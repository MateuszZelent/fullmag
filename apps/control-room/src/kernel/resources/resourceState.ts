import type { ResourceRevision } from "../api/apiTypes";

import type { ResourceStatus } from "./resourceTypes";

export interface ResourceState<TData> {
  data: TData | null;
  /**
   * Revision of the payload currently held in `data`. Unlike `revision`,
   * which follows the external revision being loaded while the resource is
   * `stale`, this value changes only when new data settles. Build caches,
   * GPU uploads and memo keys that describe the visible payload must use
   * this identity (see `resourceDataRevision`); otherwise every refresh
   * invalidates them twice and the last good frame is dropped.
   */
  dataRevision?: ResourceRevision | null;
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

/**
 * Identity of the data a resource currently shows: stable while a newer
 * revision loads in the background, `null` when there is no data.
 */
export function resourceDataRevision(
  state: Pick<ResourceState<unknown>, "data" | "dataRevision" | "revision">,
): ResourceRevision | null {
  if (state.data === null || state.data === undefined) return null;
  return state.dataRevision !== undefined ? state.dataRevision : state.revision;
}

/**
 * `ready` and `stale` both carry a settled payload; `stale` only means a
 * newer revision is loading in the background. Gating rendering on
 * `status === "ready"` alone blanks the view on every refresh.
 */
export function isDisplayableResourceStatus(status: ResourceStatus): boolean {
  return status === "ready" || status === "stale";
}

/** True when the resource holds data that may be displayed (ready or stale). */
export function resourceHasDisplayableData(
  state: Pick<ResourceState<unknown>, "data" | "status">,
): boolean {
  return (
    state.data !== null &&
    state.data !== undefined &&
    isDisplayableResourceStatus(state.status)
  );
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
    dataRevision: resourceDataRevision(current),
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
    dataRevision: revision,
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
