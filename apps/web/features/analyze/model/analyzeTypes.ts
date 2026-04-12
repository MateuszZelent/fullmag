/**
 * Analyze feature – domain model types.
 *
 * Re-exports the canonical AnalyzeSelectionState and extends with
 * feature-local query and result types.
 */
export type {
  AnalyzeSelectionState,
  AnalyzeTab,
  AnalyzeDomain,
} from "@/components/runs/control-room/analyzeSelection";

/* ── Query descriptors ── */

export interface AnalyzeQueryKey {
  domain: "eigenmodes" | "vortex";
  tab: string;
  /** Mode / branch / sample index — drives cache identity */
  selectionFingerprint: string;
  refreshNonce: number;
}

export type AnalyzeQueryStatus = "idle" | "loading" | "success" | "error";

export interface AnalyzeQueryState<T = unknown> {
  status: AnalyzeQueryStatus;
  data: T | null;
  error: string | null;
  requestedAt: number | null;
  completedAt: number | null;
}

/* ── Eigen result payloads ── */

export interface EigenSpectrumResult {
  modes: Array<{
    index: number;
    frequency_ghz: number;
    damping: number | null;
    polarization: string | null;
  }>;
  kSampling: "single" | "path";
  sampleCount: number;
}

export interface EigenModeResult {
  modeIndex: number;
  frequency_ghz: number;
  realField: Float64Array | null;
  imagField: Float64Array | null;
  amplitude: Float64Array | null;
  phase: Float64Array | null;
}

/* ── Vortex result payloads ── */

export interface VortexTimeTraceResult {
  time: number[];
  mx: number[];
  my: number[];
  mz: number[];
}

export interface VortexFrequencyResult {
  frequency: number[];
  psd_mx: number[];
  psd_my: number[];
  psd_mz: number[];
  peaks: Array<{ freq: number; power: number; channel: string }>;
}

export interface VortexOrbitResult {
  xc: number[];
  yc: number[];
  meanRadius: number | null;
  ellipticity: number | null;
  chirality: "cw" | "ccw" | null;
}
