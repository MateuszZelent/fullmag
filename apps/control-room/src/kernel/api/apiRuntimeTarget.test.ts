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

  it("accepts API base values that include the v2 path prefix", () => {
    expect(
      resolveControlRoomApiBase({
        env: {
          NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: "http://localhost:8081/v2/",
        },
      }),
    ).toBe("http://localhost:8081");
  });

  it("keeps compatibility with the Fullmag launcher API env name", () => {
    expect(
      resolveControlRoomApiBase({
        env: {
          NEXT_PUBLIC_FULLMAG_API_URL: "http://localhost:8081/",
        },
      }),
    ).toBe("http://localhost:8081");
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

  it("lets browser runtime config override build-time API env", () => {
    expect(
      resolveControlRoomApiBase({
        env: {
          NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: "http://localhost:8081",
        },
        windowConfig: { controlRoomApiBase: "http://localhost:8091" },
      }),
    ).toBe("http://localhost:8091");
  });

  it("uses the public dev proxy origin instead of a loopback API env", () => {
    expect(
      resolveControlRoomApiBase({
        env: {
          NODE_ENV: "development",
          NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: "http://localhost:8081",
        },
        windowLocation: {
          host: "fullmag.amucontainers.orion.zfns.eu.org",
          origin: "https://fullmag.amucontainers.orion.zfns.eu.org",
          protocol: "https:",
        },
      }),
    ).toBe("https://fullmag.amucontainers.orion.zfns.eu.org");
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

  it("uses the local API port for standalone localhost frontend origins", () => {
    expect(
      resolveControlRoomApiBase({
        env: { NODE_ENV: "production" },
        windowLocation: {
          host: "localhost:3100",
          origin: "http://localhost:3100",
          protocol: "http:",
        },
      }),
    ).toBe("http://localhost:8081");
  });

  it("keeps localhost API origins as the API base", () => {
    expect(
      resolveControlRoomApiBase({
        env: { NODE_ENV: "production" },
        windowLocation: {
          host: "localhost:8081",
          origin: "http://localhost:8081",
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

  it("builds realtime websocket URLs from the public dev proxy origin", () => {
    expect(
      resolveControlRoomWebSocketUrl(
        "https://fullmag.amucontainers.orion.zfns.eu.org",
        "/v2/sessions/current/events/ws",
      ),
    ).toBe(
      "wss://fullmag.amucontainers.orion.zfns.eu.org/v2/sessions/current/events/ws",
    );
  });
});
