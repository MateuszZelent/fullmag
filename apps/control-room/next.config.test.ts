import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import nextConfig, {
  resolveControlRoomDistDir,
  validateManagedControlRoomStorage,
} from "./next.config";

describe("control-room Next dev proxy config", () => {
  it("uses the managed export child so Next cleans storage instead of a repo directory", () => {
    expect(
      resolveControlRoomDistDir({
        auditBuild: false,
        managedStorage: true,
        staticExport: true,
      }),
    ).toBe(".fullmag-frontend/out");
  });

  it("keeps the legacy static export directory when managed storage is absent", () => {
    expect(
      resolveControlRoomDistDir({
        auditBuild: false,
        staticExport: true,
      }),
    ).toBe(".next");
  });

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
    expect(configSource).toContain("FULLMAG_FRONTEND_ROOT");
    expect(configSource).toContain(".fullmag-frontend/out");
  });

  it("rejects an unprepared managed storage link before Next can write", () => {
    expect(() =>
      validateManagedControlRoomStorage({
        appRoot: process.cwd(),
        distDir: ".next",
        frontendRoot: resolve(
          process.cwd(),
          "..",
          "..",
          "..",
          "missing-managed-storage",
        ),
        staticExport: false,
      }),
    ).toThrow(/Managed Control Room storage is not prepared/);
  });

  it("validates the managed links used by a static export", () => {
    const root = mkdtempSync(join(tmpdir(), "fullmag-next-config-"));
    const appRoot = join(root, "repo", "apps", "control-room");
    const frontendRoot = join(root, "storage", "frontend");
    const linkType = process.platform === "win32" ? "junction" : "dir";

    try {
      mkdirSync(appRoot, { recursive: true });
      mkdirSync(join(frontendRoot, "out"), { recursive: true });
      mkdirSync(join(frontendRoot, "next", "default"), { recursive: true });
      symlinkSync(frontendRoot, join(appRoot, ".fullmag-frontend"), linkType);
      symlinkSync(join(frontendRoot, "out"), join(appRoot, "out"), linkType);
      symlinkSync(
        join(frontendRoot, "next", "default"),
        join(appRoot, ".next"),
        linkType,
      );

      expect(() =>
        validateManagedControlRoomStorage({
          appRoot,
          distDir: ".fullmag-frontend/out",
          frontendRoot,
          staticExport: true,
        }),
      ).not.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps generated Next route types stable across dev and audit builds", () => {
    const nextEnvSource = readFileSync(
      new URL("./next-env.d.ts", import.meta.url),
      "utf8",
    );
    const packageSource = readFileSync(
      new URL("./package.json", import.meta.url),
      "utf8",
    );
    const auditBuildSource = readFileSync(
      new URL("./scripts/build-audit-control-room.mjs", import.meta.url),
      "utf8",
    );

    expect(nextEnvSource).toContain('./.next/types/routes.d.ts');
    expect(packageSource).toContain(
      '"build:audit:webpack": "node scripts/build-audit-control-room.mjs"',
    );
    expect(auditBuildSource).toContain("const nextEnvSnapshot = readFileSync");
    expect(auditBuildSource).toContain(
      "writeFileSync(nextEnvPath, nextEnvSnapshot)",
    );
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
