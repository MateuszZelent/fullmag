import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GENERATED_IDENTITY = Object.freeze({
  built_at_utc: "generated-artifact",
  git_commit: "generated-artifact",
  source_snapshot_sha256: "generated-artifact",
  worktree_state: "generated-artifact",
});

// Check the raw export before normalization removes its source identity.
// Artifact receipt/hash verification remains the responsibility of the caller.
export function validateManagedOpenApiIdentity(document, expectedCommit, expectedSnapshot) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "")) {
    throw new TypeError("Expected commit must be exactly 40 lowercase hexadecimal characters");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSnapshot ?? "")) {
    throw new TypeError("Expected snapshot must be a lowercase SHA-256 identifier");
  }
  const identity = document?.["x-fullmag-build-identity"];
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("Managed OpenAPI export is missing build identity");
  }
  if (identity.git_commit !== expectedCommit ||
      identity.source_snapshot_sha256 !== expectedSnapshot ||
      identity.worktree_state !== "clean" ||
      typeof identity.built_at_utc !== "string" ||
      !Number.isFinite(Date.parse(identity.built_at_utc))) {
    throw new TypeError("Managed OpenAPI export does not match the expected clean source identity");
  }
}

// This path is reserved for the separately verified native API receipt. The
// receipt hash pins the raw OpenAPI bytes before volatile identity fields are
// normalized for checked-in generation.
export function validateNativeOpenApiReceipt(
  document,
  receipt,
  expectedCommit,
  expectedSnapshot,
  inputSha256,
) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "")) {
    throw new TypeError("Expected commit must be exactly 40 lowercase hexadecimal characters");
  }
  if (!/^[a-f0-9]{64}$/.test(expectedSnapshot ?? "")) {
    throw new TypeError("Expected snapshot must be a lowercase SHA-256 identifier");
  }
  if (!/^[a-f0-9]{64}$/.test(inputSha256 ?? "")) {
    throw new TypeError("Raw OpenAPI input digest must be a lowercase SHA-256 identifier");
  }

  const identity = document?.["x-fullmag-build-identity"];
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("Native OpenAPI export is missing build identity");
  }
  if (
    identity.git_commit !== expectedCommit ||
    identity.source_snapshot_sha256 !== expectedSnapshot ||
    !["clean", "dirty"].includes(identity.worktree_state) ||
    !isBuildTimestamp(identity.built_at_utc)
  ) {
    throw new TypeError("Native OpenAPI export does not match the expected source identity");
  }

  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("Native OpenAPI receipt must be an object");
  }
  const sourceSha256 = receipt.source_sha256;
  if (
    receipt.schema !== "fullmag.development-backend-api-checks.v1" ||
    receipt.state !== "completed" ||
    receipt.exit_code !== 0 ||
    receipt.build_commit !== expectedCommit ||
    receipt.build_snapshot_sha256 !== expectedSnapshot ||
    !isSha256(sourceSha256) ||
    receipt.source_sha256_after !== sourceSha256 ||
    !isSha256(receipt.verified_build_id) ||
    !isSha256(receipt.api_sha256) ||
    !Array.isArray(receipt.checks) ||
    receipt.checks.length === 0 ||
    !receipt.checks.every(isNonEmptyString) ||
    !receipt.checks.includes("canonical-codegen-identity") ||
    !Array.isArray(receipt.processes) ||
    receipt.processes.length === 0 ||
    !receipt.processes.every(isWaitedProcess) ||
    !isNonEmptyString(receipt.task_id) ||
    !isNonEmptyString(receipt.owner) ||
    receipt.openapi_sha256 !== inputSha256
  ) {
    throw new TypeError("Native OpenAPI receipt does not prove a completed verified export");
  }

  if (!isNonEmptyString(receipt.started_at) || !isNonEmptyString(receipt.finished_at)) {
    throw new TypeError("Native OpenAPI receipt timestamps are missing");
  }
  const startedAt = Date.parse(receipt.started_at);
  const finishedAt = Date.parse(receipt.finished_at);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(finishedAt) ||
    finishedAt < startedAt
  ) {
    throw new TypeError("Native OpenAPI receipt timestamps are invalid");
  }
}

// Local managed-export evidence is a consistency boundary, not authentication
// against an actor who can rewrite raw bytes, receipt and proof together.
export function validateManagedSnapshotOpenApiReceipt(document, receipt, proof, expected) {
  const { expectedCommit, expectedSnapshot, expectedSourceDigest,
    inputSha256, inputByteLength, receiptSha256 } = expected;
  if (!/^[a-f0-9]{40}$/.test(expectedCommit ?? "") ||
      ![expectedSnapshot, expectedSourceDigest, inputSha256, receiptSha256].every(isSha256) ||
      !Number.isSafeInteger(inputByteLength) || inputByteLength <= 0) {
    throw new TypeError("Managed snapshot requires complete expected source identifiers and raw-byte hashes");
  }
  const identity = document?.["x-fullmag-build-identity"];
  if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
      identity.git_commit !== expectedCommit ||
      identity.source_snapshot_sha256 !== expectedSnapshot ||
      !["clean", "dirty"].includes(identity.worktree_state) ||
      !isBuildTimestamp(identity.built_at_utc)) {
    throw new TypeError("Managed snapshot OpenAPI does not match the expected raw source identity");
  }
  const trueFlags = ["process_started", "cleanup_confirmed", "input_hashes_checked", "input_hashes_verified"];
  const falseFlags = ["spawn_failed", "capture_failed", "cleanup_failed"];
  const sharedFields = ["job_id", "image_digest", "build_receipt_sha256", "source_manifest_sha256",
    "api_binary_sha256", "raw_openapi_sha256", "stderr_sha256", "state", "qualification", "exit_code",
    ...trueFlags, ...falseFlags];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      receipt.schema !== "fullmag.managed-package-openapi.v1" ||
      receipt.state !== "succeeded" || receipt.exit_code !== 0 ||
      receipt.qualification !== "NOT VERIFIED" || receipt.diagnostic_only !== true ||
      receipt.profile !== "fem-cpu-release" || receipt.source_mode !== "snapshot" ||
      receipt.source_commit !== expectedCommit ||
      receipt.source_snapshot_sha256 !== expectedSnapshot ||
      receipt.source_digest !== expectedSourceDigest ||
      receipt.source_worktree_state !== identity.worktree_state ||
      receipt.raw_openapi_sha256 !== inputSha256 || receipt.stdout_bytes !== inputByteLength ||
      receipt.timed_out !== false || receipt.output_limit_exceeded !== false ||
      !trueFlags.every((field) => receipt[field] === true) ||
      !falseFlags.every((field) => receipt[field] === false) ||
      !Array.isArray(receipt.input_hash_mismatches) || receipt.input_hash_mismatches.length !== 0 ||
      !/^[a-f0-9]{32}$/.test(receipt.job_id ?? "") ||
      !/^sha256:[a-f0-9]{64}$/.test(receipt.image_digest ?? "") ||
      ![receipt.build_receipt_sha256, receipt.source_manifest_sha256,
        receipt.api_binary_sha256, receipt.stderr_sha256].every(isSha256) ||
      !["git_commit", "source_snapshot_sha256", "worktree_state", "built_at_utc"].every(
        (field) => receipt.openapi_identity?.[field] === identity[field])) {
    throw new TypeError("Managed snapshot receipt does not prove a successful source-pinned raw export");
  }
  if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      proof.schema !== "fullmag.managed-package-openapi-proof.v1" ||
      proof.managed_export_receipt_sha256 !== receiptSha256 ||
      !sharedFields.every((field) => proof[field] === receipt[field]) ||
      !Array.isArray(proof.input_hash_mismatches) || proof.input_hash_mismatches.length !== 0 ||
      !["git_commit", "source_snapshot_sha256", "worktree_state"].every(
        (field) => proof.source_identity?.[field] === identity[field])) {
    throw new TypeError("Managed snapshot proof is incomplete or does not bind the receipt and raw export");
  }
}

function isBuildTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isWaitedProcess(process) {
  return process !== null && typeof process === "object" && !Array.isArray(process) &&
    Number.isSafeInteger(process.pid) && process.pid > 0 &&
    process.waited === true && isNonEmptyString(process.label);
}

export function normalizeOpenApiBuildIdentity(document) {
  const identity = document?.["x-fullmag-build-identity"];
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new TypeError("x-fullmag-build-identity must be an object");
  }
  for (const field of Object.keys(GENERATED_IDENTITY)) {
    if (typeof identity[field] !== "string" || identity[field].trim() === "") {
      throw new TypeError(
        `x-fullmag-build-identity.${field} must be a non-empty string`,
      );
    }
  }
  document["x-fullmag-build-identity"] = {
    ...identity,
    ...GENERATED_IDENTITY,
  };
}

async function main(path) {
  const document = JSON.parse(await readFile(path, "utf8"));
  normalizeOpenApiBuildIdentity(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv[2]);
}
