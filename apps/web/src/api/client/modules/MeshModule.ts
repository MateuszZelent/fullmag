import type {
  CommandResponse,
  MeshActiveBuildResource,
  MeshBuildCommandRequest,
  MeshObjectConfigReplaceRequest,
  MeshObjectConfigResource,
  MeshSharedDomainConfigReplaceRequest,
  MeshSharedDomainConfigResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
  MeshWorkspaceResource,
} from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class MeshModule {
  constructor(private client: LiveApiClient) {}

  async getSummary(opts?: RequestOptions): Promise<MeshWorkspaceResource> {
    return this.client.get<MeshWorkspaceResource>(
      "/v1/live/current/mesh/summary",
      opts,
    );
  }

  async getActiveBuild(opts?: RequestOptions): Promise<MeshActiveBuildResource> {
    return this.client.get<MeshActiveBuildResource>(
      "/v1/live/current/mesh/builds/active",
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
}
