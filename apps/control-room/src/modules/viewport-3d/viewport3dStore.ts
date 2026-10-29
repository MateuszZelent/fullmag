"use client";

import { useCallback, useSyncExternalStore } from "react";

import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";
import type { VisualizationVectorCapacityDescriptor } from "@/kernel/visualization/visualizationVectorCapacity";
import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { DEFAULT_CAMERA_REGISTRY_STATE } from "@/kernel/visualization/CameraRegistryController";
import {
  createViewport3DPreferencesHydrationAdapter,
  getViewport3DBrowserPreferencesStorage,
} from "./viewport3dAppearanceHydration";
import {
  applyViewport3DAppearancePatch,
  DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
  DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES,
  resolveViewport3DAppearanceDiagnostics,
  type Viewport3DAppearanceDiagnostics,
  type Viewport3DAppearancePreferences,
  type Viewport3DAppearanceSection,
  type Viewport3DPersistedPreferences,
} from "./viewport3dAppearancePreferences";
import {
  DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID,
  getViewport3DVisualProfile,
  type Viewport3DVisualProfileId,
} from "./viewport3dVisualProfile";
import { sameTuple3 } from "./viewport3dMath";
import type { Viewport3DFieldScopeKind } from "./model/viewport3DFieldDataPlan";

export interface Viewport3DCameraState {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
}

export interface Viewport3DArtifactInspectionPresentation {
  key: string;
  fieldBufferId: string;
  vectorBuildKey: string;
  capacity: VisualizationVectorCapacityDescriptor;
  decodedSampleCount: number;
  availableGlyphCount: number;
  expectedGlyphCount: number;
  adoptedGlyphCount: number | null;
}

export interface Viewport3DCommandState {
  artifactInspectionPresentation: Viewport3DArtifactInspectionPresentation | null;
  activeScalarColorbarLegends: Viewport3DScalarColorbarLegend[];
  appearance: Viewport3DAppearancePreferences;
  appearanceDiagnostics: Viewport3DAppearanceDiagnostics;
  camera: Viewport3DCameraState;
  captureReturnProfileId: Viewport3DVisualProfileId | null;
  captureError: string | null;
  captureRevision: number;
  fitRevision: number;
  renderedScalarRanges: Viewport3DRenderedScalarRange[];
  resetCameraRevision: number;
  visualProfileId: Viewport3DVisualProfileId;
  widgets: Viewport3DWidgetState;
}

type Viewport3DListener = () => void;
export interface SavedCameraOwner {
  fit: () => void;
  reset: () => void;
}

interface RegisteredSavedCameraOwner {
  owner: SavedCameraOwner;
  token: symbol;
}

export type Viewport3DHslReferenceMode = "auto" | "off" | "on";
export type Viewport3DCameraProjection = "perspective" | "orthographic";
export type Viewport3DDimensionFrameDensity = "auto" | "coarse" | "fine";
export type Viewport3DDimensionFrameMode = "off" | "floor" | "cage";
export type Viewport3DDimensionFrameAnnotation = "ticks" | "extents" | "both";
export type Viewport3DFdmTopographyComponent = "magnitude" | "x" | "y" | "z";
export type Viewport3DRotationMode = "camera" | "object";
export type Viewport3DScaleUnitMode = "auto" | "nm" | "um" | "mm" | "m";

interface Viewport3DScalarColorbarLegend {
  label: string;
  maxLabel: string;
  minLabel: string;
  paletteGradient: string;
}

export interface Viewport3DRenderedScalarRange {
  inspectionKey?: string | null;
  component: string;
  quantityId: string;
  range: { max: number; min: number };
  scopeId: string | null;
  scopeKind: Viewport3DFieldScopeKind;
}

export interface Viewport3DRenderedScalarRangeQuery {
  inspectionKey?: string | null;
  component: string | null | undefined;
  quantityId: string;
  scopeId: string | null | undefined;
  scopeKind: Viewport3DFieldScopeKind | null | undefined;
}

/**
 * A scalar buffer is built per physical mesh part, while an Inspector often
 * addresses that same carrier through its owning scene object. Publish the
 * exact render range under both identities so the Inspector never invents or
 * waits for a second, visually divergent scale.
 */
export function buildViewport3DRenderedScalarRangeAliases({
  component,
  quantityId,
  range,
  renderedScope,
  visualizationTarget,
}: {
  component: string;
  quantityId: string;
  range: { max: number; min: number };
  renderedScope: Pick<Viewport3DRenderedScalarRange, "scopeId" | "scopeKind">;
  visualizationTarget?: {
    id: string;
    kind: "object" | "part";
  } | null;
}): Viewport3DRenderedScalarRange[] {
  const ranges: Viewport3DRenderedScalarRange[] = [
    {
      component,
      quantityId,
      range,
      scopeId: renderedScope.scopeId,
      scopeKind: renderedScope.scopeKind,
    },
  ];
  if (visualizationTarget?.kind !== "object") return ranges;

  const objectScopeId = visualizationTarget.id.replace(/^object:/, "").trim();
  if (!objectScopeId) return ranges;
  ranges.push({
    component,
    quantityId,
    range,
    scopeId: objectScopeId,
    scopeKind: "object",
  });
  return ranges;
}

interface Viewport3DWidgetState {
  cameraDialogOpen: boolean;
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  dimensionFrameAnnotation: Viewport3DDimensionFrameAnnotation;
  dimensionFrameDensity: Viewport3DDimensionFrameDensity;
  dimensionFrameMode: Viewport3DDimensionFrameMode;
  effectAmbientOcclusion: boolean;
  effectAntialias: boolean;
  effectBloom: boolean;
  fdmTopographyAmplitudeCells: number;
  fdmTopographyComponent: Viewport3DFdmTopographyComponent;
  fdmTopographyEnabled: boolean;
  hslReferenceMode: Viewport3DHslReferenceMode;
  inspectEnabled: boolean;
  inspectRevision: number;
  rotationMode: Viewport3DRotationMode;
  scaleLabelsVisible: boolean;
  scaleUnitMode: Viewport3DScaleUnitMode;
  settingsDialogOpen: boolean;
  viewCubeVisible: boolean;
}

export const DEFAULT_VIEWPORT_3D_CAMERA_STATE: Viewport3DCameraState = {
  position: tuple3(DEFAULT_CAMERA_REGISTRY_STATE.position),
  target: tuple3(DEFAULT_CAMERA_REGISTRY_STATE.target),
  up: tuple3(DEFAULT_CAMERA_REGISTRY_STATE.up),
};

const DEFAULT_VIEWPORT_3D_STATE: Viewport3DCommandState = {
  artifactInspectionPresentation: null,
  activeScalarColorbarLegends: [],
  appearance: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
  appearanceDiagnostics: resolveViewport3DAppearanceDiagnostics({
    ambientOcclusionRequested: false,
    antialiasRequested: true,
    bloomRequested: false,
    profileAllowsAntialias:
      getViewport3DVisualProfile(DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID).antialias,
  }),
  camera: {
    ...DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  },
  captureReturnProfileId: null,
  captureError: null,
  captureRevision: 0,
  fitRevision: 0,
  renderedScalarRanges: [],
  resetCameraRevision: 0,
  visualProfileId: DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID,
  widgets: {
    cameraDialogOpen: false,
    cameraOrthographicScale: DEFAULT_CAMERA_REGISTRY_STATE.orthographic_scale ?? null,
    cameraProjection: DEFAULT_CAMERA_REGISTRY_STATE.projection,
    dimensionFrameAnnotation: "ticks",
    dimensionFrameDensity: "auto",
    dimensionFrameMode: "floor",
    effectAmbientOcclusion: false,
    effectAntialias: true,
    effectBloom: false,
    fdmTopographyAmplitudeCells: 0,
    fdmTopographyComponent: "z",
    fdmTopographyEnabled: false,
    hslReferenceMode: "auto",
    inspectEnabled: false,
    inspectRevision: 0,
    rotationMode: "object",
    scaleLabelsVisible: true,
    scaleUnitMode: "auto",
    settingsDialogOpen: false,
    viewCubeVisible: true,
  },
};

let ensureViewport3DPreferencesHydrated = (): void => {};

class Viewport3DStore {
  private snapshot: Viewport3DCommandState = DEFAULT_VIEWPORT_3D_STATE;
  private readonly listeners = new Set<Viewport3DListener>();
  private persistedPreferenceRevision = 0;
  private postProcessingDataProtected = false;
  private postProcessingAvailable = true;
  private savedCameraOwner: RegisteredSavedCameraOwner | null = null;

  getSnapshot(): Viewport3DCommandState {
    return this.snapshot;
  }

  requestFit(): boolean {
    if (this.savedCameraOwner) {
      this.savedCameraOwner.owner.fit();
      return true;
    }

    this.snapshot = {
      ...this.snapshot,
      fitRevision: this.snapshot.fitRevision + 1,
    };
    this.notify();
    return false;
  }

  requestCapture(): void {
    if (this.snapshot.captureReturnProfileId !== null) return;
    const captureReturnProfileId =
      this.snapshot.visualProfileId === "capture"
        ? null
        : this.snapshot.visualProfileId;
    this.snapshot = {
      ...this.snapshot,
      captureReturnProfileId,
      captureError: null,
      captureRevision: this.snapshot.captureRevision + 1,
      visualProfileId: "capture",
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        this.snapshot.widgets,
        "capture",
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
    };
    this.notify();
  }

  setCaptureError(error: string | null): void {
    const nextError = typeof error === "string" && error.trim() ? error : null;
    if (this.snapshot.captureError === nextError) return;
    this.snapshot = { ...this.snapshot, captureError: nextError };
    this.notify();
  }

  completeCapture(): void {
    if (this.snapshot.captureReturnProfileId === null) return;
    this.snapshot = {
      ...this.snapshot,
      visualProfileId: this.snapshot.captureReturnProfileId,
      captureReturnProfileId: null,
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        this.snapshot.widgets,
        this.snapshot.captureReturnProfileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
    };
    this.notify();
  }

  resetCamera(): boolean {
    if (this.savedCameraOwner) {
      this.savedCameraOwner.owner.reset();
      return true;
    }

    this.snapshot = {
      ...this.snapshot,
      camera: DEFAULT_VIEWPORT_3D_STATE.camera,
      resetCameraRevision: this.snapshot.resetCameraRevision + 1,
    };
    this.notify();
    return false;
  }

  /**
   * Routes camera commands to the currently mounted saved-results viewport.
   * The token keeps a stale unmount from clearing a newer owner.
   */
  registerSavedCameraOwner(owner: SavedCameraOwner): () => void {
    const token = Symbol("saved-camera-owner");
    this.savedCameraOwner = { owner, token };
    return () => {
      if (this.savedCameraOwner?.token !== token) return;
      this.savedCameraOwner = null;
    };
  }

  resetForTest(): void {
    this.snapshot = DEFAULT_VIEWPORT_3D_STATE;
    this.persistedPreferenceRevision = 0;
    this.postProcessingDataProtected = false;
    this.postProcessingAvailable = true;
    this.savedCameraOwner = null;
    this.notify();
  }

  setPostProcessingDataProtection(protectedData: boolean): void {
    if (this.postProcessingDataProtected === protectedData) return;
    this.postProcessingDataProtected = protectedData;
    this.refreshAppearanceDiagnostics();
  }

  setPostProcessingAvailable(available: boolean): void {
    if (this.postProcessingAvailable === available) return;
    this.postProcessingAvailable = available;
    this.refreshAppearanceDiagnostics();
  }

  setAppearance(patch: Partial<Viewport3DAppearancePreferences>): void {
    const appearance = applyViewport3DAppearancePatch(this.snapshot.appearance, patch);
    if (sameViewport3DAppearancePreferences(this.snapshot.appearance, appearance)) return;
    this.markPersistedPreferenceChange();
    this.snapshot = { ...this.snapshot, appearance };
    this.notify();
  }

  resetAppearance(section: Viewport3DAppearanceSection): void {
    const current = this.snapshot;
    const resetAll = section === "all";
    let appearance = current.appearance;
    let widgets = current.widgets;
    let visualProfileId = current.visualProfileId;
    let captureReturnProfileId = current.captureReturnProfileId;

    if (resetAll || section === "background") {
      appearance = {
        ...appearance,
        backgroundMode: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.backgroundMode,
        backgroundStrength: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.backgroundStrength,
        exportBackground: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.exportBackground,
      };
    }
    if (resetAll || section === "frame") {
      appearance = {
        ...appearance,
        dimensionOrigin: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.dimensionOrigin,
        gridOpacity: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.gridOpacity,
      };
      widgets = {
        ...widgets,
        dimensionFrameMode: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.dimensionFrameMode,
        dimensionFrameDensity: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.dimensionFrameDensity,
        dimensionFrameAnnotation: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.dimensionFrameAnnotation,
        scaleUnitMode: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.scaleUnitMode,
        scaleLabelsVisible: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.scaleLabelsVisible,
      };
    }
    if (resetAll || section === "lighting") {
      appearance = {
        ...appearance,
        lightingMode: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.lightingMode,
        lightingIntensity: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.lightingIntensity,
        lightingAzimuth: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.lightingAzimuth,
        lightingElevation: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.lightingElevation,
        lightingSpace: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.lightingSpace,
      };
    }
    if (resetAll || section === "effects") {
      appearance = {
        ...appearance,
        aoIntensity: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.aoIntensity,
        aoRadius: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.aoRadius,
        exportAnnotations: DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES.exportAnnotations,
      };
      widgets = {
        ...widgets,
        effectAmbientOcclusion: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.effectAmbientOcclusion,
        effectBloom: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.effectBloom,
        effectAntialias: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.effectAntialias,
      };
    }
    if (resetAll) {
      widgets = {
        ...widgets,
        viewCubeVisible: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.viewCubeVisible,
        hslReferenceMode: DEFAULT_VIEWPORT_3D_PERSISTED_WIDGET_PREFERENCES.hslReferenceMode,
      };
      if (current.visualProfileId === "capture") {
        visualProfileId = "capture";
        captureReturnProfileId = DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID;
      } else {
        visualProfileId = DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID;
        captureReturnProfileId = null;
      }
    }

    const next: Viewport3DCommandState = {
      ...current,
      appearance,
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        widgets,
        visualProfileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
      captureReturnProfileId,
      visualProfileId,
      widgets,
    };
    if (samePersistedViewport3DPreferences(current, next)) return;
    this.markPersistedPreferenceChange();
    this.snapshot = next;
    this.notify();
  }

  /** Applies local UI preferences while preserving the canonical camera owner. */
  hydratePersistedPreferences(
    preferences: Viewport3DPersistedPreferences | null,
  ): "applied" | "local-changes" | "ignored" {
    if (this.persistedPreferenceRevision > 0) return "local-changes";
    if (!preferences) return "ignored";

    const current = this.snapshot;
    const widgets = {
      ...current.widgets,
      ...preferences.widgets,
    };
    const isCapturing = current.visualProfileId === "capture";
    const visualProfileId = isCapturing
      ? current.visualProfileId
      : preferences.visualProfileId;
    const captureReturnProfileId = isCapturing && current.captureReturnProfileId !== null
      ? preferences.visualProfileId
      : current.captureReturnProfileId;
    const next: Viewport3DCommandState = {
      ...current,
      appearance: { ...preferences.appearance },
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        widgets,
        visualProfileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
      captureReturnProfileId,
      visualProfileId,
      widgets,
    };
    if (!samePersistedViewport3DPreferences(current, next)) {
      this.snapshot = next;
      this.notify();
    }
    return "applied";
  }

  getActiveScalarColorbarLegends(): Viewport3DScalarColorbarLegend[] {
    return this.snapshot.activeScalarColorbarLegends;
  }

  setActiveScalarColorbarLegends(
    legends: Viewport3DScalarColorbarLegend[],
  ): void {
    if (
      sameViewport3DScalarColorbarLegends(
        this.snapshot.activeScalarColorbarLegends,
        legends,
      )
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      activeScalarColorbarLegends: legends,
    };
    this.notify();
  }

  getArtifactInspectionPresentation(key: string | null): Viewport3DArtifactInspectionPresentation | null {
    const value = this.snapshot.artifactInspectionPresentation;
    return key && value?.key === key ? value : null;
  }

  setArtifactInspectionPresentation(value: Viewport3DArtifactInspectionPresentation): void {
    const current = this.snapshot.artifactInspectionPresentation;
    const next = current?.key === value.key && current.vectorBuildKey === value.vectorBuildKey && current.expectedGlyphCount === value.expectedGlyphCount && value.expectedGlyphCount > 0
      ? { ...value, adoptedGlyphCount: current.adoptedGlyphCount } : value;
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this.snapshot = { ...this.snapshot, artifactInspectionPresentation: next }; this.notify();
  }

  clearArtifactInspectionPresentation(key: string, vectorBuildKey: string): void {
    const current = this.snapshot.artifactInspectionPresentation;
    if (current?.key !== key || current.vectorBuildKey !== vectorBuildKey) return;
    this.snapshot = { ...this.snapshot, artifactInspectionPresentation: null }; this.notify();
  }

  updateArtifactGlyphAdoption(key: string, vectorBuildKey: string, count: number | null): void {
    const current = this.snapshot.artifactInspectionPresentation;
    if (current?.key !== key || current.vectorBuildKey !== vectorBuildKey || current.adoptedGlyphCount === count) return;
    if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > current.expectedGlyphCount)) return;
    this.snapshot = { ...this.snapshot, artifactInspectionPresentation: { ...current, adoptedGlyphCount: count } }; this.notify();
  }

  getRenderedScalarRange(
    query: Viewport3DRenderedScalarRangeQuery,
  ): Viewport3DRenderedScalarRange["range"] | null {
    return resolveViewport3DRenderedScalarRange(
      this.snapshot.renderedScalarRanges,
      query,
    );
  }

  setRenderedScalarRanges(
    ranges: Viewport3DRenderedScalarRange[],
  ): void {
    if (sameViewport3DRenderedScalarRanges(this.snapshot.renderedScalarRanges, ranges)) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      renderedScalarRanges: ranges,
    };
    this.notify();
  }

  setHslReferenceMode(mode: Viewport3DHslReferenceMode): void {
    if (this.snapshot.widgets.hslReferenceMode === mode) return;
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        hslReferenceMode: mode,
      },
    };
    this.notify();
  }

  setRotationMode(mode: Viewport3DRotationMode): void {
    if (this.snapshot.widgets.rotationMode === mode) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        rotationMode: mode,
      },
    };
    this.notify();
  }

  setDimensionFrameMode(mode: Viewport3DDimensionFrameMode): void {
    if (this.snapshot.widgets.dimensionFrameMode === mode) return;
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        dimensionFrameMode: mode,
      },
    };
    this.notify();
  }

  setDimensionFrameAnnotation(
    annotation: Viewport3DDimensionFrameAnnotation,
  ): void {
    if (this.snapshot.widgets.dimensionFrameAnnotation === annotation) return;
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        dimensionFrameAnnotation: annotation,
      },
    };
    this.notify();
  }

  setDimensionFrameDensity(density: Viewport3DDimensionFrameDensity): void {
    if (this.snapshot.widgets.dimensionFrameDensity === density) return;
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        dimensionFrameDensity: density,
      },
    };
    this.notify();
  }

  setScaleLabelsVisible(visible: boolean): void {
    if (this.snapshot.widgets.scaleLabelsVisible === visible) return;
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        scaleLabelsVisible: visible,
      },
    };
    this.notify();
  }

  setScaleUnitMode(mode: Viewport3DScaleUnitMode): void {
    if (this.snapshot.widgets.scaleUnitMode === mode) return;
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        scaleUnitMode: mode,
      },
    };
    this.notify();
  }

  setVisualProfile(profileId: Viewport3DVisualProfileId): void {
    if (
      this.snapshot.visualProfileId === profileId &&
      this.snapshot.captureReturnProfileId === null
    ) {
      return;
    }
    if (profileId !== "capture") this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      captureReturnProfileId: null,
      visualProfileId: profileId,
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        this.snapshot.widgets,
        profileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
    };
    this.notify();
  }

  setCamera(camera: Viewport3DCameraState): void {
    if (sameViewport3DCameraState(this.snapshot.camera, camera)) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      camera,
    };
    this.notify();
  }

  setCameraView({
    camera,
    orthographicScale,
    projection,
  }: {
    camera: Viewport3DCameraState;
    orthographicScale?: number | null;
    projection: Viewport3DCameraProjection;
  }): void {
    const nextOrthographicScale =
      orthographicScale === undefined
        ? this.snapshot.widgets.cameraOrthographicScale
        : normalizeOrthographicScale(orthographicScale);
    if (
      sameViewport3DCameraState(this.snapshot.camera, camera) &&
      this.snapshot.widgets.cameraProjection === projection &&
      this.snapshot.widgets.cameraOrthographicScale === nextOrthographicScale
    ) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      camera,
      widgets: {
        ...this.snapshot.widgets,
        cameraOrthographicScale: nextOrthographicScale,
        cameraProjection: projection,
      },
    };
    this.notify();
  }

  subscribe(listener: Viewport3DListener): () => void {
    if (typeof window !== "undefined") ensureViewport3DPreferencesHydrated();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  toggleCameraProjection(): void {
    this.setCameraProjection(
      this.snapshot.widgets.cameraProjection === "perspective"
        ? "orthographic"
        : "perspective",
    );
  }

  setCameraProjection(projection: Viewport3DCameraProjection): void {
    if (this.snapshot.widgets.cameraProjection === projection) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        cameraProjection: projection,
      },
    };
    this.notify();
  }

  setCameraOrthographicScale(scale: number | null): void {
    const nextScale = normalizeOrthographicScale(scale);
    if (this.snapshot.widgets.cameraOrthographicScale === nextScale) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        cameraOrthographicScale: nextScale,
      },
    };
    this.notify();
  }

  setCameraDialogOpen(open: boolean): void {
    if (this.snapshot.widgets.cameraDialogOpen === open) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        cameraDialogOpen: open,
      },
    };
    this.notify();
  }

  toggleViewCube(): void {
    this.markPersistedPreferenceChange();
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        viewCubeVisible: !this.snapshot.widgets.viewCubeVisible,
      },
    };
    this.notify();
  }

  setSettingsDialogOpen(open: boolean): void {
    if (this.snapshot.widgets.settingsDialogOpen === open) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        settingsDialogOpen: open,
      },
    };
    this.notify();
  }

  setInspectEnabled(enabled: boolean): void {
    if (this.snapshot.widgets.inspectEnabled === enabled) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        inspectEnabled: enabled,
        inspectRevision: this.snapshot.widgets.inspectRevision + 1,
      },
    };
    this.notify();
  }

  toggleInspect(): void {
    this.setInspectEnabled(!this.snapshot.widgets.inspectEnabled);
  }

  setEffectAmbientOcclusion(enabled: boolean): void {
    if (this.snapshot.widgets.effectAmbientOcclusion === enabled) return;
    this.markPersistedPreferenceChange();
    const widgets = { ...this.snapshot.widgets, effectAmbientOcclusion: enabled };
    this.snapshot = {
      ...this.snapshot,
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        widgets,
        this.snapshot.visualProfileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
      widgets,
    };
    this.notify();
  }

  setEffectAntialias(enabled: boolean): void {
    if (this.snapshot.widgets.effectAntialias === enabled) return;
    this.markPersistedPreferenceChange();
    const widgets = { ...this.snapshot.widgets, effectAntialias: enabled };
    this.snapshot = {
      ...this.snapshot,
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        widgets,
        this.snapshot.visualProfileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
      widgets,
    };
    this.notify();
  }

  setEffectBloom(enabled: boolean): void {
    if (this.snapshot.widgets.effectBloom === enabled) return;
    this.markPersistedPreferenceChange();
    const widgets = { ...this.snapshot.widgets, effectBloom: enabled };
    this.snapshot = {
      ...this.snapshot,
      appearanceDiagnostics: buildViewport3DAppearanceDiagnostics(
        widgets,
        this.snapshot.visualProfileId,
        this.postProcessingDataProtected,
        this.postProcessingAvailable,
      ),
      widgets,
    };
    this.notify();
  }

  setFdmTopographyEnabled(enabled: boolean): void {
    if (this.snapshot.widgets.fdmTopographyEnabled === enabled) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: { ...this.snapshot.widgets, fdmTopographyEnabled: enabled },
    };
    this.notify();
  }

  setFdmTopographyAmplitudeCells(amplitudeCells: number): void {
    const nextAmplitude = normalizeFdmTopographyAmplitudeCells(amplitudeCells);
    if (this.snapshot.widgets.fdmTopographyAmplitudeCells === nextAmplitude) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      widgets: {
        ...this.snapshot.widgets,
        fdmTopographyAmplitudeCells: nextAmplitude,
      },
    };
    this.notify();
  }

  setFdmTopographyComponent(component: Viewport3DFdmTopographyComponent): void {
    if (this.snapshot.widgets.fdmTopographyComponent === component) return;
    this.snapshot = {
      ...this.snapshot,
      widgets: { ...this.snapshot.widgets, fdmTopographyComponent: component },
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private refreshAppearanceDiagnostics(): void {
    const appearanceDiagnostics = buildViewport3DAppearanceDiagnostics(
      this.snapshot.widgets,
      this.snapshot.visualProfileId,
      this.postProcessingDataProtected,
      this.postProcessingAvailable,
    );
    if (sameViewport3DAppearanceDiagnostics(this.snapshot.appearanceDiagnostics, appearanceDiagnostics)) return;
    this.snapshot = { ...this.snapshot, appearanceDiagnostics };
    this.notify();
  }

  private markPersistedPreferenceChange(): void {
    this.persistedPreferenceRevision += 1;
  }
}

export const viewport3dStore = new Viewport3DStore();

ensureViewport3DPreferencesHydrated = createViewport3DPreferencesHydrationAdapter({
  applyPreferences: (preferences) =>
    viewport3dStore.hydratePersistedPreferences(preferences),
  getSnapshot: () => viewport3dStore.getSnapshot(),
  getStorage: getViewport3DBrowserPreferencesStorage,
  subscribe: (listener) => viewport3dStore.subscribe(listener),
});

export function useViewport3DCommandState(): Viewport3DCommandState {
  return useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    () => viewport3dStore.getSnapshot(),
    () => DEFAULT_VIEWPORT_3D_STATE,
  );
}

export function useViewport3DAppearance(): Viewport3DAppearancePreferences {
  const getSnapshot = useCallback(
    () => viewport3dStore.getSnapshot().appearance,
    [],
  );
  return useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    getSnapshot,
    () => DEFAULT_VIEWPORT_3D_APPEARANCE_PREFERENCES,
  );
}

export function useViewport3DAppearanceDiagnostics(): Viewport3DAppearanceDiagnostics {
  const getSnapshot = useCallback(
    () => viewport3dStore.getSnapshot().appearanceDiagnostics,
    [],
  );
  return useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    getSnapshot,
    () => DEFAULT_VIEWPORT_3D_STATE.appearanceDiagnostics,
  );
}

export function useViewport3DRenderedScalarRange(
  query: Viewport3DRenderedScalarRangeQuery,
): Viewport3DRenderedScalarRange["range"] | null {
  const { component, quantityId, scopeId, scopeKind, inspectionKey } = query;
  const getSnapshot = useCallback(
    () =>
      viewport3dStore.getRenderedScalarRange({
        component,
        quantityId,
        scopeId,
        scopeKind,
        inspectionKey,
      }),
    [component, quantityId, scopeId, scopeKind, inspectionKey],
  );
  return useSyncExternalStore(
    (onStoreChange) => viewport3dStore.subscribe(onStoreChange),
    getSnapshot,
    () => null,
  );
}

export function resolveViewport3DRenderedScalarRange(
  ranges: readonly Viewport3DRenderedScalarRange[],
  query: Viewport3DRenderedScalarRangeQuery,
): Viewport3DRenderedScalarRange["range"] | null {
  if (!query.component) return null;
  const quantityId = resolveCanonicalQuantityId(query.quantityId);
  const scopeKind = query.scopeKind ?? "full";
  const scopeId = scopeKind === "full" ? null : query.scopeId ?? null;
  const match = ranges.find(
    (range) =>
      range.component === query.component &&
      (range.inspectionKey ?? null) === (query.inspectionKey ?? null) &&
      resolveCanonicalQuantityId(range.quantityId) === quantityId &&
      range.scopeKind === scopeKind &&
      range.scopeId === scopeId,
  );
  return match?.range ?? null;
}

function sameViewport3DScalarColorbarLegends(
  left: readonly Viewport3DScalarColorbarLegend[],
  right: readonly Viewport3DScalarColorbarLegend[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((legend, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      legend.label === other.label &&
      legend.maxLabel === other.maxLabel &&
      legend.minLabel === other.minLabel &&
      legend.paletteGradient === other.paletteGradient
    );
  });
}

function sameViewport3DRenderedScalarRanges(
  left: readonly Viewport3DRenderedScalarRange[],
  right: readonly Viewport3DRenderedScalarRange[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((range, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      range.component === other.component &&
      (range.inspectionKey ?? null) === (other.inspectionKey ?? null) &&
      range.quantityId === other.quantityId &&
      range.range.min === other.range.min &&
      range.range.max === other.range.max &&
      range.scopeId === other.scopeId &&
      range.scopeKind === other.scopeKind
    );
  });
}

function sameViewport3DCameraState(
  left: Viewport3DCameraState,
  right: Viewport3DCameraState,
): boolean {
  return (
    sameTuple3(left.position, right.position) &&
    sameTuple3(left.target, right.target) &&
    sameTuple3(left.up, right.up)
  );
}

function buildViewport3DAppearanceDiagnostics(
  widgets: Viewport3DWidgetState,
  profileId: Viewport3DVisualProfileId,
  postProcessingDataProtected = false,
  postProcessingAvailable = true,
): Viewport3DAppearanceDiagnostics {
  return resolveViewport3DAppearanceDiagnostics({
    ambientOcclusionRequested: widgets.effectAmbientOcclusion,
    antialiasRequested: widgets.effectAntialias,
    bloomRequested: widgets.effectBloom,
    profileAllowsAntialias: getViewport3DVisualProfile(profileId).antialias,
    postProcessingAvailable,
    postProcessingDataProtected,
  });
}

function sameViewport3DAppearanceDiagnostics(
  left: Viewport3DAppearanceDiagnostics,
  right: Viewport3DAppearanceDiagnostics,
): boolean {
  return sameViewport3DEffectDiagnostic(left.ambientOcclusion, right.ambientOcclusion) &&
    sameViewport3DEffectDiagnostic(left.bloom, right.bloom) &&
    sameViewport3DEffectDiagnostic(left.antialias, right.antialias);
}

function sameViewport3DEffectDiagnostic(
  left: Viewport3DAppearanceDiagnostics["ambientOcclusion"],
  right: Viewport3DAppearanceDiagnostics["ambientOcclusion"],
): boolean {
  return left.requested === right.requested &&
    left.effective === right.effective &&
    left.reason === right.reason;
}

function sameViewport3DAppearancePreferences(
  left: Viewport3DAppearancePreferences,
  right: Viewport3DAppearancePreferences,
): boolean {
  return left.backgroundMode === right.backgroundMode &&
    left.backgroundStrength === right.backgroundStrength &&
    left.lightingMode === right.lightingMode &&
    left.lightingIntensity === right.lightingIntensity &&
    left.lightingAzimuth === right.lightingAzimuth &&
    left.lightingElevation === right.lightingElevation &&
    left.lightingSpace === right.lightingSpace &&
    left.dimensionOrigin === right.dimensionOrigin &&
    left.gridOpacity === right.gridOpacity &&
    left.aoIntensity === right.aoIntensity &&
    left.aoRadius === right.aoRadius &&
    left.exportBackground === right.exportBackground &&
    left.exportAnnotations === right.exportAnnotations;
}

function samePersistedViewport3DPreferences(
  left: Viewport3DCommandState,
  right: Viewport3DCommandState,
): boolean {
  const a = left.widgets;
  const b = right.widgets;
  return sameViewport3DAppearancePreferences(left.appearance, right.appearance) &&
    left.visualProfileId === right.visualProfileId &&
    left.captureReturnProfileId === right.captureReturnProfileId &&
    a.dimensionFrameMode === b.dimensionFrameMode &&
    a.dimensionFrameDensity === b.dimensionFrameDensity &&
    a.dimensionFrameAnnotation === b.dimensionFrameAnnotation &&
    a.scaleUnitMode === b.scaleUnitMode &&
    a.scaleLabelsVisible === b.scaleLabelsVisible &&
    a.viewCubeVisible === b.viewCubeVisible &&
    a.hslReferenceMode === b.hslReferenceMode &&
    a.effectAmbientOcclusion === b.effectAmbientOcclusion &&
    a.effectBloom === b.effectBloom &&
    a.effectAntialias === b.effectAntialias;
}

export function viewport3DCameraViewSignature({
  camera,
  orthographicScale,
  projection,
}: {
  camera: Viewport3DCameraState;
  orthographicScale?: number | null;
  projection: Viewport3DCameraProjection;
}): string {
  return [
    ...camera.position,
    ...camera.target,
    ...camera.up,
    orthographicScale ?? "null",
    projection,
  ].join(":");
}

export function resolveHslReferenceVisible(
  mode: Viewport3DHslReferenceMode,
  vectorColorMode: string,
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return vectorColorMode === "orientation";
}

export function resolveViewport3DCameraState(
  visualizationState: Pick<VisualizationStateResource, "camera"> | null | undefined,
): Viewport3DCameraState {
  const camera = visualizationState?.camera;
  const position = vector3(camera?.position);
  const target = vector3(camera?.target);
  const up = vector3(camera?.up) ?? DEFAULT_VIEWPORT_3D_CAMERA_STATE.up;
  if (!position || !target) {
    return DEFAULT_VIEWPORT_3D_CAMERA_STATE;
  }
  return { position, target, up };
}

export function resolveViewport3DCameraProjection(
  visualizationState: Pick<VisualizationStateResource, "camera"> | null | undefined,
): Viewport3DCameraProjection {
  return visualizationState?.camera?.projection === "orthographic"
    ? "orthographic"
    : "perspective";
}

export function resolveViewport3DCameraOrthographicScale(
  visualizationState: Pick<VisualizationStateResource, "camera"> | null | undefined,
): number | null {
  return normalizeOrthographicScale(visualizationState?.camera?.orthographic_scale);
}

function vector3(value: readonly number[] | null | undefined): [number, number, number] | null {
  if (!value || value.length < 3) return null;
  const next: [number, number, number] = [
    Number(value[0]),
    Number(value[1]),
    Number(value[2]),
  ];
  return next.every(Number.isFinite) ? next : null;
}

function tuple3(value: readonly number[]): [number, number, number] {
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}

function normalizeOrthographicScale(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function normalizeFdmTopographyAmplitudeCells(value: number): number {
  return Number.isFinite(value) ? Math.max(-16, Math.min(16, value)) : 0;
}

/** Own immutable carrier only; never returns another target's last presentation. */
export function useViewport3DArtifactInspectionPresentation(key: string | null): Viewport3DArtifactInspectionPresentation | null {
  const getSnapshot = useCallback(() => viewport3dStore.getArtifactInspectionPresentation(key), [key]);
  return useSyncExternalStore(listener => viewport3dStore.subscribe(listener), getSnapshot, () => null);
}
