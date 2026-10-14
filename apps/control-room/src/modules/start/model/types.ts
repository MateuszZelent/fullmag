import type { ComputeNodesState } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

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
  readonly index?: number;
  readonly cudaVersion?: string;
  readonly vramTotalBytes: number;
  readonly vramFreeBytes: number;
  readonly busyWithRun?: string;
  readonly utilizationPercent?: number;
  readonly temperatureC?: number;
}

export interface ComputeRuntimeLane {
  readonly backend: SolverKind;
  readonly device: "CPU" | "GPU";
  readonly availability: "available" | "unavailable" | "unknown";
  readonly precisions: readonly string[];
  readonly reason?: string;
}

export interface ComputeEnvironment {
  readonly gpus: readonly GpuInfo[];
  readonly cpuThreads: number;
  readonly preferredBackend: "cuda" | "cpu";
  readonly warnings: readonly string[];
  readonly source?: "runtime" | "desktop";
  readonly gpuProbeStatus?: "ready" | "unavailable";
  readonly cpuProbeStatus?: "ready" | "unavailable";
  readonly cpuName?: string;
  readonly cpuUtilizationPercent?: number;
  readonly memoryTotalBytes?: number;
  readonly memoryUsedBytes?: number;
  readonly sampledAt?: number;
  readonly runtimeLanes?: readonly ComputeRuntimeLane[];
}

/**
 * `undefined` while the initial reading is in flight, `null` when neither
 * runtime telemetry nor the desktop host can supply an inventory.
 */
export type ComputeProbeState = ComputeEnvironment | null | undefined;

export type ComputeNodeFactStatus = "available" | "last_known" | "unavailable";

export interface ComputeNodeFact<T> {
  readonly status: ComputeNodeFactStatus;
  readonly value: T | null;
}

export type ComputeNodeGpuPartition =
  | { readonly kind: "full_device" }
  | { readonly kind: "mig"; readonly parentGpuUuid: string; readonly partitionId: string }
  | { readonly kind: "unknown" };

export interface ComputeNodeGpuSummary {
  readonly uuid: string;
  readonly name: ComputeNodeFact<string>;
  readonly pciId: ComputeNodeFact<string>;
  readonly vramBytes: ComputeNodeFact<number>;
  readonly partition: ComputeNodeFact<ComputeNodeGpuPartition>;
  readonly numaNodeId: ComputeNodeFact<number>;
}

export interface ComputeNodeCpuTopologySummary {
  readonly logicalProcessorCount: number;
  readonly logicalCpuIds: readonly number[];
  readonly socketIds: readonly number[];
  readonly numaNodeIds: readonly number[];
  readonly physicalCoreCount: number | null;
}

export type ComputeNodeEnforcementStatus = "supported" | "advisory" | "unavailable";

export interface ComputeNodeSnapshotSummary {
  readonly nodeId: string;
  readonly inventoryRevision: number;
  readonly sample: {
    readonly source: string | null;
    readonly collectedAt: string | null;
    readonly freshness: string | null;
  };
  readonly cpu: {
    readonly topology: ComputeNodeFact<ComputeNodeCpuTopologySummary>;
    readonly allowedLogicalProcessorIds: ComputeNodeFact<readonly number[]>;
    readonly effectiveCapacityMillis: number | null;
    readonly effectiveCapacityAvailable: boolean;
    readonly quota: ComputeNodeFact<
      | { readonly mode: "unlimited" }
      | { readonly mode: "limited"; readonly capacityMillis: number }
    >;
  };
  readonly memory: {
    readonly totalBytes: number | null;
    readonly availableBytes: number | null;
  };
  readonly gpus: ComputeNodeFact<readonly ComputeNodeGpuSummary[]>;
  readonly enforcement: {
    readonly cpuAffinity: ComputeNodeEnforcementStatus | null;
    readonly cpuQuota: ComputeNodeEnforcementStatus | null;
    readonly memoryCap: ComputeNodeEnforcementStatus | null;
    readonly gpuVisibility: ComputeNodeEnforcementStatus | null;
    readonly storageQuota: ComputeNodeEnforcementStatus | null;
  };
}

export interface ComputeNodePolicySummary {
  readonly revision: number;
  readonly activeWorkers: number;
  readonly maxParallelWorkers: number;
  readonly draining: boolean;
  readonly overBudget: boolean;
  readonly blockingReasons: readonly string[];
  readonly allowedCpuIds: readonly number[];
  readonly allowedGpuUuids: readonly string[];
  readonly cpuReserveMillis: number;
  readonly memoryReserveBytes: number;
  readonly scratchReserveBytes: number;
  readonly gpuVramReserves: Readonly<Record<string, number>>;
  readonly priorityOrder: readonly number[];
  readonly parallelismPatternCount: number;
}

export interface ComputeNodeInventoryNodeSummary {
  readonly nodeId: string;
  readonly state: ComputeNodesState;
  readonly snapshot: ComputeNodeSnapshotSummary | null;
  readonly nodePolicy: ComputeNodePolicySummary | null;
}

export interface ComputeNodeInventorySummary {
  readonly hasSnapshot: boolean;
  readonly nodeCount: number;
  readonly nodes: readonly ComputeNodeInventoryNodeSummary[];
  readonly refreshFailed: boolean;
  readonly resourceStatus: ResourceStatus;
  readonly staleAfterSeconds: number | null;
  readonly state: ComputeNodesState | null;
}

export interface ComputeProbeController {
  readonly compute: ComputeProbeState;
  readonly nodeInventory: ComputeNodeInventorySummary;
  readonly refreshing: boolean;
  readonly stale: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

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
  /** Id of the workspace database item behind this entry, when the HTTP API served it. */
  readonly workspaceId?: string;
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
