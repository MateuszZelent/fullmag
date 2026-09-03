import type { VisualizationStatePatch, VisualizationStateResource } from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class VisualizationStateModule {
  constructor(private client: LiveSessionClient) {}

  async get(opts?: RequestOptions): Promise<VisualizationStateResource> {
    return this.client.get<VisualizationStateResource>(
      sessionApiPaths.visualization.state,
      opts,
    );
  }

  async replace(
    replacement: VisualizationStateResource,
    opts?: RequestOptions,
  ): Promise<VisualizationStateResource> {
    return this.client.put<VisualizationStateResource>(
      sessionApiPaths.visualization.state,
      replacement,
      opts,
    );
  }

  async patch(
    update: VisualizationStatePatch,
    opts?: RequestOptions,
  ): Promise<VisualizationStateResource> {
    return this.client.patch<VisualizationStateResource>(
      sessionApiPaths.visualization.state,
      update,
      opts,
    );
  }
}
