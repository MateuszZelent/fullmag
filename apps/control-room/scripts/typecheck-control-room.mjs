import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const nextEnvPath = join(appRoot, "next-env.d.ts");
const nextEnvSnapshot = readFileSync(nextEnvPath, "utf8");
const require = createRequire(import.meta.url);
const toolEntrypoints = {
  next: require.resolve("next/dist/bin/next"),
  tsc: require.resolve("typescript/bin/tsc"),
};

function runTool(tool, args) {
  const entrypoint = toolEntrypoints[tool];
  if (!entrypoint) {
    throw new Error(`Unsupported local typecheck tool: ${tool}`);
  }
  execFileSync(process.execPath, [entrypoint, ...args], {
    cwd: appRoot,
    stdio: "inherit",
  });
}

try {
  runTool("next", ["typegen", "."]);
} finally {
  writeFileSync(nextEnvPath, nextEnvSnapshot);
}

runTool("tsc", ["--noEmit", "--project", "tsconfig.typecheck.json"]);
