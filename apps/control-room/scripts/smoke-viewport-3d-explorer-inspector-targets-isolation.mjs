import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const DEFAULT_REPOSITORY_SCENARIOS = [
  "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb_fdm.py",
];

export function resolveRepositoryScenarioPaths({ env, repositoryRoot }) {
  const configured = env.CONTROL_ROOM_TARGET_SMOKE_REPOSITORY_SCENARIOS;
  const candidates = configured
    ? configured.split(",").map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_REPOSITORY_SCENARIOS;
  return candidates.map((candidate) => resolveRepositoryPath(repositoryRoot, candidate));
}

export async function captureScenarioHashes(paths) {
  return new Map(await Promise.all(paths.map(async (path) => [path, sha256(await readFile(path))])));
}

export async function assertScenarioHashesUnchanged(before) {
  for (const [path, expected] of before) {
    const actual = sha256(await readFile(path));
    if (actual !== expected) {
      throw new Error(`Scenario file changed during target smoke: ${path}; before=${expected} after=${actual}`);
    }
  }
}

function resolveRepositoryPath(repositoryRoot, candidate) {
  const root = resolve(repositoryRoot);
  const path = resolve(root, candidate);
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Target smoke scenario must remain below repository root: ${candidate}`);
  }
  return path;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
