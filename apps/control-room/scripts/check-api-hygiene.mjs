import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const productionSourceGlobs = [
  "--glob",
  "!**/*.test.*",
  "--glob",
  "!**/*.spec.*",
];

const checks = [
  {
    args: [
      "\\bfetch\\s*\\(",
      "src",
      "--glob",
      "!src/kernel/api/**",
      "--glob",
      "!src/kernel/api/generated/**",
      ...productionSourceGlobs,
    ],
    label: "direct fetch outside kernel API",
  },
  {
    args: [
      "apps/web|ControlRoomContext|normalizeSession|mergeSession",
      "src",
      "--glob",
      "!**/*.test.*",
      "--glob",
      "!**/*.spec.*",
    ],
    label: "legacy frontend imports or state models",
  },
  {
    args: [
      "\"/v2/",
      "src",
      "--glob",
      "!src/kernel/api/**",
      "--glob",
      "!src/kernel/api/generated/**",
      ...productionSourceGlobs,
    ],
    label: "hand-built v2 endpoint strings outside API/generated",
  },
  {
    args: [
      "-i",
      `/v1/live/current(?:/|["'])|\\bbootstrap\\b|\\bpoll\\b|["'][^"']*/preview(?:/|["'])`,
      "src",
      "--glob",
      "!src/kernel/api/generated/**",
      ...productionSourceGlobs,
    ],
    label: "legacy live/bootstrap/poll/preview path",
  },
];

export function findApiHygieneFailures(root = appRoot) {
  const failures = [];

  for (const check of checks) {
    const result = spawnSync("rg", check.args, {
      cwd: root,
      encoding: "utf8",
    });

    if (result.status === 0) {
      failures.push({
        kind: "failure",
        label: check.label,
        output: result.stdout,
      });
    } else if (result.status !== 1) {
      failures.push({
        kind: "error",
        label: check.label,
        output: result.stderr || result.stdout || "",
      });
    }
  }

  return failures;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const failures = findApiHygieneFailures();

  for (const failure of failures) {
    if (failure.kind === "failure") {
      console.error(`API hygiene check failed: ${failure.label}`);
    } else {
      console.error(`API hygiene check errored: ${failure.label}`);
    }
    console.error(failure.output);
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}
