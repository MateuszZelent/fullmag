#!/usr/bin/env node
/**
 * Stub shim for the fullmag binary's external-frontend detection.
 *
 * The pre-built fullmag binary looks for apps/web/dev-server.mjs to decide
 * whether an external control-room frontend is available. If the port is
 * already listening and ready (apps/control-room running on :3100), the binary
 * reuses it and never executes this file.
 *
 * If the binary does spawn this file, it delegates to apps/control-room.
 *
 * Invocation by binary:
 *   node dev-server.mjs --hostname 0.0.0.0 --port 3100 --api-target http://localhost:8081
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);

const portIdx = args.indexOf("--port");
const port = portIdx >= 0 ? (args[portIdx + 1] ?? "3100") : "3100";
const hostnameIdx = args.indexOf("--hostname");
const hostname = hostnameIdx >= 0 ? (args[hostnameIdx + 1] ?? "0.0.0.0") : "0.0.0.0";
const apiTargetIdx = args.indexOf("--api-target");
const apiTarget = apiTargetIdx >= 0 ? (args[apiTargetIdx + 1] ?? "http://localhost:8081") : "http://localhost:8081";

process.stderr.write(`[dev-server shim] delegating to apps/control-room dev on :${port}\n`);

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(
  pnpmCmd,
  ["--dir", "apps/control-room", "dev", "--hostname", hostname, "--port", port],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      FULLMAG_API_PROXY_TARGET: apiTarget,
      NEXT_PUBLIC_FULLMAG_API_URL: apiTarget,
      FULLMAG_API_URL: apiTarget,
    },
    stdio: "inherit",
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  process.stderr.write(`[dev-server shim] failed to spawn pnpm: ${err.message}\n`);
  process.exit(1);
});
