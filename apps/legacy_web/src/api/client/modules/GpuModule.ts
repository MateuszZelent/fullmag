import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class GpuModule {
  constructor(private client: LiveSessionClient) {}

  async getTelemetry(opts?: RequestOptions): Promise<unknown> {
    return this.client.get(sessionApiPaths.diagnostics.gpu, opts);
  }
}
