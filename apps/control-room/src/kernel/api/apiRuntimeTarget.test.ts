import { describe, expect, it } from "vitest";

import {
  resolveControlRoomApiBase,
  resolveControlRoomWebSocketUrl,
} from "./apiRuntimeTarget";

describe("control-room API runtime target", () => {
  it("uses an explicit control-room API base before browser origin", () => {
    expect(
      resolveControlRoomApiBase({
        env: {
          NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: "http://localhost:8081/",
        },
        windowLocation: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          protocol: "http:",
        },
      }),
    ).toBe("http://localhost:8081");
  });

  it("keeps compatibility with existing runtime HTTP env names", () => {
    expect(
      resolveControlRoomApiBase({
        env: {
          NEXT_PUBLIC_RUNTIME_HTTP_BASE: "http://127.0.0.1:8081///",
        },
      }),
    ).toBe("http://127.0.0.1:8081");
  });

  it("supports browser runtime config before falling back to origin", () => {
    expect(
      resolveControlRoomApiBase({
        windowConfig: { runtimeHttpBase: "https://api.fullmag.test/" },
        windowLocation: {
          host: "app.fullmag.test",
          origin: "https://app.fullmag.test",
          protocol: "https:",
        },
      }),
    ).toBe("https://api.fullmag.test");
  });

  it("defaults local development to the local control-room API port", () => {
    expect(
      resolveControlRoomApiBase({
        env: { NODE_ENV: "development" },
        windowLocation: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          protocol: "http:",
        },
      }),
    ).toBe("http://localhost:8081");
  });

  it("builds realtime websocket URLs from API base URL", () => {
    expect(
      resolveControlRoomWebSocketUrl(
        "http://localhost:8081",
        "/v2/sessions/current/events/ws",
        "http://localhost:3000",
      ),
    ).toBe("ws://localhost:8081/v2/sessions/current/events/ws");
  });
});
