import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const nodeVersion = "24.18.0";
const linuxX64Sha256 =
  "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
const linuxArm64Sha256 =
  "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6";

describe("Node runtime version contract", () => {
  for (const relativePath of ["docker/dev/Dockerfile", "docker/fem-gpu/Dockerfile"]) {
    it(`pins ${relativePath} to the verified Node artifact`, () => {
      const dockerfile = readFileSync(resolve(repoRoot, relativePath), "utf8");

      expect(dockerfile).toContain(`ARG NODE_VERSION=${nodeVersion}`);
      expect(dockerfile).toContain(linuxX64Sha256);
      expect(dockerfile).toContain(linuxArm64Sha256);
      expect(dockerfile).not.toContain("deb.nodesource.com");
      expect(dockerfile).not.toContain("NODE_MAJOR");
    });
  }

  it("sets up the pinned Node runtime before the first control-room repository script", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".github/workflows/bootstrap.yml"),
      "utf8",
    );
    const jobStart = workflow.indexOf("\n  control-room-contracts:");
    const nextJob = workflow.indexOf("\n  python-contracts:", jobStart);
    const job = workflow.slice(jobStart, nextJob);
    const setupNode = job.indexOf("name: Setup Node.js");
    const resourceGate = job.indexOf("name: Resource-first migration gates");

    expect(jobStart).toBeGreaterThan(-1);
    expect(setupNode).toBeGreaterThan(-1);
    expect(resourceGate).toBeGreaterThan(setupNode);
    expect(job).toContain(`node-version: ${nodeVersion}`);
  });

  it("keeps a hermetic Ubuntu 22.04 gate for ripgrep 13 API hygiene", () => {
    const workflow = readFileSync(
      resolve(repoRoot, ".github/workflows/bootstrap.yml"),
      "utf8",
    );
    const jobStart = workflow.indexOf("api-hygiene-rg13:");
    const nextJob = workflow.indexOf("\n  control-room-contracts:", jobStart);
    const job = workflow.slice(jobStart, nextJob);

    expect(jobStart).toBeGreaterThan(-1);
    expect(job).toContain("runs-on: ubuntu-22.04");
    expect(job).toContain(`node-version: ${nodeVersion}`);
    expect(job).toContain("uses: actions/setup-node@v7");
    expect(job).toContain('"$(/usr/bin/rg --version | head -n 1)" = "ripgrep 13.0.0"');
    expect(job).toContain('node_bin="$(command -v node)"');
    expect(job).toContain('test "$("$node_bin" --version)" = "v24.18.0"');
    expect(job).toContain(
      'PATH=/usr/bin:/bin "$node_bin" apps/control-room/scripts/check-api-hygiene.mjs',
    );
    expect(job).not.toContain(
      "PATH=/usr/bin:/bin node apps/control-room/scripts/check-api-hygiene.mjs",
    );
  });
});
