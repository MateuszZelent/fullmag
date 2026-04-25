import type {
  BinaryResourceResponse,
  JsonResourceResponse,
  CommandResponse,
  MeshActiveBuildResource,
  MeshBuildCommandRequest,
  MeshBuildHistoryResource,
  MeshCapabilitiesResource,
  MeshSemanticsResource,
  MeshInterfaceConfigReplaceRequest,
  MeshInterfaceConfigResource,
  MeshInterfaceQualityResource,
  MeshInterfaceReportResource,
  MeshLastSuccessfulBuildResource,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
  MeshObjectQualityResource,
  MeshObjectReportResource,
  MeshObjectSizeFieldResource,
  MeshSharedDomainConfigReplaceRequest,
  MeshSharedDomainConfigResource,
  MeshSharedDomainManifestResource,
  MeshSharedDomainQualityResource,
  MeshSharedDomainReportResource,
  MeshSummaryResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
  MeshUniverseQualityResource,
  MeshUniverseReportResource,
} from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class MeshModule {
  constructor(private client: LiveSessionClient) {}

  async getSummary(opts?: RequestOptions): Promise<MeshSummaryResource> {
    return this.client.get<MeshSummaryResource>(sessionApiPaths.meshing.summary, opts);
  }

  async getSummaryResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshSummaryResource>> {
    return this.client.getJsonResponse<MeshSummaryResource>(
      sessionApiPaths.meshing.summary,
      opts,
    );
  }

  async getCapabilities(opts?: RequestOptions): Promise<MeshCapabilitiesResource> {
    return this.client.get<MeshCapabilitiesResource>(
      sessionApiPaths.meshing.capabilities,
      opts,
    );
  }

  async getSemantics(opts?: RequestOptions): Promise<MeshSemanticsResource> {
    return this.client.get<MeshSemanticsResource>(
      sessionApiPaths.meshing.semantics,
      opts,
    );
  }

  async getActiveBuild(opts?: RequestOptions): Promise<MeshActiveBuildResource> {
    return this.client.get<MeshActiveBuildResource>(
      sessionApiPaths.meshing.currentBuild,
      opts,
    );
  }

  async getActiveBuildResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshActiveBuildResource>> {
    return this.client.getJsonResponse<MeshActiveBuildResource>(
      sessionApiPaths.meshing.currentBuild,
      opts,
    );
  }

  async getBuildHistory(opts?: RequestOptions): Promise<MeshBuildHistoryResource> {
    return this.client.get<MeshBuildHistoryResource>(
      sessionApiPaths.meshing.builds,
      opts,
    );
  }

  async getBuildHistoryResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshBuildHistoryResource>> {
    return this.client.getJsonResponse<MeshBuildHistoryResource>(
      sessionApiPaths.meshing.builds,
      opts,
    );
  }

  async getLastSuccessfulBuild(
    opts?: RequestOptions,
  ): Promise<MeshLastSuccessfulBuildResource> {
    return this.client.get<MeshLastSuccessfulBuildResource>(
      sessionApiPaths.meshing.latestSuccessfulBuild,
      opts,
    );
  }

  async getLastSuccessfulBuildResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshLastSuccessfulBuildResource>> {
    return this.client.getJsonResponse<MeshLastSuccessfulBuildResource>(
      sessionApiPaths.meshing.latestSuccessfulBuild,
      opts,
    );
  }

  async submitBuildCommand(
    request: MeshBuildCommandRequest,
    opts?: RequestOptions,
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      sessionApiPaths.simulation.commands,
      { kind: "mesh_build", ...request },
      opts,
    );
  }

  async getUniverseConfig(opts?: RequestOptions): Promise<MeshUniverseConfigResource> {
    return this.client.get<MeshUniverseConfigResource>(
      sessionApiPaths.meshing.policyUniverse,
      opts,
    );
  }

  async replaceUniverseConfig(
    request: MeshUniverseConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshUniverseConfigResource> {
    return this.client.put<MeshUniverseConfigResource>(
      sessionApiPaths.meshing.policyUniverse,
      request,
      opts,
    );
  }

  async getUniverseReport(opts?: RequestOptions): Promise<MeshUniverseReportResource> {
    return this.client.get<MeshUniverseReportResource>(
      sessionApiPaths.meshing.universeReport,
      opts,
    );
  }

  async getUniverseQuality(opts?: RequestOptions): Promise<MeshUniverseQualityResource> {
    return this.client.get<MeshUniverseQualityResource>(
      sessionApiPaths.meshing.universeQuality,
      opts,
    );
  }

  async getSharedDomainConfig(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainConfigResource> {
    return this.client.get<MeshSharedDomainConfigResource>(
      sessionApiPaths.meshing.policySharedDomain,
      opts,
    );
  }

  async replaceSharedDomainConfig(
    request: MeshSharedDomainConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainConfigResource> {
    return this.client.put<MeshSharedDomainConfigResource>(
      sessionApiPaths.meshing.policySharedDomain,
      request,
      opts,
    );
  }

  async getSharedDomainReport(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainReportResource> {
    return this.client.get<MeshSharedDomainReportResource>(
      sessionApiPaths.meshing.sharedDomainReport,
      opts,
    );
  }

  async getSharedDomainQuality(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainQualityResource> {
    return this.client.get<MeshSharedDomainQualityResource>(
      sessionApiPaths.meshing.sharedDomainQuality,
      opts,
    );
  }

  async getSharedDomainManifest(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainManifestResource> {
    return this.client.get<MeshSharedDomainManifestResource>(
      sessionApiPaths.meshing.sharedDomainManifest,
      opts,
    );
  }

  async getSharedDomainManifestResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshSharedDomainManifestResource>> {
    return this.client.getJsonResponse<MeshSharedDomainManifestResource>(
      sessionApiPaths.meshing.sharedDomainManifest,
      opts,
    );
  }

  async getSharedDomainTopology(opts?: RequestOptions): Promise<ArrayBuffer> {
    const response = await this.getSharedDomainTopologyResponse(opts);
    return response.buffer;
  }

  async getSharedDomainTopologyResponse(
    opts?: RequestOptions,
  ): Promise<BinaryResourceResponse> {
    return this.client.getBinaryResponse(
      sessionApiPaths.meshing.sharedDomainTopology,
      opts,
    );
  }

  async getObjectConfig(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectConfigResource> {
    return this.client.get<MeshObjectConfigResource>(
      sessionApiPaths.meshing.policyObject(objectId),
      opts,
    );
  }

  async replaceObjectConfig(
    objectId: string,
    request: MeshObjectConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshObjectConfigResource> {
    return this.client.put<MeshObjectConfigResource>(
      sessionApiPaths.meshing.policyObject(objectId),
      request,
      opts,
    );
  }

  async getObjectReport(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectReportResource> {
    return this.client.get<MeshObjectReportResource>(
      sessionApiPaths.meshing.objectReport(objectId),
      opts,
    );
  }

  async getObjectQuality(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectQualityResource> {
    return this.client.get<MeshObjectQualityResource>(
      sessionApiPaths.meshing.objectQuality(objectId),
      opts,
    );
  }

  async getObjectSizeField(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectSizeFieldResource> {
    return this.client.get<MeshObjectSizeFieldResource>(
      sessionApiPaths.meshing.objectSizeField(objectId),
      opts,
    );
  }

  async getObjectTopology(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<ArrayBuffer> {
    const response = await this.getObjectTopologyResponse(objectId, opts);
    return response.buffer;
  }

  async getObjectTopologyResponse(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<BinaryResourceResponse> {
    return this.client.getBinaryResponse(
      sessionApiPaths.meshing.objectTopology(objectId),
      opts,
    );
  }

  async getPartTopology(
    partId: string,
    opts?: RequestOptions,
  ): Promise<ArrayBuffer> {
    const response = await this.getPartTopologyResponse(partId, opts);
    return response.buffer;
  }

  async getPartTopologyResponse(
    partId: string,
    opts?: RequestOptions,
  ): Promise<BinaryResourceResponse> {
    return this.client.getBinaryResponse(
      sessionApiPaths.meshing.partTopology(partId),
      opts,
    );
  }

  async getInterfaceConfig(
    interfaceId: string,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceConfigResource> {
    return this.client.get<MeshInterfaceConfigResource>(
      sessionApiPaths.meshing.policyInterface(interfaceId),
      opts,
    );
  }

  async replaceInterfaceConfig(
    interfaceId: string,
    request: MeshInterfaceConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceConfigResource> {
    return this.client.put<MeshInterfaceConfigResource>(
      sessionApiPaths.meshing.policyInterface(interfaceId),
      request,
      opts,
    );
  }

  async getInterfaceReport(
    interfaceId: string,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceReportResource> {
    return this.client.get<MeshInterfaceReportResource>(
      sessionApiPaths.meshing.interfaceReport(interfaceId),
      opts,
    );
  }

  async getInterfaceQuality(
    interfaceId: string,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceQualityResource> {
    return this.client.get<MeshInterfaceQualityResource>(
      sessionApiPaths.meshing.interfaceQuality(interfaceId),
      opts,
    );
  }
}
