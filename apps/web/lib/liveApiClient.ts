"use client";

import { resolveApiBase, resolveApiWsBase } from "./apiBase";

type JsonObject = Record<string, unknown>;

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      (payload && typeof payload === "object" && ("message" in payload || "error" in payload)
        ? String((payload as { message?: unknown; error?: unknown }).message ?? (payload as { error?: unknown }).error)
        : null) ?? `HTTP ${response.status}`;
    throw new ApiHttpError(response.status, detail);
  }
  return payload as T;
}

export function currentLiveApiClient() {
  const baseUrl = resolveApiBase();
  const wsBaseUrl = resolveApiWsBase();

  return {
    urls: {
      bootstrap: `${baseUrl}/v1/live/current/bootstrap`,
      ws: `${wsBaseUrl}/ws/live/current`,
      commands: `${baseUrl}/v1/live/current/commands`,
      preview: (path: string) => `${baseUrl}/v1/live/current/preview${path}`,
      importAsset: `${baseUrl}/v1/live/current/assets/import`,
    },
    fetchBootstrap() {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/bootstrap`, {
        cache: "no-store",
      });
    },
    connectWebSocket() {
      return new WebSocket(`${wsBaseUrl}/ws/live/current`);
    },
    queueCommand(payload: JsonObject) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    updatePreview(path: string, payload: JsonObject = {}) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/preview${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    importAsset(payload: JsonObject) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/assets/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
  };
}
