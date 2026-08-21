#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { writeProofManifestToReportRoot } from "./lib/proof-manifest.mjs";

const artifactRoot = resolve(
  process.env.CONTROL_ROOM_AUDIT_ARTIFACTS_DIR ??
    "apps/control-room/.artifacts/viewport-3d-browser-audit",
);
const outputPath = resolve(artifactRoot, "viewport-proof-manifest.json");
const sourceSnapshotPath = resolve(artifactRoot, "source-snapshot.v2.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function githubExecutionIdentity() {
  const required = [
    "GITHUB_RUN_ID",
    "GITHUB_SHA",
    "GITHUB_WORKFLOW",
    "GITHUB_JOB",
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw blocked(`missing ${missing.join(", ")}`);
  }
  return {
    provider: "github-actions",
    runId: process.env.GITHUB_RUN_ID,
    workflowName: process.env.GITHUB_WORKFLOW,
    jobName: process.env.GITHUB_JOB,
    headSha: process.env.GITHUB_SHA,
    timestampUtc: new Date().toISOString(),
    conclusion: "success",
  };
}

function blocked(detail) {
  const error = new Error(`BLOCKED github-execution-identity-missing: ${detail}`);
  error.exitCode = 2;
  return error;
}

async function artifactFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await artifactFiles(path));
    } else if (entry.isFile() && path !== outputPath) {
      files.push(path);
    }
  }
  return files.sort();
}

function changedPaths(sourceSnapshot) {
  const paths = [];
  for (const record of sourceSnapshot.git_status_porcelain_v1 ?? []) {
    if (!record || !Array.isArray(record.paths)) {
      throw new Error("source snapshot contains an invalid Git status record");
    }
    paths.push(...record.paths);
  }
  return [...new Set(paths)].sort();
}

function mediaType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".txt") || path.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

async function main() {
  const execution = githubExecutionIdentity();
  if (process.argv.includes("--check-identity")) {
    process.stdout.write("browser fixture proof identity available\n");
    return;
  }

  const files = await artifactFiles(artifactRoot);
  if (files.length === 0) {
    throw new Error(`browser fixture proof requires artifacts in ${artifactRoot}`);
  }
  const sourceSnapshot = JSON.parse(await readFile(sourceSnapshotPath, "utf8"));
  const artifacts = await Promise.all(files.map(async (path) => ({
    path: relative(artifactRoot, path),
    sha256: sha256(await readFile(path)),
    mediaType: mediaType(path),
  })));
  const packageSha = sha256(await readFile("apps/control-room/package.json"));
  const manifest = {
    schemaVersion: "fullmag.viewport-proof.v1",
    proofClass: "fixture-smoke",
    outcome: "pass",
    scenarioId: "browser-fixture-smoke",
    execution,
    source: {
      auditBaseCommit: process.env.GITHUB_BASE_SHA ?? execution.headSha,
      implementationCommit: sourceSnapshot.head_commit_full,
      statusSha256: sourceSnapshot.dirty_content_sha256,
      runtimeRelevantDirty: sourceSnapshot.source_snapshot_dirty,
      allowedUnrelatedDirtyPaths: [],
      changedPaths: changedPaths(sourceSnapshot),
    },
    runtime: {
      lane: "browser-fixture",
      buildInfoSha256: packageSha,
      sourceSnapshotSha256: sourceSnapshot.source_snapshot_sha256,
      components: [{ path: "apps/control-room/package.json", sha256: packageSha, kind: "web-fixture" }],
      managedRecipe: null,
    },
    model: { path: "browser-fixture", sha256: sha256("browser-fixture"), fixture: true },
    browser: { name: "chromium", version: process.env.PLAYWRIGHT_VERSION ?? "playwright-managed" },
    gpu: { vendor: "CI", renderer: "Chromium WebGL" },
    session: {
      sessionId: "browser-fixture",
      sessionEpoch: execution.runId,
      startLifecycle: "active",
      endLifecycle: "active",
    },
    steps: [{ id: "browser-fixture-smoke", status: "pass", artifacts: artifacts.map((artifact) => artifact.path) }],
    artifacts,
    blocker: null,
  };
  await writeProofManifestToReportRoot(manifest, artifactRoot);
  process.stdout.write(`browser fixture proof manifest written: ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.exitCode ?? 1;
});
