import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const nextEnvPath = join(appRoot, "next-env.d.ts");
const nextEnvSnapshot = readFileSync(nextEnvPath, "utf8");
const binSuffix = process.platform === "win32" ? ".cmd" : "";

function runTool(tool, args) {
  execFileSync(`${tool}${binSuffix}`, args, {
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
