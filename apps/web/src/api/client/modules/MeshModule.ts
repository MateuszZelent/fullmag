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
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class MeshModule {
  constructor(private client: LiveApiClient) {}

  async getSummary(opts?: RequestOptions): Promise<MeshSummaryResource> {
    return this.client.get<MeshSummaryResource>("/v1/live/current/mesh/summary", opts);
  }

  async getSummaryResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshSummaryResource>> {
    return this.client.getJsonResponse<MeshSummaryResource>(
      "/v1/live/current/mesh/summary",
      opts,
    );
  }

  async getCapabilities(opts?: RequestOptions): Promise<MeshCapabilitiesResource> {
    return this.client.get<MeshCapabilitiesResource>(
      "/v1/live/current/mesh/capabilities",
      opts,
    );
  }

  async getSemantics(opts?: RequestOptions): Promise<MeshSemanticsResource> {
    return this.client.get<MeshSemanticsResource>(
      "/v1/live/current/mesh/semantics",
      opts,
    );
  }

  async getActiveBuild(opts?: RequestOptions): Promise<MeshActiveBuildResource> {
    return this.client.get<MeshActiveBuildResource>(
      "/v1/live/current/mesh/builds/active",
      opts,
    );
  }

  async getActiveBuildResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshActiveBuildResource>> {
    return this.client.getJsonResponse<MeshActiveBuildResource>(
      "/v1/live/current/mesh/builds/active",
      opts,
    );
  }

  async getBuildHistory(opts?: RequestOptions): Promise<MeshBuildHistoryResource> {
    return this.client.get<MeshBuildHistoryResource>(
      "/v1/live/current/mesh/builds/history",
      opts,
    );
  }

  async getBuildHistoryResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshBuildHistoryResource>> {
    return this.client.getJsonResponse<MeshBuildHistoryResource>(
      "/v1/live/current/mesh/builds/history",
      opts,
    );
  }

  async getLastSuccessfulBuild(
    opts?: RequestOptions,
  ): Promise<MeshLastSuccessfulBuildResource> {
    return this.client.get<MeshLastSuccessfulBuildResource>(
      "/v1/live/current/mesh/builds/last-success",
      opts,
    );
  }

  async getLastSuccessfulBuildResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshLastSuccessfulBuildResource>> {
    return this.client.getJsonResponse<MeshLastSuccessfulBuildResource>(
      "/v1/live/current/mesh/builds/last-success",
      opts,
    );
  }

  async submitBuildCommand(
    request: MeshBuildCommandRequest,
    opts?: RequestOptions,
  ): Promise<CommandResponse> {
    return this.client.post<CommandResponse>(
      "/v1/live/current/mesh/builds/commands",
      request,
      opts,
    );
  }

  async getUniverseConfig(opts?: RequestOptions): Promise<MeshUniverseConfigResource> {
    return this.client.get<MeshUniverseConfigResource>(
      "/v1/live/current/mesh/universe/config",
      opts,
    );
  }

  async replaceUniverseConfig(
    request: MeshUniverseConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshUniverseConfigResource> {
    return this.client.put<MeshUniverseConfigResource>(
      "/v1/live/current/mesh/universe/config",
      request,
      opts,
    );
  }

  async getUniverseReport(opts?: RequestOptions): Promise<MeshUniverseReportResource> {
    return this.client.get<MeshUniverseReportResource>(
      "/v1/live/current/mesh/universe/report",
      opts,
    );
  }

  async getUniverseQuality(opts?: RequestOptions): Promise<MeshUniverseQualityResource> {
    return this.client.get<MeshUniverseQualityResource>(
      "/v1/live/current/mesh/universe/quality",
      opts,
    );
  }

  async getSharedDomainConfig(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainConfigResource> {
    return this.client.get<MeshSharedDomainConfigResource>(
      "/v1/live/current/mesh/shared-domain/config",
      opts,
    );
  }

  async replaceSharedDomainConfig(
    request: MeshSharedDomainConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainConfigResource> {
    return this.client.put<MeshSharedDomainConfigResource>(
      "/v1/live/current/mesh/shared-domain/config",
      request,
      opts,
    );
  }

  async getSharedDomainReport(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainReportResource> {
    return this.client.get<MeshSharedDomainReportResource>(
      "/v1/live/current/mesh/shared-domain/report",
      opts,
    );
  }

  async getSharedDomainQuality(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainQualityResource> {
    return this.client.get<MeshSharedDomainQualityResource>(
      "/v1/live/current/mesh/shared-domain/quality",
      opts,
    );
  }

  async getSharedDomainManifest(
    opts?: RequestOptions,
  ): Promise<MeshSharedDomainManifestResource> {
    return this.client.get<MeshSharedDomainManifestResource>(
      "/v1/live/current/mesh/shared-domain/manifest",
      opts,
    );
  }

  async getSharedDomainManifestResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshSharedDomainManifestResource>> {
    return this.client.getJsonResponse<MeshSharedDomainManifestResource>(
      "/v1/live/current/mesh/shared-domain/manifest",
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
      "/v1/live/current/mesh/shared-domain/topology",
      opts,
    );
  }

  async getObjectConfig(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectConfigResource> {
    return this.client.get<MeshObjectConfigResource>(
      `/v1/live/current/mesh/objects/${encodeURIComponent(objectId)}/config`,
      opts,
    );
  }

  async replaceObjectConfig(
    objectId: string,
    request: MeshObjectConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshObjectConfigResource> {
    return this.client.put<MeshObjectConfigResource>(
      `/v1/live/current/mesh/objects/${encodeURIComponent(objectId)}/config`,
      request,
      opts,
    );
  }

  async getObjectReport(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectReportResource> {
    return this.client.get<MeshObjectReportResource>(
      `/v1/live/current/mesh/objects/${encodeURIComponent(objectId)}/report`,
      opts,
    );
  }

  async getObjectQuality(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectQualityResource> {
    return this.client.get<MeshObjectQualityResource>(
      `/v1/live/current/mesh/objects/${encodeURIComponent(objectId)}/quality`,
      opts,
    );
  }

  async getObjectSizeField(
    objectId: string,
    opts?: RequestOptions,
  ): Promise<MeshObjectSizeFieldResource> {
    return this.client.get<MeshObjectSizeFieldResource>(
      `/v1/live/current/mesh/objects/${encodeURIComponent(objectId)}/size-field`,
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
      `/v1/live/current/mesh/objects/${encodeURIComponent(objectId)}/topology`,
      opts,
    );
  }

  async getInterfaceConfig(
    interfaceId: string,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceConfigResource> {
    return this.client.get<MeshInterfaceConfigResource>(
      `/v1/live/current/mesh/interfaces/${encodeURIComponent(interfaceId)}/config`,
      opts,
    );
  }

  async replaceInterfaceConfig(
    interfaceId: string,
    request: MeshInterfaceConfigReplaceRequest,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceConfigResource> {
    return this.client.put<MeshInterfaceConfigResource>(
      `/v1/live/current/mesh/interfaces/${encodeURIComponent(interfaceId)}/config`,
      request,
      opts,
    );
  }

  async getInterfaceReport(
    interfaceId: string,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceReportResource> {
    return this.client.get<MeshInterfaceReportResource>(
      `/v1/live/current/mesh/interfaces/${encodeURIComponent(interfaceId)}/report`,
      opts,
    );
  }

  async getInterfaceQuality(
    interfaceId: string,
    opts?: RequestOptions,
  ): Promise<MeshInterfaceQualityResource> {
    return this.client.get<MeshInterfaceQualityResource>(
      `/v1/live/current/mesh/interfaces/${encodeURIComponent(interfaceId)}/quality`,
      opts,
    );
  }
}
