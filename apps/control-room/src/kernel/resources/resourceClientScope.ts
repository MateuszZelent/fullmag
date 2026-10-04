import type { ResourceKey } from "./resourceTypes";

const CLIENT_SCOPE_QUERY_PARAMETER = "__fm_client_scope";

/**
 * Runtime cache identity for one API client. Keep the endpoint/resource key
 * unchanged for invalidation, events, and diagnostics; only the local runtime
 * store uses this scoped variant.
 */
export function resourceRuntimeKeyForClientScope(
  resourceKey: ResourceKey,
  clientScope: string | null | undefined,
): ResourceKey {
  const normalizedScope = clientScope?.trim();
  if (!normalizedScope) return resourceKey;

  // developmentBackendResource historically included the client scope as a
  // pipe-delimited prefix. Preserve that identity without adding a second one.
  if (resourceKey.startsWith(`${normalizedScope}|`)) return resourceKey;

  const unscopedResourceKey = withoutClientScopeQueryParameter(resourceKey);
  const separator = unscopedResourceKey.includes("?") ? "&" : "?";
  return `${unscopedResourceKey}${separator}${CLIENT_SCOPE_QUERY_PARAMETER}=${encodeURIComponent(normalizedScope)}`;
}

function withoutClientScopeQueryParameter(resourceKey: ResourceKey): string {
  const queryStart = resourceKey.indexOf("?");
  if (queryStart < 0) return resourceKey;

  const path = resourceKey.slice(0, queryStart);
  const queryParts = resourceKey
    .slice(queryStart + 1)
    .split("&")
    .filter(
      (part) =>
        part.length > 0 &&
        !part.startsWith(`${CLIENT_SCOPE_QUERY_PARAMETER}=`),
    );
  return queryParts.length > 0 ? `${path}?${queryParts.join("&")}` : path;
}
