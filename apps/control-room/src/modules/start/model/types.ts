/**
 * Start screen types, mirroring docs/design/start-screen/schema/*.schema.json.
 * Only the shapes the shipped steps render are ported; the recent index and
 * manifest provenance types arrive with the steps that consume them.
 */

export type SolverKind = "FDM" | "FEM";

export type ProjectStatus =
  | "ready"
  | "running"
  | "failed"
  | "draft"
  | "migrate"
  | "missing"
  | "readonly";

export interface GpuInfo {
  readonly name: string;
  readonly cudaVersion?: string;
  readonly vramTotalBytes: number;
  readonly vramFreeBytes: number;
  readonly busyWithRun?: string;
}

export interface ComputeEnvironment {
  readonly gpus: readonly GpuInfo[];
  readonly cpuThreads: number;
  readonly preferredBackend: "cuda" | "cpu";
  readonly warnings: readonly string[];
}

/**
 * `undefined` while a probe is in flight, `null` when this host cannot probe
 * at all (the browser build, or a desktop host without `compute_probe`).
 */
export type ComputeProbeState = ComputeEnvironment | null | undefined;
