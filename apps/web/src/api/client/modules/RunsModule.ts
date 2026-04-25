import type { CurrentRunResource } from "../../types";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class RunsModule {
  constructor(private client: LiveSessionClient) {}

  async current(opts?: RequestOptions): Promise<CurrentRunResource> {
    return this.client.get<CurrentRunResource>(
      sessionApiPaths.simulation.runsCurrent,
      opts,
    );
  }

  async get(runId: string, opts?: RequestOptions): Promise<CurrentRunResource> {
    return this.client.get<CurrentRunResource>(
      sessionApiPaths.simulation.run(runId),
      opts,
    );
  }
}
