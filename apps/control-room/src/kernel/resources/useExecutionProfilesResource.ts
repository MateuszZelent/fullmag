"use client";

import { useCallback } from "react";

import { PLATFORM_COMPUTE_PROFILES_PATH } from "../api/apiPaths";
import type { ExecutionProfileCatalogResource, PublishExecutionProfileRequest } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { useResource } from "./useResource";

/** Profile pages share one catalogue revision and one API instance scope. */
export function useExecutionProfilesResource() {
  const { api } = useKernel();
  const load = useCallback(async ({ signal }: { signal: AbortSignal }) => {
    let page = await api.platform.computeProfiles({ limit: 100 }, { signal });
    const revision = page.revision;
    const total = page.total;
    if (total > 1024 || page.offset !== 0) throw new Error("Invalid profile catalogue size or offset.");
    const entries = [...page.entries];
    let offset = page.next_offset;
    while (offset != null) {
      if (offset <= page.offset || entries.length >= 1024) {
        throw new Error("The profile catalogue returned an invalid page sequence.");
      }
      page = await api.platform.computeProfiles({ limit: 100, offset, revision }, { signal });
      if (page.revision !== revision) throw new Error("The profile catalogue changed. Refresh to try again.");
      if (page.offset !== offset || page.total !== total) throw new Error("The profile catalogue returned inconsistent pages.");
      entries.push(...page.entries);
      offset = page.next_offset;
    }
    if (entries.length !== total) throw new Error("The profile catalogue returned an incomplete version list.");
    return { ...page, offset: 0, next_offset: null, entries } satisfies ExecutionProfileCatalogResource;
  }, [api]);
  const resource = useResource({
    load,
    resourceKey: PLATFORM_COMPUTE_PROFILES_PATH,
    resolveRevision: (catalog) => catalog.revision,
  });
  const publish = useCallback((request: PublishExecutionProfileRequest) =>
    api.platform.publishComputeProfile(request), [api]);
  const findPublication = useCallback(async (intentId: string) => {
    const page = await api.platform.computeProfiles({ client_intent_id: intentId, limit: 1 });
    return page.entries[0] ?? null;
  }, [api]);
  return { ...resource, publish, findPublication, scope: api.resourceCacheScope };
}
