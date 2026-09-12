import type {
  SolverEnergyCurrentResource,
  SolverEnergyHistoryResource,
  SolverStatusResource,
} from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class SolverModule {
  constructor(private client: LiveSessionClient) {}

  async status(opts?: RequestOptions): Promise<SolverStatusResource> {
    return this.client.get<SolverStatusResource>(
      sessionApiPaths.simulation.solverStatus,
      opts,
    );
  }

  async currentEnergies(opts?: RequestOptions): Promise<SolverEnergyCurrentResource> {
    return this.client.get<SolverEnergyCurrentResource>(
      sessionApiPaths.simulation.solverEnergiesCurrent,
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
      `${sessionApiPaths.simulation.solverEnergiesHistory}${suffix}`,
      opts,
    );
  }
}
