import type { LiveStatus } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class StatusModule {
  constructor(private client: LiveApiClient) {}

  async get(): Promise<LiveStatus> {
    return this.client.get<LiveStatus>("/v1/live/current/status");
  }
}
