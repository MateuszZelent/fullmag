export type ViewportQualityProfileId =
  | "interactive-lite"
  | "interactive"
  | "balanced"
  | "figure"
  | "capture";

export interface ViewportQualityProfile {
  id: ViewportQualityProfileId;
  label: string;
  dprCap: number;
  antialias: boolean;
  preserveDrawingBuffer: boolean;
  toneMapping: "none" | "aces";
  edgeOpacity: number;
  edgeBoost: number;
  glyphBudget: number;
  allowHeavyTransparency: boolean;
  captureScale: number;
}

export const VIEWPORT_QUALITY_PROFILES: Record<ViewportQualityProfileId, ViewportQualityProfile> = {
  "interactive-lite": {
    id: "interactive-lite",
    label: "Interactive Lite",
    dprCap: 1,
    antialias: false,
    preserveDrawingBuffer: false,
    toneMapping: "none",
    edgeOpacity: 0.3,
    edgeBoost: 0.85,
    glyphBudget: 700,
    allowHeavyTransparency: false,
    captureScale: 1,
  },
  interactive: {
    id: "interactive",
    label: "Interactive",
    dprCap: 1.25,
    antialias: true,
    preserveDrawingBuffer: false,
    toneMapping: "aces",
    edgeOpacity: 0.42,
    edgeBoost: 1.0,
    glyphBudget: 1200,
    allowHeavyTransparency: false,
    captureScale: 1,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    dprCap: 1.5,
    antialias: true,
    preserveDrawingBuffer: false,
    toneMapping: "aces",
    edgeOpacity: 0.55,
    edgeBoost: 1.1,
    glyphBudget: 2000,
    allowHeavyTransparency: true,
    captureScale: 1,
  },
  figure: {
    id: "figure",
    label: "Figure",
    dprCap: 2,
    antialias: true,
    preserveDrawingBuffer: false,
    toneMapping: "aces",
    edgeOpacity: 0.72,
    edgeBoost: 1.25,
    glyphBudget: 2800,
    allowHeavyTransparency: true,
    captureScale: 2,
  },
  capture: {
    id: "capture",
    label: "Capture",
    dprCap: 2,
    antialias: true,
    preserveDrawingBuffer: true,
    toneMapping: "aces",
    edgeOpacity: 0.82,
    edgeBoost: 1.35,
    glyphBudget: 3200,
    allowHeavyTransparency: true,
    captureScale: 4,
  },
};

export function getViewportQualityProfile(
  id: ViewportQualityProfileId | null | undefined,
): ViewportQualityProfile {
  return VIEWPORT_QUALITY_PROFILES[id ?? "interactive"];
}
