"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Layers, Settings2 } from "lucide-react";

import type {
  PlanarCropState,
  PlanarFieldSource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  planarFieldQueryFromMeta,
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
} from "@/kernel/resources/planarFieldResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { isFlowMajorTensorDescriptor, tensorProjectionOutputKind } from "@/kernel/api/tensorFieldProjection";
import { quantityCatalogEntrySpatialProjections, quantityCatalogEntrySupportsAnySpatialVisualization } from "@/kernel/api/quantityIds";
import { useFieldCatalogResource, useQuantityCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import {
  planarGridResolutionPresets,
  planarSectionAxes,
  resolvePlanarSectionGeometryFromMeta,
  type PlanarSectionPlane,
} from "@/kernel/visualization/planarSectionModel";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveVisualizationTargetFromSelection,
  visualizationStateScopeIdForTarget,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  findPlanarTargetWireframeOverride,
  planarTargetPresentationReason,
  resolvePlanarTargetWireframeStyle,
} from "@/kernel/visualization/planarTargetPresentation";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  fieldMapSurfaceStore,
  useFieldMapSurfaceEvidenceStatus,
} from "@/kernel/visualization/fieldMapSurfaceStore";
import { DIRECTION_COLORMAP } from "@/shared/visualization/directionColor";
import { projectPlanarPresentationState } from "@/kernel/visualization/planarPresentationProjection";
import {
  resolvePlanarInspectorCapabilities,
  type FieldMapCapability,
} from "@/kernel/visualization/planarCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { SCALAR_COLOR_PALETTE_ITEMS } from "../panels/ObjectVisualizationPanelModel";
import {
  PLANAR_RANGE_MODE_ITEMS,
  planarDisplayModePatch,
  planarRangeForMode,
  resolvePlanarDisplayMode,
} from "./presentationSemantics";
import {
  PlanarDisplayPassesSection,
  PlanarPointsSection,
  PlanarProvenanceSection,
  PlanarQualitySection,
  PlanarVectorStyleSection,
  PlanarWireframeSection,
} from "./PlanarPresentationSections";
import { VisualizationRenderModeControl } from "./VisualizationInspectorControls";
import { planarViewScopeForSelection, planarVisualizationCoverage } from "./VisualizationViewContext";
import { PlanarTargetFieldSection, type PlanarLayerPassReasons, type PlanarLayerWriteOptions } from "./PlanarTargetFieldSection";
import { PlanarFieldLayerList, type PlanarFieldLayerCandidate } from "./PlanarFieldLayerList";
import { PlanarSectionPlaneSection } from "./PlanarSectionPlaneSection";
import { PlanarCropViewSection } from "./PlanarCropViewSection";
import {
  addFieldLayer,
  createFieldLayer,
  fieldLayerTargetSupported,
  layerIdForTarget,
  layerVisible,
  PLANAR_FIELD_LAYERS_MAX,
  type PlanarFieldLayer,
  type PlanarFieldQuantityOption,
} from "./planarFieldLayers";
import { defaultPlanarDisplayPatch, planarDisplayDiffersFromDefault } from "./planarDisplayDefaults";

const currentFieldMapSectionGeometry = () => fieldMapSurfaceStore.get().sectionGeometry;
const serverFieldMapSectionGeometry = () => null;
const currentFieldMapObjectLayers = () => fieldMapSurfaceStore.get().objectLayers;
const SERVER_OBJECT_LAYERS: readonly never[] = [];
const serverFieldMapObjectLayers = () => SERVER_OBJECT_LAYERS;
const NO_LAYERS: readonly PlanarFieldLayer[] = [];

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarRange = NonNullable<PlanarState["range"]>;
type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;

const PLANAR_COMPONENTS = [
  "x", "y", "z", "u", "v", "normal", "magnitude", "in_plane_magnitude", "orientation",
] as const;

function finiteNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function capabilityReason(capability: FieldMapCapability): string | undefined {
  if (capability.enabled) return undefined;
  switch (capability.reasonCode) {
    case "fdm_scope_not_supported":
      return "Structured FDM sampling does not support mesh-part scope.";
    case "fem_layer_scope_not_supported":
      return "Native layer scope requires an FDM multilayer carrier.";
    case "mesh_overlay_unavailable":
      return "Mesh overlay is unavailable for this sample.";
    case "occupancy_mask_unavailable":
      return "Sample points require the canonical occupancy mask.";
    case "planar_meta_unavailable":
      return "Planar sample metadata is not materialized.";
    case "mesh_overlay_codec_unsupported":
      return "Mesh overlay requires the fmcs.v4 or fmfg.v1 descriptor codec.";
    case "target_boundaries_unavailable":
      return "FDM structured-grid overlays do not publish exact target boundaries.";
    case "boundaries_not_exact":
      return "Exact boundaries are unavailable for this overlay descriptor.";
    case "quantity_not_vector":
      return "The selected scalar quantity has no vector components.";
    case "quantity_not_spatial":
      return "The selected quantity is not spatially sampleable.";
    case "airbox_carrier_unresolved":
      return "Waiting for the backend to resolve the Airbox carrier.";
    default:
      return capability.reasonCode
        ? `Unavailable for the selected planar sample: ${capability.reasonCode}`
        : "This control is unavailable for the selected planar sample.";
  }
}

/**
 * Inspector 2D tab (plan §2.4): status line, field layer list, selected layer
 * editor, section plane, crop and view. Every control writes immediately.
 */
export function PlanarVisualizationSection({ selection }: { selection: Selection }) {
  const kernel = useKernel();
  const { visualizationSync } = kernel;
  const visualization = useVisualizationStateResource();
  const planar = projectPlanarPresentationState(visualization.data, visualization.optimisticData);
  const layerModel = planar?.layer_model ?? "legacy";
  const planarTarget = resolveVisualizationTargetFromSelection(selection);
  const planarTargetReason = planarTargetPresentationReason(planarTarget, visualization.data?.targets);
  const registryTargets = visualization.data?.targets;
  // The editor shows the newest optimistic list; the canvas keeps its own projection.
  const fieldLayers = visualization.optimisticData?.planar?.field_overlays
    ?? visualization.data?.planar?.field_overlays
    ?? NO_LAYERS;
  const coverage = planarVisualizationCoverage(selection);
  const viewScope = planarViewScopeForSelection(selection);
  const [validationError, setValidationError] = useState<string | null>(null);
  const selectionKey = selection.nodeId ?? "";
  const [pickedLayer, setPickedLayer] = useState<{ key: string; id: string } | null>(null);
  const surfaceEvidence = useFieldMapSurfaceEvidenceStatus();
  const monitors = usePlanarMonitorsResource({ enabled: coverage.supported });
  const publishedGeometry = useSyncExternalStore(
    fieldMapSurfaceStore.subscribe,
    currentFieldMapSectionGeometry,
    serverFieldMapSectionGeometry,
  );
  // Named object sections come from the mounted 2D surface (one owner).
  const objectLayers = useSyncExternalStore(
    fieldMapSurfaceStore.subscribe,
    currentFieldMapObjectLayers,
    serverFieldMapObjectLayers,
  );
  const fieldCatalog = useFieldCatalogResource({ enabled: coverage.supported });
  const quantityCatalog = useQuantityCatalogResource({ enabled: coverage.supported });
  const discretization = useSessionStatusSelector(
    (status) => resolveSessionDiscretization(status.data),
    { enabled: coverage.supported },
  );
  const planarSourceKey = planar?.source?.kind === "monitor" ? planar.source.monitor_id ?? "" : "default";
  /* Keep the source object stable: resource hooks use its identity in their
   * canonical query key, while the React compiler cannot prove the derived
   * presentation object is immutable. */
  /* eslint-disable react-hooks/preserve-manual-memoization */
  const defaultSliceKey = planar ? JSON.stringify(planar.default_slice) : undefined;
  const source = useMemo<PlanarFieldSource>(() => {
    if (planarSourceKey !== "default" && planarSourceKey.length > 0) {
      return { kind: "monitor", monitorId: planarSourceKey };
    }
    return { kind: "default", sliceKey: defaultSliceKey };
  }, [defaultSliceKey, planarSourceKey]);
  /* eslint-enable react-hooks/preserve-manual-memoization */
  // The base sample carries the frame, section and mesh evidence of every layer.
  const quantityId = planar?.quantity_id ?? "";
  const quantityComponent = planar?.component ?? "magnitude";
  const meta = usePlanarFieldMetaResource(
    quantityId,
    source,
    planar
      ? {
          component: quantityComponent,
          resolution_x: planar.resolution.width,
          resolution_y: planar.resolution.height,
          scope_id: planar.view_scope.kind === "mesh_part" ? planar.view_scope.scope_id : undefined,
          scope_kind: planar.view_scope.kind,
        }
      : {},
    { enabled: coverage.supported && planar !== null },
  );
  const canonicalSample = meta.data ? planarFieldQueryFromMeta(quantityId, source, meta.data) : null;
  const mask = usePlanarMaskResource(
    quantityId,
    source,
    canonicalSample?.ok ? canonicalSample.query : {},
    { enabled: coverage.supported && planar !== null && canonicalSample?.ok === true },
  );

  const resetDisplay = useCallback(() => {
    visualizationSync.queuePatch({ planar: defaultPlanarDisplayPatch() });
    void visualizationSync.flushNow?.();
  }, [visualizationSync]);
  const acceptLiveChanges = useCallback(() => true, []);
  useRegisterInspectorEditSession(
    planar ? "liveViewport" : null,
    false,
    planar ? planarDisplayDiffersFromDefault(planar) : false,
    true,
    undefined,
    acceptLiveChanges,
    resetDisplay,
  );

  if (!coverage.supported) {
    return <InspectorGroup title="2D visualization"><FieldRow label="Availability" value="Not a spatial target" /><FieldRow label="Reason" value="quantity_or_target_not_spatial" /></InspectorGroup>;
  }
  if (!planar) {
    return <InspectorGroup title="2D visualization"><FieldRow label="Availability" value={visualization.status === "error" ? "Unavailable" : "Loading planar visualization state"} /></InspectorGroup>;
  }

  const patch = (next: PlanarPatch) => visualizationSync.queuePatch({ planar: next });
  const writeLayers = (layers: PlanarFieldLayer[], touchedLayerId: string, options?: PlanarLayerWriteOptions) => {
    visualizationSync.queuePlanarFieldOverlayPatch({ planar: { field_overlays: layers } }, touchedLayerId);
    if (options?.flush) void visualizationSync.flushNow?.();
  };

  // Quantity options of the layer editor.
  const availableQuantities = (fieldCatalog.data?.quantities ?? []).filter(
    (quantity) => quantity.available && (!quantityCatalog.data ||
      Boolean(quantityCatalog.data.quantities.find((entry) => entry.id === quantity.quantity_id &&
        quantityCatalogEntrySupportsAnySpatialVisualization(entry)))),
  );
  const layerQuantities = availableQuantities.flatMap<PlanarFieldQuantityOption>((quantity) => {
    const entry = quantityCatalog.data?.quantities.find((candidate) => candidate.id === quantity.quantity_id);
    const projections = quantityCatalogEntrySpatialProjections(entry);
    if (entry?.tensor != null) {
      if (projections.length === 0) return [];
      return [{
        id: quantity.quantity_id,
        label: quantity.label,
        unit: quantity.unit,
        vector: projections.some((projection) => tensorProjectionOutputKind(projection.value) === "vector"),
        components: projections.map((projection) => ({
          ...projection,
          outputKind: tensorProjectionOutputKind(projection.value) ?? "scalar",
        })),
      }];
    }
    // Layers accept the established three-component field projections.
    if (quantity.components !== 3) return [];
    return [{
      id: quantity.quantity_id,
      label: quantity.label,
      unit: quantity.unit,
      vector: true,
      components: PLANAR_COMPONENTS.map((value) => ({ value, label: value.replaceAll("_", " ") })),
    }];
  });

  // Layer targets and labels.
  const airboxLabel = registryTargets?.airbox.label ?? "Airbox";
  const objectTargets = (registryTargets?.objects ?? []).map((entry) => ({
    id: `object:${entry.scope_id}`,
    label: entry.label ?? entry.scope_id,
    target: { id: `object:${entry.scope_id}`, kind: "object" as const, label: entry.label ?? entry.scope_id },
  }));
  const targetLabelForLayer = (layer: PlanarFieldLayer): string => {
    if (layer.id === "all") return "All objects";
    if (layer.view_scope.kind === "airbox") return airboxLabel;
    if (layer.view_scope.kind === "object") {
      const scopeId = layer.view_scope.scope_id;
      return objectTargets.find((entry) => entry.id === `object:${scopeId}`)?.label ?? scopeId;
    }
    return "scope_id" in layer.view_scope ? layer.view_scope.scope_id : layer.id;
  };
  const allCandidates: PlanarFieldLayerCandidate[] = [
    { id: "all", label: "All objects", target: "all" },
    { id: "airbox", label: airboxLabel, target: AIRBOX_VISUALIZATION_TARGET },
    ...objectTargets,
  ];
  const layerIds = new Set(fieldLayers.map((layer) => layer.id));
  const candidates = allCandidates.filter((candidate) => !layerIds.has(candidate.id));

  // Selection: a tree target selects its layer; a row click selects any layer.
  const selectedTarget = fieldLayerTargetSupported(planarTarget) && planarTarget ? planarTarget : null;
  const selectedTargetLayerId = selectedTarget ? layerIdForTarget(selectedTarget) : null;
  const selectedLayerId = pickedLayer?.key === selectionKey
    ? pickedLayer.id
    : selectedTargetLayerId ?? fieldLayers[0]?.id ?? null;
  const selectedLayer = fieldLayers.find((layer) => layer.id === selectedLayerId) ?? null;
  const emptyTarget: PlanarFieldLayerCandidate | null = !selectedLayer && selectedTarget && selectedTargetLayerId
    ? {
        id: selectedTargetLayerId,
        label: selectedTargetLayerId === "airbox"
          ? airboxLabel
          : objectTargets.find((entry) => entry.id === selectedTargetLayerId)?.label
            ?? selectedTarget.label
            ?? visualizationStateScopeIdForTarget(selectedTarget),
        target: selectedTarget,
      }
    : null;
  const addLayer = (candidate: PlanarFieldLayerCandidate) => {
    let layer = createFieldLayer(candidate.target);
    const options = layer.view_scope.kind === "airbox"
      ? layerQuantities.filter((quantity) => quantity.id !== "m")
      : layerQuantities;
    if (options.length > 0 && !options.some((quantity) => quantity.id === layer.quantity_id)) {
      const quantity = options[0]!;
      const component = quantity.components.find((option) => option.value === "magnitude")?.value
        ?? quantity.components[0]?.value
        ?? "magnitude";
      layer = {
        ...layer,
        quantity_id: quantity.id,
        component: component as PlanarFieldLayer["component"],
        colormap: quantity.vector ? layer.colormap : SCALAR_COLOR_PALETTE_ITEMS[0]?.value ?? "viridis",
      };
    }
    const result = addFieldLayer(fieldLayers, layer);
    if ("refused" in result) return;
    writeLayers(result.layers, layer.id, { flush: true });
    setPickedLayer({ key: selectionKey, id: layer.id });
  };

  // Base-sample capabilities (mesh descriptor, occupancy) shared by all layers.
  const selectedDescriptor = fieldCatalog.data?.quantities.find((quantity) => quantity.quantity_id === quantityId);
  const catalogQuantity = quantityCatalog.data?.quantities.find((entry) => entry.id === quantityId);
  const tensor = catalogQuantity?.tensor;
  const capabilities = resolvePlanarInspectorCapabilities({
    descriptor: meta.data
      ? {
          available: meta.data.mesh_overlay_descriptor.available,
          boundaryClassification: meta.data.mesh_overlay_descriptor.boundary_classification,
          codec: meta.data.mesh_overlay_descriptor.codec,
          geometrySource: meta.data.mesh_overlay_descriptor.geometry_source,
        }
      : null,
    discretization,
    metaAvailable: meta.status === "ready" && meta.data !== null,
    metaErrorCode: meta.error instanceof ControlRoomApiError ? meta.error.code : null,
    occupancyAvailable: mask.status === "ready" && mask.data !== null,
    component: quantityComponent,
    quantity: selectedDescriptor,
    tensor,
    catalogQuantity,
    scopeKind: planar.view_scope.kind,
  });
  const passReasons: PlanarLayerPassReasons = {
    ...(capabilities.mesh.enabled ? {} : { mesh: capabilityReason(capabilities.mesh) }),
    ...(capabilities.points.enabled ? {} : { points: capabilityReason(capabilities.points) }),
  };

  // Section geometry: the mounted surface publishes it; otherwise the base meta.
  const plane = planar.default_slice.plane as PlanarSectionPlane;
  const sectionGeometry = publishedGeometry
    ?? resolvePlanarSectionGeometryFromMeta(meta.data?.section, plane);
  const axes = planarSectionAxes(plane);
  const fullBoundsRaw = meta.data?.frame.full_bounds_uv_m ?? meta.data?.frame.bounds_uv_m;
  const fullBounds = fullBoundsRaw && fullBoundsRaw.length === 4 && fullBoundsRaw.every(Number.isFinite)
    ? [fullBoundsRaw[0]!, fullBoundsRaw[1]!, fullBoundsRaw[2]!, fullBoundsRaw[3]!] as const
    : null;
  const resolutionPresets = source.kind === "default" ? planarGridResolutionPresets(sectionGeometry) : [];

  const visibleLayerCount = fieldLayers.filter(layerVisible).length;
  const dataState = layerModel === "layers" && visibleLayerCount === 0
    ? "No visible field layer"
    : surfaceEvidence === "ready"
      ? "Live"
      : surfaceEvidence === "error"
        ? "Error"
        : surfaceEvidence === "loading"
          ? "Loading frame"
          : meta.status === "ready"
            ? "2D view closed"
            : meta.status === "error"
              ? "Unavailable"
              : "Loading";
  const meshState = capabilities.mesh.enabled ? "Mesh ready" : "Mesh unavailable";

  const planarTargetOverride = planarTarget && planarTargetReason === undefined
    ? findPlanarTargetWireframeOverride(planar.target_overrides, planarTarget)
    : undefined;
  const planarWireframeStyle = planarTarget && planarTargetReason === undefined
    ? resolvePlanarTargetWireframeStyle(planar.wireframe_style, planar.target_overrides, planarTarget)
    : planar.wireframe_style;

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" data-planar-layer-model={layerModel}>
      <p
        aria-label="2D view status"
        className="fm-planar-status-line"
        data-state={dataState === "Live" ? "live" : dataState === "Error" ? "error" : "idle"}
        role="status"
      >
        <span className="fm-planar-status-line__item" data-tone={dataState === "Live" ? "success" : "neutral"}>{dataState}</span>
        <span className="fm-planar-status-line__item" data-tone={capabilities.mesh.enabled ? "success" : "degraded"}>{meshState}</span>
      </p>
      <InspectorGroup
        icon={<Layers aria-hidden="true" size={16} strokeWidth={1.75} />}
        badge={`${fieldLayers.length} / ${PLANAR_FIELD_LAYERS_MAX}`}
        title="Field layers"
      >
        <PlanarFieldLayerList
          candidates={candidates}
          layers={fieldLayers}
          selectedLayerId={selectedLayer?.id ?? null}
          targetLabel={targetLabelForLayer}
          viewMasks={planar.layers}
          onAdd={addLayer}
          onSelect={(id) => setPickedLayer({ key: selectionKey, id })}
          onWrite={writeLayers}
        />
      </InspectorGroup>
      <PlanarTargetFieldSection
        emptyTarget={emptyTarget}
        layer={selectedLayer}
        layers={fieldLayers}
        passReasons={passReasons}
        quantities={layerQuantities}
        targetLabel={selectedLayer ? targetLabelForLayer(selectedLayer) : ""}
        targetReason={selectedLayer && selectedLayer.id === selectedTargetLayerId ? planarTargetReason : emptyTarget ? planarTargetReason : undefined}
        viewMasks={planar.layers}
        onAdd={addLayer}
        onWrite={writeLayers}
      />
      <PlanarSectionPlaneSection
        defaultSlice={planar.default_slice}
        geometry={sectionGeometry}
        monitors={monitors.data?.monitors ?? []}
        objectLayers={objectLayers}
        source={planar.source}
        patch={patch}
      />
      <PlanarCropViewSection
        axisLabels={axes}
        crop={planar.crop ?? null}
        fullBounds={fullBounds}
        quality={<PlanarQualitySection capability={capabilities.raster} interaction={planar.interaction} patch={patch} quality={planar.quality} resolution={planar.resolution} resolutionPresets={resolutionPresets} />}
        zoom={planar.interaction.zoom}
        onClear={() => visualizationSync.queuePlanarCropPatch(null)}
        onCrop={(crop: PlanarCropState) => visualizationSync.queuePlanarCropPatch(crop)}
        onFit={() => void kernel.commands.execute("field-map.fit", createCommandContext("inspector", kernel))}
      />
      {planar.layers.points ? <PlanarPointsSection patch={patch} style={planar.point_style} /> : null}
      {planar.layers.mesh || planar.layers.boundaries ? (
        <PlanarWireframeSection
          disabled={planarTarget === null || planarTargetReason !== undefined}
          hasOverride={planarTargetOverride !== undefined}
          onReset={() => {
            if (planarTarget && planarTargetReason === undefined) {
              visualizationSync.queuePlanarTargetOverride({ kind: "remove", target: planarTarget });
            }
          }}
          onStyleChange={(wireframeStyle) => {
            if (planarTarget && planarTargetReason === undefined) {
              visualizationSync.queuePlanarTargetOverride({ kind: "upsert", target: planarTarget, wireframeStyle });
            }
          }}
          reason={planarTargetReason}
          style={planarWireframeStyle}
        />
      ) : null}
      {layerModel === "legacy" ? (
        <LegacyBaseFieldSection
          capabilities={capabilities}
          planar={planar}
          patch={patch}
          quantityOptions={availableQuantities.map((quantity) => ({ id: quantity.quantity_id, label: quantity.label, unit: quantity.unit }))}
          validationError={validationError}
          setValidationError={setValidationError}
          componentItems={componentItemsFor(catalogQuantity, selectedDescriptor)}
          onUseTargetScope={() => patch({ view_scope: viewScope })}
          tensorFlowMajor={isFlowMajorTensorDescriptor(tensor)}
          quantityCatalog={quantityCatalog.data?.quantities ?? []}
        />
      ) : null}
      <InspectorGroup
        collapsible
        defaultOpen={false}
        icon={<Settings2 aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary="Provenance"
        title="Advanced"
        variant="nav"
      >
        <PlanarProvenanceSection meta={meta} source={source} />
      </InspectorGroup>
    </div>
  );
}

type QuantityCatalogEntry = NonNullable<ReturnType<typeof useQuantityCatalogResource>["data"]>["quantities"][number];
type FieldCatalogEntry = NonNullable<ReturnType<typeof useFieldCatalogResource>["data"]>["quantities"][number];

function componentItemsFor(
  catalogQuantity: QuantityCatalogEntry | undefined,
  descriptor: FieldCatalogEntry | undefined,
): readonly { value: string; label: string }[] {
  const tensorOptions = quantityCatalogEntrySpatialProjections(catalogQuantity);
  if (tensorOptions.length > 0) return tensorOptions;
  if (catalogQuantity?.tensor != null || (descriptor && ![1, 2, 3].includes(descriptor.components))) return [];
  return ((descriptor?.components ?? 3) > 1 ? PLANAR_COMPONENTS : ["magnitude"])
    .map((value) => ({ value, label: value.replaceAll("_", " ") }));
}

/**
 * Base field of a session still in the legacy model, where the base quantity
 * is drawn under the layers. Persisted sessions migrate to layers on restore.
 */
const LEGACY_BASE_PALETTE_ITEMS = [
  { label: "Direction (HSL, mumax3)", value: DIRECTION_COLORMAP },
  ...SCALAR_COLOR_PALETTE_ITEMS,
];

function LegacyBaseFieldSection({
  capabilities,
  componentItems,
  planar,
  patch,
  quantityCatalog,
  quantityOptions,
  setValidationError,
  tensorFlowMajor,
  validationError,
  onUseTargetScope,
}: {
  capabilities: ReturnType<typeof resolvePlanarInspectorCapabilities>;
  componentItems: readonly { value: string; label: string }[];
  planar: PlanarState;
  patch: (next: PlanarPatch) => void;
  quantityCatalog: readonly QuantityCatalogEntry[];
  quantityOptions: readonly { id: string; label: string; unit: string }[];
  setValidationError: (message: string | null) => void;
  tensorFlowMajor: boolean;
  validationError: string | null;
  onUseTargetScope: () => void;
}) {
  const range = planar.range ?? { mode: "auto" as const, min: null, max: null };
  const scalarReason = capabilityReason(capabilities.raster);
  const paletteItems = LEGACY_BASE_PALETTE_ITEMS;
  const renderModeOptions = capabilities.mesh.enabled
    ? (["surface", "surface+edges", "wireframe", ...(capabilities.points.enabled ? ["points" as const] : []), "off"] as const)
    : (["surface", ...(capabilities.points.enabled ? ["points" as const] : []), "off"] as const);
  const updateManualRange = (field: "min" | "max", raw: string) => {
    const value = finiteNumber(raw);
    if (value === null) { setValidationError("Range limits must be finite SI values."); return; }
    const next = { mode: "manual" as const, min: range.mode === "manual" ? range.min : -1, max: range.mode === "manual" ? range.max : 1, [field]: value };
    if (typeof next.min !== "number" || typeof next.max !== "number" || next.min >= next.max) { setValidationError("Manual range requires minimum < maximum."); return; }
    setValidationError(null);
    patch({ range: next });
  };
  return (
    <InspectorGroup collapsible defaultOpen={false} summary={planar.quantity_id} title="Base field (legacy)" variant="nav">
      <PlanarDisplayPassesSection capabilities={capabilities} layers={planar.layers} patch={patch} visible={planar.visible} />
      <VisualizationRenderModeControl disabled={!planar.visible} options={renderModeOptions} value={resolvePlanarDisplayMode(planar.layers)} onValueChange={(mode) => patch(planarDisplayModePatch(mode, planar.layers))} />
      <FormField label="Base quantity" type="select" value={planar.quantity_id} onChange={(event) => {
        const next = event.currentTarget.value;
        const options = quantityCatalogEntrySpatialProjections(quantityCatalog.find((entry) => entry.id === next));
        patch({ component: options.find((option) => option.value === "frobenius")?.value ?? options[0]?.value ?? "magnitude", quantity_id: next });
      }}>
        {quantityOptions.map((quantity) => <option key={quantity.id} value={quantity.id}>{quantity.label} ({quantity.unit || "1"})</option>)}
      </FormField>
      <FormField label="Base component" type="select" value={planar.component} onChange={(event) => {
        const component = event.currentTarget.value as PlanarState["component"];
        patch({ component, ...(tensorFlowMajor && tensorProjectionOutputKind(component) !== "vector" ? { layers: { ...planar.layers, vectors: false } } : {}) });
      }}>
        {componentItems.map((component) => <option key={component.value} value={component.value}>{component.label}</option>)}
      </FormField>
      <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Base color map" type="select" value={planar.colormap} onChange={(event) => patch({ colormap: event.currentTarget.value })}>{paletteItems.map((palette) => <option key={palette.value} value={palette.value}>{palette.label}</option>)}</FormField>
      <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Base range mode" type="select" value={range.mode} onChange={(event) => patch({ range: planarRangeForMode(event.currentTarget.value as PlanarRange["mode"], range) })}>{PLANAR_RANGE_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
      {range.mode === "manual" ? <><FormField error={validationError ?? undefined} label="Base range minimum" type="number" value={range.min ?? ""} onChange={(event) => updateManualRange("min", event.currentTarget.value)} /><FormField error={validationError ?? undefined} label="Base range maximum" type="number" value={range.max ?? ""} onChange={(event) => updateManualRange("max", event.currentTarget.value)} /></> : null}
      <PlanarVectorStyleSection capability={capabilities.vectors} patch={patch} resolution={planar.resolution} vectorStyle={planar.vector_style} />
      <div className="fm-inspector-toolbar">
        <Button size="sm" type="button" variant="secondary" onClick={onUseTargetScope}>Use target scope</Button>
      </div>
    </InspectorGroup>
  );
}
