"use client";

import { resolveApiBase, resolveApiWsBase } from "./apiBase";
import type { MeshCommandTarget } from "./session/types";

type JsonObject = Record<string, unknown>;
type JsonBody = unknown;

/** Runtime feature flags from the backend. */
export interface RuntimeFeatureFlags {
  disable_charts: boolean;
  disable_preview_2d: boolean;
  disable_preview_3d: boolean;
  disable_session_state_broadcast: boolean;
}

interface QueueRemeshPayload {
  mesh_options?: JsonBody;
  mesh_target: MeshCommandTarget;
  mesh_reason?: string;
}

export interface GpuTelemetryDevice {
  index: number;
  name: string;
  utilization_gpu_percent: number;
  utilization_memory_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  temperature_c?: number | null;
}

export interface GpuTelemetryResponse {
  sample_time_unix_ms: number;
  devices: GpuTelemetryDevice[];
}

export type EngineAvailabilityStatus =
  | "available"
  | "missing_runtime"
  | "missing_driver"
  | "missing_library"
  | "feature_gated"
  | "experimental";

export interface HostEngineEntry {
  backend: string;
  device: string;
  precision: string;
  mode: string;
  runtime_family: string;
  runtime_version: string;
  worker: string;
  status: EngineAvailabilityStatus;
  status_reason?: string | null;
  public: boolean;
  stability: string;
}

export interface HostCapabilityMatrix {
  profile_version: string;
  engines: HostEngineEntry[];
}

// ── Data-plane field store types ──────────────────────────────────────

export interface LiveFieldCatalogEntry {
  quantity_id: string;
  label: string;
  kind: string;
  unit: string;
  spatial_domain: string;
  n_comp: number;
  source: string;
  available: boolean;
  element_count: number;
  grid?: [number, number, number] | null;
  stats?: {
    min: number;
    max: number;
    mean: number;
    component_min?: [number, number, number] | null;
    component_max?: [number, number, number] | null;
  } | null;
}

export interface LiveFieldVectorResponse {
  quantity_id: string;
  unit: string;
  n_comp: number;
  element_count: number;
  grid?: [number, number, number] | null;
  values: number[];
  active_mask?: boolean[] | null;
  source: string;
}

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
      runtimeCapabilities: `${baseUrl}/v1/runtime/capabilities`,
      ws: `${wsBaseUrl}/ws/live/current`,
      commands: `${baseUrl}/v1/live/current/commands`,
      preview: (path: string) => `${baseUrl}/v1/live/current/preview${path}`,
      previewSelection: `${baseUrl}/v1/live/current/preview/selection`,
      importAsset: `${baseUrl}/v1/live/current/assets/import`,
      exportState: `${baseUrl}/v1/live/current/state/export`,
      importState: `${baseUrl}/v1/live/current/state/import`,
      scriptSync: `${baseUrl}/v1/live/current/script/sync`,
      scene: `${baseUrl}/v1/live/current/scene`,
      gpuTelemetry: `${baseUrl}/v1/live/current/gpu/telemetry`,
    },
    fetchBootstrap() {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/bootstrap`, {
        cache: "no-store",
      });
    },
    fetchScalarsHistory() {
      return requestJson<{ scalar_rows: JsonObject[]; scalar_rows_total: number }>(
        `${baseUrl}/v1/live/current/scalars`,
        { cache: "no-store" },
      );
    },
    fetchFeatureFlags() {
      return requestJson<RuntimeFeatureFlags>(`${baseUrl}/v1/live/feature-flags`, {
        cache: "no-store",
      });
    },
    fetchRuntimeCapabilities() {
      return requestJson<HostCapabilityMatrix>(`${baseUrl}/v1/runtime/capabilities`, {
        cache: "no-store",
      });
    },
    connectWebSocket() {
      return new WebSocket(`${wsBaseUrl}/ws/live/current`);
    },
    queueCommand(payload: JsonBody) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    queueRemesh(payload: QueueRemeshPayload) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "remesh",
          mesh_options: payload.mesh_options,
          mesh_target: payload.mesh_target,
          mesh_reason: payload.mesh_reason,
        }),
      });
    },
    queueStudyDomainRemesh(meshOptions: JsonBody, meshReason?: string) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "remesh",
          mesh_options: meshOptions,
          mesh_target: { kind: "study_domain" },
          mesh_reason: meshReason,
        }),
      });
    },
    updatePreview(path: string, payload: JsonBody = {}) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/preview${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    updateDisplaySelection(payload: JsonBody) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/preview/selection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    importAsset(payload: JsonBody) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/assets/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    exportState(payload: JsonBody) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/state/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    importState(payload: JsonBody) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/state/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    syncScript(payload: JsonBody = {}) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/script/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    updateSceneDocument(payload: JsonBody) {
      return requestJson<JsonObject>(`${baseUrl}/v1/live/current/scene`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    fetchGpuTelemetry() {
      return requestJson<GpuTelemetryResponse>(`${baseUrl}/v1/live/current/gpu/telemetry`, {
        cache: "no-store",
      });
    },
    // ── Data-plane field store (read-only, no command queue) ──────────
    getFieldCatalog() {
      return requestJson<LiveFieldCatalogEntry[]>(`${baseUrl}/v1/live/current/fields/catalog`, {
        cache: "no-store",
      });
    },
    getFieldVector(quantityId: string) {
      return requestJson<LiveFieldVectorResponse>(
        `${baseUrl}/v1/live/current/fields/${encodeURIComponent(quantityId)}/vector`,
        { cache: "no-store" },
      );
    },
    getFieldMeta(quantityId: string) {
      return requestJson<LiveFieldCatalogEntry>(
        `${baseUrl}/v1/live/current/fields/${encodeURIComponent(quantityId)}/meta`,
        { cache: "no-store" },
      );
    },
  };
}
