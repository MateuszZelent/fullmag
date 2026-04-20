import type { ArtifactEntry } from "../../generated/openapi-types";
import type { LiveApiClient } from "../LiveApiClient";

export class ArtifactsModule {
  constructor(private client: LiveApiClient) {}

  async list(): Promise<ArtifactEntry[]> {
    return this.client.get<ArtifactEntry[]>("/v1/live/current/artifacts");
  }

  async get(artifactId: string): Promise<ArrayBuffer> {
    const encoded = encodeURIComponent(artifactId);
    return this.client.getBinary(`/v1/live/current/artifacts/${encoded}`);
  }
}
