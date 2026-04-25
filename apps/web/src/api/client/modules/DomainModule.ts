import type { BinaryResourceResponse } from "../../types";
import type { DomainMeta } from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class DomainModule {
  constructor(private client: LiveSessionClient) {}

  async getMeta(opts?: RequestOptions): Promise<DomainMeta> {
    return this.client.get<DomainMeta>(sessionApiPaths.data.domainMeta, opts);
  }

  async getTopology(opts?: RequestOptions): Promise<ArrayBuffer> {
    const response = await this.getTopologyResponse(opts);
    return response.buffer;
  }

  async getTopologyResponse(opts?: RequestOptions): Promise<BinaryResourceResponse> {
    return this.client.getBinaryResponse(sessionApiPaths.data.domainTopology, opts);
  }
}
