import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  normalizeOpenApiBuildIdentity,
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
    "expected-source-digest": { type: "string" },
  },
  allowPositionals: false,
});
let document;
const snapshotReceipt = values["managed-snapshot-receipt"];
if (snapshotReceipt !== undefined && values["native-receipt"] !== undefined) {
  throw new Error("Native and managed snapshot receipts are mutually exclusive");
}
if (snapshotReceipt !== undefined && values.input === undefined) {
  throw new Error("A managed snapshot receipt requires --input; Cargo fallback is not allowed");
}
if (snapshotReceipt !== undefined && values["expected-source-digest"] === undefined) {
  throw new Error("A managed snapshot receipt requires an expected source digest");
}
if (values["expected-source-digest"] !== undefined && snapshotReceipt === undefined) {
  throw new Error("An expected source digest requires a managed snapshot receipt; no Cargo fallback");
}
if (values["native-receipt"] !== undefined && values.input === undefined) {
  throw new Error("A native receipt requires --input; Cargo fallback is not allowed");
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
  if (snapshotReceipt !== undefined) {
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
        inputSha256: createHash("sha256").update(bytes).digest("hex"),
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
    const inputSha256 = createHash("sha256").update(bytes).digest("hex");
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
const output = join(appRoot, "src/kernel/api/generated/openapi-v2.json");
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
