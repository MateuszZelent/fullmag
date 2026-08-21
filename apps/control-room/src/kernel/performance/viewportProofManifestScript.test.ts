import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateProofManifest,
  validateSourceSnapshotBinding,
  writeProofManifest,
  writeProofManifestToReportRoot,
} from "../../../scripts/lib/proof-manifest.mjs";

const SHA = "a".repeat(64);
const GIT_SHA1 = "d9518082eaee2131c3e7160bd8ae952ed2f45899";
const OTHER_SHA = "b".repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fullmag-viewport-proof-"));
  roots.push(root);
  await writeFile(join(root, "vectors.png"), "proof-image");
  await writeFile(join(root, "adoption.json"), "{}\n");
  return root;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function qualificationManifest() {
  return {
    schemaVersion: "fullmag.viewport-proof.v1",
    proofClass: "qualification",
    outcome: "pass",
    scenarioId: "fdm-regular-airbox-post-stage",
    execution: {
      provider: "github-actions",
      runId: "123456789",
      workflowName: "frontend-3d-contracts",
      jobName: "control-room-contracts",
      headSha: SHA,
      timestampUtc: "2026-08-20T18:00:00.000Z",
      conclusion: "success",
    },
    source: {
      auditBaseCommit: SHA,
      implementationCommit: SHA,
      statusSha256: OTHER_SHA,
      runtimeRelevantDirty: false,
      allowedUnrelatedDirtyPaths: [
        "apps/control-room/next-env.d.ts",
        "external_solvers/3",
      ],
      changedPaths: ["apps/control-room/next-env.d.ts", "external_solvers/3"],
    },
    runtime: {
      lane: "fdm-cpu",
      buildInfoSha256: SHA,
      sourceSnapshotSha256: OTHER_SHA,
      components: [{ path: "fullmag", sha256: SHA, kind: "binary" }],
      managedRecipe: null,
    },
    model: {
      path: "models/fdm-airbox.py",
      sha256: OTHER_SHA,
      fixture: false,
    },
    browser: { name: "chromium", version: "140.0.7339.16" },
    gpu: { vendor: "NVIDIA Corporation", renderer: "NVIDIA RTX A4000" },
    session: {
      sessionId: "session-fdm-proof-001",
      sessionEpoch: "epoch-001",
      startLifecycle: "running",
      endLifecycle: "awaiting_command",
    },
    steps: [
      {
        id: "vectors-only",
        status: "pass",
        quantityId: "H_demag",
        expected: { wireframeVisible: false },
        actual: { glyphCount: 128 },
        artifacts: ["vectors.png", "adoption.json"],
      },
    ],
    artifacts: [
      {
        path: "vectors.png",
        sha256: digest("proof-image"),
        mediaType: "image/png",
      },
      {
        path: "adoption.json",
        sha256: digest("{}\n"),
        mediaType: "application/json",
      },
    ],
    blocker: null as null | { code: string; detail: string },
  };
}

function sourceSnapshot(manifest = qualificationManifest()) {
  return {
    schema: "fullmag.source-snapshot.v2",
    head_commit_full: manifest.source.implementationCommit,
    source_snapshot_sha256: manifest.runtime.sourceSnapshotSha256,
  };
}

describe("viewport proof manifest", () => {
  it("binds the proof to the existing managed source snapshot identity", () => {
    const manifest = qualificationManifest();
    const snapshot = {
      schema: "fullmag.source-snapshot.v2",
      head_commit_full: manifest.source.implementationCommit,
      source_snapshot_sha256: manifest.runtime.sourceSnapshotSha256,
    };

    expect(() => validateSourceSnapshotBinding(manifest, snapshot)).not.toThrow();
    snapshot.source_snapshot_sha256 = SHA;
    expect(() => validateSourceSnapshotBinding(manifest, snapshot)).toThrowError(
      expect.objectContaining({ reasonCode: "source_snapshot_mismatch" }),
    );
  });

  it("accepts a source-bound qualification with unrelated dirty paths", async () => {
    const root = await fixtureRoot();
    const manifest = qualificationManifest();
    manifest.source.auditBaseCommit = GIT_SHA1;
    manifest.source.implementationCommit = GIT_SHA1;
    manifest.execution.headSha = GIT_SHA1;

    await expect(validateProofManifest(manifest, root)).resolves.toBeUndefined();
  });

  it("writes canonical JSON and validates the stored manifest", async () => {
    const root = await fixtureRoot();
    const path = join(root, "viewport-proof-manifest.json");
    const manifest = qualificationManifest();
    await writeFile(
      join(root, "source-snapshot.v2.json"),
      `${JSON.stringify(sourceSnapshot(manifest))}\n`,
    );

    await writeProofManifestToReportRoot(manifest, root);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
  });

  it("rejects a write that is not bound to the report root source snapshot", async () => {
    const root = await fixtureRoot();
    const path = join(root, "viewport-proof-manifest.json");
    const manifest = qualificationManifest();
    const snapshot = sourceSnapshot(manifest);
    snapshot.source_snapshot_sha256 = SHA;

    await expect(writeProofManifest(manifest, path, root, snapshot)).rejects.toMatchObject({
      reasonCode: "source_snapshot_mismatch",
    });
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["fixture qualification", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.model.fixture = true; }, "qualification_fixture_forbidden"],
    ["short commit", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.source.implementationCommit = "abc123"; }, "invalid_sha256"],
    ["uppercase digest", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.source.statusSha256 = "A".repeat(64); }, "invalid_sha256"],
    ["runtime dirty path", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.source.changedPaths.push("apps/control-room/src/app.tsx"); }, "runtime_relevant_dirty"],
    ["invalid execution timestamp", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.execution.timestampUtc = "not-a-timestamp"; }, "invalid_timestamp"],
    ["non-numeric GitHub run ID", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.execution.runId = "run-123"; }, "invalid_execution_identity"],
    ["execution head SHA mismatch", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.execution.headSha = OTHER_SHA; }, "execution_source_mismatch"],
    ["pass with non-success conclusion", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.execution.conclusion = "failure"; }, "execution_outcome_mismatch"],
    ["empty artifact list", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.artifacts = []; }, "artifact_required"],
    ["missing artifact", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.artifacts[0].path = "missing.png"; }, "artifact_missing"],
    ["bad artifact hash", (manifest: ReturnType<typeof qualificationManifest>) => { manifest.artifacts[0].sha256 = SHA; }, "artifact_hash_mismatch"],
  ])("rejects %s", async (_label, mutate, reasonCode) => {
    const root = await fixtureRoot();
    const manifest = qualificationManifest();
    mutate(manifest);

    await expect(validateProofManifest(manifest, root)).rejects.toMatchObject({ reasonCode });
  });

  it("rejects traversal outside artifactRoot", async () => {
    const root = await fixtureRoot();
    const manifest = qualificationManifest();
    manifest.artifacts[0].path = "../vectors.png";

    await expect(validateProofManifest(manifest, root)).rejects.toMatchObject({
      reasonCode: "artifact_path_escape",
    });
  });

  it("rejects a symlink escaping artifactRoot", async () => {
    const root = await fixtureRoot();
    const outside = await mkdtemp(join(tmpdir(), "fullmag-viewport-proof-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "outside.png"), "proof-image");
    await mkdir(join(root, "linked"));
    await symlink(join(outside, "outside.png"), join(root, "linked", "outside.png"));
    const manifest = qualificationManifest();
    manifest.artifacts[0].path = "linked/outside.png";

    await expect(validateProofManifest(manifest, root)).rejects.toMatchObject({
      reasonCode: "artifact_path_escape",
    });
  });

  it("accepts a typed blocked outcome without pretending qualification PASS", async () => {
    const root = await fixtureRoot();
    const manifest = qualificationManifest();
    manifest.proofClass = "blocked";
    manifest.outcome = "blocked";
    manifest.execution.conclusion = "blocked";
    manifest.steps = [];
    manifest.blocker = { code: "browser_unavailable", detail: "No browser bridge" };

    await expect(validateProofManifest(manifest, root)).resolves.toBeUndefined();
  });

  it("rejects blocked proof with a passing execution conclusion", async () => {
    const root = await fixtureRoot();
    const manifest = qualificationManifest();
    manifest.proofClass = "blocked";
    manifest.outcome = "blocked";
    manifest.blocker = { code: "browser_unavailable", detail: "No browser bridge" };

    await expect(validateProofManifest(manifest, root)).rejects.toMatchObject({
      reasonCode: "execution_outcome_mismatch",
    });
  });
});
