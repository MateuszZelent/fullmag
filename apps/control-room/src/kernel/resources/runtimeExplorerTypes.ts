import type { ResourceStatus } from "./resourceTypes";

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

export interface RuntimeExplorerDetail {
  cache: string | null;
  category: "diagnostic" | "job" | "resource";
  contractGap: boolean;
  facts: readonly RuntimeExplorerFact[];
  generation: string | null;
  key: string;
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
