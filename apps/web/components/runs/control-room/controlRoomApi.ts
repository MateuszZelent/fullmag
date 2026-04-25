"use client";

import type { RequestOptions } from "@/src/api/client/LiveSessionClient";
import { getLiveSessionClient } from "@/src/api/client/LiveSessionClient";
import { normalizeCommandRequest } from "@/src/api/client/modules/CommandAdapter";
import { sessionApiPaths } from "@/src/api/client/sessionPaths";
import type { DisplaySelection, LiveStatus } from "@/src/api/contracts";
import type {
  AuthoringStudyRuntimePatchRequest,
  AuthoringStudyRuntimeResource,
  DisplayPatchRequest,
  DisplayReplaceRequest,
  FieldSampleScopeKind,
  MeshBuildCommandRequest,
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
  getStatus: (
    options?: RequestOptions,
  ) => Promise<LiveStatus>;
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
  patchStudyRuntime: (
    payload: AuthoringStudyRuntimePatchRequest,
    options?: RequestOptions,
  ) => Promise<AuthoringStudyRuntimeResource>;
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
  getScopedFieldVectorBinary: (
    quantityId: string,
    scope: { kind: FieldSampleScopeKind; id?: string | null },
    options?: RequestOptions,
  ) => Promise<ArrayBuffer>;
  getFemMeshTopologyBinary: (
    generationId?: string | null,
    options?: RequestOptions,
  ) => Promise<ArrayBuffer>;
  getFemMeshObjectTopologyBinary: (
    objectId: string,
    options?: RequestOptions,
  ) => Promise<ArrayBuffer>;
  getFemMeshPartTopologyBinary: (
    partId: string,
    options?: RequestOptions,
  ) => Promise<ArrayBuffer>;
}

export function createControlRoomApi(): ControlRoomApi {
  const client = getLiveSessionClient();

  return {
    queueCommand(payload, options) {
      const command = normalizeCommandRequest((payload ?? {}) as Record<string, unknown>);
      return client.commands
        .submit(command, options)
        .then((response) => response as unknown as JsonObject);
    },
    queueRemesh(payload, options) {
      const request: MeshBuildCommandRequest = {
        mesh_options: payload.mesh_options,
        mesh_target: payload.mesh_target,
        mesh_reason: payload.mesh_reason,
      };
      return client.mesh
        .submitBuildCommand(request, options)
        .then((response) => response as unknown as JsonObject);
    },
    getStatus(options) {
      return client.status.get(options);
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
    patchStudyRuntime(payload, options) {
      return client.scene.patchStudyRuntime(payload, options);
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
        sessionApiPaths.data.fieldVector(quantityId),
        options,
      );
    },
    getScopedFieldVectorBinary(quantityId, scope, options) {
      const params = new URLSearchParams({ scope_kind: scope.kind });
      if (scope.id) {
        params.set("scope_id", scope.id);
      }
      return client.getBinary(
        `${sessionApiPaths.data.fieldVector(quantityId)}?${params.toString()}`,
        options,
      );
    },
    getFemMeshTopologyBinary(generationId, options) {
      const params = new URLSearchParams();
      if (generationId) {
        params.set("generation_id", generationId);
      }
      const path = `${sessionApiPaths.meshing.sharedDomainTopology}${
        params.size > 0 ? `?${params.toString()}` : ""
      }`;
      return client.getBinary(path, options);
    },
    getFemMeshObjectTopologyBinary(objectId, options) {
      return client.getBinary(sessionApiPaths.meshing.objectTopology(objectId), options);
    },
    getFemMeshPartTopologyBinary(partId, options) {
      return client.getBinary(sessionApiPaths.meshing.partTopology(partId), options);
    },
  };
}
