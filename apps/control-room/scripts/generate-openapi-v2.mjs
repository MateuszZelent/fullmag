import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOpenApiBuildIdentity } from "./normalize-openapi-build-identity.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "cargo",
  ["run", "--locked", "-p", "fullmag-api", "--features", "openapi-codegen", "--bin", "fullmag-api-openapi"],
  { cwd: appRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`OpenAPI generator failed (${result.status ?? result.signal}); existing contract preserved`);
}
const document = JSON.parse(result.stdout);
if (!document.paths?.["/v2/sessions/current/status"]) {
  throw new Error("OpenAPI generator omitted the canonical session status resource");
}
normalizeOpenApiBuildIdentity(document);
const output = join(appRoot, "src/kernel/api/generated/openapi-v2.json");
const temporary = `${output}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
renameSync(temporary, output);
