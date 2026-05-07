/**
 * Pure utility functions extracted from ControlRoomContext.tsx.
 * No React hooks — only plain functions and constants.
 */
import type { GpuTelemetryDevice } from "@/src/api/types";
import type {
  MeshEntityViewStateMap,
  SceneDocument,
  VisualizationPreset,
  VisualizationPresetFdmState,
  VisualizationPresetRef,
} from "../../../lib/session/types";
import type { ResultWorkspaceKind } from "@/features/analyze/model/analyzeTypes";
import type { ObjectViewMode } from "./shared";
import {
  LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY,
  LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY,
  cloneVisualizationPreset,
  createDefaultVisualizationPreset,
} from "./visualizationPresets";
import type { ScalarRow, EngineLogEntry, QuantityDescriptor, ArtifactEntry } from "@/lib/session/types";

/* ── Stable empty arrays ── */
export const EMPTY_SCALAR_ROWS: ScalarRow[] = [];
export const EMPTY_ENGINE_LOG: EngineLogEntry[] = [];
export const EMPTY_QUANTITIES: QuantityDescriptor[] = [];
export const EMPTY_ARTIFACTS: ArtifactEntry[] = [];
export const DEFAULT_AIR_MESH_OPACITY = 28;
/** GPU telemetry is polled less frequently (5 s) since it no longer drives
 *  transportValue and only updates the command-context GPU readout. */
export const GPU_TELEMETRY_POLL_MS = 5000;

export const DEFAULT_FDM_VISUALIZATION_SETTINGS: VisualizationPresetFdmState = {
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
};

export function fmtGpuMemoryGb(valueMb: number): string {
  return `${(valueMb / 1024).toFixed(1)} GB`;
}

export function runtimeEngineGpuLabelForDevice(device: GpuTelemetryDevice | null): string | null {
  if (!device) {
    return null;
  }
  return `${Math.round(device.utilization_gpu_percent)}% GPU · ${fmtGpuMemoryGb(device.memory_used_mb)}/${fmtGpuMemoryGb(device.memory_total_mb)}`;
}

export function parseOptionalFiniteNumberText(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resultWorkspaceIcon(kind: ResultWorkspaceKind): string {
  switch (kind) {
    case "spectrum":
      return "📊";
    case "dispersion":
      return "≈";
    case "modes":
      return "〜";
    case "time-traces":
      return "〰";
    case "vortex-frequency":
      return "🌀";
    case "vortex-trajectory":
      return "◎";
    case "vortex-orbit":
      return "◉";
    case "table":
      return "📋";
    case "quantity":
    default:
      return "𝑓";
  }
}

export function normalizePersistedObjectViewMode(
  value: SceneDocument["editor"]["object_view_mode"],
): ObjectViewMode {
  return value === "isolate" ? "isolate" : "context";
}

export function normalizePersistedMeshEntityViewState(
  value: SceneDocument["editor"]["mesh_entity_view_state"],
): MeshEntityViewStateMap {
  const next: MeshEntityViewStateMap = {};
  for (const [entityId, state] of Object.entries(value ?? {})) {
    next[entityId] = {
      visible: state.visible,
      renderMode: state.render_mode,
      opacity: state.opacity,
      colorField: state.color_field,
    };
  }
  return next;
}

export function serializeMeshEntityViewStateForScene(
  value: MeshEntityViewStateMap,
): SceneDocument["editor"]["mesh_entity_view_state"] {
  const next: SceneDocument["editor"]["mesh_entity_view_state"] = {};
  for (const [entityId, state] of Object.entries(value)) {
    next[entityId] = {
      visible: state.visible,
      render_mode: state.renderMode,
      opacity: state.opacity,
      color_field: state.colorField,
    };
  }
  return next;
}

export function samePersistedMeshEntityViewState(
  left: SceneDocument["editor"]["mesh_entity_view_state"],
  right: SceneDocument["editor"]["mesh_entity_view_state"],
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    const lhs = left[key];
    const rhs = right[key];
    if (!rhs) {
      return false;
    }
    if (
      lhs.visible !== rhs.visible ||
      lhs.render_mode !== rhs.render_mode ||
      lhs.opacity !== rhs.opacity ||
      lhs.color_field !== rhs.color_field
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeVisualizationPresetRef(
  value: VisualizationPresetRef | null | undefined,
): VisualizationPresetRef | null {
  if (!value || !value.preset_id || (value.source !== "project" && value.source !== "local")) {
    return null;
  }
  return {
    source: value.source,
    preset_id: value.preset_id,
  };
}

export function sameVisualizationPresetRef(
  left: VisualizationPresetRef | null | undefined,
  right: VisualizationPresetRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left == null && right == null;
  }
  return left.source === right.source && left.preset_id === right.preset_id;
}

export function sameMeshEntityViewStateMap(
  left: MeshEntityViewStateMap,
  right: MeshEntityViewStateMap,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    const lhs = left[key];
    const rhs = right[key];
    if (!lhs || !rhs) {
      return false;
    }
    if (
      lhs.visible !== rhs.visible ||
      lhs.renderMode !== rhs.renderMode ||
      lhs.opacity !== rhs.opacity ||
      lhs.colorField !== rhs.colorField
    ) {
      return false;
    }
  }
  return true;
}

export function sameVisualizationPresets(
  left: VisualizationPreset[],
  right: VisualizationPreset[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return false;
    }
  }
  return true;
}

export function loadLocalVisualizationPresets(): VisualizationPreset[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_VISUALIZATION_PRESETS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const normalized: VisualizationPreset[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const value = entry as VisualizationPreset;
      normalized.push(
        createDefaultVisualizationPreset({
          id: value.id,
          name: value.name || "Visualization",
          quantity: value.quantity || "m",
          domain: value.domain === "fdm" ? "fdm" : "fem",
          mode: value.mode === "2D" ? "2D" : "3D",
          nowUnixMs: Number(value.updated_at_unix_ms ?? Date.now()),
        }),
      );
      const last = normalized[normalized.length - 1];
      normalized[normalized.length - 1] = cloneVisualizationPreset(last, value);
    }
    return normalized;
  } catch {
    return [];
  }
}

export function loadLocalActiveVisualizationRef(): VisualizationPresetRef | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_ACTIVE_VISUALIZATION_PRESET_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as VisualizationPresetRef;
    return normalizeVisualizationPresetRef(parsed);
  } catch {
    return null;
  }
}
