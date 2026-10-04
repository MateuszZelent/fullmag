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

export type DocumentMode = "read_write" | "read_only";

export type AuthorRole = "creator" | "contributor" | "maintainer";

export interface Author {
  readonly name: string;
  readonly email?: string;
  readonly affiliation?: string;
  readonly orcid?: string;
  readonly role: AuthorRole;
}

/** Denormalised model facts written on save; a hint, re-read on open. */
export interface ModelSummary {
  readonly discretisation?: string;
  readonly cellSize?: string;
  readonly periodicity?: string;
  readonly materials?: readonly string[];
  readonly ms?: string;
  readonly aex?: string;
  readonly alpha?: string;
  readonly interactions?: readonly string[];
  readonly integrator?: string;
  readonly tolerance?: string;
  readonly excitation?: string;
  readonly outputFrames?: number;
  readonly outputBytes?: number;
  readonly outputFields?: readonly string[];
}

export interface RecentEntry {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly solver: SolverKind;
  readonly status: ProjectStatus;
  readonly lastOpenedAt: string;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly sizeBytes?: number;
  readonly revision?: number;
  readonly manifestSchemaVersion?: string;
  readonly createdWithVersion?: string;
  readonly mode?: DocumentMode;
  readonly modeReason?: string;
  readonly pinned?: boolean;
  readonly tags?: readonly string[];
  readonly thumbnail?: string;
  readonly lastError?: string;
  readonly summary?: ModelSummary;
  readonly authors?: readonly Author[];
}

export interface RunProgress {
  readonly fraction: number;
  readonly simTimeS?: number;
  readonly simTimeTotalS?: number;
  readonly framesWritten?: number;
  readonly framesTotal?: number;
  /** null when no meaningful estimate exists: render nothing, not a guess. */
  readonly etaSeconds?: number | null;
}

export interface ContinueSession {
  readonly projectId: string;
  readonly runId: string;
  readonly checkpointAt: string;
  readonly device?: string;
  readonly progress: RunProgress;
  /** Computed on this machine, never copied from the file. */
  readonly resumable: boolean;
  readonly notResumableReason?: string;
}

export interface ScannedLocation {
  readonly path: string;
  readonly recursive?: boolean;
  readonly lastScannedAt?: string;
  readonly reachable?: boolean;
}

export interface RecentIndex {
  readonly formatVersion: 1;
  readonly generatedAt: string;
  readonly scannedLocations?: readonly ScannedLocation[];
  readonly continue?: ContinueSession;
  readonly entries: readonly RecentEntry[];
}

/**
 * The index is derived state: every failure here is recoverable by rescanning
 * and none of them may disable creating or opening a project.
 */
export type RecentIndexState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly index: RecentIndex }
  | { readonly kind: "empty" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly message: string };

export type RecentFilter = "all" | "fdm" | "fem" | "pinned";

export type RecentSort = "lastOpened" | "name" | "created" | "size";

export type InspectorTab = "overview" | "authors" | "history" | "runs";
