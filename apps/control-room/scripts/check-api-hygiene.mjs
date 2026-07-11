import { spawnSync } from "node:child_process";

const checks = [
  {
    args: [
      "\\bfetch\\(",
      "src",
      "--glob",
      "!src/kernel/api/**",
      "--glob",
      "!src/kernel/api/generated/**",
    ],
    label: "direct fetch outside kernel API",
  },
  {
    args: ["apps/web|ControlRoomContext|normalizeSession|mergeSession", "src"],
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
    ],
    label: "hand-built v2 endpoint strings outside API/generated",
  },
  {
    args: [
      "-i",
      "/v1/live/current|\\bbootstrap\\b|\\bpoll\\b|/preview[-/]|preview/",
      "src",
      "--glob",
      "!src/kernel/api/generated/**",
    ],
    label: "legacy live/bootstrap/poll/preview path",
  },
];

let failed = false;

for (const check of checks) {
  const result = spawnSync("rg", check.args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  if (result.status === 0) {
    failed = true;
    console.error(`API hygiene check failed: ${check.label}`);
    console.error(result.stdout);
  } else if (result.status !== 1) {
    failed = true;
    console.error(`API hygiene check errored: ${check.label}`);
    console.error(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exit(1);
}
