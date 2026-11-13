"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Layers, Monitor, Settings2 } from "lucide-react";

import type {
  PlanarCropState,
  PlanarFieldSource,
  VisualizationStatePatch,
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
import { tensorProjectionOutputKind } from "@/kernel/api/tensorFieldProjection";
import { quantityCatalogEntrySpatialProjections, quantityCatalogEntrySupportsAnySpatialVisualization } from "@/kernel/api/quantityIds";
import { useFieldCatalogResource, useQuantityCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import {
  formatSectionLength,
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
import { projectPlanarPresentationState } from "@/kernel/visualization/planarPresentationProjection";
import {
  resolvePlanarInspectorCapabilities,
  type FieldMapCapability,
} from "@/kernel/visualization/planarCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { SCALAR_COLOR_PALETTE_ITEMS } from "../panels/ObjectVisualizationPanelModel";
import {
  PlanarPointsSection,
  PlanarProvenanceSection,
  PlanarQualitySection,
  PlanarWireframeSection,
} from "./PlanarPresentationSections";
import { planarVisualizationCoverage } from "./VisualizationViewContext";
import { PlanarTargetFieldSection, type PlanarLayerPassReasons, type PlanarLayerWriteOptions } from "./PlanarTargetFieldSection";
import { PlanarFieldLayerList, type PlanarFieldLayerCandidate } from "./PlanarFieldLayerList";
import { PlanarSectionPlaneSection } from "./PlanarSectionPlaneSection";
import { PlanarCropViewSection } from "./PlanarCropViewSection";
import {
  addFieldLayer,
  createFieldLayer,
  effectivePlanarFieldLayers,
  fieldLayerTargetSupported,
  inheritedFieldLayer,
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
const PLANE_OPTIONS = [
  { label: "XY", value: "xy", commandId: "field-map.plane.xy" },
  { label: "XZ", value: "xz", commandId: "field-map.plane.xz" },
  { label: "YZ", value: "yz", commandId: "field-map.plane.yz" },
] as const;

type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;

const PLANAR_COMPONENTS = [
  "x", "y", "z", "u", "v", "normal", "magnitude", "in_plane_magnitude", "orientation",
] as const;

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
 * Inspector 2D tab (spec 23 §5): status line, section plane, "Field in
 * <target>", then the collapsible view-wide "2D view" group (field layer list,
 * section details, crop, point and wireframe styles). Every control writes
 * immediately.
 */
export function PlanarVisualizationSection({ selection }: { selection: Selection }) {
  const kernel = useKernel();
  const { visualizationSync } = kernel;
  const visualization = useVisualizationStateResource();
  const planar = projectPlanarPresentationState(visualization.data, visualization.optimisticData);
  const layerModel = planar?.layer_model ?? "legacy";
  const legacy = layerModel !== "layers";
  const planarTarget = resolveVisualizationTargetFromSelection(selection);
  const planarTargetReason = planarTargetPresentationReason(planarTarget, visualization.data?.targets);
  const registryTargets = visualization.data?.targets;
  // The editor shows the newest optimistic list; the canvas keeps its own
  // projection. A live legacy state is shown as the list its migration makes.
  const fieldLayers = planar
    ? effectivePlanarFieldLayers({
        ...planar,
        field_overlays: visualization.optimisticData?.planar?.field_overlays
          ?? visualization.data?.planar?.field_overlays
          ?? planar.field_overlays,
      })
    : [];
  const coverage = planarVisualizationCoverage(selection);
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
    // The first edit of a legacy state converts it, as the backend migration does.
    visualizationSync.queuePlanarFieldOverlayPatch(
      { planar: { field_overlays: layers, ...(legacy ? { layer_model: "layers" as const } : {}) } },
      touchedLayerId,
    );
    if (options?.flush || legacy) void visualizationSync.flushNow?.();
  };
  const runCommand = (commandId: string) =>
    void kernel.commands.execute(commandId, createCommandContext("inspector", kernel));

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
  const inherited = emptyTarget ? inheritedFieldLayer(fieldLayers, emptyTarget.target) : null;
  const addLayer = (candidate: PlanarFieldLayerCandidate, quantityId?: string) => {
    let layer = createFieldLayer(candidate.target);
    const options = layer.view_scope.kind === "airbox"
      ? layerQuantities.filter((quantity) => quantity.id !== "m")
      : layerQuantities;
    const chosen = quantityId ?? layer.quantity_id;
    if (options.length > 0 && (chosen !== layer.quantity_id || !options.some((quantity) => quantity.id === chosen))) {
      const quantity = options.find((option) => option.id === chosen) ?? options[0]!;
      const component = quantity.components.find((option) => option.value === "magnitude")?.value
        ?? quantity.components[0]?.value
        ?? "magnitude";
      layer = {
        ...layer,
        quantity_id: quantity.id,
        component: component as PlanarFieldLayer["component"],
        // Direction colours belong to magnetization; other fields start as magnitude maps.
        colormap: quantity.id === "m" ? layer.colormap : SCALAR_COLOR_PALETTE_ITEMS[0]?.value ?? "viridis",
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
  const dataState = visibleLayerCount === 0
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

  const sectionPosition = sectionGeometry
    ? `${sectionGeometry.normal} = ${formatSectionLength(sectionGeometry.normalMin + planar.default_slice.position_fraction * sectionGeometry.normalExtent)}`
    : null;
  const monitorSource = planar.source.kind === "monitor";
  const viewSummary = `${plane.toUpperCase()}${sectionPosition ? ` · ${sectionPosition}` : ""} · ${fieldLayers.length} field ${fieldLayers.length === 1 ? "layer" : "layers"}`;

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
      <div className="fm-inspector-form-field" data-slot="planar-quick-plane">
        <span className="fm-inspector-form-field__label">Section plane</span>
        <SegmentedControl
          aria-label="Section plane"
          columns={3}
          options={PLANE_OPTIONS.map((option) => ({ label: option.label, value: option.value, disabled: monitorSource }))}
          value={plane}
          onValueChange={(value) => {
            const option = PLANE_OPTIONS.find((entry) => entry.value === value);
            if (option) runCommand(option.commandId);
          }}
        />
        <span className="fm-inspector-form-field__hint">
          {monitorSource
            ? "Defined by the monitor. Choose Source: Default under 2D view to change it."
            : `${sectionPosition ?? "Waiting for the section extent"} · shared by every object in the 2D view`}
        </span>
      </div>
      <PlanarTargetFieldSection
        emptyTarget={emptyTarget}
        inherited={inherited}
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
      <InspectorGroup
        collapsible
        defaultOpen={false}
        description="Applies to the whole 2D view, not only to the selected object."
        icon={<Monitor aria-hidden="true" size={16} strokeWidth={1.75} />}
        summary={viewSummary}
        title="2D view"
        variant="nav"
      >
        <InspectorGroup
          icon={<Layers aria-hidden="true" size={16} strokeWidth={1.75} />}
          badge={`${fieldLayers.length} / ${PLANAR_FIELD_LAYERS_MAX}`}
          description="Every object or Airbox with its own setting. The first row is drawn on top."
          title="Field layers"
        >
          <PlanarFieldLayerList
            candidates={candidates}
            layers={fieldLayers}
            selectedLayerId={selectedLayer?.id ?? null}
            targetLabel={targetLabelForLayer}
            viewMasks={planar.layers}
            onAdd={(candidate) => addLayer(candidate)}
            onSelect={(id) => setPickedLayer({ key: selectionKey, id })}
            onWrite={writeLayers}
          />
        </InspectorGroup>
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
          onFit={() => runCommand("field-map.fit")}
        />
        {planar.layers.points ? <PlanarPointsSection patch={patch} style={planar.point_style} /> : null}
      </InspectorGroup>
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
