import {
  ACESFilmicToneMapping,
  NoToneMapping,
  SRGBColorSpace,
  type WebGLRenderer,
} from "three";

export type Viewport3DVisualProfileId =
  | "interactive-lite"
  | "interactive"
  | "balanced"
  | "figure"
  | "capture";

export interface Viewport3DVisualProfile {
  id: Viewport3DVisualProfileId;
  label: string;
  antialias: boolean;
  captureScale: number;
  dprCap: number;
  edgeBoost: number;
  edgeOpacity: number;
  glyphBudget: number;
  lighting: "minimal" | "studio" | "figure";
  preserveDrawingBuffer: boolean;
  toneMapping: "none" | "aces";
  toneMappingExposure: number;
  voxelFillRatio: number;
  voxelMagnitudeThreshold: number;
  voxelTopography: {
    amplitudeCells: number;
    component: "magnitude" | "x" | "y" | "z";
    enabled: boolean;
  };
}

export const DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID: Viewport3DVisualProfileId =
  "interactive";

const VIEWPORT_3D_VISUAL_PROFILES: Record<
  Viewport3DVisualProfileId,
  Viewport3DVisualProfile
> = {
  "interactive-lite": {
    id: "interactive-lite",
    label: "Interactive Lite",
    antialias: false,
    captureScale: 1,
    dprCap: 1,
    edgeBoost: 0.85,
    edgeOpacity: 0.3,
    glyphBudget: 700,
    lighting: "minimal",
    preserveDrawingBuffer: false,
    toneMapping: "none",
    toneMappingExposure: 1,
    voxelFillRatio: 1,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "z",
      enabled: false,
    },
  },
  interactive: {
    id: "interactive",
    label: "Interactive",
    antialias: true,
    captureScale: 1,
    dprCap: 1.25,
    edgeBoost: 1,
    edgeOpacity: 0.42,
    glyphBudget: 1_200,
    lighting: "minimal",
    preserveDrawingBuffer: false,
    toneMapping: "none",
    toneMappingExposure: 1,
    voxelFillRatio: 1,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "z",
      enabled: false,
    },
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    antialias: true,
    captureScale: 1,
    dprCap: 1.5,
    edgeBoost: 1.1,
    edgeOpacity: 0.55,
    glyphBudget: 2_000,
    lighting: "minimal",
    preserveDrawingBuffer: false,
    toneMapping: "none",
    toneMappingExposure: 1,
    voxelFillRatio: 1,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "z",
      enabled: false,
    },
  },
  figure: {
    id: "figure",
    label: "Figure",
    antialias: true,
    captureScale: 2,
    dprCap: 2,
    edgeBoost: 1.25,
    edgeOpacity: 0.72,
    glyphBudget: 2_800,
    lighting: "minimal",
    preserveDrawingBuffer: false,
    toneMapping: "none",
    toneMappingExposure: 1,
    voxelFillRatio: 1,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "z",
      enabled: false,
    },
  },
  capture: {
    id: "capture",
    label: "Capture",
    antialias: true,
    captureScale: 4,
    dprCap: 2,
    edgeBoost: 1.35,
    edgeOpacity: 0.82,
    glyphBudget: 3_200,
    lighting: "minimal",
    preserveDrawingBuffer: true,
    toneMapping: "none",
    toneMappingExposure: 1,
    voxelFillRatio: 1,
    voxelMagnitudeThreshold: 0,
    voxelTopography: {
      amplitudeCells: 0,
      component: "z",
      enabled: false,
    },
  },
};

export function getViewport3DVisualProfile(
  id: Viewport3DVisualProfileId | null | undefined,
): Viewport3DVisualProfile {
  return VIEWPORT_3D_VISUAL_PROFILES[
    id ?? DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID
  ];
}

export function resolveViewport3DCanvasDpr({
  devicePixelRatio,
  profile,
}: {
  devicePixelRatio: number;
  profile: Viewport3DVisualProfile;
}): number {
  const safeRatio = Number.isFinite(devicePixelRatio)
    ? Math.max(1, devicePixelRatio)
    : 1;
  return Math.min(safeRatio, profile.dprCap);
}

/**
 * S-15: the user-facing "Antialiasing" toggle previously never reached the
 * WebGL context -- `antialiasOverride` was accepted and explicitly discarded
 * (`void _antialiasOverride`), so context MSAA followed the visual profile
 * alone. The flag was only read by PostProcessingLayer as the composer's
 * `multisampling`, and the composer does not exist at all while both effects
 * are off, which made the toggle a no-op in the default (no-effect) mode and
 * made enabling Bloom/AO silently change edge quality.
 *
 * The override is now honored, with the profile keeping its veto: it can turn
 * antialiasing OFF anywhere, and can turn it ON only where the profile allows
 * it (`interactive-lite` deliberately runs without MSAA for performance, and
 * must stay that way regardless of the toggle). Omitting the argument keeps
 * the pure profile-owned behavior.
 */
export function resolveViewport3DCanvasGlOptions(
  profile: Viewport3DVisualProfile,
  antialiasOverride?: boolean,
): {
  alpha: false;
  antialias: boolean;
  powerPreference: "high-performance";
  preserveDrawingBuffer: boolean;
} {
  return {
    alpha: false,
    antialias: profile.antialias && (antialiasOverride ?? true),
    powerPreference: "high-performance",
    preserveDrawingBuffer: profile.preserveDrawingBuffer,
  };
}

export function configureViewport3DRenderer(
  renderer: WebGLRenderer,
  profile: Viewport3DVisualProfile,
): void {
  if (profile.toneMapping === "aces") {
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = profile.toneMappingExposure;
  } else {
    renderer.toneMapping = NoToneMapping;
    renderer.toneMappingExposure = 1;
  }
  renderer.outputColorSpace = SRGBColorSpace;
}
