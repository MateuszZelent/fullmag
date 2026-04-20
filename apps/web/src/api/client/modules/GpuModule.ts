import type { LiveApiClient } from "../LiveApiClient";

export class GpuModule {
  constructor(private client: LiveApiClient) {}

  async getTelemetry(): Promise<unknown> {
    return this.client.get("/v1/live/current/gpu/telemetry");
  }
}
