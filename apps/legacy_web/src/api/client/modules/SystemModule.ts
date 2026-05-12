import type {
  HealthResponse,
  RuntimeCapabilityMatrix,
} from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class SystemModule {
  constructor(private client: LiveSessionClient) {}

  async getHealth(opts?: RequestOptions): Promise<HealthResponse> {
    return this.client.get<HealthResponse>(sessionApiPaths.platform.health, opts);
  }

  async getCapabilities(
    opts?: RequestOptions,
  ): Promise<RuntimeCapabilityMatrix> {
    return this.client.get<RuntimeCapabilityMatrix>(
      sessionApiPaths.platform.capabilities,
      opts,
    );
  }
}
