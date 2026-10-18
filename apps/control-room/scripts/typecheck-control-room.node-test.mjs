import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const originalNextEnv = "// Preserve checkout-owned Next declarations.\n";

function fixture({ missingNative = false, missingBin = false, nextExit = 0, tscExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fullmag-typecheck-cli-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  copyFileSync(join(scriptDir, "typecheck-control-room.mjs"), join(scripts, "typecheck-control-room.mjs"));
  writeFileSync(join(root, "next-env.d.ts"), originalNextEnv);
  const typescriptNative = join(root, "node_modules", "typescript-native");
  const typescriptApi = join(root, "node_modules", "typescript");
  const next = join(root, "node_modules", "next");
  if (!missingNative) {
    mkdirSync(join(typescriptNative, "bin"), { recursive: true });
    writeFileSync(join(typescriptNative, "package.json"), JSON.stringify({
      name: "typescript", version: "7.0.2", bin: missingBin ? {} : { tsc: "bin/tsc" },
      exports: { "./package.json": "./package.json" },
    }));
    const record = 'require("node:fs").appendFileSync(process.env.FULLMAG_TYPECHECK_CALLS, JSON.stringify({tool: TOOL, args: process.argv.slice(2)}) + "\\n");';
    writeFileSync(join(typescriptNative, "bin", "tsc"),
      record.replace("TOOL", '"tsc"') + `process.exit(${tscExit});`);
  }
  mkdirSync(join(typescriptApi, "bin"), { recursive: true });
  mkdirSync(join(next, "dist", "bin"), { recursive: true });
  writeFileSync(join(typescriptApi, "package.json"), JSON.stringify({
    name: "typescript", version: "6.0.2", bin: { tsc: "bin/tsc" },
    exports: { "./package.json": "./package.json" },
  }));
  const apiRecord = 'require("node:fs").appendFileSync(process.env.FULLMAG_TYPECHECK_CALLS, JSON.stringify({tool: "typescript-api6", args: process.argv.slice(2)}) + "\\n");';
  writeFileSync(join(typescriptApi, "bin", "tsc"), apiRecord + "process.exit(97);");
  const record = 'require("node:fs").appendFileSync(process.env.FULLMAG_TYPECHECK_CALLS, JSON.stringify({tool: TOOL, args: process.argv.slice(2)}) + "\\n");';
  writeFileSync(join(next, "package.json"), JSON.stringify({ name: "next" }));
  writeFileSync(join(next, "dist", "bin", "next"),
    record.replace("TOOL", '"next"') +
    `require("node:fs").writeFileSync("next-env.d.ts", "generated"); process.exit(${nextExit});`);
  const callsPath = join(root, "calls.jsonl");
  const frontendRoot = join(root, "frontend");
  return {
    root, frontendRoot,
    run() {
      return spawnSync(process.execPath, [join(scripts, "typecheck-control-room.mjs")], {
        cwd: root, encoding: "utf8", env: { ...process.env, FULLMAG_TYPECHECK_CALLS: callsPath, FULLMAG_FRONTEND_ROOT: frontendRoot },
      });
    },
    calls() {
      try { return readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("runs the declared package CLI when compiler subpaths are not exported", () => {
  const f = fixture();
  try {
    const require = createRequire(join(f.root, "scripts", "typecheck-control-room.mjs"));
    assert.throws(() => require.resolve("typescript-native/bin/tsc"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), [
      { tool: "next", args: ["typegen", "."] },
      { tool: "tsc", args: ["--noEmit", "--project", "tsconfig.typecheck.json", "--tsBuildInfoFile", join(f.frontendRoot, "tsbuildinfo", "control-room.tsbuildinfo")] },
    ]);
    assert.equal(readFileSync(join(f.root, "next-env.d.ts"), "utf8"), originalNextEnv);
  } finally { f.cleanup(); }
});

test("restores Next declarations and stops when type generation fails", () => {
  const f = fixture({ nextExit: 7 });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(f.root, "next-env.d.ts"), "utf8"), originalNextEnv);
    assert.deepEqual(f.calls(), [{ tool: "next", args: ["typegen", "."] }]);
  } finally { f.cleanup(); }
});

test("rejects a package without its declared tsc command", () => {
  const f = fixture({ missingBin: true });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /typescript-native package does not declare a tsc command/);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});

test("does not fall back to API TypeScript when the native alias is missing", () => {
  const f = fixture({ missingNative: true });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /typescript-native/);
    assert.deepEqual(f.calls(), []);
    assert.equal(readFileSync(join(f.root, "next-env.d.ts"), "utf8"), originalNextEnv);
  } finally { f.cleanup(); }
});

test("propagates compiler failure after preserving Next declarations", () => {
  const f = fixture({ tscExit: 11 });
  try {
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(f.calls().map(c => c.tool), ["next", "tsc"]);
    assert.equal(readFileSync(join(f.root, "next-env.d.ts"), "utf8"), originalNextEnv);
  } finally { f.cleanup(); }
});
