import type { ResourceRevision } from "../api/apiTypes";

import type { ResourceStatus } from "./resourceTypes";

export interface ResourceState<TData> {
  data: TData | null;
  error: Error | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export function markResourceLoading<TData>(
  current: ResourceState<TData>,
  revision: ResourceRevision | null,
): ResourceState<TData> {
  return {
    data: current.data,
    error: null,
    revision,
    status: current.data ? "stale" : "loading",
  };
}

export function markResourceReady<TData>(
  current: ResourceState<TData>,
  data: TData,
  revision: ResourceRevision | null,
): ResourceState<TData> {
  return {
    ...current,
    data,
    error: null,
    revision,
    status: "ready",
  };
}

export function markResourceError<TData>(
  current: ResourceState<TData>,
  error: Error,
): ResourceState<TData> {
  return {
    ...current,
    error,
    status: "error",
  };
}
