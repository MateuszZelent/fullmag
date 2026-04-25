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
});
