import { describe, expect, it, vi } from "vitest";

import { DomainModule } from "../DomainModule";
import type { LiveSessionClient } from "../../LiveSessionClient";

function createClient() {
  const get = vi.fn();
  const getBinaryResponse = vi.fn();
  const getJsonResponse = vi.fn();
  const client = {
    get,
    getBinaryResponse,
    getJsonResponse,
  } as unknown as LiveSessionClient;
  return { client, get, getBinaryResponse, getJsonResponse };
}

describe("DomainModule", () => {
  it("uses the v2 domain slice mesh overlay path and forwards If-None-Match", async () => {
    const { client, getJsonResponse } = createClient();
    getJsonResponse.mockResolvedValue({
      data: null,
      status: 304,
      headers: new Headers({ ETag: "\"mesh-1\"" }),
    });

    const module = new DomainModule(client);
    const response = await module.getSliceMeshOverlayResponse(
      {
        plane: "xy",
        cut_world: 12.5,
      },
      "\"mesh-0\"",
    );

    expect(response.status).toBe(304);
    expect(response.data).toBeNull();
    expect(getJsonResponse).toHaveBeenCalledTimes(1);
    const [path, opts] = getJsonResponse.mock.calls[0];
    expect(path).toContain("/v2/sessions/current/data/domain/slice/mesh-overlay?");
    expect(path).toContain("plane=xy");
    expect(path).toContain("cut_world=12.5");
    expect(opts.headers["If-None-Match"]).toBe("\"mesh-0\"");
  });
});
