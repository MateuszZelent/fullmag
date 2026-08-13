import type { ResourceStatus } from "./resourceTypes";
import type { CommandDetailResource } from "../api/apiTypes";

export interface RuntimeCommandDetailEntry {
  commandId: string;
  data: CommandDetailResource | null;
  error: string | null;
  missing: boolean;
  revision: number | null;
  status: "error" | "ready" | "unavailable";
}

export interface RuntimeExecutionDetail {
  backend: string | null;
  device: string | null;
  engineId: string | null;
  mode: string | null;
  precision: string | null;
  runtimeFamily: string | null;
  worker: string | null;
}

export interface RuntimeExplorerFact {
  label: string;
  value: string;
}

export type RuntimeExplorerCondition =
  | "degraded"
  | "failed"
  | "ready"
  | "stale"
  | "unavailable"
  | "unsupported"
  | "warning";

export interface RuntimeExplorerDetail {
  cache: string | null;
  category: "diagnostic" | "job" | "resource";
  condition: RuntimeExplorerCondition;
  contractGap: boolean;
  facts: readonly RuntimeExplorerFact[];
  generation: string | null;
  key: string;
  lifecycleStatus: string | null;
  location: string | null;
  message: string | null;
  owner: string | null;
  requestedExecution: RuntimeExecutionDetail | null;
  resolvedExecution: RuntimeExecutionDetail | null;
  revision: number | string | null;
  schema: string | null;
  sizeBytes: number | null;
  sourceStatus: ResourceStatus | "unavailable";
}
