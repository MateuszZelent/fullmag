import type { Viewport3DCapabilities, Viewport3DToolbarState } from "../contracts";

export interface Viewport3DToolbarInputs {
  capabilities: Viewport3DCapabilities;
  has_topology: boolean;
  has_field_data: boolean;
}

export interface Viewport3DFieldDataEvidence {
  statusFieldRevision?: string | number | null;
  femMeshFieldRevision?: string | number | null;
  dataPlaneFieldRevision?: string | number | null;
  selectedVectorCount?: number | null;
}

export interface Viewport3DResourceEvidence extends Viewport3DFieldDataEvidence {
  statusTopologyRevision?: string | number | null;
  topologyFallbackRevision?: string | number | null;
}

export interface Viewport3DResourceState {
  hasTopology: boolean;
  hasFieldData: boolean;
  topologyRevision: string | null;
  fieldRevision: string | null;
  fieldDataRevision: string | null;
}

function stringifyRevision(value: string | number | null | undefined): string | null {
  return value != null ? String(value) : null;
}

export function hasViewport3DFieldData({
  statusFieldRevision = null,
  femMeshFieldRevision = null,
  dataPlaneFieldRevision = null,
  selectedVectorCount = null,
}: Viewport3DFieldDataEvidence): boolean {
  return Boolean(
    statusFieldRevision != null ||
      femMeshFieldRevision != null ||
      dataPlaneFieldRevision != null ||
      (selectedVectorCount != null && selectedVectorCount > 0),
  );
}

export function resolveViewport3DResourceState({
  statusTopologyRevision = null,
  topologyFallbackRevision = null,
  statusFieldRevision = null,
  femMeshFieldRevision = null,
  dataPlaneFieldRevision = null,
  selectedVectorCount = null,
}: Viewport3DResourceEvidence): Viewport3DResourceState {
  const topologyRevision =
    stringifyRevision(statusTopologyRevision) ?? stringifyRevision(topologyFallbackRevision);
  const fieldRevision =
    stringifyRevision(statusFieldRevision) ??
    stringifyRevision(femMeshFieldRevision) ??
    stringifyRevision(dataPlaneFieldRevision);
  const fieldDataRevision =
    stringifyRevision(dataPlaneFieldRevision) ??
    stringifyRevision(femMeshFieldRevision) ??
    stringifyRevision(statusFieldRevision);

  return {
    hasTopology: topologyRevision != null,
    hasFieldData: hasViewport3DFieldData({
      statusFieldRevision,
      femMeshFieldRevision,
      dataPlaneFieldRevision,
      selectedVectorCount,
    }),
    topologyRevision,
    fieldRevision,
    fieldDataRevision,
  };
}

export function runtimeToViewport3DToolbarState(
  input: Viewport3DToolbarInputs,
): Viewport3DToolbarState {
  const quantity_enabled = input.has_field_data;
  const component_enabled = input.has_field_data && input.capabilities.can_show_vectors;
  const clip_enabled = input.has_topology;
  const render_mode_enabled = input.capabilities.can_render_3d;

  return {
    quantity_enabled,
    component_enabled,
    clip_enabled,
    render_mode_enabled,
    reasons: {
      quantity: quantity_enabled ? null : "field data unavailable",
      component: component_enabled ? null : "vector components unsupported",
      clip: clip_enabled ? null : "topology unavailable",
      render_mode: render_mode_enabled ? null : "3d preview unavailable",
    },
  };
}
