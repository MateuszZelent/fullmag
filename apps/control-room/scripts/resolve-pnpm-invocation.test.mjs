import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ensureControlRoomDependencies,
  resolvePnpmInvocation,
} from "./resolve-pnpm-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

describe("resolvePnpmInvocation", () => {
  it("uses Corepack next to the current Linux Node even when PATH points at Windows pnpm", () => {
    const execPath = "/home/user/.nvm/versions/node/v24.18.0/bin/node";
    const corepackPath = join(dirname(execPath), "corepack");

    expect(
      resolvePnpmInvocation({
        platform: "linux",
        execPath,
        env: {
          PATH: "/mnt/c/Users/User/AppData/Roaming/npm:/usr/bin",
          PNPM_HOME: "/mnt/c/Users/User/AppData/Roaming/npm",
          WSL_DISTRO_NAME: "Ubuntu",
        },
        pathExists: (candidate) => candidate === corepackPath,
        realPath: (candidate) => candidate,
      }),
    ).toEqual({
      command: execPath,
      argsPrefix: [corepackPath, "pnpm"],
      shell: false,
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
        realPath: (candidate) => candidate,
      }),
    ).toEqual({
      command: pnpmPath,
      argsPrefix: [],
      shell: false,
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

  it("never launches PNPM_HOME in WSL even from a nonstandard Windows mount", () => {
    const pnpmHome = "/windir/c/Users/User/AppData/Roaming/npm";
    const pnpmPath = join(pnpmHome, "pnpm");

    expect(() =>
      resolvePnpmInvocation({
        platform: "linux",
        execPath: "/usr/bin/node",
        env: { PNPM_HOME: pnpmHome, WSL_DISTRO_NAME: "Ubuntu" },
        pathExists: (candidate) => candidate === pnpmPath,
        realPath: (candidate) => candidate,
      }),
    ).toThrow(/Corepack next to the active Linux Node/);
  });

  it("rejects a Node symlink that resolves to a Windows executable in WSL", () => {
    const execPath = "/usr/local/bin/node";

    expect(() =>
      resolvePnpmInvocation({
        platform: "linux",
        execPath,
        env: { WSL_INTEROP: "/run/WSL/123_interop" },
        pathExists: () => true,
        realPath: (candidate) =>
          candidate === execPath
            ? "/mnt/c/Program Files/nodejs/node.exe"
            : candidate,
      }),
    ).toThrow(/active Linux Node/);
  });

  it("rejects a Windows Node executable under a custom WSL automount root", () => {
    const execPath = "/usr/local/bin/node";

    expect(() =>
      resolvePnpmInvocation({
        platform: "linux",
        execPath,
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        pathExists: () => true,
        realPath: (candidate) =>
          candidate === execPath
            ? "/windir/c/Program Files/nodejs/node.exe"
            : candidate,
      }),
    ).toThrow(/active Linux Node/);
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
      shell: true,
      source: "windows-path",
    });
  });

  it("uses the launcher-validated pinned pnpm CLI on native Windows", () => {
    const pnpmCli = "C:\\fullmag-cache\\corepack\\v1\\pnpm\\10.8.1\\bin\\pnpm.cjs";

    expect(
      resolvePnpmInvocation({
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        env: { FULLMAG_PNPM_CLI: pnpmCli },
        pathExists: (candidate) => candidate === pnpmCli,
        realPath: (candidate) => candidate,
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      argsPrefix: [pnpmCli],
      shell: false,
      source: "fullmag-pinned-pnpm",
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

describe("control-room dependency readiness", () => {
  it("installs dependencies when node_modules exists without the Next executable", () => {
    const installCalls = [];
    let nextAvailable = false;

    const installed = ensureControlRoomDependencies({
      appDir: "/repo/apps/control-room",
      cwd: "/repo",
      pnpm: {
        command: "/usr/bin/pnpm",
        argsPrefix: [],
        shell: false,
        source: "pnpm-home",
      },
      pathExists: (candidate) =>
        nextAvailable &&
        candidate
          .replaceAll("\\", "/")
          .endsWith("/node_modules/.bin/next"),
      execFile: (command, args, options) => {
        installCalls.push({ command, args, options });
        nextAvailable = true;
      },
    });

    expect(installed).toBe(true);
    expect(installCalls).toEqual([
      {
        command: "/usr/bin/pnpm",
        args: ["--dir", "/repo/apps/control-room", "install", "--frozen-lockfile"],
        options: { cwd: "/repo", shell: false, stdio: "inherit" },
      },
    ]);
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
    expect(controlRoomLauncher).toContain(
      "const browserOrigin = `http://${formatUrlHost(browserHost)}:${port}`",
    );
    expect(controlRoomLauncher).toContain(
      "NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: browserOrigin",
    );
    expect(controlRoomLauncher).not.toContain(
      "NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: apiTarget",
    );
    expect(controlRoomLauncher).not.toContain(
      'process.platform === "win32" ? "pnpm.cmd" : "pnpm"',
    );
    expect(controlRoomLauncher).toContain("shell: pnpm.shell");
    expect(webShim).toContain("process.execPath");
    expect(webShim).toContain("apps/control-room/dev-server.mjs");
    expect(webShim).not.toMatch(/\bpnpm(?:\.cmd)?\b/);
  });

  it("derives browser-facing URLs from the public host when WSL is opened by IP", () => {
    const controlRoomLauncher = readFileSync(
      resolve(scriptDir, "../dev-server.mjs"),
      "utf8",
    );

    expect(controlRoomLauncher).toContain("FULLMAG_WEB_PUBLIC_HOST");
    expect(controlRoomLauncher).toContain("browserHost");
  });
});
