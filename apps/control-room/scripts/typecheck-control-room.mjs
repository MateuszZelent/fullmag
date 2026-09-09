import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const nextEnvPath = join(appRoot, "next-env.d.ts");
const nextEnvSnapshot = readFileSync(nextEnvPath, "utf8");
const frontendRoot = process.env.FULLMAG_FRONTEND_ROOT?.trim();
if (frontendRoot && !isAbsolute(frontendRoot)) {
  throw new Error(`FULLMAG_FRONTEND_ROOT must be absolute: ${frontendRoot}`);
}
const tsBuildInfoFile = frontendRoot
  ? resolve(frontendRoot, "tsbuildinfo", "control-room.tsbuildinfo")
  : undefined;
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

runTool(
  "tsc",
  [
    "--noEmit",
    "--project",
    "tsconfig.typecheck.json",
    ...(tsBuildInfoFile ? ["--tsBuildInfoFile", tsBuildInfoFile] : []),
  ],
);
