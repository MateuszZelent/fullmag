import { describe, expect, it, vi } from "vitest";

import { ControlRoomApi } from "./ControlRoomApi";

describe("ControlRoomApi", () => {
  it("loads current session status through the v2 resource path", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          api_contract_version: "v2",
          resources: { session: 7 },
          runtime_bundle_version: "dev",
          session: { state: "idle" },
        }),
        { status: 200 },
      );
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-1",
    });

    const status = await api.sessions.current.status();

    expect(status.resources.session).toBe(7);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/v2/sessions/current/status",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-request-id": "req-1",
          "x-fullmag-contract-version": "resource-first-v2",
        }),
        method: "GET",
      }),
    );
  });

  it("reports non-ok status responses as API errors", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () => new Response("No active workspace", { status: 404 }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 404,
      message: "No active workspace",
    });
  });
});
