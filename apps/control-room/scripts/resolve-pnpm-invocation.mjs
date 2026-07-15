import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function isWindowsInteropPath(candidate) {
  return (
    /^\/mnt\/[a-z](?:\/|$)/i.test(candidate) ||
    /^[a-z]:[\\/]/i.test(candidate) ||
    candidate.startsWith("\\\\")
  );
}

export function resolvePnpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  pathExists = existsSync,
} = {}) {
  if (platform === "win32") {
    return {
      command: "pnpm.cmd",
      argsPrefix: [],
      source: "windows-path",
    };
  }

  const corepackPath = join(dirname(execPath), "corepack");
  if (!isWindowsInteropPath(execPath) && pathExists(corepackPath)) {
    return {
      command: execPath,
      argsPrefix: [corepackPath, "pnpm"],
      source: "corepack",
    };
  }

  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome && !isWindowsInteropPath(pnpmHome)) {
    const pnpmPath = join(pnpmHome, "pnpm");
    if (pathExists(pnpmPath)) {
      return {
        command: pnpmPath,
        argsPrefix: [],
        source: "pnpm-home",
      };
    }
  }

  throw new Error(
    "No Linux pnpm installation was found. Install Corepack or set PNPM_HOME to a Linux path.",
  );
}
