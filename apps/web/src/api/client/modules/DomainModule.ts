import type { BinaryResourceResponse } from "../../types";
import type { DomainMeta } from "../../generated/openapi-types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class DomainModule {
  constructor(private client: LiveApiClient) {}

  async getMeta(opts?: RequestOptions): Promise<DomainMeta> {
    return this.client.get<DomainMeta>("/v1/live/current/domain/meta", opts);
  }

  async getTopology(opts?: RequestOptions): Promise<ArrayBuffer> {
    const response = await this.getTopologyResponse(opts);
    return response.buffer;
  }

  async getTopologyResponse(opts?: RequestOptions): Promise<BinaryResourceResponse> {
    return this.client.getBinaryResponse("/v1/live/current/domain/topology", opts);
  }
}
