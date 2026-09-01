import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const nextEnvPath = join(appRoot, "next-env.d.ts");
const nextEnvSnapshot = readFileSync(nextEnvPath, "utf8");
function runNodeTool(modulePath, args) {
  execFileSync(process.execPath, [modulePath, ...args], {
    cwd: appRoot,
    stdio: "inherit",
  });
}

const nextCli = join(appRoot, "node_modules", "next", "dist", "bin", "next");
const tscCli = join(appRoot, "node_modules", "typescript", "bin", "tsc");

try {
  runNodeTool(nextCli, ["typegen", "."]);
} finally {
  writeFileSync(nextEnvPath, nextEnvSnapshot);
}

runNodeTool(tscCli, ["--noEmit", "--project", "tsconfig.typecheck.json"]);
