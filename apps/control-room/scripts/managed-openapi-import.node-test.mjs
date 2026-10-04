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
