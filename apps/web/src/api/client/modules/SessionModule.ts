import type { LiveApiClient } from "../LiveApiClient";

export class SessionModule {
  constructor(private client: LiveApiClient) {}

  async export(format: string): Promise<Blob> {
    const buffer = await this.client.getBinary(
      `/v1/live/current/state/export?format=${encodeURIComponent(format)}`,
    );
    return new Blob([buffer]);
  }

  async inspect(): Promise<unknown> {
    return this.client.get("/v1/live/current/state/inspect");
  }

  async commit(data: unknown): Promise<unknown> {
    return this.client.post("/v1/live/current/state/commit", data);
  }
}
