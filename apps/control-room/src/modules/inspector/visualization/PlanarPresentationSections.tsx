import type {
  PlanarFieldSource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { FieldMapCapability, PlanarInspectorCapabilities } from "@/kernel/visualization/planarCapabilities";
import { Button } from "@/shared/ui/Button";
import { ArrowRightLeft, Crosshair, Eye, ScanLine, SquareDashed } from "lucide-react";

import { ColorField } from "../primitives/ColorField";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { usePlanarPresentationDraftState } from "./PlanarPresentationDraftOwner";
import { PlanarNumberField } from "./PlanarNumberField";
import { VisualizationDisplayPassesControl } from "./VisualizationInspectorControls";
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

function reason(capability: FieldMapCapability): string | undefined {
  if (capability.enabled) return undefined;
  switch (capability.reasonCode) {
    case "mesh_overlay_unavailable": return "Mesh overlay is unavailable for this sample.";
    case "mesh_overlay_codec_unsupported": return "Mesh overlay requires the fmcs.v4 or fmfg.v1 descriptor codec.";
    case "target_boundaries_unavailable": return "FDM structured-grid overlays do not publish exact target boundaries.";
    case "occupancy_mask_unavailable": return "Sample points require the canonical occupancy mask.";
    case "planar_meta_unavailable": return "Planar sample metadata is not materialized.";
    case "boundaries_not_exact": return "Exact boundaries are unavailable for this overlay descriptor.";
    case "fdm_scope_not_supported": return "Structured FDM sampling does not support mesh-part or airbox scope.";
    case "quantity_not_vector": return "The selected scalar quantity has no vector components.";
    case "quantity_not_spatial": return "The selected quantity is not spatially sampleable.";
    default: return "Unavailable";
  }
}

export function PlanarDisplayPassesSection({
  capabilities,
  visible,
  layers,
  patch,
}: {
  capabilities: PlanarInspectorCapabilities;
  visible: boolean;
  layers: Planar["layers"];
  patch: (next: PlanarPatch) => void;
}) {
  const toggle = (layer: keyof Planar["layers"]) =>
    patch(planarLayerPatch(layers, layer));
  return (
    <div className="grid min-w-0 gap-0">
      <VisualizationDisplayPassesControl
        items={[
          {
            icon: <Eye aria-hidden="true" size={13} strokeWidth={1.75} />,
            id: "visible",
            label: "Visible",
            pressed: visible,
            onToggle: () => patch({ visible: !visible }),
          },
          {
            disabled: !capabilities.bounds.enabled,
            icon: <SquareDashed aria-hidden="true" size={13} strokeWidth={1.75} />,
            id: "bounds",
            label: "Bounds",
            pressed: visible && layers.bounds,
            onToggle: () => toggle("bounds"),
          },
          {
            disabled: !capabilities.contours.enabled,
            icon: <ScanLine aria-hidden="true" size={13} strokeWidth={1.75} />,
            id: "contours",
            label: "Contours",
            pressed: visible && layers.contours,
            onToggle: () => toggle("contours"),
          },
          {
            disabled: !capabilities.vectors.enabled,
            icon: <ArrowRightLeft aria-hidden="true" size={13} strokeWidth={1.75} />,
            id: "vectors",
            label: "Vectors",
            pressed: visible && layers.vectors,
            onToggle: () => toggle("vectors"),
          },
          {
            ariaLabel: "Toggle Points",
            disabled: !capabilities.points.enabled,
            icon: <Crosshair aria-hidden="true" size={13} strokeWidth={1.75} />,
            id: "points",
            label: "Points",
            pressed: visible && layers.points,
            onToggle: () => toggle("points"),
          },
          {
            disabled: !capabilities.raster.enabled,
            icon: <Crosshair aria-hidden="true" size={13} strokeWidth={1.75} />,
            id: "probes",
            label: "Probes",
            pressed: visible && layers.probes,
            onToggle: () => toggle("probes"),
          },
        ]}
      />
      {!capabilities.mesh.enabled ? (
        <FieldRow label="Mesh overlay" value={reason(capabilities.mesh) ?? "Unavailable"} />
      ) : null}
      {!capabilities.boundaries.enabled && capabilities.boundaries.reasonCode !== capabilities.mesh.reasonCode ? (
        <FieldRow label="Boundaries" value={reason(capabilities.boundaries) ?? "Unavailable"} />
      ) : null}
      {!capabilities.points.enabled ? (
        <FieldRow label="Points" value={reason(capabilities.points) ?? "Unavailable"} />
      ) : null}
      {!capabilities.raster.enabled ? (
        <FieldRow label="Raster" value={reason(capabilities.raster) ?? "Unavailable"} />
      ) : null}
    </div>
  );
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
  return <InspectorGroup
    collapsible
    defaultOpen={false}
    icon={<ArrowRightLeft aria-hidden="true" size={16} strokeWidth={1.75} />}
    summary={`Quiver • ${resolution.vector_budget}`}
    title="Vectors"
    variant="nav"
  >
    <FormField disabled label="Glyph" type="select" value="quiver">{PLANAR_VECTOR_GLYPH_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <PlanarNumberField disabled={!capability.enabled} hint={hint} integer label="Vector density" maximum={10000} minimum={0} path="resolution.vector_budget" value={resolution.vector_budget} onCommit={(value) => patch(planarResolutionPatch(resolution, { vector_budget: value }))} />
    <PlanarNumberField disabled={!capability.enabled} hint={hint} label="Vector scale" minimum={0} minimumExclusive path="vector_style.scale" value={vectorStyle.scale} onCommit={(value) => patch(planarVectorStylePatch(vectorStyle, { scale: value }))} />
    <PlanarNumberField disabled={!capability.enabled} hint={hint} label="Vector opacity" maximum={1} minimum={0} path="vector_style.opacity" value={vectorStyle.opacity} onCommit={(value) => patch(planarVectorStylePatch(vectorStyle, { opacity: value }))} />
    <PlanarNumberField disabled={!capability.enabled} hint={hint} label="Vector thickness" maximum={16} minimum={0} minimumExclusive path="vector_style.thickness" value={vectorStyle.thickness} onCommit={(value) => patch(planarVectorStylePatch(vectorStyle, { thickness: value }))} />
    <FormField disabled={!capability.enabled} hint={hint} label="Vector length mode" type="select" value={vectorStyle.length_mode} onChange={(event) => patch(planarVectorStylePatch(vectorStyle, { length_mode: event.currentTarget.value }))}>{PLANAR_VECTOR_LENGTH_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <FormField disabled={!capability.enabled} hint={hint} label="Vector color mode" type="select" value={vectorStyle.color_mode} onChange={(event) => patch(planarVectorStylePatch(vectorStyle, { color_mode: event.currentTarget.value }))}>{PLANAR_VECTOR_COLOR_MODE_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    {vectorStyle.color_mode === "monochrome" ? <ColorField disabled={!capability.enabled} label="Vector color" value={vectorStyle.monochrome_color} onChange={(value) => patch(planarVectorStylePatch(vectorStyle, { monochrome_color: value }))} /> : null}
  </InspectorGroup>;
}

export function PlanarWireframeSection({
  disabled = false,
  draftPath = "wireframe.opacity",
  hasOverride,
  reason,
  style,
  onReset,
  onStyleChange,
}: {
  disabled?: boolean;
  draftPath?: string;
  hasOverride: boolean;
  reason?: string;
  style: Planar["wireframe_style"];
  onReset: () => void;
  onStyleChange: (style: Planar["wireframe_style"]) => void;
}) {
  const { pending } = usePlanarPresentationDraftState();
  return (
    <InspectorGroup title="Wireframe">
      <FieldRow
        label="Target style"
        value={reason ?? (hasOverride ? "Target override" : "Global fallback")}
      />
      <ColorField
        disabled={disabled}
        label="Wireframe color"
        value={style.color}
        onChange={(color) => onStyleChange({ ...style, color })}
      />
      <PlanarNumberField
        disabled={disabled}
        hint={reason}
        label="Wireframe opacity"
        maximum={1}
        minimum={0}
        path={draftPath}
        value={style.opacity}
        onCommit={(opacity) => onStyleChange({ ...style, opacity })}
      />
      <div className="fm-inspector-toolbar">
        <Button
          disabled={disabled || pending || !hasOverride}
          size="sm"
          type="button"
          variant="secondary"
          onClick={onReset}
        >
          Reset wireframe override
        </Button>
      </div>
    </InspectorGroup>
  );
}

export function PlanarPointsSection({
  style,
  patch,
}: {
  style: Planar["point_style"];
  patch: (next: PlanarPatch) => void;
}) {
  return (
    <InspectorGroup title="Points">
      <ColorField label="Point color" value={style.color} onChange={(color) => patch({ point_style: { ...style, color } })} />
      <PlanarNumberField label="Point opacity" maximum={1} minimum={0} path="point_style.opacity" value={style.opacity} onCommit={(opacity) => patch({ point_style: { ...style, opacity } })} />
      <PlanarNumberField label="Point size" maximum={64} minimum={0} minimumExclusive path="point_style.size" value={style.size} onCommit={(size) => patch({ point_style: { ...style, size } })} />
    </InspectorGroup>
  );
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
  return <InspectorGroup collapsible defaultOpen={false} title="Sampling & Resolution">
    <FormField disabled={!capability.enabled} hint={hint} label="Render quality" type="select" value={quality} onChange={(event) => patch({ quality: event.currentTarget.value as Planar["quality"] })}>{PLANAR_QUALITY_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    <PlanarNumberField disabled={!capability.enabled} hint={hint} integer label="Resolution width" maximum={2048} minimum={16} path="resolution.width" value={resolution.width} onCommit={(value) => patch(planarResolutionPatch(resolution, { width: value }))} />
    <PlanarNumberField disabled={!capability.enabled} hint={hint} integer label="Resolution height" maximum={2048} minimum={16} path="resolution.height" value={resolution.height} onCommit={(value) => patch(planarResolutionPatch(resolution, { height: value }))} />
    <PlanarNumberField disabled={!capability.enabled} hint={hint} label="Interaction zoom" minimum={0} minimumExclusive path="interaction.zoom" value={interaction.zoom} onCommit={(value) => patch(planarInteractionPatch(interaction, { zoom: value }))} />
  </InspectorGroup>;
}

export function PlanarProvenanceSection({
  meta,
  source,
}: {
  meta: {
    data: {
      canonical_unit?: string;
      component?: string;
      field_backend?: string | null;
      field_device?: string | null;
      field_revision?: string;
      field_precision?: string | null;
      field_source?: string;
      carrier_revision?: string;
      mesh_revision?: string;
      quantity_id?: string;
      sample_token?: string;
      sampling_execution?: string;
      sampling_method?: string;
      source?:
        | {
            kind: "default";
            default_slice_hash: string;
            default_slice_revision: string;
          }
        | {
            kind: "monitor";
            monitor_hash: string;
            monitor_id: string;
            monitor_revision: string;
          };
    } | null;
    status: string;
  };
  source: PlanarFieldSource;
}) {
  const sourceLabel = source.kind === "default" ? "Default" : source.monitorId;
  const sourceRevision = meta.data?.source?.kind === "default"
    ? meta.data.source.default_slice_revision
    : meta.data?.source?.monitor_revision;
  const sourceHash = meta.data?.source?.kind === "default"
    ? meta.data.source.default_slice_hash
    : meta.data?.source?.monitor_hash;
  return <InspectorGroup collapsible defaultOpen={false} title="Provenance">
    <FieldRow label="Availability" value={meta.status === "error" ? "Unavailable for this source" : meta.status} />
    <FieldRow label="Source" value={sourceLabel} />
    <FieldRow label="Source hash" mono value={sourceHash ?? "Not sampled"} />
    <FieldRow label="Source revision" value={sourceRevision ?? "Not sampled"} />
    <FieldRow label="Sample token" value={meta.data?.sample_token ?? "Not sampled"} />
    <FieldRow label="Quantity" value={meta.data?.quantity_id ?? "Not sampled"} />
    <FieldRow label="Component" value={meta.data?.component ?? "Not sampled"} />
    <FieldRow label="Unit" value={meta.data?.canonical_unit ?? "Not sampled"} />
    <FieldRow label="Field backend" value={meta.data?.field_backend ?? "Not published"} />
    <FieldRow label="Field device" value={meta.data?.field_device ?? "Not published"} />
    <FieldRow label="Field precision" value={meta.data?.field_precision ?? "Not published"} />
    <FieldRow label="Field source" value={meta.data?.field_source ?? "Not sampled"} />
    <FieldRow label="Field revision" value={meta.data?.field_revision ?? "Not sampled"} />
    <FieldRow label="Carrier revision" value={meta.data?.carrier_revision ?? "Not sampled"} />
    <FieldRow label="Mesh revision" value={meta.data?.mesh_revision ?? "Not sampled"} />
    <FieldRow label="Sampling execution" value={meta.data?.sampling_execution ?? "Not sampled"} />
    <FieldRow label="Sampling" value={meta.data?.sampling_method ?? "Not sampled"} />
  </InspectorGroup>;
}
