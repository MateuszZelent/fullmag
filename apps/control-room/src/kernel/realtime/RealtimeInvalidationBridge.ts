import type { ResourceRevision } from "../api/apiTypes";
import {
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_SCENE_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";

const SESSION_STATUS_RESOURCE_KEY = "session:status";

interface RealtimeResourceEvent {
  resource_key?: string;
  revision?: ResourceRevision;
  type: string;
}

interface RealtimeBatchChange {
  recommended_fetch?: string;
  revision: ResourceRevision;
}

interface RealtimeBatchChangedEvent {
  payload?: {
    changes?: unknown[];
  };
  type: string;
}

interface RealtimeResyncRequiredEvent {
  payload?: {
    replay_available_after_seq?: unknown;
  };
  type: string;
}

interface RealtimeInvalidationBridgeOptions {
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

export class RealtimeInvalidationBridge {
  constructor(
    private readonly resources: ResourceInvalidationController,
    private readonly options: RealtimeInvalidationBridgeOptions = {},
  ) {}

  handleEvent(event: unknown): boolean {
    if (isRealtimeResyncRequiredEvent(event)) {
      const replayAfter = event.payload?.replay_available_after_seq;
      this.resources.invalidate(
        SESSION_STATUS_RESOURCE_KEY,
        typeof replayAfter === "number" ? replayAfter : Date.now(),
      );
      return true;
    }

    if (isRealtimeBatchChangedEvent(event)) {
      const changes = event.payload?.changes ?? [];
      let handled = false;

      for (const rawChange of changes) {
        const change = realtimeBatchChange(rawChange);
        if (!change) {
          continue;
        }

        this.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, change.revision);
        if (change.recommended_fetch) {
          this.invalidateResource(change.recommended_fetch, change.revision);
          this.resources.invalidatePrefix(change.recommended_fetch, change.revision);
          this.invalidateMeshBuildCompletionDependents(
            change.recommended_fetch,
            change.revision,
          );
        }
        handled = true;
      }

      return handled;
    }

    if (!isRealtimeResourceEvent(event)) {
      return false;
    }

    if (event.type !== "resource.updated") {
      return false;
    }

    if (!event.resource_key || event.revision === undefined) {
      return false;
    }

    this.invalidateResource(event.resource_key, event.revision);
    return true;
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
}
