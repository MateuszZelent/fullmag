import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePnpmInvocation } from "./resolve-pnpm-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

describe("resolvePnpmInvocation", () => {
  it("uses Corepack next to the current Linux Node even when PATH points at Windows pnpm", () => {
    const execPath = "/home/user/.nvm/versions/node/v24.11.1/bin/node";
    const corepackPath = join(dirname(execPath), "corepack");

    expect(
      resolvePnpmInvocation({
        platform: "linux",
        execPath,
        env: {
          PATH: "/mnt/c/Users/User/AppData/Roaming/npm:/usr/bin",
          PNPM_HOME: "/mnt/c/Users/User/AppData/Roaming/npm",
        },
        pathExists: (candidate) => candidate === corepackPath,
      }),
    ).toEqual({
      command: execPath,
      argsPrefix: [corepackPath, "pnpm"],
      source: "corepack",
    });
  });

  it("uses an explicit POSIX PNPM_HOME when Corepack is unavailable", () => {
    const pnpmHome = "/home/user/.local/share/pnpm";
    const pnpmPath = join(pnpmHome, "pnpm");

    expect(
      resolvePnpmInvocation({
        platform: "linux",
        execPath: "/usr/bin/node",
        env: { PNPM_HOME: pnpmHome },
        pathExists: (candidate) => candidate === pnpmPath,
      }),
    ).toEqual({
      command: pnpmPath,
      argsPrefix: [],
      source: "pnpm-home",
    });
  });

  it("never launches a Windows PNPM_HOME from POSIX", () => {
    expect(() =>
      resolvePnpmInvocation({
        platform: "linux",
        execPath: "/usr/bin/node",
        env: { PNPM_HOME: "/mnt/c/Users/User/AppData/Roaming/npm" },
        pathExists: () => false,
      }),
    ).toThrow(/Linux pnpm installation/);
  });

  it("keeps native Windows pnpm resolution", () => {
    expect(
      resolvePnpmInvocation({
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        env: {},
        pathExists: () => false,
      }),
    ).toEqual({
      command: "pnpm.cmd",
      argsPrefix: [],
      source: "windows-path",
    });
  });

  it("fails clearly instead of falling back to a PATH-resolved Windows shim", () => {
    expect(() =>
      resolvePnpmInvocation({
        platform: "linux",
        execPath: "/usr/bin/node",
        env: { PATH: "/mnt/c/Users/User/AppData/Roaming/npm" },
        pathExists: () => false,
      }),
    ).toThrow(/Corepack or set PNPM_HOME/);
  });
});

describe("dev-server launcher contract", () => {
  it("keeps pnpm resolution in the control-room launcher and delegates the web shim through Node", () => {
    const controlRoomLauncher = readFileSync(
      resolve(scriptDir, "../dev-server.mjs"),
      "utf8",
    );
    const webShim = readFileSync(
      resolve(scriptDir, "../../web/dev-server.mjs"),
      "utf8",
    );

    expect(controlRoomLauncher).toContain("resolvePnpmInvocation");
    expect(controlRoomLauncher).not.toContain(
      'process.platform === "win32" ? "pnpm.cmd" : "pnpm"',
    );
    expect(webShim).toContain("process.execPath");
    expect(webShim).toContain("apps/control-room/dev-server.mjs");
    expect(webShim).not.toMatch(/\bpnpm(?:\.cmd)?\b/);
  });
});
