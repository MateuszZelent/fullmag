"use client";

import type { LaunchEntryKind, LaunchIntent, WorkspaceStage } from "./launch-intent";
import { resolveApiBase } from "@/lib/apiBase";
import {
  getLiveApiClient,
  initLiveApiClient,
} from "@/src/api/client/LiveApiClient";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import { recordFrontendDebugEvent } from "./navigation-debug";
import type { LiveStatus } from "@/src/api/types";

function inferEntryKind(path: string | null): LaunchEntryKind {
  if (!path) return "project";
  return path.toLowerCase().endsWith(".py") ? "script" : "project";
}

function inferStage(status: string | null): WorkspaceStage {
  if (status === "running" || status === "awaiting_command" || status === "materializing_script" || status === "bootstrapping") {
    return "study";
  }
  return "build";
}

export interface DetectedLiveSession {
  intent: LaunchIntent;
  name: string;
  backend: string | null;
  scriptPath: string | null;
  status: string | null;
}

type LiveIntentCacheEntry = {
  promise: Promise<DetectedLiveSession | null>;
  startedAt: number;
};

const liveIntentInFlight = new Map<string, LiveIntentCacheEntry>();
const LIVE_INTENT_DEDUP_WINDOW_MS = 1500;

export async function detectLiveSessionIntent(): Promise<DetectedLiveSession | null> {
  const baseUrl = resolveApiBase();
  const now = Date.now();
  const cached = liveIntentInFlight.get(baseUrl);
  if (cached && now - cached.startedAt < LIVE_INTENT_DEDUP_WINDOW_MS) {
    recordFrontendDebugEvent("live-intent", "dedup_reuse_inflight", {
      baseUrl,
      ageMs: now - cached.startedAt,
    });
    return cached.promise;
  }

  const promise = (async (): Promise<DetectedLiveSession | null> => {
  recordFrontendDebugEvent("live-intent", "status_fetch_start", { baseUrl });
  let payload: LiveStatus;
  try {
    payload = await ensureResourceClient().status.get();
  } catch (error) {
    if (error instanceof LiveApiError && error.status === 404) {
      recordFrontendDebugEvent("live-intent", "status_fetch_not_found", { baseUrl });
      return null;
    }
    if (error instanceof LiveApiError) {
      recordFrontendDebugEvent("live-intent", "status_fetch_http_error", {
        baseUrl,
        status: error.status,
      });
      return null;
    }
    recordFrontendDebugEvent("live-intent", "status_fetch_network_error", { baseUrl });
    return null;
  }
  const runId = payload.run?.run_id ?? payload.session.session_id;
  const scriptPath = null;
  const problemName = payload.session.name || "Live Simulation";
  const backend = payload.domain.discretization ?? null;
  const status = payload.solver.state ?? null;
  const entryKind = inferEntryKind(scriptPath);
  const targetStage = inferStage(status);

  const result: DetectedLiveSession = {
    intent: {
      source: "local_live",
      entryPath: scriptPath,
      entryKind,
      targetStage,
      resumeProjectId: runId,
      displayName: problemName,
      launchAssetId: null,
      metadata: {
        detectedBy: "live_status",
        backend,
        problemName,
        status,
      },
    },
    name: problemName,
    backend,
    scriptPath,
    status,
  };
  recordFrontendDebugEvent("live-intent", "status_fetch_success", {
    baseUrl,
    runId,
    targetStage,
    status,
  });
  return result;
  })();

  liveIntentInFlight.set(baseUrl, { promise, startedAt: now });
  try {
    return await promise;
  } finally {
    const current = liveIntentInFlight.get(baseUrl);
    if (current?.promise === promise) {
      liveIntentInFlight.delete(baseUrl);
    }
  }
}

function ensureResourceClient() {
  try {
    return getLiveApiClient();
  } catch {
    return initLiveApiClient({ baseUrl: resolveApiBase() });
  }
}
