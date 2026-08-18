import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import nextConfig, { resolveControlRoomDistDir } from "./next.config";

describe("control-room Next dev proxy config", () => {
  it("assigns a distinct dev distDir to each runtime port", () => {
    expect(
      resolveControlRoomDistDir({
        auditBuild: false,
        requestedDistDir: ".next-control-room-3100",
      }),
    ).toBe(".next-control-room-3100");
    expect(
      resolveControlRoomDistDir({
        auditBuild: false,
        requestedDistDir: ".next-control-room-42695",
      }),
    ).toBe(".next-control-room-42695");
  });

  it("rejects an arbitrary distDir override", () => {
    expect(
      resolveControlRoomDistDir({
        auditBuild: false,
        requestedDistDir: "/tmp/shared-next-cache",
      }),
    ).toBe(".next");
  });

  it("isolates production browser-audit artifacts from the shared dev build", () => {
    const configSource = readFileSync(
      new URL("./next.config.ts", import.meta.url),
      "utf8",
    );

    expect(configSource).toContain("FULLMAG_NEXT_DIST_DIR");
    expect(configSource).toContain("isIsolatedSmokeDistDir");
    expect(configSource).toContain("resolveControlRoomDistDir");
  });

  it("allows the public Traefik origin used by the HMR websocket", () => {
    expect(nextConfig.allowedDevOrigins).toContain(
      "fullmag.amucontainers.orion.zfns.eu.org",
    );
  });

  it("allows the IPv4 loopback origin used by local browser smoke", () => {
    expect(nextConfig.allowedDevOrigins).toContain("127.0.0.1");
  });

  it("derives an allowed dev origin from the WSL public host", () => {
    const configSource = readFileSync(
      new URL("./next.config.ts", import.meta.url),
      "utf8",
    );

    expect(configSource).toContain("FULLMAG_WEB_PUBLIC_HOST");
    expect(configSource).toContain("configuredPublicDevHost");
  });

  it("proxies v2 API requests through the configured backend target", async () => {
    const previousTarget = process.env.FULLMAG_API_PROXY_TARGET;
    process.env.FULLMAG_API_PROXY_TARGET = "http://localhost:8081/";

    try {
      await expect(nextConfig.rewrites?.()).resolves.toContainEqual({
        source: "/v2/:path*",
        destination: "http://localhost:8081/v2/:path*",
      });
    } finally {
      if (previousTarget === undefined) {
        delete process.env.FULLMAG_API_PROXY_TARGET;
      } else {
        process.env.FULLMAG_API_PROXY_TARGET = previousTarget;
      }
    }
  });
});
