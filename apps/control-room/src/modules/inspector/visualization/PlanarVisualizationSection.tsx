"use client";

import { useMemo, useState } from "react";
import { Palette, ScanLine } from "lucide-react";

import type {
  PlanarFieldSource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  planarFieldQueryFromMeta,
  usePlanarFieldMetaResource,
  usePlanarMaskResource,
} from "@/kernel/resources/planarFieldResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useDomainMetaResource } from "@/kernel/resources/geometryLifecycleResources";
import { useFieldCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { resolveVisualizationTargetFromSelection } from "@/kernel/visualization/ObjectVisualizationController";
import {
  findPlanarTargetWireframeOverride,
  planarTargetPresentationReason,
  resolvePlanarTargetWireframeStyle,
} from "@/kernel/visualization/planarTargetPresentation";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { projectPlanarPresentationState } from "@/kernel/visualization/planarPresentationProjection";
import {
  resolvePlanarInspectorCapabilities,
  type FieldMapCapability,
} from "@/kernel/visualization/planarCapabilities";

import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  scalarColorbarDisplayUnitItems,
  SCALAR_COLOR_PALETTE_ITEMS,
} from "../panels/ObjectVisualizationPanelModel";
import { VisualizationInspectorOverview } from "../panels/ObjectVisualizationOverview";
import {
  PLANAR_RANGE_MODE_ITEMS,
  planarDisplayModePatch,
  planarRangeForMode,
  resolvePlanarDisplayMode,
} from "./presentationSemantics";
import { DefaultPlanarSourceSection } from "./DefaultPlanarSourceSection";
import {
  PlanarDisplayPassesSection,
  PlanarPointsSection,
  PlanarProvenanceSection,
  PlanarQualitySection,
  PlanarVectorStyleSection,
  PlanarWireframeSection,
} from "./PlanarPresentationSections";
import { VisualizationRenderModeControl } from "./VisualizationInspectorControls";
import {
  planarViewScopeForSelection,
  planarVisualizationCoverage,
} from "./VisualizationViewContext";
import type { Selection } from "@/kernel/selection/selectionTypes";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type PlanarRange = NonNullable<PlanarState["range"]>;
type PlanarPatch = NonNullable<Parameters<ReturnType<typeof useKernel>["visualizationSync"]["queuePatch"]>[0]["planar"]>;

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
      return "Structured FDM sampling does not support mesh-part or airbox scope.";
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
    default:
      return "This control is unavailable for the selected planar sample.";
  }
}

export function PlanarVisualizationSection({ selection }: { selection: Selection }) {
  const { visualizationSync } = useKernel();
  const visualization = useVisualizationStateResource();
  const planar = projectPlanarPresentationState(
    visualization.data,
    visualization.optimisticData,
  );
  const planarTarget = resolveVisualizationTargetFromSelection(selection);
  const planarTargetReason = planarTargetPresentationReason(
    planarTarget,
    visualization.data?.targets,
  );
  const coverage = planarVisualizationCoverage(selection);
  const viewScope = planarViewScopeForSelection(selection);
  const [validationError, setValidationError] = useState<string | null>(null);
  const monitors = usePlanarMonitorsResource({ enabled: coverage.supported });
  const domain = useDomainMetaResource({ enabled: coverage.supported });
  const fieldCatalog = useFieldCatalogResource({ enabled: coverage.supported });
  const discretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
    { enabled: coverage.supported },
  );
  const planarSourceKind = planar?.source?.kind;
  const planarSourceMonitorId = planarSourceKind === "monitor"
    ? planar?.source?.monitor_id
    : undefined;
  const planarSourceKey = planarSourceKind === "monitor"
    ? planarSourceMonitorId ?? ""
    : "default";
  /* Keep the source object stable: resource hooks use its identity in their
   * canonical query key, while the React compiler cannot prove the derived
   * presentation object is immutable. */
  /* eslint-disable react-hooks/preserve-manual-memoization */
  const source = useMemo<PlanarFieldSource>(() => {
    if (planarSourceKey !== "default" && planarSourceKey.length > 0) {
      return { kind: "monitor", monitorId: planarSourceKey };
    }
    return { kind: "default" };
  }, [planarSourceKey]);
  /* eslint-enable react-hooks/preserve-manual-memoization */
  const sourceValue = source.kind === "default" ? "default" : source.monitorId;
  const quantityId = planar?.quantity_id ?? "";
  const meta = usePlanarFieldMetaResource(
    quantityId,
    source,
    planar
      ? {
          component: planar.component,
          resolution_x: planar.resolution.width,
          resolution_y: planar.resolution.height,
          scope_id: planar.view_scope.kind === "mesh_part" ? planar.view_scope.scope_id : undefined,
          scope_kind: planar.view_scope.kind,
        }
      : {},
    { enabled: coverage.supported && planar !== undefined },
  );
  const canonicalSample = meta.data
    ? planarFieldQueryFromMeta(quantityId, source, meta.data)
    : null;
  const mask = usePlanarMaskResource(
    quantityId,
    source,
    canonicalSample?.ok ? canonicalSample.query : {},
    {
      enabled:
        coverage.supported &&
        planar !== undefined &&
        canonicalSample?.ok === true,
    },
  );
  const patch = (next: PlanarPatch) => visualizationSync.queuePatch({ planar: next });
  const selectedDescriptor = fieldCatalog.data?.quantities.find((quantity) => quantity.quantity_id === quantityId);
  const componentItems = (selectedDescriptor?.components ?? 3) > 1 ? PLANAR_COMPONENTS : ["magnitude"];
  const canonicalUnit = meta.data?.canonical_unit ?? selectedDescriptor?.unit ?? "";
  const displayUnitItems = scalarColorbarDisplayUnitItems(canonicalUnit);
  const availableQuantities = (fieldCatalog.data?.quantities ?? []).filter(
    (quantity) => quantity.available,
  );

  if (!coverage.supported) {
    return <InspectorGroup title="2D visualization"><FieldRow label="Availability" value="Not a spatial target" /><FieldRow label="Reason" value="quantity_or_target_not_spatial" /></InspectorGroup>;
  }
  if (!planar) {
    return <InspectorGroup title="2D visualization"><FieldRow label="Availability" value={visualization.status === "error" ? "Unavailable" : "Loading planar visualization state"} /></InspectorGroup>;
  }

  const range = planar.range ?? { mode: "auto" as const, min: null, max: null };
  const planarTargetOverride =
    planarTarget && planarTargetReason === undefined
      ? findPlanarTargetWireframeOverride(
          planar.target_overrides,
          planarTarget,
        )
      : undefined;
  const planarWireframeStyle =
    planarTarget && planarTargetReason === undefined
      ? resolvePlanarTargetWireframeStyle(
          planar.wireframe_style,
          planar.target_overrides,
          planarTarget,
        )
      : planar.wireframe_style;
  const queuePlanarWireframeStyle = (
    wireframeStyle: PlanarState["wireframe_style"],
  ) => {
    if (!planarTarget || planarTargetReason !== undefined) return;
    visualizationSync.queuePlanarTargetOverride({
      kind: "upsert",
      target: planarTarget,
      wireframeStyle,
    });
  };
  const resetPlanarWireframeStyle = () => {
    if (!planarTarget || planarTargetReason !== undefined) return;
    visualizationSync.queuePlanarTargetOverride({
      kind: "remove",
      target: planarTarget,
    });
  };
  const vectorStyle = planar.vector_style;
  const interaction = planar.interaction;
  const quality = planar.quality;
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
    occupancyAvailable: mask.status === "ready" && mask.data !== null,
    quantity: selectedDescriptor,
    scopeKind: planar.view_scope.kind,
  });
  const scalarReason = capabilityReason(capabilities.raster);
  const updateManualRange = (field: "min" | "max", raw: string) => {
    const value = finiteNumber(raw);
    if (value === null) { setValidationError("Range limits must be finite SI values."); return; }
    const next = { mode: "manual" as const, min: range.mode === "manual" ? range.min : -1, max: range.mode === "manual" ? range.max : 1, [field]: value };
    if (typeof next.min !== "number" || typeof next.max !== "number" || next.min >= next.max) { setValidationError("Manual range requires minimum < maximum."); return; }
    setValidationError(null);
    patch({ range: next });
  };

  const renderModeOptions = capabilities.mesh.enabled
    ? (["surface", "surface+edges", "wireframe", ...(capabilities.points.enabled ? ["points" as const] : []), "off"] as const)
    : (["surface", ...(capabilities.points.enabled ? ["points" as const] : []), "off"] as const);
  const enabledPassCount = [
    planar.visible,
    planar.layers.bounds,
    planar.layers.contours,
    planar.layers.vectors,
    planar.layers.probes,
  ].filter(Boolean).length;
  const sourceAndSlice = (
    <InspectorGroup
      collapsible
      defaultOpen
      icon={<ScanLine size={16} strokeWidth={1.75} />}
      summary={source.kind === "default"
        ? `Default • ${planar.default_slice.plane.toUpperCase()}`
        : `${(monitors.data?.monitors ?? []).find((monitor) => monitor.id === source.monitorId)?.name ?? source.monitorId} • Monitor`}
      title="Source & Slice"
      variant="nav"
    >
      <FieldRow label="Target" value={coverage.targetKind} />
      <div aria-label="Planar field selection controls" className="grid min-w-0 gap-fm-inspector-control" role="group">
        <FormField label="Source" type="select" value={sourceValue} onChange={(event) => { const value = event.currentTarget.value; patch({ source: value === "default" ? { kind: "default" } : { kind: "monitor", monitor_id: value } }); }}>
          <option value="default">Default</option>
          <optgroup label="Monitors">{(monitors.data?.monitors ?? []).map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}</optgroup>
        </FormField>
        {source.kind === "default" ? (
          <DefaultPlanarSourceSection
            defaultSlice={planar.default_slice}
            domain={domain.data}
            patch={patch}
            onSaveAsMonitor={() =>
              kernel.commands.run("planar-monitor.create", {
                intent: { source: "inspector", preset: planar.default_slice.plane },
              })
            }
          />
        ) : null}
      </div>
    </InspectorGroup>
  );
  const surfaceColoring = (
    <InspectorGroup
      collapsible
      defaultOpen={false}
      icon={<Palette size={16} strokeWidth={1.75} />}
      summary={`${SCALAR_COLOR_PALETTE_ITEMS.find((item) => item.value === planar.colormap)?.label ?? planar.colormap} • ${range.mode === "auto" ? "Auto range" : range.mode === "manual" ? "Manual range" : "Symmetric range"}`}
      title="Surface Coloring"
      variant="nav"
    >
      <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Color map" type="select" value={planar.colormap} onChange={(event) => patch({ colormap: event.currentTarget.value })}>{SCALAR_COLOR_PALETTE_ITEMS.map((palette) => <option key={palette.value} value={palette.value}>{palette.label}</option>)}</FormField>
      {displayUnitItems.length > 1 ? <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Display unit" type="select" value={planar.display_unit ?? displayUnitItems[0]?.value ?? ""} onChange={(event) => patch({ display_unit: event.currentTarget.value || null })}>{displayUnitItems.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</FormField> : <FieldRow label="Unit" value={canonicalUnit || "dimensionless"} />}
      <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Range mode" type="select" value={range.mode} onChange={(event) => patch({ range: planarRangeForMode(event.currentTarget.value as PlanarRange["mode"], range) })}>{PLANAR_RANGE_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
      {range.mode === "manual" ? <><FormField disabled={!capabilities.raster.enabled} error={validationError ?? undefined} hint={scalarReason} label="Range minimum" type="number" value={range.min ?? ""} onChange={(event) => updateManualRange("min", event.currentTarget.value)} /><FormField disabled={!capabilities.raster.enabled} error={validationError ?? undefined} hint={scalarReason} label="Range maximum" type="number" value={range.max ?? ""} onChange={(event) => updateManualRange("max", event.currentTarget.value)} /></> : null}
      <FormField disabled={!capabilities.raster.enabled} error={validationError ?? undefined} hint={scalarReason} label="Raster opacity" max="1" min="0" step="0.05" type="number" value={planar.raster_opacity ?? 1} onChange={(event) => { const value = finiteNumber(event.currentTarget.value); if (value === null || value < 0 || value > 1) { setValidationError("Raster opacity must be between 0 and 1."); return; } setValidationError(null); patch({ raster_opacity: value }); }} />
      <FormField label="Viewport colorbar" type="checkbox" checked={planar.viewport_colorbar_visible} onChange={() => patch({ viewport_colorbar_visible: !planar.viewport_colorbar_visible })} />
    </InspectorGroup>
  );

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <VisualizationInspectorOverview
        advanced={<PlanarQualitySection capability={capabilities.raster} interaction={interaction} patch={patch} quality={quality} resolution={planar.resolution} />}
        camera={<p className="m-0 text-fm-help leading-snug text-fm-muted">Pan and zoom follow the planar viewport.</p>}
        clipping={<p className="m-0 text-fm-help leading-snug text-fm-muted">The active plane and slice position are controlled in Source &amp; Slice.</p>}
        context={sourceAndSlice}
        dataState={meta.status === "ready" ? "Live" : meta.status}
        display={<><PlanarDisplayPassesSection capabilities={capabilities} layers={planar.layers} patch={patch} visible={planar.visible} /><VisualizationRenderModeControl disabled={!planar.visible} options={renderModeOptions} value={resolvePlanarDisplayMode(planar.layers)} onValueChange={(mode) => patch(planarDisplayModePatch(mode, planar.layers))} /><FormField label="Quantity" type="select" value={quantityId} onChange={(event) => patch({ component: "magnitude", quantity_id: event.currentTarget.value })}>{availableQuantities.map((quantity) => <option key={quantity.quantity_id} value={quantity.quantity_id}>{quantity.label} ({quantity.unit || "1"})</option>)}</FormField><FormField label="Component" type="select" value={planar.component} onChange={(event) => patch({ component: event.currentTarget.value as PlanarState["component"] })}>{componentItems.map((component) => <option key={component} value={component}>{component.replaceAll("_", " ")}</option>)}</FormField></>}
        enabledPassCount={enabledPassCount}
        meshState={capabilities.mesh.enabled ? "Ready" : "Degraded"}
        quantitySource={quantityId || "Not available"}
        surfaceColoring={surfaceColoring}
        vectors={<PlanarVectorStyleSection capability={capabilities.vectors} patch={patch} resolution={planar.resolution} vectorStyle={vectorStyle} />}
      />
      {planar.layers.points ? <PlanarPointsSection patch={patch} style={planar.point_style} /> : null}
      {planar.layers.mesh || planar.layers.boundaries ? (
        <PlanarWireframeSection
          disabled={planarTargetReason !== undefined}
          hasOverride={planarTargetOverride !== undefined}
          onReset={resetPlanarWireframeStyle}
          onStyleChange={queuePlanarWireframeStyle}
          reason={planarTargetReason}
          style={planarWireframeStyle}
        />
      ) : null}
      <PlanarProvenanceSection meta={meta} source={source} />
      <div className="fm-inspector-toolbar"><Button size="sm" type="button" variant="secondary" onClick={() => patch({ view_scope: viewScope })}>Use target scope</Button></div>
    </div>
  );
}
