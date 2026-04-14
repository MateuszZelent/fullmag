"use client";

import type { LaunchEntryKind, LaunchIntent, WorkspaceStage } from "./launch-intent";
import { resolveApiBase } from "@/lib/apiBase";
import { apiGet } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { recordFrontendDebugEvent } from "./navigation-debug";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

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
  recordFrontendDebugEvent("live-intent", "bootstrap_fetch_start", { baseUrl });
  let payload: unknown;
  try {
    payload = await apiGet<unknown>(`${baseUrl}/v1/live/current/bootstrap`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      recordFrontendDebugEvent("live-intent", "bootstrap_fetch_not_found", { baseUrl });
      return null;
    }
    if (error instanceof ApiError) {
      recordFrontendDebugEvent("live-intent", "bootstrap_fetch_http_error", {
        baseUrl,
        status: error.status,
      });
      return null;
    }
    recordFrontendDebugEvent("live-intent", "bootstrap_fetch_network_error", { baseUrl });
    return null;
  }
  const root = asRecord(payload);
  if (!root) {
    return null;
  }
  const mode = asString(root.mode);
  if (mode === "hub") {
    return null;
  }

  const session = asRecord(root.session);
  if (!session) {
    return null;
  }

  const runId = asString(session.run_id) ?? asString(session.session_id);
  const scriptPath = asString(session.script_path);
  const problemName = asString(session.problem_name) ?? "Live Simulation";
  const backend = asString(session.requested_backend);
  const status = asString(session.status);
  const entryKind = inferEntryKind(scriptPath);
  const targetStage = inferStage(status);

  const result: DetectedLiveSession = {
    intent: {
      source: "electron_cli",
      entryPath: scriptPath,
      entryKind,
      targetStage,
      resumeProjectId: runId,
      displayName: problemName,
      launchAssetId: null,
      metadata: {
        detectedBy: "live_bootstrap",
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
  recordFrontendDebugEvent("live-intent", "bootstrap_fetch_success", {
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
