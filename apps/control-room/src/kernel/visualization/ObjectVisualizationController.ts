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
export type VisualizationGeometryScope = "surface" | "full";
export type VisualizationColorMode =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "monochrome";
export type SurfaceColorSource =
  | "solid"
  | "orientation"
  | "component_x"
  | "component_y"
  | "component_z"
  | "magnitude"
  | "colormap";

export interface VisualizationTargetRef {
  id: string;
  kind: VisualizationTargetKind;
  label?: string | null;
}

export interface VisualizationTargetSettings {
  boundsVisible: boolean;
  geometryScope: VisualizationGeometryScope;
  opacityPercent: number;
  pointsVisible: boolean;
  renderMode: VisualizationRenderMode;
  shaderColorMode: VisualizationColorMode;
  shaderMonoColor: string;
  shaderVisible: boolean;
  surfaceColorSource: SurfaceColorSource;
  vectorAlphaPercent: number;
  vectorColorMode: VisualizationColorMode;
  vectorMonoColor: string;
  vectorThickness: number;
  vectorsVisible: boolean;
  visible: boolean;
  wireframeColor: string;
  wireframeOpacityPercent: number;
  wireframeVisible: boolean;
}

export type VisualizationTargetPatch = Partial<VisualizationTargetSettings>;

export interface ObjectVisualizationSnapshot {
  defaults: Partial<Record<VisualizationTargetKind, VisualizationTargetPatch>>;
  overrides: Record<string, VisualizationTargetPatch>;
  version: number;
}

export interface ResolvedTargetVisualization {
  baseSettings: VisualizationTargetSettings;
  effectiveSettings: VisualizationTargetSettings;
  override: VisualizationTargetPatch | null;
  revision: string;
  settings: VisualizationTargetSettings;
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
  boundsVisible: false,
  geometryScope: "full",
  opacityPercent: 100,
  pointsVisible: false,
  renderMode: "surface+edges",
  shaderColorMode: "orientation",
  shaderMonoColor: "var(--fm-surface-magnetic)",
  shaderVisible: true,
  surfaceColorSource: "orientation",
  vectorAlphaPercent: 100,
  vectorColorMode: "orientation",
  vectorMonoColor: "var(--fm-accent)",
  vectorThickness: 1,
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-border-strong)",
  wireframeOpacityPercent: 100,
  wireframeVisible: true,
};

export const DEFAULT_AIRBOX_VISUALIZATION: VisualizationTargetSettings = {
  boundsVisible: false,
  geometryScope: "full",
  opacityPercent: 28,
  pointsVisible: false,
  renderMode: "wireframe",
  shaderColorMode: "monochrome",
  shaderMonoColor: "var(--fm-airbox-fill)",
  shaderVisible: false,
  surfaceColorSource: "solid",
  vectorAlphaPercent: 100,
  vectorColorMode: "orientation",
  vectorMonoColor: "var(--fm-accent)",
  vectorThickness: 1,
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-airbox-wire)",
  wireframeOpacityPercent: 100,
  wireframeVisible: true,
};

const DEFAULT_PART_VISUALIZATION: VisualizationTargetSettings = {
  ...DEFAULT_OBJECT_VISUALIZATION,
  renderMode: "surface",
  wireframeVisible: false,
};

export class ObjectVisualizationController {
  private readonly defaults = new Map<
    VisualizationTargetKind,
    VisualizationTargetPatch
  >();
  private readonly listeners = new Set<ObjectVisualizationListener>();
  private readonly overrides = new Map<string, VisualizationTargetPatch>();
  private snapshot: ObjectVisualizationSnapshot = {
    defaults: {},
    overrides: {},
    version: 0,
  };

  clearDefaults(kind: VisualizationTargetKind): void {
    if (!this.defaults.delete(kind)) {
      return;
    }

    this.bump();
  }

  clearTarget(target: VisualizationTargetRef): void {
    if (!this.overrides.delete(visualizationTargetKey(target))) {
      return;
    }

    this.bump();
  }

  getDefaultSettings(
    kind: VisualizationTargetKind,
    baseSettings?: VisualizationTargetSettings,
  ): VisualizationTargetSettings {
    return resolveDefaultVisualizationSettings(
      this.snapshot,
      kind,
      baseSettings,
    );
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

  patchDefaults(
    kind: VisualizationTargetKind,
    patch: VisualizationTargetPatch,
  ): void {
    const current = this.defaults.get(kind) ?? {};
    const next = normalizePatch({
      ...current,
      ...patch,
    });

    if (samePatch(current, next)) {
      return;
    }

    this.defaults.set(kind, next);
    this.bump();
  }

  subscribe(listener: ObjectVisualizationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private bump(): void {
    this.snapshot = {
      defaults: Object.fromEntries(this.defaults),
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
    ...resolveDefaultVisualizationSettings(snapshot, target.kind, baseSettings),
    ...(snapshot.overrides[visualizationTargetKey(target)] ?? {}),
  });
}

export function resolveEffectiveVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  if (settings.visible) {
    return settings;
  }

  return {
    ...settings,
    boundsVisible: false,
    pointsVisible: false,
    shaderVisible: false,
    vectorsVisible: false,
    wireframeVisible: false,
  };
}

export function resolveDefaultVisualizationSettings(
  snapshot: ObjectVisualizationSnapshot,
  kind: VisualizationTargetKind,
  baseSettings?: VisualizationTargetSettings,
): VisualizationTargetSettings {
  return normalizeVisualizationSettings({
    ...defaultVisualizationSettings(kind),
    ...(baseSettings ?? {}),
    ...(snapshot.defaults[kind] ?? {}),
  });
}

export function resolveTargetVisualization({
  snapshot,
  target,
  visualizationState,
}: {
  snapshot: ObjectVisualizationSnapshot;
  target: VisualizationTargetRef;
  visualizationState?: VisualizationStateResource | null;
}): ResolvedTargetVisualization {
  const baseSettings = resolveVisualizationBaseSettings(
    target.kind,
    visualizationState,
  );
  const localOverride = snapshot.overrides[visualizationTargetKey(target)] ?? null;
  const backendOverride = resolveVisualizationStateTargetOverride(
    visualizationState,
    target,
  );
  const settings = normalizeVisualizationSettings({
    ...resolveDefaultVisualizationSettings(snapshot, target.kind, baseSettings),
    ...(backendOverride ?? {}),
    ...(localOverride ?? {}),
  });

  return {
    baseSettings,
    effectiveSettings: resolveEffectiveVisualizationSettings(settings),
    override:
      backendOverride || localOverride
        ? {
            ...(backendOverride ?? {}),
            ...(localOverride ?? {}),
          }
        : null,
    revision:
      visualizationState?.revision === undefined
        ? `${snapshot.version}`
        : `${snapshot.version}:${visualizationState.revision}`,
    settings,
  };
}

export function resolveVisualizationStateTargetOverride(
  state: VisualizationStateResource | null | undefined,
  target: VisualizationTargetRef,
): VisualizationTargetPatch | null {
  const override = state?.overrides?.find(
    (entry) => entry.scope === target.kind && entry.scope_id === target.id,
  );
  if (!override) return null;
  const display = override.display ?? null;
  const style = override.style ?? null;
  const visible = display?.visible ?? override.visible;
  const patch: VisualizationTargetPatch = {
    ...(display?.geometry_scope === undefined || display.geometry_scope === null
      ? {}
      : { geometryScope: display.geometry_scope }),
    ...(display?.opacity === undefined || display.opacity === null
      ? {}
      : { opacityPercent: layerOpacityToPercent(display.opacity) }),
    ...(display?.points?.visible === undefined ||
    display.points.visible === null
      ? {}
      : { pointsVisible: display.points.visible }),
    ...(display?.surface?.visible === undefined ||
    display.surface.visible === null
      ? {}
      : { shaderVisible: display.surface.visible }),
    ...(display?.vectors?.visible === undefined ||
    display.vectors.visible === null
      ? {}
      : { vectorsVisible: display.vectors.visible }),
    ...(visible === undefined || visible === null ? {} : { visible }),
    ...(display?.wireframe?.opacity === undefined ||
    display.wireframe.opacity === null
      ? {}
      : {
          wireframeOpacityPercent: layerOpacityToPercent(
            display.wireframe.opacity,
          ),
        }),
    ...(display?.wireframe?.visible === undefined ||
    display.wireframe.visible === null
      ? {}
      : { wireframeVisible: display.wireframe.visible }),
    ...(style?.surface_color_source === undefined ||
    style.surface_color_source === null
      ? {}
      : { surfaceColorSource: style.surface_color_source }),
    ...(style?.surface_mono_color === undefined ||
    style.surface_mono_color === null
      ? {}
      : { shaderMonoColor: style.surface_mono_color }),
    ...(style?.vector_alpha === undefined || style.vector_alpha === null
      ? {}
      : { vectorAlphaPercent: layerOpacityToPercent(style.vector_alpha) }),
    ...(style?.vector_color_mode === undefined ||
    style.vector_color_mode === null
      ? {}
      : { vectorColorMode: style.vector_color_mode }),
    ...(style?.vector_mono_color === undefined ||
    style.vector_mono_color === null
      ? {}
      : { vectorMonoColor: style.vector_mono_color }),
    ...(style?.vector_thickness === undefined ||
    style.vector_thickness === null
      ? {}
      : { vectorThickness: style.vector_thickness }),
    ...(style?.wireframe_color === undefined || style.wireframe_color === null
      ? {}
      : { wireframeColor: style.wireframe_color }),
  };

  return Object.keys(patch).length > 0 ? patch : null;
}

export function visualizationStateOverrideFromTargetPatch(
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): VisualizationStateResource["overrides"][number] {
  const normalized = normalizePatch(patch);
  const display = {
    ...(normalized.geometryScope === undefined
      ? {}
      : { geometry_scope: normalized.geometryScope }),
    ...(normalized.opacityPercent === undefined
      ? {}
      : { opacity: clampOpacity(normalized.opacityPercent) / 100 }),
    ...(normalized.pointsVisible === undefined
      ? {}
      : { points: { visible: normalized.pointsVisible } }),
    ...(normalized.shaderVisible === undefined
      ? {}
      : { surface: { visible: normalized.shaderVisible } }),
    ...(normalized.vectorsVisible === undefined
      ? {}
      : { vectors: { visible: normalized.vectorsVisible } }),
    ...(normalized.visible === undefined ? {} : { visible: normalized.visible }),
    ...(normalized.wireframeOpacityPercent === undefined &&
    normalized.wireframeVisible === undefined
      ? {}
      : {
          wireframe: {
            ...(normalized.wireframeOpacityPercent === undefined
              ? {}
              : {
                  opacity: clampOpacity(normalized.wireframeOpacityPercent) / 100,
                }),
            ...(normalized.wireframeVisible === undefined
              ? {}
              : { visible: normalized.wireframeVisible }),
          },
        }),
  };
  const style = {
    ...(normalized.surfaceColorSource === undefined
      ? {}
      : { surface_color_source: normalized.surfaceColorSource }),
    ...(normalized.shaderMonoColor === undefined
      ? {}
      : { surface_mono_color: normalized.shaderMonoColor }),
    ...(normalized.vectorAlphaPercent === undefined
      ? {}
      : { vector_alpha: clampOpacity(normalized.vectorAlphaPercent) / 100 }),
    ...(normalized.vectorColorMode === undefined
      ? {}
      : { vector_color_mode: normalized.vectorColorMode }),
    ...(normalized.vectorMonoColor === undefined
      ? {}
      : { vector_mono_color: normalized.vectorMonoColor }),
    ...(normalized.vectorThickness === undefined
      ? {}
      : { vector_thickness: normalized.vectorThickness }),
    ...(normalized.wireframeColor === undefined
      ? {}
      : { wireframe_color: normalized.wireframeColor }),
  };

  return {
    scope: target.kind,
    scope_id: target.id,
    ...(normalized.visible === undefined ? {} : { visible: normalized.visible }),
    ...(Object.keys(display).length === 0 ? {} : { display }),
    ...(Object.keys(style).length === 0 ? {} : { style }),
  };
}

export function mergeVisualizationStateTargetOverride(
  overrides: readonly VisualizationStateResource["overrides"][number][],
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): VisualizationStateResource["overrides"] {
  const next = visualizationStateOverrideFromTargetPatch(target, patch);
  const current = overrides.find(
    (entry) => entry.scope === target.kind && entry.scope_id === target.id,
  );
  const merged = current ? mergeVisualizationOverride(current, next) : next;
  const rest = overrides.filter(
    (entry) => !(entry.scope === target.kind && entry.scope_id === target.id),
  );
  return [...rest, merged];
}

function mergeVisualizationOverride(
  current: VisualizationStateResource["overrides"][number],
  next: VisualizationStateResource["overrides"][number],
): VisualizationStateResource["overrides"][number] {
  return {
    ...current,
    ...next,
    display: {
      ...(current.display ?? {}),
      ...(next.display ?? {}),
      points: mergeOptionalRecord(current.display?.points, next.display?.points),
      surface: mergeOptionalRecord(current.display?.surface, next.display?.surface),
      vectors: mergeOptionalRecord(current.display?.vectors, next.display?.vectors),
      wireframe: mergeOptionalRecord(
        current.display?.wireframe,
        next.display?.wireframe,
      ),
    },
    style: {
      ...(current.style ?? {}),
      ...(next.style ?? {}),
    },
  };
}

function mergeOptionalRecord<T extends object>(
  current: T | null | undefined,
  next: T | null | undefined,
): T | undefined {
  if (!current && !next) return undefined;
  return {
    ...(current ?? {}),
    ...(next ?? {}),
  } as T;
}

export function resolveVisualizationBaseSettings(
  kind: VisualizationTargetKind,
  state: VisualizationStateResource | null | undefined,
): VisualizationTargetSettings {
  if (kind === "airbox") {
    return resolveAirboxVisualizationSettingsFromState(state);
  }
  return resolveGlobalObjectVisualizationSettings(state);
}

export function resolveGlobalObjectVisualizationSettings(
  state: VisualizationStateResource | null | undefined,
): VisualizationTargetSettings {
  if (!state) {
    return DEFAULT_OBJECT_VISUALIZATION;
  }

  const surfaceVisible =
    state?.layers?.surface?.visible ?? DEFAULT_OBJECT_VISUALIZATION.shaderVisible;
  const wireframeVisible =
    state?.layers?.wireframe?.visible ??
    DEFAULT_OBJECT_VISUALIZATION.wireframeVisible;
  const pointsVisible =
    state?.layers?.points?.visible ?? DEFAULT_OBJECT_VISUALIZATION.pointsVisible;
  const vectorColorMode =
    state?.vector_style?.color_mode ??
    DEFAULT_OBJECT_VISUALIZATION.vectorColorMode;
  const vectorMonoColor =
    state?.vector_style?.mono_color ??
    DEFAULT_OBJECT_VISUALIZATION.vectorMonoColor;

  return {
    ...DEFAULT_OBJECT_VISUALIZATION,
    opacityPercent: layerOpacityToPercent(
      state?.layers?.surface?.opacity ??
        DEFAULT_OBJECT_VISUALIZATION.opacityPercent / 100,
    ),
    pointsVisible,
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible: surfaceVisible,
      wireframeVisible,
    }),
    shaderColorMode: vectorColorMode,
    shaderMonoColor: vectorMonoColor,
    shaderVisible: surfaceVisible,
    surfaceColorSource:
      surfaceColorSourceFromColorMode(vectorColorMode) ??
      DEFAULT_OBJECT_VISUALIZATION.surfaceColorSource,
    vectorAlphaPercent: layerOpacityToPercent(state?.vector_style?.alpha ?? 1),
    vectorColorMode,
    vectorMonoColor,
    vectorThickness:
      state?.vector_style?.thickness ??
      DEFAULT_OBJECT_VISUALIZATION.vectorThickness,
    vectorsVisible:
      state?.layers?.vectors?.visible ??
      state?.vector_glyphs ??
      DEFAULT_OBJECT_VISUALIZATION.vectorsVisible,
    wireframeVisible,
  };
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
  const airbox: NonNullable<
    NonNullable<VisualizationStatePatch["layers"]>["airbox"]
  > = {
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
  };

  return Object.keys(airbox).length > 0
    ? { layers: { airbox } }
    : {};
}

export function airboxLocalVisualizationPatchFromTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  return {
    ...(patch.boundsVisible === undefined
      ? {}
      : { boundsVisible: patch.boundsVisible }),
    ...(patch.geometryScope === undefined
      ? {}
      : { geometryScope: patch.geometryScope }),
    ...(patch.shaderColorMode === undefined
      ? {}
      : { shaderColorMode: patch.shaderColorMode }),
    ...(patch.shaderMonoColor === undefined
      ? {}
      : { shaderMonoColor: patch.shaderMonoColor }),
    ...(patch.surfaceColorSource === undefined
      ? {}
      : { surfaceColorSource: patch.surfaceColorSource }),
    ...(patch.vectorAlphaPercent === undefined
      ? {}
      : { vectorAlphaPercent: patch.vectorAlphaPercent }),
    ...(patch.vectorColorMode === undefined
      ? {}
      : { vectorColorMode: patch.vectorColorMode }),
    ...(patch.vectorMonoColor === undefined
      ? {}
      : { vectorMonoColor: patch.vectorMonoColor }),
    ...(patch.vectorThickness === undefined
      ? {}
      : { vectorThickness: patch.vectorThickness }),
    ...(patch.wireframeColor === undefined
      ? {}
      : { wireframeColor: patch.wireframeColor }),
    ...(patch.wireframeOpacityPercent === undefined
      ? {}
      : { wireframeOpacityPercent: patch.wireframeOpacityPercent }),
  };
}

export function hasVisualizationStatePatch(
  patch: VisualizationStatePatch,
): boolean {
  return Object.keys(patch).length > 0;
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
  const normalized = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as VisualizationTargetPatch;
  if (normalized.opacityPercent !== undefined) {
    normalized.opacityPercent = clampOpacity(normalized.opacityPercent);
  }
  if (normalized.vectorAlphaPercent !== undefined) {
    normalized.vectorAlphaPercent = clampOpacity(normalized.vectorAlphaPercent);
  }
  if (normalized.wireframeOpacityPercent !== undefined) {
    normalized.wireframeOpacityPercent = clampOpacity(
      normalized.wireframeOpacityPercent,
    );
  }
  if (normalized.vectorThickness !== undefined) {
    normalized.vectorThickness = clampScale(normalized.vectorThickness);
  }
  if (normalized.shaderColorMode !== undefined) {
    normalized.shaderColorMode =
      normalizeColorMode(normalized.shaderColorMode) ?? "orientation";
  }
  if (
    normalized.surfaceColorSource === undefined &&
    normalized.shaderColorMode !== undefined
  ) {
    normalized.surfaceColorSource = surfaceColorSourceFromColorMode(
      normalized.shaderColorMode,
    );
  }
  if (normalized.surfaceColorSource !== undefined) {
    normalized.surfaceColorSource =
      normalizeSurfaceColorSource(normalized.surfaceColorSource) ??
      "orientation";
    normalized.shaderColorMode = surfaceColorSourceToColorMode(
      normalized.surfaceColorSource,
    ) ?? "monochrome";
  }
  if (normalized.vectorColorMode !== undefined) {
    normalized.vectorColorMode =
      normalizeColorMode(normalized.vectorColorMode) ?? "orientation";
  }
  if (normalized.renderMode) {
    Object.assign(normalized, renderModePatch(normalized.renderMode));
  }
  return normalized;
}

function normalizeVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const surfaceColorSource =
    normalizeSurfaceColorSource(settings.surfaceColorSource) ??
    surfaceColorSourceFromColorMode(settings.shaderColorMode) ??
    "orientation";
  return {
    ...settings,
    geometryScope:
      settings.geometryScope === "surface" || settings.geometryScope === "full"
        ? settings.geometryScope
        : "full",
    opacityPercent: clampOpacity(settings.opacityPercent),
    shaderColorMode:
      surfaceColorSourceToColorMode(surfaceColorSource) ?? "monochrome",
    surfaceColorSource,
  };
}

function clampOpacity(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function clampScale(value: number): number {
  return Math.min(8, Math.max(0.1, value));
}

function normalizeColorMode(value: unknown): VisualizationColorMode | undefined {
  return value === "orientation" ||
    value === "x" ||
    value === "y" ||
    value === "z" ||
    value === "magnitude" ||
    value === "monochrome"
    ? value
    : undefined;
}

export function normalizeSurfaceColorSource(
  value: unknown,
): SurfaceColorSource | undefined {
  return value === "solid" ||
    value === "orientation" ||
    value === "component_x" ||
    value === "component_y" ||
    value === "component_z" ||
    value === "magnitude" ||
    value === "colormap"
    ? value
    : undefined;
}

export function surfaceColorSourceFromColorMode(
  value: VisualizationColorMode | undefined,
): SurfaceColorSource | undefined {
  if (value === "monochrome") return "solid";
  if (value === "x") return "component_x";
  if (value === "y") return "component_y";
  if (value === "z") return "component_z";
  if (value === "orientation" || value === "magnitude") return value;
  return undefined;
}

export function surfaceColorSourceToColorMode(
  value: SurfaceColorSource,
): VisualizationColorMode | null {
  if (value === "solid") return null;
  if (value === "component_x") return "x";
  if (value === "component_y") return "y";
  if (value === "component_z") return "z";
  if (value === "colormap") return "magnitude";
  return value;
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
