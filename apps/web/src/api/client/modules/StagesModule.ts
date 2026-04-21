import type { StageExecutionResource } from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class StagesModule {
  constructor(private client: LiveApiClient) {}

  async execution(opts?: RequestOptions): Promise<StageExecutionResource> {
    return this.client.get<StageExecutionResource>("/v1/live/current/stages/execution", opts);
  }
}
