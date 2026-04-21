import type {
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverStatusResource,
} from "../../types";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class SolverModule {
  constructor(private client: LiveApiClient) {}

  async status(opts?: RequestOptions): Promise<SolverStatusResource> {
    return this.client.get<SolverStatusResource>("/v1/live/current/solver/status", opts);
  }

  async currentEnergies(opts?: RequestOptions): Promise<SolverEnergyCurrentResource> {
    return this.client.get<SolverEnergyCurrentResource>(
      "/v1/live/current/solver/energies/current",
      opts,
    );
  }

  async energyHistory(
    params?: { limit?: number },
    opts?: RequestOptions,
  ): Promise<SolverEnergyHistoryResource> {
    const search = new URLSearchParams();
    if (params?.limit != null) {
      search.set("limit", String(params.limit));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.client.get<SolverEnergyHistoryResource>(
      `/v1/live/current/solver/energies/history${suffix}`,
      opts,
    );
  }
}
