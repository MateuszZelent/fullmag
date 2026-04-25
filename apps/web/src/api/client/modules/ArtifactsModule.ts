import type { JsonResourceResponse } from "../../types";
import type { ArtifactEntry } from "../../contracts";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class ArtifactsModule {
  constructor(private client: LiveApiClient) {}

  async list(opts?: RequestOptions): Promise<ArtifactEntry[]> {
    return this.client.get<ArtifactEntry[]>("/v1/live/current/artifacts", opts);
  }

  async listResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<ArtifactEntry[]>> {
    return this.client.getJsonResponse<ArtifactEntry[]>(
      "/v1/live/current/artifacts",
      opts,
    );
  }

  async get(artifactId: string, opts?: RequestOptions): Promise<ArrayBuffer> {
    const encoded = encodeURIComponent(artifactId);
    return this.client.getBinary(`/v1/live/current/artifacts/${encoded}`, opts);
  }
}
