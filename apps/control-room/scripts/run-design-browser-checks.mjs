import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { designCheckUrl, designReportDir } from "./lib/design-browser-env.mjs";

// Runs the Control Room design browser checks against one DEV group, each with
// its own report directory under CONTROL_ROOM_DESIGN_REPORT_DIR.
// `--only a,b` selects checks by name. Model-backed checks need the fixture
// session (`examples/fem_disconnected_mixed_p1_operator_probe.py`) loaded.
const CHECKS = [
  { name: "design-audit", note: "mocked empty-session API" },
  { name: "theme-start", note: "start screen theme and fonts" },
  { name: "header-session", note: "header width sweep" },
  { name: "ribbon-design", note: "ribbon toolbar and densities" },
  { name: "design-interactions", note: "keyboard, 200% zoom, embedded Home" },
  { name: "script-options", note: "prepared-script options" },
  { name: "panel-design", note: "panel frames; needs the fixture model" },
  { name: "inspector-ack", note: "Inspector Apply/ACK; needs the fixture model" },
  { name: "inspector-resize", note: "Inspector resize; needs the fixture model" },
  { name: "design-acceptance", note: "PR #268 acceptance symptoms; needs the fixture model" },
];

const scripts = dirname(fileURLToPath(import.meta.url));
const url = designCheckUrl();
const reportRoot = designReportDir();
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1]?.split(",") ?? []) : null;
const selected = CHECKS.filter((check) => !only || only.has(check.name));
if (only && selected.length !== only.size) {
  console.error(`Unknown check in --only; available: ${CHECKS.map((check) => check.name).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const check of selected) {
  const output = resolve(reportRoot, check.name);
  mkdirSync(output, { recursive: true });
  console.log(`▶ ${check.name} (${check.note})`);
  const run = spawnSync(process.execPath, [resolve(scripts, `check-${check.name}-browser.mjs`)], {
    env: { ...process.env, CONTROL_ROOM_URL: url, CONTROL_ROOM_DESIGN_REPORT_DIR: output },
    stdio: "inherit",
  });
  results.push({ name: check.name, status: run.status === 0 ? "PASS" : "FAIL" });
}
console.log(JSON.stringify({ url, reportRoot, results }));
process.exit(results.every((result) => result.status === "PASS") ? 0 : 1);
