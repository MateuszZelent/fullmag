"use client";

import { resolveApiBase } from "./apiBase";
import { apiGet, apiGetOptional, apiPost } from "./api/client";
import { ApiError } from "./api/errors";
import type { MeshCommandTarget } from "./session/types";
import type { SceneDocument } from "./session/types";

type JsonObject = Record<string, unknown>;
type JsonBody = unknown;
type RequestOptions = { signal?: AbortSignal };

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

export interface QuantityCatalogResponse {
  schema_version: string;
  quantities: unknown[];
}

export class ApiHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

function normalizeApiError(error: unknown): never {
  if (error instanceof ApiError) {
    throw new ApiHttpError(error.status, error.message);
  }
  throw error;
}

async function requestGet<T>(url: string, options?: RequestOptions): Promise<T> {
  try {
    return await apiGet<T>(url, options);
  } catch (error) {
    normalizeApiError(error);
  }
}

async function requestGetOptional<T>(url: string, options?: RequestOptions): Promise<T | null> {
  try {
    return await apiGetOptional<T>(url, options);
  } catch (error) {
    normalizeApiError(error);
  }
}

async function requestPost<T>(url: string, body: JsonBody, options?: RequestOptions): Promise<T> {
  try {
    return await apiPost<T>(url, body, options);
  } catch (error) {
    normalizeApiError(error);
  }
}

export function currentLiveApiClient() {
  const baseUrl = resolveApiBase();

  return {
    urls: {
      bootstrap: `${baseUrl}/v1/live/current/bootstrap`,
      poll: `${baseUrl}/v1/live/current/poll`,
      runtimeCapabilities: `${baseUrl}/v1/runtime/capabilities`,
      commands: `${baseUrl}/v1/live/current/commands`,
      preview: (path: string) => `${baseUrl}/v1/live/current/preview${path}`,
      previewSelection: `${baseUrl}/v1/live/current/preview/selection`,
      importAsset: `${baseUrl}/v1/live/current/assets/import`,
      exportState: `${baseUrl}/v1/live/current/state/export`,
      importState: `${baseUrl}/v1/live/current/state/import`,
      scriptSync: `${baseUrl}/v1/live/current/script/sync`,
      scene: `${baseUrl}/v1/live/current/scene`,
      gpuTelemetry: `${baseUrl}/v1/live/current/gpu/telemetry`,
      artifacts: `${baseUrl}/v1/live/current/artifacts`,
      eigenSpectrum: `${baseUrl}/v1/live/current/eigen/spectrum`,
      eigenDispersion: `${baseUrl}/v1/live/current/eigen/dispersion`,
      eigenBranches: `${baseUrl}/v1/live/current/eigen/branches`,
      eigenMode: `${baseUrl}/v1/live/current/eigen/mode`,
      quantitiesCatalog: `${baseUrl}/v1/quantities/catalog`,
    },
    fetchBootstrap<T = JsonObject>(options?: RequestOptions) {
      return requestGet<T>(`${baseUrl}/v1/live/current/bootstrap`, options);
    },
    async fetchPoll(params: { sinceVersion: number; scalarRowsTotal: number }, options?: RequestOptions) {
      const url = new URL(`${baseUrl}/v1/live/current/poll`);
      url.searchParams.set("since_version", String(params.sinceVersion));
      url.searchParams.set("scalar_rows_total", String(params.scalarRowsTotal));
      return requestGetOptional<JsonObject>(url.toString(), options);
    },
    fetchScalarsHistory(options?: RequestOptions) {
      return requestGet<{ scalar_rows: JsonObject[]; scalar_rows_total: number }>(
        `${baseUrl}/v1/live/current/scalars`,
        options,
      );
    },
    fetchFeatureFlags(options?: RequestOptions) {
      return requestGet<RuntimeFeatureFlags>(`${baseUrl}/v1/live/feature-flags`, options);
    },
    fetchRuntimeCapabilities(options?: RequestOptions) {
      return requestGet<HostCapabilityMatrix>(`${baseUrl}/v1/runtime/capabilities`, options);
    },
    queueCommand(payload: JsonBody, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/commands`, payload, options);
    },
    queueRemesh(payload: QueueRemeshPayload, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/commands`, {
        kind: "remesh",
        mesh_options: payload.mesh_options,
        mesh_target: payload.mesh_target,
        mesh_reason: payload.mesh_reason,
      }, options);
    },
    queueStudyDomainRemesh(meshOptions: JsonBody, meshReason?: string, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/commands`, {
        kind: "remesh",
        mesh_options: meshOptions,
        mesh_target: { kind: "study_domain" },
        mesh_reason: meshReason,
      }, options);
    },
    updatePreview(path: string, payload: JsonBody = {}, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/preview${path}`, payload, options);
    },
    updateDisplaySelection(payload: JsonBody, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/preview/selection`, payload, options);
    },
    importAsset(payload: JsonBody, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/assets/import`, payload, options);
    },
    exportState(payload: JsonBody, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/state/export`, payload, options);
    },
    importState(payload: JsonBody, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/state/import`, payload, options);
    },
    syncScript(payload: JsonBody = {}, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/script/sync`, payload, options);
    },
    updateSceneDocument(payload: JsonBody, options?: RequestOptions) {
      return requestPost<SceneDocument>(`${baseUrl}/v1/live/current/scene`, payload, options);
    },
    fetchGpuTelemetry(options?: RequestOptions) {
      return requestGet<GpuTelemetryResponse>(`${baseUrl}/v1/live/current/gpu/telemetry`, options);
    },
    fetchArtifacts(options?: RequestOptions) {
      return requestGet<Array<{ path: string; kind?: string }>>(
        `${baseUrl}/v1/live/current/artifacts`,
        options,
      );
    },
    fetchEigenSpectrum<T = { modes?: unknown[] }>(options?: RequestOptions) {
      return requestGet<T>(`${baseUrl}/v1/live/current/eigen/spectrum`, options);
    },
    fetchEigenDispersion<T = { csv_path: string; path_metadata?: unknown; rows: unknown[] }>(options?: RequestOptions) {
      return requestGet<T>(`${baseUrl}/v1/live/current/eigen/dispersion`, options);
    },
    fetchEigenBranches<T = unknown>(options?: RequestOptions) {
      return requestGet<T>(`${baseUrl}/v1/live/current/eigen/branches`, options);
    },
    fetchEigenMode<T = unknown>(index: number, sampleIndex?: number | null, options?: RequestOptions) {
      const url = new URL(`${baseUrl}/v1/live/current/eigen/mode`);
      url.searchParams.set("index", String(index));
      if (sampleIndex != null) {
        url.searchParams.set("sample_index", String(sampleIndex));
      }
      return requestGet<T>(url.toString(), options);
    },
    fetchQuantitiesCatalog(options?: RequestOptions) {
      return requestGet<QuantityCatalogResponse>(`${baseUrl}/v1/quantities/catalog`, options);
    },
    // ── Data-plane field store (read-only, no command queue) ──────────
    getFieldCatalog(options?: RequestOptions) {
      return requestGet<LiveFieldCatalogEntry[]>(`${baseUrl}/v1/live/current/fields/catalog`, options);
    },
    getFieldVector(quantityId: string, options?: RequestOptions) {
      return requestGet<LiveFieldVectorResponse>(
        `${baseUrl}/v1/live/current/fields/${encodeURIComponent(quantityId)}/vector`,
        options,
      );
    },
    getFieldMeta(quantityId: string, options?: RequestOptions) {
      return requestGet<LiveFieldCatalogEntry>(
        `${baseUrl}/v1/live/current/fields/${encodeURIComponent(quantityId)}/meta`,
        options,
      );
    },
  };
}
