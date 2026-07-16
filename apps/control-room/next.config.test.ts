import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

describe("control-room Next dev proxy config", () => {
  it("isolates production browser-audit artifacts from the shared dev build", () => {
    const configSource = readFileSync(
      new URL("./next.config.ts", import.meta.url),
      "utf8",
    );

    expect(configSource).toContain('distDir: auditBuild ? ".next-audit" : ".next"');
  });

  it("allows the public Traefik origin used by the HMR websocket", () => {
    expect(nextConfig.allowedDevOrigins).toContain(
      "fullmag.amucontainers.orion.zfns.eu.org",
    );
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
