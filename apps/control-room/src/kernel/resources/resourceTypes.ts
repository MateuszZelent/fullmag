import type { ResourceRevision } from "../api/apiTypes";

export type ResourceKey = string;

export type ResourceStatus = "idle" | "loading" | "ready" | "stale" | "error";

export type ResourceExecutionState =
  | "not_started"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type ResourceAvailability =
  | "available"
  | "partial"
  | "unavailable"
  | "unsupported";

export interface ResourceStateFacets {
  availability: ResourceAvailability;
  executionState: ResourceExecutionState;
  resourceState: ResourceStatus;
}

export interface ResourceResult<TData> {
  data: TData | null;
  error: Error | null;
  refetch: () => void;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}
