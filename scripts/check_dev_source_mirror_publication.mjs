import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportArgument = process.argv.indexOf("--report-dir");
assert(reportArgument >= 0, "provide a managed --report-dir");
const reportDir = resolve(process.argv[reportArgument + 1]);
const moduleArgument = process.argv.indexOf("--module");
const modulePath = moduleArgument >= 0 ? resolve(process.argv[moduleArgument + 1])
  : join(repo, "apps/control-room/scripts/dev-source-mirror.mjs");
const expectGap = process.argv.includes("--expect-gap");
await fs.mkdir(reportDir, { recursive: true });
const root = await fs.mkdtemp(join(reportDir, "mirror-publication-"));
const child = relative(reportDir, root);
assert(child && !isAbsolute(child) && !child.startsWith(".."), "scratch must remain inside report root");
const source = join(root, "source");
const target = join(root, "target");
const sourceFile = join(source, "src", "ComputeEnvironmentWidget.tsx");
const targetFile = join(target, "src", "ComputeEnvironmentWidget.tsx");
const { mirrorDevSourcesOnce, DevSourceMirror } = await import(pathToFileURL(modulePath).href);
const rename = fs.rename;
const unlink = fs.unlink;
const report = { schema: "fullmag.dev-source-publication-contract.v1", module: modulePath,
  source_sha256: createHash("sha256").update(await fs.readFile(modulePath)).digest("hex"),
  state: "running", checks: [] };
try {
  for (const parent of [source, target]) await fs.mkdir(join(parent, "src"), { recursive: true });
  await fs.writeFile(sourceFile, "export const version = 'earlier';");
  const options = { sourceRoot: source, targetRoot: target, directories: ["src"] };
  await mirrorDevSourcesOnce(options);
  const earlier = await fs.readFile(targetFile, "utf8");
  await fs.writeFile(sourceFile, "export const version = 'updated-source';");
  let attempts = 0;
  let removedTarget = false;
  let missingReads = 0;
  fs.unlink = async (path) => {
    if (resolve(path) === targetFile) removedTarget = true;
    return unlink.call(fs, path);
  };
  fs.rename = async (from, to) => {
    if (resolve(to) !== targetFile) return rename.call(fs, from, to);
    attempts += 1;
    try { await fs.readFile(targetFile); } catch (error) { if (error.code === "ENOENT") missingReads += 1; else throw error; }
    if (attempts === 1) throw Object.assign(new Error("simulated Windows sharing violation"), { code: "EPERM" });
    return rename.call(fs, from, to);
  };
  await mirrorDevSourcesOnce(options);
  assert.equal(await fs.readFile(targetFile, "utf8"), await fs.readFile(sourceFile, "utf8"));
  if (expectGap) {
    assert(removedTarget && missingReads > 0, "baseline did not reproduce a missing imported module");
    report.checks.push({ name: "baseline_missing_import_reproduced", attempts, missingReads });
  } else {
    assert.equal(removedTarget, false, "sharing violation removed the imported target");
    assert.equal(missingReads, 0, "an imported module disappeared during replacement");
    report.checks.push({ name: "transient_sharing_lock_keeps_import_readable", attempts, missingReads });
    const retained = await fs.readFile(targetFile, "utf8");
    await fs.writeFile(sourceFile, "export const version = 'third';");
    fs.rename = async (from, to) => {
      if (resolve(to) === targetFile) throw Object.assign(new Error("persistent sharing lock"), { code: "EPERM" });
      return rename.call(fs, from, to);
    };
    await assert.rejects(mirrorDevSourcesOnce(options));
    assert.equal(await fs.readFile(targetFile, "utf8"), retained, "persistent lock removed last readable source");
    report.checks.push({ name: "persistent_lock_retains_prior_source" });
    fs.rename = rename;
    const mirror = new DevSourceMirror(options);
    const snapshot = await mirror.snapshotSources();
    snapshot.delete("src/ComputeEnvironmentWidget.tsx");
    await mirror.applySnapshot(snapshot, await mirror.snapshotTargets());
    assert.equal(await fs.readFile(targetFile, "utf8"), retained, "stale deletion snapshot removed a source that reappeared");
    await mirror.close();
    report.checks.push({ name: "stale_deletion_does_not_remove_reappeared_source" });
    await mirrorDevSourcesOnce(options);
    assert.equal(await fs.readFile(targetFile, "utf8"), await fs.readFile(sourceFile, "utf8"));
    report.checks.push({ name: "mirror_recovers_after_lock_release" });
    assert(earlier.length > 0);
  }
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  fs.rename = rename;
  fs.unlink = unlink;
  report.finished_at = new Date().toISOString();
  assert.equal(createHash("sha256").update(await fs.readFile(modulePath)).digest("hex"), report.source_sha256,
    "source changed during contract check");
  await fs.writeFile(join(reportDir, expectGap ? "baseline.json" : "publication.json"), JSON.stringify(report, null, 2));
  // This exact mkdtemp child is ours; all mirror handles have been closed.
  assert.equal(await fs.realpath(root), root);
  await fs.rm(root, { recursive: true });
}
console.log(JSON.stringify({ state: report.state, checks: report.checks, report_dir: reportDir }));
