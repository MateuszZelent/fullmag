import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROOF_CLASSES = new Set([
  "qualification",
  "fixture-smoke",
  "baseline-fail",
  "blocked",
]);
const OUTCOMES = new Set(["pass", "fail", "blocked"]);

export class ProofManifestError extends Error {
  constructor(reasonCode, detail) {
    super(`${reasonCode}: ${detail}`);
    this.name = "ProofManifestError";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode, detail) {
  throw new ProofManifestError(reasonCode, detail);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_manifest", `${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("invalid_manifest", `${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("invalid_sha256", `${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function requireGitCommit(value, label) {
  if (typeof value !== "string" || !GIT_COMMIT_PATTERN.test(value)) {
    fail("invalid_sha256", `${label} must be a full lowercase Git object ID`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail("invalid_manifest", `${label} must be an array of strings`);
  }
  return value;
}

function pathIsInside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function resolveArtifact(root, artifactPath) {
  requireString(artifactPath, "artifact.path");
  if (isAbsolute(artifactPath)) {
    fail("artifact_path_escape", `absolute artifact path is forbidden: ${artifactPath}`);
  }
  const lexicalPath = resolve(root, artifactPath);
  if (!pathIsInside(root, lexicalPath)) {
    fail("artifact_path_escape", `artifact path escapes artifactRoot: ${artifactPath}`);
  }
  let resolvedPath;
  try {
    resolvedPath = await realpath(lexicalPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      fail("artifact_missing", `artifact does not exist: ${artifactPath}`);
    }
    throw error;
  }
  if (!pathIsInside(root, resolvedPath)) {
    fail("artifact_path_escape", `artifact symlink escapes artifactRoot: ${artifactPath}`);
  }
  if (!(await stat(resolvedPath)).isFile()) {
    fail("artifact_missing", `artifact is not a file: ${artifactPath}`);
  }
  return resolvedPath;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function validateSource(source) {
  requireGitCommit(source.auditBaseCommit, "source.auditBaseCommit");
  requireGitCommit(source.implementationCommit, "source.implementationCommit");
  requireSha256(source.statusSha256, "source.statusSha256");
  if (typeof source.runtimeRelevantDirty !== "boolean") {
    fail("invalid_manifest", "source.runtimeRelevantDirty must be boolean");
  }
  const allowed = new Set(requireStringArray(
    source.allowedUnrelatedDirtyPaths,
    "source.allowedUnrelatedDirtyPaths",
  ));
  const changedPaths = requireStringArray(source.changedPaths, "source.changedPaths");
  const runtimeRelevantPaths = changedPaths.filter((path) => !allowed.has(path));
  if (source.runtimeRelevantDirty || runtimeRelevantPaths.length > 0) {
    fail(
      "runtime_relevant_dirty",
      `runtime-relevant dirty paths: ${runtimeRelevantPaths.join(", ") || "declared"}`,
    );
  }
}

function validateRuntime(runtime) {
  requireString(runtime.lane, "runtime.lane");
  requireSha256(runtime.buildInfoSha256, "runtime.buildInfoSha256");
  requireSha256(runtime.sourceSnapshotSha256, "runtime.sourceSnapshotSha256");
  if (!Array.isArray(runtime.components) || runtime.components.length === 0) {
    fail("invalid_manifest", "runtime.components must be a non-empty array");
  }
  for (const [index, component] of runtime.components.entries()) {
    requireObject(component, `runtime.components[${index}]`);
    requireString(component.path, `runtime.components[${index}].path`);
    requireString(component.kind, `runtime.components[${index}].kind`);
    requireSha256(component.sha256, `runtime.components[${index}].sha256`);
  }
  if (runtime.managedRecipe !== null && typeof runtime.managedRecipe !== "string") {
    fail("invalid_manifest", "runtime.managedRecipe must be string or null");
  }
}

function validateModel(model, proofClass) {
  requireString(model.path, "model.path");
  requireSha256(model.sha256, "model.sha256");
  if (typeof model.fixture !== "boolean") {
    fail("invalid_manifest", "model.fixture must be boolean");
  }
  if (proofClass === "qualification" && model.fixture) {
    fail("qualification_fixture_forbidden", "qualification requires model.fixture=false");
  }
}

function validateSession(session) {
  requireString(session.sessionId, "session.sessionId");
  requireString(session.sessionEpoch, "session.sessionEpoch");
  requireString(session.startLifecycle, "session.startLifecycle");
  requireString(session.endLifecycle, "session.endLifecycle");
}

function validateExecution(execution, implementationCommit) {
  requireString(execution.provider, "execution.provider");
  requireString(execution.runId, "execution.runId");
  requireString(execution.workflowName, "execution.workflowName");
  requireString(execution.jobName, "execution.jobName");
  const headSha = requireGitCommit(execution.headSha, "execution.headSha");
  requireString(execution.conclusion, "execution.conclusion");
  if (headSha !== implementationCommit) {
    fail(
      "execution_source_mismatch",
      "execution.headSha does not match source.implementationCommit",
    );
  }
}

export function validateSourceSnapshotBinding(manifestValue, snapshotValue) {
  const manifest = requireObject(manifestValue, "manifest");
  const source = requireObject(manifest.source, "source");
  const runtime = requireObject(manifest.runtime, "runtime");
  const snapshot = requireObject(snapshotValue, "sourceSnapshot");
  if (snapshot.schema !== "fullmag.source-snapshot.v2") {
    fail("source_snapshot_mismatch", "sourceSnapshot.schema must be fullmag.source-snapshot.v2");
  }
  const commit = requireGitCommit(snapshot.head_commit_full, "sourceSnapshot.head_commit_full");
  const snapshotSha = requireSha256(
    snapshot.source_snapshot_sha256,
    "sourceSnapshot.source_snapshot_sha256",
  );
  if (commit !== source.implementationCommit) {
    fail(
      "source_snapshot_mismatch",
      "sourceSnapshot.head_commit_full does not match source.implementationCommit",
    );
  }
  if (snapshotSha !== runtime.sourceSnapshotSha256) {
    fail(
      "source_snapshot_mismatch",
      "sourceSnapshot.source_snapshot_sha256 does not match runtime.sourceSnapshotSha256",
    );
  }
}

export async function validateProofManifest(manifestValue, artifactRoot) {
  const manifest = requireObject(manifestValue, "manifest");
  if (manifest.schemaVersion !== "fullmag.viewport-proof.v1") {
    fail("invalid_manifest", "schemaVersion must be fullmag.viewport-proof.v1");
  }
  if (!PROOF_CLASSES.has(manifest.proofClass)) {
    fail("invalid_manifest", `unsupported proofClass: ${String(manifest.proofClass)}`);
  }
  if (!OUTCOMES.has(manifest.outcome)) {
    fail("invalid_manifest", `unsupported outcome: ${String(manifest.outcome)}`);
  }
  if (manifest.proofClass === "qualification" && manifest.outcome !== "pass") {
    fail("invalid_manifest", "qualification proof must have outcome=pass");
  }
  if (manifest.outcome === "blocked") {
    const blocker = requireObject(manifest.blocker, "blocker");
    requireString(blocker.code, "blocker.code");
    requireString(blocker.detail, "blocker.detail");
  } else if (manifest.blocker !== null) {
    fail("invalid_manifest", "non-blocked outcome requires blocker=null");
  }
  requireString(manifest.scenarioId, "scenarioId");
  const source = requireObject(manifest.source, "source");
  validateSource(source);
  validateExecution(
    requireObject(manifest.execution, "execution"),
    source.implementationCommit,
  );
  validateRuntime(requireObject(manifest.runtime, "runtime"));
  validateModel(requireObject(manifest.model, "model"), manifest.proofClass);
  requireObject(manifest.browser, "browser");
  requireString(manifest.browser.name, "browser.name");
  requireString(manifest.browser.version, "browser.version");
  requireObject(manifest.gpu, "gpu");
  requireString(manifest.gpu.vendor, "gpu.vendor");
  requireString(manifest.gpu.renderer, "gpu.renderer");
  validateSession(requireObject(manifest.session, "session"));
  if (!Array.isArray(manifest.steps)) {
    fail("invalid_manifest", "steps must be an array");
  }
  if (!Array.isArray(manifest.artifacts)) {
    fail("invalid_manifest", "artifacts must be an array");
  }

  const canonicalRoot = await realpath(resolve(artifactRoot));
  const artifactPaths = new Set();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    requireObject(artifact, `artifacts[${index}]`);
    const artifactPath = requireString(artifact.path, `artifacts[${index}].path`);
    requireString(artifact.mediaType, `artifacts[${index}].mediaType`);
    const expectedSha = requireSha256(artifact.sha256, `artifacts[${index}].sha256`);
    if (artifactPaths.has(artifactPath)) {
      fail("invalid_manifest", `duplicate artifact path: ${artifactPath}`);
    }
    artifactPaths.add(artifactPath);
    const resolvedPath = await resolveArtifact(canonicalRoot, artifactPath);
    const actualSha = await sha256File(resolvedPath);
    if (actualSha !== expectedSha) {
      fail("artifact_hash_mismatch", `artifact hash mismatch: ${artifactPath}`);
    }
  }
  for (const [index, step] of manifest.steps.entries()) {
    requireObject(step, `steps[${index}]`);
    requireString(step.id, `steps[${index}].id`);
    requireString(step.status, `steps[${index}].status`);
    for (const artifactPath of requireStringArray(step.artifacts ?? [], `steps[${index}].artifacts`)) {
      if (!artifactPaths.has(artifactPath)) {
        fail("artifact_missing", `step references undeclared artifact: ${artifactPath}`);
      }
    }
  }
}

export async function writeProofManifest(manifest, outputPath, artifactRoot) {
  await validateProofManifest(manifest, artifactRoot);
  const canonicalRoot = await realpath(resolve(artifactRoot));
  const lexicalOutput = resolve(outputPath);
  if (!pathIsInside(canonicalRoot, lexicalOutput)) {
    fail("artifact_path_escape", `manifest output escapes artifactRoot: ${outputPath}`);
  }
  const canonicalParent = await realpath(dirname(lexicalOutput));
  if (!pathIsInside(canonicalRoot, canonicalParent)) {
    fail("artifact_path_escape", `manifest parent escapes artifactRoot: ${outputPath}`);
  }
  await writeFile(lexicalOutput, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}
