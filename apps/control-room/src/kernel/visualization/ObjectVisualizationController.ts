import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import type { Selection } from "../selection/selectionTypes";

export type VisualizationTargetKind = "airbox" | "object" | "part";
export type VisualizationRenderMode =
  | "points"
  | "surface"
  | "surface+edges"
  | "wireframe";

export interface VisualizationTargetRef {
  id: string;
  kind: VisualizationTargetKind;
  label?: string | null;
}

export interface VisualizationTargetSettings {
  opacityPercent: number;
  pointsVisible: boolean;
  renderMode: VisualizationRenderMode;
  shaderVisible: boolean;
  vectorsVisible: boolean;
  visible: boolean;
  wireframeVisible: boolean;
}

export type VisualizationTargetPatch = Partial<VisualizationTargetSettings>;

export interface ObjectVisualizationSnapshot {
  overrides: Record<string, VisualizationTargetPatch>;
  version: number;
}

type AirboxVisualizationStateLike = {
  layers?: {
    airbox?: VisualizationStateResource["layers"]["airbox"] | null;
  } | null;
};

type ObjectVisualizationListener = () => void;

export const AIRBOX_VISUALIZATION_TARGET: VisualizationTargetRef = {
  id: "airbox",
  kind: "airbox",
  label: "Airbox",
};

export const DEFAULT_OBJECT_VISUALIZATION: VisualizationTargetSettings = {
  opacityPercent: 55,
  pointsVisible: false,
  renderMode: "surface+edges",
  shaderVisible: true,
  vectorsVisible: false,
  visible: true,
  wireframeVisible: true,
};

export const DEFAULT_AIRBOX_VISUALIZATION: VisualizationTargetSettings = {
  opacityPercent: 28,
  pointsVisible: false,
  renderMode: "wireframe",
  shaderVisible: false,
  vectorsVisible: false,
  visible: true,
  wireframeVisible: true,
};

const DEFAULT_PART_VISUALIZATION: VisualizationTargetSettings = {
  ...DEFAULT_OBJECT_VISUALIZATION,
  renderMode: "surface",
  wireframeVisible: false,
};

export class ObjectVisualizationController {
  private readonly listeners = new Set<ObjectVisualizationListener>();
  private readonly overrides = new Map<string, VisualizationTargetPatch>();
  private snapshot: ObjectVisualizationSnapshot = {
    overrides: {},
    version: 0,
  };

  clearTarget(target: VisualizationTargetRef): void {
    if (!this.overrides.delete(visualizationTargetKey(target))) {
      return;
    }

    this.bump();
  }

  getSettings(target: VisualizationTargetRef): VisualizationTargetSettings {
    return resolveVisualizationSettings(this.snapshot, target);
  }

  getSnapshot(): ObjectVisualizationSnapshot {
    return this.snapshot;
  }

  patchTarget(
    target: VisualizationTargetRef,
    patch: VisualizationTargetPatch,
  ): void {
    const key = visualizationTargetKey(target);
    const current = this.overrides.get(key) ?? {};
    const next = normalizePatch({
      ...current,
      ...patch,
    });

    if (samePatch(current, next)) {
      return;
    }

    this.overrides.set(key, next);
    this.bump();
  }

  subscribe(listener: ObjectVisualizationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bump(): void {
    this.snapshot = {
      overrides: Object.fromEntries(this.overrides),
      version: this.snapshot.version + 1,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function defaultVisualizationSettings(
  kind: VisualizationTargetKind,
): VisualizationTargetSettings {
  if (kind === "airbox") return DEFAULT_AIRBOX_VISUALIZATION;
  if (kind === "part") return DEFAULT_PART_VISUALIZATION;
  return DEFAULT_OBJECT_VISUALIZATION;
}

export function displayLabelForVisualizationTarget(
  target: VisualizationTargetRef,
): string {
  return target.label ?? (target.kind === "airbox" ? "Airbox" : target.id);
}

export function renderModePatch(
  renderMode: VisualizationRenderMode,
): VisualizationTargetPatch {
  if (renderMode === "surface") {
    return {
      pointsVisible: false,
      renderMode,
      shaderVisible: true,
      wireframeVisible: false,
    };
  }

  if (renderMode === "wireframe") {
    return {
      pointsVisible: false,
      renderMode,
      shaderVisible: false,
      wireframeVisible: true,
    };
  }

  if (renderMode === "points") {
    return {
      pointsVisible: true,
      renderMode,
      shaderVisible: false,
      wireframeVisible: false,
    };
  }

  return {
    pointsVisible: false,
    renderMode,
    shaderVisible: true,
    wireframeVisible: true,
  };
}

export function resolveVisualizationSettings(
  snapshot: ObjectVisualizationSnapshot,
  target: VisualizationTargetRef,
  baseSettings?: VisualizationTargetSettings,
): VisualizationTargetSettings {
  return normalizeVisualizationSettings({
    ...(baseSettings ?? defaultVisualizationSettings(target.kind)),
    ...(snapshot.overrides[visualizationTargetKey(target)] ?? {}),
  });
}

export function resolveAirboxVisualizationSettingsFromState(
  state: AirboxVisualizationStateLike | null | undefined,
): VisualizationTargetSettings {
  const airbox = state?.layers?.airbox;
  const shaderVisible =
    airbox?.surface?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.shaderVisible;
  const wireframeVisible =
    airbox?.wireframe?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.wireframeVisible;
  const pointsVisible =
    airbox?.points?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.pointsVisible;

  return {
    ...DEFAULT_AIRBOX_VISUALIZATION,
    opacityPercent: layerOpacityToPercent(
      airbox?.opacity ?? DEFAULT_AIRBOX_VISUALIZATION.opacityPercent / 100,
    ),
    pointsVisible,
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible,
      wireframeVisible,
    }),
    shaderVisible,
    vectorsVisible:
      airbox?.vectors?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.vectorsVisible,
    visible: airbox?.visible ?? DEFAULT_AIRBOX_VISUALIZATION.visible,
    wireframeVisible,
  };
}

export function airboxVisualizationStatePatchFromTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationStatePatch {
  return {
    layers: {
      airbox: {
        ...(patch.opacityPercent === undefined
          ? {}
          : { opacity: clampOpacity(patch.opacityPercent) / 100 }),
        ...(patch.pointsVisible === undefined
          ? {}
          : { points: { visible: patch.pointsVisible } }),
        ...(patch.shaderVisible === undefined
          ? {}
          : { surface: { visible: patch.shaderVisible } }),
        ...(patch.vectorsVisible === undefined
          ? {}
          : {
              vectors: {
                domain: "airbox_only",
                visible: patch.vectorsVisible,
              },
            }),
        ...(patch.visible === undefined ? {} : { visible: patch.visible }),
        ...(patch.wireframeVisible === undefined
          ? {}
          : { wireframe: { visible: patch.wireframeVisible } }),
      },
    },
  };
}

export function resolveVisualizationTargetFromSelection(
  selection: Pick<Selection, "kind" | "label" | "nodeId" | "objectId">,
): VisualizationTargetRef | null {
  if (selection.kind === "airbox.visualization" || selection.kind === "mesh-part-airbox") {
    return AIRBOX_VISUALIZATION_TARGET;
  }

  if (selection.objectId) {
    return {
      id: selection.objectId,
      kind: "object",
      label: selection.label,
    };
  }

  if (selection.kind === "mesh-part" && selection.nodeId) {
    return {
      id: selection.nodeId,
      kind: "part",
      label: selection.label,
    };
  }

  return null;
}

export function visualizationTargetKey(target: VisualizationTargetRef): string {
  if (target.kind === "airbox") return "airbox";
  return `${target.kind}:${target.id}`;
}

function normalizePatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  const normalized = { ...patch };
  if (normalized.opacityPercent !== undefined) {
    normalized.opacityPercent = clampOpacity(normalized.opacityPercent);
  }
  if (normalized.renderMode) {
    Object.assign(normalized, renderModePatch(normalized.renderMode));
  }
  return normalized;
}

function normalizeVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  return {
    ...settings,
    opacityPercent: clampOpacity(settings.opacityPercent),
  };
}

function clampOpacity(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function layerOpacityToPercent(value: number): number {
  return clampOpacity(value * 100);
}

function resolveRenderMode({
  pointsVisible,
  shaderVisible,
  wireframeVisible,
}: Pick<
  VisualizationTargetSettings,
  "pointsVisible" | "shaderVisible" | "wireframeVisible"
>): VisualizationRenderMode {
  if (pointsVisible) return "points";
  if (shaderVisible && wireframeVisible) return "surface+edges";
  if (shaderVisible) return "surface";
  return "wireframe";
}

function samePatch(
  left: VisualizationTargetPatch,
  right: VisualizationTargetPatch,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
