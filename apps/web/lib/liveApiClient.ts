"use client";

import { resolveApiBase } from "./apiBase";
import { apiGet, apiGetArrayBuffer, apiGetOptional, apiPost } from "./api/client";
import { ApiError } from "./api/errors";
import {
  getLiveApiClient,
  initLiveApiClient,
} from "@/src/api/client/LiveApiClient";
import { adaptLegacyCommand } from "@/src/api/client/modules/CommandAdapter";
import { scalarWindowToRows } from "@/src/api/client/modules/ScalarHistoryAdapter";
import type { DisplayUpdate, RemeshCommandRequest } from "@/src/api/types";
import type { MeshCommandTarget } from "./session/types";
import type { SceneDocument } from "./session/types";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "./debug/frontendDiagnosticFlags";

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
  status: string;
  reason?: string | null;
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
  values: Float32Array | Float64Array;
  active_mask?: boolean[] | null;
  source: string;
}

const DEFAULT_RUNTIME_FEATURE_FLAGS: RuntimeFeatureFlags = {
  disable_charts: false,
  disable_preview_2d: false,
  disable_preview_3d: false,
  disable_session_state_broadcast: false,
};

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

function ensureResourceClient() {
  try {
    return getLiveApiClient();
  } catch {
    return initLiveApiClient({ baseUrl: resolveApiBase() });
  }
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

async function requestGetArrayBuffer(url: string, options?: RequestOptions): Promise<ArrayBuffer> {
  try {
    return await apiGetArrayBuffer(url, options);
  } catch (error) {
    normalizeApiError(error);
  }
}

export function currentLiveApiClient() {
  const baseUrl = resolveApiBase();
  const binaryFieldTransportEnabled =
    FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.binaryFieldTransport;
  const binaryFemTopologyTransportEnabled =
    FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.binaryFemTopologyTransport;
  const fieldTransportMode = binaryFieldTransportEnabled ? "bin" : "json";
  const meshTransportMode = binaryFemTopologyTransportEnabled ? "bin" : "json";
  const withSnapshotTransport = (path: string) => {
    const url = new URL(path);
    url.searchParams.set("field_transport", fieldTransportMode);
    url.searchParams.set("mesh_transport", meshTransportMode);
    return url.toString();
  };

  return {
    urls: {
      bootstrap: withSnapshotTransport(`${baseUrl}/v1/live/current/bootstrap`),
      poll: withSnapshotTransport(`${baseUrl}/v1/live/current/poll`),
      runtimeCapabilities: `${baseUrl}/v1/capabilities`,
      commands: `${baseUrl}/v1/live/current/commands`,
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
      return requestGet<T>(withSnapshotTransport(`${baseUrl}/v1/live/current/bootstrap`), options);
    },
    async fetchPoll(params: { sinceVersion: number; scalarRowsTotal: number }, options?: RequestOptions) {
      const url = new URL(withSnapshotTransport(`${baseUrl}/v1/live/current/poll`));
      url.searchParams.set("since_version", String(params.sinceVersion));
      url.searchParams.set("scalar_rows_total", String(params.scalarRowsTotal));
      return requestGetOptional<JsonObject>(url.toString(), options);
    },
    fetchScalarsHistory(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.scalars
        .getWindow()
        .then((window) => ({
          scalar_rows: scalarWindowToRows(window),
          scalar_rows_total: window.total_rows,
        }));
    },
    fetchFeatureFlags(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.system
        .getCapabilities()
        .then(() => DEFAULT_RUNTIME_FEATURE_FLAGS);
    },
    fetchRuntimeCapabilities(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.system.getCapabilities() as Promise<HostCapabilityMatrix>;
    },
    queueCommand(payload: JsonBody, options?: RequestOptions) {
      const command = adaptLegacyCommand((payload ?? {}) as Record<string, unknown>);
      const client = ensureResourceClient();
      return client.commands.submit(command).then((response) => response as unknown as JsonObject);
    },
    queueRemesh(payload: QueueRemeshPayload, options?: RequestOptions) {
      const client = ensureResourceClient();
      const request: RemeshCommandRequest = {
        kind: "remesh",
        mesh_options: payload.mesh_options,
        mesh_target: payload.mesh_target,
        mesh_reason: payload.mesh_reason,
      };
      return client.commands.submit(request).then((response) => response as unknown as JsonObject);
    },
    queueStudyDomainRemesh(meshOptions: JsonBody, meshReason?: string, options?: RequestOptions) {
      const client = ensureResourceClient();
      const request: RemeshCommandRequest = {
        kind: "remesh",
        mesh_options: meshOptions,
        mesh_target: { kind: "study_domain" },
        mesh_reason: meshReason,
      };
      return client.commands.submit(request).then((response) => response as unknown as JsonObject);
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
    updateDisplay(payload: DisplayUpdate, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.display.update(payload).then(
        (response) => response as unknown as JsonObject,
      );
    },
    updateSceneDocument(payload: JsonBody, options?: RequestOptions) {
      return requestPost<SceneDocument>(`${baseUrl}/v1/live/current/scene`, payload, options);
    },
    fetchGpuTelemetry(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.gpu.getTelemetry() as Promise<GpuTelemetryResponse>;
    },
    fetchArtifacts(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.artifacts.list();
    },
    fetchEigenSpectrum<T = { modes?: unknown[] }>(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getSpectrum() as Promise<T>;
    },
    fetchEigenDispersion<T = { csv_path: string; path_metadata?: unknown; rows: unknown[] }>(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getDispersion() as Promise<T>;
    },
    fetchEigenBranches<T = unknown>(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getBranches() as Promise<T>;
    },
    fetchEigenMode<T = unknown>(index: number, sampleIndex?: number | null, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getMode({ index, sampleIndex }) as Promise<T>;
    },
    fetchQuantitiesCatalog(options?: RequestOptions) {
      return requestGet<QuantityCatalogResponse>(`${baseUrl}/v1/quantities/catalog`, options);
    },
    // ── Data-plane field store (read-only, no command queue) ──────────
    getFieldCatalog(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.fields.getCatalog().then((catalog) =>
        catalog.quantities.map((entry) => ({
          quantity_id: entry.quantity_id,
          label: entry.label,
          kind: entry.kind,
          unit: entry.unit,
          spatial_domain: entry.location,
          n_comp: entry.components,
          source: "resource_client",
          available: entry.available,
          element_count: 0,
        })),
      );
    },
    getFieldVector(quantityId: string, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.fields.getVector(quantityId).then((decoded) => ({
        quantity_id: decoded.quantityId,
        unit: "",
        n_comp: decoded.nComp,
        element_count: decoded.valueCount,
        grid: decoded.grid,
        values: decoded.values,
        active_mask: null,
        source: "binary",
      }));
    },
    getFieldVectorBinary(quantityId: string, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.getBinary(
        `/v1/live/current/fields/${encodeURIComponent(quantityId)}/vector`,
        options,
      );
    },
    getFemMeshTopologyBinary(generationId?: string | null, options?: RequestOptions) {
      const client = ensureResourceClient();
      const url = new URL("/v1/live/current/domain/topology", baseUrl);
      if (generationId) {
        url.searchParams.set("generation_id", generationId);
      }
      return client.getBinary(url.toString(), options);
    },
    getFieldMeta(quantityId: string, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.fields.getMeta(quantityId).then((meta) => ({
        quantity_id: meta.quantity_id,
        label: meta.label,
        kind: meta.kind,
        unit: meta.unit,
        spatial_domain: meta.location,
        n_comp: meta.components,
        source: "resource_client",
        available: true,
        element_count: 0,
        grid: undefined,
        stats: meta.stats
          ? {
              min: meta.stats.min,
              max: meta.stats.max,
              mean: meta.stats.mean,
            }
          : undefined,
      }));
    },
  };
}
