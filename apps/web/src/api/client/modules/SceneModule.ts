import type {
  AuthoringMaterialPatchRequest,
  AuthoringMaterialResource,
  AuthoringObjectGeometryPatchRequest,
  AuthoringObjectInteractionPatchRequest,
  AuthoringObjectInteractionResource,
  AuthoringStudyRuntimePatchRequest,
  AuthoringStudyRuntimeResource,
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  GeometryCapabilitiesResource,
  GeometryRealizationRequest,
  GeometryRealizationSnapshot,
  GeometryValidationResource,
  ScenePatchRequest,
  ScriptSourceResponse,
  ScriptSyncRequest,
  ScriptSyncResponse,
} from "../../types";
import type { SceneDocument } from "@/lib/session/types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class SceneModule {
  constructor(private client: LiveSessionClient) {}

  async get(
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.get<SceneDocument>(
      sessionApiPaths.model.scene,
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

  async updateMagnetizationAssets(
    document: Pick<SceneDocument, "magnetization_assets">,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.updateSceneMergePatch({
      magnetization_assets: document.magnetization_assets as unknown,
    }, opts);
  }

  async updateSceneMergePatch(
    mergePatch: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.transact(
      {
        kind: "merge_patch",
        merge_patch: mergePatch,
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
      sessionApiPaths.model.scene,
      request,
      opts,
    );
  }

  async getGeometryCapabilities(
    opts?: RequestOptions,
  ): Promise<GeometryCapabilitiesResource> {
    return this.client.get<GeometryCapabilitiesResource>(
      sessionApiPaths.model.geometryCapabilities,
      opts,
    );
  }

  async getGeometryValidation(
    opts?: RequestOptions,
  ): Promise<GeometryValidationResource> {
    return this.client.get<GeometryValidationResource>(
      sessionApiPaths.model.geometryValidation,
      opts,
    );
  }

  async createGeometryRealization(
    request: GeometryRealizationRequest = {},
    opts?: RequestOptions,
  ): Promise<GeometryRealizationSnapshot> {
    return this.client.post<GeometryRealizationSnapshot>(
      sessionApiPaths.model.geometryRealizations,
      request,
      opts,
    );
  }

  async getCurrentGeometryRealization(
    opts?: RequestOptions,
  ): Promise<GeometryRealizationSnapshot> {
    return this.client.get<GeometryRealizationSnapshot>(
      sessionApiPaths.model.geometryRealizationCurrent,
      opts,
    );
  }

  async transact(
    request: AuthoringTransactionRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringTransactionResponse> {
    return this.client.post<AuthoringTransactionResponse>(
      sessionApiPaths.model.transactions,
      request,
      opts,
    );
  }

  async getStudyRuntime(
    opts?: RequestOptions,
  ): Promise<AuthoringStudyRuntimeResource> {
    return this.client.get<AuthoringStudyRuntimeResource>(
      sessionApiPaths.model.study,
      opts,
    );
  }

  async patchStudyRuntime(
    request: AuthoringStudyRuntimePatchRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringStudyRuntimeResource> {
    return this.client.patch<AuthoringStudyRuntimeResource>(
      sessionApiPaths.model.study,
      request,
      opts,
    );
  }

  async getMaterial(
    materialId: string,
    opts?: RequestOptions,
  ): Promise<AuthoringMaterialResource> {
    return this.client.get<AuthoringMaterialResource>(
      sessionApiPaths.model.material(materialId),
      opts,
    );
  }

  async patchMaterial(
    materialId: string,
    request: AuthoringMaterialPatchRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringMaterialResource> {
    return this.client.patch<AuthoringMaterialResource>(
      sessionApiPaths.model.material(materialId),
      request,
      opts,
    );
  }

  async getObjectInteraction(
    objectId: string,
    interactionKind: string,
    opts?: RequestOptions,
  ): Promise<AuthoringObjectInteractionResource> {
    return this.client.get<AuthoringObjectInteractionResource>(
      sessionApiPaths.model.objectInteraction(objectId, interactionKind),
      opts,
    );
  }

  async patchObjectGeometry(
    objectId: string,
    request: AuthoringObjectGeometryPatchRequest,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.patch<SceneDocument>(
      sessionApiPaths.model.objectGeometry(objectId),
      request,
      opts,
    );
  }

  async patchObjectInteraction(
    objectId: string,
    interactionKind: string,
    request: AuthoringObjectInteractionPatchRequest,
    opts?: RequestOptions,
  ): Promise<AuthoringObjectInteractionResource> {
    return this.client.patch<AuthoringObjectInteractionResource>(
      sessionApiPaths.model.objectInteraction(objectId, interactionKind),
      request,
      opts,
    );
  }

  async syncScript(
    request: ScriptSyncRequest = {},
    opts?: RequestOptions,
  ): Promise<ScriptSyncResponse> {
    return this.client.post<ScriptSyncResponse>(
      sessionApiPaths.model.syncs,
      request,
      opts,
    );
  }

  async getScriptSource(opts?: RequestOptions): Promise<ScriptSourceResponse> {
    return this.client.get<ScriptSourceResponse>(
      sessionApiPaths.model.script,
      opts,
    );
  }
}
