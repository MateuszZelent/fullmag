import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePnpmInvocation } from "./resolve-pnpm-invocation.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const nextEnvPath = join(appRoot, "next-env.d.ts");
const nextEnvSnapshot = readFileSync(nextEnvPath, "utf8");
const pnpmLockPath = join(appRoot, "..", "..", "pnpm-lock.yaml");
const pnpmLockSnapshot = readFileSync(pnpmLockPath);
const pnpm = resolvePnpmInvocation();

try {
  execFileSync(
    pnpm.command,
    [...pnpm.argsPrefix, "--dir", appRoot, "exec", "next", "build", "--webpack"],
    {
      cwd: appRoot,
      env: { ...process.env, NEXT_PUBLIC_AUDIT_BUILD: "1" },
      shell: pnpm.shell,
      stdio: "inherit",
    },
  );
} finally {
  writeFileSync(nextEnvPath, nextEnvSnapshot);
  // Keep the audit build hermetic: pnpm/Next may rewrite lockfile metadata on
  // some hosts even though the build does not resolve new dependencies.
  writeFileSync(pnpmLockPath, pnpmLockSnapshot);
}
