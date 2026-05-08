import type {
  BinaryResourceResponse,
  DomainSliceMeshOverlayQuery,
  JsonResourceResponse,
  MeshOverlay2DResponse,
} from "../../types";
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

  async getSliceMeshOverlay(
    query: DomainSliceMeshOverlayQuery,
    opts?: RequestOptions,
  ): Promise<MeshOverlay2DResponse | null> {
    const response = await this.getSliceMeshOverlayResponse(query, undefined, opts);
    return response.data;
  }

  async getSliceMeshOverlayResponse(
    query: DomainSliceMeshOverlayQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<JsonResourceResponse<MeshOverlay2DResponse>> {
    const params = buildDomainSliceMeshOverlayParams(query);
    const path = `${sessionApiPaths.data.domainSliceMeshOverlay}?${params}`;
    const headers: Record<string, string> = {};
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    return this.client.getJsonResponse<MeshOverlay2DResponse>(path, {
      ...opts,
      headers: { ...opts?.headers as Record<string, string> | undefined, ...headers },
    });
  }
}

function buildDomainSliceMeshOverlayParams(
  query: DomainSliceMeshOverlayQuery,
): URLSearchParams {
  const params = new URLSearchParams({ plane: query.plane });
  if (typeof query.cut_world === "number") params.set("cut_world", String(query.cut_world));
  if (typeof query.cut_norm === "number") params.set("cut_norm", String(query.cut_norm));
  return params;
}
