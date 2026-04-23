"use client";

/**
 * Hook: polls /status at adaptive intervals.
 * Faster polling during active solver, slower when idle.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { LiveStatus } from "../../api/generated/openapi-types";
import { getLiveApiClient } from "../../api/client/LiveApiClient";
import { LiveApiError } from "../../api/client/errors/LiveApiError";
import { LiveRealtimeClient } from "../../api/realtime/LiveRealtimeClient";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import type {
  LiveRealtimeEvent,
  RealtimeResourceBatchChangedPayload,
  RealtimeResourceRevisionMap,
  ResourceRevisionMap,
} from "../../api/types";

const IDLE_INTERVAL_MS = 3000;
const ACTIVE_INTERVAL_MS = 500;
const ERROR_BACKOFF_MS = 5000;
const WS_IDLE_INTERVAL_MS = 10_000;
const WS_ACTIVE_INTERVAL_MS = 2_000;

interface UseLiveStatusResult {
  status: LiveStatus | null;
  loading: boolean;
  error: LiveApiError | null;
  refresh: () => Promise<void>;
}

function mergeRealtimeRevisionsIntoStatusResources(
  current: ResourceRevisionMap,
  incoming: Partial<RealtimeResourceRevisionMap>,
): ResourceRevisionMap {
  return {
    ...current,
    ...(incoming.topology_revision != null
      ? { topology_revision: incoming.topology_revision }
      : {}),
    ...(incoming.field_catalog_revision != null
      ? { field_catalog_revision: incoming.field_catalog_revision }
      : {}),
    ...(incoming.field_revision != null
      ? { field_revision: incoming.field_revision }
      : {}),
    ...(incoming.slice_revision != null
      ? { slice_revision: incoming.slice_revision }
      : {}),
    ...(incoming.artifact_revision != null
      ? { artifact_revision: incoming.artifact_revision }
      : {}),
    ...(incoming.command_completion_revision != null
      ? { command_completion_revision: incoming.command_completion_revision }
      : {}),
    ...(incoming.fields_revision != null
      ? { fields_revision: incoming.fields_revision }
      : {}),
    ...(incoming.scalars_revision != null
      ? { scalars_revision: incoming.scalars_revision }
      : {}),
    ...(incoming.domain_generation_id != null
      ? { domain_generation_id: incoming.domain_generation_id }
      : {}),
    ...(incoming.artifacts_revision != null
      ? { artifacts_revision: incoming.artifacts_revision }
      : {}),
    ...(incoming.engine_log_revision != null
      ? { engine_log_revision: incoming.engine_log_revision }
      : {}),
    ...(incoming.display_revision != null
      ? { display_revision: incoming.display_revision }
      : {}),
    ...(incoming.workspace_revision != null
      ? { workspace_revision: incoming.workspace_revision }
      : {}),
    ...(incoming.mesh_revision != null
      ? { mesh_revision: incoming.mesh_revision }
      : {}),
    ...(incoming.mesh_build_revision != null
      ? { mesh_build_revision: incoming.mesh_build_revision }
      : {}),
    ...(incoming.commands_revision != null
      ? { commands_revision: incoming.commands_revision }
      : {}),
    ...(incoming.stages_revision != null
      ? { stages_revision: incoming.stages_revision }
      : {}),
    ...(incoming.scene_revision !== undefined
      ? { scene_revision: incoming.scene_revision ?? null }
      : {}),
  };
}

function mergeRealtimeBatchIntoStatusResources(
  current: ResourceRevisionMap,
  payload: RealtimeResourceBatchChangedPayload,
): ResourceRevisionMap {
  const patch: Partial<RealtimeResourceRevisionMap> = {};
  for (const change of payload.changes) {
    switch (change.resource) {
      case "display":
        patch.display_revision = change.revision;
        break;
      case "workspace":
        patch.workspace_revision = change.revision;
        break;
      case "fields":
        patch.fields_revision = change.revision;
        patch.field_catalog_revision = change.revision;
        patch.field_revision = change.revision;
        patch.slice_revision = change.revision;
        if (change.domain_generation_id != null) {
          patch.domain_generation_id = change.domain_generation_id;
        }
        break;
      case "scalars":
        patch.scalars_revision = change.revision;
        break;
      case "domain":
        patch.domain_generation_id = change.domain_generation_id ?? change.revision;
        patch.topology_revision = change.revision;
        break;
      case "artifacts":
        patch.artifact_revision = change.revision;
        patch.artifacts_revision = change.revision;
        break;
      case "logs":
        patch.engine_log_revision = change.revision;
        break;
      case "mesh":
        patch.topology_revision = change.revision;
        patch.mesh_revision = change.revision;
        if (change.domain_generation_id != null) {
          patch.domain_generation_id = change.domain_generation_id;
        }
        break;
      case "mesh_builds":
        patch.mesh_build_revision = change.revision;
        if (change.domain_generation_id != null) {
          patch.domain_generation_id = change.domain_generation_id;
        }
        break;
      case "commands":
        patch.command_completion_revision = change.revision;
        patch.commands_revision = change.revision;
        break;
      case "stages":
        patch.stages_revision = change.revision;
        break;
      case "scene_document":
        patch.scene_revision = change.revision;
        break;
      default:
        break;
    }
  }
  return mergeRealtimeRevisionsIntoStatusResources(current, patch);
}

function realtimeEventNeedsStatusRefresh(event: LiveRealtimeEvent): boolean {
  if (event.type === "resync.required") {
    return true;
  }
  if (event.type !== "resource.batch_changed") {
    return false;
  }
  return event.payload.changes.some(
    (change) => change.resource === "display" || change.resource === "domain",
  );
}

export function useLiveStatus(options?: { enabled?: boolean }): UseLiveStatusResult {
  const enabled = options?.enabled ?? true;
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LiveApiError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const realtimeClientRef = useRef<LiveRealtimeClient | null>(null);
  const refreshQueuedRef = useRef(false);

  const poll = useCallback(async function pollStatus(): Promise<void> {
    try {
      const client = getLiveApiClient();
      const result = await client.status.get();
      if (!mountedRef.current) return;
      setStatus(result);
      setError(null);
      setLoading(false);

      // Adaptive interval based on solver state
      const isActive =
        result.solver.state === "running" ||
        result.solver.state === "initializing";
      const websocketEnabled = FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveWebSocket;
      const interval = websocketEnabled
        ? isActive
          ? WS_ACTIVE_INTERVAL_MS
          : WS_IDLE_INTERVAL_MS
        : isActive
          ? ACTIVE_INTERVAL_MS
          : IDLE_INTERVAL_MS;
      timerRef.current = setTimeout(pollStatus, interval);
    } catch (err) {
      if (!mountedRef.current) return;
      const apiErr =
        err instanceof LiveApiError
          ? err
          : LiveApiError.networkError("status", err);
      setError(apiErr);
      setLoading(false);
      timerRef.current = setTimeout(poll, ERROR_BACKOFF_MS);
    }
  }, []);

  const queueRefresh = useCallback(() => {
    if (refreshQueuedRef.current) {
      return;
    }
    refreshQueuedRef.current = true;
    window.setTimeout(() => {
      refreshQueuedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      void poll();
    }, 0);
  }, [poll]);

  const applyRealtimeEvent = useCallback(
    (event: LiveRealtimeEvent) => {
      if (event.type === "heartbeat") {
        return;
      }

      if (event.type === "hello") {
        setStatus((previous) => {
          if (!previous) {
            return previous;
          }
          return {
            ...previous,
            resources: mergeRealtimeRevisionsIntoStatusResources(
              previous.resources,
              event.payload.resource_revisions,
            ),
          };
        });
        return;
      }

      if (event.type === "resource.batch_changed") {
        setStatus((previous) => {
          if (!previous) {
            return previous;
          }
          return {
            ...previous,
            resources: mergeRealtimeBatchIntoStatusResources(
              previous.resources,
              event.payload,
            ),
          };
        });
      }

      if (realtimeEventNeedsStatusRefresh(event)) {
        queueRefresh();
      }
    },
    [queueRefresh],
  );

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setError(null);
      return;
    }
    mountedRef.current = true;
    setLoading(true);
    poll();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll, enabled]);

  useEffect(() => {
    const hasActiveSession = Boolean(status?.session?.session_id);
    if (
      !enabled ||
      !FRONTEND_DIAGNOSTIC_FLAGS.session.enableLiveWebSocket ||
      !hasActiveSession
    ) {
      realtimeClientRef.current?.close();
      realtimeClientRef.current = null;
      return;
    }
    const client = new LiveRealtimeClient({
      baseUrl: getLiveApiClient().getBaseUrl(),
      onEvent: applyRealtimeEvent,
      onError: (realtimeError) => {
        if (!mountedRef.current) {
          return;
        }
        setError((previous) => previous ?? LiveApiError.networkError("realtime", realtimeError));
      },
    });
    realtimeClientRef.current = client;
    client.connect();
    return () => {
      client.close();
      if (realtimeClientRef.current === client) {
        realtimeClientRef.current = null;
      }
    };
  }, [applyRealtimeEvent, enabled, status?.session?.session_id]);

  return {
    status,
    loading,
    error,
    refresh: async () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      await poll();
    },
  };
}
