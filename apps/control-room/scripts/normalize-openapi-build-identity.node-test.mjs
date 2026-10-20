import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOpenApiBuildIdentity,
  validateDockerOpenApiReceipt,
  validateDirectComposeOpenApiReceipt,
  validateManagedOpenApiIdentity,
  validateNativeOpenApiReceipt,
} from "./normalize-openapi-build-identity.mjs";

test("normalizes volatile build identity in generated OpenAPI artifacts", () => {
  const document = {
    info: { title: "Fullmag" },
    "x-fullmag-build-identity": {
      built_at_utc: "2026-08-23T22:15:56Z",
      git_commit: "a".repeat(40),
      source_snapshot_sha256: "unknown",
      worktree_state: "dirty",
      runtime_bundle: "fullmag-api-v2",
    },
  };

  normalizeOpenApiBuildIdentity(document);

  assert.deepEqual(document["x-fullmag-build-identity"], {
    built_at_utc: "generated-artifact",
    git_commit: "generated-artifact",
    source_snapshot_sha256: "generated-artifact",
    worktree_state: "generated-artifact",
    runtime_bundle: "fullmag-api-v2",
  });
});

test("rejects a generated OpenAPI document without build identity", () => {
  assert.throws(
    () => normalizeOpenApiBuildIdentity({ info: { title: "Fullmag" } }),
    /x-fullmag-build-identity must be an object/,
  );
});

test("rejects an incomplete generated OpenAPI build identity", () => {
  assert.throws(
    () =>
      normalizeOpenApiBuildIdentity({
        "x-fullmag-build-identity": {
          built_at_utc: "2026-08-23T22:15:56Z",
          git_commit: "a".repeat(40),
          worktree_state: "dirty",
        },
      }),
    /x-fullmag-build-identity\.source_snapshot_sha256 must be a non-empty string/,
  );
});

function managedDocument() {
  return {
    "x-fullmag-build-identity": {
      built_at_utc: "2026-10-03T02:00:00Z",
      git_commit: "a".repeat(40),
      source_snapshot_sha256: "b".repeat(64),
      worktree_state: "clean",
    },
  };
}

function nativeDocument(worktreeState = "dirty") {
  return {
    "x-fullmag-build-identity": {
      built_at_utc: "2026-10-03T02:00:00Z",
      git_commit: "a".repeat(40),
      source_snapshot_sha256: "b".repeat(64),
      worktree_state: worktreeState,
    },
  };
}

function nativeReceipt() {
  return {
    schema: "fullmag.development-backend-api-checks.v1",
    state: "completed",
    exit_code: 0,
    task_id: "native-api-check",
    owner: "fixture-owner",
    build_commit: "a".repeat(40),
    build_snapshot_sha256: "b".repeat(64),
    source_sha256: "c".repeat(64),
    source_sha256_after: "c".repeat(64),
    verified_build_id: "d".repeat(64),
    api_sha256: "e".repeat(64),
    started_at: "2026-10-03T02:00:00.000000+00:00",
    finished_at: "2026-10-03T02:01:00.000000+00:00",
    checks: ["canonical-codegen-identity"],
    processes: [{ label: "fixture-api", pid: 12345, waited: true }],
    openapi_sha256: "f".repeat(64),
  };
}

function dockerEvidence(worktreeState = "dirty") {
  const document = nativeDocument(worktreeState);
  const inputPath = "/tmp/fullmag-docker/stdout.raw.json";
  const assemblyPath = "/tmp/fullmag-docker/assembly.json";
  const packageRoot = "/tmp/fullmag-docker/package";
  const backendBuildReceiptPath = `${packageRoot}/backend-build-receipt.json`;
  const imageId = `sha256:${"1".repeat(64)}`;
  const apiBinarySha256 = "c".repeat(64);
  const backendBuildReceiptSha256 = "d".repeat(64);
  const assembly = {
    schema: "fullmag.docker-all-image.v1",
    state: "succeeded",
    exit_code: 0,
    commit: "a".repeat(40),
    source_snapshot_sha256: "b".repeat(64),
    source_digest: "e".repeat(64),
    image_id: imageId,
    package_root: packageRoot,
    backend_build_receipt: backendBuildReceiptPath,
    build_receipt_sha256: backendBuildReceiptSha256,
    binary_hashes: { "fullmag-api": apiBinarySha256 },
    native_source_identity: {
      schema: "fullmag.source-snapshot.v2",
      head_commit_full: "a".repeat(40),
      source_snapshot_sha256: "b".repeat(64),
      source_snapshot_dirty: worktreeState === "dirty",
    },
  };
  const proof = {
    schema: "fullmag.direct-package-openapi-export.v1",
    state: "succeeded",
    exit_code: 0,
    assembly: assemblyPath,
    input: inputPath,
    commit: "a".repeat(40),
    snapshot: "b".repeat(64),
    source_digest: "e".repeat(64),
    image_id: imageId,
    binary_sha256: apiBinarySha256,
    stdout_sha256: "f".repeat(64),
  };
  const expected = {
    expectedCommit: "a".repeat(40),
    expectedSnapshot: "b".repeat(64),
    expectedSourceDigest: "e".repeat(64),
    inputSha256: "f".repeat(64),
    inputByteLength: 123,
    inputPath,
    assemblyPath,
    packageRoot,
    backendBuildReceiptPath,
    apiBinarySha256,
    backendBuildReceiptSha256,
  };
  return { document, assembly, proof, expected };
}

test("accepts only the exact clean managed source identity before normalization", () => {
  const document = managedDocument();
  validateManagedOpenApiIdentity(document, "a".repeat(40), "b".repeat(64));
  assert.equal(document["x-fullmag-build-identity"].git_commit, "a".repeat(40));
  normalizeOpenApiBuildIdentity(document);
  assert.throws(() => validateManagedOpenApiIdentity(document, "a".repeat(40), "b".repeat(64)));
});

test("rejects stale commits, wrong snapshots and dirty exports without modifying identity", () => {
  for (const changes of [
    { git_commit: "c".repeat(40) },
    { source_snapshot_sha256: "c".repeat(64) },
    { worktree_state: "dirty" },
    { built_at_utc: "generated-artifact" },
  ]) {
    const document = managedDocument();
    Object.assign(document["x-fullmag-build-identity"], changes);
    const before = structuredClone(document);
    assert.throws(() => validateManagedOpenApiIdentity(document, "a".repeat(40), "b".repeat(64)));
    assert.deepEqual(document, before);
  }
});

test("requires full expected source identifiers and complete raw identity", () => {
  assert.throws(() => validateManagedOpenApiIdentity(managedDocument(), "abc", "b".repeat(64)));
  const unsupported = managedDocument();
  unsupported["x-fullmag-build-identity"].git_commit = "a".repeat(64);
  assert.throws(() => validateManagedOpenApiIdentity(unsupported, "a".repeat(64), "b".repeat(64)));
  assert.throws(() => validateManagedOpenApiIdentity(managedDocument(), "a".repeat(40), "unknown"));
  assert.throws(() => validateManagedOpenApiIdentity({}, "a".repeat(40), "b".repeat(64)));
});

test("accepts dirty native identity only with a completed source-pinned receipt", () => {
  const receipt = nativeReceipt();
  validateNativeOpenApiReceipt(
    nativeDocument("clean"),
    receipt,
    "a".repeat(40),
    "b".repeat(64),
    "f".repeat(64),
  );
  const document = nativeDocument();
  validateNativeOpenApiReceipt(
    document,
    receipt,
    "a".repeat(40),
    "b".repeat(64),
    "f".repeat(64),
  );
  normalizeOpenApiBuildIdentity(document);
  assert.equal(document["x-fullmag-build-identity"].git_commit, "generated-artifact");
});

test("native receipt requires nonempty checks and waited positive-pid process evidence", () => {
  for (const mutate of [
    (receipt) => { receipt.checks = [""]; },
    (receipt) => { receipt.processes = [{ label: "fixture-api", pid: 0, waited: true }]; },
    (receipt) => { receipt.processes = [{ label: "", pid: 12345, waited: true }]; },
  ]) {
    const receipt = nativeReceipt();
    mutate(receipt);
    assert.throws(() => validateNativeOpenApiReceipt(
      nativeDocument(), receipt, "a".repeat(40), "b".repeat(64), "f".repeat(64),
    ));
  }
});

test("Docker receipt binds source, image, package hashes and successful terminal evidence", () => {
  for (const state of ["clean", "dirty"]) {
    const evidence = dockerEvidence(state);
    validateDockerOpenApiReceipt(
      evidence.document,
      evidence.assembly,
      evidence.proof,
      evidence.expected,
    );
  }

  for (const mutate of [
    (evidence) => { evidence.assembly.image_id = `sha256:${"2".repeat(64)}`; },
    (evidence) => { evidence.assembly.binary_hashes["fullmag-api"] = "2".repeat(64); },
    (evidence) => { evidence.proof.exit_code = 1; },
    (evidence) => { evidence.assembly.native_source_identity.source_snapshot_dirty = false; },
  ]) {
    const evidence = dockerEvidence();
    mutate(evidence);
    assert.throws(
      () => validateDockerOpenApiReceipt(
        evidence.document,
        evidence.assembly,
        evidence.proof,
        evidence.expected,
      ),
      /Docker (assembly|export proof)/,
    );
  }
});


function directEvidence() {
  const document = nativeDocument("dirty");
  const expected = {
    expectedCommit: "a".repeat(40),
    expectedSnapshot: "b".repeat(64),
    expectedSourceDigest: "c".repeat(64),
    inputSha256: "d".repeat(64),
    inputByteLength: 321,
  };
  const proof = {
    schema: "fullmag.direct-compose-openapi-codegen.v1",
    state: "succeeded",
    exit_code: 0,
    compose_project: "fullmag-worktree-example",
    backend_container_id: "backend-container-id",
    frontend_container_id: "frontend-container-id",
    source_commit: expected.expectedCommit,
    source_snapshot_sha256: expected.expectedSnapshot,
    source_digest: expected.expectedSourceDigest,
    source_identity: {
      git_commit: expected.expectedCommit,
      source_snapshot_sha256: expected.expectedSnapshot,
      source_digest: expected.expectedSourceDigest,
      worktree_state: "dirty",
      native_source_identity_sha256: "e".repeat(64),
    },
    backend_build_receipt_sha256: "f".repeat(64),
    backend_provenance_sha256: "1".repeat(64),
    api_binary_sha256: "2".repeat(64),
    raw_openapi_sha256: expected.inputSha256,
    raw_openapi_bytes: expected.inputByteLength,
    stderr_sha256: "3".repeat(64),
    stderr_bytes: 0,
    source_probe_live_manifest_sha256: "4".repeat(64),
  };
  return { document, proof, expected };
}

test("accepts direct Compose codegen proof and rejects source or raw-byte drift", () => {
  const evidence = directEvidence();
  validateDirectComposeOpenApiReceipt(evidence.document, evidence.proof, evidence.expected);
  for (const mutate of [
    (item) => { item.raw_openapi_sha256 = "5".repeat(64); },
    (item) => { item.source_identity.worktree_state = "clean"; },
    (item) => { item.source_digest = "7".repeat(64); },
  ]) {
    const changed = structuredClone(evidence.proof);
    mutate(changed);
    assert.throws(() => validateDirectComposeOpenApiReceipt(
      evidence.document, changed, evidence.expected,
    ), /Direct Compose codegen proof/);
  }
});
