import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { FieldMapCapability, PlanarInspectorCapabilities } from "@/kernel/visualization/planarCapabilities";

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
  capabilities,
  layers,
  patch,
}: {
  capabilities: PlanarInspectorCapabilities;
  layers: Planar["layers"];
  patch: (next: PlanarPatch) => void;
}) {
  const capabilityForLayer = (layer: keyof Planar["layers"]): FieldMapCapability => {
    if (layer === "boundaries") return capabilities.boundaries;
    if (layer === "bounds") return capabilities.bounds;
    if (layer === "contours") return capabilities.contours;
    if (layer === "mesh") return capabilities.mesh;
    if (layer === "points") return capabilities.points;
    if (layer === "vectors") return capabilities.vectors;
    return capabilities.raster;
  };
  const reason = (capability: FieldMapCapability): string | undefined => {
    if (capability.enabled) return undefined;
    switch (capability.reasonCode) {
      case "mesh_overlay_unavailable": return "Mesh overlay is unavailable for this sample.";
      case "mesh_overlay_codec_unsupported": return "Mesh overlay requires the fmcs.v4 descriptor codec.";
      case "occupancy_mask_unavailable": return "Sample points require the canonical occupancy mask.";
      case "planar_meta_unavailable": return "Planar sample metadata is not materialized.";
      case "boundaries_not_exact": return "Exact boundaries are unavailable for this overlay descriptor.";
      case "fdm_scope_not_supported": return "Structured FDM sampling does not support mesh-part or airbox scope.";
      case "quantity_not_vector": return "The selected scalar quantity has no vector components.";
      case "quantity_not_spatial": return "The selected quantity is not spatially sampleable.";
      default: return "Unavailable";
    }
  };
  return <InspectorGroup collapsible defaultOpen={false} title="Geometry layers">
    {(["raster", "bounds", "contours", "mesh", "boundaries", "points", "vectors", "probes"] as const).map((layer) => {
      const capability = capabilityForLayer(layer);
      return <FormField key={layer} disabled={!capability.enabled} hint={reason(capability)} label={`Layer ${layer}`} type="checkbox" checked={layers[layer]} onChange={() => patch(planarLayerPatch(layers, layer))} />;
    })}
    <FieldRow label="Points availability" value={capabilities.points.enabled ? "Occupancy-backed bin centers" : reason(capabilities.points) ?? "Unavailable"} />
    <FieldRow label="Boundary availability" value={capabilities.boundaries.enabled ? "Exact boundaries" : reason(capabilities.boundaries) ?? "Unavailable"} />
    <FieldRow label="Mesh overlay" value={capabilities.boundaries.enabled ? "Mesh overlay: exact boundaries" : "Mesh overlay degraded or unavailable"} />
  </InspectorGroup>;
}

export function PlanarVectorStyleSection({
  capability,
  resolution,
  vectorStyle,
  patch,
}: {
  capability: FieldMapCapability;
  resolution: Planar["resolution"];
  vectorStyle: Planar["vector_style"];
  patch: (next: PlanarPatch) => void;
}) {
  const hint = capability.enabled ? undefined : capability.reasonCode === "quantity_not_vector" ? "The selected scalar quantity has no vector components." : capability.reasonCode === "quantity_not_spatial" ? "The selected quantity is not spatially sampleable." : capability.reasonCode?.replaceAll("_", " ");
  return <InspectorGroup collapsible defaultOpen={false} title="Vector style">
    <FormField disabled label="Glyph" type="select" value="quiver">{PLANAR_VECTOR_GLYPH_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField disabled={!capability.enabled} hint={hint} label="Vector density" max="10000" min="0" step="1" type="number" value={resolution.vector_budget} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 0 && value <= 10000) patch(planarResolutionPatch(resolution, { vector_budget: value })); }} />
    <FormField disabled={!capability.enabled} hint={hint} label="Vector scale" min="0" step="0.1" type="number" value={vectorStyle.scale} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value > 0) patch(planarVectorStylePatch(vectorStyle, { scale: value })); }} />
    <FormField disabled={!capability.enabled} hint={hint} label="Vector length mode" type="select" value={vectorStyle.length_mode} onChange={(event) => patch(planarVectorStylePatch(vectorStyle, { length_mode: event.currentTarget.value }))}>{PLANAR_VECTOR_LENGTH_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField disabled={!capability.enabled} hint={hint} label="Vector color mode" type="select" value={vectorStyle.color_mode} onChange={(event) => patch(planarVectorStylePatch(vectorStyle, { color_mode: event.currentTarget.value }))}>{PLANAR_VECTOR_COLOR_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
  </InspectorGroup>;
}

export function PlanarQualitySection({
  capability,
  interaction,
  quality,
  resolution,
  patch,
}: {
  capability: FieldMapCapability;
  interaction: Planar["interaction"];
  quality: Planar["quality"];
  resolution: Planar["resolution"];
  patch: (next: PlanarPatch) => void;
}) {
  const hint = capability.enabled ? undefined : capability.reasonCode === "quantity_not_spatial" ? "The selected quantity is not spatially sampleable." : capability.reasonCode?.replaceAll("_", " ");
  return <InspectorGroup collapsible defaultOpen={false} title="Quality">
    <FormField disabled={!capability.enabled} hint={hint} label="Render quality" type="select" value={quality} onChange={(event) => patch({ quality: event.currentTarget.value as Planar["quality"] })}>{PLANAR_QUALITY_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField disabled={!capability.enabled} hint={hint} label="Resolution width" max="2048" min="16" step="1" type="number" value={resolution.width} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 16 && value <= 2048) patch(planarResolutionPatch(resolution, { width: value })); }} />
    <FormField disabled={!capability.enabled} hint={hint} label="Resolution height" max="2048" min="16" step="1" type="number" value={resolution.height} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 16 && value <= 2048) patch(planarResolutionPatch(resolution, { height: value })); }} />
    <FormField disabled={!capability.enabled} hint={hint} label="Interaction zoom" min="0.01" step="0.1" type="number" value={interaction.zoom} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value > 0) patch(planarInteractionPatch(interaction, { zoom: value })); }} />
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
