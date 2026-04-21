import type {
  AuthoringMaterialPatchRequest,
  AuthoringMaterialResource,
  AuthoringStudyRuntimePatchRequest,
  AuthoringStudyRuntimeResource,
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  ScenePatchRequest,
  ScriptSourceResponse,
  ScriptSyncRequest,
  ScriptSyncResponse,
} from "../../types";
import type { SceneDocument } from "@/lib/session/types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class SceneModule {
  constructor(private client: LiveApiClient) {}

  async get(
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.get<SceneDocument>(
      "/v1/live/current/authoring/scene",
      opts,
    );
  }

  async update(
    document: SceneDocument,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.transact(
      {
        kind: "replace_scene",
        scene: document as unknown as Record<string, unknown>,
      },
      opts,
    ).then(
      (response) => response.committed_scene as unknown as SceneDocument,
    );
  }

  async patch(
    request: ScenePatchRequest,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.patch<SceneDocument>(
      "/v1/live/current/authoring/scene",
      request,
      opts,
    );
  }

  async transact(
    request: AuthoringTransactionRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringTransactionResponse> {
    return this.client.post<AuthoringTransactionResponse>(
      "/v1/live/current/authoring/transactions",
      request,
      opts,
    );
  }

  async getStudyRuntime(
    opts?: RequestOptions,
  ): Promise<AuthoringStudyRuntimeResource> {
    return this.client.get<AuthoringStudyRuntimeResource>(
      "/v1/live/current/authoring/study/runtime",
      opts,
    );
  }

  async patchStudyRuntime(
    request: AuthoringStudyRuntimePatchRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringStudyRuntimeResource> {
    return this.client.patch<AuthoringStudyRuntimeResource>(
      "/v1/live/current/authoring/study/runtime",
      request,
      opts,
    );
  }

  async getMaterial(
    materialId: string,
    opts?: RequestOptions,
  ): Promise<AuthoringMaterialResource> {
    return this.client.get<AuthoringMaterialResource>(
      `/v1/live/current/authoring/model/materials/${encodeURIComponent(materialId)}`,
      opts,
    );
  }

  async patchMaterial(
    materialId: string,
    request: AuthoringMaterialPatchRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringMaterialResource> {
    return this.client.patch<AuthoringMaterialResource>(
      `/v1/live/current/authoring/model/materials/${encodeURIComponent(materialId)}`,
      request,
      opts,
    );
  }

  async syncScript(
    request: ScriptSyncRequest = {},
    opts?: RequestOptions,
  ): Promise<ScriptSyncResponse> {
    return this.client.post<ScriptSyncResponse>(
      "/v1/live/current/authoring/script/sync",
      request,
      opts,
    );
  }

  async getScriptSource(opts?: RequestOptions): Promise<ScriptSourceResponse> {
    return this.client.get<ScriptSourceResponse>(
      "/v1/live/current/authoring/script/source",
      opts,
    );
  }
}
