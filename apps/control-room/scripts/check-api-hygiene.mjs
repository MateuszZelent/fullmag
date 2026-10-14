import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  filterCanonicalComputePreviewMatchLines,
  LEGACY_PATH_PATTERN,
  shouldFailSearchCheck,
} from "./api-hygiene-rules.mjs";

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
      "--line-number",
      "--no-heading",
      LEGACY_PATH_PATTERN,
      "src",
      "--glob",
      "!src/kernel/api/generated/**",
      ...productionSourceGlobs,
    ],
    label: "legacy live/bootstrap/poll/preview path",
    filterMatches: filterCanonicalComputePreviewMatchLines,
  },
];

export function findApiHygieneFailures(root = appRoot) {
  const failures = [];
  for (const check of checks) {
    const result = spawnSync("rg", check.args, { cwd: root, encoding: "utf8" });
    if (!shouldFailSearchCheck(result.status, result.stdout, check.filterMatches)) {
      continue;
    }
    failures.push({
      kind: result.status === 0 ? "failure" : "error",
      label: check.label,
      output: result.status === 0
        ? (check.filterMatches ? check.filterMatches(result.stdout) : result.stdout)
        : result.stderr || result.stdout || "",
    });
  }
  return failures;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const regressionTests = spawnSync(
    process.execPath,
    ["--test", fileURLToPath(new URL("./check-api-hygiene-rules.node-test.mjs", import.meta.url))],
    { cwd: appRoot, encoding: "utf8" },
  );
  let failed = regressionTests.status !== 0;
  if (failed) {
    console.error("API hygiene rule regressions failed");
    console.error(regressionTests.error?.message || [regressionTests.stderr, regressionTests.stdout].filter(Boolean).join("\n"));
  }
  const failures = findApiHygieneFailures();
  for (const failure of failures) {
    console.error(`API hygiene check ${failure.kind === "failure" ? "failed" : "errored"}: ${failure.label}`);
    console.error(failure.output);
  }
  if (failed || failures.length > 0) process.exit(1);
}
