import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "../api/apiTypes";
import {
  isScalarSpatialQuantityId,
  normalizeQuantityIdOrDefault,
  resolveCanonicalQuantityId,
} from "../api/quantityIds";
import {
  canonicalVisualizationSceneObjectId,
  visualizationPartScopeIdFromTargetId,
  visualizationTargetIdForSceneObject,
  type Selection,
} from "../selection/selectionTypes";
import {
  canonicalVisualizationTargetId as canonicalPublicVisualizationTargetId,
  FDM_OUTSIDE_SUPPORT_CARRIER_ID,
} from "./visualizationTargetIdentity";

export type VisualizationTargetKind =
  | "airbox"
  | "fdm-domain"
  | "fdm-native-layer"
  | "object"
  | "part"
  | "region";
export type VisualizationRenderMode =
  | "off"
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
export type SurfaceFieldProjectionMode =
  | "raw_nodal"
  | "surface_faces"
  | "thickness_average_z";

export interface VisualizationTargetRef {
  id: string;
  kind: VisualizationTargetKind;
  label?: string | null;
}

export interface VisualizationTargetSettings {
  activeQuantityId: string;
  airboxSyntheticVectorsEnabled: boolean;
  boundsOpacityPercent: number;
  boundsVisible: boolean;
  geometryScope: VisualizationGeometryScope;
  surfaceOpacityPercent: number;
  pointColor: string;
  pointOpacityPercent: number;
  pointsVisible: boolean;
  primitiveMonoColor?: string;
  primitiveOpacityPercent?: number;
  primitiveVisible?: boolean;
  renderMode: VisualizationRenderMode;
  scalarColorPalette: string;
  shaderColorMode: VisualizationColorMode;
  shaderMonoColor: string;
  shaderVisible: boolean;
  surfaceColorSource: SurfaceColorSource;
  surfaceProjectionMode: SurfaceFieldProjectionMode;
  viewportColorbarVisible: boolean;
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
export type VisualizationStoredTargetPatch = Omit<
  VisualizationTargetPatch,
  "renderMode"
>;
/**
 * Client-owned rendering choices. They deliberately live outside the canonical
 * visualization target override contract: a second viewport must not receive
 * them through HTTP/realtime or mistake them for a backend acknowledgement.
 */
export interface ViewportTargetRenderingPreferences {
  airboxSyntheticVectorsEnabled?: boolean;
  primitiveMonoColor?: string;
  primitiveOpacityPercent?: number;
  primitiveVisible?: boolean;
  vectorCenteringEnabled?: boolean;
  vectorSurfaceOffsetEnabled?: boolean;
  vectorSurfaceOffsetScale?: number;
}

export interface ObjectVisualizationSnapshot {
  defaults: Partial<Record<VisualizationTargetKind, VisualizationStoredTargetPatch>>;
  viewportPreferenceDefaults?: Partial<
    Record<VisualizationTargetKind, ViewportTargetRenderingPreferences>
  >;
  viewportPreferences?: Record<string, ViewportTargetRenderingPreferences>;
  overrides: Record<string, VisualizationStoredTargetPatch>;
  pendingOverrides?: Record<string, PendingVisualizationTargetPatch>;
  version: number;
}

export interface PendingVisualizationTargetPatch {
  baseRevision: number;
  patch: VisualizationStoredTargetPatch;
  target: VisualizationTargetRef;
}

export interface ResolvedTargetVisualization {
  baseSettings: VisualizationTargetSettings;
  effectiveSettings: VisualizationTargetSettings;
  override: VisualizationStoredTargetPatch | null;
  revision: string;
  settings: VisualizationTargetSettings;
}

type AirboxVisualizationStateLike = {
  active_quantity_id?: string | null;
  colormap?: string | null;
  layers?: {
    airbox?: VisualizationStateResource["layers"]["airbox"] | null;
  } | null;
  quantity?: {
    active_quantity_id?: string | null;
    colormap?: string | null;
  } | null;
  targets?: VisualizationStateResource["targets"] | null;
};

type ResolvedTargetSettingsResource = NonNullable<
  NonNullable<VisualizationStateResource["targets"]>["airbox"]
>["settings"];

type EffectiveTargetRegistryEntry = NonNullable<
  NonNullable<VisualizationStateResource["targets"]>["airbox"]
>;

type ObjectVisualizationListener = () => void;

export const AIRBOX_VISUALIZATION_TARGET: VisualizationTargetRef = {
  id: "airbox",
  kind: "airbox",
  label: "Airbox",
};

/** @deprecated The outside-support identifier is a carrier, not a target. */
export const FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET = {
  id: "airbox",
  kind: "airbox",
  label: "Airbox",
} as const satisfies VisualizationTargetRef;

export interface VisualizationTargetCapabilities {
  primaryRenderModes: readonly VisualizationRenderMode[];
  showBoundsControl: boolean;
  showGeometryScopeControl: boolean;
  supportsFieldData: boolean;
  supportsPoints: boolean;
  supportsVectors: boolean;
  supportsVectorSurfaceOffset: boolean;
}

const DEFAULT_VISUALIZATION_TARGET_CAPABILITIES: VisualizationTargetCapabilities = {
  primaryRenderModes: ["surface", "surface+edges", "wireframe", "points"],
  showBoundsControl: true,
  showGeometryScopeControl: true,
  supportsFieldData: true,
  supportsPoints: true,
  supportsVectors: true,
  supportsVectorSurfaceOffset: true,
};

const AIRBOX_VISUALIZATION_TARGET_CAPABILITIES: VisualizationTargetCapabilities = {
  primaryRenderModes: ["wireframe", "points"],
  showBoundsControl: true,
  showGeometryScopeControl: false,
  supportsFieldData: true,
  supportsPoints: true,
  supportsVectors: true,
  supportsVectorSurfaceOffset: false,
};

const FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET_CAPABILITIES: VisualizationTargetCapabilities = {
  primaryRenderModes: ["wireframe", "points"],
  showBoundsControl: true,
  showGeometryScopeControl: false,
  supportsFieldData: true,
  supportsPoints: true,
  supportsVectors: true,
  supportsVectorSurfaceOffset: false,
};

export function visualizationTargetCapabilities(
  target: VisualizationTargetRef,
): VisualizationTargetCapabilities {
  if (isFdmUniverseOutsideSupportTarget(target)) {
    return FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET_CAPABILITIES;
  }
  return target.kind === "airbox"
    ? AIRBOX_VISUALIZATION_TARGET_CAPABILITIES
    : DEFAULT_VISUALIZATION_TARGET_CAPABILITIES;
}

export function isFdmUniverseOutsideSupportTarget(
  target: VisualizationTargetRef,
): boolean {
  return (
    target.kind === "fdm-domain" &&
    target.id === FDM_OUTSIDE_SUPPORT_CARRIER_ID
  );
}

const FDM_UNIVERSE_OUTSIDE_SUPPORT_PATCH_FIELDS = new Set<
  keyof VisualizationTargetPatch
>([
  "activeQuantityId",
  "boundsOpacityPercent",
  "boundsVisible",
  "pointColor",
  "pointOpacityPercent",
  "pointsVisible",
  "renderMode",
  "vectorAlphaPercent",
  "vectorBudget",
  "vectorCenteringEnabled",
  "vectorColorMode",
  "vectorLengthScale",
  "vectorMonoColor",
  "vectorThickness",
  "vectorsVisible",
  "visible",
  "wireframeColor",
  "wireframeOpacityPercent",
  "wireframeVisible",
]);

export function visualizationTargetUnsupportedPatchFields(
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): Array<keyof VisualizationTargetPatch> {
  const isAirboxTarget =
    target.kind === "airbox" || isFdmUniverseOutsideSupportTarget(target);
  if (!isAirboxTarget) return [];
  const unsupportedAirboxFields = new Set<keyof VisualizationTargetPatch>([
    "shaderColorMode",
    "shaderMonoColor",
    "shaderVisible",
    "surfaceColorSource",
    "surfaceOpacityPercent",
    "surfaceProjectionMode",
    "viewportColorbarVisible",
  ]);
  if (target.kind === "airbox") {
    const unsupported = (Object.keys(patch) as Array<keyof VisualizationTargetPatch>).filter(
      (field) => patch[field] !== undefined && unsupportedAirboxFields.has(field),
    );
    if (
      patch.renderMode !== undefined &&
      patch.renderMode !== "off" &&
      patch.renderMode !== "wireframe" &&
      patch.renderMode !== "points"
    ) {
      unsupported.push("renderMode");
    }
    return [...new Set(unsupported)];
  }
  const unsupported = (Object.keys(patch) as Array<keyof VisualizationTargetPatch>).filter(
    (field) =>
      patch[field] !== undefined &&
      !FDM_UNIVERSE_OUTSIDE_SUPPORT_PATCH_FIELDS.has(field),
  );
  if (
    patch.renderMode !== undefined &&
    patch.renderMode !== "off" &&
    patch.renderMode !== "wireframe"
  ) {
    unsupported.push("renderMode");
  }
  return [...new Set(unsupported)];
}

export function visualizationTargetSupportedPatch(
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  if (target.kind === "airbox") {
    const supported = Object.fromEntries(
      Object.entries(patch).filter(
        ([field, value]) =>
          value !== undefined &&
          ![
            "shaderColorMode",
            "shaderMonoColor",
            "shaderVisible",
            "surfaceColorSource",
            "surfaceOpacityPercent",
            "surfaceProjectionMode",
            "viewportColorbarVisible",
          ].includes(field),
      ),
    ) as VisualizationTargetPatch;
    if (supported.renderMode !== undefined) {
      const renderMode = supported.renderMode;
      delete supported.renderMode;
      supported.wireframeVisible = renderMode === "wireframe";
      supported.pointsVisible = renderMode === "points";
    }
    return supported;
  }
  if (!isFdmUniverseOutsideSupportTarget(target)) return patch;
  const supported = Object.fromEntries(
    Object.entries(patch).filter(
      ([field, value]) =>
        value !== undefined &&
        FDM_UNIVERSE_OUTSIDE_SUPPORT_PATCH_FIELDS.has(
          field as keyof VisualizationTargetPatch,
        ),
    ),
  ) as VisualizationTargetPatch;
  if (
    supported.renderMode !== undefined &&
    supported.renderMode !== "off" &&
    supported.renderMode !== "wireframe" &&
    supported.renderMode !== "points"
  ) {
    supported.renderMode = "wireframe";
  }
  if (supported.renderMode !== undefined) {
    const renderMode = supported.renderMode;
    delete supported.renderMode;
    supported.wireframeVisible = renderMode === "wireframe";
    supported.pointsVisible = renderMode === "points";
  }
  return supported;
}

export const DEFAULT_OBJECT_VISUALIZATION: VisualizationTargetSettings = {
  activeQuantityId: "m",
  airboxSyntheticVectorsEnabled: false,
  boundsOpacityPercent: 100,
  boundsVisible: false,
  geometryScope: "surface",
  surfaceOpacityPercent: 100,
  pointColor: "var(--fm-border-strong)",
  pointOpacityPercent: 100,
  pointsVisible: false,
  primitiveMonoColor: "var(--fm-surface-magnetic)",
  primitiveOpacityPercent: 100,
  primitiveVisible: false,
  renderMode: "surface",
  scalarColorPalette: "viridis",
  shaderColorMode: "orientation",
  shaderMonoColor: "var(--fm-surface-magnetic)",
  shaderVisible: true,
  surfaceColorSource: "orientation",
  surfaceProjectionMode: "raw_nodal",
  viewportColorbarVisible: false,
  vectorAlphaPercent: 100,
  vectorBudget: 1200,
  vectorCenteringEnabled: true,
  vectorColorMode: "orientation",
  vectorLengthScale: 1,
  vectorMonoColor: "var(--fm-accent)",
  vectorSurfaceOffsetEnabled: false,
  vectorSurfaceOffsetScale: 0,
  vectorThickness: 1,
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-border-strong)",
  wireframeOpacityPercent: 100,
  wireframeVisible: false,
};

export const DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION: VisualizationTargetSettings = {
  ...DEFAULT_OBJECT_VISUALIZATION,
  activeQuantityId: "H_demag",
  boundsOpacityPercent: 55,
  boundsVisible: true,
  geometryScope: "full",
  pointColor: "var(--fm-info)",
  renderMode: "wireframe",
  shaderColorMode: "monochrome",
  shaderVisible: false,
  surfaceColorSource: "solid",
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-info)",
  wireframeOpacityPercent: 55,
  wireframeVisible: true,
};

/**
 * Native multilayer carriers keep their geometry and field identity in the
 * FDM layout resource, while their display settings use the session-scoped
 * visualization override contract like FEM targets.
 */
export const FDM_NATIVE_LAYER_TARGET_PREFIX = "fdm-native-layer:";

export function targetForFdmNativeLayer(
  layerId: string,
  label?: string | null,
): VisualizationTargetRef {
  return {
    id: `${FDM_NATIVE_LAYER_TARGET_PREFIX}${encodeURIComponent(layerId)}`,
    kind: "fdm-native-layer",
    label: label ?? layerId,
  };
}

export function isFdmNativeLayerTarget(
  target: VisualizationTargetRef,
): boolean {
  return (
    target.kind === "fdm-native-layer" &&
    target.id.startsWith(FDM_NATIVE_LAYER_TARGET_PREFIX)
  );
}

function normalizeFdmUniverseOutsideSupportVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const wireframeVisible = settings.wireframeVisible || settings.shaderVisible;
  const pointsVisible = settings.pointsVisible;
  return normalizeVisualizationSettings({
    ...DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION,
    activeQuantityId: settings.activeQuantityId,
    boundsOpacityPercent: settings.boundsOpacityPercent,
    boundsVisible: settings.boundsVisible,
    pointColor: settings.pointColor,
    pointOpacityPercent: settings.pointOpacityPercent,
    pointsVisible,
    renderMode: pointsVisible ? "points" : wireframeVisible ? "wireframe" : "off",
    visible: settings.visible,
    vectorAlphaPercent: settings.vectorAlphaPercent,
    vectorBudget: settings.vectorBudget,
    vectorCenteringEnabled: settings.vectorCenteringEnabled,
    vectorColorMode: settings.vectorColorMode,
    vectorLengthScale: settings.vectorLengthScale,
    vectorMonoColor: settings.vectorMonoColor,
    vectorThickness: settings.vectorThickness,
    vectorsVisible: settings.vectorsVisible,
    wireframeColor: settings.wireframeColor,
    wireframeOpacityPercent: settings.wireframeOpacityPercent,
    wireframeVisible,
  });
}

/**
 * The FDM domain target is the magnetic structured-grid view. Before the
 * membership artifact is available it must remain an outline, never a
 * filled shader over every authored universe cell.
 */
export const DEFAULT_FDM_DOMAIN_VISUALIZATION: VisualizationTargetSettings = {
  ...DEFAULT_OBJECT_VISUALIZATION,
  boundsVisible: false,
  geometryScope: "full",
  renderMode: "wireframe",
  shaderVisible: false,
  surfaceColorSource: "solid",
  wireframeVisible: true,
};

/**
 * A structured-grid descriptor is not a magnetic mask. Until the canonical
 * FMRM membership is current, keep viewport rendering fail-closed: outline
 * the authored grid, but never paint every universe cell as a magnetic field.
 */
export function resolveFdmViewportVisualizationSettings(
  settings: VisualizationTargetSettings,
  membershipReady: boolean,
): VisualizationTargetSettings {
  if (membershipReady) return settings;
  return {
    ...settings,
    renderMode: "wireframe",
    shaderVisible: false,
    surfaceColorSource: "solid",
    vectorsVisible: false,
  };
}

export const DEFAULT_REGION_VISUALIZATION: VisualizationTargetSettings = {
  ...DEFAULT_OBJECT_VISUALIZATION,
  boundsVisible: false,
  pointsVisible: false,
  primitiveVisible: false,
  renderMode: "surface",
  shaderVisible: false,
  vectorsVisible: false,
  visible: false,
  wireframeVisible: false,
};

export const DEFAULT_AIRBOX_VISUALIZATION: VisualizationTargetSettings = {
  activeQuantityId: "H_demag",
  airboxSyntheticVectorsEnabled: false,
  boundsOpacityPercent: 100,
  boundsVisible: false,
  geometryScope: "full",
  surfaceOpacityPercent: 28,
  pointColor: "var(--fm-info)",
  pointOpacityPercent: 100,
  pointsVisible: false,
  primitiveVisible: false,
  renderMode: "off",
  scalarColorPalette: "viridis",
  shaderColorMode: "monochrome",
  shaderMonoColor: "var(--fm-airbox-fill)",
  shaderVisible: false,
  surfaceColorSource: "solid",
  surfaceProjectionMode: "raw_nodal",
  viewportColorbarVisible: false,
  vectorAlphaPercent: 100,
  vectorBudget: 1200,
  vectorCenteringEnabled: true,
  vectorColorMode: "orientation",
  vectorLengthScale: 1,
  vectorMonoColor: "var(--fm-info)",
  vectorSurfaceOffsetEnabled: false,
  vectorSurfaceOffsetScale: 0,
  vectorThickness: 1,
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-airbox-wire)",
  wireframeOpacityPercent: 100,
  wireframeVisible: false,
};

const DEFAULT_PART_VISUALIZATION: VisualizationTargetSettings = {
  ...DEFAULT_OBJECT_VISUALIZATION,
  primitiveVisible: false,
  renderMode: "surface",
  wireframeVisible: false,
};


export class ObjectVisualizationController {
  private readonly defaults = new Map<
    VisualizationTargetKind,
    VisualizationStoredTargetPatch
  >();
  private readonly listeners = new Set<ObjectVisualizationListener>();
  private readonly viewportPreferenceDefaults = new Map<
    VisualizationTargetKind,
    ViewportTargetRenderingPreferences
  >();
  private readonly viewportPreferences = new Map<
    string,
    ViewportTargetRenderingPreferences
  >();
  private readonly overrides = new Map<string, VisualizationStoredTargetPatch>();
  private readonly pendingOverrides = new Map<
    string,
    PendingVisualizationTargetPatch
  >();
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
    const key = visualizationTargetKey(target);
    const clearedViewportPreference = this.viewportPreferences.delete(key);
    const clearedOverride = this.overrides.delete(key);
    const clearedPendingOverride = this.pendingOverrides.delete(key);
    if (!clearedViewportPreference && !clearedOverride && !clearedPendingOverride) {
      return;
    }

    this.bump();
  }

  clearPendingTarget(target: VisualizationTargetRef): void {
    if (!this.pendingOverrides.delete(visualizationTargetKey(target))) return;
    this.bump();
  }

  removeTargetOverrideField(
    target: VisualizationTargetRef,
    field: keyof VisualizationTargetPatch,
  ): void {
    const key = visualizationTargetKey(target);
    const override = this.overrides.get(key);
    const pending = this.pendingOverrides.get(key);
    const nextOverride = override
      ? removeStoredTargetPatchField(override, field)
      : undefined;
    const nextPendingPatch = pending
      ? removeStoredTargetPatchField(pending.patch, field)
      : undefined;
    const changed =
      (override !== undefined && !samePatch(override, nextOverride ?? {})) ||
      (pending !== undefined && !samePatch(pending.patch, nextPendingPatch ?? {}));
    if (!changed) return;

    if (nextOverride && Object.keys(nextOverride).length > 0) {
      this.overrides.set(key, nextOverride);
    } else {
      this.overrides.delete(key);
    }
    if (pending && nextPendingPatch && Object.keys(nextPendingPatch).length > 0) {
      this.pendingOverrides.set(key, { ...pending, patch: nextPendingPatch });
    } else if (pending) {
      this.pendingOverrides.delete(key);
    }
    this.bump();
  }

  removeAllTargetOverrideFields(field: keyof VisualizationTargetPatch): void {
    let changed = false;
    for (const [key, override] of this.overrides) {
      const next = removeStoredTargetPatchField(override, field);
      if (samePatch(override, next ?? {})) continue;
      changed = true;
      if (next && Object.keys(next).length > 0) this.overrides.set(key, next);
      else this.overrides.delete(key);
    }
    for (const [key, pending] of this.pendingOverrides) {
      const next = removeStoredTargetPatchField(pending.patch, field);
      if (samePatch(pending.patch, next ?? {})) continue;
      changed = true;
      if (next && Object.keys(next).length > 0) {
        this.pendingOverrides.set(key, { ...pending, patch: next });
      } else {
        this.pendingOverrides.delete(key);
      }
    }
    if (changed) this.bump();
  }

  getDefaultSettings(
    kind: VisualizationTargetKind,
    baseSettings?: VisualizationTargetSettings,
  ): VisualizationTargetSettings {
    return normalizeVisualizationSettings({
      ...resolveDefaultVisualizationSettings(this.snapshot, kind, baseSettings),
      ...(this.snapshot.viewportPreferenceDefaults?.[kind] ?? {}),
    });
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
      ...visualizationTargetSupportedPatch(target, patch),
    });

    if (samePatch(current, next)) {
      return;
    }

    this.overrides.set(key, next);
    this.bump();
  }

  patchTargetPending(
    target: VisualizationTargetRef,
    patch: VisualizationTargetPatch,
    baseRevision: number,
  ): void {
    const key = visualizationTargetKey(target);
    const current = this.pendingOverrides.get(key);
    const nextPatch = normalizePatch({
      ...(current?.patch ?? {}),
      ...visualizationTargetSupportedPatch(target, patch),
    });
    // Pending acknowledgements compare against the serialized target
    // override. `shaderColorMode` is a normalized UI alias; the backend stores
    // the canonical `surfaceColorSource` instead. `renderMode` was already
    // lowered to pass flags by normalizePatch above.
    delete nextPatch.shaderColorMode;
    const next: PendingVisualizationTargetPatch = {
      baseRevision,
      patch: nextPatch,
      target,
    };

    if (
      current &&
      current.baseRevision === next.baseRevision &&
      samePatch(current.patch, next.patch)
    ) {
      return;
    }

    this.pendingOverrides.set(key, next);
    this.bump();
  }

  acknowledgePendingTargetPatches(state: VisualizationStateResource): void {
    let changed = false;
    for (const [key, pending] of this.pendingOverrides) {
      const persistedOverride = resolveVisualizationStateTargetOverride(
        state,
        pending.target,
      );
      if (
        state.revision > pending.baseRevision &&
        persistedOverride &&
        visualizationTargetPatchSatisfiesPatch(persistedOverride, pending.patch)
      ) {
        const committedOverride = {
          ...(this.overrides.get(key) ?? {}),
          ...persistedOverride,
        };
        this.overrides.set(key, committedOverride);
        this.pendingOverrides.delete(key);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  rejectPendingTargetPatches(targetIds: readonly string[]): void {
    if (targetIds.length === 0 || this.pendingOverrides.size === 0) return;

    const rejected = new Set(targetIds);
    let changed = false;
    for (const [key] of this.pendingOverrides) {
      if (!rejected.has(key)) continue;
      this.pendingOverrides.delete(key);
      changed = true;
    }
    if (changed) this.bump();
  }

  patchViewportPreferences(
    target: VisualizationTargetRef,
    patch: ViewportTargetRenderingPreferences,
  ): void {
    const key = visualizationTargetKey(target);
    const current = this.viewportPreferences.get(key) ?? {};
    const next = normalizeViewportTargetRenderingPreferences({
      ...current,
      ...patch,
    });
    if (samePatch(current, next)) return;

    this.viewportPreferences.set(key, next);
    this.bump();
  }

  patchViewportPreferenceDefaults(
    kind: VisualizationTargetKind,
    patch: ViewportTargetRenderingPreferences,
  ): void {
    const current = this.viewportPreferenceDefaults.get(kind) ?? {};
    const next = normalizeViewportTargetRenderingPreferences({
      ...current,
      ...patch,
    });
    if (samePatch(current, next)) return;

    this.viewportPreferenceDefaults.set(kind, next);
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
      viewportPreferenceDefaults: Object.fromEntries(this.viewportPreferenceDefaults),
      viewportPreferences: Object.fromEntries(this.viewportPreferences),
      overrides: Object.fromEntries(this.overrides),
      pendingOverrides: Object.fromEntries(this.pendingOverrides),
      version: this.snapshot.version + 1,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function defaultVisualizationSettings(
  kind: VisualizationTargetKind,
  targetId?: string,
): VisualizationTargetSettings {
  if (kind === "airbox") return DEFAULT_AIRBOX_VISUALIZATION;
  if (kind === "fdm-domain" || kind === "fdm-native-layer") {
    return targetId === FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
      ? DEFAULT_FDM_UNIVERSE_OUTSIDE_SUPPORT_VISUALIZATION
      : DEFAULT_FDM_DOMAIN_VISUALIZATION;
  }
  if (kind === "part") return DEFAULT_PART_VISUALIZATION;
  if (kind === "region") return DEFAULT_REGION_VISUALIZATION;
  return DEFAULT_OBJECT_VISUALIZATION;
}

export function displayLabelForVisualizationTarget(
  target: VisualizationTargetRef,
): string {
  return target.label ?? (target.kind === "airbox" ? "Airbox" : target.id);
}

export function renderModePatch(
  renderMode: VisualizationRenderMode | "off",
): VisualizationTargetPatch {
  if (renderMode === "off") {
    return {
      pointsVisible: false,
      shaderVisible: false,
      wireframeVisible: false,
    };
  }
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
  baseSettings?: VisualizationTargetPatch,
): VisualizationTargetSettings {
  const targetKey = visualizationTargetKey(target);
  const settings = normalizeVisualizationSettings({
    ...resolveDefaultVisualizationSettings(
      snapshot,
      target.kind,
      baseSettings,
      target.id,
    ),
    ...(snapshot.overrides[targetKey] ?? {}),
    ...(snapshot.pendingOverrides?.[targetKey]?.patch ?? {}),
  });
  if (isFdmUniverseOutsideSupportTarget(target)) {
    return normalizeFdmUniverseOutsideSupportVisualizationSettings(settings);
  }
  return target.kind === "airbox"
    ? normalizeAirboxVisualizationSettings(settings)
    : settings;
}

function normalizeAirboxVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const wireframeVisible = settings.wireframeVisible;
  const pointsVisible = settings.pointsVisible;
  return normalizeVisualizationSettings({
    ...DEFAULT_AIRBOX_VISUALIZATION,
    ...settings,
    activeQuantityId: settings.activeQuantityId,
    pointsVisible,
    renderMode: pointsVisible ? "points" : wireframeVisible ? "wireframe" : "off",
    shaderVisible: false,
    surfaceColorSource: "solid",
    viewportColorbarVisible: false,
    wireframeVisible,
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

/**
 * Region visualization is a sparse override of its owner's effective state.
 * Keeping the inherited baseline complete makes every non-overridden setting
 * follow later owner changes instead of materializing a copied region state.
 */
export function resolveRegionInheritedBaseline(
  ownerSettings: VisualizationTargetSettings,
): VisualizationTargetPatch {
  return { ...ownerSettings };
}

export function resolveDefaultVisualizationSettings(
  snapshot: ObjectVisualizationSnapshot,
  kind: VisualizationTargetKind,
  baseSettings?: VisualizationTargetPatch,
  targetId?: string,
): VisualizationTargetSettings {
  if (kind === "region") {
    return normalizeVisualizationSettings({
      ...DEFAULT_OBJECT_VISUALIZATION,
      ...DEFAULT_REGION_VISUALIZATION,
      ...(baseSettings ?? {}),
      ...(snapshot.defaults[kind] ?? {}),
    });
  }
  return normalizeVisualizationSettings({
    ...defaultVisualizationSettings(kind, targetId),
    ...(baseSettings ?? {}),
    ...(kind === "fdm-domain" &&
    targetId === FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
      ? {}
      : (snapshot.defaults[kind] ?? {})),
  });
}

export function resolveTargetVisualization({
  inheritedSettings,
  snapshot,
  target,
  visualizationState,
}: {
  inheritedSettings?: VisualizationTargetSettings;
  snapshot: ObjectVisualizationSnapshot;
  target: VisualizationTargetRef;
  visualizationState?: VisualizationStateResource | null;
}): ResolvedTargetVisualization {
  const registryEntry = resolveEffectiveTargetRegistryEntry(
    visualizationState,
    target,
  );
  const resolvedBaseSettings =
    (registryEntry
      ? visualizationSettingsFromResolvedTarget(
          registryEntry.settings,
          defaultVisualizationSettings(target.kind, target.id),
        )
      : null) ??
      resolveVisualizationBaseSettings(target.kind, target.id, visualizationState);
  const baseSettings =
    target.kind === "airbox"
      ? {
          ...resolvedBaseSettings,
          activeQuantityId: resolvedBaseSettings.activeQuantityId,
        }
      : resolvedBaseSettings;
  const targetKey = visualizationTargetKey(target);
  const storedOverride =
    snapshot.overrides[targetKey] ??
    (targetKey === "airbox"
      ? snapshot.overrides[FDM_OUTSIDE_SUPPORT_CARRIER_ID]
      : undefined);
  const pendingOverride = resolvePendingTargetPatch(snapshot, target);
  const localOverride = registryEntry
    ? pendingOverride
    : pendingOverride || storedOverride
      ? {
          ...(storedOverride ?? {}),
          ...(pendingOverride ?? {}),
        }
      : null;
  const viewportPreferences = snapshot.viewportPreferences?.[
    visualizationTargetKey(target)
  ] ?? null;
  const viewportPreferenceDefaults =
    snapshot.viewportPreferenceDefaults?.[target.kind] ?? null;
  const backendOverride = resolveVisualizationStateTargetOverride(
    visualizationState,
    target,
  );
  const inheritedDefaultSettings =
    target.kind === "region"
      ? inheritedSettings
        ? resolveRegionInheritedBaseline(inheritedSettings)
        : undefined
      : inheritedSettings ?? baseSettings;
  const normalizedSettings = normalizeVisualizationSettings({
    ...(registryEntry
      ? baseSettings
      : resolveDefaultVisualizationSettings(
          snapshot,
          target.kind,
          inheritedDefaultSettings,
          target.id,
        )),
    ...(registryEntry ? {} : (backendOverride ?? {})),
    ...(localOverride ?? {}),
    ...(viewportPreferenceDefaults ?? {}),
    ...(viewportPreferences ?? {}),
  });
  const settings = isFdmUniverseOutsideSupportTarget(target)
    ? normalizeFdmUniverseOutsideSupportVisualizationSettings(normalizedSettings)
    : normalizedSettings;

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

function resolvePendingTargetPatch(
  snapshot: ObjectVisualizationSnapshot,
  target: VisualizationTargetRef,
): VisualizationStoredTargetPatch | null {
  const pending = snapshot.pendingOverrides?.[visualizationTargetKey(target)];
  return pending?.patch ?? null;
}

function visualizationTargetPatchSatisfiesPatch(
  statePatch: VisualizationStoredTargetPatch,
  expectedPatch: VisualizationStoredTargetPatch,
): boolean {
  return Object.entries(expectedPatch).every(([field, expected]) =>
    Object.is(
      statePatch[field as keyof VisualizationStoredTargetPatch],
      expected,
    ),
  );
}

export function resolveEffectiveTargetRegistryEntry(
  state: VisualizationStateResource | null | undefined,
  target: VisualizationTargetRef,
): EffectiveTargetRegistryEntry | null {
  const registry = state?.targets;
  if (
    !registry ||
    target.kind === "region" ||
    target.kind === "fdm-domain" ||
    target.kind === "fdm-native-layer"
  ) {
    return null;
  }

  const entries: readonly EffectiveTargetRegistryEntry[] =
    target.kind === "airbox"
      ? [registry.airbox]
      : target.kind === "object"
        ? registry.objects
        : registry.parts;
  const scopeId = visualizationStateScopeIdForTarget(target);

  return (
    entries.find(
      (entry) => entry.scope === target.kind && entry.scope_id === scopeId,
    ) ?? null
  );
}

function resolveVisualizationStateTargetOverride(
  state: VisualizationStateResource | null | undefined,
  target: VisualizationTargetRef,
): VisualizationStoredTargetPatch | null {
  const override = state?.overrides?.find((entry) =>
    visualizationStateOverrideMatchesTarget(entry, target),
  );
  if (!override) return null;
  const display = override.display ?? null;
  const style = override.style ?? null;
  const visible = display?.visible ?? override.visible;
  const surfaceOpacity = display?.surface?.opacity ?? display?.opacity;
  const patch: VisualizationStoredTargetPatch = {
    ...(display?.geometry_scope === undefined || display.geometry_scope === null
      ? {}
      : { geometryScope: display.geometry_scope }),
    ...(surfaceOpacity === undefined || surfaceOpacity === null
      ? {}
      : {
          surfaceOpacityPercent: layerOpacityToPercent(surfaceOpacity),
        }),
    ...(display?.bounds?.visible === undefined || display.bounds.visible === null
      ? {}
      : { boundsVisible: display.bounds.visible }),
    ...(display?.bounds?.opacity === undefined || display.bounds.opacity === null
      ? {}
      : { boundsOpacityPercent: layerOpacityToPercent(display.bounds.opacity) }),
    ...(display?.points?.visible === undefined ||
    display.points.visible === null
      ? {}
      : { pointsVisible: display.points.visible }),
    ...(display?.points?.opacity === undefined || display.points.opacity === null
      ? {}
      : { pointOpacityPercent: layerOpacityToPercent(display.points.opacity) }),
    ...(style?.point_color === undefined || style.point_color === null
      ? {}
      : { pointColor: style.point_color }),
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
    ...(style?.surface_projection_mode === undefined ||
    style.surface_projection_mode === null
      ? {}
      : { surfaceProjectionMode: style.surface_projection_mode }),
    ...(style?.surface_mono_color === undefined ||
    style.surface_mono_color === null
      ? {}
      : { shaderMonoColor: style.surface_mono_color }),
    ...(style?.viewport_colorbar_visible === undefined ||
    style.viewport_colorbar_visible === null
      ? {}
      : { viewportColorbarVisible: style.viewport_colorbar_visible }),
    ...(style?.scalar_color_palette === undefined ||
    style.scalar_color_palette === null
      ? {}
      : { scalarColorPalette: style.scalar_color_palette }),
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
    ...(override.quantity?.active_quantity_id === undefined ||
    override.quantity.active_quantity_id === null
      ? {}
      : {
          activeQuantityId: normalizeQuantityIdOrDefault(
            override.quantity.active_quantity_id,
          ),
        }),
  };

  return Object.keys(patch).length > 0 ? patch : null;
}

export function visualizationStateOverrideFromTargetPatch(
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): VisualizationStateResource["overrides"][number] | null {
  const normalized = normalizePatch(
    visualizationTargetSupportedPatch(target, patch),
  );
  const display = {
    ...(normalized.geometryScope === undefined
      ? {}
      : { geometry_scope: normalized.geometryScope }),
    ...(normalized.boundsVisible === undefined &&
    normalized.boundsOpacityPercent === undefined
      ? {}
      : {
          bounds: {
            ...(normalized.boundsOpacityPercent === undefined
              ? {}
              : { opacity: clampOpacity(normalized.boundsOpacityPercent) / 100 }),
            ...(normalized.boundsVisible === undefined
              ? {}
              : { visible: normalized.boundsVisible }),
          },
        }),
    ...(normalized.pointsVisible === undefined &&
    normalized.pointOpacityPercent === undefined
      ? {}
      : {
          points: {
            ...(normalized.pointOpacityPercent === undefined
              ? {}
              : { opacity: clampOpacity(normalized.pointOpacityPercent) / 100 }),
            ...(normalized.pointsVisible === undefined
              ? {}
              : { visible: normalized.pointsVisible }),
          },
        }),
    ...(normalized.shaderVisible === undefined &&
    normalized.surfaceOpacityPercent === undefined
      ? {}
      : {
          surface: {
            ...(normalized.surfaceOpacityPercent === undefined
              ? {}
              : { opacity: clampOpacity(normalized.surfaceOpacityPercent) / 100 }),
            ...(normalized.shaderVisible === undefined
              ? {}
              : { visible: normalized.shaderVisible }),
          },
        }),
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
    ...(normalized.surfaceProjectionMode === undefined
      ? {}
      : { surface_projection_mode: normalized.surfaceProjectionMode }),
    ...(normalized.pointColor === undefined
      ? {}
      : { point_color: normalized.pointColor }),
    ...(normalized.shaderMonoColor === undefined
      ? {}
      : { surface_mono_color: normalized.shaderMonoColor }),
    ...(normalized.viewportColorbarVisible === undefined
      ? {}
      : { viewport_colorbar_visible: normalized.viewportColorbarVisible }),
    ...(normalized.scalarColorPalette === undefined
      ? {}
      : { scalar_color_palette: normalized.scalarColorPalette }),
    ...(normalized.vectorAlphaPercent === undefined
      ? {}
      : { vector_alpha: clampOpacity(normalized.vectorAlphaPercent) / 100 }),
    ...(normalized.vectorBudget === undefined
      ? {}
      : { vector_budget: Math.max(0, Math.floor(normalized.vectorBudget)) }),
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
  const quantity:
    | NonNullable<VisualizationStateResource["overrides"][number]["quantity"]>
    | undefined =
    normalized.activeQuantityId === undefined
      ? undefined
      : { active_quantity_id: normalized.activeQuantityId };

  return {
    scope: visualizationStateScopeForTarget(target),
    scope_id: visualizationStateScopeIdForTarget(target),
    ...(normalized.visible === undefined ? {} : { visible: normalized.visible }),
    ...(Object.keys(display).length === 0 ? {} : { display }),
    ...(Object.keys(style).length === 0 ? {} : { style }),
    ...(quantity === undefined ? {} : { quantity }),
  };
}

export function visualizationStateScopeIdForTarget(target: VisualizationTargetRef): string {
  if (target.id === FDM_OUTSIDE_SUPPORT_CARRIER_ID) return "airbox";
  if (target.kind === "object" && target.id.startsWith("object:")) {
    return canonicalVisualizationSceneObjectId(
      target.id.slice("object:".length),
    );
  }
  if (target.kind === "part") {
    return visualizationPartScopeIdFromTargetId(target.id);
  }
  return target.id;
}

function visualizationStateScopeForTarget(
  target: VisualizationTargetRef,
): VisualizationStateResource["overrides"][number]["scope"] {
  if (target.id === FDM_OUTSIDE_SUPPORT_CARRIER_ID) return "airbox";
  if (target.kind === "fdm-domain") return "fdm_domain";
  if (target.kind === "fdm-native-layer") return "fdm_native_layer";
  return target.kind;
}

export function mergeVisualizationStateTargetOverride(
  overrides: readonly VisualizationStateResource["overrides"][number][],
  target: VisualizationTargetRef,
  patch: VisualizationTargetPatch,
): VisualizationStateResource["overrides"] {
  const next = visualizationStateOverrideFromTargetPatch(target, patch);
  if (!next) {
    return mergeVisualizationStateTargetOverrides(overrides, []);
  }
  return mergeVisualizationStateTargetOverrides(overrides, [next]);
}

/**
 * Merge serialized target overrides by their `(scope, scope_id)` identity.
 *
 * Target patches are often built from a stale/partial snapshot while another
 * target mutation is still queued.  A plain array merge would replace the
 * whole list and lose that unrelated mutation.  Keep the first occurrence's
 * position stable, merge duplicate entries field-by-field, and append only
 * genuinely new target identities.
 */
export function mergeVisualizationStateTargetOverrides(
  current: readonly VisualizationStateResource["overrides"][number][],
  next: readonly VisualizationStateResource["overrides"][number][],
): VisualizationStateResource["overrides"] {
  const mergedByIdentity = new Map<
    string,
    VisualizationStateResource["overrides"][number]
  >();
  const order: string[] = [];

  for (const entry of [...current, ...next]) {
    const normalized = normalizeVisualizationStateOverride(entry);
    const identity = visualizationStateOverrideIdentity(normalized);
    const existing = mergedByIdentity.get(identity);
    if (existing) {
      mergedByIdentity.set(identity, mergeVisualizationOverride(existing, normalized));
      continue;
    }
    order.push(identity);
    mergedByIdentity.set(identity, normalized);
  }

  return order.flatMap((identity) => {
    const entry = mergedByIdentity.get(identity);
    return entry ? [entry] : [];
  });
}

/**
 * Remove one semantic target setting from the serialized override that owns it.
 * `undefined` cannot express deletion in a PATCH record: it is stripped before
 * serialization and an existing backend value would survive the merge.
 */
export function removeTargetOverrideField(
  overrides: readonly VisualizationStateResource["overrides"][number][],
  target: VisualizationTargetRef,
  field: keyof VisualizationTargetPatch,
): VisualizationStateResource["overrides"] {
  return overrides.flatMap((entry) => {
    if (!visualizationStateOverrideMatchesTarget(entry, target)) {
      return [normalizeVisualizationStateOverride(entry)];
    }
    const next = removeSerializedOverrideField(entry, field);
    return isVisualizationStateOverrideEmpty(next) ? [] : [next];
  });
}

function removeSerializedOverrideField(
  entry: VisualizationStateResource["overrides"][number],
  field: keyof VisualizationTargetPatch,
): VisualizationStateResource["overrides"][number] {
  const display = { ...(entry.display ?? {}) };
  const style = { ...(entry.style ?? {}) };
  let quantity = entry.quantity;
  let visible = entry.visible;

  switch (field) {
    case "activeQuantityId":
      quantity = undefined;
      break;
    case "boundsVisible":
      delete display.bounds;
      break;
    case "geometryScope":
      delete display.geometry_scope;
      break;
    case "surfaceOpacityPercent":
      delete display.opacity;
      if (display.surface) {
        const surface = { ...display.surface };
        delete surface.opacity;
        if (Object.keys(surface).length === 0) delete display.surface;
        else display.surface = surface;
      }
      break;
    case "pointsVisible":
      delete display.points;
      break;
    case "shaderVisible":
      if (display.surface) {
        const surface = { ...display.surface };
        delete surface.visible;
        if (Object.keys(surface).length === 0) delete display.surface;
        else display.surface = surface;
      }
      break;
    case "vectorsVisible":
      delete display.vectors;
      break;
    case "visible":
      delete display.visible;
      visible = undefined;
      break;
    case "wireframeOpacityPercent":
      if (display.wireframe) {
        const wireframe = { ...display.wireframe };
        delete wireframe.opacity;
        if (Object.keys(wireframe).length === 0) delete display.wireframe;
        else display.wireframe = wireframe;
      }
      break;
    case "wireframeVisible":
      if (display.wireframe) {
        const wireframe = { ...display.wireframe };
        delete wireframe.visible;
        if (Object.keys(wireframe).length === 0) delete display.wireframe;
        else display.wireframe = wireframe;
      }
      break;
    case "pointColor":
      delete style.point_color;
      break;
    case "scalarColorPalette":
      delete style.scalar_color_palette;
      break;
    case "shaderColorMode":
    case "surfaceColorSource":
      delete style.surface_color_source;
      break;
    case "shaderMonoColor":
      delete style.surface_mono_color;
      break;
    case "surfaceProjectionMode":
      delete style.surface_projection_mode;
      break;
    case "vectorAlphaPercent":
      delete style.vector_alpha;
      break;
    case "vectorBudget":
      delete style.vector_budget;
      break;
    case "vectorColorMode":
      delete style.vector_color_mode;
      break;
    case "vectorLengthScale":
      delete style.vector_length_scale;
      break;
    case "vectorMonoColor":
      delete style.vector_mono_color;
      break;
    case "vectorThickness":
      delete style.vector_thickness;
      break;
    case "viewportColorbarVisible":
      delete style.viewport_colorbar_visible;
      break;
    // Local-only settings are never serialized in a target override.
    case "airboxSyntheticVectorsEnabled":
    case "primitiveVisible":
    case "renderMode":
    case "vectorCenteringEnabled":
    case "vectorSurfaceOffsetEnabled":
    case "vectorSurfaceOffsetScale":
      break;
  }

  return {
    scope: entry.scope,
    scope_id: entry.scope_id,
    ...(visible === undefined ? {} : { visible }),
    ...(Object.keys(display).length === 0 ? {} : { display }),
    ...(Object.keys(style).length === 0 ? {} : { style }),
    ...(quantity?.active_quantity_id ? { quantity } : {}),
  };
}

function isVisualizationStateOverrideEmpty(
  entry: VisualizationStateResource["overrides"][number],
): boolean {
  return (
    entry.visible === undefined &&
    !entry.display &&
    !entry.style &&
    !entry.quantity
  );
}

export function visualizationStateOverrideMatchesTarget(
  entry: VisualizationStateResource["overrides"][number],
  target: VisualizationTargetRef,
): boolean {
  if (
    target.kind === "airbox" &&
    entry.scope === "fdm_domain" &&
    entry.scope_id === FDM_OUTSIDE_SUPPORT_CARRIER_ID
  ) {
    return true;
  }
  if (entry.scope !== visualizationStateScopeForTarget(target)) return false;
  if (
    entry.scope_id === target.id ||
    entry.scope_id === visualizationStateScopeIdForTarget(target)
  ) {
    return true;
  }
  return (
    target.kind === "object" &&
    target.id.startsWith("object:") &&
    canonicalVisualizationSceneObjectId(entry.scope_id) ===
      canonicalVisualizationSceneObjectId(target.id.slice("object:".length))
  );
}

function normalizeVisualizationStateOverride(
  override: VisualizationStateResource["overrides"][number],
): VisualizationStateResource["overrides"][number] {
  const canonicalOverride =
    override.scope === "fdm_domain" &&
    override.scope_id === FDM_OUTSIDE_SUPPORT_CARRIER_ID
      ? { ...override, scope: "airbox" as const, scope_id: "airbox" }
      : override;
  return canonicalOverride.quantity?.active_quantity_id
    ? {
        ...canonicalOverride,
        quantity: {
          active_quantity_id: normalizeQuantityIdOrDefault(
            canonicalOverride.quantity.active_quantity_id,
          ),
        },
      }
    : canonicalOverride;
}

export function visualizationStatePatchFromDefaultTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationStatePatch {
  const normalized = normalizePatch(patch);
  const layers: NonNullable<VisualizationStatePatch["layers"]> = {};
  const surface = {
    ...(normalized.surfaceOpacityPercent === undefined
      ? {}
      : { opacity: clampOpacity(normalized.surfaceOpacityPercent) / 100 }),
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
      : { density: Math.max(0, Math.floor(normalized.vectorBudget)) }),
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

  if (
    normalized.boundsVisible !== undefined ||
    normalized.boundsOpacityPercent !== undefined
  ) {
    layers.bounds = {
      ...(normalized.boundsOpacityPercent === undefined
        ? {}
        : { opacity: normalized.boundsOpacityPercent / 100 }),
      ...(normalized.boundsVisible === undefined
        ? {}
        : { visible: normalized.boundsVisible }),
    };
  }
  if (Object.keys(surface).length > 0) {
    layers.surface = surface;
  }
  if (Object.keys(wireframe).length > 0) {
    layers.wireframe = wireframe;
  }
  if (
    normalized.pointsVisible !== undefined ||
    normalized.pointOpacityPercent !== undefined
  ) {
    layers.points = {
      ...(normalized.pointOpacityPercent === undefined
        ? {}
        : { opacity: normalized.pointOpacityPercent / 100 }),
      ...(normalized.pointsVisible === undefined
        ? {}
        : { visible: normalized.pointsVisible }),
    };
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
  const quantitySource = next.quantity ?? current.quantity;
  const quantity = quantitySource?.active_quantity_id
    ? {
        active_quantity_id: normalizeQuantityIdOrDefault(
          quantitySource.active_quantity_id,
        ),
      }
    : undefined;
  const merged = {
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
  return quantity ? { ...merged, quantity } : merged;
}

function visualizationStateOverrideIdentity(
  entry: VisualizationStateResource["overrides"][number],
): string {
  return `${entry.scope}\u0000${entry.scope_id}`;
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
  targetId: string | undefined,
  state: VisualizationStateResource | null | undefined,
): VisualizationTargetSettings {
  if (kind === "airbox") {
    return resolveAirboxVisualizationSettingsFromState(state);
  }
  // The backend target registry does not publish structured-grid FDM entries,
  // so resolve the FDM baseline locally and apply its session override below.
  if (kind === "fdm-domain") {
    return defaultVisualizationSettings(kind, targetId);
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
  const vectorBudget =
    state?.sampling?.max_glyphs ??
    state?.layers?.vectors?.density ??
    state?.vector_density;
  const activeQuantityId = normalizeQuantityIdOrDefault(
    state.quantity?.active_quantity_id ?? state.active_quantity_id,
    DEFAULT_OBJECT_VISUALIZATION.activeQuantityId,
  );
  const surfaceColorSource = defaultSurfaceColorSourceForQuantity(
    activeQuantityId,
    vectorColorMode,
  );

  return {
    ...DEFAULT_OBJECT_VISUALIZATION,
    activeQuantityId,
    boundsVisible:
      state?.layers?.bounds?.visible ?? DEFAULT_OBJECT_VISUALIZATION.boundsVisible,
    boundsOpacityPercent: layerOpacityToPercent(
      state?.layers?.bounds?.opacity ??
        DEFAULT_OBJECT_VISUALIZATION.boundsOpacityPercent / 100,
    ),
    surfaceOpacityPercent: layerOpacityToPercent(
      state?.layers?.surface?.opacity ??
        DEFAULT_OBJECT_VISUALIZATION.surfaceOpacityPercent / 100,
    ),
    pointsVisible,
    pointOpacityPercent: layerOpacityToPercent(
      state?.layers?.points?.opacity ??
        DEFAULT_OBJECT_VISUALIZATION.pointOpacityPercent / 100,
    ),
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible: surfaceVisible,
      wireframeVisible,
    }),
    scalarColorPalette:
      state.quantity?.colormap ??
      state.colormap ??
      DEFAULT_OBJECT_VISUALIZATION.scalarColorPalette,
    shaderColorMode:
      surfaceColorSourceToColorMode(surfaceColorSource) ?? "monochrome",
    shaderMonoColor: vectorMonoColor,
    shaderVisible: surfaceVisible,
    surfaceColorSource,
    vectorAlphaPercent: layerOpacityToPercent(state?.vector_style?.alpha ?? 1),
    vectorBudget:
      vectorBudget === undefined || vectorBudget === null
        ? DEFAULT_OBJECT_VISUALIZATION.vectorBudget
        : Math.max(0, Math.floor(vectorBudget)),
    vectorColorMode,
    vectorLengthScale:
      state?.vector_style?.length_scale ??
      DEFAULT_OBJECT_VISUALIZATION.vectorLengthScale,
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
  const activeQuantityId = normalizeQuantityIdOrDefault(
    state?.targets?.airbox?.settings?.active_quantity_id,
    baseSettings.activeQuantityId,
  );
  const airbox = state?.layers?.airbox;
  const shaderVisible =
    airbox?.surface?.visible ?? baseSettings.shaderVisible;
  const wireframeVisible =
    airbox?.wireframe?.visible ?? baseSettings.wireframeVisible;
  const pointsVisible =
    airbox?.points?.visible ?? baseSettings.pointsVisible;

  return normalizeAirboxVisualizationSettings({
    ...baseSettings,
    activeQuantityId,
    boundsVisible:
      airbox?.bounds?.visible ?? baseSettings.boundsVisible,
    boundsOpacityPercent: layerOpacityToPercent(
      airbox?.bounds?.opacity ?? baseSettings.boundsOpacityPercent / 100,
    ),
    surfaceOpacityPercent: layerOpacityToPercent(
      airbox?.surface?.opacity ??
        airbox?.opacity ??
        baseSettings.surfaceOpacityPercent / 100,
    ),
    pointsVisible,
    pointOpacityPercent: layerOpacityToPercent(
      airbox?.points?.opacity ?? baseSettings.pointOpacityPercent / 100,
    ),
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible,
      wireframeVisible,
    }),
    scalarColorPalette:
      state?.quantity?.colormap ??
      state?.colormap ??
      baseSettings.scalarColorPalette,
    shaderVisible,
    vectorBudget:
      state?.targets?.airbox?.settings?.vector_budget !== undefined &&
      state?.targets?.airbox?.settings?.vector_budget !== null
        ? baseSettings.vectorBudget
        : airbox?.vectors?.density ?? baseSettings.vectorBudget,
    vectorsVisible:
      airbox?.vectors?.visible ?? baseSettings.vectorsVisible,
    visible: airbox?.visible ?? baseSettings.visible,
    wireframeVisible,
  });
}

function visualizationSettingsFromResolvedTarget(
  settings: ResolvedTargetSettingsResource | null | undefined,
  defaultSettings = DEFAULT_AIRBOX_VISUALIZATION,
): VisualizationTargetSettings | null {
  if (!settings) return null;

  return normalizeVisualizationSettings({
    ...defaultSettings,
    activeQuantityId:
      normalizeQuantityIdOrDefault(
        settings.active_quantity_id,
        defaultSettings.activeQuantityId,
      ),
    boundsVisible: settings.bounds_visible,
    boundsOpacityPercent: layerOpacityToPercent(settings.bounds_opacity),
    geometryScope: settings.geometry_scope,
    surfaceOpacityPercent: layerOpacityToPercent(
      settings.surface_opacity ?? settings.opacity,
    ),
    pointsVisible: settings.points_visible,
    pointOpacityPercent: layerOpacityToPercent(settings.point_opacity),
    pointColor:
      settings.point_color ?? defaultSettings.pointColor,
    renderMode: settings.render_mode,
    shaderMonoColor:
      settings.surface_mono_color ?? defaultSettings.shaderMonoColor,
    shaderVisible: settings.surface_visible,
    scalarColorPalette:
      settings.scalar_color_palette ??
      defaultSettings.scalarColorPalette,
    surfaceColorSource: settings.surface_color_source,
    surfaceProjectionMode: settings.surface_projection_mode ?? "raw_nodal",
    viewportColorbarVisible: settings.viewport_colorbar_visible,
    vectorAlphaPercent: layerOpacityToPercent(settings.vector_alpha),
    vectorBudget: Math.max(
      0,
      Math.floor(settings.vector_budget ?? defaultSettings.vectorBudget),
    ),
    vectorColorMode: settings.vector_color_mode,
    vectorLengthScale:
      settings.vector_length_scale ?? defaultSettings.vectorLengthScale,
    vectorMonoColor:
      settings.vector_mono_color ?? defaultSettings.vectorMonoColor,
    vectorThickness: settings.vector_thickness,
    vectorsVisible: settings.vectors_visible,
    visible: settings.visible,
    wireframeColor:
      settings.wireframe_color ?? defaultSettings.wireframeColor,
    wireframeOpacityPercent: layerOpacityToPercent(settings.wireframe_opacity),
    wireframeVisible: settings.wireframe_visible,
  });
}

export function airboxVisualizationStatePatchFromTargetPatch(
  patch: VisualizationTargetPatch,
  currentOverrides?: VisualizationStateResource["overrides"],
): VisualizationStatePatch {
  const normalized = normalizePatch(
    visualizationTargetSupportedPatch(AIRBOX_VISUALIZATION_TARGET, patch),
  );
  const vectors =
    normalized.vectorsVisible === undefined && normalized.vectorBudget === undefined
      ? {}
      : {
          vectors: {
            domain: "airbox_only" as const,
            ...(normalized.vectorBudget === undefined
              ? {}
              : { density: normalized.vectorBudget }),
            ...(normalized.vectorsVisible === undefined
              ? {}
              : { visible: normalized.vectorsVisible }),
          },
        };
  const airbox: NonNullable<
    NonNullable<VisualizationStatePatch["layers"]>["airbox"]
  > = {
    ...(normalized.boundsVisible === undefined &&
    normalized.boundsOpacityPercent === undefined
      ? {}
      : {
          bounds: {
            ...(normalized.boundsOpacityPercent === undefined
              ? {}
              : { opacity: normalized.boundsOpacityPercent / 100 }),
            ...(normalized.boundsVisible === undefined
              ? {}
              : { visible: normalized.boundsVisible }),
          },
        }),
    ...(normalized.pointsVisible === undefined &&
    normalized.pointOpacityPercent === undefined
      ? {}
      : {
          points: {
            ...(normalized.pointOpacityPercent === undefined
              ? {}
              : { opacity: normalized.pointOpacityPercent / 100 }),
            ...(normalized.pointsVisible === undefined
              ? {}
              : { visible: normalized.pointsVisible }),
          },
        }),
    ...(normalized.shaderVisible === undefined &&
    normalized.surfaceOpacityPercent === undefined
      ? {}
      : {
          surface: {
            ...(normalized.surfaceOpacityPercent === undefined
              ? {}
              : { opacity: normalized.surfaceOpacityPercent / 100 }),
            ...(normalized.shaderVisible === undefined
              ? {}
              : { visible: normalized.shaderVisible }),
          },
        }),
    ...vectors,
    ...(normalized.visible === undefined ? {} : { visible: normalized.visible }),
    ...(normalized.wireframeOpacityPercent === undefined &&
    normalized.wireframeVisible === undefined
      ? {}
      : {
          wireframe: {
            ...(normalized.wireframeOpacityPercent === undefined
              ? {}
              : { opacity: normalized.wireframeOpacityPercent / 100 }),
            ...(normalized.wireframeVisible === undefined
              ? {}
              : { visible: normalized.wireframeVisible }),
          },
        }),
  };
  const statePatch: VisualizationStatePatch = {
    ...(Object.keys(airbox).length > 0 ? { layers: { airbox } } : {}),
  };
  const remotePatch = normalized;
  return Object.keys(remotePatch).length > 0
    ? {
        ...statePatch,
        overrides: mergeVisualizationStateTargetOverride(
          currentOverrides ?? [],
          AIRBOX_VISUALIZATION_TARGET,
          remotePatch,
        ),
      }
    : statePatch;
}

export function viewportRenderingPreferencesFromTargetPatch(
  patch: VisualizationTargetPatch,
): ViewportTargetRenderingPreferences {
  return {
    ...(patch.airboxSyntheticVectorsEnabled === undefined
      ? {}
      : { airboxSyntheticVectorsEnabled: patch.airboxSyntheticVectorsEnabled }),
    ...(patch.primitiveVisible === undefined
      ? {}
      : { primitiveVisible: patch.primitiveVisible }),
    ...(patch.primitiveMonoColor === undefined
      ? {}
      : { primitiveMonoColor: patch.primitiveMonoColor }),
    ...(patch.primitiveOpacityPercent === undefined
      ? {}
      : { primitiveOpacityPercent: patch.primitiveOpacityPercent }),
    ...(patch.vectorCenteringEnabled === undefined
      ? {}
      : { vectorCenteringEnabled: patch.vectorCenteringEnabled }),
    ...(patch.vectorSurfaceOffsetEnabled === undefined
      ? {}
      : { vectorSurfaceOffsetEnabled: patch.vectorSurfaceOffsetEnabled }),
    ...(patch.vectorSurfaceOffsetScale === undefined
      ? {}
      : { vectorSurfaceOffsetScale: patch.vectorSurfaceOffsetScale }),
  };
}

export function persistentVisualizationTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  const persistent = { ...patch };
  // `renderMode` is a derived UI value. The v2 target override serializes its
  // primitive pass flags instead, so retaining it in the pending overlay
  // would make acknowledgement impossible even after the backend persisted
  // the equivalent surface/wireframe state.
  delete persistent.renderMode;
  // The serialized style stores the canonical `surfaceColorSource`; the
  // normalized `shaderColorMode` is only a local presentation alias.
  delete persistent.shaderColorMode;
  delete persistent.airboxSyntheticVectorsEnabled;
  delete persistent.primitiveVisible;
  delete persistent.primitiveMonoColor;
  delete persistent.primitiveOpacityPercent;
  delete persistent.vectorCenteringEnabled;
  delete persistent.vectorSurfaceOffsetEnabled;
  delete persistent.vectorSurfaceOffsetScale;
  return persistent;
}

export function airboxLocalVisualizationPatchFromTargetPatch(
  patch: VisualizationTargetPatch,
): ViewportTargetRenderingPreferences {
  return viewportRenderingPreferencesFromTargetPatch(patch);
}

export function resetAirboxVisualizationState(
  currentState: Pick<VisualizationStateResource, "overrides">,
): VisualizationStatePatch {
  return {
      layers: {
        airbox: {
        bounds: {
          opacity: DEFAULT_AIRBOX_VISUALIZATION.boundsOpacityPercent / 100,
          visible: DEFAULT_AIRBOX_VISUALIZATION.boundsVisible,
        },
        vectors: {
          density: DEFAULT_AIRBOX_VISUALIZATION.vectorBudget,
          domain: "airbox_only",
          visible: DEFAULT_AIRBOX_VISUALIZATION.vectorsVisible,
        },
        visible: DEFAULT_AIRBOX_VISUALIZATION.visible,
        wireframe: {
          opacity: DEFAULT_AIRBOX_VISUALIZATION.wireframeOpacityPercent / 100,
          visible: DEFAULT_AIRBOX_VISUALIZATION.wireframeVisible,
        },
      },
    },
    overrides: (currentState.overrides ?? []).filter(
      (entry) => !visualizationStateOverrideMatchesTarget(entry, AIRBOX_VISUALIZATION_TARGET),
    ),
  };
}

export function hasVisualizationStatePatch(
  patch: VisualizationStatePatch,
): boolean {
  return Object.keys(patch).length > 0;
}

export function resolveVisualizationTargetFromSelection(
  selection: Pick<Selection, "kind" | "label" | "nodeId" | "objectId" | "ref">,
): VisualizationTargetRef | null {
  if (
    selection.ref?.type === "fdm-cell" ||
    selection.ref?.type === "fdm-domain"
  ) {
    if (
      selection.ref.type === "fdm-domain" &&
      selection.ref.kind === "mesh.grid.common"
    ) {
      // The common convolution grid is an FFT scratch layout, not a
      // physical carrier.  It remains selectable for its Inspector, but it
      // must not mutate any viewport target settings.
      return null;
    }
    const targetId =
      selection.ref.type === "fdm-domain"
        ? selection.ref.visualizationTargetId
        : "fdm-domain";
    if (canonicalPublicVisualizationTargetId(targetId) === "airbox") {
      if (selection.kind?.startsWith("airbox.mesh")) return null;
      return AIRBOX_VISUALIZATION_TARGET;
    }
    if (targetId.startsWith(FDM_NATIVE_LAYER_TARGET_PREFIX)) {
      return {
        id: targetId,
        kind: "fdm-native-layer",
        label: selection.label,
      };
    }
    if (targetId.startsWith("region:")) {
      return {
        id: targetId,
        kind: "region",
        label: selection.label,
      };
    }
    return {
      id: targetId,
      kind: "fdm-domain",
      label:
        targetId === FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
          ? FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.label
          : selection.label,
    };
  }

  // Canonical Airbox refs include the target-only FDM multilayer leaf and
  // viewport-generated Airbox-root selections.  They are not the legacy
  // outside-support structured-grid target.
  if (
    selection.ref?.type === "airbox" &&
    selection.ref.visualizationTargetId === AIRBOX_VISUALIZATION_TARGET.id &&
    (selection.kind === "airbox.multilayer.target" ||
      selection.kind === "airbox.root" ||
      selection.ref.kind === "airbox.multilayer.target")
  ) {
    return AIRBOX_VISUALIZATION_TARGET;
  }

  if (
    selection.kind === "airbox.visualization" ||
    selection.kind === "airbox.visualization.debug" ||
    selection.kind === "mesh-part-airbox"
  ) {
    return AIRBOX_VISUALIZATION_TARGET;
  }

  if (selection.objectId && selection.ref?.type === "scene-object" && selection.ref.regionId) {
    return {
      id: selection.ref.visualizationTargetId,
      kind: "region",
      label: selection.label,
    };
  }

  if (selection.objectId) {
    return {
      id:
        selection.ref?.type === "scene-object"
          ? selection.ref.visualizationTargetId
          : visualizationTargetIdForSceneObject(selection.objectId),
      kind: "object",
      label: selection.label,
    };
  }

  if (selection.kind === "mesh-part" && selection.nodeId) {
    return {
      id:
        selection.ref?.type === "mesh-part"
          ? selection.ref.carrierPartId
            ? selection.ref.visualizationTargetId
            : selection.ref.nodeId
          : selection.nodeId,
      kind: "part",
      label: selection.label,
    };
  }

  return null;
}

export function visualizationTargetKey(target: VisualizationTargetRef): string {
  const publicTargetId = canonicalPublicVisualizationTargetId(target.id);
  if (target.kind === "airbox" || publicTargetId === "airbox") return "airbox";
  if (target.kind === "fdm-domain") {
    return target.id === FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
      ? FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id
      : "fdm-domain";
  }
  return canonicalVisualizationTargetId(target);
}

function canonicalVisualizationTargetId(target: VisualizationTargetRef): string {
  if (target.kind === "object") {
    const objectId = target.id.startsWith("object:")
      ? target.id.slice("object:".length)
      : target.id;
    return `object:${canonicalVisualizationSceneObjectId(objectId)}`;
  }
  if (target.kind === "region") {
    const match = /^region:([^:]+):(.+)$/.exec(target.id);
    if (!match) return target.id;
    try {
      const objectId = encodeURIComponent(
        canonicalVisualizationSceneObjectId(
          decodeURIComponent(match[1] ?? ""),
        ),
      );
      const regionId = encodeURIComponent(decodeURIComponent(match[2] ?? ""));
      return `region:${objectId}:${regionId}`;
    } catch {
      return target.id;
    }
  }
  if (target.kind === "part") {
    return target.id.startsWith("part:") ? target.id : `part:${target.id}`;
  }
  return target.id;
}

function normalizePatch(
  patch: VisualizationTargetPatch,
): VisualizationStoredTargetPatch {
  const normalized = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as VisualizationTargetPatch;
  if (normalized.surfaceOpacityPercent !== undefined) {
    normalized.surfaceOpacityPercent = clampOpacity(normalized.surfaceOpacityPercent);
  }
  if (normalized.boundsOpacityPercent !== undefined) {
    normalized.boundsOpacityPercent = clampOpacity(normalized.boundsOpacityPercent);
  }
  if (normalized.pointOpacityPercent !== undefined) {
    normalized.pointOpacityPercent = clampOpacity(normalized.pointOpacityPercent);
  }
  if (normalized.primitiveOpacityPercent !== undefined) {
    normalized.primitiveOpacityPercent = clampOpacity(
      normalized.primitiveOpacityPercent,
    );
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
    normalized.vectorBudget = Math.max(0, Math.floor(normalized.vectorBudget));
  }
  if (normalized.scalarColorPalette !== undefined) {
    normalized.scalarColorPalette = normalizeScalarColorPalette(
      normalized.scalarColorPalette,
    );
  }
  if (normalized.vectorLengthScale !== undefined) {
    normalized.vectorLengthScale = Math.max(0.1, Math.min(5, normalized.vectorLengthScale));
  }
  if (normalized.vectorSurfaceOffsetScale !== undefined) {
    normalized.vectorSurfaceOffsetScale = Math.max(
      0,
      Math.min(1, normalized.vectorSurfaceOffsetScale),
    );
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
  if (normalized.surfaceProjectionMode !== undefined) {
    normalized.surfaceProjectionMode =
      normalizeSurfaceProjectionMode(normalized.surfaceProjectionMode) ??
      "raw_nodal";
  }
  if (normalized.vectorColorMode !== undefined) {
    normalized.vectorColorMode =
      normalizeColorMode(normalized.vectorColorMode) ?? "orientation";
  }
  if (normalized.renderMode) {
    Object.assign(normalized, renderModePatch(normalized.renderMode));
    delete normalized.renderMode;
  }
  if (normalized.activeQuantityId !== undefined) {
    const activeQuantityId =
      typeof normalized.activeQuantityId === "string"
        ? normalized.activeQuantityId.trim()
        : "";
    if (activeQuantityId) {
      normalized.activeQuantityId = resolveCanonicalQuantityId(activeQuantityId);
    } else {
      delete normalized.activeQuantityId;
    }
  }
  return normalized;
}

function normalizeViewportTargetRenderingPreferences(
  preferences: ViewportTargetRenderingPreferences,
): ViewportTargetRenderingPreferences {
  return {
    ...(preferences.airboxSyntheticVectorsEnabled === undefined
      ? {}
      : {
          airboxSyntheticVectorsEnabled:
            preferences.airboxSyntheticVectorsEnabled,
        }),
    ...(preferences.primitiveVisible === undefined
      ? {}
      : { primitiveVisible: preferences.primitiveVisible }),
    ...(preferences.primitiveMonoColor === undefined
      ? {}
      : { primitiveMonoColor: preferences.primitiveMonoColor }),
    ...(preferences.primitiveOpacityPercent === undefined
      ? {}
      : {
          primitiveOpacityPercent: clampOpacity(
            preferences.primitiveOpacityPercent,
          ),
        }),
    ...(preferences.vectorCenteringEnabled === undefined
      ? {}
      : { vectorCenteringEnabled: preferences.vectorCenteringEnabled }),
    ...(preferences.vectorSurfaceOffsetEnabled === undefined
      ? {}
      : { vectorSurfaceOffsetEnabled: preferences.vectorSurfaceOffsetEnabled }),
    ...(preferences.vectorSurfaceOffsetScale === undefined
      ? {}
      : {
          vectorSurfaceOffsetScale: Math.max(
            0,
            Math.min(1, preferences.vectorSurfaceOffsetScale),
          ),
        }),
  };
}

function removeStoredTargetPatchField(
  patch: VisualizationStoredTargetPatch,
  field: keyof VisualizationTargetPatch,
): VisualizationStoredTargetPatch {
  const next = { ...patch };
  delete next[field as keyof VisualizationStoredTargetPatch];
  if (field === "surfaceColorSource" || field === "shaderColorMode") {
    delete next.surfaceColorSource;
    delete next.shaderColorMode;
  }
  return next;
}

function normalizeVisualizationSettings(
  settings: VisualizationTargetSettings,
): VisualizationTargetSettings {
  const surfaceColorSource =
    normalizeSurfaceColorSource(settings.surfaceColorSource) ??
    surfaceColorSourceFromColorMode(settings.shaderColorMode) ??
    "orientation";
  const pointsVisible = Boolean(settings.pointsVisible);
  const shaderVisible = Boolean(settings.shaderVisible);
  const wireframeVisible = Boolean(settings.wireframeVisible);
  return {
    ...settings,
    activeQuantityId: normalizeQuantityIdOrDefault(settings.activeQuantityId),
    scalarColorPalette: normalizeScalarColorPalette(settings.scalarColorPalette),
    primitiveVisible: settings.primitiveVisible ?? false,
    primitiveMonoColor:
      settings.primitiveMonoColor ?? settings.shaderMonoColor,
    primitiveOpacityPercent: clampOpacity(
      settings.primitiveOpacityPercent ?? 100,
    ),
    pointsVisible,
    renderMode: resolveRenderMode({
      pointsVisible,
      shaderVisible,
      wireframeVisible,
    }),
    shaderVisible,
    wireframeVisible,
    geometryScope:
      settings.geometryScope === "surface" || settings.geometryScope === "full"
        ? settings.geometryScope
        : "full",

    surfaceOpacityPercent: clampOpacity(settings.surfaceOpacityPercent),
    boundsOpacityPercent: clampOpacity(settings.boundsOpacityPercent),
    pointOpacityPercent: clampOpacity(settings.pointOpacityPercent),
    shaderColorMode:
      surfaceColorSourceToColorMode(surfaceColorSource) ?? "monochrome",
    surfaceColorSource,
    surfaceProjectionMode:
      normalizeSurfaceProjectionMode(settings.surfaceProjectionMode) ??
      "raw_nodal",
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

function normalizeSurfaceProjectionMode(
  value: unknown,
): SurfaceFieldProjectionMode | undefined {
  return value === "raw_nodal" ||
    value === "surface_faces" ||
    value === "thickness_average_z"
    ? value
    : undefined;
}

function normalizeScalarColorPalette(value: unknown): string {
  const normalized =
    typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
      : "";
  return normalized === "coolwarm" ||
    normalized === "inferno" ||
    normalized === "jet" ||
    normalized === "magma" ||
    normalized === "viridis"
    ? normalized
    : "viridis";
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

export function defaultSurfaceColorSourceForQuantity(
  activeQuantityId: string,
  vectorColorMode: VisualizationColorMode,
): SurfaceColorSource {
  if (isScalarSpatialQuantityId(activeQuantityId)) {
    return "colormap";
  }
  return (
    surfaceColorSourceFromColorMode(vectorColorMode) ??
    DEFAULT_OBJECT_VISUALIZATION.surfaceColorSource
  );
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
  if (wireframeVisible) return "wireframe";
  return "off";
}

function samePatch(
  left: VisualizationStoredTargetPatch,
  right: VisualizationStoredTargetPatch,
): boolean {
  const leftKeys = Object.keys(left) as Array<keyof VisualizationStoredTargetPatch>;
  const rightKeys = Object.keys(right) as Array<keyof VisualizationStoredTargetPatch>;
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) &&
    Object.is(left[key], right[key]),
  );
}
