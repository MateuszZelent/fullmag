import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import type { components } from "../api/generated/openapi-v2-types";

type SessionListResource = components["schemas"]["SessionListResource"];

describe("session collection facade", () => {
  it("returns the generated GET /v2/sessions response type", async () => {
    const api = new ControlRoomApi({
      baseUrl: "http://localhost",
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ schema_version: "2.0.0", sessions: [] }), {
          headers: {
            "content-type": "application/json",
            "x-api-contract-version": "1.0.0",
          },
        })),
    });

    const resource: SessionListResource = await api.sessions.list();

    expect(resource.sessions).toEqual([]);
  });

  it("does not maintain a handwritten session collection wire type", () => {
    const apiTypes = readFileSync(
      new URL("../api/apiTypes.ts", import.meta.url),
      "utf8",
    );

    expect(apiTypes).not.toContain("interface SessionCollectionResource");
  });
});
