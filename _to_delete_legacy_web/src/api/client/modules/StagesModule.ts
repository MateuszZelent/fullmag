import type { StageExecutionResource } from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class StagesModule {
  constructor(private client: LiveSessionClient) {}

  async execution(opts?: RequestOptions): Promise<StageExecutionResource> {
    return this.client.get<StageExecutionResource>(
      sessionApiPaths.simulation.stagesExecution,
      opts,
    );
  }
}
