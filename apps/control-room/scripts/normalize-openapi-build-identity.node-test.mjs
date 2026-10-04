import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOpenApiBuildIdentity,
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
