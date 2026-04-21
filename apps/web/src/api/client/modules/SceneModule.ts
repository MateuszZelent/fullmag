import type { SceneDocument } from "@/lib/session/types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class SceneModule {
  constructor(private client: LiveApiClient) {}

  async update(
    document: SceneDocument,
    opts?: RequestOptions,
  ): Promise<SceneDocument> {
    return this.client.post<SceneDocument>(
      "/v1/live/current/scene",
      document,
      opts,
    );
  }
}
