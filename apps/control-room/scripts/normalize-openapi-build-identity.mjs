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
