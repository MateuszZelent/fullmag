import type {
  AuthoringMaterialPatchRequest,
  AuthoringMaterialResource,
  AuthoringCreateObjectTransactionRequest,
  AuthoringObjectGeometryPatchRequest,
  AuthoringObjectInteractionPatchRequest,
  AuthoringObjectInteractionResource,
  AuthoringStudyRuntimePatchRequest,
  AuthoringStudyRuntimeResource,
  AuthoringTransactionRequest,
  AuthoringTransactionResponse,
  GeometryCapabilitiesResource,
  GeometryDiagnosticsResource,
  GeometryRealizationRequest,
  GeometryRealizationSnapshot,
  GeometryValidationResource,
  ObjectCreateRequest,
  ObjectPatchRequest,
  RegionListResource,
  RegionPatchRequest,
  ScenePatchRequest,
  ScriptSourceResponse,
  ScriptSyncRequest,
  ScriptSyncResponse,
  UniverseFitRequest,
  UniversePatchRequest,
  UniverseResource,
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

  async getGeometryDiagnostics(
    opts?: RequestOptions,
  ): Promise<GeometryDiagnosticsResource> {
    return this.client.get<GeometryDiagnosticsResource>(
      sessionApiPaths.model.geometryDiagnostics,
      opts,
    );
  }

  async getGeometryDiagnostic(
    diagnosticId: string,
    opts?: RequestOptions,
  ): Promise<GeometryDiagnosticsResource["diagnostics"][number]> {
    return this.client.get<GeometryDiagnosticsResource["diagnostics"][number]>(
      sessionApiPaths.model.geometryDiagnostic(diagnosticId),
      opts,
    );
  }

  async createObjectResource(
    request: ObjectCreateRequest,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.post<SceneDocument>(
      sessionApiPaths.model.objects,
      request,
      opts,
    );
  }

  async patchObjectResource(
    objectId: string,
    request: ObjectPatchRequest,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.patch<SceneDocument>(
      sessionApiPaths.model.object(objectId),
      request,
      opts,
    );
  }

  async deleteObjectResource(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.delete<SceneDocument>(
      sessionApiPaths.model.object(objectId),
      opts,
    );
  }

  async getRegions(
    opts?: RequestOptions,
  ): Promise<RegionListResource> {
    return this.client.get<RegionListResource>(
      sessionApiPaths.model.regions,
      opts,
    );
  }

  async patchRegion(
    regionId: string,
    request: RegionPatchRequest,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.patch<SceneDocument>(
      sessionApiPaths.model.region(regionId),
      request,
      opts,
    );
  }

  async getUniverse(
    opts?: RequestOptions,
  ): Promise<UniverseResource> {
    return this.client.get<UniverseResource>(
      sessionApiPaths.model.universe,
      opts,
    );
  }

  async patchUniverse(
    request: UniversePatchRequest,
    opts?: RequestOptions,
  ): Promise<UniverseResource> {
    return this.client.patch<UniverseResource>(
      sessionApiPaths.model.universe,
      request,
      opts,
    );
  }

  async fitUniverse(
    request: UniverseFitRequest = {},
    opts?: RequestOptions,
  ): Promise<UniverseResource> {
    return this.client.post<UniverseResource>(
      sessionApiPaths.model.universeFit,
      request,
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

  async createObject(
    request: Omit<AuthoringCreateObjectTransactionRequest, "kind">,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.transact(
      {
        kind: "create_object",
        ...request,
      },
      opts,
    ).then((response) => response.committed_scene as unknown as SceneDocument);
  }

  async deleteObject(
    objectId: string,
    baseRevision?: number,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.transact(
      {
        kind: "delete_object",
        object_id: objectId,
        ...(baseRevision != null ? { base_revision: baseRevision } : {}),
      },
      opts,
    ).then((response) => response.committed_scene as unknown as SceneDocument);
  }

  async renameObject(
    objectId: string,
    name: string,
    baseRevision?: number,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.transact(
      {
        kind: "rename_object",
        object_id: objectId,
        name,
        ...(baseRevision != null ? { base_revision: baseRevision } : {}),
      },
      opts,
    ).then((response) => response.committed_scene as unknown as SceneDocument);
  }

  async commitObjectTransform(
    objectId: string,
    transform: Record<string, unknown>,
    baseRevision?: number,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.transact(
      {
        kind: "commit_object_transform",
        object_id: objectId,
        transform,
        ...(baseRevision != null ? { base_revision: baseRevision } : {}),
      },
      opts,
    ).then((response) => response.committed_scene as unknown as SceneDocument);
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
