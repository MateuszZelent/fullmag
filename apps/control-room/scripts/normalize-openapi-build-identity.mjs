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
