import type { LiveApiClient } from "../LiveApiClient";

export class SessionModule {
  constructor(private client: LiveApiClient) {}

  async export(format?: string): Promise<unknown> {
    return this.client.post("/v1/live/current/session/export", {
      format: format ?? "json",
    });
  }

  async inspect(): Promise<unknown> {
    return this.client.get("/v1/live/current/session/inspect");
  }

  async commit(data: unknown): Promise<unknown> {
    return this.client.post("/v1/live/current/session/commit", data);
  }
}
