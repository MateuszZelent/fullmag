"use client";

import { getLiveApiClient, type RequestOptions } from "@/src/api/client/LiveApiClient";
import { adaptLegacyCommand } from "@/src/api/client/modules/CommandAdapter";
import type { DisplaySelection } from "@/src/api/generated/openapi-types";
import type {
  DisplayPatchRequest,
  DisplayReplaceRequest,
  RemeshCommandRequest,
  SessionExportRequest,
  SessionExportResponse,
  SessionImportCommitRequest,
  SessionImportCommitResponse,
  SessionImportInspectRequest,
  SessionImportInspectResponse,
} from "@/src/api/types";
import type { GpuTelemetryResponse } from "@/src/api/types";
import type { MeshCommandTarget, SceneDocument } from "@/lib/session/types";

type JsonObject = Record<string, unknown>;
type JsonBody = unknown;

interface QueueRemeshPayload {
  mesh_options?: JsonBody;
  mesh_target: MeshCommandTarget;
  mesh_reason?: string;
}

export interface ControlRoomApi {
  queueCommand: (
    payload: JsonBody,
    options?: RequestOptions,
  ) => Promise<JsonObject>;
  queueRemesh: (
    payload: QueueRemeshPayload,
    options?: RequestOptions,
  ) => Promise<JsonObject>;
  getDisplay: (
    options?: RequestOptions,
  ) => Promise<DisplaySelection>;
  replaceDisplay: (
    payload: DisplayReplaceRequest,
    options?: RequestOptions,
  ) => Promise<DisplaySelection>;
  patchDisplay: (
    payload: DisplayPatchRequest,
    options?: RequestOptions,
  ) => Promise<DisplaySelection>;
  updateSceneDocument: (
    payload: SceneDocument,
    options?: RequestOptions,
  ) => Promise<SceneDocument>;
  syncScript: (
    payload?: JsonBody,
    options?: RequestOptions,
  ) => Promise<JsonObject>;
  exportSession: (
    payload: SessionExportRequest,
    options?: RequestOptions,
  ) => Promise<SessionExportResponse>;
  inspectSessionImport: (
    payload: SessionImportInspectRequest,
    options?: RequestOptions,
  ) => Promise<SessionImportInspectResponse>;
  commitSessionImport: (
    payload: SessionImportCommitRequest,
    options?: RequestOptions,
  ) => Promise<SessionImportCommitResponse>;
  fetchGpuTelemetry: (
    options?: RequestOptions,
  ) => Promise<GpuTelemetryResponse>;
  getFieldVectorBinary: (
    quantityId: string,
    options?: RequestOptions,
  ) => Promise<ArrayBuffer>;
  getFemMeshTopologyBinary: (
    generationId?: string | null,
    options?: RequestOptions,
  ) => Promise<ArrayBuffer>;
}

export function createControlRoomApi(): ControlRoomApi {
  const client = getLiveApiClient();

  return {
    queueCommand(payload, options) {
      const command = adaptLegacyCommand((payload ?? {}) as Record<string, unknown>);
      return client.commands
        .submit(command, options)
        .then((response) => response as unknown as JsonObject);
    },
    queueRemesh(payload, options) {
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
    getDisplay(options) {
      return client.display.get(options);
    },
    replaceDisplay(payload, options) {
      return client.display.replace(payload, options);
    },
    patchDisplay(payload, options) {
      return client.display.patch(payload, options);
    },
    updateSceneDocument(payload, options) {
      return client.scene.update(payload, options);
    },
    syncScript(payload = {}, options) {
      return client.scene
        .syncScript(payload as Record<string, unknown>, options)
        .then((response) => response as unknown as JsonObject);
    },
    exportSession(payload, options) {
      return client.session.export(payload, options);
    },
    inspectSessionImport(payload, options) {
      return client.session.inspectImport(payload, options);
    },
    commitSessionImport(payload, options) {
      return client.session.commitImport(payload, options);
    },
    fetchGpuTelemetry(options) {
      return client.gpu.getTelemetry(options) as Promise<GpuTelemetryResponse>;
    },
    getFieldVectorBinary(quantityId, options) {
      return client.getBinary(
        `/v1/live/current/fields/${encodeURIComponent(quantityId)}/vector`,
        options,
      );
    },
    getFemMeshTopologyBinary(generationId, options) {
      const params = new URLSearchParams();
      if (generationId) {
        params.set("generation_id", generationId);
      }
      const path = `/v1/live/current/domain/topology${
        params.size > 0 ? `?${params.toString()}` : ""
      }`;
      return client.getBinary(path, options);
    },
  };
}
