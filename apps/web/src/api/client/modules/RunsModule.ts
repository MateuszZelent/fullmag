import type { CurrentRunResource } from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class RunsModule {
  constructor(private client: LiveApiClient) {}

  async current(opts?: RequestOptions): Promise<CurrentRunResource> {
    return this.client.get<CurrentRunResource>("/v1/live/current/runs/current", opts);
  }
}
