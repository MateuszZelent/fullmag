import type { EngineLogResource } from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class LogsModule {
  constructor(private client: LiveApiClient) {}

  async getEngine(opts?: RequestOptions): Promise<EngineLogResource> {
    return this.client.get<EngineLogResource>("/v1/live/current/logs/engine", opts);
  }
}
