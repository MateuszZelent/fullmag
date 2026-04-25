import type { LiveStatus } from "../../contracts";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class StatusModule {
  constructor(private client: LiveApiClient) {}

  async get(opts?: RequestOptions): Promise<LiveStatus> {
    return this.client.get<LiveStatus>("/v1/live/current/status", opts);
  }
}
