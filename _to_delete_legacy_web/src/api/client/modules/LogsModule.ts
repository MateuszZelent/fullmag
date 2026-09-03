import type { EngineLogResource, JsonResourceResponse } from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class LogsModule {
  constructor(private client: LiveSessionClient) {}

  async getEngine(opts?: RequestOptions): Promise<EngineLogResource> {
    return this.client.get<EngineLogResource>(
      sessionApiPaths.diagnostics.engineLog,
      opts,
    );
  }

  async getEngineResponse(
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<EngineLogResource>> {
    return this.client.getJsonResponse<EngineLogResource>(
      sessionApiPaths.diagnostics.engineLog,
      opts,
    );
  }
}
