import type { DomainMeta } from "../../generated/openapi-types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class DomainModule {
  constructor(private client: LiveApiClient) {}

  async getMeta(opts?: RequestOptions): Promise<DomainMeta> {
    return this.client.get<DomainMeta>("/v1/live/current/domain/meta", opts);
  }

  async getTopology(opts?: RequestOptions): Promise<ArrayBuffer> {
    return this.client.getBinary("/v1/live/current/domain/topology", opts);
  }
}
