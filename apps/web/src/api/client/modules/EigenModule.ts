import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class EigenModule {
  constructor(private client: LiveApiClient) {}

  async getSpectrum(opts?: RequestOptions): Promise<unknown> {
    return this.client.get("/v1/live/current/eigen/spectrum", opts);
  }

  async getMode(
    params: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<unknown> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    return this.client.get(
      `/v1/live/current/eigen/mode${qs ? `?${qs}` : ""}`,
      opts,
    );
  }

  async getDispersion(opts?: RequestOptions): Promise<unknown> {
    return this.client.get("/v1/live/current/eigen/dispersion", opts);
  }

  async getBranches(opts?: RequestOptions): Promise<unknown> {
    return this.client.get("/v1/live/current/eigen/branches", opts);
  }
}
