import type { ResourceRevision } from "../api/apiTypes";

export type ResourceKey = string;

export type ResourceStatus = "idle" | "loading" | "ready" | "stale" | "error";

export interface ResourceResult<TData> {
  data: TData | null;
  error: Error | null;
  refetch: () => void;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}
