import type { JsonResourceResponse } from "../../types";
import type { ArtifactEntry } from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class ArtifactsModule {
  constructor(private client: LiveSessionClient) {}

  async list(opts?: RequestOptions): Promise<ArtifactEntry[]> {
    return this.client.get<ArtifactEntry[]>(sessionApiPaths.data.artifacts, opts);
  }

  async listResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<ArtifactEntry[]>> {
    return this.client.getJsonResponse<ArtifactEntry[]>(
      sessionApiPaths.data.artifacts,
      opts,
    );
  }

  async get(artifactId: string, opts?: RequestOptions): Promise<ArrayBuffer> {
    return this.client.getBinary(sessionApiPaths.data.artifact(artifactId), opts);
  }
}
