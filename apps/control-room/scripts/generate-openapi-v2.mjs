import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  normalizeOpenApiBuildIdentity,
  validateDockerOpenApiReceipt,
  validateDirectComposeOpenApiReceipt,
  validateManagedOpenApiIdentity,
  validateManagedSnapshotOpenApiReceipt,
  validateNativeOpenApiReceipt,
} from "./normalize-openapi-build-identity.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    "expected-commit": { type: "string" },
    "expected-snapshot": { type: "string" },
    "native-receipt": { type: "string" },
    "managed-snapshot-receipt": { type: "string" },
    "docker-assembly": { type: "string" },
    "docker-export-receipt": { type: "string" },
    "expected-source-digest": { type: "string" },
    "direct-compose-receipt": { type: "string" },
    output: { type: "string" },
  },
  allowPositionals: false,
});
let document;
const snapshotReceipt = values["managed-snapshot-receipt"];
const dockerAssembly = values["docker-assembly"];
const dockerExportReceipt = values["docker-export-receipt"];
const directComposeReceipt = values["direct-compose-receipt"];
if ((dockerAssembly === undefined) !== (dockerExportReceipt === undefined)) {
  throw new Error("Docker assembly and export receipt are mutually required");
}
const receiptModeCount = [
  values["native-receipt"] !== undefined,
  snapshotReceipt !== undefined,
  dockerAssembly !== undefined,
  directComposeReceipt !== undefined,
].filter(Boolean).length;
if (receiptModeCount > 1) {
  throw new Error("Native, managed snapshot, Docker export, and direct Compose receipts are mutually exclusive");
}
if (directComposeReceipt !== undefined && values.input === undefined) {
  throw new Error("A direct Compose receipt requires --input; Cargo fallback is not allowed");
}
if (directComposeReceipt !== undefined && values["expected-source-digest"] === undefined) {
  throw new Error("A direct Compose receipt requires an expected source digest");
}
if (snapshotReceipt !== undefined && values.input === undefined) {
  throw new Error("A managed snapshot receipt requires --input; Cargo fallback is not allowed");
}
if (snapshotReceipt !== undefined && values["expected-source-digest"] === undefined) {
  throw new Error("A managed snapshot receipt requires an expected source digest");
}
if (dockerAssembly !== undefined && values["expected-source-digest"] === undefined) {
  throw new Error("A Docker export receipt requires an expected source digest");
}
if (values["expected-source-digest"] !== undefined &&
    snapshotReceipt === undefined && dockerAssembly === undefined && directComposeReceipt === undefined) {
  throw new Error("An expected source digest requires a managed snapshot receipt; no Cargo fallback");
}
if (values["native-receipt"] !== undefined && values.input === undefined) {
  throw new Error("A native receipt requires --input; Cargo fallback is not allowed");
}
if (dockerAssembly !== undefined && values.input === undefined) {
  throw new Error("A Docker export receipt requires --input; Cargo fallback is not allowed");
}
if (values.input !== undefined) {
  if (!isAbsolute(values.input) || !values["expected-commit"] || !values["expected-snapshot"]) {
    throw new Error("Managed import requires an absolute input and both expected source identifiers");
  }
  const bytes = readBoundedRegularFile(
    values.input,
    64 * 1024 * 1024,
    "Managed OpenAPI input",
  );
  document = JSON.parse(bytes.toString("utf8"));
  const inputSha256 = createHash("sha256").update(bytes).digest("hex");
  if (directComposeReceipt !== undefined) {
    if (!isAbsolute(directComposeReceipt)) {
      throw new Error("Direct Compose receipt path must be absolute");
    }
    const proofBytes = readBoundedRegularFile(
      resolve(directComposeReceipt),
      16 * 1024 * 1024,
      "Direct Compose codegen receipt",
    );
    validateDirectComposeOpenApiReceipt(
      document,
      JSON.parse(proofBytes.toString("utf8")),
      {
        expectedCommit: values["expected-commit"],
        expectedSnapshot: values["expected-snapshot"],
        expectedSourceDigest: values["expected-source-digest"],
        inputSha256,
        inputByteLength: bytes.length,
      },
    );
  } else if (dockerAssembly !== undefined) {
    if (!isAbsolute(dockerAssembly) || !isAbsolute(dockerExportReceipt)) {
      throw new Error("Docker assembly and export receipt paths must be absolute");
    }
    const assemblyPath = resolve(dockerAssembly);
    const proofPath = resolve(dockerExportReceipt);
    if (resolve(values.input) !== resolve(dirname(proofPath), "stdout.raw.json")) {
      throw new Error("Docker export input must be receipt-parent/stdout.raw.json");
    }
    const assemblyBytes = readBoundedRegularFile(
      assemblyPath,
      16 * 1024 * 1024,
      "Docker assembly",
    );
    const proofBytes = readBoundedRegularFile(
      proofPath,
      16 * 1024 * 1024,
      "Docker export receipt",
    );
    const packageRoot = resolve(dirname(assemblyPath), "package");
    const apiBinaryPath = join(packageRoot, "bin", "fullmag-api");
    const backendBuildReceiptPath = join(packageRoot, "backend-build-receipt.json");
    const apiBinarySha256 = hashBoundedRegularFile(
      apiBinaryPath,
      512 * 1024 * 1024,
      "Docker package fullmag-api",
    );
    const backendBuildReceiptBytes = readBoundedRegularFile(
      backendBuildReceiptPath,
      16 * 1024 * 1024,
      "Docker backend build receipt",
    );
    validateDockerOpenApiReceipt(
      document,
      JSON.parse(assemblyBytes.toString("utf8")),
      JSON.parse(proofBytes.toString("utf8")),
      {
        expectedCommit: values["expected-commit"],
        expectedSnapshot: values["expected-snapshot"],
        expectedSourceDigest: values["expected-source-digest"],
        inputSha256,
        inputByteLength: bytes.length,
        inputPath: resolve(values.input),
        assemblyPath,
        packageRoot,
        backendBuildReceiptPath,
        apiBinarySha256,
        backendBuildReceiptSha256: createHash("sha256").update(backendBuildReceiptBytes).digest("hex"),
      },
    );
  } else if (snapshotReceipt !== undefined) {
    if (!isAbsolute(snapshotReceipt)) {
      throw new Error("Managed snapshot receipt path must be absolute");
    }
    const receiptPath = resolve(snapshotReceipt);
    if (resolve(values.input) !== resolve(dirname(receiptPath), "stdout.raw.json")) {
      throw new Error("Managed snapshot input must be receipt-parent/stdout.raw.json");
    }
    const receiptBytes = readBoundedRegularFile(receiptPath, 16 * 1024 * 1024, "Managed snapshot receipt");
    const proofBytes = readBoundedRegularFile(join(dirname(receiptPath), "proof.json"),
      16 * 1024 * 1024, "Managed snapshot proof");
    validateManagedSnapshotOpenApiReceipt(document,
      JSON.parse(receiptBytes.toString("utf8")), JSON.parse(proofBytes.toString("utf8")), {
        expectedCommit: values["expected-commit"],
        expectedSnapshot: values["expected-snapshot"],
        expectedSourceDigest: values["expected-source-digest"],
        inputSha256,
        inputByteLength: bytes.length,
        receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
      });
  } else if (values["native-receipt"] !== undefined) {
    const receiptPath = values["native-receipt"];
    if (!isAbsolute(receiptPath)) {
      throw new Error("Native OpenAPI receipt path must be absolute");
    }
    const resolvedReceiptPath = resolve(receiptPath);
    const expectedInputPath = resolve(dirname(resolvedReceiptPath), "openapi-v2.json");
    if (resolve(values.input) !== expectedInputPath) {
      throw new Error("Native OpenAPI input must be receipt-parent/openapi-v2.json");
    }
    const receiptBytes = readBoundedRegularFile(
      resolvedReceiptPath,
      16 * 1024 * 1024,
      "Native OpenAPI receipt",
    );
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    validateNativeOpenApiReceipt(
      document,
      receipt,
      values["expected-commit"],
      values["expected-snapshot"],
      inputSha256,
    );
  } else {
    validateManagedOpenApiIdentity(document, values["expected-commit"], values["expected-snapshot"]);
  }
} else {
  if (values["expected-commit"] !== undefined || values["expected-snapshot"] !== undefined) {
    throw new Error("Expected source identifiers require an explicit managed input; no Cargo fallback");
  }
  const result = spawnSync(
    "cargo",
    ["run", "--locked", "-p", "fullmag-api", "--features", "openapi-codegen", "--bin", "fullmag-api-openapi"],
    { cwd: appRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`OpenAPI generator failed (${result.status ?? result.signal}); existing contract preserved`);
  }
  document = JSON.parse(result.stdout);
}
if (!document.paths?.["/v2/sessions/current/status"]) {
  throw new Error("OpenAPI generator omitted the canonical session status resource");
}
normalizeOpenApiBuildIdentity(document);
const output = values.output === undefined
  ? join(appRoot, "src/kernel/api/generated/openapi-v2.json")
  : values.output;
if (!isAbsolute(output)) {
  throw new Error("OpenAPI output path must be absolute");
}
const temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
renameSync(temporary, output);

function readBoundedRegularFile(path, limit, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > limit) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const handle = openSync(path, constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size > limit ||
        opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`${label} changed or is not a bounded regular file`);
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(handle, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count !== opened.size) throw new Error(`${label} changed during read`);
    return buffer.subarray(0, count);
  } finally {
    closeSync(handle);
  }
}

function hashBoundedRegularFile(path, limit, label) {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.size > limit) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  const handle = openSync(path, constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(handle);
    if (!sameFileMetadata(metadata, opened)) {
      throw new Error(`${label} changed or is not a bounded regular file`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let remaining = opened.size;
    while (remaining > 0) {
      const count = readSync(handle, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count === 0) throw new Error(`${label} changed during read`);
      hash.update(buffer.subarray(0, count));
      remaining -= count;
    }
    const finished = fstatSync(handle);
    const current = lstatSync(path);
    if (!sameFileMetadata(opened, finished) || !sameFileMetadata(metadata, current)) {
      throw new Error(`${label} changed during read`);
    }
    return hash.digest("hex");
  } finally {
    closeSync(handle);
  }
}

function sameFileMetadata(left, right) {
  return left.isFile() && right.isFile() &&
    left.size === right.size && left.dev === right.dev && left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
