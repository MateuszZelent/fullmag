#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProofManifestError,
  validateProofManifest,
  validateSourceSnapshotBinding,
} from "./lib/proof-manifest.mjs";

const SHA = "a".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

async function selfTest() {
  const root = await makeSelfTestRoot();
  try {
    await writeFile(join(root, "evidence.json"), "{}\n");
    const manifest = {
      schemaVersion: "fullmag.viewport-proof.v1",
      proofClass: "fixture-smoke",
      outcome: "pass",
      scenarioId: "validator-self-test",
      execution: {
        provider: "self-test",
        runId: "self-test-run",
        workflowName: "self-test-workflow",
        jobName: "self-test-job",
        headSha: SHA,
        conclusion: "success",
      },
      source: {
        auditBaseCommit: SHA,
        implementationCommit: SHA,
        statusSha256: SHA,
        runtimeRelevantDirty: false,
        allowedUnrelatedDirtyPaths: [],
        changedPaths: [],
      },
      runtime: {
        lane: "self-test",
        buildInfoSha256: SHA,
        sourceSnapshotSha256: SHA,
        components: [{ path: "self-test", sha256: SHA, kind: "fixture" }],
        managedRecipe: null,
      },
      model: { path: "self-test", sha256: SHA, fixture: true },
      browser: { name: "none", version: "self-test" },
      gpu: { vendor: "none", renderer: "self-test" },
      session: {
        sessionId: "self-test-session",
        sessionEpoch: "self-test-epoch",
        startLifecycle: "active",
        endLifecycle: "active",
      },
      steps: [
        {
          id: "validate",
          status: "pass",
          artifacts: ["evidence.json"],
        },
      ],
      artifacts: [
        {
          path: "evidence.json",
          sha256: sha256("{}\n"),
          mediaType: "application/json",
        },
      ],
      blocker: null,
    };
    await validateProofManifest(manifest, root);
    manifest.execution.headSha = "b".repeat(64);
    await assertProofManifestFailure(
      manifest,
      root,
      "execution_source_mismatch",
    );
    manifest.execution.headSha = SHA;
    manifest.artifacts[0].sha256 = "b".repeat(64);
    try {
      await validateProofManifest(manifest, root);
    } catch (error) {
      if (error instanceof ProofManifestError && error.reasonCode === "artifact_hash_mismatch") {
        process.stdout.write("viewport proof manifest self-test: PASS\n");
        return;
      }
      throw error;
    }
    throw new Error("tampered artifact was accepted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertProofManifestFailure(manifest, root, reasonCode) {
  try {
    await validateProofManifest(manifest, root);
  } catch (error) {
    if (error instanceof ProofManifestError && error.reasonCode === reasonCode) {
      return;
    }
    throw error;
  }
  throw new Error(`manifest unexpectedly passed: ${reasonCode}`);
}

async function makeSelfTestRoot() {
  const candidates = [
    process.env.FULLMAG_PROOF_SELF_TEST_TMPDIR,
    tmpdir(),
    "/tmp",
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true });
      return await mkdtemp(join(candidate, "fullmag-proof-self-test-"));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("no writable temporary directory for proof self-test");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    await selfTest();
    return;
  }
  const manifestPath = optionValue(args, "--manifest") ?? args[0] ?? null;
  if (!manifestPath) {
    throw new Error("usage: validate-viewport-proof-manifest.mjs --manifest <path> [--artifact-root <path>] [--source-snapshot <path>]");
  }
  const absoluteManifestPath = resolve(manifestPath);
  const artifactRoot = resolve(
    optionValue(args, "--artifact-root") ?? dirname(absoluteManifestPath),
  );
  const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
  await validateProofManifest(manifest, artifactRoot);
  const sourceSnapshotPath = optionValue(args, "--source-snapshot");
  if (sourceSnapshotPath) {
    const sourceSnapshot = JSON.parse(await readFile(resolve(sourceSnapshotPath), "utf8"));
    validateSourceSnapshotBinding(manifest, sourceSnapshot);
  }
  process.stdout.write(`viewport proof manifest valid: ${absoluteManifestPath}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
