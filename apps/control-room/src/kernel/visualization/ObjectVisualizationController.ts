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
  vectorBudget: number;
  vectorCenteringEnabled: boolean;
  vectorColorMode: VisualizationColorMode;
  vectorLengthScale: number;
  vectorMonoColor: string;
  vectorSurfaceOffsetEnabled: boolean;
  vectorSurfaceOffsetScale: number;
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
  targets?: VisualizationStateResource["targets"] | null;
};

type ResolvedTargetSettingsResource = NonNullable<
  NonNullable<VisualizationStateResource["targets"]>["airbox"]
>["settings"];

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
  vectorBudget: 1200,
  vectorCenteringEnabled: true,
  vectorColorMode: "orientation",
  vectorLengthScale: 1,
  vectorMonoColor: "var(--fm-accent)",
  vectorSurfaceOffsetEnabled: false,
  vectorSurfaceOffsetScale: 0.1,
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
  vectorBudget: 1200,
  vectorCenteringEnabled: true,
  vectorColorMode: "orientation",
  vectorLengthScale: 1,
  vectorMonoColor: "var(--fm-accent)",
  vectorSurfaceOffsetEnabled: false,
  vectorSurfaceOffsetScale: 0.1,
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

function defaultVisualizationSettings(
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

function resolveVisualizationStateTargetOverride(
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
    ...(display?.bounds?.visible === undefined || display.bounds.visible === null
      ? {}
      : { boundsVisible: display.bounds.visible }),
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
    ...(style?.vector_budget === undefined || style.vector_budget === null
      ? {}
      : { vectorBudget: Math.max(0, Math.floor(style.vector_budget)) }),
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
      : { vectorThickness: style.vector_thickness as number }),
    ...(style?.vector_length_scale === undefined || style.vector_length_scale === null
      ? {}
      : { vectorLengthScale: style.vector_length_scale as number }),
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
    ...(normalized.boundsVisible === undefined
      ? {}
      : { bounds: { visible: normalized.boundsVisible } }),
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
    ...(normalized.vectorBudget === undefined
      ? {}
      : { vector_budget: Math.max(1, Math.floor(normalized.vectorBudget)) }),
    ...(normalized.vectorLengthScale === undefined
      ? {}
      : {
          vector_length_scale: Math.max(
            0.1,
            Math.min(5, normalized.vectorLengthScale),
          ),
        }),
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

export function visualizationStatePatchFromDefaultTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationStatePatch {
  const normalized = normalizePatch(patch);
  const layers: NonNullable<VisualizationStatePatch["layers"]> = {};
  const surface = {
    ...(normalized.opacityPercent === undefined
      ? {}
      : { opacity: clampOpacity(normalized.opacityPercent) / 100 }),
    ...(normalized.shaderVisible === undefined
      ? {}
      : { visible: normalized.shaderVisible }),
  };
  const wireframe = {
    ...(normalized.wireframeOpacityPercent === undefined
      ? {}
      : { opacity: clampOpacity(normalized.wireframeOpacityPercent) / 100 }),
    ...(normalized.wireframeVisible === undefined
      ? {}
      : { visible: normalized.wireframeVisible }),
  };
  const vectors = {
    ...(normalized.vectorsVisible === undefined
      ? {}
      : { visible: normalized.vectorsVisible }),
    ...(normalized.vectorBudget === undefined
      ? {}
      : { density: Math.max(1, Math.floor(normalized.vectorBudget)) }),
  };
  const vectorColorMode =
    normalized.surfaceColorSource === undefined
      ? normalized.vectorColorMode
      : surfaceColorSourceToColorMode(normalized.surfaceColorSource) ??
        "monochrome";
  const vectorStyle = {
    ...(vectorColorMode === undefined ? {} : { color_mode: vectorColorMode }),
    ...(normalized.shaderMonoColor === undefined &&
    normalized.vectorMonoColor === undefined
      ? {}
      : {
          mono_color:
            normalized.shaderMonoColor ?? normalized.vectorMonoColor ?? "",
        }),
    ...(normalized.vectorAlphaPercent === undefined
      ? {}
      : { alpha: clampOpacity(normalized.vectorAlphaPercent) / 100 }),
    ...(normalized.vectorLengthScale === undefined
      ? {}
      : { length_scale: Math.max(0.1, Math.min(5, normalized.vectorLengthScale)) }),
    ...(normalized.vectorThickness === undefined
      ? {}
      : { thickness: clampScale(normalized.vectorThickness) }),
    ...(normalized.vectorLengthScale === undefined
      ? {}
      : { vector_length_scale: Math.max(0.1, Math.min(5, normalized.vectorLengthScale)) }),
  };

  if (normalized.boundsVisible !== undefined) {
    layers.bounds = { visible: normalized.boundsVisible };
  }
  if (Object.keys(surface).length > 0) {
    layers.surface = surface;
  }
  if (Object.keys(wireframe).length > 0) {
    layers.wireframe = wireframe;
  }
  if (normalized.pointsVisible !== undefined) {
    layers.points = { visible: normalized.pointsVisible };
  }
  if (Object.keys(vectors).length > 0) {
    layers.vectors = vectors;
  }

  return {
    ...(Object.keys(layers).length === 0 ? {} : { layers }),
    ...(Object.keys(vectorStyle).length === 0
      ? {}
      : { vector_style: vectorStyle }),
    ...(normalized.vectorsVisible === undefined
      ? {}
      : { vector_glyphs: normalized.vectorsVisible }),
  };
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
      bounds: mergeOptionalRecord(current.display?.bounds, next.display?.bounds),
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

function resolveVisualizationBaseSettings(
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
    boundsVisible:
      state?.layers?.bounds?.visible ?? DEFAULT_OBJECT_VISUALIZATION.boundsVisible,
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
  const targetSettings = visualizationSettingsFromResolvedTarget(
    state?.targets?.airbox?.settings,
  );
  const baseSettings = targetSettings ?? DEFAULT_AIRBOX_VISUALIZATION;
  const airbox = state?.layers?.airbox;
  const shaderVisible =
    airbox?.surface?.visible ?? baseSettings.shaderVisible;
  const wireframeVisible =
    airbox?.wireframe?.visible ?? baseSettings.wireframeVisible;
  const pointsVisible =
    airbox?.points?.visible ?? baseSettings.pointsVisible;

  return {
    ...baseSettings,
    boundsVisible:
      airbox?.bounds?.visible ?? baseSettings.boundsVisible,
    opacityPercent: layerOpacityToPercent(
      airbox?.opacity ?? baseSettings.opacityPercent / 100,
    ),
    pointsVisible,
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible,
      wireframeVisible,
    }),
    shaderVisible,
    vectorBudget:
      targetSettings === null
        ? airbox?.vectors?.density ?? baseSettings.vectorBudget
        : baseSettings.vectorBudget,
    vectorsVisible:
      airbox?.vectors?.visible ?? baseSettings.vectorsVisible,
    visible: airbox?.visible ?? baseSettings.visible,
    wireframeVisible,
  };
}

function visualizationSettingsFromResolvedTarget(
  settings: ResolvedTargetSettingsResource | null | undefined,
): VisualizationTargetSettings | null {
  if (!settings) return null;

  return normalizeVisualizationSettings({
    ...DEFAULT_AIRBOX_VISUALIZATION,
    boundsVisible: settings.bounds_visible,
    geometryScope: settings.geometry_scope,
    opacityPercent: layerOpacityToPercent(settings.opacity),
    pointsVisible: settings.points_visible,
    renderMode: settings.render_mode,
    shaderMonoColor: settings.surface_mono_color,
    shaderVisible: settings.surface_visible,
    surfaceColorSource: settings.surface_color_source,
    vectorAlphaPercent: layerOpacityToPercent(settings.vector_alpha),
    vectorBudget: Math.max(
      1,
      Math.floor(
        settings.vector_budget ?? DEFAULT_AIRBOX_VISUALIZATION.vectorBudget,
      ),
    ),
    vectorColorMode: settings.vector_color_mode,
    vectorLengthScale:
      settings.vector_length_scale ?? DEFAULT_AIRBOX_VISUALIZATION.vectorLengthScale,
    vectorMonoColor: settings.vector_mono_color,
    vectorThickness: settings.vector_thickness,
    vectorsVisible: settings.vectors_visible,
    visible: settings.visible,
    wireframeColor: settings.wireframe_color,
    wireframeOpacityPercent: layerOpacityToPercent(settings.wireframe_opacity),
    wireframeVisible: settings.wireframe_visible,
  });
}

export function airboxVisualizationStatePatchFromTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationStatePatch {
  const vectors =
    patch.vectorsVisible === undefined && patch.vectorBudget === undefined
      ? {}
      : {
          vectors: {
            domain: "airbox_only" as const,
            ...(patch.vectorBudget === undefined
              ? {}
              : { density: Math.max(1, Math.floor(patch.vectorBudget)) }),
            ...(patch.vectorsVisible === undefined
              ? {}
              : { visible: patch.vectorsVisible }),
          },
        };
  const airbox: NonNullable<
    NonNullable<VisualizationStatePatch["layers"]>["airbox"]
  > = {
    ...(patch.boundsVisible === undefined
      ? {}
      : { bounds: { visible: patch.boundsVisible } }),
    ...(patch.opacityPercent === undefined
      ? {}
      : { opacity: clampOpacity(patch.opacityPercent) / 100 }),
    ...(patch.pointsVisible === undefined
      ? {}
      : { points: { visible: patch.pointsVisible } }),
    ...(patch.shaderVisible === undefined
      ? {}
      : { surface: { visible: patch.shaderVisible } }),
    ...vectors,
    ...(patch.visible === undefined ? {} : { visible: patch.visible }),
    ...(patch.wireframeVisible === undefined
      ? {}
      : { wireframe: { visible: patch.wireframeVisible } }),
  };
  const vectorStyle =
    patch.vectorLengthScale === undefined
      ? {}
      : {
          vector_style: {
            length_scale: Math.max(0.1, Math.min(5, patch.vectorLengthScale)),
          },
        };

  return {
    ...(Object.keys(airbox).length > 0 ? { layers: { airbox } } : {}),
    ...vectorStyle,
  };
}

export function airboxLocalVisualizationPatchFromTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  return {
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
    ...(patch.vectorCenteringEnabled === undefined
      ? {}
      : { vectorCenteringEnabled: patch.vectorCenteringEnabled }),
    ...(patch.vectorColorMode === undefined
      ? {}
      : { vectorColorMode: patch.vectorColorMode }),
    ...(patch.vectorMonoColor === undefined
      ? {}
      : { vectorMonoColor: patch.vectorMonoColor }),
    ...(patch.vectorThickness === undefined
      ? {}
      : { vectorThickness: patch.vectorThickness }),
    ...(patch.vectorSurfaceOffsetEnabled === undefined
      ? {}
      : { vectorSurfaceOffsetEnabled: patch.vectorSurfaceOffsetEnabled }),
    ...(patch.vectorSurfaceOffsetScale === undefined
      ? {}
      : { vectorSurfaceOffsetScale: patch.vectorSurfaceOffsetScale }),
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
  if (normalized.vectorBudget !== undefined) {
    normalized.vectorBudget = Math.max(1, Math.floor(normalized.vectorBudget));
  }
  if (normalized.vectorLengthScale !== undefined) {
    normalized.vectorLengthScale = Math.max(0.1, Math.min(5, normalized.vectorLengthScale));
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

function normalizeSurfaceColorSource(
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

function surfaceColorSourceFromColorMode(
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
