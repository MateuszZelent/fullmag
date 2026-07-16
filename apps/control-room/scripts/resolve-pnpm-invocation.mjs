import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

function isWindowsInteropPath(candidate) {
  return (
    /^\/mnt\/[a-z](?:\/|$)/i.test(candidate) ||
    /^[a-z]:[\\/]/i.test(candidate) ||
    candidate.startsWith("\\\\") ||
    /\.(?:bat|cmd|exe)$/i.test(candidate)
  );
}

export function resolvePnpmInvocation({
  platform = process.platform,
  execPath = process.execPath,
  env = process.env,
  pathExists = existsSync,
  realPath = realpathSync,
} = {}) {
  if (platform === "win32") {
    return {
      command: "pnpm.cmd",
      argsPrefix: [],
      shell: true,
      source: "windows-path",
    };
  }

  const canonicalExecPath = canonicalPath(execPath, realPath);
  const corepackPath = join(dirname(canonicalExecPath), "corepack");
  if (
    !isWindowsInteropPath(canonicalExecPath) &&
    pathExists(corepackPath) &&
    !isWindowsInteropPath(canonicalPath(corepackPath, realPath))
  ) {
    return {
      command: canonicalExecPath,
      argsPrefix: [corepackPath, "pnpm"],
      shell: false,
      source: "corepack",
    };
  }

  const isWsl =
    platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (isWsl) {
    throw new Error(
      "No Corepack next to the active Linux Node was found. Install Node and Corepack inside WSL; Windows PNPM_HOME is intentionally ignored.",
    );
  }

  const pnpmHome = env.PNPM_HOME?.trim();
  if (pnpmHome) {
    const canonicalPnpmHome = canonicalPath(pnpmHome, realPath);
    const pnpmPath = join(canonicalPnpmHome, "pnpm");
    if (
      !isWindowsInteropPath(canonicalPnpmHome) &&
      pathExists(pnpmPath) &&
      !isWindowsInteropPath(canonicalPath(pnpmPath, realPath))
    ) {
      return {
        command: pnpmPath,
        argsPrefix: [],
        shell: false,
        source: "pnpm-home",
      };
    }
  }

  throw new Error(
    "No Linux pnpm installation was found. Install Corepack or set PNPM_HOME to a Linux path.",
  );
}

function canonicalPath(candidate, realPath) {
  try {
    return realPath(candidate);
  } catch {
    return candidate;
  }
}
