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
  CONTROL_ROOM_SYNC_COMMAND_PROXY_TIMEOUT_MS,
  DOCKER_DEV_WATCH_POLLING_DEFAULT_MS,
  isDockerDevGeneratedWatchPath,
  resolveControlRoomDistDir,
  resolveDockerDevWatchOptions,
  resolveDockerDevWatchPollingMs,
  validateManagedControlRoomStorage,
} from "./next.config";

describe("control-room Next dev proxy config", () => {
  it("keeps proxy waiting compatible with the synchronous command phase owners", () => {
    const script = readFileSync(new URL("../../crates/fullmag-api/src/script.rs", import.meta.url), "utf8");
    const preparation = readFileSync(new URL("../../crates/fullmag-api/src/live_scene_preparation.rs", import.meta.url), "utf8");
    const duration = (source: string, name: string, unit: string) => {
      const match = new RegExp("const " + name + "[^;]*from_" + unit + "\\((\\d+)\\)").exec(source);
      expect(match, name).not.toBeNull();
      return Number(match![1]);
    };
    const phaseBudget =
      (duration(script, "BOUNDED_PYTHON_HELPER_TIMEOUT", "secs") +
       duration(script, "BOUNDED_SOURCE_CAPTURE_TIMEOUT", "secs") +
       duration(preparation, "ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT", "secs")) * 1000 +
      duration(preparation, "ACCEPTED_LIVE_PREPARATION_POLL_INTERVAL", "millis");
    expect(CONTROL_ROOM_SYNC_COMMAND_PROXY_TIMEOUT_MS).toBe(phaseBudget);
    expect(nextConfig.experimental?.proxyTimeout).toBe(phaseBudget);
    expect(Number.isFinite(phaseBudget)).toBe(true);
    expect(phaseBudget).toBeGreaterThan(30_000);
    expect(phaseBudget).toBeLessThan(2 ** 31 - 1);
  });

  it("keeps API commands on the existing same-origin rewrite", async () => {
    expect(await nextConfig.rewrites?.()).toContainEqual({
      source: "/v2/:path*",
      destination: expect.stringMatching(/\/v2\/:path\*$/),
    });
  });

  it("redirects the bootstrap root before lazily compiling the workspace", async () => {
    await expect(nextConfig.redirects?.()).resolves.toContainEqual({
      source: "/",
      destination: "/workspace",
      permanent: false,
    });
  });

  it("keeps live Docker source trees watchable while ignoring generated trees", () => {
    expect(DOCKER_DEV_WATCH_POLLING_DEFAULT_MS).toBe(5000);
    expect(isDockerDevGeneratedWatchPath("/state/.fullmag-frontend/out")).toBe(
      true,
    );
    expect(isDockerDevGeneratedWatchPath("/state/.next-control-room-8080/dev")).toBe(
      true,
    );
    expect(isDockerDevGeneratedWatchPath("/state/node_modules/next")).toBe(true);
    for (const livePath of [
      "/state/development/workspace/apps/control-room/app/page.tsx",
      "/state/development/workspace/apps/control-room/src/kernel.ts",
      "/state/development/workspace/apps/control-room/public/logo.svg",
      "/state/development/workspace/apps/control-room/scripts/dev.ts",
    ]) {
      expect(isDockerDevGeneratedWatchPath(livePath)).toBe(false);
    }

    const inheritedIgnored = /(?:^|[\\/])\.git(?:[\\/]|$)/;
    const options = resolveDockerDevWatchOptions(inheritedIgnored, "5000");
    expect(options.poll).toBe(5000);
    const ignored = Array.isArray(options.ignored)
      ? options.ignored
      : [options.ignored];
    const matchesIgnored = (pathValue: string) =>
      ignored.some((entry) =>
        entry instanceof RegExp ? entry.test(pathValue) : false,
      );
    expect(matchesIgnored("/state/repo/.git/HEAD")).toBe(true);
    expect(matchesIgnored("/state/repo/.next-control-room-8080/dev")).toBe(
      true,
    );
    expect(matchesIgnored("/state/repo/apps/control-room/app/page.tsx")).toBe(
      false,
    );

    const stringOptions = resolveDockerDevWatchOptions("**/.git/**", "5000");
    expect(Array.isArray(stringOptions.ignored)).toBe(true);
    expect(stringOptions.ignored).toContain("**/.git/**");
    expect(stringOptions.ignored).toContain("**/.next*/**");

    const arrayOptions = resolveDockerDevWatchOptions(
      ["**/.git/**", "**/.cache/**"],
      "5000",
    );
    expect(arrayOptions.ignored).toEqual([
      "**/.git/**",
      "**/.cache/**",
      "**/node_modules/**",
      "**/.fullmag-frontend/**",
      "**/.next*/**",
    ]);
    expect(() => resolveDockerDevWatchOptions([/\.git/], "5000")).toThrow(
      /arrays must contain only strings/,
    );
  });

  it("validates and preserves an explicit Docker polling override", () => {
    expect(resolveDockerDevWatchPollingMs("2000")).toBe(2000);
    expect(resolveDockerDevWatchOptions(undefined, "7500").poll).toBe(7500);
    expect(() => resolveDockerDevWatchPollingMs("249")).toThrow(
      /between 250 and 10000 ms/,
    );
    expect(() => resolveDockerDevWatchPollingMs("10001")).toThrow(
      /between 250 and 10000 ms/,
    );
  });

  it("applies the watcher policy only to the Docker development webpack config", () => {
    const webpack = nextConfig.webpack;
    expect(webpack).toBeTypeOf("function");
    const originalMode = process.env.FULLMAG_DOCKER_FRONTEND;
    const originalPolling = process.env.WATCHPACK_POLLING;
    const originalWatchMode = process.env.FULLMAG_WATCHPACK_MODE;
    try {
      process.env.FULLMAG_DOCKER_FRONTEND = "dev";
      delete process.env.WATCHPACK_POLLING;
      delete process.env.FULLMAG_WATCHPACK_MODE;
      const dockerDevConfig = webpack?.(
        { watchOptions: { ignored: /\.git/ } } as never,
        { dev: true } as never,
      );
      expect(dockerDevConfig?.watchOptions?.poll).toBe(5000);
      expect(dockerDevConfig?.watchOptions?.ignored).not.toBeTypeOf("function");

      process.env.FULLMAG_DOCKER_FRONTEND = "static";
      const releaseConfig = webpack?.(
        { watchOptions: { ignored: /\.git/ } } as never,
        { dev: true } as never,
      );
      expect(releaseConfig?.watchOptions?.poll).toBeUndefined();
      expect(releaseConfig?.watchOptions?.ignored).toEqual(/\.git/);
    } finally {
      if (originalMode === undefined) {
        delete process.env.FULLMAG_DOCKER_FRONTEND;
      } else {
        process.env.FULLMAG_DOCKER_FRONTEND = originalMode;
      }
      if (originalPolling === undefined) {
        delete process.env.WATCHPACK_POLLING;
      } else {
        process.env.WATCHPACK_POLLING = originalPolling;
      }
      if (originalWatchMode === undefined) {
        delete process.env.FULLMAG_WATCHPACK_MODE;
      } else {
        process.env.FULLMAG_WATCHPACK_MODE = originalWatchMode;
      }
    }
  });

  it("watches natively without polling when the launcher selects native mode", () => {
    const native = resolveDockerDevWatchOptions(/\.git/, "5000", "native");
    expect(native.poll).toBeUndefined();
    expect(native.ignored).toBeInstanceOf(RegExp);
    expect(resolveDockerDevWatchOptions(undefined, "5000", "polling").poll).toBe(5000);
    expect(() => resolveDockerDevWatchOptions(undefined, "5000", "inotify")).toThrow(
      /FULLMAG_WATCHPACK_MODE/,
    );
  });

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

    // Next writes dev/ for development and types/ for typegen. Docker DEV
    // uses the fixed managed distDir; audit wrappers preserve either entry.
    expect(nextEnvSource).toMatch(
      /import ["']\.\/(?:\.next\/(?:dev\/)?|\.next-control-room-8080\/dev\/)types\/routes\.d\.ts["'];/,
    );
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
