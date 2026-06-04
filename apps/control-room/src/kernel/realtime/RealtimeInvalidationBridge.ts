import type { ResourceRevision } from "../api/apiTypes";
import {
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELDS_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MODEL_SCENE_PATH,
  SESSION_CURRENT_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import { resolveCanonicalQuantityId } from "../api/quantityIds";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

const SESSION_STATUS_RESOURCE_KEY = "session:status";

interface RealtimeResourceEvent {
  resource_key?: string;
  revision?: ResourceRevision;
  seq?: ResourceRevision;
  session_id?: string;
  type: string;
}

interface RealtimeBatchChange {
  broad?: boolean;
  quantity_ids?: string[];
  resource?: string;
  resource_id?: string;
  recommended_fetch?: string;
  revision: ResourceRevision;
}

interface RealtimeBatchChangedEvent {
  payload?: {
    changes?: unknown[];
  };
  seq?: ResourceRevision;
  session_id?: string;
  type: string;
}

interface RealtimeResyncRequiredEvent {
  payload?: {
    replay_available_after_seq?: unknown;
  };
  seq?: ResourceRevision;
  session_id?: string;
  type: string;
}

interface RealtimeInvalidationBridgeOptions {
  scheduleFlush?: (callback: () => void) => () => void;
  shouldSuppressInvalidation?: (
    resourceKey: string,
    revision: ResourceRevision,
  ) => boolean;
}

function isRealtimeResourceEvent(event: unknown): event is RealtimeResourceEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  return typeof record.type === "string";
}

function isRealtimeBatchChangedEvent(
  event: unknown,
): event is RealtimeBatchChangedEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  return record.type === "resource.batch_changed";
}

function isRealtimeResyncRequiredEvent(
  event: unknown,
): event is RealtimeResyncRequiredEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  return record.type === "resync.required";
}

function realtimeBatchChange(change: unknown): RealtimeBatchChange | null {
  if (!change || typeof change !== "object") {
    return null;
  }

  const record = change as Record<string, unknown>;
  const revision = record.revision;
  if (typeof revision !== "number" && typeof revision !== "string") {
    return null;
  }

  return {
    broad: record.broad === true,
    quantity_ids: Array.isArray(record.quantity_ids)
      ? record.quantity_ids.filter((value): value is string => typeof value === "string")
      : undefined,
    resource: typeof record.resource === "string" ? record.resource : undefined,
    resource_id:
      typeof record.resource_id === "string" ? record.resource_id : undefined,
    recommended_fetch:
      typeof record.recommended_fetch === "string"
        ? record.recommended_fetch
        : undefined,
    revision,
  };
}

function resourceFamilyPrefix(pathWithObjectId: string): string {
  return pathWithObjectId.slice(0, pathWithObjectId.indexOf("{object_id}"));
}

const SESSION_STATUS_RECOMMENDED_FETCHES = new Set<string>([
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
]);

function shouldInvalidateSessionStatus(recommendedFetch?: string): boolean {
  return (
    recommendedFetch !== undefined &&
    SESSION_STATUS_RECOMMENDED_FETCHES.has(recommendedFetch)
  );
}

function latestRevision(
  current: ResourceRevision | null,
  next: ResourceRevision,
): ResourceRevision {
  if (typeof current === "number" && typeof next === "number") {
    return Math.max(current, next);
  }
  return next;
}

function dependentResourceRevision(
  sourceResourceKey: string,
  revision: ResourceRevision,
): ResourceRevision {
  return typeof revision === "number"
    ? `dependent:${sourceResourceKey}:${revision}`
    : revision;
}

function defaultScheduleFlush(callback: () => void): () => void {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    const frameId = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(frameId);
  }

  callback();
  return () => {};
}

export class RealtimeInvalidationBridge {
  private currentRunId: string | null = null;
  private currentSessionId: string | null = null;
  private flushCancel: (() => void) | null = null;
  private pendingFetches = new Map<string, ResourceRevision>();
  private pendingMatchers: Array<{
    predicate: (resourceKey: string) => boolean;
    revision: ResourceRevision;
  }> = [];
  private pendingPrefixes = new Map<string, ResourceRevision>();
  private pendingStatusRevision: ResourceRevision | null = null;

  constructor(
    private readonly resources: ResourceInvalidationController,
    private readonly options: RealtimeInvalidationBridgeOptions = {},
  ) {}

  handleEvent(event: unknown): boolean {
    const sessionHandled = this.handleSessionEnvelope(event);

    if (isRealtimeResyncRequiredEvent(event)) {
      const replayAfter = event.payload?.replay_available_after_seq;
      if (!sessionHandled) {
        this.resources.invalidate(
          SESSION_STATUS_RESOURCE_KEY,
          typeof replayAfter === "number" ? replayAfter : Date.now(),
        );
      }
      return true;
    }

    if (isRealtimeBatchChangedEvent(event)) {
      const changes = event.payload?.changes ?? [];
      let handled = false;
      let statusRevision: ResourceRevision | null = null;

      for (const rawChange of changes) {
        const change = realtimeBatchChange(rawChange);
        if (!change) {
          continue;
        }
        const recommendedFetch = change.recommended_fetch;

        if (recommendedFetch && shouldInvalidateSessionStatus(recommendedFetch)) {
          statusRevision = latestRevision(
            statusRevision,
            dependentResourceRevision(recommendedFetch, change.revision),
          );
        }
        if (recommendedFetch) {
          this.queueResourceInvalidation(
            recommendedFetch,
            change.revision,
          );
        } else if (
          change.resource === "fields" &&
          change.resource_id === "samples"
        ) {
          if (change.broad || !change.quantity_ids?.length) {
            this.queuePrefixInvalidation(DATA_FIELDS_PATH, change.revision);
          } else {
            for (const quantityId of change.quantity_ids) {
              this.queueFieldSampleQuantityInvalidation(
                quantityId,
                change.revision,
              );
            }
          }
        }
        handled = true;
      }

      if (statusRevision !== null) {
        this.pendingStatusRevision = latestRevision(
          this.pendingStatusRevision,
          statusRevision,
        );
      }

      if (handled) {
        this.scheduleFlush();
      }
      return handled || sessionHandled;
    }

    if (!isRealtimeResourceEvent(event)) {
      return sessionHandled;
    }

    if (event.type !== "resource.updated") {
      return sessionHandled;
    }

    if (!event.resource_key || event.revision === undefined) {
      return sessionHandled;
    }

    this.invalidateResource(event.resource_key, event.revision);
    return true;
  }

  private handleSessionEnvelope(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;

    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const sessionId =
      typeof record.session_id === "string" && record.session_id.length > 0
        ? record.session_id
        : null;
    if (!sessionId) return false;

    const tracksRunIdentity =
      type === "hello" ||
      type === "resource.batch_changed" ||
      type === "resync.required";
    const runId =
      tracksRunIdentity &&
      typeof record.run_id === "string" &&
      record.run_id.length > 0
        ? record.run_id
        : null;
    const sessionChanged =
      this.currentSessionId !== null && this.currentSessionId !== sessionId;
    const runChanged =
      tracksRunIdentity &&
      this.currentSessionId !== null &&
      !sessionChanged &&
      this.currentRunId !== runId;
    const shouldResync =
      type === "hello" ||
      type === "resync.required" ||
      sessionChanged ||
      runChanged;
    this.currentSessionId = sessionId;
    if (tracksRunIdentity || sessionChanged) {
      this.currentRunId = runId;
    }
    if (!shouldResync) return false;

    const seq = record.seq;
    const revision =
      typeof seq === "number" || typeof seq === "string"
        ? `session:${sessionId}:${seq}`
        : `session:${sessionId}:${Date.now()}`;
    this.invalidateSessionScope(revision);
    return true;
  }

  private invalidateSessionScope(revision: ResourceRevision): void {
    this.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
    this.resources.invalidatePrefix(SESSION_CURRENT_PATH, revision);
  }

  private queueResourceInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
  ): void {
    this.pendingFetches.set(
      resourceKey,
      latestRevision(this.pendingFetches.get(resourceKey) ?? null, revision),
    );
  }

  private queuePrefixInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
  ): void {
    this.pendingPrefixes.set(
      resourceKey,
      latestRevision(this.pendingPrefixes.get(resourceKey) ?? null, revision),
    );
  }

  private queueFieldSampleQuantityInvalidation(
    quantityId: string,
    revision: ResourceRevision,
  ): void {
    const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
    const quantityPrefix = `${DATA_FIELDS_PATH}/${encodeURIComponent(canonicalQuantityId)}/`;
    this.queueMatchingInvalidation(
      (resourceKey) =>
        resourceKey.startsWith(quantityPrefix) ||
        resourceKey.includes(quantityPrefix),
      revision,
    );
  }

  private queueMatchingInvalidation(
    predicate: (resourceKey: string) => boolean,
    revision: ResourceRevision,
  ): void {
    this.pendingMatchers.push({ predicate, revision });
  }

  private scheduleFlush(): void {
    if (this.flushCancel) return;
    const scheduleFlush = this.options.scheduleFlush ?? defaultScheduleFlush;
    let didFlush = false;
    const cancel = scheduleFlush(() => {
      didFlush = true;
      this.flushCancel = null;
      this.flushPendingInvalidations();
    });
    this.flushCancel = didFlush ? null : cancel;
  }

  private flushPendingInvalidations(): void {
    const pendingFetches = this.pendingFetches;
    const pendingPrefixes = this.pendingPrefixes;
    const pendingMatchers = this.pendingMatchers;
    let statusRevision = this.pendingStatusRevision;
    this.pendingFetches = new Map<string, ResourceRevision>();
    this.pendingPrefixes = new Map<string, ResourceRevision>();
    this.pendingMatchers = [];
    this.pendingStatusRevision = null;

    for (const [resourceKey, revision] of pendingFetches) {
      this.invalidateResource(resourceKey, revision);
      this.resources.invalidatePrefix(resourceKey, revision);
      this.invalidateMeshBuildCompletionDependents(resourceKey, revision);
      const dependentStatusRevision =
        this.invalidateRuntimeLifecycleDependents(resourceKey, revision);
      if (dependentStatusRevision !== null && statusRevision === null) {
        statusRevision = latestRevision(statusRevision, dependentStatusRevision);
      }
    }
    for (const [resourceKey, revision] of pendingPrefixes) {
      this.resources.invalidatePrefix(resourceKey, revision);
    }
    for (const matcher of pendingMatchers) {
      this.resources.invalidateMatching(matcher.predicate, matcher.revision);
    }

    if (statusRevision !== null) {
      this.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, statusRevision);
    }
  }

  private invalidateResource(
    resourceKey: string,
    revision: ResourceRevision,
  ): void {
    if (this.options.shouldSuppressInvalidation?.(resourceKey, revision)) {
      return;
    }
    this.resources.invalidate(resourceKey, revision);
  }

  private invalidateMeshBuildCompletionDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): void {
    if (recommendedFetch !== MESHING_BUILDS_LATEST_SUCCESSFUL_PATH) return;

    this.resources.invalidate(MODEL_SCENE_PATH, revision);
    this.resources.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, revision);
    this.resources.invalidate(VISUALIZATION_STATE_PATH, revision);
    this.resources.invalidate(DATA_DOMAIN_META_PATH, revision);
    this.resources.invalidate(DATA_DOMAIN_TOPOLOGY_PATH, revision);
    this.resources.invalidate(MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH, revision);
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_TOPOLOGY_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_REPORT_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_QUALITY_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_SIZE_FIELD_PATH),
      revision,
    );
  }

  private invalidateRuntimeLifecycleDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): ResourceRevision | null {
    const dependentRevision = dependentResourceRevision(
      recommendedFetch,
      revision,
    );
    if (recommendedFetch === SIMULATION_COMMANDS_PATH) {
      this.resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, dependentRevision);
      this.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, dependentRevision);
      return dependentRevision;
    }

    if (recommendedFetch === SIMULATION_STAGES_EXECUTION_PATH) {
      this.resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, dependentRevision);
      this.resources.invalidate(SIMULATION_COMMANDS_PATH, dependentRevision);
      return null;
    }

    if (recommendedFetch === SIMULATION_SOLVER_STATUS_PATH) {
      this.resources.invalidate(SIMULATION_COMMANDS_PATH, dependentRevision);
      return null;
    }

    return null;
  }
}
