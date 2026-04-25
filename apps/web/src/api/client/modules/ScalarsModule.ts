import type { ScalarWindow } from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class ScalarsModule {
  constructor(private client: LiveSessionClient) {}

  async getWindow(opts?: {
    sinceRevision?: number;
    limit?: number;
  }, requestOptions?: RequestOptions): Promise<ScalarWindow> {
    const params = new URLSearchParams();
    if (opts?.sinceRevision != null) {
      params.set("since_revision", String(opts.sinceRevision));
    }
    if (opts?.limit != null) {
      params.set("limit", String(opts.limit));
    }
    const qs = params.toString();
    const path = `${sessionApiPaths.data.scalars}${qs ? `?${qs}` : ""}`;
    return this.client.get<ScalarWindow>(path, requestOptions);
  }
}
