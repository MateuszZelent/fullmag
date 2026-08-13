import type { VisualizationStateResource } from "@/kernel/api/apiTypes";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  PLANAR_QUALITY_ITEMS,
  PLANAR_VECTOR_COLOR_MODE_ITEMS,
  PLANAR_VECTOR_GLYPH_ITEMS,
  PLANAR_VECTOR_LENGTH_MODE_ITEMS,
  planarInteractionPatch,
  planarLayerPatch,
  planarResolutionPatch,
  planarVectorStylePatch,
} from "./presentationSemantics";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarPatch = NonNullable<Parameters<(patch: { planar: Partial<Planar> }) => void>[0]["planar"]>;

export function PlanarGeometryLayersSection({
  exactBoundaries,
  boundaryReason,
  layers,
  patch,
}: {
  exactBoundaries: boolean;
  boundaryReason: string | null;
  layers: Planar["layers"];
  patch: (next: PlanarPatch) => void;
}) {
  return <InspectorGroup collapsible defaultOpen={false} title="Geometry layers">
    {(["raster", "contours", "mesh", "boundaries", "vectors", "probes"] as const).map((layer) => <FormField key={layer} disabled={layer === "boundaries" && !exactBoundaries} hint={layer === "boundaries" ? boundaryReason ?? undefined : undefined} label={`Layer ${layer}`} type="checkbox" checked={layers[layer]} onChange={() => patch(planarLayerPatch(layers, layer))} />)}
    {!exactBoundaries && boundaryReason ? <FieldRow label="Boundary availability" value={boundaryReason} /> : null}
    <FieldRow label="Mesh overlay" value={exactBoundaries ? "Mesh overlay: exact boundaries" : "Mesh overlay degraded or unavailable"} />
  </InspectorGroup>;
}

export function PlanarVectorStyleSection({
  resolution,
  vectorStyle,
  patch,
}: {
  resolution: Planar["resolution"];
  vectorStyle: Planar["vector_style"];
  patch: (next: PlanarPatch) => void;
}) {
  return <InspectorGroup collapsible defaultOpen={false} title="Vector style">
    <FormField disabled label="Glyph" type="select" value="quiver">{PLANAR_VECTOR_GLYPH_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField label="Vector density" max="10000" min="0" step="1" type="number" value={resolution.vector_budget} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 0 && value <= 10000) patch(planarResolutionPatch(resolution, { vector_budget: value })); }} />
    <FormField label="Vector scale" min="0" step="0.1" type="number" value={vectorStyle.scale} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value > 0) patch(planarVectorStylePatch(vectorStyle, { scale: value })); }} />
    <FormField label="Vector length mode" type="select" value={vectorStyle.length_mode} onChange={(event) => patch(planarVectorStylePatch(vectorStyle, { length_mode: event.currentTarget.value }))}>{PLANAR_VECTOR_LENGTH_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField label="Vector color mode" type="select" value={vectorStyle.color_mode} onChange={(event) => patch(planarVectorStylePatch(vectorStyle, { color_mode: event.currentTarget.value }))}>{PLANAR_VECTOR_COLOR_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
  </InspectorGroup>;
}

export function PlanarQualitySection({
  interaction,
  quality,
  resolution,
  patch,
}: {
  interaction: Planar["interaction"];
  quality: Planar["quality"];
  resolution: Planar["resolution"];
  patch: (next: PlanarPatch) => void;
}) {
  return <InspectorGroup collapsible defaultOpen={false} title="Quality">
    <FormField label="Render quality" type="select" value={quality} onChange={(event) => patch({ quality: event.currentTarget.value as Planar["quality"] })}>{PLANAR_QUALITY_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField label="Resolution width" max="2048" min="16" step="1" type="number" value={resolution.width} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 16 && value <= 2048) patch(planarResolutionPatch(resolution, { width: value })); }} />
    <FormField label="Resolution height" max="2048" min="16" step="1" type="number" value={resolution.height} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 16 && value <= 2048) patch(planarResolutionPatch(resolution, { height: value })); }} />
    <FormField label="Interaction zoom" min="0.01" step="0.1" type="number" value={interaction.zoom} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value > 0) patch(planarInteractionPatch(interaction, { zoom: value })); }} />
  </InspectorGroup>;
}

export function PlanarProvenanceSection({
  meta,
  monitorId,
}: {
  meta: { data: { field_revision?: string; mesh_revision?: string; monitor_revision?: string; sample_token?: string; sampling_method?: string } | null; status: string };
  monitorId: string;
}) {
  return <InspectorGroup collapsible defaultOpen={false} title="Provenance">
    <FieldRow label="Availability" value={!monitorId ? "Select a planar monitor" : meta.status === "error" ? "Unavailable for this target" : meta.status} />
    <FieldRow label="Sample token" value={meta.data?.sample_token ?? "Not sampled"} />
    <FieldRow label="Field revision" value={meta.data?.field_revision ?? "Not sampled"} />
    <FieldRow label="Mesh revision" value={meta.data?.mesh_revision ?? "Not sampled"} />
    <FieldRow label="Monitor revision" value={meta.data?.monitor_revision ?? "Not sampled"} />
    <FieldRow label="Sampling" value={meta.data?.sampling_method ?? "Not sampled"} />
  </InspectorGroup>;
}
