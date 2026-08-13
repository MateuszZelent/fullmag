"use client";

import { useState } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarFieldMetaResource } from "@/kernel/resources/planarFieldResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useFieldCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";

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

function labelForOverlay(meta: ReturnType<typeof usePlanarFieldMetaResource>): {
  exact: boolean;
  reason: string | null;
  value: string;
} {
  const descriptor = meta.data?.mesh_overlay_descriptor;
  if (!descriptor?.available) {
    return { exact: false, reason: "Mesh overlay is unavailable for this sample.", value: "Mesh overlay unavailable" };
  }
  if (descriptor.boundary_classification !== "exact") {
    return {
      exact: false,
      reason: "Exact boundaries are unavailable for this overlay descriptor.",
      value: `Mesh overlay: ${descriptor.boundary_classification}`,
    };
  }
  return { exact: true, reason: null, value: "Mesh overlay: exact boundaries" };
}

export function PlanarVisualizationSection({ selection }: { selection: Selection }) {
  const { visualizationSync } = useKernel();
  const visualization = useVisualizationStateResource();
  const planar = visualization.data?.planar;
  const coverage = planarVisualizationCoverage(selection);
  const viewScope = planarViewScopeForSelection(selection);
  const [validationError, setValidationError] = useState<string | null>(null);
  const monitors = usePlanarMonitorsResource({ enabled: coverage.supported });
  const fieldCatalog = useFieldCatalogResource({ enabled: coverage.supported });
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
  const overlay = labelForOverlay(meta);
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
      <FormField label="Color map" type="select" value={planar.colormap} onChange={(event) => patch({ colormap: event.currentTarget.value })}>
        {SCALAR_COLOR_PALETTE_ITEMS.map((palette) => <option key={palette.value} value={palette.value}>{palette.label}</option>)}
      </FormField>
      {displayUnitItems.length > 1 ? <FormField label="Display unit" type="select" value={planar.display_unit ?? displayUnitItems[0]?.value ?? ""} onChange={(event) => patch({ display_unit: event.currentTarget.value || null })}>{displayUnitItems.map((unit) => <option key={unit.value} value={unit.value}>{unit.label}</option>)}</FormField> : <FieldRow label="Unit" value={canonicalUnit || "dimensionless"} />}

      <FormField label="Range mode" type="select" value={range.mode} onChange={(event) => patch({ range: planarRangeForMode(event.currentTarget.value as PlanarRange["mode"], range) })}>
        {PLANAR_RANGE_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </FormField>
      {range.mode === "manual" ? <><FormField error={validationError ?? undefined} label="Range minimum" type="number" value={range.min ?? ""} onChange={(event) => updateManualRange("min", event.currentTarget.value)} /><FormField error={validationError ?? undefined} label="Range maximum" type="number" value={range.max ?? ""} onChange={(event) => updateManualRange("max", event.currentTarget.value)} /></> : null}
      <FormField error={validationError ?? undefined} label="Raster opacity" max="1" min="0" step="0.05" type="number" value={planar.raster_opacity ?? 1} onChange={(event) => { const value = finiteNumber(event.currentTarget.value); if (value === null || value < 0 || value > 1) { setValidationError("Raster opacity must be between 0 and 1."); return; } setValidationError(null); patch({ raster_opacity: value }); }} />

      <PlanarGeometryLayersSection boundaryReason={overlay.reason} exactBoundaries={overlay.exact} layers={planar.layers} patch={patch} />
      <PlanarVectorStyleSection patch={patch} resolution={planar.resolution} vectorStyle={vectorStyle} />
      <PlanarQualitySection interaction={interaction} patch={patch} quality={quality} resolution={planar.resolution} />
      <PlanarProvenanceSection meta={meta} monitorId={monitorId} />
      <div className="fm-inspector-toolbar"><Button disabled={!monitorId} size="sm" type="button" variant="secondary" onClick={() => patch({ view_scope: viewScope })}>Use target scope</Button></div>
    </InspectorGroup>
  );
}
