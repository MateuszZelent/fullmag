import type { HealthResponse, RuntimeCapabilityMatrix } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class SystemModule {
  constructor(private client: LiveApiClient) {}

  async getHealth(): Promise<HealthResponse> {
    return this.client.get<HealthResponse>("/v1/health");
  }

  async getCapabilities(): Promise<RuntimeCapabilityMatrix> {
    return this.client.get<RuntimeCapabilityMatrix>("/v1/capabilities");
  }
}
