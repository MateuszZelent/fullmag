import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class EigenModule {
  constructor(private client: LiveSessionClient) {}

  async getSpectrum(opts?: RequestOptions): Promise<unknown> {
    return this.client.get(sessionApiPaths.analysis.eigenSpectrum, opts);
  }

  async getMode(
    params: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<unknown> {
    const searchParams = new URLSearchParams();
    const modeId = String(params.mode_id ?? params.modeId ?? params.index ?? "0");
    for (const [key, value] of Object.entries(params)) {
      if (
        value != null &&
        key !== "mode_id" &&
        key !== "modeId" &&
        key !== "index"
      ) {
        searchParams.set(key, String(value));
      }
    }
    const qs = searchParams.toString();
    return this.client.get(
      `${sessionApiPaths.analysis.eigenMode(modeId)}${qs ? `?${qs}` : ""}`,
      opts,
    );
  }

  async getDispersion(opts?: RequestOptions): Promise<unknown> {
    return this.client.get(sessionApiPaths.analysis.eigenDispersion, opts);
  }

  async getBranches(opts?: RequestOptions): Promise<unknown> {
    return this.client.get(sessionApiPaths.analysis.eigenBranches, opts);
  }

  async getSpectrumV2(opts?: RequestOptions): Promise<unknown> {
    return this.client.get(sessionApiPaths.analysis.eigenSpectrumV2, opts);
  }

  async getBranchesV2(opts?: RequestOptions): Promise<unknown> {
    return this.client.get(sessionApiPaths.analysis.eigenBranchesV2, opts);
  }

  async getModeV2(
    sampleIndex: number,
    modeIndex: number,
    opts?: RequestOptions,
  ): Promise<unknown> {
    return this.client.get(
      sessionApiPaths.analysis.eigenModeV2(sampleIndex, modeIndex),
      opts,
    );
  }

  async getDispersionCsv(opts?: RequestOptions): Promise<string> {
    return this.client.getText(sessionApiPaths.analysis.eigenDispersionCsv, opts);
  }
}
