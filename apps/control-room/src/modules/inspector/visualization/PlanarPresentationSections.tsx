import type {
  PlanarFieldSource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { FieldMapCapability } from "@/kernel/visualization/planarCapabilities";
import type { PlanarResolutionPreset } from "@/kernel/visualization/planarSectionModel";
import { Button } from "@/shared/ui/Button";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { ColorField } from "../panels/ObjectVisualizationTargetSection";
import {
  PLANAR_QUALITY_ITEMS,
  planarInteractionPatch,
  planarResolutionPatch,
} from "./presentationSemantics";

type Planar = NonNullable<VisualizationStateResource["planar"]>;
type PlanarPatch = NonNullable<Parameters<(patch: { planar: Partial<Planar> }) => void>[0]["planar"]>;

export function PlanarWireframeSection({
  disabled = false,
  hasOverride,
  reason,
  style,
  onReset,
  onStyleChange,
}: {
  disabled?: boolean;
  hasOverride: boolean;
  reason?: string;
  style: Planar["wireframe_style"];
  onReset: () => void;
  onStyleChange: (style: Planar["wireframe_style"]) => void;
}) {
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
      <FormField
        disabled={disabled}
        hint={reason}
        label="Wireframe opacity"
        max="1"
        min="0"
        step="0.05"
        type="number"
        value={style.opacity}
        onChange={(event) => {
          const opacity = Number(event.currentTarget.value);
          if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1) {
            onStyleChange({ ...style, opacity });
          }
        }}
      />
      <div className="fm-inspector-toolbar">
        <Button
          disabled={disabled || !hasOverride}
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
      <FormField label="Point opacity" max="1" min="0" step="0.05" type="number" value={style.opacity} onChange={(event) => { const opacity = Number(event.currentTarget.value); if (Number.isFinite(opacity) && opacity >= 0 && opacity <= 1) patch({ point_style: { ...style, opacity } }); }} />
      <FormField label="Point size" max="64" min="0.5" step="0.5" type="number" value={style.size} onChange={(event) => { const size = Number(event.currentTarget.value); if (Number.isFinite(size) && size > 0) patch({ point_style: { ...style, size } }); }} />
    </InspectorGroup>
  );
}

export function PlanarQualitySection({
  capability,
  interaction,
  quality,
  resolution,
  resolutionPresets = [],
  patch,
}: {
  capability: FieldMapCapability;
  interaction: Planar["interaction"];
  quality: Planar["quality"];
  resolution: Planar["resolution"];
  resolutionPresets?: readonly PlanarResolutionPreset[];
  patch: (next: PlanarPatch) => void;
}) {
  const hint = capability.enabled ? undefined : capability.reasonCode === "quantity_not_spatial" ? "The selected quantity is not spatially sampleable." : capability.reasonCode?.replaceAll("_", " ");
  const activePreset = resolutionPresets.find((preset) => preset.width === resolution.width && preset.height === resolution.height);
  return <InspectorGroup collapsible defaultOpen={false} title="Sampling & Resolution">
    <FormField disabled={!capability.enabled} hint={hint} label="Render quality" type="select" value={quality} onChange={(event) => patch({ quality: event.currentTarget.value as Planar["quality"] })}>{PLANAR_QUALITY_ITEMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</FormField>
    {resolutionPresets.length > 0 ? <FormField disabled={!capability.enabled} hint="Pixels covering whole cells are exact area averages." label="Grid resolution" type="select" value={activePreset ? `${activePreset.width}x${activePreset.height}` : "custom"} onChange={(event) => { const preset = resolutionPresets.find((item) => `${item.width}x${item.height}` === event.currentTarget.value); if (preset) patch(planarResolutionPatch(resolution, { width: preset.width, height: preset.height })); }}>{activePreset ? null : <option value="custom">Custom ({resolution.width} × {resolution.height})</option>}{resolutionPresets.map((preset) => <option key={preset.label} value={`${preset.width}x${preset.height}`}>{preset.label}</option>)}</FormField> : null}
    <FormField disabled={!capability.enabled} hint={hint} label="Resolution width" max="2048" min="16" step="1" type="number" value={resolution.width} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 16 && value <= 2048) patch(planarResolutionPatch(resolution, { width: value })); }} />
    <FormField disabled={!capability.enabled} hint={hint} label="Resolution height" max="2048" min="16" step="1" type="number" value={resolution.height} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= 16 && value <= 2048) patch(planarResolutionPatch(resolution, { height: value })); }} />
    <FormField disabled={!capability.enabled} hint={hint} label="Interaction zoom" min="0.01" step="0.1" type="number" value={interaction.zoom} onChange={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value) && value > 0) patch(planarInteractionPatch(interaction, { zoom: value })); }} />
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
