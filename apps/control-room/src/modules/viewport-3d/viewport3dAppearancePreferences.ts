export type Viewport3DBackgroundMode = "solid" | "gradient";
export type Viewport3DLightingMode = "flat" | "studio";
export type Viewport3DLightingSpace = "camera" | "world";
export type Viewport3DDimensionOrigin = "frame-center" | "world";
export type Viewport3DExportBackground = "view" | "transparent";

export interface Viewport3DAppearancePreferences {
  renderMode: "scientific" | "presentation";
  materialRoughness: number;
  materialMetalness: number;
  softShadows: boolean;
  exportScale: 1 | 2 | 4;
  backgroundMode: Viewport3DBackgroundMode;
  backgroundStrength: number;
  lightingMode: Viewport3DLightingMode;
  lightingIntensity: number;
  lightingAzimuth: number;
  lightingElevation: number;
  lightingSpace: Viewport3DLightingSpace;
  dimensionOrigin: Viewport3DDimensionOrigin;
  gridOpacity: number;
  aoIntensity: number;
  aoRadius: number;
  exportBackground: Viewport3DExportBackground;
  exportAnnotations: boolean;
}

export type Viewport3DAppearanceSection =
  | "background"
  | "frame"
  | "lighting"
  | "effects"
  | "all";

export const DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES = Object.freeze({
  renderMode: "scientific",
  materialRoughness: 0.35,
  materialMetalness: 0.5,
  softShadows: true,
  exportScale: 2,
  backgroundMode: "gradient",
  backgroundStrength: 0.65,
  lightingMode: "studio",
  lightingIntensity: 1,
  lightingAzimuth: -35,
  lightingElevation: 45,
  lightingSpace: "camera",
  dimensionOrigin: "frame-center",
  gridOpacity: 1,
  aoIntensity: 1,
  aoRadius: 0.02,
  exportBackground: "view",
  exportAnnotations: true,
} satisfies Viewport3DAppearancePreferences);

export interface Viewport3DEffectDiagnostic {
  requested: boolean;
  effective: boolean;
  reason: string | null;
}

export interface Viewport3DAppearanceDiagnostics {
  ambientOcclusion: Viewport3DEffectDiagnostic;
  bloom: Viewport3DEffectDiagnostic;
  antialias: Viewport3DEffectDiagnostic;
}

export function resolveViewport3DAppearanceDiagnostics({
  ambientOcclusionRequested,
  antialiasRequested,
  bloomRequested,
  postProcessingAvailable = true,
  postProcessingDataProtected = false,
  profileAllowsAntialias,
  profileAllowsAmbientOcclusion = true,
}: {
  ambientOcclusionRequested: boolean;
  antialiasRequested: boolean;
  bloomRequested: boolean;
  postProcessingAvailable?: boolean;
  postProcessingDataProtected?: boolean;
  profileAllowsAntialias: boolean;
  profileAllowsAmbientOcclusion?: boolean;
}): Viewport3DAppearanceDiagnostics {
  const postProcessingEffect = (
    requested: boolean,
    profileAllowsEffect = true,
  ): Viewport3DEffectDiagnostic => {
    const reason = !requested
      ? null
      : postProcessingDataProtected
        ? "Quantitative field colors are protected"
        : !profileAllowsEffect
          ? "The selected quality disables ambient occlusion."
        : !postProcessingAvailable
          ? "Post-processing is disabled by browser configuration."
          : null;
    return {
      requested,
      effective: requested && profileAllowsEffect && postProcessingAvailable && !postProcessingDataProtected,
      reason,
    };
  };

  const antialiasEffective = antialiasRequested && profileAllowsAntialias;
  return {
    ambientOcclusion: postProcessingEffect(ambientOcclusionRequested, profileAllowsAmbientOcclusion),
    bloom: postProcessingEffect(bloomRequested),
    antialias: {
      requested: antialiasRequested,
      effective: antialiasEffective,
      reason:
        antialiasRequested && !profileAllowsAntialias
          ? "The selected visual profile disables canvas antialiasing."
          : null,
    },
  };
}

const APPEARANCE_ENUMS = {
  renderMode: ["scientific", "presentation"],
  backgroundMode: ["solid", "gradient"],
  lightingMode: ["flat", "studio"],
  lightingSpace: ["camera", "world"],
  dimensionOrigin: ["frame-center", "world"],
  exportBackground: ["view", "transparent"],
} as const;

const APPEARANCE_NUMERIC_BOUNDS = {
  materialRoughness: [0.05, 1],
  materialMetalness: [0, 1],
  backgroundStrength: [0, 1],
  lightingIntensity: [0, 2],
  lightingAzimuth: [-180, 180],
  lightingElevation: [-90, 90],
  gridOpacity: [0.25, 2],
  aoIntensity: [0, 3],
  aoRadius: [0, 1],
} as const;

export function normalizeViewport3DAppearancePreferences(
  value: unknown,
): Viewport3DAppearancePreferences {
  const record = asRecord(value);
  const defaults = DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES;
  return {
    renderMode: enumValue(record.renderMode, APPEARANCE_ENUMS.renderMode, defaults.renderMode),
    materialRoughness: numericValue(record.materialRoughness, APPEARANCE_NUMERIC_BOUNDS.materialRoughness, defaults.materialRoughness),
    materialMetalness: numericValue(record.materialMetalness, APPEARANCE_NUMERIC_BOUNDS.materialMetalness, defaults.materialMetalness),
    softShadows: booleanValue(record.softShadows, defaults.softShadows),
    exportScale: record.exportScale === 1 || record.exportScale === 2 || record.exportScale === 4 ? record.exportScale : defaults.exportScale,
    backgroundMode: enumValue(record.backgroundMode, APPEARANCE_ENUMS.backgroundMode, defaults.backgroundMode),
    backgroundStrength: numericValue(record.backgroundStrength, APPEARANCE_NUMERIC_BOUNDS.backgroundStrength, defaults.backgroundStrength),
    lightingMode: enumValue(record.lightingMode, APPEARANCE_ENUMS.lightingMode, defaults.lightingMode),
    lightingIntensity: numericValue(record.lightingIntensity, APPEARANCE_NUMERIC_BOUNDS.lightingIntensity, defaults.lightingIntensity),
    lightingAzimuth: numericValue(record.lightingAzimuth, APPEARANCE_NUMERIC_BOUNDS.lightingAzimuth, defaults.lightingAzimuth),
    lightingElevation: numericValue(record.lightingElevation, APPEARANCE_NUMERIC_BOUNDS.lightingElevation, defaults.lightingElevation),
    lightingSpace: enumValue(record.lightingSpace, APPEARANCE_ENUMS.lightingSpace, defaults.lightingSpace),
    dimensionOrigin: enumValue(record.dimensionOrigin, APPEARANCE_ENUMS.dimensionOrigin, defaults.dimensionOrigin),
    gridOpacity: numericValue(record.gridOpacity, APPEARANCE_NUMERIC_BOUNDS.gridOpacity, defaults.gridOpacity),
    aoIntensity: numericValue(record.aoIntensity, APPEARANCE_NUMERIC_BOUNDS.aoIntensity, defaults.aoIntensity),
    aoRadius: numericValue(record.aoRadius, APPEARANCE_NUMERIC_BOUNDS.aoRadius, defaults.aoRadius),
    exportBackground: enumValue(record.exportBackground, APPEARANCE_ENUMS.exportBackground, defaults.exportBackground),
    exportAnnotations: booleanValue(record.exportAnnotations, defaults.exportAnnotations),
  };
}

export function applyViewport3DAppearancePatch(
  current: Viewport3DAppearancePreferences,
  patch: unknown,
): Viewport3DAppearancePreferences {
  const record = asRecord(patch);
  const next = { ...current };
  if (isEnumValue(record.renderMode, APPEARANCE_ENUMS.renderMode)) next.renderMode = record.renderMode;
  if (isFiniteNumber(record.materialRoughness)) next.materialRoughness = clamp(record.materialRoughness, APPEARANCE_NUMERIC_BOUNDS.materialRoughness);
  if (isFiniteNumber(record.materialMetalness)) next.materialMetalness = clamp(record.materialMetalness, APPEARANCE_NUMERIC_BOUNDS.materialMetalness);
  if (typeof record.softShadows === "boolean") next.softShadows = record.softShadows;
  if (record.exportScale === 1 || record.exportScale === 2 || record.exportScale === 4) next.exportScale = record.exportScale;


  if (isEnumValue(record.backgroundMode, APPEARANCE_ENUMS.backgroundMode)) next.backgroundMode = record.backgroundMode;
  if (isFiniteNumber(record.backgroundStrength)) next.backgroundStrength = clamp(record.backgroundStrength, APPEARANCE_NUMERIC_BOUNDS.backgroundStrength);
  if (isEnumValue(record.lightingMode, APPEARANCE_ENUMS.lightingMode)) next.lightingMode = record.lightingMode;
  if (isFiniteNumber(record.lightingIntensity)) next.lightingIntensity = clamp(record.lightingIntensity, APPEARANCE_NUMERIC_BOUNDS.lightingIntensity);
  if (isFiniteNumber(record.lightingAzimuth)) next.lightingAzimuth = clamp(record.lightingAzimuth, APPEARANCE_NUMERIC_BOUNDS.lightingAzimuth);
  if (isFiniteNumber(record.lightingElevation)) next.lightingElevation = clamp(record.lightingElevation, APPEARANCE_NUMERIC_BOUNDS.lightingElevation);
  if (isEnumValue(record.lightingSpace, APPEARANCE_ENUMS.lightingSpace)) next.lightingSpace = record.lightingSpace;
  if (isEnumValue(record.dimensionOrigin, APPEARANCE_ENUMS.dimensionOrigin)) next.dimensionOrigin = record.dimensionOrigin;
  if (isFiniteNumber(record.gridOpacity)) next.gridOpacity = clamp(record.gridOpacity, APPEARANCE_NUMERIC_BOUNDS.gridOpacity);
  if (isFiniteNumber(record.aoIntensity)) next.aoIntensity = clamp(record.aoIntensity, APPEARANCE_NUMERIC_BOUNDS.aoIntensity);
  if (isFiniteNumber(record.aoRadius)) next.aoRadius = clamp(record.aoRadius, APPEARANCE_NUMERIC_BOUNDS.aoRadius);
  if (isEnumValue(record.exportBackground, APPEARANCE_ENUMS.exportBackground)) next.exportBackground = record.exportBackground;
  if (typeof record.exportAnnotations === "boolean") next.exportAnnotations = record.exportAnnotations;

  return next;
}

export type Viewport3DSavedVisualProfileId =
  | "interactive-lite"
  | "interactive"
  | "balanced"
  | "figure";

export interface Viewport3DPersistedWidgetPreferences {
  dimensionFrameMode: "off" | "floor" | "cage";
  dimensionFrameDensity: "auto" | "coarse" | "fine";
  dimensionFrameAnnotation: "ticks" | "extents" | "both";
  scaleUnitMode: "auto" | "nm" | "um" | "mm" | "m";
  scaleLabelsVisible: boolean;
  viewCubeVisible: boolean;
  hslReferenceMode: "auto" | "off" | "on";
  effectAmbientOcclusion: boolean;
  effectBloom: boolean;
  effectAntialias: boolean;
}

export interface Viewport3DPersistedPreferences {
  schemaVersion: 1;
  appearance: Viewport3DAppearancePreferences;
  widgets: Viewport3DPersistedWidgetPreferences;
  visualProfileId: Viewport3DSavedVisualProfileId;
}

export const DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES = Object.freeze({
  dimensionFrameMode: "floor",
  dimensionFrameDensity: "auto",
  dimensionFrameAnnotation: "ticks",
  scaleUnitMode: "auto",
  scaleLabelsVisible: true,
  viewCubeVisible: true,
  hslReferenceMode: "auto",
  effectAmbientOcclusion: false,
  effectBloom: false,
  effectAntialias: true,
} satisfies Viewport3DPersistedWidgetPreferences);

export const VIEWPORT_3D_APPEARANCE_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const VIEWPORT_3D_APPEARANCE_PREFERENCES_STORAGE_KEY =
  "fullmag.control-room.viewport-3d.appearance-preferences";

export interface Viewport3DPersistedPreferencesSource {
  appearance: unknown;
  captureReturnProfileId: string | null;
  visualProfileId: string;
  widgets: unknown;
}

export function buildViewport3DPersistedPreferences(
  source: Viewport3DPersistedPreferencesSource,
): Viewport3DPersistedPreferences | null {
  const visualProfileId =
    source.visualProfileId === "capture"
      ? source.captureReturnProfileId
      : source.visualProfileId;
  if (!isSavedVisualProfileId(visualProfileId)) return null;

  return {
    schemaVersion: VIEWPORT_3D_APPEARANCE_PREFERENCES_SCHEMA_VERSION,
    appearance: normalizeViewport3DAppearancePreferences(source.appearance),
    widgets: normalizePersistedWidgetPreferences(source.widgets),
    visualProfileId,
  };
}

export function parseViewport3DPersistedPreferences(
  serialized: string | null,
): Viewport3DPersistedPreferences | null {
  if (serialized === null) return null;
  try {
    const record = asRecord(JSON.parse(serialized));
    if (record.schemaVersion !== VIEWPORT_3D_APPEARANCE_PREFERENCES_SCHEMA_VERSION) {
      return null;
    }
    const visualProfileId = isSavedVisualProfileId(record.visualProfileId)
      ? record.visualProfileId
      : DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID;
    return {
      schemaVersion: VIEWPORT_3D_APPEARANCE_PREFERENCES_SCHEMA_VERSION,
      appearance: normalizeViewport3DAppearancePreferences(record.appearance),
      widgets: normalizePersistedWidgetPreferences(record.widgets),
      visualProfileId,
    };
  } catch {
    return null;
  }
}

export function serializeViewport3DPersistedPreferences(
  preferences: Viewport3DPersistedPreferences,
): string {
  return JSON.stringify({
    schemaVersion: VIEWPORT_3D_APPEARANCE_PREFERENCES_SCHEMA_VERSION,
    appearance: preferences.appearance,
    widgets: preferences.widgets,
    visualProfileId: preferences.visualProfileId,
  });
}

function normalizePersistedWidgetPreferences(
  value: unknown,
): Viewport3DPersistedWidgetPreferences {
  const record = asRecord(value);
  const defaults = DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES;
  return {
    dimensionFrameMode: enumValue(record.dimensionFrameMode, ["off", "floor", "cage"], defaults.dimensionFrameMode),
    dimensionFrameDensity: enumValue(record.dimensionFrameDensity, ["auto", "coarse", "fine"], defaults.dimensionFrameDensity),
    dimensionFrameAnnotation: enumValue(record.dimensionFrameAnnotation, ["ticks", "extents", "both"], defaults.dimensionFrameAnnotation),
    scaleUnitMode: enumValue(record.scaleUnitMode, ["auto", "nm", "um", "mm", "m"], defaults.scaleUnitMode),
    scaleLabelsVisible: booleanValue(record.scaleLabelsVisible, defaults.scaleLabelsVisible),
    viewCubeVisible: booleanValue(record.viewCubeVisible, defaults.viewCubeVisible),
    hslReferenceMode: enumValue(record.hslReferenceMode, ["auto", "off", "on"], defaults.hslReferenceMode),
    effectAmbientOcclusion: booleanValue(record.effectAmbientOcclusion, defaults.effectAmbientOcclusion),
    effectBloom: booleanValue(record.effectBloom, defaults.effectBloom),
    effectAntialias: booleanValue(record.effectAntialias, defaults.effectAntialias),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numericValue(
  value: unknown,
  bounds: readonly [number, number],
  fallback: number,
): number {
  return isFiniteNumber(value) ? clamp(value, bounds) : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number],
): T[number] {
  return isEnumValue(value, values) ? value : fallback;
}

function isEnumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function clamp(value: number, bounds: readonly [number, number]): number {
  return Math.min(bounds[1], Math.max(bounds[0], value));
}

function isSavedVisualProfileId(
  value: unknown,
): value is Viewport3DSavedVisualProfileId {
  return value === "interactive-lite" || value === "interactive" ||
    value === "balanced" || value === "figure";
}

const DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID: Viewport3DSavedVisualProfileId =
  "interactive";
