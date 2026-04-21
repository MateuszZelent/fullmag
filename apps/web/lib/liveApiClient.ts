"use client";

import { resolveApiBase } from "./apiBase";
import { apiPost } from "./api/client";
import { ApiError } from "./api/errors";
import {
  getLiveApiClient,
  initLiveApiClient,
} from "@/src/api/client/LiveApiClient";
import { adaptLegacyCommand } from "@/src/api/client/modules/CommandAdapter";
import type { QuantityCatalogResponse as ResourceQuantityCatalogResponse } from "@/src/api/client/modules/QuantitiesModule";
import type {
  DisplayPatchRequest,
  DisplayReplaceRequest,
  RemeshCommandRequest,
} from "@/src/api/types";
import type { MeshCommandTarget } from "./session/types";
import type { SceneDocument } from "./session/types";

type JsonObject = Record<string, unknown>;
type JsonBody = unknown;
type RequestOptions = { signal?: AbortSignal; timeout?: number };

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

function scalarWindowToLegacyRows(window: {
  columns: string[];
  rows: number[][];
}): JsonObject[] {
  return window.rows.map((values) => {
    const row: JsonObject = {};
    for (let index = 0; index < window.columns.length; index += 1) {
      const column = window.columns[index];
      if (typeof column === "string" && column.length > 0) {
        row[column] = values[index] ?? 0;
      }
    }
    return row;
  });
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
      runtimeCapabilities: `${baseUrl}/v1/capabilities`,
      commands: `${baseUrl}/v1/live/current/commands`,
      importAsset: `${baseUrl}/v1/live/current/assets/import`,
      scriptSync: `${baseUrl}/v1/live/current/authoring/script/sync`,
      scene: `${baseUrl}/v1/live/current/authoring/scene`,
      gpuTelemetry: `${baseUrl}/v1/live/current/gpu/telemetry`,
      artifacts: `${baseUrl}/v1/live/current/artifacts`,
      eigenSpectrum: `${baseUrl}/v1/live/current/eigen/spectrum`,
      eigenDispersion: `${baseUrl}/v1/live/current/eigen/dispersion`,
      eigenBranches: `${baseUrl}/v1/live/current/eigen/branches`,
      eigenMode: `${baseUrl}/v1/live/current/eigen/mode`,
      quantitiesCatalog: `${baseUrl}/v1/live/current/quantities/catalog`,
    },
    fetchScalarsHistory(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.scalars
        .getWindow(undefined, options)
        .then((window) => ({
          scalar_rows: scalarWindowToLegacyRows(window),
          scalar_rows_total: window.total_rows,
        }));
    },
    fetchFeatureFlags(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.system
        .getCapabilities(options)
        .then(() => DEFAULT_RUNTIME_FEATURE_FLAGS);
    },
    fetchRuntimeCapabilities(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.system.getCapabilities(options) as Promise<HostCapabilityMatrix>;
    },
    queueCommand(payload: JsonBody, options?: RequestOptions) {
      const command = adaptLegacyCommand((payload ?? {}) as Record<string, unknown>);
      const client = ensureResourceClient();
      return client.commands
        .submit(command, options)
        .then((response) => response as unknown as JsonObject);
    },
    queueRemesh(payload: QueueRemeshPayload, options?: RequestOptions) {
      const client = ensureResourceClient();
      const request: RemeshCommandRequest = {
        kind: "remesh",
        mesh_options: payload.mesh_options,
        mesh_target: payload.mesh_target,
        mesh_reason: payload.mesh_reason,
      };
      return client.commands
        .submit(request, options)
        .then((response) => response as unknown as JsonObject);
    },
    queueStudyDomainRemesh(meshOptions: JsonBody, meshReason?: string, options?: RequestOptions) {
      const client = ensureResourceClient();
      const request: RemeshCommandRequest = {
        kind: "remesh",
        mesh_options: meshOptions,
        mesh_target: { kind: "study_domain" },
        mesh_reason: meshReason,
      };
      return client.commands
        .submit(request, options)
        .then((response) => response as unknown as JsonObject);
    },
    importAsset(payload: JsonBody, options?: RequestOptions) {
      return requestPost<JsonObject>(`${baseUrl}/v1/live/current/assets/import`, payload, options);
    },
    syncScript(payload: JsonBody = {}, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.scene
        .syncScript(payload as Record<string, unknown>, options)
        .then((response) => response as unknown as JsonObject);
    },
    getDisplay(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.display.get(options).then(
        (response) => response as unknown as JsonObject,
      );
    },
    replaceDisplay(payload: DisplayReplaceRequest, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.display.replace(payload, options).then(
        (response) => response as unknown as JsonObject,
      );
    },
    patchDisplay(payload: DisplayPatchRequest, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.display.patch(payload, options).then(
        (response) => response as unknown as JsonObject,
      );
    },
    updateDisplay(payload: DisplayPatchRequest, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.display.patch(payload, options).then(
        (response) => response as unknown as JsonObject,
      );
    },
    updateSceneDocument(payload: JsonBody, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.scene.update(payload as SceneDocument, options);
    },
    fetchGpuTelemetry(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.gpu.getTelemetry(options) as Promise<GpuTelemetryResponse>;
    },
    fetchArtifacts(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.artifacts.list(options);
    },
    fetchEigenSpectrum<T = { modes?: unknown[] }>(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getSpectrum(options) as Promise<T>;
    },
    fetchEigenDispersion<T = { csv_path: string; path_metadata?: unknown; rows: unknown[] }>(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getDispersion(options) as Promise<T>;
    },
    fetchEigenBranches<T = unknown>(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getBranches(options) as Promise<T>;
    },
    fetchEigenMode<T = unknown>(index: number, sampleIndex?: number | null, options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.eigen.getMode({ index, sampleIndex }, options) as Promise<T>;
    },
    fetchQuantitiesCatalog(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.quantities.getCatalog(options) as Promise<ResourceQuantityCatalogResponse>;
    },
    // ── Data-plane field store (read-only, no command queue) ──────────
    getFieldCatalog(options?: RequestOptions) {
      const client = ensureResourceClient();
      return client.fields.getCatalog(options).then((catalog) =>
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
      return client.fields.getVector(quantityId, options).then((decoded) => ({
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
      return client.fields.getMeta(quantityId, options).then((meta) => ({
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
