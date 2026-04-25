import type { BinaryResourceResponse } from "../../types";
import type {
  FieldBinaryResponse,
  FieldSliceMeta,
  FieldSliceQuery,
  FieldVectorOptions,
} from "../../types";
import type { FieldCatalog, FieldMeta } from "../../contracts";
import type { DecodedFieldVector } from "../../codecs/types";
import { decodeFieldVectorOffThread } from "../../codecs/decodeOffThread";
import type { LiveApiClient, RequestOptions } from "../LiveApiClient";

export class FieldsModule {
  constructor(private client: LiveApiClient) {}

  async getCatalog(opts?: RequestOptions): Promise<FieldCatalog> {
    return this.client.get<FieldCatalog>("/v1/live/current/fields/catalog", opts);
  }

  async getMeta(quantityId: string, opts?: RequestOptions): Promise<FieldMeta> {
    const encoded = encodeURIComponent(quantityId);
    return this.client.get<FieldMeta>(
      `/v1/live/current/fields/${encoded}/meta`,
      opts,
    );
  }

  async getVector(
    quantityId: string,
    opts?: RequestOptions,
  ): Promise<DecodedFieldVector> {
    const response = await this.getVectorResponse(quantityId, undefined, opts);
    if (!response.buffer) {
      throw new Error("getVector: unexpectedly received 304 Not Modified without a prior buffer");
    }
    return decodeFieldVectorOffThread(response.buffer);
  }

  /** @deprecated Use `getVectorResponse(id, options, opts)` instead. */
  async getVectorResponseLegacy(
    quantityId: string,
    opts?: RequestOptions,
  ): Promise<BinaryResourceResponse> {
    const encoded = encodeURIComponent(quantityId);
    return this.client.getBinaryResponse(
      `/v1/live/current/fields/${encoded}/vector?format=bin`,
      opts,
    );
  }

  /**
   * Fetches a field vector binary buffer with optional component selection and ETag caching.
   *
   * Returns `FieldBinaryResponse` with `buffer === null` and `status === 304` when the
   * resource has not changed (requires `vectorOptions.etag` to be set).
   */
  async getVectorResponse(
    quantityId: string,
    vectorOptions?: FieldVectorOptions,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const encoded = encodeURIComponent(quantityId);
    const params = new URLSearchParams({ format: "bin" });
    if (vectorOptions?.component && vectorOptions.component !== "full") {
      params.set("component", vectorOptions.component);
    }
    const path = `/v1/live/current/fields/${encoded}/vector?${params.toString()}`;

    const headers: Record<string, string> = {};
    if (vectorOptions?.etag) {
      headers["If-None-Match"] = vectorOptions.etag;
    }

    const raw = await this.client.getBinaryResponse(path, {
      ...opts,
      headers: { ...opts?.headers as Record<string, string> | undefined, ...headers },
    });

    const etag = raw.headers.get("ETag");
    const status = (raw.status === 304 ? 304 : 200) as 200 | 304;
    const buffer = status === 304 ? null : raw.buffer;
    return { buffer, etag, status, headers: raw.headers };
  }

  // ── Slice (2-D) ──────────────────────────────────────────────────

  /**
   * Returns JSON metadata for a 2-D slice without transferring field data.
   * Use this to learn pixel dimensions, ETag, and resolved cut position.
   */
  async getSliceMeta(
    quantityId: string,
    query: FieldSliceQuery,
    opts?: RequestOptions,
  ): Promise<FieldSliceMeta> {
    const encoded = encodeURIComponent(quantityId);
    const params = buildSliceParams(query);
    return this.client.get<FieldSliceMeta>(
      `/v1/live/current/fields/${encoded}/slice/meta?${params}`,
      opts,
    );
  }

  /**
   * Returns the scalar (single-component) field binary buffer for a 2-D slice.
   * Sends `If-None-Match` when `etag` is provided; returns `buffer === null` on 304.
   */
  async getSliceScalarResponse(
    quantityId: string,
    query: FieldSliceQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const encoded = encodeURIComponent(quantityId);
    const params = buildSliceParams(query);
    const path = `/v1/live/current/fields/${encoded}/slice/scalar?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  /**
   * Returns the arrow (vector glyph) field binary buffer for a 2-D slice.
   * Sends `If-None-Match` when `etag` is provided; returns `buffer === null` on 304.
   */
  async getSliceArrowsResponse(
    quantityId: string,
    query: FieldSliceQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const encoded = encodeURIComponent(quantityId);
    const params = buildSliceParams(query, { arrows: true });
    const path = `/v1/live/current/fields/${encoded}/slice/arrows?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  private async _binaryWithEtag(
    path: string,
    etag: string | undefined,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const headers: Record<string, string> = {};
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    const raw = await this.client.getBinaryResponse(path, {
      ...opts,
      headers: { ...opts?.headers as Record<string, string> | undefined, ...headers },
    });
    const outEtag = raw.headers.get("ETag");
    const status = (raw.status === 304 ? 304 : 200) as 200 | 304;
    return { buffer: status === 304 ? null : raw.buffer, etag: outEtag, status, headers: raw.headers };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildSliceParams(
  q: FieldSliceQuery,
  extra?: { arrows?: boolean },
): URLSearchParams {
  const p = new URLSearchParams({ plane: q.plane });
  if (q.component && q.component !== "full") p.set("component", q.component);
  if (q.cut_world !== undefined) p.set("cut_world", String(q.cut_world));
  if (q.cut_norm !== undefined) p.set("cut_norm", String(q.cut_norm));
  if (q.x_size !== undefined) p.set("x_size", String(q.x_size));
  if (q.y_size !== undefined) p.set("y_size", String(q.y_size));
  if (q.max_points !== undefined) p.set("max_points", String(q.max_points));
  if (extra?.arrows || q.include_arrows) p.set("include_arrows", "true");
  if (q.arrow_every !== undefined) p.set("arrow_every", String(q.arrow_every));
  if (q.max_arrows !== undefined) p.set("max_arrows", String(q.max_arrows));
  return p;
}
