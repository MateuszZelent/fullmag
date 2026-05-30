import { spawnSync } from "node:child_process";

const args = [
  "--dir",
  "apps/control-room",
  "exec",
  "vitest",
  "run",
  "src/modules/viewport-2d/viewport2dRenderModel.performance.test.ts",
  "--pool=threads",
];

const result = spawnSync("pnpm", args, {
  cwd: new URL("../../..", import.meta.url),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
