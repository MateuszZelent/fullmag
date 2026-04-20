import type { HealthResponse, CapabilityMap } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class SystemModule {
  constructor(private client: LiveApiClient) {}

  async getHealth(): Promise<HealthResponse> {
    return this.client.get<HealthResponse>("/v1/health");
  }

  async getCapabilities(): Promise<CapabilityMap> {
    return this.client.get<CapabilityMap>("/v1/runtime/capabilities");
  }
}
