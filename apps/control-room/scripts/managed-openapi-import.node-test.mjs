import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceScripts = dirname(fileURLToPath(import.meta.url));
const runRoot = process.env.FULLMAG_FRONTEND_SOURCE_RUN_ROOT;
if (!runRoot || !isAbsolute(runRoot)) {
  throw new Error("Use the managed openapi-import-check route; no temporary storage fallback");
}
const commit = "a".repeat(40);
const snapshot = "b".repeat(64);
const sourceDigest = "c".repeat(64);
let sequence = 0;

function fixture(worktreeState = "clean", inputName = "raw.json") {
  const root = join(runRoot, `import-fixture-${sequence++}`);
  const scripts = join(root, "scripts");
  const output = join(root, "src/kernel/api/generated/openapi-v2.json");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  for (const name of ["generate-openapi-v2.mjs", "normalize-openapi-build-identity.mjs"]) {
    copyFileSync(join(sourceScripts, name), join(scripts, name));
  }
  writeFileSync(output, "previous contract\n");
  const input = join(root, inputName);
  const document = {
    openapi: "3.0.3",
    paths: { "/v2/sessions/current/status": { get: {} } },
    "x-fullmag-build-identity": {
      built_at_utc: "2026-10-03T02:00:00Z",
      git_commit: commit,
      source_snapshot_sha256: snapshot,
      worktree_state: worktreeState,
    },
  };
  writeFileSync(input, JSON.stringify(document));
  return { root, output, input, document, script: join(scripts, "generate-openapi-v2.mjs") };
}

function nativeFixture() {
  const item = fixture("dirty", "openapi-v2.json");
  const receipt = join(item.root, "receipt.json");
  writeFileSync(receipt, JSON.stringify(nativeReceipt(item.input)));
  return { ...item, receipt };
}

function nativeReceipt(inputPath) {
  const rawOpenApiSha256 = createHash("sha256").update(readFileSync(inputPath)).digest("hex");
  return {
    schema: "fullmag.development-backend-api-checks.v1",
    state: "completed",
    exit_code: 0,
    task_id: "task-native-openapi",
    owner: "fixture-owner",
    build_commit: commit,
    build_snapshot_sha256: snapshot,
    source_sha256: "c".repeat(64),
    source_sha256_after: "c".repeat(64),
    verified_build_id: "d".repeat(64),
    api_sha256: "e".repeat(64),
    started_at: "2026-10-03T02:00:00.000000+00:00",
    finished_at: "2026-10-03T02:01:00.000000+00:00",
    checks: ["canonical-codegen-identity"],
    processes: [{ label: "fixture-api", pid: 12345, waited: true, exit_code: 0 }],
    openapi_sha256: rawOpenApiSha256,
  };
}

function invoke(item, input = item.input, extra = []) {
  return spawnSync(process.execPath, [item.script, "--input", input,
    "--expected-commit", commit, "--expected-snapshot", snapshot, ...extra], {
    cwd: item.root, encoding: "utf8", timeout: 10000,
    // There is deliberately no Cargo on the child PATH. Import cannot compile.
    env: { ...process.env, PATH: dirname(process.execPath) },
  });
}

function assertPreserved(item, result, reason) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, reason);
  assert.equal(readFileSync(item.output, "utf8"), "previous contract\n");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function managedSnapshotFixture(worktreeState = "dirty") {
  const item = fixture(worktreeState, "stdout.raw.json");
  const raw = readFileSync(item.input);
  const evidence = {
    state: "succeeded", qualification: "NOT VERIFIED", exit_code: 0,
    job_id: "d".repeat(32), image_digest: `sha256:${"e".repeat(64)}`,
    build_receipt_sha256: "f".repeat(64), source_manifest_sha256: "1".repeat(64),
    raw_openapi_sha256: sha256(raw), stderr_sha256: "2".repeat(64),
    process_started: true, spawn_failed: false, capture_failed: false,
    cleanup_confirmed: true, cleanup_failed: false,
    input_hashes_checked: true, input_hashes_verified: true, input_hash_mismatches: [],
  };
  const receiptDocument = {
    ...evidence, schema: "fullmag.managed-package-openapi.v1", diagnostic_only: true,
    profile: "fem-cpu-release", source_mode: "snapshot", source_commit: commit,
    source_snapshot_sha256: snapshot, source_digest: sourceDigest,
    source_worktree_state: worktreeState, stdout_bytes: raw.length,
    timed_out: false, output_limit_exceeded: false, api_binary_sha256: "3".repeat(64),
    openapi_identity: { ...item.document["x-fullmag-build-identity"] },
  };
  const proofDocument = {
    ...evidence, schema: "fullmag.managed-package-openapi-proof.v1",
    api_binary_sha256: receiptDocument.api_binary_sha256,
    source_identity: { git_commit: commit, source_snapshot_sha256: snapshot, worktree_state: worktreeState },
  };
  const result = { ...item, receipt: join(item.root, "receipt.json"),
    proof: join(item.root, "proof.json"), receiptDocument, proofDocument };
  writeManagedEvidence(result);
  return result;
}

function writeManagedEvidence(item) {
  const receiptBytes = JSON.stringify(item.receiptDocument);
  writeFileSync(item.receipt, receiptBytes);
  item.proofDocument.managed_export_receipt_sha256 = sha256(receiptBytes);
  writeFileSync(item.proof, JSON.stringify(item.proofDocument));
}

function snapshotOptions(item) {
  return ["--managed-snapshot-receipt", item.receipt, "--expected-source-digest", sourceDigest];
}

function dockerFixture(worktreeState = "dirty") {
  const item = fixture(worktreeState, "stdout.raw.json");
  const packageRoot = join(item.root, "package");
  const apiBinary = join(packageRoot, "bin", "fullmag-api");
  const backendBuildReceipt = join(packageRoot, "backend-build-receipt.json");
  mkdirSync(dirname(apiBinary), { recursive: true });
  writeFileSync(apiBinary, Buffer.from("fixture docker api binary\n"));
  writeFileSync(backendBuildReceipt, JSON.stringify({ state: "succeeded" }));
  const assembly = join(item.root, "assembly.json");
  const apiBinarySha256 = sha256(readFileSync(apiBinary));
  const backendBuildReceiptSha256 = sha256(readFileSync(backendBuildReceipt));
  const imageId = `sha256:${"e".repeat(64)}`;
  writeFileSync(assembly, JSON.stringify({
    schema: "fullmag.docker-all-image.v1",
    state: "succeeded",
    exit_code: 0,
    commit,
    source_snapshot_sha256: snapshot,
    source_digest: sourceDigest,
    image_id: imageId,
    package_root: packageRoot,
    backend_build_receipt: backendBuildReceipt,
    build_receipt_sha256: backendBuildReceiptSha256,
    binary_hashes: { "fullmag-api": apiBinarySha256 },
    native_source_identity: {
      schema: "fullmag.source-snapshot.v2",
      head_commit_full: commit,
      source_snapshot_sha256: snapshot,
      source_snapshot_dirty: worktreeState === "dirty",
    },
  }));
  const proof = join(item.root, "proof.json");
  writeFileSync(proof, JSON.stringify({
    schema: "fullmag.direct-package-openapi-export.v1",
    state: "succeeded",
    exit_code: 0,
    assembly,
    input: item.input,
    commit,
    snapshot,
    source_digest: sourceDigest,
    image_id: imageId,
    binary_sha256: apiBinarySha256,
    stdout_sha256: sha256(readFileSync(item.input)),
  }));
  return { ...item, assembly, proof, apiBinary, backendBuildReceipt };
}

function dockerOptions(item) {
  return [
    "--docker-assembly", item.assembly,
    "--docker-export-receipt", item.proof,
    "--expected-source-digest", sourceDigest,
  ];
}

test("managed snapshot receipt binds raw bytes and proof before normalization", () => {
  for (const state of ["clean", "dirty"]) {
    const item = managedSnapshotFixture(state);
    const original = readFileSync(item.input);
    const result = invoke(item, item.input, snapshotOptions(item));
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(readFileSync(item.output, "utf8"));
    assert.deepEqual(published.paths, item.document.paths);
    assert.equal(published["x-fullmag-build-identity"].worktree_state, "generated-artifact");
    assert.deepEqual(readFileSync(item.input), original);
  }
});

test("Docker export binds clean and dirty source identities before normalization", () => {
  for (const state of ["clean", "dirty"]) {
    const item = dockerFixture(state);
    const original = readFileSync(item.input);
    const result = invoke(item, item.input, dockerOptions(item));
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(readFileSync(item.output, "utf8"));
    assert.deepEqual(published.paths, item.document.paths);
    assert.equal(published["x-fullmag-build-identity"].worktree_state, "generated-artifact");
    assert.deepEqual(readFileSync(item.input), original);
  }
});

test("Docker export hashes the package files actually read", () => {
  const binary = dockerFixture();
  writeFileSync(binary.apiBinary, Buffer.from("changed api binary\n"));
  assertPreserved(binary, invoke(binary, binary.input, dockerOptions(binary)), /Docker assembly|Docker export proof/);

  const receipt = dockerFixture();
  writeFileSync(receipt.backendBuildReceipt, JSON.stringify({ state: "changed" }));
  assertPreserved(receipt, invoke(receipt, receipt.input, dockerOptions(receipt)), /Docker assembly|Docker export proof/);
});

test("Docker export requires complete exclusive receipt paths and source pins", () => {
  const item = dockerFixture();
  assertPreserved(item, invoke(item, item.input, ["--docker-assembly", item.assembly]), /mutually required/);
  assertPreserved(item, invoke(item, item.input, [
    "--docker-assembly", item.assembly, "--docker-export-receipt", item.proof,
  ]), /source digest/);
  assertPreserved(item, invoke(item, item.input, [
    ...dockerOptions(item), "--managed-snapshot-receipt", item.proof,
  ]), /mutually exclusive/);
  const otherInput = join(item.root, "other.json");
  copyFileSync(item.input, otherInput);
  assertPreserved(item, invoke(item, otherInput, dockerOptions(item)), /receipt-parent\/stdout\.raw\.json/);
  const noInput = spawnSync(process.execPath, [item.script, ...dockerOptions(item)], {
    cwd: item.root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: dirname(process.execPath) },
  });
  assertPreserved(item, noInput, /requires --input/);
});

test("managed snapshot import rejects altered raw bytes and an unbound receipt", () => {
  const raw = managedSnapshotFixture();
  writeFileSync(raw.input, `${readFileSync(raw.input, "utf8")}\n`);
  assertPreserved(raw, invoke(raw, raw.input, snapshotOptions(raw)), /Managed snapshot/);
  const receipt = managedSnapshotFixture();
  writeFileSync(receipt.receipt, `${readFileSync(receipt.receipt, "utf8")}\n`);
  assertPreserved(receipt, invoke(receipt, receipt.input, snapshotOptions(receipt)), /Managed snapshot/);
});

test("managed snapshot rejects mismatched pins and incomplete success evidence even after rehash", () => {
  const mutations = [
    (r) => { r.source_digest = "4".repeat(64); },
    (r) => { r.source_commit = "4".repeat(40); },
    (r) => { r.source_snapshot_sha256 = "4".repeat(64); },
    (r) => { r.source_mode = "commit"; },
    (r) => { r.source_worktree_state = "clean"; },
    (r) => { r.state = "failed"; },
    (r) => { r.exit_code = 1; },
    (r) => { r.diagnostic_only = false; },
    (r) => { r.timed_out = true; },
    (r) => { r.output_limit_exceeded = true; },
    (r) => { r.input_hashes_verified = false; },
    (r) => { r.input_hash_mismatches = ["api"]; },
    (r) => { r.cleanup_confirmed = false; },
    (r) => { r.spawn_failed = true; },
    (r) => { r.capture_failed = true; },
    (r) => { r.stdout_bytes += 1; },
    (r) => { r.api_binary_sha256 = "not-a-digest"; },
    (r) => { r.openapi_identity.built_at_utc = "2026-10-04T00:00:00Z"; },
  ];
  for (const mutate of mutations) {
    const item = managedSnapshotFixture();
    mutate(item.receiptDocument);
    writeManagedEvidence(item);
    assertPreserved(item, invoke(item, item.input, snapshotOptions(item)), /Managed snapshot/);
  }
});

test("managed snapshot requires a successful matching proof", () => {
  const mutations = [
    (p) => { p.schema = "wrong"; },
    (p) => { p.state = "failed"; },
    (p) => { p.api_binary_sha256 = "4".repeat(64); },
    (p) => { p.raw_openapi_sha256 = "4".repeat(64); },
    (p) => { p.input_hashes_checked = false; },
    (p) => { p.source_identity.worktree_state = "clean"; },
    (p) => { p.source_identity.source_snapshot_sha256 = "4".repeat(64); },
    (p) => { p.managed_export_receipt_sha256 = "4".repeat(64); },
  ];
  for (const mutate of mutations) {
    const item = managedSnapshotFixture();
    mutate(item.proofDocument);
    writeFileSync(item.proof, JSON.stringify(item.proofDocument));
    assertPreserved(item, invoke(item, item.input, snapshotOptions(item)), /Managed snapshot/);
  }
});

test("managed snapshot requires explicit input, full pins and exclusive absolute receipt paths", () => {
  const item = managedSnapshotFixture();
  assertPreserved(item, invoke(item, item.input, ["--managed-snapshot-receipt", item.receipt]), /source digest/);
  assertPreserved(item, invoke(item, item.input, ["--expected-source-digest", sourceDigest]), /snapshot receipt/);
  assertPreserved(item, invoke(item, item.input, ["--managed-snapshot-receipt", "receipt.json", "--expected-source-digest", sourceDigest]), /absolute/);
  assertPreserved(item, invoke(item, item.input, [...snapshotOptions(item), "--native-receipt", item.receipt]), /mutually exclusive/);
  const other = join(item.root, "other.json");
  copyFileSync(item.input, other);
  assertPreserved(item, invoke(item, other, snapshotOptions(item)), /receipt-parent\/stdout\.raw\.json/);
  const noInput = spawnSync(process.execPath, [item.script, ...snapshotOptions(item)], {
    cwd: item.root, encoding: "utf8", timeout: 10000,
    env: { ...process.env, PATH: dirname(process.execPath) },
  });
  assertPreserved(item, noInput, /requires --input/);
});

test("publishes a validated raw export only inside the isolated fixture", () => {
  const item = fixture();
  const result = invoke(item);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(readFileSync(item.output, "utf8"));
  assert.deepEqual(published.paths, item.document.paths);
  assert.equal(published["x-fullmag-build-identity"].git_commit, "generated-artifact");
  assert.equal(JSON.parse(readFileSync(item.input, "utf8"))["x-fullmag-build-identity"].git_commit, commit);
});

test("stale identity and malformed JSON preserve the previous contract", () => {
  const stale = fixture();
  stale.document["x-fullmag-build-identity"].git_commit = "c".repeat(40);
  writeFileSync(stale.input, JSON.stringify(stale.document));
  assertPreserved(stale, invoke(stale), /does not match the expected/);
  const malformed = fixture();
  writeFileSync(malformed.input, "{broken");
  assertPreserved(malformed, invoke(malformed), /SyntaxError/);
});

test("relative paths and directories cannot become import streams", () => {
  const item = fixture();
  assertPreserved(item, invoke(item, "raw.json"), /absolute input/);
  assertPreserved(item, invoke(item, item.root), /bounded regular file/);
});

test("oversized input is refused before publication", () => {
  const item = fixture();
  const handle = openSync(item.input, "w");
  try { ftruncateSync(handle, 64 * 1024 * 1024 + 1); } finally { closeSync(handle); }
  assertPreserved(item, invoke(item), /bounded regular file/);
});

test("a raw export without the required resource is refused", () => {
  const item = fixture();
  item.document.paths = {};
  writeFileSync(item.input, JSON.stringify(item.document));
  assertPreserved(item, invoke(item), /omitted the canonical session status/);
});

test("a completed native receipt admits a matching dirty export before normalization", () => {
  const item = nativeFixture();
  const result = invoke(item, item.input, ["--native-receipt", item.receipt]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(readFileSync(item.output, "utf8"));
  assert.deepEqual(published.paths, item.document.paths);
  assert.equal(published["x-fullmag-build-identity"].git_commit, "generated-artifact");
  assert.equal(JSON.parse(readFileSync(item.input, "utf8"))["x-fullmag-build-identity"].worktree_state, "dirty");
});

test("dirty identity remains rejected by the default import path", () => {
  const item = nativeFixture();
  assertPreserved(item, invoke(item), /expected clean source identity/);
});

test("failed, stale-hash, changed-source and unwaited native receipts preserve output", () => {
  const mutations = [
    (receipt) => { receipt.state = "failed"; },
    (receipt) => { receipt.openapi_sha256 = "f".repeat(64); },
    (receipt) => { receipt.source_sha256_after = "f".repeat(64); },
    (receipt) => { receipt.processes[0].waited = false; },
  ];
  for (const mutate of mutations) {
    const item = nativeFixture();
    const receipt = nativeReceipt(item.input);
    mutate(receipt);
    writeFileSync(item.receipt, JSON.stringify(receipt));
    assertPreserved(
      item,
      invoke(item, item.input, ["--native-receipt", item.receipt]),
      /Native OpenAPI receipt/,
    );
  }
});

test("native receipt requires absolute matching paths and an explicit input", () => {
  const item = nativeFixture();
  assertPreserved(item, invoke(item, item.input, ["--native-receipt", "receipt.json"]), /absolute/);

  const otherInput = join(item.root, "other.json");
  copyFileSync(item.input, otherInput);
  assertPreserved(
    item,
    invoke(item, otherInput, ["--native-receipt", item.receipt]),
    /receipt-parent\/openapi-v2\.json/,
  );

  const noInput = spawnSync(process.execPath, [item.script, "--native-receipt", item.receipt], {
    cwd: item.root,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, PATH: dirname(process.execPath) },
  });
  assertPreserved(item, noInput, /requires --input/);
});

test("direct Compose proof admits a running-service export without Cargo fallback", () => {
  const item = fixture("dirty", "raw.json");
  const proof = join(item.root, "direct-proof.json");
  const raw = readFileSync(item.input);
  writeFileSync(proof, JSON.stringify({
    schema: "fullmag.direct-compose-openapi-codegen.v1",
    state: "succeeded",
    exit_code: 0,
    compose_project: "fullmag-worktree-fixture",
    backend_container_id: "backend-fixture",
    frontend_container_id: "frontend-fixture",
    source_commit: commit,
    source_snapshot_sha256: snapshot,
    source_digest: sourceDigest,
    source_identity: {
      git_commit: commit,
      source_snapshot_sha256: snapshot,
      source_digest: sourceDigest,
      worktree_state: "dirty",
      native_source_identity_sha256: "e".repeat(64),
    },
    backend_build_receipt_sha256: "f".repeat(64),
    backend_provenance_sha256: "1".repeat(64),
    api_binary_sha256: "2".repeat(64),
    raw_openapi_sha256: sha256(raw),
    raw_openapi_bytes: raw.length,
    stderr_sha256: "3".repeat(64),
    stderr_bytes: 0,
    source_probe_live_manifest_sha256: "4".repeat(64),
  }));
  const result = invoke(item, item.input, [
    "--expected-source-digest", sourceDigest,
    "--direct-compose-receipt", proof,
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(item.output, "utf8"))["x-fullmag-build-identity"].git_commit, "generated-artifact");
});
