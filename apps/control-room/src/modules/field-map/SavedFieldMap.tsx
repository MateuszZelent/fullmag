"use client";

import { useCallback, useMemo } from "react";
import type { MaterializedDatasetResource, SavedPlanarQuery } from "@/kernel/api/apiTypes";
import { useSavedFieldGeometryResource, useSavedFieldTopologyResource } from "@/kernel/resources/savedGeometryResources";
import { savedPlanarQueryKey, useSavedPlanarResource } from "@/kernel/resources/savedPlanarResources";
import { useMaterializedDatasetResource } from "@/kernel/resources/solutionSetResources";
import { materializedDatasetSelectionMatches } from "@/kernel/visualization/savedFieldPresentation";
import { useObjectVisualizationController, useSavedFieldPresentation } from "@/kernel/visualization/useObjectVisualization";
import { DEFAULT_SAVED_FIELD_SECTION, type SavedFieldSectionPreferences } from "@/kernel/visualization/ObjectVisualizationController";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { Input } from "@/shared/ui/Input";
import { Button } from "@/shared/ui/Button";
import { PlanarSurface } from "./renderer/PlanarSurface";
import { PlanarColorLegend } from "./components/PlanarColorLegend";
import { buildFieldMapRenderModel, projectPlanarVectors } from "./model/fieldMapRenderModel";

export function SavedFieldMap() {
  const { presentation, projectMatches } = useSavedFieldPresentation();
  const ref = presentation?.selection;
  const controller = useObjectVisualizationController();
  const onSectionChange = useCallback((patch: Partial<SavedFieldSectionPreferences>) => {
    if (ref) controller.patchSavedFieldSection(ref, patch);
  }, [controller, ref]);
  const resource = useMaterializedDatasetResource(ref?.projectId, ref?.runId, ref?.solutionSetId,
    ref?.containingRevision, ref?.memberId, ref?.artifactId, { enabled: projectMatches });
  const dataset = ref && resource.data && materializedDatasetSelectionMatches(ref, resource.data)
    ? resource.data : null;
  if (!dataset) return <p role="status">{resource.error?.message ?? "Loading pinned field metadata…"}</p>;
  if (dataset.field.descriptor.quantity_id !== "H_ant" || dataset.field.descriptor.unit !== "A/m") {
    return <p role="status">Select the saved antenna magnetic field H to inspect its transverse section.</p>;
  }
  return <SavedFieldSection key={`${dataset.manifest_object_ref}:${dataset.artifact_id}`} dataset={dataset}
    section={presentation?.section ?? DEFAULT_SAVED_FIELD_SECTION} onSectionChange={onSectionChange} />;
}

function SavedFieldSection({ dataset, section, onSectionChange }: {
  dataset: MaterializedDatasetResource;
  section: SavedFieldSectionPreferences;
  onSectionChange: (patch: Partial<SavedFieldSectionPreferences>) => void;
}) {
  const geometry = useSavedFieldGeometryResource(dataset);
  const topology = useSavedFieldTopologyResource(dataset, geometry.data);
  const { plane, positionText, component, vectors, verticalExaggeration, interaction } = section;
  const setInteraction = useCallback((interaction: SavedFieldSectionPreferences["interaction"]) => {
    onSectionChange({ interaction });
  }, [onSectionChange]);
  const bounds = useMemo(() => {
    if (!topology.data) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < topology.data.positions.length; i += 1) {
      min[i % 3] = Math.min(min[i % 3]!, topology.data.positions[i]!);
      max[i % 3] = Math.max(max[i % 3]!, topology.data.positions[i]!);
    }
    return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
  }, [topology.data]);
  const axes = useMemo(() => plane === "xy" ? [0, 1, 2] : plane === "xz" ? [0, 2, 1] : [1, 2, 0], [plane]);
  const position = positionText === null && bounds
    ? (bounds.min[axes[2]!]! + bounds.max[axes[2]!]!) / 2
    : positionText?.trim() ? Number(positionText) * 1e-6 : Number.NaN;
  const query = useMemo<SavedPlanarQuery | null>(() => {
    if (!geometry.data || !bounds || !Number.isFinite(position)) return null;
    const [u, v] = plane === "xy" ? [0, 1] : plane === "xz" ? [0, 2] : [1, 2];
    return {
      expected_dataset_manifest_object_ref: dataset.manifest_object_ref,
      expected_geometry_manifest_object_ref: geometry.data.geometry_manifest.object_ref,
      expected_geometry_object_ref: geometry.data.geometry_payload.object_ref,
      plane, position_m: position, u_min_m: bounds.min[u!]!, u_max_m: bounds.max[u!]!,
      v_min_m: bounds.min[v!]!, v_max_m: bounds.max[v!]!, width: 192, height: 192,
      component, max_response_bytes: "33554432",
    };
  }, [bounds, component, dataset.manifest_object_ref, geometry.data, plane, position]);
  const raster = useSavedPlanarResource(dataset, geometry.data, query);
  const model = useMemo(() => {
    if (!raster.data || !query || raster.data.queryKey !== savedPlanarQueryKey(query)) return null;
    const { meta, scalar, mask, vectors: world } = raster.data;
    // A previous query must never masquerade as the selected plane/component.
    if (meta.component !== query.component || meta.resolution[0] !== query.width ||
        meta.resolution[1] !== query.height || meta.frame_origin_m[axes[2]!] !== query.position_m) return null;
    const triple = (values: number[]): [number, number, number] => [values[0]!, values[1]!, values[2]!];
    const frame = { origin: triple(meta.frame_origin_m), uAxis: triple(meta.frame_u_axis), vAxis: triple(meta.frame_v_axis), normal: triple(meta.frame_normal) };
    // This saved inspection contract renders only fully occupied samples.
    // Keep the original mask in the resource; renderer placeholders stay hidden.
    const renderMask = Uint8Array.from(mask, occupancy => occupancy === 0 ? 0 : 1);
    return buildFieldMapRenderModel({
      bounds: [meta.bounds_uv_m[0]!, meta.bounds_uv_m[1]!, meta.bounds_uv_m[2]!, meta.bounds_uv_m[3]!], frame, canonicalUnit: "A/m", component, colormap: "viridis",
      layers: { raster: true, vectors, contours: false, mesh: false, probes: true },
      range: { mode: "auto" }, mask: renderMask, scalar, worldVectors: world,
      vectors: projectPlanarVectors(world, frame), resolution: [meta.resolution[0]!, meta.resolution[1]!],
      sampleIdentity: meta.request_identity, interaction, vectorBudget: 196,
    });
  }, [raster.data, query, component, vectors, interaction, axes]);
  const error = geometry.error ?? topology.error ?? raster.error;
  return <section className="fm-field-map" aria-label="Saved antenna field section">
    <div className="fm-field-map__toolbar fm-field-map__toolbar--saved">
      <Select value={plane} onValueChange={value => onSectionChange({ plane: value as SavedFieldSectionPreferences["plane"], positionText: null, interaction: { panU: 0, panV: 0, zoom: 1 } })}>
        <SelectTrigger className="fm-field-map__saved-select" aria-label="Section plane"><SelectValue /></SelectTrigger>
        <SelectContent>{["xy", "xz", "yz"].map(value => <SelectItem key={value} value={value}>{value.toUpperCase()}</SelectItem>)}</SelectContent>
      </Select>
      <label className="fm-field-map__saved-position">Position (µm)<Input aria-label="Section position (µm)" type="number" step="any"
        value={positionText ?? (Number.isFinite(position) ? String(Number((position * 1e6).toPrecision(8))) : "")}
        onChange={event => onSectionChange({ positionText: event.target.value })} /></label>
      <Select value={component} onValueChange={component => onSectionChange({ component })}>
        <SelectTrigger className="fm-field-map__saved-select" aria-label="Field component"><SelectValue /></SelectTrigger>
        <SelectContent>{["magnitude", "x", "y", "z", "u", "v", "normal"].map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={String(verticalExaggeration)} onValueChange={value => onSectionChange({ verticalExaggeration: value === "100" ? 100 : value === "10" ? 10 : 1 })}>
        <SelectTrigger className="fm-field-map__saved-select" aria-label="Vertical exaggeration"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="1">Vertical ×1</SelectItem>
          <SelectItem value="10">Vertical ×10</SelectItem>
          <SelectItem value="100">Vertical ×100</SelectItem>
        </SelectContent>
      </Select>
      <Button aria-pressed={vectors} onClick={() => onSectionChange({ vectors: !vectors })}>Vectors</Button>
    <p className="fm-field-map__section-caption" role="status">{verticalExaggeration === 1 ? "Equal physical axis scales. " : `Vertical axis ×${verticalExaggeration} (display only); field values and coordinates unchanged. `}{error?.message ?? (!query ? "Enter a finite section position." : !model ? "Loading saved field section…" : `${raster.data!.meta.occupied_count} raster pixels · A/m · inspection reconstruction, not qualified for LLG`)}</p>
    </div>
    <div className="fm-field-map__stage">
    {model && raster.data?.meta.occupied_count === 0 ? <p role="status">This section has no saved samples. Missing data does not mean zero field.</p> : model ? <><PlanarSurface model={model} onInteraction={setInteraction} verticalExaggeration={verticalExaggeration} />
      <PlanarColorLegend colormap={model.colormap} component={component} legendUnit={model.display.legendUnit}
        probeScale={model.display.probeScale} quantityId="H_ant" range={model.range} />
    </> : null}
    </div>
  </section>;
}
