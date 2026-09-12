import type { BinaryResourceResponse } from "../../types";
import type {
  FieldBinaryResponse,
  FieldProjectionMeta,
  FieldProjectionMatrixQuery,
  FieldProjectionProfile,
  FieldProjectionProfileQuery,
  FieldProjectionQuery,
  FieldMatrixResponse,
  FieldRenderPngQuery,
  FieldSliceMeta,
  FieldSliceMatrixQuery,
  FieldSliceQuery,
  FieldVectorOptions,
} from "../../types";
import type { FieldCatalog, FieldMeta } from "../../contracts";
import type { DecodedFieldVector } from "../../codecs/types";
import { decodeFieldVectorOffThread } from "../../codecs/decodeOffThread";
import type { LiveSessionClient, RequestOptions } from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

export class FieldsModule {
  constructor(private client: LiveSessionClient) {}

  async getCatalog(opts?: RequestOptions): Promise<FieldCatalog> {
    return this.client.get<FieldCatalog>(sessionApiPaths.data.fields, opts);
  }

  async getMeta(quantityId: string, opts?: RequestOptions): Promise<FieldMeta> {
    return this.client.get<FieldMeta>(
      sessionApiPaths.data.fieldMeta(quantityId),
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
    return decodeFieldVectorOffThread(response.buffer, { transferInput: true });
  }

  /** @deprecated Use `getVectorResponse(id, options, opts)` instead. */
  async getVectorResponseLegacy(
    quantityId: string,
    opts?: RequestOptions,
  ): Promise<BinaryResourceResponse> {
    return this.client.getBinaryResponse(
      `${sessionApiPaths.data.fieldVector(quantityId)}?format=bin`,
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
    const params = new URLSearchParams({ format: "bin" });
    if (vectorOptions?.component && vectorOptions.component !== "full") {
      params.set("component", vectorOptions.component);
    }
    if (vectorOptions?.scope_kind && vectorOptions.scope_kind !== "full") {
      params.set("scope_kind", vectorOptions.scope_kind);
    }
    if (vectorOptions?.scope_id) {
      params.set("scope_id", vectorOptions.scope_id);
    }
    const path = `${sessionApiPaths.data.fieldVector(quantityId)}?${params.toString()}`;

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
    const params = buildSliceParams(query);
    return this.client.get<FieldSliceMeta>(
      `${sessionApiPaths.data.fieldSliceMeta(quantityId)}?${params}`,
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
    const params = buildSliceParams(query);
    const path = `${sessionApiPaths.data.fieldSliceScalar(quantityId)}?${params}`;
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
    const params = buildSliceParams(query, { arrows: true });
    const path = `${sessionApiPaths.data.fieldSliceArrows(quantityId)}?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  async getSliceMatrix(
    quantityId: string,
    query: FieldSliceMatrixQuery,
    opts?: RequestOptions,
  ): Promise<FieldMatrixResponse> {
    const params = buildSliceMatrixParams(query);
    return this.client.get<FieldMatrixResponse>(
      `${sessionApiPaths.data.fieldSliceMatrix(quantityId)}?${params}`,
      opts,
    );
  }

  async getSliceRenderPngResponse(
    quantityId: string,
    query: FieldRenderPngQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const params = buildRenderPngParams(query);
    const path = `${sessionApiPaths.data.fieldSliceRenderPng(quantityId)}?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  // ── Projection (all-layer 2-D) ─────────────────────────────────

  async getProjectionMeta(
    quantityId: string,
    query: FieldProjectionQuery,
    opts?: RequestOptions,
  ): Promise<FieldProjectionMeta> {
    const params = buildProjectionParams(query);
    return this.client.get<FieldProjectionMeta>(
      `${sessionApiPaths.data.fieldProjectionMeta(quantityId)}?${params}`,
      opts,
    );
  }

  async getProjectionScalarResponse(
    quantityId: string,
    query: FieldProjectionQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const params = buildProjectionParams(query);
    const path = `${sessionApiPaths.data.fieldProjectionScalar(quantityId)}?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  async getProjectionEmptyMaskResponse(
    quantityId: string,
    query: FieldProjectionQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const params = buildProjectionParams(query);
    const path = `${sessionApiPaths.data.fieldProjectionEmptyMask(quantityId)}?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  async getProjectionMatrix(
    quantityId: string,
    query: FieldProjectionMatrixQuery,
    opts?: RequestOptions,
  ): Promise<FieldMatrixResponse> {
    const params = buildProjectionMatrixParams(query);
    return this.client.get<FieldMatrixResponse>(
      `${sessionApiPaths.data.fieldProjectionMatrix(quantityId)}?${params}`,
      opts,
    );
  }

  async getProjectionRenderPngResponse(
    quantityId: string,
    query: FieldRenderPngQuery,
    etag?: string,
    opts?: RequestOptions,
  ): Promise<FieldBinaryResponse> {
    const params = buildRenderPngParams({ ...query, mode: "projection" });
    const path = `${sessionApiPaths.data.fieldProjectionRenderPng(quantityId)}?${params}`;
    return this._binaryWithEtag(path, etag, opts);
  }

  async getProjectionProfile(
    quantityId: string,
    query: FieldProjectionProfileQuery,
    opts?: RequestOptions,
  ): Promise<FieldProjectionProfile> {
    const params = buildProjectionProfileParams(query);
    return this.client.get<FieldProjectionProfile>(
      `${sessionApiPaths.data.fieldProjectionProfile(quantityId)}?${params}`,
      opts,
    );
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

function buildSliceMatrixParams(q: FieldSliceMatrixQuery | FieldRenderPngQuery): URLSearchParams {
  const p = new URLSearchParams({ plane: q.plane });
  if (q.component && q.component !== "full") p.set("component", q.component);
  if (q.cut_world !== undefined) p.set("cut_world", String(q.cut_world));
  if (q.cut_norm !== undefined) p.set("cut_norm", String(q.cut_norm));
  if (q.x_size !== undefined) p.set("x_size", String(q.x_size));
  if (q.y_size !== undefined) p.set("y_size", String(q.y_size));
  if (q.max_points !== undefined) p.set("max_points", String(q.max_points));
  if (q.include_arrows) p.set("include_arrows", "true");
  if (q.arrow_every !== undefined) p.set("arrow_every", String(q.arrow_every));
  if (q.max_arrows !== undefined) p.set("max_arrows", String(q.max_arrows));
  if (q.mode !== undefined) p.set("mode", q.mode);
  if (q.color_mode !== undefined) p.set("color_mode", q.color_mode);
  if (q.thickness_world !== undefined) p.set("thickness_world", String(q.thickness_world));
  if (q.aggregation !== undefined) p.set("aggregation", q.aggregation);
  if (q.samples !== undefined) p.set("samples", String(q.samples));
  if (q.format !== undefined) p.set("format", q.format);
  return p;
}

function buildProjectionParams(q: FieldProjectionQuery): URLSearchParams {
  const p = new URLSearchParams({ plane: q.plane });
  if (q.component && q.component !== "full") p.set("component", q.component);
  if (q.reduction !== undefined) p.set("reduction", q.reduction);
  if (q.include_air_as_zero !== undefined) {
    p.set("include_air_as_zero", String(q.include_air_as_zero));
  }
  if (q.samples !== undefined) p.set("samples", String(q.samples));
  if (q.adaptive !== undefined) p.set("adaptive", String(q.adaptive));
  if (q.error_tolerance !== undefined) p.set("error_tolerance", String(q.error_tolerance));
  if (q.min_samples !== undefined) p.set("min_samples", String(q.min_samples));
  if (q.x_size !== undefined) p.set("x_size", String(q.x_size));
  if (q.y_size !== undefined) p.set("y_size", String(q.y_size));
  if (q.max_points !== undefined) p.set("max_points", String(q.max_points));
  if (q.tile_x !== undefined) p.set("tile_x", String(q.tile_x));
  if (q.tile_y !== undefined) p.set("tile_y", String(q.tile_y));
  if (q.tile_size !== undefined) p.set("tile_size", String(q.tile_size));
  return p;
}

function buildProjectionMatrixParams(q: FieldProjectionMatrixQuery): URLSearchParams {
  const p = buildProjectionParams(q);
  if (q.mode !== undefined) p.set("mode", q.mode);
  if (q.color_mode !== undefined) p.set("color_mode", q.color_mode);
  if (q.aggregation !== undefined) p.set("aggregation", q.aggregation);
  if (q.format !== undefined) p.set("format", q.format);
  return p;
}

function buildRenderPngParams(q: FieldRenderPngQuery): URLSearchParams {
  const p = buildSliceMatrixParams(q);
  if (q.reduction !== undefined) p.set("reduction", q.reduction);
  if (q.include_air_as_zero !== undefined) {
    p.set("include_air_as_zero", String(q.include_air_as_zero));
  }
  if (q.adaptive !== undefined) p.set("adaptive", String(q.adaptive));
  if (q.error_tolerance !== undefined) p.set("error_tolerance", String(q.error_tolerance));
  if (q.min_samples !== undefined) p.set("min_samples", String(q.min_samples));
  if (q.colormap !== undefined) p.set("colormap", q.colormap);
  if (q.vmin !== undefined) p.set("vmin", String(q.vmin));
  if (q.vmax !== undefined) p.set("vmax", String(q.vmax));
  if (q.auto_scale !== undefined) p.set("auto_scale", q.auto_scale);
  if (q.alpha_mask !== undefined) p.set("alpha_mask", String(q.alpha_mask));
  if (q.show_mesh !== undefined) p.set("show_mesh", String(q.show_mesh));
  if (q.show_arrows !== undefined) p.set("show_arrows", String(q.show_arrows));
  return p;
}

function buildProjectionProfileParams(q: FieldProjectionProfileQuery): URLSearchParams {
  const p = new URLSearchParams({
    plane: q.plane,
    pixel_x: String(q.pixel_x),
    pixel_y: String(q.pixel_y),
  });
  if (q.component && q.component !== "full") p.set("component", q.component);
  if (q.x_size !== undefined) p.set("x_size", String(q.x_size));
  if (q.y_size !== undefined) p.set("y_size", String(q.y_size));
  if (q.max_samples !== undefined) p.set("max_samples", String(q.max_samples));
  return p;
}
