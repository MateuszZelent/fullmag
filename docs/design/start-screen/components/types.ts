/**
 * Types for the start screen, mirroring schema/recent-index.schema.json and
 * schema/project-manifest.schema.json.
 *
 * Reference implementation — intended to live at
 * apps/control-room/src/modules/start/model/types.ts
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

export type DocumentMode = "read_write" | "read_only";

export type AuthorRole = "creator" | "contributor" | "maintainer";

export interface Author {
  readonly name: string;
  readonly email?: string;
  readonly affiliation?: string;
  readonly orcid?: string;
  readonly role: AuthorRole;
}

/** Denormalised model facts, written on save so the inspector renders without
 *  opening the archive. Treated as a hint: opening re-reads the manifest. */
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
  /** null when no meaningful estimate exists — render nothing, not a guess. */
  readonly etaSeconds?: number | null;
}

export interface ContinueSession {
  readonly projectId: string;
  readonly runId: string;
  readonly checkpointAt: string;
  readonly device?: string;
  readonly progress: RunProgress;
  /** Computed on THIS machine (build + device), never copied from the file. */
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

/** The index is derived state; any of these is recoverable by rescanning. */
export type RecentIndexState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly index: RecentIndex }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly message: string };

/* ── History & runs (from the project manifest) ─────────────────────────── */

export type HistoryKind = "edit" | "run" | "migrate" | "import" | "restore";

export interface HistoryEntry {
  readonly revision: number;
  readonly at: string;
  readonly by?: string;
  readonly kind: HistoryKind;
  readonly summary: string;
  readonly changes?: readonly string[];
  readonly runId?: string;
  readonly restorable?: boolean;
}

export type RunStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface RunRecord {
  readonly runId: string;
  readonly revision?: number;
  readonly startedAt: string;
  readonly finishedAt?: string | null;
  readonly durationSeconds?: number | null;
  readonly status: RunStatus;
  readonly device?: string;
  readonly backend?: string;
  readonly outputBytes?: number;
  readonly frames?: number;
  readonly error?: string | null;
}

/* ── Compute environment ────────────────────────────────────────────────── */

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

/* ── Start screen UI state ──────────────────────────────────────────────── */

export type StartSection =
  | "home"
  | "templates"
  | "import"
  | "learn"
  | "settings"
  | "about";

export type InspectorTab = "overview" | "authors" | "history" | "runs";

export type RecentFilter = "all" | "fdm" | "fem" | "pinned";

export type RecentSort = "lastOpened" | "name" | "created" | "size" | "lastRun";

export interface StartScreenState {
  readonly section: StartSection;
  readonly view: "list" | "grid";
  readonly filter: RecentFilter;
  readonly sort: RecentSort;
  readonly query: string;
  readonly selectedProjectId: string | null;
  readonly inspectorTab: InspectorTab;
  readonly inspectorVisible: boolean;
}
