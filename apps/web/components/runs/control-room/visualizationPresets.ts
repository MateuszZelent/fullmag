"use client";

import type {
  VisualizationPreset,
  VisualizationPresetRef,
  VisualizationPresetSource,
} from "../../../lib/session/types";

export const LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY = "fullmag.visualization-presets.local.v1";
export const LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY =
  "fullmag.visualization-presets.active-ref.v1";

export const VISUALIZATION_ROOT_NODE_ID = "visualization-root";
export const VISUALIZATION_PROJECT_SECTION_NODE_ID = "visualization-section-project";
export const VISUALIZATION_LOCAL_SECTION_NODE_ID = "visualization-section-local";

export interface ParsedVisualizationNode {
  source: VisualizationPresetSource;
  presetId: string;
}

export function visualizationSectionNodeId(source: VisualizationPresetSource): string {
  return source === "project"
    ? VISUALIZATION_PROJECT_SECTION_NODE_ID
    : VISUALIZATION_LOCAL_SECTION_NODE_ID;
}

export function buildVisualizationPresetNodeId(
  source: VisualizationPresetSource,
  presetId: string,
): string {
  return `vis-${source}-${presetId}`;
}

export function parseVisualizationPresetNodeId(
  nodeId: string | null | undefined,
): ParsedVisualizationNode | null {
  if (!nodeId || !nodeId.startsWith("vis-")) {
    return null;
  }
  const match = nodeId.match(/^vis-(project|local)-(.+)$/);
  if (!match) {
    return null;
  }
  return {
    source: match[1] as VisualizationPresetSource,
    presetId: match[2],
  };
}

export function isVisualizationTreeNode(nodeId: string | null | undefined): boolean {
  if (!nodeId) {
    return false;
  }
  return (
    nodeId === VISUALIZATION_ROOT_NODE_ID ||
    nodeId === VISUALIZATION_PROJECT_SECTION_NODE_ID ||
    nodeId === VISUALIZATION_LOCAL_SECTION_NODE_ID ||
    Boolean(parseVisualizationPresetNodeId(nodeId))
  );
}

export function nextVisualizationPresetName(
  existing: readonly VisualizationPreset[],
): string {
  const used = new Set(existing.map((preset) => preset.name));
  let index = existing.length + 1;
  while (used.has(`Visualization ${index}`)) {
    index += 1;
  }
  return `Visualization ${index}`;
}

export function createVisualizationPresetId(): string {
  return `vis_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createDefaultVisualizationPreset(
  params: {
    id?: string;
    name: string;
    quantity: string;
    domain: "fem" | "fdm";
    mode: "3D" | "2D";
    nowUnixMs?: number;
  },
): VisualizationPreset {
  const now = params.nowUnixMs ?? Date.now();
  return {
    id: params.id ?? createVisualizationPresetId(),
    name: params.name,
    mode: params.mode,
    domain: params.domain,
    quantity: params.quantity,
    fem: {
      render_mode: "surface+edges",
      opacity: 100,
      clip_enabled: false,
      clip_axis: "x",
      clip_pos: 50,
      show_arrows: false,
      max_points: 16384,
      arrow_color_mode: "orientation",
      arrow_mono_color: "#00c2ff",
      arrow_alpha: 1,
      arrow_length_scale: 1,
      arrow_thickness: 1,
      object_view_mode: "context",
      vector_domain_filter: "auto",
      ferromagnet_visibility_mode: "hide",
      air_mesh_visible: false,
      air_mesh_opacity: 28,
      mesh_entity_view_state: {},
    },
    fdm: {
      quality: "high",
      render_mode: "glyph",
      voxel_color_mode: "orientation",
      sampling: 1,
      brightness: 1.5,
      voxel_opacity: 0.5,
      voxel_gap: 0.14,
      voxel_threshold: 0.08,
      topo_enabled: false,
      topo_component: "z",
      topo_multiplier: 5,
    },
    two_d: {
      component: "magnitude",
      plane: "xy",
      slice_index: 0,
    },
    camera: {
      projection: null,
      navigation: null,
      preset: null,
    },
    created_at_unix_ms: now,
    updated_at_unix_ms: now,
  };
}

export function cloneVisualizationPreset(
  preset: VisualizationPreset,
  overrides: Partial<VisualizationPreset> = {},
): VisualizationPreset {
  const now = Date.now();
  return {
    ...preset,
    ...overrides,
    fem: {
      ...preset.fem,
      ...(overrides.fem ?? {}),
      mesh_entity_view_state: {
        ...preset.fem.mesh_entity_view_state,
        ...(overrides.fem?.mesh_entity_view_state ?? {}),
      },
    },
    fdm: {
      ...preset.fdm,
      ...(overrides.fdm ?? {}),
    },
    two_d: {
      ...preset.two_d,
      ...(overrides.two_d ?? {}),
    },
    camera: {
      ...preset.camera,
      ...(overrides.camera ?? {}),
    },
    updated_at_unix_ms: now,
  };
}

export function sameVisualizationPresetRef(
  left: VisualizationPresetRef | null | undefined,
  right: VisualizationPresetRef | null | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return left.source === right.source && left.preset_id === right.preset_id;
}
