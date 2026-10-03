import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeOpenApiBuildIdentity, validateManagedOpenApiIdentity } from "./normalize-openapi-build-identity.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    "expected-commit": { type: "string" },
    "expected-snapshot": { type: "string" },
  },
  allowPositionals: false,
});
let document;
if (values.input !== undefined) {
  if (!isAbsolute(values.input) || !values["expected-commit"] || !values["expected-snapshot"]) {
    throw new Error("Managed import requires an absolute input and both expected source identifiers");
  }
  // Export files and their ancestors are trusted operator-owned artifacts.
  // Never accept a stream or unbounded JSON as a contract input.
  const limit = 64 * 1024 * 1024;
  const metadata = lstatSync(values.input);
  if (!metadata.isFile() || metadata.size > limit) {
    throw new Error("Managed OpenAPI input must be a bounded regular file");
  }
  const handle = openSync(values.input, constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size > limit ||
        opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error("Managed OpenAPI input changed or is not a bounded regular file");
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(handle, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count !== opened.size) throw new Error("Managed OpenAPI input changed during read");
    bytes = buffer.subarray(0, count);
  } finally {
    closeSync(handle);
  }
  document = JSON.parse(bytes.toString("utf8"));
  validateManagedOpenApiIdentity(document, values["expected-commit"], values["expected-snapshot"]);
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
