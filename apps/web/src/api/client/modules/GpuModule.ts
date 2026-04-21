import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class GpuModule {
  constructor(private client: LiveApiClient) {}

  async getTelemetry(opts?: RequestOptions): Promise<unknown> {
    return this.client.get("/v1/live/current/gpu/telemetry", opts);
  }
}
