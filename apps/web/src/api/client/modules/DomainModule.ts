import type { DomainMeta } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class DomainModule {
  constructor(private client: LiveApiClient) {}

  async getMeta(): Promise<DomainMeta> {
    return this.client.get<DomainMeta>("/v1/live/current/domain/meta");
  }

  async getTopology(): Promise<ArrayBuffer> {
    return this.client.getBinary("/v1/live/current/domain/topology");
  }

  async getCoordinates(): Promise<ArrayBuffer> {
    return this.client.getBinary("/v1/live/current/domain/coordinates");
  }
}
