import type {
  HealthResponse,
  RuntimeCapabilityMatrix,
} from "../../contracts";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class SystemModule {
  constructor(private client: LiveApiClient) {}

  async getHealth(opts?: RequestOptions): Promise<HealthResponse> {
    return this.client.get<HealthResponse>("/v1/health", opts);
  }

  async getCapabilities(
    opts?: RequestOptions,
  ): Promise<RuntimeCapabilityMatrix> {
    return this.client.get<RuntimeCapabilityMatrix>("/v1/capabilities", opts);
  }
}
