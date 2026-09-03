import type { ScalarWindow } from "../../contracts";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class ScalarsModule {
  constructor(private client: LiveSessionClient) {}

  /**
   * Fetch a scalar data window.
   *
   * Extended for the 2D Plots pipeline (masterplan §6.3):
   * - `sinceStep`: stable incremental fetch key
   * - `maxPoints`: max points after decimation
   * - `decimate`: decimation method (none/stride/minmax/lttb)
   * - `x`: x-axis for decimation context
   * - `runId`: distinguish runs
   * - `stageIndex`: distinguish solver stages
   *
   * Parameters that the backend doesn't yet support are safely
   * included in the query string — they're ignored by older backends
   * and will activate once the backend is upgraded.
   */
  async getWindow(opts?: {
    sinceRevision?: number;
    limit?: number;
    columns?: string[];
    // New parameters for plots2d pipeline
    sinceStep?: number;
    maxPoints?: number;
    decimate?: "none" | "stride" | "minmax" | "lttb";
    x?: "time" | "step";
    runId?: string;
    stageIndex?: number;
  }, requestOptions?: RequestOptions): Promise<ScalarWindow> {
    const params = new URLSearchParams();
    if (opts?.sinceRevision != null) {
      params.set("since_revision", String(opts.sinceRevision));
    }
    if (opts?.limit != null) {
      params.set("limit", String(opts.limit));
    }
    if (opts?.columns && opts.columns.length > 0) {
      params.set("columns", opts.columns.join(","));
    }
    // Extended parameters
    if (opts?.sinceStep != null) {
      params.set("since_step", String(opts.sinceStep));
    }
    if (opts?.maxPoints != null) {
      params.set("max_points", String(opts.maxPoints));
    }
    if (opts?.decimate && opts.decimate !== "none") {
      params.set("decimate", opts.decimate);
    }
    if (opts?.x) {
      params.set("x", opts.x);
    }
    if (opts?.runId) {
      params.set("run_id", opts.runId);
    }
    if (opts?.stageIndex != null) {
      params.set("stage_index", String(opts.stageIndex));
    }
    const qs = params.toString();
    const path = `${sessionApiPaths.data.scalars}${qs ? `?${qs}` : ""}`;
    return this.client.get<ScalarWindow>(path, requestOptions);
  }
}
