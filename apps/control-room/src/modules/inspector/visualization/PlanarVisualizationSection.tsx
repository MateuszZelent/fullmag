"use client";

import { useState } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarFieldMetaResource } from "@/kernel/resources/planarFieldResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useFieldCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
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
import { PLANAR_RANGE_MODE_ITEMS, planarRangeForMode } from "./presentationSemantics";
import {
  PlanarGeometryLayersSection,
  PlanarProvenanceSection,
  PlanarQualitySection,
  PlanarVectorStyleSection,
} from "./PlanarPresentationSections";
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
    case "mesh_overlay_codec_unsupported":
      return "Mesh overlay requires the fmcs.v4 descriptor codec.";
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
  const coverage = planarVisualizationCoverage(selection);
  const viewScope = planarViewScopeForSelection(selection);
  const [validationError, setValidationError] = useState<string | null>(null);
  const monitors = usePlanarMonitorsResource({ enabled: coverage.supported });
  const fieldCatalog = useFieldCatalogResource({ enabled: coverage.supported });
  const discretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
    { enabled: coverage.supported },
  );
  const monitorId = planar?.active_monitor_id ?? "";
  const quantityId = planar?.quantity_id ?? "";
  const meta = usePlanarFieldMetaResource(
    quantityId,
    monitorId,
    planar
      ? {
          component: planar.component,
          resolution_x: planar.resolution.width,
          resolution_y: planar.resolution.height,
          scope_id: planar.view_scope.kind === "mesh_part" ? planar.view_scope.scope_id : undefined,
          scope_kind: planar.view_scope.kind,
        }
      : {},
    { enabled: coverage.supported && planar !== undefined && monitorId.length > 0 },
  );
  const patch = (next: PlanarPatch) => visualizationSync.queuePatch({ planar: next });
  const selectedDescriptor = fieldCatalog.data?.quantities.find((quantity) => quantity.quantity_id === quantityId);
  const componentItems = (selectedDescriptor?.components ?? 3) > 1 ? PLANAR_COMPONENTS : ["magnitude"];
  const canonicalUnit = meta.data?.canonical_unit ?? selectedDescriptor?.unit ?? "";
  const displayUnitItems = scalarColorbarDisplayUnitItems(canonicalUnit);

  if (!coverage.supported) {
    return <InspectorGroup title="2D visualization"><FieldRow label="Availability" value="Not a spatial target" /><FieldRow label="Reason" value="quantity_or_target_not_spatial" /></InspectorGroup>;
  }
  if (!planar) {
    return <InspectorGroup title="2D visualization"><FieldRow label="Availability" value={visualization.status === "error" ? "Unavailable" : "Loading planar visualization state"} /></InspectorGroup>;
  }

  const range = planar.range ?? { mode: "auto" as const, min: null, max: null };
  const vectorStyle = planar.vector_style;
  const interaction = planar.interaction;
  const quality = planar.quality;
  const capabilities = resolvePlanarInspectorCapabilities({
    descriptor: meta.data
      ? {
          available: meta.data.mesh_overlay_descriptor.available,
          boundaryClassification: meta.data.mesh_overlay_descriptor.boundary_classification,
          codec: meta.data.mesh_overlay_descriptor.codec,
        }
      : null,
    discretization,
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

  return (
    <InspectorGroup title="2D visualization">
      <FieldRow label="Target" value={coverage.targetKind} />
      <FormField label="Monitor" type="select" value={monitorId} onChange={(event) => patch({ active_monitor_id: event.currentTarget.value || null })}>
        <option value="">Select monitor</option>
        {(monitors.data?.monitors ?? []).map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}
      </FormField>
      <FormField label="Quantity" type="select" value={quantityId} onChange={(event) => patch({ component: "magnitude", quantity_id: event.currentTarget.value })}>
        {(fieldCatalog.data?.quantities ?? []).filter((quantity) => quantity.available).map((quantity) => <option key={quantity.quantity_id} value={quantity.quantity_id}>{quantity.label} ({quantity.unit || "1"})</option>)}
      </FormField>
      <FormField label="Component" type="select" value={planar.component} onChange={(event) => patch({ component: event.currentTarget.value as PlanarState["component"] })}>
        {componentItems.map((component) => <option key={component} value={component}>{component.replaceAll("_", " ")}</option>)}
      </FormField>
      <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Color map" type="select" value={planar.colormap} onChange={(event) => patch({ colormap: event.currentTarget.value })}>
        {SCALAR_COLOR_PALETTE_ITEMS.map((palette) => <option key={palette.value} value={palette.value}>{palette.label}</option>)}
      </FormField>
      {displayUnitItems.length > 1 ? <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Display unit" type="select" value={planar.display_unit ?? displayUnitItems[0]?.value ?? ""} onChange={(event) => patch({ display_unit: event.currentTarget.value || null })}>{displayUnitItems.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</FormField> : <FieldRow label="Unit" value={canonicalUnit || "dimensionless"} />}

      <FormField disabled={!capabilities.raster.enabled} hint={scalarReason} label="Range mode" type="select" value={range.mode} onChange={(event) => patch({ range: planarRangeForMode(event.currentTarget.value as PlanarRange["mode"], range) })}>
        {PLANAR_RANGE_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </FormField>
      {range.mode === "manual" ? <><FormField disabled={!capabilities.raster.enabled} error={validationError ?? undefined} hint={scalarReason} label="Range minimum" type="number" value={range.min ?? ""} onChange={(event) => updateManualRange("min", event.currentTarget.value)} /><FormField disabled={!capabilities.raster.enabled} error={validationError ?? undefined} hint={scalarReason} label="Range maximum" type="number" value={range.max ?? ""} onChange={(event) => updateManualRange("max", event.currentTarget.value)} /></> : null}
      <FormField disabled={!capabilities.raster.enabled} error={validationError ?? undefined} hint={scalarReason} label="Raster opacity" max="1" min="0" step="0.05" type="number" value={planar.raster_opacity ?? 1} onChange={(event) => { const value = finiteNumber(event.currentTarget.value); if (value === null || value < 0 || value > 1) { setValidationError("Raster opacity must be between 0 and 1."); return; } setValidationError(null); patch({ raster_opacity: value }); }} />

      <PlanarGeometryLayersSection capabilities={capabilities} layers={planar.layers} patch={patch} />
      <PlanarVectorStyleSection capability={capabilities.vectors} patch={patch} resolution={planar.resolution} vectorStyle={vectorStyle} />
      <PlanarQualitySection capability={capabilities.raster} interaction={interaction} patch={patch} quality={quality} resolution={planar.resolution} />
      <PlanarProvenanceSection meta={meta} monitorId={monitorId} />
      <div className="fm-inspector-toolbar"><Button disabled={!monitorId} size="sm" type="button" variant="secondary" onClick={() => patch({ view_scope: viewScope })}>Use target scope</Button></div>
    </InspectorGroup>
  );
}
