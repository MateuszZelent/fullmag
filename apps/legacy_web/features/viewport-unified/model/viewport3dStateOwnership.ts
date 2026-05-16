export type Viewport3DStateOwner =
  | "display-resource"
  | "viewport-render-state"
  | "viewport-camera-state"
  | "geometry-builder-state";

export type Viewport3DStatePersistence =
  | "runtime-session"
  | "workspace-ui"
  | "authoring-workspace";

export interface Viewport3DStateOwnershipEntry {
  state: string;
  owner: Viewport3DStateOwner;
  persistence: Viewport3DStatePersistence;
  backendContract: string | null;
  changesPhysics: boolean;
}

export const VIEWPORT_3D_STATE_OWNERSHIP = [
  {
    state: "active_quantity",
    owner: "display-resource",
    persistence: "runtime-session",
    backendContract: "PATCH /display",
    changesPhysics: false,
  },
  {
    state: "view_mode",
    owner: "display-resource",
    persistence: "runtime-session",
    backendContract: "PATCH /display",
    changesPhysics: false,
  },
  {
    state: "field_component",
    owner: "display-resource",
    persistence: "runtime-session",
    backendContract: "PATCH /display",
    changesPhysics: false,
  },
  {
    state: "vector_density",
    owner: "display-resource",
    persistence: "runtime-session",
    backendContract: "PATCH /display",
    changesPhysics: false,
  },
  {
    state: "slice_layer_mode",
    owner: "display-resource",
    persistence: "runtime-session",
    backendContract: "PATCH /display",
    changesPhysics: false,
  },
  {
    state: "colormap_contrast",
    owner: "display-resource",
    persistence: "runtime-session",
    backendContract: "PATCH /display",
    changesPhysics: false,
  },
  {
    state: "fem_render_mode",
    owner: "viewport-render-state",
    persistence: "workspace-ui",
    backendContract: null,
    changesPhysics: false,
  },
  {
    state: "fem_layer_visibility",
    owner: "viewport-render-state",
    persistence: "workspace-ui",
    backendContract: null,
    changesPhysics: false,
  },
  {
    state: "fem_arrows_visibility",
    owner: "viewport-render-state",
    persistence: "workspace-ui",
    backendContract: null,
    changesPhysics: false,
  },
  {
    state: "fdm_glyph_voxel_topography",
    owner: "viewport-render-state",
    persistence: "workspace-ui",
    backendContract: null,
    changesPhysics: false,
  },
  {
    state: "legend_visibility",
    owner: "viewport-render-state",
    persistence: "workspace-ui",
    backendContract: null,
    changesPhysics: false,
  },
  {
    state: "camera_projection_navigation_preset",
    owner: "viewport-camera-state",
    persistence: "workspace-ui",
    backendContract: null,
    changesPhysics: false,
  },
  {
    state: "authoring_transform_snap",
    owner: "geometry-builder-state",
    persistence: "authoring-workspace",
    backendContract: null,
    changesPhysics: false,
  },
] as const satisfies readonly Viewport3DStateOwnershipEntry[];

export function getViewport3DStateOwnership(
  state: string,
): Viewport3DStateOwnershipEntry | null {
  return VIEWPORT_3D_STATE_OWNERSHIP.find((entry) => entry.state === state) ?? null;
}
