import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptRoot);
const require = createRequire(import.meta.url);
const workspaceCompilerManifest = require.resolve("typescript/package.json");

function lintSource(source) {
  return spawnSync(process.execPath, [
    resolve(scriptRoot, "run-eslint.mjs"),
    "--format", "json",
    "--max-warnings", "0",
    "--stdin",
    "--stdin-filename", "src/__compiler_api_fixture__.ts",
  ], {
    cwd: appRoot,
    input: source,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
  });
}

test("the real ESLint parser accepts TypeScript while the workspace keeps its compiler", () => {
  const before = readFileSync(workspaceCompilerManifest, "utf8");
  const appManifest = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8"));
  assert.equal(JSON.parse(before).version, appManifest.devDependencies.typescript);
  const result = lintSource("export const compilerApiFixture: number = 1;\n");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fatalErrorCount, 0);
  assert.deepEqual(reports[0].messages, []);
  assert.equal(readFileSync(workspaceCompilerManifest, "utf8"), before);
});

test("the real lint gate still rejects unused TypeScript variables", () => {
  const result = lintSource("const unusedCompilerApiFixture: number = 1;\n");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].fatalErrorCount, 0);
  assert.ok(reports[0].messages.some(
    (message) => message.ruleId === "@typescript-eslint/no-unused-vars",
  ), result.stdout);
});
