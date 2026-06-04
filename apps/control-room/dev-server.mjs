#!/usr/bin/env node
/**
 * dev-server.mjs for apps/control-room
 *
 * Used by the fullmag binary when browser_control_room_assets points to
 * apps/control-room (after the Rust source is updated and rebuilt).
 *
 * Invocation by binary:
 *   node dev-server.mjs --hostname 0.0.0.0 --port 3100 --api-target http://localhost:8081
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, "../..");
const args = process.argv.slice(2);

const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? (args[portIdx + 1] ?? "3100") : "3100";
const hostnameIdx = args.indexOf("--hostname");
const hostname =
  hostnameIdx >= 0 ? (args[hostnameIdx + 1] ?? "0.0.0.0") : "0.0.0.0";
const apiTargetIdx = args.indexOf("--api-target");
const apiTarget =
  apiTargetIdx >= 0
    ? (args[apiTargetIdx + 1] ?? "http://localhost:8081")
    : "http://localhost:8081";

process.stderr.write(`[control-room dev-server] starting on :${port}\n`);

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(
  pnpmCmd,
  ["--dir", appDir, "dev", "--hostname", hostname, "--port", port],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      FULLMAG_API_PROXY_TARGET: apiTarget,
      FULLMAG_API_URL: apiTarget,
      NEXT_PUBLIC_API_URL: apiTarget,
      NEXT_PUBLIC_CONTROL_ROOM_API_BASE_URL: apiTarget,
      NEXT_PUBLIC_FULLMAG_API_URL: apiTarget,
      NEXT_PUBLIC_RUNTIME_HTTP_BASE: apiTarget,
    },
    stdio: "inherit",
  },
);

const signalExitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
};

let shuttingDown = false;
let childExited = false;
const shutdown = (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  child.kill(signal);
  setTimeout(() => {
    if (!childExited) {
      child.kill("SIGKILL");
    }
  }, 2000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  childExited = true;
  if (signal) {
    process.exit(signalExitCodes[signal] ?? 1);
    return;
  }
  process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write(`[control-room dev-server] failed to spawn pnpm: ${err.message}\n`);
  process.exit(1);
});
