import type { LiveStatus } from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class StatusModule {
  constructor(private client: LiveSessionClient) {}

  async get(opts?: RequestOptions): Promise<LiveStatus> {
    return this.client.get<LiveStatus>(sessionApiPaths.status, opts);
  }
}
