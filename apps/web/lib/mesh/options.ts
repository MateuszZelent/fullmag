/**
 * Canonical mesh options types and defaults.
 *
 * These types are shared between the state/context layer and the UI components.
 * They live here (lib/mesh/) so that the context layer does NOT import from UI
 * component files, which would create an inverted dependency.
 */

/* ── Size field spec for lasso refinement zones ─────────────────────────── */

export interface SizeFieldSpec {
  kind: string;
  params: Record<string, number | number[] | string>;
}

/* ── Mesh options state ──────────────────────────────────────────────────── */

export interface MeshOptionsState {
  algorithm2d: number;
  algorithm3d: number;
  hmax: string;          // stored as SI metres; edited in the UI as nanometres
  hmin: string;          // stored as SI metres; edited in the UI as nanometres
  sizeFactor: number;
  sizeFromCurvature: number;
  growthRate: string;    // "" = Gmsh default (1.8), otherwise float [1.1–3.0]
  narrowRegions: number; // 0 = off, 1+ = min elements across narrow gap
  smoothingSteps: number;
  optimize: string;      // "" = none, "Netgen", "HighOrder", "Laplace2D", etc.
  optimizeIters: number;
  computeQuality: boolean;
  perElementQuality: boolean;
  refinementZones: SizeFieldSpec[]; // lasso refinement zones

  // Interface & transition (COMSOL-like region controls)
  interfaceHMax: string;        // SI metres — element size at mag-air interface
  interfaceThickness: string;   // SI metres — shell thickness for interface refinement
  transitionDistance: string;    // SI metres — distance over which sizing grades to airbox
  transitionGrowth: string;     // growth rate within transition zone ("" = default 1.5)

  // Adaptive Mesh (AFEM)
  adaptiveEnabled: boolean;
  adaptivePolicy: string;
  adaptiveTheta: number;
  adaptiveHMin: string;  // stored as SI metres; edited in the UI as nanometres
  adaptiveHMax: string;  // stored as SI metres; edited in the UI as nanometres
  adaptiveMaxPasses: number;
  adaptiveErrorTolerance: string;
}

/* ── Mesh quality data (frontend representation of backend quality stats) ── */

export interface MeshQualityData {
  nElements: number;
  sicnMin: number;
  sicnMax: number;
  sicnMean: number;
  sicnP5: number;
  sicnHistogram: number[];
  gammaMin: number;
  gammaMean: number;
  gammaHistogram: number[];
  volumeMin: number;
  volumeMax: number;
  volumeMean: number;
  volumeStd: number;
  avgQuality: number;
}

/* ── Default mesh options ────────────────────────────────────────────────── */

export const DEFAULT_MESH_OPTIONS: MeshOptionsState = {
  algorithm2d: 6,
  algorithm3d: 1,
  hmax: "",
  hmin: "",
  sizeFactor: 1.0,
  sizeFromCurvature: 0,
  growthRate: "",
  narrowRegions: 0,
  smoothingSteps: 1,
  optimize: "",
  optimizeIters: 1,
  computeQuality: false,
  perElementQuality: false,
  refinementZones: [],
  interfaceHMax: "",
  interfaceThickness: "",
  transitionDistance: "",
  transitionGrowth: "",
  adaptiveEnabled: false,
  adaptivePolicy: "auto",
  adaptiveTheta: 0.3,
  adaptiveHMin: "",
  adaptiveHMax: "",
  adaptiveMaxPasses: 2,
  adaptiveErrorTolerance: "1e-3",
};
