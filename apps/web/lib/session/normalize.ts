/* ── Session state normalizers ──
 * All functions that normalize raw JSON wire data into typed SessionState. */

import type {
  CurrentDisplaySelection,
  DisplayKind,
  FemLiveMesh,
  FemLiveMeshObjectSegment,
  FemMeshPart,
  LatestFieldFrame,
  LatestFields,
  LiveState,
  MeshCommandTarget,
  SceneEditorMeshEntityViewState,
  ModelBuilderGraphV2,
  MeshWorkspaceState,
  PreviewConfig,
  PreviewState,
  RuntimeStatusKind,
  RuntimeStatusState,
  SceneDocument,
  ScriptBuilderState,
  SessionState,
} from "./types";
import { createModelBuilderGraphV2 } from "./modelBuilderGraph";
import {
  buildSceneDocumentFromScriptBuilder,
  buildScriptBuilderFromSceneDocument,
} from "./sceneDocument";
import { ensureObjectPhysicsStack } from "./magneticPhysics";

function normalizeSessionManifest(raw: any) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    ...raw,
    explicit_selection: Boolean(raw.explicit_selection),
    requested_device:
      typeof raw.requested_device === "string" ? raw.requested_device : "auto",
    requested_precision:
      typeof raw.requested_precision === "string"
        ? raw.requested_precision
        : typeof raw.precision === "string"
          ? raw.precision
          : "double",
    requested_mode:
      typeof raw.requested_mode === "string"
        ? raw.requested_mode
        : typeof raw.execution_mode === "string"
          ? raw.execution_mode
          : "strict",
    resolved_backend:
      typeof raw.resolved_backend === "string" ? raw.resolved_backend : null,
    resolved_device:
      typeof raw.resolved_device === "string" ? raw.resolved_device : null,
    resolved_precision:
      typeof raw.resolved_precision === "string" ? raw.resolved_precision : null,
    resolved_mode: typeof raw.resolved_mode === "string" ? raw.resolved_mode : null,
    resolved_runtime_family:
      typeof raw.resolved_runtime_family === "string" ? raw.resolved_runtime_family : null,
    resolved_engine_id:
      typeof raw.resolved_engine_id === "string" ? raw.resolved_engine_id : null,
    resolved_worker: typeof raw.resolved_worker === "string" ? raw.resolved_worker : null,
    resolved_fallback:
      raw.resolved_fallback && typeof raw.resolved_fallback === "object"
        ? raw.resolved_fallback
        : undefined,
  };
}

/* ── Field helpers ── */

function toFloat64Array(raw: unknown): Float64Array | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const values = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    values[i] = Number(raw[i] ?? 0);
  }
  return values;
}

function normalizeVectorFieldValues(raw: unknown): Float64Array | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  if (raw.length === 0) {
    return new Float64Array(0);
  }
  if (Array.isArray(raw[0])) {
    const source = raw as unknown[];
    const flattened = new Float64Array(source.length * 3);
    let offset = 0;
    for (const vector of source) {
      flattened[offset] = Number(Array.isArray(vector) ? vector[0] ?? 0 : 0);
      flattened[offset + 1] = Number(Array.isArray(vector) ? vector[1] ?? 0 : 0);
      flattened[offset + 2] = Number(Array.isArray(vector) ? vector[2] ?? 0 : 0);
      offset += 3;
    }
    return flattened;
  }
  return toFloat64Array(raw);
}

function normalizeActiveMask(raw: unknown): Uint8Array | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const mask = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    mask[i] = raw[i] ? 1 : 0;
  }
  return mask;
}

function fieldGrid(raw: any): [number, number, number] | null {
  if (Array.isArray(raw?.grid) && raw.grid.length === 3) {
    return [Number(raw.grid[0]), Number(raw.grid[1]), Number(raw.grid[2])];
  }
  const grid = raw?.layout?.grid_cells;
  if (!Array.isArray(grid) || grid.length !== 3) {
    return null;
  }
  return [Number(grid[0]), Number(grid[1]), Number(grid[2])];
}

function normalizeLatestFieldFrame(
  quantityId: string,
  raw: any,
): LatestFieldFrame | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const values = normalizeVectorFieldValues(raw.values);
  const grid = fieldGrid(raw);
  if (!values || !grid) {
    return null;
  }
  const nComp =
    typeof raw.n_comp === "number" && Number.isFinite(raw.n_comp)
      ? Math.max(1, Math.trunc(raw.n_comp))
      : Array.isArray(raw.values) && raw.values.length > 0 && Array.isArray(raw.values[0])
        ? Math.max(1, (raw.values[0] as unknown[]).length)
        : 1;
  return {
    quantity_id: quantityId,
    unit: typeof raw.unit === "string" ? raw.unit : "",
    n_comp: nComp,
    grid,
    values,
    active_mask: normalizeActiveMask(raw.active_mask),
    location: typeof raw.location === "string" ? raw.location : null,
    domain: typeof raw.domain === "string" ? raw.domain : null,
  };
}

function normalizeLatestFields(raw: any): LatestFields {
  if (!raw || typeof raw !== "object") {
    return { frames: {}, grid: null };
  }

  const frames: Record<string, LatestFieldFrame> = {};
  let grid: [number, number, number] | null = null;

  for (const [quantity, value] of Object.entries(raw)) {
    const frame = normalizeLatestFieldFrame(quantity, value);
    if (frame) {
      frames[quantity] = frame;
    }
    if (!grid && frame) {
      grid = frame.grid;
    }
  }

  return { frames, grid };
}

/* ── Enum-like normalizers ── */

function normalizeDisplayKind(raw: unknown): DisplayKind {
  switch (raw) {
    case "spatial_scalar":
      return "spatial_scalar";
    case "global_scalar":
      return "global_scalar";
    default:
      return "vector_field";
  }
}

export function normalizeMeshCommandTarget(raw: unknown): MeshCommandTarget | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === "study_domain") {
    return { kind: "study_domain" };
  }
  if (kind === "adaptive_followup") {
    return { kind: "adaptive_followup" };
  }
  if (kind === "airbox") {
    return { kind: "airbox" };
  }
  if (kind === "object_mesh") {
    const objectId = (raw as { object_id?: unknown }).object_id;
    if (typeof objectId === "string" && objectId) {
      return { kind: "object_mesh", object_id: objectId };
    }
  }
  return null;
}

function normalizeRuntimeStatusKind(raw: unknown): RuntimeStatusKind {
  switch (raw) {
    case "bootstrapping":
    case "materializing":
    case "materializing_script":
    case "waiting_for_compute":
    case "awaiting_command":
    case "running":
    case "paused":
    case "breaking":
    case "closing":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return "unknown";
  }
}

function normalizeFemMeshPartRole(
  raw: unknown,
): "air" | "magnetic_object" | "interface" | "outer_boundary" {
  switch (raw) {
    case "air":
    case "magnetic_object":
    case "interface":
    case "outer_boundary":
      return raw;
    default:
      return "magnetic_object";
  }
}

function normalizeFemLiveMeshObjectSegments(raw: unknown): FemLiveMeshObjectSegment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value) => value && typeof value === "object")
    .map((value) => {
      const segment = value as Record<string, unknown>;
      return {
        object_id: String(segment.object_id ?? ""),
        geometry_id: typeof segment.geometry_id === "string" ? segment.geometry_id : null,
        node_start: Number(segment.node_start ?? 0),
        node_count: Number(segment.node_count ?? 0),
        element_start: Number(segment.element_start ?? 0),
        element_count: Number(segment.element_count ?? 0),
        boundary_face_start: Number(segment.boundary_face_start ?? 0),
        boundary_face_count: Number(segment.boundary_face_count ?? 0),
      };
    });
}

function normalizeMeshPart(raw: Record<string, unknown>): FemMeshPart {
  return {
    id: String(raw.id ?? ""),
    label: String(raw.label ?? ""),
    role: normalizeFemMeshPartRole(raw.role),
    object_id: typeof raw.object_id === "string" ? raw.object_id : null,
    geometry_id: typeof raw.geometry_id === "string" ? raw.geometry_id : null,
    material_id: typeof raw.material_id === "string" ? raw.material_id : null,
    element_start: Number(raw.element_start ?? 0),
    element_count: Number(raw.element_count ?? 0),
    boundary_face_start: Number(raw.boundary_face_start ?? 0),
    boundary_face_count: Number(raw.boundary_face_count ?? 0),
    boundary_face_indices: Array.isArray(raw.boundary_face_indices)
      ? raw.boundary_face_indices.map((value) => Number(value ?? 0))
      : [],
    node_start: Number(raw.node_start ?? 0),
    node_count: Number(raw.node_count ?? 0),
    node_indices: Array.isArray(raw.node_indices)
      ? raw.node_indices.map((value) => Number(value ?? 0))
      : [],
    surface_faces: Array.isArray(raw.surface_faces)
      ? raw.surface_faces
          .filter((face) => Array.isArray(face) && face.length >= 3)
          .map((face) => [
            Number(face[0] ?? 0),
            Number(face[1] ?? 0),
            Number(face[2] ?? 0),
          ] as [number, number, number])
      : [],
    bounds_min: normalizeVec3(raw.bounds_min),
    bounds_max: normalizeVec3(raw.bounds_max),
  };
}

function normalizeMeshParts(raw: unknown): FemMeshPart[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((value) => value && typeof value === "object")
    .map((value) => normalizeMeshPart(value as Record<string, unknown>));
}

function normalizeFemLiveMesh(raw: unknown): FemLiveMesh | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const mesh = raw as Record<string, unknown>;
  const nodes = Array.isArray(mesh.nodes)
    ? mesh.nodes
        .filter((node) => Array.isArray(node) && node.length >= 3)
        .map((node) => [Number(node[0] ?? 0), Number(node[1] ?? 0), Number(node[2] ?? 0)] as [
          number,
          number,
          number,
        ])
    : [];
  const elements = Array.isArray(mesh.elements)
    ? mesh.elements
        .filter((element) => Array.isArray(element) && element.length >= 4)
        .map((element) => [
          Number(element[0] ?? 0),
          Number(element[1] ?? 0),
          Number(element[2] ?? 0),
          Number(element[3] ?? 0),
        ] as [number, number, number, number])
    : [];
  const boundaryFaces = Array.isArray(mesh.boundary_faces)
    ? mesh.boundary_faces
        .filter((face) => Array.isArray(face) && face.length >= 3)
        .map((face) => [Number(face[0] ?? 0), Number(face[1] ?? 0), Number(face[2] ?? 0)] as [
          number,
          number,
          number,
        ])
    : [];
  return {
    mesh_name: typeof mesh.mesh_name === "string" ? mesh.mesh_name : null,
    mesh_id: typeof mesh.mesh_id === "string" ? mesh.mesh_id : null,
    nodes,
    elements,
    element_markers: Array.isArray(mesh.element_markers)
      ? mesh.element_markers.map((value) => Number(value ?? 0))
      : [],
    boundary_faces: boundaryFaces,
    boundary_markers: Array.isArray(mesh.boundary_markers)
      ? mesh.boundary_markers.map((value) => Number(value ?? 0))
      : [],
    object_segments: normalizeFemLiveMeshObjectSegments(mesh.object_segments),
    mesh_parts: normalizeMeshParts(mesh.mesh_parts),
    domain_mesh_mode:
      typeof mesh.domain_mesh_mode === "string" ? mesh.domain_mesh_mode : null,
    domain_frame: normalizeDomainFrame(mesh.domain_frame),
    generation_id: typeof mesh.generation_id === "string" ? mesh.generation_id : null,
  };
}

function normalizeSceneEditorMeshRenderMode(
  raw: unknown,
): SceneEditorMeshEntityViewState["render_mode"] {
  switch (raw) {
    case "surface":
    case "surface+edges":
    case "wireframe":
    case "points":
      return raw;
    default:
      return "surface";
  }
}

function normalizeSceneEditorMeshColorField(
  raw: unknown,
): SceneEditorMeshEntityViewState["color_field"] {
  switch (raw) {
    case "orientation":
    case "x":
    case "y":
    case "z":
    case "magnitude":
    case "quality":
    case "sicn":
    case "none":
      return raw;
    default:
      return "orientation";
  }
}

function normalizeSceneEditorMeshEntityViewState(
  raw: unknown,
): Record<string, SceneEditorMeshEntityViewState> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: Record<string, SceneEditorMeshEntityViewState> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    normalized[key] = {
      visible: Boolean((value as Record<string, unknown>).visible ?? true),
      render_mode: normalizeSceneEditorMeshRenderMode(
        (value as Record<string, unknown>).render_mode,
      ),
      opacity: Number((value as Record<string, unknown>).opacity ?? 100),
      color_field: normalizeSceneEditorMeshColorField(
        (value as Record<string, unknown>).color_field,
      ),
    };
  }
  return normalized;
}

function normalizeVisualizationArrowColorMode(
  raw: unknown,
): SceneDocument["editor"]["visualization_presets"][number]["fem"]["arrow_color_mode"] {
  switch (raw) {
    case "orientation":
    case "x":
    case "y":
    case "z":
    case "magnitude":
    case "monochrome":
      return raw;
    default:
      return "orientation";
  }
}

function normalizeVisualizationPresetMode(
  raw: unknown,
): SceneDocument["editor"]["visualization_presets"][number]["mode"] {
  return raw === "2D" ? "2D" : "3D";
}

function normalizeVisualizationPresetDomain(
  raw: unknown,
): SceneDocument["editor"]["visualization_presets"][number]["domain"] {
  return raw === "fdm" ? "fdm" : "fem";
}

function normalizeFemVectorDomainFilter(
  raw: unknown,
): SceneDocument["editor"]["visualization_presets"][number]["fem"]["vector_domain_filter"] {
  switch (raw) {
    case "magnetic_only":
    case "full_domain":
    case "airbox_only":
      return raw;
    default:
      return "auto";
  }
}

function normalizeFemFerromagnetVisibilityMode(
  raw: unknown,
): SceneDocument["editor"]["visualization_presets"][number]["fem"]["ferromagnet_visibility_mode"] {
  return raw === "ghost" ? "ghost" : "hide";
}

function normalizeVisualizationPresets(
  raw: unknown,
): SceneDocument["editor"]["visualization_presets"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: SceneDocument["editor"]["visualization_presets"] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const value = entry as Record<string, unknown>;
    const fem = value.fem as Record<string, unknown> | undefined;
    const fdm = value.fdm as Record<string, unknown> | undefined;
    const twoD = value.two_d as Record<string, unknown> | undefined;
    const camera = value.camera as Record<string, unknown> | undefined;
    normalized.push({
      id: String(value.id ?? ""),
      name: String(value.name ?? "Visualization"),
      mode: normalizeVisualizationPresetMode(value.mode),
      domain: normalizeVisualizationPresetDomain(value.domain),
      quantity: String(value.quantity ?? "m"),
      fem: {
        render_mode: normalizeSceneEditorMeshRenderMode(fem?.render_mode),
        opacity: Number(fem?.opacity ?? 100),
        clip_enabled: Boolean(fem?.clip_enabled ?? false),
        clip_axis:
          fem?.clip_axis === "y" || fem?.clip_axis === "z" ? fem.clip_axis : "x",
        clip_pos: Number(fem?.clip_pos ?? 50),
        show_arrows: Boolean(fem?.show_arrows ?? true),
        max_points: Number(fem?.max_points ?? 16384),
        arrow_color_mode: normalizeVisualizationArrowColorMode(fem?.arrow_color_mode),
        arrow_mono_color:
          typeof fem?.arrow_mono_color === "string" ? fem.arrow_mono_color : "#00c2ff",
        arrow_alpha: Number(fem?.arrow_alpha ?? 1),
        arrow_length_scale: Number(fem?.arrow_length_scale ?? 1),
        arrow_thickness: Number(fem?.arrow_thickness ?? 1),
        object_view_mode: fem?.object_view_mode === "isolate" ? "isolate" : "context",
        vector_domain_filter: normalizeFemVectorDomainFilter(fem?.vector_domain_filter),
        ferromagnet_visibility_mode: normalizeFemFerromagnetVisibilityMode(
          fem?.ferromagnet_visibility_mode,
        ),
        air_mesh_visible: Boolean(fem?.air_mesh_visible ?? false),
        air_mesh_opacity: Number(fem?.air_mesh_opacity ?? 28),
        mesh_entity_view_state: normalizeSceneEditorMeshEntityViewState(
          fem?.mesh_entity_view_state,
        ),
      },
      fdm: {
        quality:
          fdm?.quality === "low" || fdm?.quality === "ultra" ? fdm.quality : "high",
        render_mode: fdm?.render_mode === "voxel" ? "voxel" : "glyph",
        voxel_color_mode:
          fdm?.voxel_color_mode === "x" ||
          fdm?.voxel_color_mode === "y" ||
          fdm?.voxel_color_mode === "z"
            ? fdm.voxel_color_mode
            : "orientation",
        sampling:
          fdm?.sampling === 2 || fdm?.sampling === 4 ? fdm.sampling : 1,
        brightness: Number(fdm?.brightness ?? 1.5),
        voxel_opacity: Number(fdm?.voxel_opacity ?? 0.5),
        voxel_gap: Number(fdm?.voxel_gap ?? 0.14),
        voxel_threshold: Number(fdm?.voxel_threshold ?? 0.08),
        topo_enabled: Boolean(fdm?.topo_enabled ?? false),
        topo_component:
          fdm?.topo_component === "x" || fdm?.topo_component === "y"
            ? fdm.topo_component
            : "z",
        topo_multiplier: Number(fdm?.topo_multiplier ?? 5),
      },
      two_d: {
        component:
          twoD?.component === "x" ||
          twoD?.component === "y" ||
          twoD?.component === "z"
            ? twoD.component
            : "magnitude",
        plane:
          twoD?.plane === "xz" || twoD?.plane === "yz" ? twoD.plane : "xy",
        slice_index: Number(twoD?.slice_index ?? 0),
      },
      camera: {
        projection:
          camera?.projection === "perspective" || camera?.projection === "orthographic"
            ? camera.projection
            : null,
        navigation:
          camera?.navigation === "trackball" || camera?.navigation === "cad"
            ? camera.navigation
            : null,
        preset:
          camera?.preset === "reset" ||
          camera?.preset === "front" ||
          camera?.preset === "top" ||
          camera?.preset === "right" ||
          camera?.preset === "iso"
            ? camera.preset
            : null,
      },
      created_at_unix_ms: Number(value.created_at_unix_ms ?? Date.now()),
      updated_at_unix_ms: Number(value.updated_at_unix_ms ?? Date.now()),
    });
  }
  return normalized;
}

function normalizeVisualizationPresetRef(
  raw: unknown,
): SceneDocument["editor"]["active_visualization_preset_ref"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const source = value.source === "local" ? "local" : value.source === "project" ? "project" : null;
  const presetId = typeof value.preset_id === "string" ? value.preset_id : null;
  if (!source || !presetId || presetId.trim().length === 0) {
    return null;
  }
  return {
    source,
    preset_id: presetId,
  };
}

/* ── Sub-object normalizers ── */

export function normalizeDisplaySelection(raw: any): CurrentDisplaySelection | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const selection = raw.selection;
  if (!selection || typeof selection !== "object") {
    return null;
  }
  return {
    revision: Number(raw.revision ?? 0),
    selection: {
      quantity: String(selection.quantity ?? "m"),
      kind: normalizeDisplayKind(selection.kind),
      component: String(selection.component ?? "3D"),
      layer: Number(selection.layer ?? 0),
      all_layers: Boolean(selection.all_layers),
      x_chosen_size: Number(selection.x_chosen_size ?? 0),
      y_chosen_size: Number(selection.y_chosen_size ?? 0),
      every_n: Number(selection.every_n ?? 50),
      max_points: Number(selection.max_points ?? 16384),
      auto_scale_enabled: Boolean(selection.auto_scale_enabled ?? true),
    },
  };
}

function normalizeRuntimeStatus(raw: any): RuntimeStatusState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const code = String(raw.code ?? "");
  const kind = normalizeRuntimeStatusKind(raw.kind ?? code);
  return {
    kind,
    code: code || kind,
    is_busy: Boolean(raw.is_busy),
    can_accept_commands: Boolean(raw.can_accept_commands),
  };
}

function normalizePreviewConfig(raw: any): PreviewConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    revision: Number(raw.revision ?? 0),
    quantity: String(raw.quantity ?? "m"),
    component: String(raw.component ?? "3D"),
    layer: Number(raw.layer ?? 0),
    all_layers: Boolean(raw.all_layers),
    every_n: Number(raw.every_n ?? 50),
    x_chosen_size: Number(raw.x_chosen_size ?? 0),
    y_chosen_size: Number(raw.y_chosen_size ?? 0),
    auto_scale_enabled: Boolean(raw.auto_scale_enabled ?? true),
    max_points: Number(raw.max_points ?? 0),
  };
}

function previewConfigFromDisplaySelection(
  displaySelection: CurrentDisplaySelection | null,
): PreviewConfig | null {
  if (!displaySelection) {
    return null;
  }
  return {
    revision: displaySelection.revision,
    quantity: displaySelection.selection.quantity,
    component: displaySelection.selection.component,
    layer: displaySelection.selection.layer,
    all_layers: displaySelection.selection.all_layers,
    every_n: displaySelection.selection.every_n,
    x_chosen_size: displaySelection.selection.x_chosen_size,
    y_chosen_size: displaySelection.selection.y_chosen_size,
    auto_scale_enabled: displaySelection.selection.auto_scale_enabled,
    max_points: displaySelection.selection.max_points,
  };
}

function normalizePreviewState(
  raw: any,
  pendingVectorPayloads?: Map<number, Float64Array>,
): PreviewState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (raw.kind === "global_scalar") {
    return {
      kind: "global_scalar",
      display_kind: "global_scalar",
      config_revision: Number(raw.config_revision ?? 0),
      source_step: Number(raw.source_step ?? 0),
      source_time: Number(raw.source_time ?? 0),
      quantity: String(raw.quantity ?? ""),
      unit: String(raw.unit ?? ""),
      value: Number(raw.value ?? 0),
    };
  }
  return {
    kind: "spatial",
    display_kind:
      raw.display_kind === "spatial_scalar" ? "spatial_scalar" : "vector_field",
    config_revision: Number(raw.config_revision ?? 0),
    source_step: Number(raw.source_step ?? 0),
    source_time: Number(raw.source_time ?? 0),
    spatial_kind: raw.spatial_kind === "mesh" ? "mesh" : "grid",
    quantity: String(raw.quantity ?? ""),
    unit: String(raw.unit ?? ""),
    quantity_domain:
      raw.quantity_domain === "magnetic_only" || raw.quantity_domain === "surface_only"
        ? raw.quantity_domain
        : "full_domain",
    component: String(raw.component ?? "3D"),
    layer: Number(raw.layer ?? 0),
    all_layers: Boolean(raw.all_layers),
    type: String(raw.type ?? "3D"),
    vector_payload_id:
      raw.vector_payload_id != null ? Number(raw.vector_payload_id) : null,
    vector_field_values:
      normalizeVectorFieldValues(raw.vector_field_values) ??
      (raw.vector_payload_id != null
        ? pendingVectorPayloads?.get(Number(raw.vector_payload_id)) ?? null
        : null),
    scalar_field: Array.isArray(raw.scalar_field)
      ? raw.scalar_field
          .filter((point: unknown) => Array.isArray(point) && point.length >= 3)
          .map(
            (point: number[]) =>
              [Number(point[0]), Number(point[1]), Number(point[2])] as [
                number,
                number,
                number,
              ],
          )
      : [],
    min: Number(raw.min ?? 0),
    max: Number(raw.max ?? 0),
    n_comp: Number(raw.n_comp ?? 0),
    max_points: Number(raw.max_points ?? 0),
    data_points_count: Number(raw.data_points_count ?? 0),
    x_possible_sizes: Array.isArray(raw.x_possible_sizes)
      ? raw.x_possible_sizes.map(Number)
      : [],
    y_possible_sizes: Array.isArray(raw.y_possible_sizes)
      ? raw.y_possible_sizes.map(Number)
      : [],
    x_chosen_size: Number(raw.x_chosen_size ?? 0),
    y_chosen_size: Number(raw.y_chosen_size ?? 0),
    applied_x_chosen_size: Number(raw.applied_x_chosen_size ?? 0),
    applied_y_chosen_size: Number(raw.applied_y_chosen_size ?? 0),
    applied_layer_stride: Number(raw.applied_layer_stride ?? 1),
    auto_scale_enabled: Boolean(raw.auto_scale_enabled),
    auto_downscaled: Boolean(raw.auto_downscaled),
    auto_downscale_message: raw.auto_downscale_message ?? null,
    preview_grid:
      Array.isArray(raw.preview_grid) && raw.preview_grid.length === 3
        ? [
            Number(raw.preview_grid[0]),
            Number(raw.preview_grid[1]),
            Number(raw.preview_grid[2]),
          ]
        : [0, 0, 0],
    fem_mesh: normalizeFemLiveMesh(raw.fem_mesh),
    original_node_count:
      raw.original_node_count != null ? Number(raw.original_node_count) : null,
    original_face_count:
      raw.original_face_count != null ? Number(raw.original_face_count) : null,
    active_mask: Array.isArray(raw.active_mask)
      ? raw.active_mask.map((v: unknown) => Boolean(v))
      : null,
  };
}

function normalizeScriptBuilder(raw: any): ScriptBuilderState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    revision: Number(raw.revision ?? 0),
    backend:
      typeof raw.backend === "string" && raw.backend.trim().length > 0
        ? raw.backend
        : null,
    demag_realization:
      typeof raw.demag_realization === "string" && raw.demag_realization.trim().length > 0
        ? raw.demag_realization
        : null,
    external_field: normalizeVec3(raw.external_field),
    solver: {
      integrator: String(raw.solver?.integrator ?? ""),
      fixed_timestep: String(raw.solver?.fixed_timestep ?? ""),
      relax_algorithm: String(raw.solver?.relax_algorithm ?? ""),
      torque_tolerance: String(raw.solver?.torque_tolerance ?? ""),
      energy_tolerance: String(raw.solver?.energy_tolerance ?? ""),
      max_relax_steps: String(raw.solver?.max_relax_steps ?? ""),
    },
    mesh: {
      algorithm_2d: Number(raw.mesh?.algorithm_2d ?? 6),
      algorithm_3d: Number(raw.mesh?.algorithm_3d ?? 1),
      size_mode: raw.mesh?.size_mode === "custom" ? "custom" : "predefined",
      hmax: String(raw.mesh?.hmax ?? ""),
      hmin: String(raw.mesh?.hmin ?? ""),
      maximum_element_size: String(raw.mesh?.maximum_element_size ?? raw.mesh?.hmax ?? ""),
      minimum_element_size: String(raw.mesh?.minimum_element_size ?? raw.mesh?.hmin ?? ""),
      calibrate_for: String(raw.mesh?.calibrate_for ?? ""),
      size_preset: String(raw.mesh?.size_preset ?? ""),
      size_factor: Number(raw.mesh?.size_factor ?? 1),
      size_from_curvature: Number(raw.mesh?.size_from_curvature ?? 0),
      curvature_factor: String(raw.mesh?.curvature_factor ?? ""),
      growth_rate: String(raw.mesh?.growth_rate ?? ""),
      maximum_element_growth_rate: String(
        raw.mesh?.maximum_element_growth_rate ?? raw.mesh?.growth_rate ?? "",
      ),
      narrow_regions: Number(raw.mesh?.narrow_regions ?? 0),
      narrow_region_resolution: String(raw.mesh?.narrow_region_resolution ?? ""),
      resolved_size_from_curvature:
        raw.mesh?.resolved_size_from_curvature != null
          ? Number(raw.mesh.resolved_size_from_curvature)
          : null,
      resolved_narrow_regions:
        raw.mesh?.resolved_narrow_regions != null
          ? Number(raw.mesh.resolved_narrow_regions)
          : null,
      resolved_growth_rate: String(raw.mesh?.resolved_growth_rate ?? ""),
      smoothing_steps: Number(raw.mesh?.smoothing_steps ?? 1),
      optimize: String(raw.mesh?.optimize ?? ""),
      optimize_iterations: Number(raw.mesh?.optimize_iterations ?? 1),
      compute_quality: Boolean(raw.mesh?.compute_quality),
      per_element_quality: Boolean(raw.mesh?.per_element_quality),
      interface_hmax: String(raw.mesh?.interface_hmax ?? ""),
      interface_thickness: String(raw.mesh?.interface_thickness ?? ""),
      transition_distance: String(raw.mesh?.transition_distance ?? ""),
      transition_growth: String(raw.mesh?.transition_growth ?? ""),
      adaptive_enabled: Boolean(raw.mesh?.adaptive_enabled),
      adaptive_policy: String(raw.mesh?.adaptive_policy ?? "auto"),
      adaptive_indicator: String(raw.mesh?.adaptive_indicator ?? "geometric_only"),
      adaptive_target_quantity: String(raw.mesh?.adaptive_target_quantity ?? "auto"),
      adaptive_convergence_metric: String(raw.mesh?.adaptive_convergence_metric ?? "energy_delta"),
      adaptive_theta: Number(raw.mesh?.adaptive_theta ?? 0.3),
      adaptive_h_min: String(raw.mesh?.adaptive_h_min ?? ""),
      adaptive_h_max: String(raw.mesh?.adaptive_h_max ?? ""),
      adaptive_max_passes: Number(raw.mesh?.adaptive_max_passes ?? 2),
      adaptive_error_tolerance: String(raw.mesh?.adaptive_error_tolerance ?? "1e-3"),
    },
    universe:
      raw.universe && typeof raw.universe === "object"
        ? {
            mode: String(raw.universe.mode ?? "auto"),
            size: normalizeVec3(raw.universe.size),
            center: normalizeVec3(raw.universe.center),
            padding: normalizeVec3(raw.universe.padding),
            airbox_hmax:
              raw.universe.airbox_hmax != null
                ? Number(raw.universe.airbox_hmax)
                : null,
            airbox_hmin:
              raw.universe.airbox_hmin != null
                ? Number(raw.universe.airbox_hmin)
                : null,
            airbox_growth_rate:
              raw.universe.airbox_growth_rate != null
                ? Number(raw.universe.airbox_growth_rate)
                : null,
            airbox_grading:
              raw.universe.airbox_grading != null
                ? String(raw.universe.airbox_grading)
                : null,
          }
        : null,
    domain_frame: normalizeDomainFrame(raw.domain_frame),
    stages: Array.isArray(raw.stages)
      ? raw.stages.map((stage: any) => ({
          kind: String(stage?.kind ?? "run"),
          entrypoint_kind: String(stage?.entrypoint_kind ?? ""),
          integrator: String(stage?.integrator ?? ""),
          fixed_timestep: String(stage?.fixed_timestep ?? ""),
          until_seconds: String(stage?.until_seconds ?? ""),
          relax_algorithm: String(stage?.relax_algorithm ?? ""),
          torque_tolerance: String(stage?.torque_tolerance ?? ""),
          energy_tolerance: String(stage?.energy_tolerance ?? ""),
          max_steps: String(stage?.max_steps ?? ""),
          eigen_count: String(stage?.eigen_count ?? ""),
          eigen_target: String(stage?.eigen_target ?? ""),
          eigen_include_demag: Boolean(stage?.eigen_include_demag ?? false),
          eigen_equilibrium_source: String(stage?.eigen_equilibrium_source ?? ""),
          eigen_normalization: String(stage?.eigen_normalization ?? ""),
          eigen_target_frequency: String(stage?.eigen_target_frequency ?? ""),
          eigen_damping_policy: String(stage?.eigen_damping_policy ?? ""),
          eigen_k_vector: String(stage?.eigen_k_vector ?? ""),
          eigen_spin_wave_bc: String(stage?.eigen_spin_wave_bc ?? ""),
          eigen_spin_wave_bc_config:
            stage?.eigen_spin_wave_bc_config && typeof stage.eigen_spin_wave_bc_config === "object"
              ? stage.eigen_spin_wave_bc_config
              : null,
        }))
      : [],
    study_pipeline:
      raw.study_pipeline && typeof raw.study_pipeline === "object"
        ? (raw.study_pipeline as ScriptBuilderState["study_pipeline"])
        : null,
    initial_state:
      raw.initial_state && typeof raw.initial_state === "object"
        ? {
            magnet_name:
              typeof raw.initial_state.magnet_name === "string"
                ? raw.initial_state.magnet_name
                : null,
            source_path: String(raw.initial_state.source_path ?? ""),
            format: String(raw.initial_state.format ?? "json"),
            dataset:
              typeof raw.initial_state.dataset === "string"
                ? raw.initial_state.dataset
                : null,
            sample_index:
              raw.initial_state.sample_index != null
                ? Number(raw.initial_state.sample_index)
                : null,
          }
        : null,
    geometries: Array.isArray(raw.geometries)
      ? raw.geometries.map((geo: any) => ({
          name: String(geo?.name ?? ""),
          region_name:
            typeof geo?.region_name === "string" && geo.region_name.trim().length > 0
              ? geo.region_name
              : null,
          geometry_kind: String(geo?.geometry_kind ?? ""),
          geometry_params: (geo?.geometry_params && typeof geo.geometry_params === "object") ? geo.geometry_params : {},
          bounds_min: normalizeVec3(geo?.bounds_min),
          bounds_max: normalizeVec3(geo?.bounds_max),
          material: {
            Ms: geo?.material?.Ms != null ? Number(geo.material.Ms) : null,
            Aex: geo?.material?.Aex != null ? Number(geo.material.Aex) : null,
            alpha: Number(geo?.material?.alpha ?? 0.01),
            Dind: geo?.material?.Dind != null ? Number(geo.material.Dind) : null,
          },
          physics_stack: ensureObjectPhysicsStack(
            geo?.physics_stack,
            geo?.material?.Dind != null ? Number(geo.material.Dind) : null,
          ),
          magnetization: {
            kind: String(geo?.magnetization?.kind ?? "uniform"),
            value: Array.isArray(geo?.magnetization?.value) ? geo.magnetization.value.map(Number) : null,
            seed: geo?.magnetization?.seed != null ? Number(geo.magnetization.seed) : null,
            source_path: typeof geo?.magnetization?.source_path === "string" ? geo.magnetization.source_path : null,
            source_format: typeof geo?.magnetization?.source_format === "string" ? geo.magnetization.source_format : null,
            dataset: typeof geo?.magnetization?.dataset === "string" ? geo.magnetization.dataset : null,
            sample_index: geo?.magnetization?.sample_index != null ? Number(geo.magnetization.sample_index) : null,
          },
          mesh: geo?.mesh && typeof geo.mesh === "object" ? {
            mode: geo.mesh.mode === "custom" ? "custom" : "inherit",
            size_mode: geo.mesh.size_mode === "custom" ? "custom" : "predefined",
            hmax: String(geo.mesh.hmax ?? ""),
            hmin: String(geo.mesh.hmin ?? ""),
            maximum_element_size: String(geo.mesh.maximum_element_size ?? geo.mesh.hmax ?? ""),
            minimum_element_size: String(geo.mesh.minimum_element_size ?? geo.mesh.hmin ?? ""),
            calibrate_for: typeof geo.mesh.calibrate_for === "string" ? geo.mesh.calibrate_for : null,
            size_preset: typeof geo.mesh.size_preset === "string" ? geo.mesh.size_preset : null,
            order: geo.mesh.order != null ? Number(geo.mesh.order) : null,
            source: typeof geo.mesh.source === "string" ? geo.mesh.source : null,
            algorithm_2d: geo.mesh.algorithm_2d != null ? Number(geo.mesh.algorithm_2d) : null,
            algorithm_3d: geo.mesh.algorithm_3d != null ? Number(geo.mesh.algorithm_3d) : null,
            size_factor: geo.mesh.size_factor != null ? Number(geo.mesh.size_factor) : null,
            size_from_curvature: geo.mesh.size_from_curvature != null ? Number(geo.mesh.size_from_curvature) : null,
            curvature_factor: String(geo.mesh.curvature_factor ?? ""),
            growth_rate: String(geo.mesh.growth_rate ?? ""),
            maximum_element_growth_rate: String(
              geo.mesh.maximum_element_growth_rate ?? geo.mesh.growth_rate ?? "",
            ),
            narrow_regions: geo.mesh.narrow_regions != null ? Number(geo.mesh.narrow_regions) : null,
            narrow_region_resolution: String(geo.mesh.narrow_region_resolution ?? ""),
            resolved_size_from_curvature:
              geo.mesh.resolved_size_from_curvature != null
                ? Number(geo.mesh.resolved_size_from_curvature)
                : null,
            resolved_narrow_regions:
              geo.mesh.resolved_narrow_regions != null
                ? Number(geo.mesh.resolved_narrow_regions)
                : null,
            resolved_growth_rate: String(geo.mesh.resolved_growth_rate ?? ""),
            smoothing_steps: geo.mesh.smoothing_steps != null ? Number(geo.mesh.smoothing_steps) : null,
            optimize: typeof geo.mesh.optimize === "string" ? geo.mesh.optimize : null,
            optimize_iterations: geo.mesh.optimize_iterations != null ? Number(geo.mesh.optimize_iterations) : null,
            compute_quality: typeof geo.mesh.compute_quality === "boolean" ? geo.mesh.compute_quality : null,
            per_element_quality: typeof geo.mesh.per_element_quality === "boolean" ? geo.mesh.per_element_quality : null,
            bulk_hmax: typeof geo.mesh.bulk_hmax === "string" ? geo.mesh.bulk_hmax : null,
            bulk_hmin: typeof geo.mesh.bulk_hmin === "string" ? geo.mesh.bulk_hmin : null,
            interface_hmax: typeof geo.mesh.interface_hmax === "string" ? geo.mesh.interface_hmax : null,
            interface_thickness: typeof geo.mesh.interface_thickness === "string" ? geo.mesh.interface_thickness : null,
            transition_distance: typeof geo.mesh.transition_distance === "string" ? geo.mesh.transition_distance : null,
            transition_growth: geo.mesh.transition_growth != null ? Number(geo.mesh.transition_growth) : null,
            boundary_layer_count: geo.mesh.boundary_layer_count != null ? Number(geo.mesh.boundary_layer_count) : null,
            boundary_layer_thickness: typeof geo.mesh.boundary_layer_thickness === "string" ? geo.mesh.boundary_layer_thickness : null,
            boundary_layer_stretching: geo.mesh.boundary_layer_stretching != null ? Number(geo.mesh.boundary_layer_stretching) : null,
            size_fields: Array.isArray(geo.mesh.size_fields)
              ? geo.mesh.size_fields.map((field: any) => ({
                  kind: String(field?.kind ?? ""),
                  params:
                    field?.params && typeof field.params === "object"
                      ? field.params
                      : {},
                }))
              : [],
            operations: Array.isArray(geo.mesh.operations)
              ? geo.mesh.operations.map((operation: any) => ({
                  kind: String(operation?.kind ?? ""),
                  params:
                    operation?.params && typeof operation.params === "object"
                      ? operation.params
                      : {},
                }))
              : [],
            build_requested: Boolean(geo.mesh.build_requested),
          } : null,
        }))
      : [],
    current_modules: Array.isArray(raw.current_modules)
      ? raw.current_modules.map((module: any) => ({
          kind: String(module?.kind ?? "antenna_field_source"),
          name: String(module?.name ?? ""),
          solver: String(module?.solver ?? "mqs_2p5d_az"),
          air_box_factor: Number(module?.air_box_factor ?? 12),
          antenna_kind: String(module?.antenna_kind ?? ""),
          antenna_params:
            module?.antenna_params && typeof module.antenna_params === "object"
              ? module.antenna_params
              : {},
          drive: {
            current_a: Number(module?.drive?.current_a ?? 0),
            frequency_hz:
              module?.drive?.frequency_hz != null
                ? Number(module.drive.frequency_hz)
                : null,
            phase_rad: Number(module?.drive?.phase_rad ?? 0),
            waveform:
              module?.drive?.waveform && typeof module.drive.waveform === "object"
                ? module.drive.waveform
                : null,
          },
        }))
      : [],
    excitation_analysis:
      raw.excitation_analysis && typeof raw.excitation_analysis === "object"
        ? {
            source: String(raw.excitation_analysis.source ?? ""),
            method: String(raw.excitation_analysis.method ?? ""),
            propagation_axis:
              normalizeVec3(raw.excitation_analysis.propagation_axis) ?? [1, 0, 0],
            k_max_rad_per_m:
              raw.excitation_analysis.k_max_rad_per_m != null
                ? Number(raw.excitation_analysis.k_max_rad_per_m)
                : null,
            samples: Number(raw.excitation_analysis.samples ?? 256),
          }
        : null,
  };
}

function normalizeModelBuilderGraph(raw: any): ModelBuilderGraphV2 | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const projectedBuilder = normalizeScriptBuilder({
    revision: raw.revision,
    backend: raw.study?.backend,
    demag_realization: raw.study?.demag_realization,
    external_field: raw.study?.external_field ?? null,
    solver: raw.study?.solver,
    mesh: raw.study?.shared_domain_mesh ?? raw.study?.mesh_defaults,
    universe: raw.universe?.value,
    stages: raw.study?.stages,
    study_pipeline: raw.study?.study_pipeline ?? null,
    initial_state: raw.study?.initial_state,
    geometries: Array.isArray(raw.objects?.items)
      ? raw.objects.items
          .map((item: any) => {
            if (!item?.geometry) {
              return null;
            }
            return {
              ...item.geometry,
              mesh: item.object_mesh ?? item.geometry.mesh ?? null,
            };
          })
          .filter(Boolean)
      : [],
    current_modules: raw.current_modules?.modules,
    excitation_analysis: raw.current_modules?.excitation_analysis,
  });
  if (!projectedBuilder) {
    return null;
  }
  const graph = createModelBuilderGraphV2(projectedBuilder);
  graph.study.requested_backend =
    typeof raw.study?.requested_backend === "string" ? raw.study.requested_backend : "auto";
  graph.study.requested_device =
    typeof raw.study?.requested_device === "string" ? raw.study.requested_device : "auto";
  graph.study.requested_precision =
    typeof raw.study?.requested_precision === "string"
      ? raw.study.requested_precision
      : "double";
  graph.study.requested_mode =
    typeof raw.study?.requested_mode === "string" ? raw.study.requested_mode : "strict";
  graph.study.external_field =
    Array.isArray(raw.study?.external_field) && raw.study.external_field.length === 3
      ? ([
          Number(raw.study.external_field[0] ?? 0),
          Number(raw.study.external_field[1] ?? 0),
          Number(raw.study.external_field[2] ?? 0),
        ] as [number, number, number])
      : null;
  return graph;
}

function emptyScriptBuilderState(): ScriptBuilderState {
  return normalizeScriptBuilder({
    revision: 0,
    backend: null,
    demag_realization: null,
    external_field: null,
    solver: {},
    mesh: {},
    universe: null,
    stages: [],
    study_pipeline: null,
    initial_state: null,
    geometries: [],
    current_modules: [],
    excitation_analysis: null,
  })!;
}

function normalizeQuat4(raw: unknown): [number, number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 4) {
    return [0, 0, 0, 1];
  }
  return [
    Number(raw[0] ?? 0),
    Number(raw[1] ?? 0),
    Number(raw[2] ?? 0),
    Number(raw[3] ?? 1),
  ];
}

function normalizeSceneMeshOverride(raw: any) {
  return normalizeScriptBuilder({
    revision: 0,
    backend: null,
    solver: {},
    mesh: {},
    universe: null,
    stages: [],
    study_pipeline: null,
    initial_state: null,
    geometries: [
      {
        name: "tmp",
        geometry_kind: "Box",
        geometry_params: {},
        material: {},
        magnetization: {},
        mesh: raw ?? null,
      },
    ],
    current_modules: [],
    excitation_analysis: null,
  })?.geometries[0]?.mesh ?? null;
}

function normalizeSceneCurrentModules(raw: any) {
  const normalized = normalizeScriptBuilder({
    revision: 0,
    backend: null,
    solver: {},
    mesh: {},
    universe: null,
    stages: [],
    study_pipeline: null,
    initial_state: null,
    geometries: [],
    current_modules: Array.isArray(raw?.modules) ? raw.modules : [],
    excitation_analysis: raw?.excitation_analysis ?? null,
  });
  return {
    modules: normalized?.current_modules ?? [],
    excitation_analysis: normalized?.excitation_analysis ?? null,
  };
}

function normalizeSceneStudy(raw: any) {
  const defaults = emptyScriptBuilderState();
  const normalized = normalizeScriptBuilder({
    revision: 0,
    backend: raw?.backend ?? null,
    demag_realization: raw?.demag_realization ?? null,
    external_field: raw?.external_field ?? null,
    solver: raw?.solver ?? {},
    mesh: raw?.shared_domain_mesh ?? raw?.mesh_defaults ?? {},
    universe: null,
    stages: Array.isArray(raw?.stages) ? raw.stages : [],
    study_pipeline: raw?.study_pipeline ?? null,
    initial_state: raw?.initial_state ?? null,
    geometries: [],
    current_modules: [],
    excitation_analysis: null,
  });
  return {
    backend: normalized?.backend ?? null,
    requested_backend:
      typeof raw?.requested_backend === "string" ? raw.requested_backend : "auto",
    requested_device:
      typeof raw?.requested_device === "string" ? raw.requested_device : "auto",
    requested_precision:
      typeof raw?.requested_precision === "string" ? raw.requested_precision : "double",
    requested_mode:
      typeof raw?.requested_mode === "string" ? raw.requested_mode : "strict",
    demag_realization: normalized?.demag_realization ?? null,
    external_field: normalized?.external_field ?? null,
    solver: normalized?.solver ?? defaults.solver,
    universe_mesh:
      raw?.universe_mesh && typeof raw.universe_mesh === "object"
        ? {
            mode: String(raw.universe_mesh.mode ?? "auto"),
            size: normalizeVec3(raw.universe_mesh.size),
            center: normalizeVec3(raw.universe_mesh.center),
            padding: normalizeVec3(raw.universe_mesh.padding),
            airbox_hmax:
              raw.universe_mesh.airbox_hmax != null
                ? Number(raw.universe_mesh.airbox_hmax)
                : null,
            airbox_hmin:
              raw.universe_mesh.airbox_hmin != null
                ? Number(raw.universe_mesh.airbox_hmin)
                : null,
            airbox_growth_rate:
              raw.universe_mesh.airbox_growth_rate != null
                ? Number(raw.universe_mesh.airbox_growth_rate)
                : null,
            airbox_grading:
              raw.universe_mesh.airbox_grading != null
                ? String(raw.universe_mesh.airbox_grading)
                : null,
          }
        : null,
    shared_domain_mesh: normalized?.mesh ?? defaults.mesh,
    mesh_defaults: normalized?.mesh ?? defaults.mesh,
    stages: normalized?.stages ?? [],
    study_pipeline: normalized?.study_pipeline ?? null,
    initial_state: normalized?.initial_state ?? null,
  };
}

function normalizeSceneDocument(raw: any): SceneDocument | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    version: "scene.v1",
    revision: Number(raw.revision ?? 0),
    scene:
      raw.scene && typeof raw.scene === "object"
        ? {
            id: String(raw.scene.id ?? ""),
            name: String(raw.scene.name ?? "Scene"),
            source_of_truth: "repo_head",
            authoring_schema: String(raw.scene.authoring_schema ?? "mesh-first-fem.v1"),
          }
        : {
            id: "",
            name: "Scene",
            source_of_truth: "repo_head",
            authoring_schema: "mesh-first-fem.v1",
          },
    universe:
      raw.universe && typeof raw.universe === "object"
        ? {
            mode: String(raw.universe.mode ?? "auto"),
            size: normalizeVec3(raw.universe.size),
            center: normalizeVec3(raw.universe.center),
            padding: normalizeVec3(raw.universe.padding),
            airbox_hmax:
              raw.universe.airbox_hmax != null
                ? Number(raw.universe.airbox_hmax)
                : null,
            airbox_hmin:
              raw.universe.airbox_hmin != null
                ? Number(raw.universe.airbox_hmin)
                : null,
            airbox_growth_rate:
              raw.universe.airbox_growth_rate != null
                ? Number(raw.universe.airbox_growth_rate)
                : null,
            airbox_grading:
              raw.universe.airbox_grading != null
                ? String(raw.universe.airbox_grading)
                : null,
          }
        : null,
    objects: Array.isArray(raw.objects)
      ? raw.objects.map((object: any) => ({
          id: String(object?.id ?? ""),
          name: String(object?.name ?? object?.id ?? ""),
          geometry: {
            geometry_kind: String(object?.geometry?.geometry_kind ?? ""),
            geometry_params:
              object?.geometry?.geometry_params &&
              typeof object.geometry.geometry_params === "object"
                ? object.geometry.geometry_params
                : {},
            bounds_min: normalizeVec3(object?.geometry?.bounds_min),
            bounds_max: normalizeVec3(object?.geometry?.bounds_max),
          },
          transform: {
            translation: normalizeVec3(object?.transform?.translation) ?? [0, 0, 0],
            rotation_quat: normalizeQuat4(object?.transform?.rotation_quat),
            scale: normalizeVec3(object?.transform?.scale) ?? [1, 1, 1],
            pivot: normalizeVec3(object?.transform?.pivot) ?? [0, 0, 0],
          },
          material_ref: String(object?.material_ref ?? ""),
          region_name:
            typeof object?.region_name === "string" ? object.region_name : null,
          magnetization_ref:
            typeof object?.magnetization_ref === "string"
              ? object.magnetization_ref
              : null,
          physics_stack: ensureObjectPhysicsStack(object?.physics_stack),
          object_mesh: normalizeSceneMeshOverride(
            object?.object_mesh ?? object?.mesh_override ?? null,
          ),
          mesh_override: normalizeSceneMeshOverride(object?.mesh_override ?? null),
          visible: Boolean(object?.visible ?? true),
          locked: Boolean(object?.locked),
          tags: Array.isArray(object?.tags)
            ? object.tags.filter((tag: unknown): tag is string => typeof tag === "string")
            : [],
        }))
      : [],
    materials: Array.isArray(raw.materials)
      ? raw.materials.map((material: any) => ({
          id: String(material?.id ?? ""),
          name: String(material?.name ?? ""),
          properties: {
            Ms: material?.properties?.Ms != null ? Number(material.properties.Ms) : null,
            Aex:
              material?.properties?.Aex != null ? Number(material.properties.Aex) : null,
            alpha: Number(material?.properties?.alpha ?? 0.01),
            Dind:
              material?.properties?.Dind != null ? Number(material.properties.Dind) : null,
          },
        }))
      : [],
    magnetization_assets: Array.isArray(raw.magnetization_assets)
      ? raw.magnetization_assets.map((asset: any) => ({
          id: String(asset?.id ?? ""),
          name: String(asset?.name ?? ""),
          kind: String(asset?.kind ?? "uniform"),
          value: Array.isArray(asset?.value) ? asset.value.map(Number) : null,
          seed: asset?.seed != null ? Number(asset.seed) : null,
          source_path: typeof asset?.source_path === "string" ? asset.source_path : null,
          source_format:
            typeof asset?.source_format === "string" ? asset.source_format : null,
          dataset: typeof asset?.dataset === "string" ? asset.dataset : null,
          sample_index: asset?.sample_index != null ? Number(asset.sample_index) : null,
          mapping: {
            space: String(asset?.mapping?.space ?? "object"),
            projection: String(asset?.mapping?.projection ?? "object_local"),
            clamp_mode: String(asset?.mapping?.clamp_mode ?? "none"),
          },
          texture_transform: {
            translation: normalizeVec3(asset?.texture_transform?.translation) ?? [0, 0, 0],
            rotation_quat: normalizeQuat4(asset?.texture_transform?.rotation_quat),
            scale: normalizeVec3(asset?.texture_transform?.scale) ?? [1, 1, 1],
            pivot: normalizeVec3(asset?.texture_transform?.pivot) ?? [0, 0, 0],
          },
          preset_kind:
            typeof asset?.preset_kind === "string" ? asset.preset_kind : null,
          preset_params:
            asset?.preset_params != null &&
            typeof asset.preset_params === "object" &&
            !Array.isArray(asset.preset_params)
              ? (asset.preset_params as Record<string, unknown>)
              : null,
          preset_version:
            asset?.preset_version != null ? Number(asset.preset_version) : null,
          ui_label:
            typeof asset?.ui_label === "string" ? asset.ui_label : null,
        }))
      : [],
    current_modules: normalizeSceneCurrentModules(raw.current_modules),
    study: normalizeSceneStudy(raw.study),
    outputs: {
      items: Array.isArray(raw.outputs?.items)
        ? raw.outputs.items.filter(
            (item: unknown): item is Record<string, unknown> =>
              item != null && typeof item === "object" && !Array.isArray(item),
          )
        : [],
    },
    editor: {
      selected_object_id:
        typeof raw.editor?.selected_object_id === "string"
          ? raw.editor.selected_object_id
          : null,
      gizmo_mode:
        typeof raw.editor?.gizmo_mode === "string" ? raw.editor.gizmo_mode : null,
      transform_space:
        typeof raw.editor?.transform_space === "string"
          ? raw.editor.transform_space
          : null,
      selected_entity_id:
        typeof raw.editor?.selected_entity_id === "string"
          ? raw.editor.selected_entity_id
          : null,
      focused_entity_id:
        typeof raw.editor?.focused_entity_id === "string"
          ? raw.editor.focused_entity_id
          : null,
      object_view_mode:
        raw.editor?.object_view_mode === "context" ||
        raw.editor?.object_view_mode === "isolate"
          ? raw.editor.object_view_mode
          : null,
      vector_domain_filter: normalizeFemVectorDomainFilter(raw.editor?.vector_domain_filter),
      ferromagnet_visibility_mode: normalizeFemFerromagnetVisibilityMode(
        raw.editor?.ferromagnet_visibility_mode,
      ),
      air_mesh_visible:
        typeof raw.editor?.air_mesh_visible === "boolean"
          ? raw.editor.air_mesh_visible
          : null,
      air_mesh_opacity:
        raw.editor?.air_mesh_opacity != null
          ? Number(raw.editor.air_mesh_opacity)
          : null,
      mesh_entity_view_state: normalizeSceneEditorMeshEntityViewState(
        raw.editor?.mesh_entity_view_state,
      ),
      visualization_presets: normalizeVisualizationPresets(
        raw.editor?.visualization_presets,
      ),
      active_visualization_preset_ref: normalizeVisualizationPresetRef(
        raw.editor?.active_visualization_preset_ref,
      ),
      active_transform_scope:
        raw.editor?.active_transform_scope === "object" ||
        raw.editor?.active_transform_scope === "texture"
          ? raw.editor.active_transform_scope
          : null,
    },
  };
}

function normalizeVec3(raw: unknown): [number, number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) {
    return null;
  }
  return [Number(raw[0] ?? 0), Number(raw[1] ?? 0), Number(raw[2] ?? 0)];
}

function normalizeDomainFrame(raw: any) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    declared_universe:
      raw.declared_universe && typeof raw.declared_universe === "object"
        ? {
            mode: String(raw.declared_universe.mode ?? "auto"),
            size: normalizeVec3(raw.declared_universe.size),
            center: normalizeVec3(raw.declared_universe.center),
            padding: normalizeVec3(raw.declared_universe.padding),
            airbox_hmax:
              raw.declared_universe.airbox_hmax != null
                ? Number(raw.declared_universe.airbox_hmax)
                : null,
            airbox_hmin:
              raw.declared_universe.airbox_hmin != null
                ? Number(raw.declared_universe.airbox_hmin)
                : null,
            airbox_growth_rate:
              raw.declared_universe.airbox_growth_rate != null
                ? Number(raw.declared_universe.airbox_growth_rate)
                : null,
            airbox_grading:
              raw.declared_universe.airbox_grading != null
                ? String(raw.declared_universe.airbox_grading)
                : null,
          }
        : null,
    object_bounds_min: normalizeVec3(raw.object_bounds_min),
    object_bounds_max: normalizeVec3(raw.object_bounds_max),
    mesh_bounds_min: normalizeVec3(raw.mesh_bounds_min),
    mesh_bounds_max: normalizeVec3(raw.mesh_bounds_max),
    effective_extent: normalizeVec3(raw.effective_extent),
    effective_center: normalizeVec3(raw.effective_center),
    effective_source:
      typeof raw.effective_source === "string" ? raw.effective_source : null,
  };
}

function normalizeMeshWorkspace(raw: any): MeshWorkspaceState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const meshSummaryRaw = raw.mesh_summary;
  const qualityRaw = raw.mesh_quality_summary;
  return {
    mesh_summary:
      meshSummaryRaw && typeof meshSummaryRaw === "object"
        ? {
            mesh_id:
              typeof meshSummaryRaw.mesh_id === "string"
                ? meshSummaryRaw.mesh_id
                : null,
            mesh_name: String(meshSummaryRaw.mesh_name ?? ""),
            mesh_source:
              typeof meshSummaryRaw.mesh_source === "string"
                ? meshSummaryRaw.mesh_source
                : null,
            backend: String(meshSummaryRaw.backend ?? ""),
            source_kind: String(meshSummaryRaw.source_kind ?? ""),
            order: Number(meshSummaryRaw.order ?? 1),
            hmax: Number(meshSummaryRaw.hmax ?? 0),
            node_count: Number(meshSummaryRaw.node_count ?? 0),
            element_count: Number(meshSummaryRaw.element_count ?? 0),
            boundary_face_count: Number(meshSummaryRaw.boundary_face_count ?? 0),
            bounds_min: normalizeVec3(meshSummaryRaw.bounds_min),
            bounds_max: normalizeVec3(meshSummaryRaw.bounds_max),
            mesh_extent:
              normalizeVec3(meshSummaryRaw.mesh_extent)
              ?? normalizeVec3(meshSummaryRaw.world_extent),
            world_extent: normalizeVec3(meshSummaryRaw.world_extent),
            world_center: normalizeVec3(meshSummaryRaw.world_center),
            world_extent_source:
              typeof meshSummaryRaw.world_extent_source === "string"
                ? meshSummaryRaw.world_extent_source
                : null,
            domain_frame: normalizeDomainFrame(meshSummaryRaw.domain_frame),
            domain_mesh_mode:
              typeof meshSummaryRaw.domain_mesh_mode === "string"
                ? meshSummaryRaw.domain_mesh_mode
                : null,
            generation_id: String(meshSummaryRaw.generation_id ?? ""),
          }
        : null,
    mesh_quality_summary:
      qualityRaw && typeof qualityRaw === "object"
        ? {
            n_elements: Number(qualityRaw.n_elements ?? 0),
            sicn_min: Number(qualityRaw.sicn_min ?? 0),
            sicn_max: Number(qualityRaw.sicn_max ?? 0),
            sicn_mean: Number(qualityRaw.sicn_mean ?? 0),
            sicn_p5: Number(qualityRaw.sicn_p5 ?? 0),
            gamma_min: Number(qualityRaw.gamma_min ?? 0),
            gamma_mean: Number(qualityRaw.gamma_mean ?? 0),
            avg_quality: Number(qualityRaw.avg_quality ?? 0),
          }
        : null,
    mesh_pipeline_status: Array.isArray(raw.mesh_pipeline_status)
      ? raw.mesh_pipeline_status.map((phase: any) => ({
          id: String(phase?.id ?? ""),
          label: String(phase?.label ?? ""),
          status:
            phase?.status === "active" ||
            phase?.status === "done" ||
            phase?.status === "warning" ||
            phase?.status === "queued" ||
            phase?.status === "failed"
              ? phase.status
              : "idle",
          detail: typeof phase?.detail === "string" ? phase.detail : null,
        }))
      : [],
    mesh_capabilities:
      raw.mesh_capabilities && typeof raw.mesh_capabilities === "object"
        ? {
            has_volume_mesh: Boolean(raw.mesh_capabilities.has_volume_mesh),
            has_quality_arrays: Boolean(raw.mesh_capabilities.has_quality_arrays),
            supports_adaptive_remesh: Boolean(raw.mesh_capabilities.supports_adaptive_remesh),
            supports_compare_snapshots: Boolean(raw.mesh_capabilities.supports_compare_snapshots),
            supports_size_field_remesh: Boolean(raw.mesh_capabilities.supports_size_field_remesh),
            supports_mesh_error_preview: Boolean(raw.mesh_capabilities.supports_mesh_error_preview),
            supports_target_h_preview: Boolean(raw.mesh_capabilities.supports_target_h_preview),
          }
        : null,
    mesh_adaptivity_state:
      raw.mesh_adaptivity_state && typeof raw.mesh_adaptivity_state === "object"
        ? {
            enabled: Boolean(raw.mesh_adaptivity_state.enabled),
            policy: String(raw.mesh_adaptivity_state.policy ?? "manual"),
            pass_count: Number(raw.mesh_adaptivity_state.pass_count ?? 0),
            max_passes: Number(raw.mesh_adaptivity_state.max_passes ?? 0),
            convergence_status: String(raw.mesh_adaptivity_state.convergence_status ?? "idle"),
            last_target_h_summary:
              raw.mesh_adaptivity_state.last_target_h_summary &&
              typeof raw.mesh_adaptivity_state.last_target_h_summary === "object"
                ? raw.mesh_adaptivity_state.last_target_h_summary
                : null,
          }
        : null,
    mesh_history: Array.isArray(raw.mesh_history)
      ? raw.mesh_history.map((entry: any) => ({
          mesh_name: String(entry?.mesh_name ?? ""),
          generation_mode:
            typeof entry?.generation_mode === "string" ? entry.generation_mode : null,
          node_count: Number(entry?.node_count ?? 0),
          element_count: Number(entry?.element_count ?? 0),
          boundary_face_count: Number(entry?.boundary_face_count ?? 0),
          kind: typeof entry?.kind === "string" ? entry.kind : undefined,
          quality:
            entry?.quality && typeof entry.quality === "object" ? entry.quality : null,
          mesh_provenance:
            entry?.mesh_provenance && typeof entry.mesh_provenance === "object"
              ? entry.mesh_provenance
              : null,
          size_field_stats:
            entry?.size_field_stats && typeof entry.size_field_stats === "object"
              ? entry.size_field_stats
              : null,
        }))
      : [],
    effective_airbox_target:
      raw.effective_airbox_target && typeof raw.effective_airbox_target === "object"
        ? {
            hmax:
              raw.effective_airbox_target.hmax != null
                ? Number(raw.effective_airbox_target.hmax)
                : null,
            hmin:
              raw.effective_airbox_target.hmin != null
                ? Number(raw.effective_airbox_target.hmin)
                : null,
            growth_rate:
              raw.effective_airbox_target.growth_rate != null
                ? Number(raw.effective_airbox_target.growth_rate)
                : null,
          }
        : null,
    active_build: normalizeMeshBuildIntent(raw.active_build),
    effective_per_object_targets:
      raw.effective_per_object_targets && typeof raw.effective_per_object_targets === "object"
        ? Object.fromEntries(
            Object.entries(raw.effective_per_object_targets).map(([geometryName, entry]) => {
              const target = entry && typeof entry === "object"
                ? entry as Record<string, unknown>
                : {};
              return [
                geometryName,
                {
                  marker:
                    target.marker != null ? Number(target.marker) : null,
                  hmax:
                    target.hmax != null ? Number(target.hmax) : null,
                  interface_hmax:
                    target.interface_hmax != null ? Number(target.interface_hmax) : null,
                  transition_distance:
                    target.transition_distance != null ? Number(target.transition_distance) : null,
                  source:
                    typeof target.source === "string" ? target.source : null,
                },
              ];
            }),
          )
        : null,
    last_build_summary:
      raw.last_build_summary && typeof raw.last_build_summary === "object"
        ? raw.last_build_summary
        : null,
    last_build_error:
      typeof raw.last_build_error === "string" ? raw.last_build_error : null,
  };
}

function normalizeStageExecutionState(raw: any) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  return {
    total_stages: Number(raw.total_stages ?? 0),
    completed_stage_indexes: Array.isArray(raw.completed_stage_indexes)
      ? raw.completed_stage_indexes
          .map((value: unknown) => Number(value ?? -1))
          .filter((value: number) => Number.isFinite(value) && value >= 0)
      : [],
    active_stage_index:
      typeof raw.active_stage_index === "number" && Number.isFinite(raw.active_stage_index)
        ? Math.max(0, Math.trunc(raw.active_stage_index))
        : null,
    active_stage_kind:
      typeof raw.active_stage_kind === "string" ? raw.active_stage_kind : null,
    runtime_state:
      typeof raw.runtime_state === "string" ? raw.runtime_state : "idle",
  };
}

function normalizeMeshBuildIntent(raw: unknown): import("./types").MeshBuildIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mode = r.mode;
  const target = r.target;
  if (!target || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  const kind = t.kind;
  if (mode === "all" && kind === "study_domain") {
    return { mode: "all", target: { kind: "study_domain" } };
  }
  if (mode === "selected") {
    if (kind === "study_domain") return { mode: "selected", target: { kind: "study_domain" } };
    if (kind === "airbox") return { mode: "selected", target: { kind: "airbox" } };
    if (kind === "object_mesh" && typeof t.object_id === "string") {
      return { mode: "selected", target: { kind: "object_mesh", object_id: t.object_id } };
    }
  }
  return null;
}

/* ── Top-level normalizer ── */

export function normalizeSessionState(
  raw: any,
  pendingVectorPayloads?: Map<number, Float64Array>,
): SessionState {
  const rawLive = raw.live_state;
  const latestFields = normalizeLatestFields(raw.latest_fields);

  // Merge step_update_v2 frames into latest_fields so transport metadata stays
  // attached to the values all the way into the frontend store.
  const rawStepV2 = raw.step_update_v2;
  if (rawStepV2 && Array.isArray(rawStepV2.frames)) {
    for (const frame of rawStepV2.frames) {
      if (
        frame &&
        typeof frame.quantity_id === "string" &&
        Array.isArray(frame.values) &&
        frame.values.length > 0
      ) {
        latestFields.frames[frame.quantity_id] = {
          quantity_id: frame.quantity_id,
          unit: typeof frame.unit === "string" ? frame.unit : "",
          n_comp:
            typeof frame.n_comp === "number" && Number.isFinite(frame.n_comp)
              ? Math.max(1, Math.trunc(frame.n_comp))
              : 1,
          grid: Array.isArray(frame.grid) && frame.grid.length === 3
            ? [Number(frame.grid[0]), Number(frame.grid[1]), Number(frame.grid[2])]
            : latestFields.grid ?? [1, 1, 1],
          values: new Float64Array(frame.values),
          active_mask: normalizeActiveMask(frame.active_mask),
          location: null,
          domain: null,
        };
        if (!latestFields.grid) {
          latestFields.grid = latestFields.frames[frame.quantity_id].grid;
        }
      }
    }
  }

  // ── Merge step_update_v2.scalars into scalar_rows for live chart population.
  // The backend emits `step_update_v2` on every live step update;
  // `scalars` contains the scalar row whenever `scalar_row_due` is true in the
  // Rust runner. Without this merge the chart stays empty during a live run
  // because no full `raw.scalar_rows` snapshot arrives until the session is over.
  const rawScalarsFromStep = rawStepV2?.scalars;
  // solver_dt lives in diagnostics, not in GlobalQuantityRow — pull it so ScalarRow
  // has a non-zero dt even when the row arrived via the V2 channel.
  const rawV2Dt: number | undefined =
    typeof rawStepV2?.diagnostics?.dt === "number" ? rawStepV2.diagnostics.dt : undefined;
  let rawScalarRowsForMerge: any[] = Array.isArray(raw.scalar_rows) ? raw.scalar_rows : [];
  if (
    rawScalarsFromStep &&
    typeof rawScalarsFromStep.step === "number" &&
    Number.isFinite(rawScalarsFromStep.step)
  ) {
    // Deduplicate: skip if the same step is already in the snapshot batch.
    // Note: this only deduplicates against rows in the CURRENT delta batch; the
    // stale-tip guard in mergeSessionState handles the case where the V2 step
    // equals the previously-accumulated tip step in prev.scalar_rows.
    const alreadyPresent = rawScalarRowsForMerge.some(
      (r: any) => Number(r?.step) === rawScalarsFromStep.step,
    );
    if (!alreadyPresent) {
      // Carry solver_dt from diagnostics (not present on GlobalQuantityRow itself).
      const v2RowWithDt = rawV2Dt != null
        ? { ...rawScalarsFromStep, solver_dt: rawV2Dt }
        : rawScalarsFromStep;
      rawScalarRowsForMerge = [...rawScalarRowsForMerge, v2RowWithDt];
    }
  }

  if (process.env.NODE_ENV !== "production") {
    console.debug(
      `[normalize] scalar_rows=${rawScalarRowsForMerge.length}` +
      ` raw_delta=${Array.isArray(raw.scalar_rows) ? (raw.scalar_rows as any[]).length : "?"}` +
      ` v2_step=${rawScalarsFromStep?.step ?? "-"}` +
      ` scalar_rows_total=${raw.scalar_rows_total ?? "?"}`,
    );
  }

  const rawPreview = raw.preview ?? null;
  const rawPreviewConfig = raw.preview_config ?? null;
  const displaySelection = normalizeDisplaySelection(raw.display_selection);
  const fallbackGrid = latestFields.grid;
  const sceneDocument =
    normalizeSceneDocument(raw.scene_document) ??
    (() => {
      const builder = normalizeScriptBuilder(raw.script_builder);
      return builder ? buildSceneDocumentFromScriptBuilder(builder) : null;
    })();
  const scriptBuilder = sceneDocument
    ? buildScriptBuilderFromSceneDocument(sceneDocument)
    : normalizeScriptBuilder(raw.script_builder);
  const modelBuilderGraph =
    (sceneDocument ? createModelBuilderGraphV2(scriptBuilder ?? undefined) : null) ??
    normalizeModelBuilderGraph(raw.model_builder_graph) ??
    (scriptBuilder ? createModelBuilderGraphV2(scriptBuilder) : null);

  const liveState: LiveState | null = rawLive
    ? {
        status: rawLive.status,
        updated_at_unix_ms: rawLive.updated_at_unix_ms,
        step: rawLive.latest_step?.step ?? 0,
        time: rawLive.latest_step?.time ?? 0,
        dt: rawLive.latest_step?.dt ?? 0,
        e_ex: rawLive.latest_step?.e_ex ?? 0,
        e_demag: rawLive.latest_step?.e_demag ?? 0,
        e_ext: rawLive.latest_step?.e_ext ?? 0,
        e_ani: rawLive.latest_step?.e_ani ?? 0,
        e_dmi: rawLive.latest_step?.e_dmi ?? 0,
        e_total: rawLive.latest_step?.e_total ?? 0,
        max_dm_dt: rawLive.latest_step?.max_dm_dt ?? 0,
        max_h_eff: rawLive.latest_step?.max_h_eff ?? 0,
        max_h_demag: rawLive.latest_step?.max_h_demag ?? 0,
        max_torque_Apm:
          typeof rawLive.latest_step?.max_torque_Apm === "number"
            ? Number(rawLive.latest_step.max_torque_Apm)
            : undefined,
        max_torque_T:
          typeof rawLive.latest_step?.max_torque_T === "number"
            ? Number(rawLive.latest_step.max_torque_T)
            : undefined,
        wall_time_ns: rawLive.latest_step?.wall_time_ns ?? 0,
        grid: rawLive.latest_step?.grid ?? fallbackGrid ?? [0, 0, 0],
        preview_grid: rawLive.latest_step?.preview_grid ?? null,
        preview_data_points_count: rawLive.latest_step?.preview_data_points_count ?? null,
        preview_max_points: rawLive.latest_step?.preview_max_points ?? null,
        preview_auto_downscaled: Boolean(rawLive.latest_step?.preview_auto_downscaled),
        preview_auto_downscale_message: rawLive.latest_step?.preview_auto_downscale_message ?? null,
        fem_mesh: normalizeFemLiveMesh(rawLive.latest_step?.fem_mesh),
        magnetization: toFloat64Array(rawLive.latest_step?.magnetization),
        finished: Boolean(rawLive.latest_step?.finished),
      }
    : null;

  return {
    state_version:
      typeof raw.state_version === "number" ? raw.state_version : undefined,
    session_protocol_version:
      typeof raw.session_protocol_version === "string" ? raw.session_protocol_version : undefined,
    capability_profile_version:
      typeof raw.capability_profile_version === "string"
        ? raw.capability_profile_version
        : undefined,
    session: normalizeSessionManifest(raw.session),
    run: raw.run ?? null,
    live_state: liveState,
    runtime_status: normalizeRuntimeStatus(raw.runtime_status),
    capabilities:
      raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : null,
    metadata: raw.metadata ?? null,
    mesh_workspace: normalizeMeshWorkspace(raw.mesh_workspace),
    stage_execution: normalizeStageExecutionState(raw.stage_execution),
    scene_document: sceneDocument,
    script_builder: scriptBuilder,
    model_builder_graph: modelBuilderGraph,
    scalar_rows: rawScalarRowsForMerge.map((row: any) => ({
          step: Number(row?.step ?? 0),
          time: Number(row?.time ?? 0),
          solver_dt: Number(row?.solver_dt ?? row?.dt ?? 0),
          mx: Number(row?.mx ?? 0),
          my: Number(row?.my ?? 0),
          mz: Number(row?.mz ?? 0),
          e_ex: Number(row?.e_ex ?? 0),
          e_demag: Number(row?.e_demag ?? 0),
          e_ext: Number(row?.e_ext ?? 0),
          e_ani: Number(row?.e_ani ?? 0),
          e_dmi: Number(row?.e_dmi ?? 0),
          e_total: Number(row?.e_total ?? 0),
          max_dm_dt: Number(row?.max_dm_dt ?? 0),
          max_h_eff: Number(row?.max_h_eff ?? 0),
          max_h_demag: Number(row?.max_h_demag ?? 0),
          max_torque_Apm: Number(row?.max_torque_Apm ?? 0),
          max_torque_T: Number(row?.max_torque_T ?? 0),
        })),
    // Server-side total row count (used by merge logic to distinguish "empty delta" from no data).
    scalar_rows_total: typeof raw.scalar_rows_total === "number" ? raw.scalar_rows_total : rawScalarRowsForMerge.length,
    engine_log: Array.isArray(raw.engine_log) ? raw.engine_log : [],
    quantities: Array.isArray(raw.quantities)
      ? raw.quantities.map((quantity: any) => ({
          id: String(quantity?.id ?? ""),
          label: String(quantity?.label ?? ""),
          kind: String(quantity?.kind ?? ""),
          unit: String(quantity?.unit ?? ""),
          location: String(quantity?.location ?? ""),
          available: Boolean(quantity?.available),
          interactive_preview: Boolean(quantity?.interactive_preview),
          quick_access_label:
            typeof quantity?.quick_access_label === "string" ? quantity.quick_access_label : null,
          scalar_metric_key:
            typeof quantity?.scalar_metric_key === "string" ? quantity.scalar_metric_key : null,
          n_comp: Number(quantity?.n_comp ?? 0),
          domain: String(quantity?.domain ?? "magnetic_only") as "magnetic_only" | "full_domain",
          normalization_hint: String(quantity?.normalization_hint ?? "none") as "unit_vector" | "max_abs" | "none",
          supports_preview_2d: Boolean(quantity?.supports_preview_2d),
          supports_preview_3d: Boolean(quantity?.supports_preview_3d),
          supports_history: Boolean(quantity?.supports_history),
          supports_export: Boolean(quantity?.supports_export),
        }))
      : [],
    fem_mesh: normalizeFemLiveMesh(raw.fem_mesh ?? raw.live_state?.latest_step?.fem_mesh),
    latest_fields: latestFields,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    display_selection: displaySelection,
    preview_config:
      normalizePreviewConfig(rawPreviewConfig) ??
      previewConfigFromDisplaySelection(displaySelection),
    preview: normalizePreviewState(rawPreview, pendingVectorPayloads),
    command_status: null,
    step_update_v2: raw.step_update_v2 ?? null,
  };
}
