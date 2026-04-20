import type { ScalarWindow } from "../../types";
import type { LiveApiClient } from "../LiveApiClient";

export class ScalarsModule {
  constructor(private client: LiveApiClient) {}

  async getWindow(opts?: {
    sinceRevision?: number;
    limit?: number;
  }): Promise<ScalarWindow> {
    const params = new URLSearchParams();
    if (opts?.sinceRevision != null) {
      params.set("since_revision", String(opts.sinceRevision));
    }
    if (opts?.limit != null) {
      params.set("limit", String(opts.limit));
    }
    const qs = params.toString();
    const path = `/v1/live/current/scalars${qs ? `?${qs}` : ""}`;
    return this.client.get<ScalarWindow>(path);
  }
}
