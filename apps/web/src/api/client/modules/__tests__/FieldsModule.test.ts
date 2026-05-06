import { describe, expect, it, vi } from "vitest";

import { FieldsModule } from "../FieldsModule";
import type { LiveSessionClient } from "../../LiveSessionClient";

function createClient() {
  const get = vi.fn();
  const getBinaryResponse = vi.fn();
  const client = {
    get,
    getBinaryResponse,
  } as unknown as LiveSessionClient;
  return { client, get, getBinaryResponse };
}

describe("FieldsModule", () => {
  it("adds component query for vector fetch when non-full component is requested", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 200,
      buffer: new ArrayBuffer(16),
      headers: new Headers({ ETag: "\"v1\"" }),
    });

    const module = new FieldsModule(client);
    const response = await module.getVectorResponse("m", { component: "x", etag: "\"old\"" });

    expect(response.status).toBe(200);
    expect(response.buffer).toBeInstanceOf(ArrayBuffer);
    expect(response.etag).toBe("\"v1\"");
    expect(getBinaryResponse).toHaveBeenCalledTimes(1);
    const [path, opts] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/fields/m/samples/vector?");
    expect(path).toContain("format=bin");
    expect(path).toContain("component=x");
    expect(opts.headers["If-None-Match"]).toBe("\"old\"");
  });

  it("does not add component query when requesting full vector payload", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 200,
      buffer: new ArrayBuffer(8),
      headers: new Headers(),
    });

    const module = new FieldsModule(client);
    await module.getVectorResponse("m", { component: "full" });

    const [path] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("format=bin");
    expect(path).not.toContain("component=");
  });

  it("adds scope query when requesting a scoped vector sample", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 200,
      buffer: new ArrayBuffer(8),
      headers: new Headers({ ETag: "\"scoped\"" }),
    });

    const module = new FieldsModule(client);
    await module.getVectorResponse("m", {
      component: "full",
      scope_kind: "airbox",
      scope_id: "airbox",
    });

    const [path] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("format=bin");
    expect(path).toContain("scope_kind=airbox");
    expect(path).toContain("scope_id=airbox");
    expect(path).not.toContain("component=");
  });

  it("returns null buffer on 304 for slice scalar and preserves ETag", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 304,
      buffer: new ArrayBuffer(0),
      headers: new Headers({ ETag: "\"slice-1\"" }),
    });

    const module = new FieldsModule(client);
    const response = await module.getSliceScalarResponse("m", {
      plane: "xy",
      component: "magnitude",
      cut_norm: 0.5,
      x_size: 64,
      y_size: 64,
    }, "\"slice-0\"");

    expect(response.status).toBe(304);
    expect(response.buffer).toBeNull();
    expect(response.etag).toBe("\"slice-1\"");
    const [, opts] = getBinaryResponse.mock.calls[0];
    expect(opts.headers["If-None-Match"]).toBe("\"slice-0\"");
  });

  it("forces include_arrows=true for arrows endpoint", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 200,
      buffer: new ArrayBuffer(24),
      headers: new Headers({ ETag: "\"arr-1\"" }),
    });

    const module = new FieldsModule(client);
    await module.getSliceArrowsResponse("m", {
      plane: "xz",
      component: "x",
      cut_norm: 0.25,
      x_size: 128,
      y_size: 96,
      include_arrows: false,
      arrow_every: 4,
      max_arrows: 2000,
    });

    const [path] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/fields/m/samples/slice/arrows?");
    expect(path).toContain("include_arrows=true");
    expect(path).toContain("arrow_every=4");
    expect(path).toContain("max_arrows=2000");
  });

  it("uses v2 projection meta path with explicit reduction params", async () => {
    const { client, get } = createClient();
    get.mockResolvedValue({
      quantity_id: "m",
      plane: "xy",
      component: "x",
      reduction: "sum",
      include_air_as_zero: false,
      samples: 4,
      field_revision: 1,
      domain_generation_id: 1,
      sampling_method: "fdm_layer_projection_nearest",
      etag: "\"proj\"",
      projection_revision: "proj",
      x_pixels: 32,
      y_pixels: 32,
      grid: { x_size: 32, y_size: 32, point_count: 1024 },
      bounds: null,
      occupied_count: 1024,
      occupied_measure: 4096,
      empty_count: 0,
      error_estimate: 0,
      error_method: "coarse_fine_sample_delta_max_abs",
      scalar: { available: true, n_comp: 1, point_count: 1024, min: 0, max: 1, etag: "\"proj\"", href: null },
      empty_mask: { available: true, point_count: 1024, etag: "\"mask\"", href: null },
    });

    const module = new FieldsModule(client);
    await module.getProjectionMeta("m", {
      plane: "xy",
      component: "x",
      reduction: "sum",
      samples: 4,
      x_size: 32,
      y_size: 32,
    });

    const [path] = get.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/fields/m/projection/meta?");
    expect(path).toContain("component=x");
    expect(path).toContain("reduction=sum");
    expect(path).toContain("samples=4");
  });

  it("returns null buffer on 304 for projection scalar and preserves ETag", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 304,
      buffer: new ArrayBuffer(0),
      headers: new Headers({ ETag: "\"proj-1\"" }),
    });

    const module = new FieldsModule(client);
    const response = await module.getProjectionScalarResponse("m", {
      plane: "xz",
      component: "magnitude",
      reduction: "mean_occupied",
      include_air_as_zero: true,
      samples: 8,
      adaptive: true,
      error_tolerance: 0.001,
      min_samples: 2,
      x_size: 64,
      y_size: 32,
    }, "\"proj-0\"");

    expect(response.status).toBe(304);
    expect(response.buffer).toBeNull();
    expect(response.etag).toBe("\"proj-1\"");
    const [path, opts] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/fields/m/projection/scalar?");
    expect(path).toContain("include_air_as_zero=true");
    expect(path).toContain("adaptive=true");
    expect(path).toContain("error_tolerance=0.001");
    expect(path).toContain("min_samples=2");
    expect(opts.headers["If-None-Match"]).toBe("\"proj-0\"");
  });

  it("returns null buffer on 304 for projection empty mask and preserves ETag", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 304,
      buffer: new ArrayBuffer(0),
      headers: new Headers({ ETag: "\"mask-1\"" }),
    });

    const module = new FieldsModule(client);
    const response = await module.getProjectionEmptyMaskResponse("m", {
      plane: "xy",
      component: "x",
      reduction: "sum",
      samples: 2,
      x_size: 16,
      y_size: 16,
    }, "\"mask-0\"");

    expect(response.status).toBe(304);
    expect(response.buffer).toBeNull();
    expect(response.etag).toBe("\"mask-1\"");
    const [path, opts] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/fields/m/projection/empty-mask?");
    expect(path).toContain("reduction=sum");
    expect(opts.headers["If-None-Match"]).toBe("\"mask-0\"");
  });

  it("passes projection tile query parameters through the typed facade", async () => {
    const { client, getBinaryResponse } = createClient();
    getBinaryResponse.mockResolvedValue({
      status: 200,
      buffer: new ArrayBuffer(16),
      headers: new Headers({ ETag: "\"tile\"" }),
    });

    const module = new FieldsModule(client);
    await module.getProjectionScalarResponse("m", {
      plane: "xy",
      component: "x",
      reduction: "max",
      x_size: 256,
      y_size: 256,
      tile_x: 1,
      tile_y: 2,
      tile_size: 64,
    });

    const [path] = getBinaryResponse.mock.calls[0];
    expect(path).toContain("tile_x=1");
    expect(path).toContain("tile_y=2");
    expect(path).toContain("tile_size=64");
  });

  it("uses v2 projection profile path with pixel query parameters", async () => {
    const { client, get } = createClient();
    get.mockResolvedValue({
      quantity_id: "m",
      plane: "xy",
      component: "x",
      field_revision: 1,
      domain_generation_id: 42,
      sampling_method: "fem_tetra_depth_profile",
      pixel_x: 3,
      pixel_y: 4,
      x_pixels: 64,
      y_pixels: 64,
      u: 0.1,
      v: 0.2,
      bounds: null,
      sample_count: 1,
      truncated: false,
      samples: [{ element_index: 0, marker: 7, normal_coord: 0.5, value: 2, measure: 1e-27 }],
    });

    const module = new FieldsModule(client);
    await module.getProjectionProfile("m", {
      plane: "xy",
      component: "x",
      x_size: 64,
      y_size: 64,
      pixel_x: 3,
      pixel_y: 4,
      max_samples: 16,
    });

    const [path] = get.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/fields/m/projection/profile?");
    expect(path).toContain("component=x");
    expect(path).toContain("pixel_x=3");
    expect(path).toContain("pixel_y=4");
    expect(path).toContain("max_samples=16");
  });
});
