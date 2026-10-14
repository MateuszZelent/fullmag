import type { ResourceRevision } from "../api/apiTypes";
import { resourceRuntimeKeyForClientScope } from "./resourceClientScope";
import type { ResourceInvalidationController } from "./ResourceInvalidationController";
import {
  sharedResourceRuntimeStore,
  type ResourceRuntimeStore,
} from "./ResourceRuntimeStore";

let meshPolicyPublicationSequence = 0;

export function resolveMeshPolicyResourceRevision(
  data:
    | {
        config?: unknown;
        effective_config?: unknown;
        revision?: ResourceRevision | null;
      }
    | null
    | undefined,
): ResourceRevision | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const baseRevision =
    typeof record.revision === "number" || typeof record.revision === "string"
      ? record.revision
      : 0;
  const configFingerprint =
    record.config === undefined || record.config === null
      ? "null"
      : JSON.stringify(record.config);
  return `${baseRevision}:${configFingerprint}`;
}

export function publishCommittedMeshPolicyResource<
  TPolicy extends {
    config?: unknown;
    effective_config?: unknown;
    revision?: number;
  },
>(
  resources: ResourceInvalidationController | null | undefined,
  unscopedResourceKey: string,
  sessionScopeKey: string | null | undefined,
  policyResource: TPolicy,
  resourceCacheScope?: string | null,
  runtimeStore: ResourceRuntimeStore<TPolicy> =
    sharedResourceRuntimeStore as ResourceRuntimeStore<TPolicy>,
): void {
  if (!resources) return;
  const revisionToken: ResourceRevision =
    resolveMeshPolicyResourceRevision(policyResource) ??
    `policy:${policyResource.revision ?? 0}:${++meshPolicyPublicationSequence}`;
  const publish = resourceCacheScope
    ? runtimeStore.updateObservedData.bind(runtimeStore)
    : runtimeStore.updateData.bind(runtimeStore);

  publish(
    resourceRuntimeKeyForClientScope(unscopedResourceKey, resourceCacheScope),
    policyResource,
    revisionToken,
  );
  if (sessionScopeKey) {
    const scopedKey = `${sessionScopeKey}|${unscopedResourceKey}`;
    publish(
      resourceRuntimeKeyForClientScope(scopedKey, resourceCacheScope),
      policyResource,
      revisionToken,
    );
    if (typeof resources.invalidate === "function") {
      resources.invalidate(scopedKey, revisionToken);
    }
  }
  if (typeof resources.invalidate === "function") {
    resources.invalidate(unscopedResourceKey, revisionToken);
  }
}
