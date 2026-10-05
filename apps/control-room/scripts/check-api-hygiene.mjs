import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  filterCanonicalComputePreviewMatchLines,
  LEGACY_PATH_PATTERN,
  shouldFailSearchCheck,
} from "./api-hygiene-rules.mjs";

const controlRoomDirectory = new URL("..", import.meta.url);
const regressionTests = spawnSync(
  process.execPath,
  [
    "--test",
    fileURLToPath(
      new URL("./check-api-hygiene-rules.node-test.mjs", import.meta.url),
    ),
  ],
  { cwd: controlRoomDirectory, encoding: "utf8" },
);

const checks = [
  {
    args: [
      "\\bfetch\\s*\\(",
      "src",
      "--glob",
      "!src/kernel/api/**",
      "--glob",
      "!src/kernel/api/generated/**",
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
    ],
    label: "hand-built v2 endpoint strings outside API/generated",
  },
  {
    args: [
      "-i",
      "--line-number",
      "--no-heading",
      LEGACY_PATH_PATTERN,
      "src",
      "--glob",
      "!src/kernel/api/generated/**",
    ],
    label: "legacy live/bootstrap/poll/preview path",
    filterMatches: filterCanonicalComputePreviewMatchLines,
  },
];

let failed = regressionTests.status !== 0;
if (failed) {
  console.error("API hygiene rule regressions failed");
  console.error(
    regressionTests.error?.message ||
      [regressionTests.stderr, regressionTests.stdout].filter(Boolean).join("\n"),
  );
}

for (const check of checks) {
  const result = spawnSync("rg", check.args, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  if (!shouldFailSearchCheck(result.status, result.stdout, check.filterMatches)) {
    continue;
  }

  if (result.status === 0) {
    failed = true;
    console.error(`API hygiene check failed: ${check.label}`);
    console.error(
      check.filterMatches ? check.filterMatches(result.stdout) : result.stdout,
    );
  } else {
    failed = true;
    console.error(`API hygiene check errored: ${check.label}`);
    console.error(result.stderr || result.stdout);
  }
}

if (failed) {
  process.exit(1);
}
