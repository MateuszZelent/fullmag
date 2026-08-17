"use client";

import { useCallback, useMemo } from "react";

import { DATA_FIELD_AVAILABILITY_PATH } from "../api/apiPaths";
import type {
  FieldAvailabilityQuery,
  FieldAvailabilityResource,
  ResourceRevision,
} from "../api/apiTypes";
import { resolveCanonicalQuantityId } from "../api/quantityIds";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";
import type { ResourceResult } from "./resourceTypes";

const FIELD_AVAILABILITY_QUERY_ORDER = [
  "target_id",
  "scope_kind",
  "scope_id",
  "owner_object_id",
] as const satisfies readonly (keyof FieldAvailabilityQuery)[];

export interface FieldAvailabilityResourceOptions
  extends FieldAvailabilityQuery {
  enabled?: boolean;
  quantityId: string;
}

export type FieldAvailabilityResourceResult = ResourceResult<
  FieldAvailabilityResource | null
>;

export type FieldAvailabilityDataState =
  | "ready"
  | "partial"
  | "pending"
  | "unavailable";

export type FieldAvailabilityResultState =
  | FieldAvailabilityDataState
  | "error";

/**
 * Build the stable identity for one target/scope availability resource.
 * Optional query values are normalized so equivalent whitespace does not
 * create separate cache entries.
 */
export function resolveFieldAvailabilityResourceKey(
  quantityId: string,
  query: FieldAvailabilityQuery = {},
): string {
  const path = DATA_FIELD_AVAILABILITY_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(resolveCanonicalQuantityId(quantityId)),
  );
  const params = new URLSearchParams();
  for (const key of FIELD_AVAILABILITY_QUERY_ORDER) {
    const value = normalizeAvailabilityQueryValue(key, query[key]);
    if (value !== undefined) params.set(key, value);
  }
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

/**
 * Availability revisions are target-scoped field revisions. The carrier
 * generation remains a stable fallback for pending/unmaterialized resources
 * that do not yet have a field revision.
 */
export function resolveFieldAvailabilityRevision(
  data: FieldAvailabilityResource | null | undefined,
): ResourceRevision | null {
  return data?.revision ?? data?.generation ?? null;
}

/**
 * Map the backend availability facts without treating a successful pending
 * response as a transport error. Transport failures remain `error` in the
 * outer ResourceResult and are handled by `resolveFieldAvailabilityResultState`.
 */
export function resolveFieldAvailabilityDataState(
  data: FieldAvailabilityResource | null | undefined,
): FieldAvailabilityDataState {
  if (!data || data.pending || data.state === "materializing") {
    return "pending";
  }
  if (!data.supported || data.state === "unavailable") {
    return "unavailable";
  }
  if (!data.materialized || data.state === "supported" || data.state === "stale") {
    return "partial";
  }
  return "ready";
}

export function resolveFieldAvailabilityResultState(
  resource: Pick<FieldAvailabilityResourceResult, "data" | "status">,
): FieldAvailabilityResultState {
  if (resource.status === "error") return "error";
  return resolveFieldAvailabilityDataState(resource.data);
}

export function useFieldAvailabilityResource({
  enabled = true,
  owner_object_id = null,
  scope_id = null,
  scope_kind = null,
  target_id = null,
  quantityId,
}: FieldAvailabilityResourceOptions): FieldAvailabilityResourceResult {
  const { api } = useKernel();
  const resolvedQuantityId = useMemo(
    () => resolveCanonicalQuantityId(quantityId),
    [quantityId],
  );
  const query = useMemo<FieldAvailabilityQuery>(
    () => ({
      owner_object_id: normalizeAvailabilityQueryValue(
        "owner_object_id",
        owner_object_id,
      ),
      scope_id: normalizeAvailabilityQueryValue("scope_id", scope_id),
      scope_kind: normalizeAvailabilityQueryValue("scope_kind", scope_kind),
      target_id: normalizeAvailabilityQueryValue("target_id", target_id),
    }),
    [owner_object_id, scope_id, scope_kind, target_id],
  );
  const resourceKey = useMemo(
    () => resolveFieldAvailabilityResourceKey(resolvedQuantityId, query),
    [query, resolvedQuantityId],
  );
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.data.fields.availability(resolvedQuantityId, query, { signal }),
    [api, query, resolvedQuantityId],
  );
  const resolveRevision = useCallback(
    (data: FieldAvailabilityResource | null) =>
      resolveFieldAvailabilityRevision(data),
    [],
  );

  return useResource<FieldAvailabilityResource | null>({
    enabled,
    load,
    resolveRevision,
    resourceKey,
  });
}

function normalizeAvailabilityQueryValue(
  key: keyof FieldAvailabilityQuery,
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return key === "scope_kind" ? normalized.toLowerCase() : normalized;
}
