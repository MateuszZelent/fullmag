import { describe, expect, it } from "vitest";

import { ControlRoomApi } from "../api/ControlRoomApi";

describe("session collection facade", () => {
  it("exposes the typed GET /v2/sessions entry point needed to distinguish an empty collection", () => {
    const api = new ControlRoomApi({ baseUrl: "http://localhost" });
    expect(typeof (api.sessions as { list?: unknown }).list).toBe("function");
  });
});
