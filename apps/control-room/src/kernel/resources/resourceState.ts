import type { ResourceRevision } from "../api/apiTypes";

import type { ResourceStatus } from "./resourceTypes";

export interface ResourceState<TData> {
  data: TData | null;
  error: Error | null;
  /**
   * LR-09: błąd zakończonego odświeżenia, gdy poprzednie dane są nadal
   * pokazywane. `error` jest wtedy zerowane, żeby konsumenci dalej
   * renderowali ostatnią dobrą klatkę; ten kanał niesie informację, że
   * odświeżenie zawiodło, zamiast udawać zwykłe pobieranie.
   */
  refreshError?: Error | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export function markResourceLoading<TData>(
  current: ResourceState<TData>,
  revision: ResourceRevision | null,
): ResourceState<TData> {
  const retainedRefreshError = current.data
    ? current.error ?? current.refreshError ?? null
    : null;
  return {
    data: current.data,
    error: null,
    revision,
    status: current.data ? "stale" : "loading",
    ...(retainedRefreshError ? { refreshError: retainedRefreshError } : {}),
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
    refreshError: undefined,
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
