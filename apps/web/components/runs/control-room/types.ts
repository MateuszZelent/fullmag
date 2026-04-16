/* ── ControlRoom exported types ──
 * Data-only interfaces that are used outside the provider. */

export interface ActivityInfo {
  label: string;
  detail: string;
  progressMode: "idle" | "indeterminate" | "determinate";
  progressValue: number | undefined;
}

export interface MaterialSummary {
  msat: number | null;
  aex: number | null;
  alpha: number | null;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  zeemanField: number[] | null;
  name: string | null;
}

export interface SolverAdaptiveSummary {
  atol: number | null;
  dtInitial: number | null;
  dtMin: number | null;
  dtMax: number | null;
  safety: number | null;
}

export interface SolverRelaxationSummary {
  algorithm: string | null;
  torqueTolerance: number | null;
  energyTolerance: number | null;
  maxSteps: number | null;
}

export interface SolverLinearSolverSummary {
  family: string | null;
  method: string | null;
  preconditioner: string | null;
  relativeTolerance: number | null;
  absoluteTolerance: number | null;
  maxIterations: number | null;
  printLevel: number | null;
}

export interface SolverPlanSummary {
  backendKind: string | null;
  requestedBackend: string | null;
  resolvedBackend: string | null;
  executionMode: string | null;
  precision: string | null;
  integrator: string | null;
  fixedTimestep: number | null;
  adaptive: SolverAdaptiveSummary | null;
  relaxation: SolverRelaxationSummary | null;
  gyromagneticRatio: number | null;
  exchangeBoundary: string | null;
  externalField: [number, number, number] | null;
  exchangeEnabled: boolean;
  demagEnabled: boolean;
  cellSize: [number, number, number] | null;
  gridCells: [number, number, number] | null;
  meshName: string | null;
  meshSource: string | null;
  feOrder: number | null;
  hmax: number | null;
  demagSolver: SolverLinearSolverSummary | null;
  materialName: string | null;
  materialMsat: number | null;
  materialAex: number | null;
  materialAlpha: number | null;
  notes: string[];
}

export interface PreviewOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface QuickPreviewTarget {
  id: string;
  shortLabel: string;
  available: boolean;
}

export interface SessionFooterData {
  requestedBackend: string | null;
  scriptPath: string | null;
  artifactDir: string | null;
}

export interface FieldStats {
  meanX: number; meanY: number; meanZ: number;
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface MeshQualitySummary {
  min: number; max: number; mean: number;
  good: number; fair: number; poor: number;
  count: number;
}

export interface BackendErrorInfo {
  timestampUnixMs: number;
  level: string;
  title: string;
  summary: string;
  details: string;
  traceback: string | null;
}
