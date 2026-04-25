import type {
  CapabilityMap,
  DisplaySelection,
  ResourceRevisionMap,
} from "../../api/types";

export type SharedSurfaceStatus =
  | "idle"
  | "loading"
  | "stale"
  | "ready"
  | "building"
  | "degraded"
  | "error";

export type QuantityComponent = "3D" | "x" | "y" | "z" | "magnitude";

export interface QuantitySelectionState {
  activeQuantityId: string;
  component: QuantityComponent;
  colormap: string;
  autoContrast: boolean;
  contrastMin: number | null;
  contrastMax: number | null;
}

export type ViewMode = "2d" | "3d" | "mesh";
export type SelectionKind =
  | "scene_object"
  | "primitive"
  | "mesh_part"
  | "mesh_segment"
  | "mesh_element"
  | "mesh_node"
  | "slice_probe"
  | "none";

export interface SelectionIdentity {
  kind: SelectionKind;
  id: string | null;
}

export type SelectionSourceSurface =
  | "geometry"
  | "mesh"
  | "slice2d"
  | "viewport3d"
  | null;

export interface CrossSurfaceSelectionState {
  primary: SelectionIdentity;
  multi: SelectionIdentity[];
  sourceSurface: SelectionSourceSurface;
  mappedSceneObjectId: string | null;
}

export type SliceAxis = "x" | "y" | "z";

export interface SlicePlaneState {
  axis: SliceAxis;
  mode: "single" | "slab" | "all_layers";
  positionPercent: number;
  layerIndex: number | null;
  thicknessPercent: number | null;
  syncWith3DClip: boolean;
}

export type MeshDirtyReason =
  | "scene_changed"
  | "universe_changed"
  | "shared_domain_changed"
  | "object_override_changed"
  | "backend_mesh_policy_changed";

export type MeshRecommendedAction =
  | "build_required"
  | "rebuild_recommended"
  | "no_action"
  | "blocked_by_missing_universe"
  | "blocked_by_invalid_shared_domain";

export interface MeshDirtyState {
  isDirty: boolean;
  reasons: MeshDirtyReason[];
  sinceSceneRevision: number | null;
  lastSuccessfulBuildId: string | null;
  recommendedAction: MeshRecommendedAction;
}

export interface DomainRevisionState {
  domainGenerationId: number | null;
  topologyRevision: number | null;
  fieldsRevision: number | null;
  scalarsRevision: number | null;
  displayRevision: number | null;
  meshRevision: number | null;
  meshBuildRevision: number | null;
  sceneRevision: number | null;
}

export interface SharedViewportCapabilities {
  preview_2d: boolean;
  preview_3d: boolean;
  meshing: boolean;
  structured_grid: boolean;
  explicit_topology: boolean;
  authoring_primitives: boolean;
  mesh_quality_metrics: boolean;
  part_manifest: boolean;
  slice_probe: boolean;
  slice_profile: boolean;
}

export type CapabilityReasonMap = Partial<Record<keyof SharedViewportCapabilities, string>>;

export interface CapabilityGate {
  enabled: boolean;
  reason: string | null;
}

export type CapabilityGateMap = {
  [K in keyof SharedViewportCapabilities]: CapabilityGate;
};

export interface WorkspaceSyncState {
  quantitySync: boolean;
  selectionSync: boolean;
  planeSync: boolean;
  followSelectionAcrossTabs: boolean;
}

export type WorkspaceSyncAction =
  | { type: "set_quantity_sync"; enabled: boolean }
  | { type: "set_selection_sync"; enabled: boolean }
  | { type: "set_plane_sync"; enabled: boolean }
  | { type: "set_follow_selection_across_tabs"; enabled: boolean }
  | { type: "reset" };

export const DEFAULT_WORKSPACE_SYNC_STATE: WorkspaceSyncState = {
  quantitySync: true,
  selectionSync: true,
  planeSync: false,
  followSelectionAcrossTabs: false,
};

export const EMPTY_CROSS_SURFACE_SELECTION: CrossSurfaceSelectionState = {
  primary: { kind: "none", id: null },
  multi: [],
  sourceSurface: null,
  mappedSceneObjectId: null,
};

const CAPABILITY_REASONS: CapabilityReasonMap = {
  preview_2d: "Requires preview_2d capability",
  preview_3d: "Requires preview_3d capability",
  meshing: "Requires meshing capability",
  structured_grid: "Requires structured_grid capability",
  explicit_topology: "Requires explicit_topology capability",
  authoring_primitives: "Requires authoring_primitives capability",
  mesh_quality_metrics: "Requires mesh_quality_metrics capability",
  part_manifest: "Requires part_manifest capability",
  slice_probe: "Requires slice_probe capability",
  slice_profile: "Requires slice_profile capability",
};

export function normalizeQuantityComponent(component: string | null | undefined): QuantityComponent {
  if (component === "3D" || component === "x" || component === "y" || component === "z") {
    return component;
  }
  return "magnitude";
}

export function quantitySelectionFromDisplay(
  display: Pick<
    DisplaySelection,
    | "active_quantity_id"
    | "view_mode"
    | "field_component"
    | "colormap"
    | "auto_contrast"
    | "contrast_min"
    | "contrast_max"
  >,
): QuantitySelectionState {
  return {
    activeQuantityId: display.active_quantity_id,
    component: display.view_mode === "3d" ? "3D" : normalizeQuantityComponent(display.field_component),
    colormap: display.colormap,
    autoContrast: display.auto_contrast,
    contrastMin: display.contrast_min,
    contrastMax: display.contrast_max,
  };
}

export function slicePlaneFromDisplay(
  display: Pick<DisplaySelection, "slice_mode" | "slice_layer">,
  options?: {
    axis?: SliceAxis;
    positionPercent?: number;
    thicknessPercent?: number | null;
    syncWith3DClip?: boolean;
  },
): SlicePlaneState {
  const sliceMode = display.slice_mode === "all_layers" ? "all_layers" : display.slice_mode === "slab" ? "slab" : "single";
  return {
    axis: options?.axis ?? "z",
    mode: sliceMode,
    positionPercent: clampPercent(options?.positionPercent ?? 50),
    layerIndex: Number.isFinite(display.slice_layer) ? Math.max(0, Math.trunc(display.slice_layer)) : null,
    thicknessPercent:
      options?.thicknessPercent == null ? null : clampPercent(options.thicknessPercent),
    syncWith3DClip: options?.syncWith3DClip ?? false,
  };
}

export function domainRevisionStateFromResources(
  resources: Partial<ResourceRevisionMap> | null | undefined,
): DomainRevisionState {
  return {
    domainGenerationId: resources?.domain_generation_id ?? null,
    topologyRevision: resources?.topology_revision ?? null,
    fieldsRevision: resources?.fields_revision ?? resources?.field_revision ?? null,
    scalarsRevision: resources?.scalars_revision ?? null,
    displayRevision: resources?.display_revision ?? null,
    meshRevision: resources?.mesh_revision ?? null,
    meshBuildRevision: resources?.mesh_build_revision ?? null,
    sceneRevision: resources?.scene_revision ?? null,
  };
}

export function sharedCapabilitiesFromApi(
  capabilities: CapabilityMap | null | undefined,
  overrides?: Partial<SharedViewportCapabilities>,
): SharedViewportCapabilities {
  return {
    preview_2d: Boolean(capabilities?.preview_2d ?? overrides?.preview_2d),
    preview_3d: Boolean(capabilities?.preview_3d ?? overrides?.preview_3d),
    meshing: Boolean(overrides?.meshing ?? capabilities?.explicit_topology ?? capabilities?.structured_grid),
    structured_grid: Boolean(capabilities?.structured_grid ?? overrides?.structured_grid),
    explicit_topology: Boolean(capabilities?.explicit_topology ?? overrides?.explicit_topology),
    authoring_primitives: Boolean(overrides?.authoring_primitives ?? true),
    mesh_quality_metrics: Boolean(overrides?.mesh_quality_metrics ?? capabilities?.explicit_topology),
    part_manifest: Boolean(overrides?.part_manifest ?? capabilities?.explicit_topology),
    slice_probe: Boolean(overrides?.slice_probe ?? capabilities?.preview_2d),
    slice_profile: Boolean(overrides?.slice_profile ?? capabilities?.preview_2d),
  };
}

export function capabilityGateMap(
  capabilities: SharedViewportCapabilities,
  reasons: CapabilityReasonMap = CAPABILITY_REASONS,
): CapabilityGateMap {
  return Object.fromEntries(
    (Object.keys(capabilities) as Array<keyof SharedViewportCapabilities>).map((key) => [
      key,
      {
        enabled: capabilities[key],
        reason: capabilities[key] ? null : reasons[key] ?? `Requires ${key}`,
      },
    ]),
  ) as CapabilityGateMap;
}

export function reduceCrossSurfaceSelection(
  current: CrossSurfaceSelectionState,
  next: {
    primary: SelectionIdentity;
    sourceSurface: SelectionSourceSurface;
    mappedSceneObjectId?: string | null;
    multi?: SelectionIdentity[];
  },
): CrossSurfaceSelectionState {
  const primary =
    next.primary.kind === "none"
      ? { kind: "none" as const, id: null }
      : { kind: next.primary.kind, id: next.primary.id };
  const multi = next.multi ?? current.multi.filter((entry) => entry.kind !== primary.kind || entry.id !== primary.id);
  return {
    primary,
    multi,
    sourceSurface: next.sourceSurface,
    mappedSceneObjectId: next.mappedSceneObjectId ?? null,
  };
}

export function reduceWorkspaceSyncState(
  current: WorkspaceSyncState,
  action: WorkspaceSyncAction,
): WorkspaceSyncState {
  switch (action.type) {
    case "set_quantity_sync":
      return { ...current, quantitySync: action.enabled };
    case "set_selection_sync":
      return { ...current, selectionSync: action.enabled };
    case "set_plane_sync":
      return { ...current, planeSync: action.enabled };
    case "set_follow_selection_across_tabs":
      return { ...current, followSelectionAcrossTabs: action.enabled };
    case "reset":
      return DEFAULT_WORKSPACE_SYNC_STATE;
    default:
      return current;
  }
}

export function isDomainTopologyStale(
  previous: DomainRevisionState | null | undefined,
  next: DomainRevisionState | null | undefined,
): boolean {
  if (!previous || !next) return false;
  return (
    previous.domainGenerationId !== next.domainGenerationId ||
    previous.topologyRevision !== next.topologyRevision ||
    previous.meshRevision !== next.meshRevision ||
    previous.meshBuildRevision !== next.meshBuildRevision
  );
}

export function isFieldPayloadStale(
  previous: DomainRevisionState | null | undefined,
  next: DomainRevisionState | null | undefined,
): boolean {
  if (!previous || !next) return false;
  return previous.fieldsRevision !== next.fieldsRevision;
}

export function shouldResampleSliceForRevisionChange(
  previous: DomainRevisionState | null | undefined,
  next: DomainRevisionState | null | undefined,
): boolean {
  return isDomainTopologyStale(previous, next) || isFieldPayloadStale(previous, next);
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}
