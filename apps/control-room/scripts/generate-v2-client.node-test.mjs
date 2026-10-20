import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./generate-v2-client.mjs", import.meta.url));

test("client generator accepts volume staging input and output directory", () => {
  const root = mkdtempSync(join(tmpdir(), "fullmag-openapi-client-"));
  const input = join(root, "openapi-v2.json");
  const output = join(root, "generated");
  writeFileSync(input, JSON.stringify({
    paths: { "/v2/sessions/current/status": { get: {} }, "/v2/projects": { get: {} } },
  }));
  const result = spawnSync(process.execPath, [script, "--input", input, "--output-dir", output], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const paths = readFileSync(join(output, "openapi-v2-paths.ts"), "utf8");
  const client = readFileSync(join(output, "openapi-v2-client.ts"), "utf8");
  assert.match(paths, /\/v2\/projects/);
  assert.match(client, /openapi-fetch/);
});
