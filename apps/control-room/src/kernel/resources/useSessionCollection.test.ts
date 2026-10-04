import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";
import type { components } from "../api/generated/openapi-v2-types";
import {
  resolveSessionCollectionResourceState,
  resolveSessionCollectionState,
} from "./useSessionCollection";

type SessionListResource = components["schemas"]["SessionListResource"];

describe("session collection facade", () => {
  it("keeps the confirmed collection during a refresh error", () => {
    const collection = {
      schema_version: "2.0.0",
      sessions: [{
        current: true,
        name: "session-1",
        session_id: "session-1",
        status: "active",
      }],
    } as SessionListResource;

    expect(resolveSessionCollectionState(collection)).toBe("ready");
    expect(
      resolveSessionCollectionResourceState({
        data: collection,
        status: "error",
      }),
    ).toBe("ready");
  });

  it("does not turn an initial collection error into an empty workspace", () => {
    expect(
      resolveSessionCollectionResourceState({ data: null, status: "error" }),
    ).toBe("error");
  });

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
