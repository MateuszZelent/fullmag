import type { LiveApiClient } from "../LiveApiClient";

export class EigenModule {
  constructor(private client: LiveApiClient) {}

  async getSpectrum(): Promise<unknown> {
    return this.client.get("/v1/live/current/eigen/spectrum");
  }

  async getMode(params: Record<string, unknown>): Promise<unknown> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value != null) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    return this.client.get(`/v1/live/current/eigen/mode${qs ? `?${qs}` : ""}`);
  }

  async getDispersion(): Promise<unknown> {
    return this.client.get("/v1/live/current/eigen/dispersion");
  }

  async getBranches(): Promise<unknown> {
    return this.client.get("/v1/live/current/eigen/branches");
  }
}
