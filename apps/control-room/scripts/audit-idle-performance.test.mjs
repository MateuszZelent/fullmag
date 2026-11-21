import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { runInNewContext } from "node:vm";

const audit = readFileSync(new URL("./audit-idle-performance.mjs", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/modules/viewport-3d/layers/Viewport3DScene.tsx", import.meta.url), "utf8");
const rules = audit.slice(audit.indexOf("function allowsViewport3DDemandFrameOneShots("), audit.indexOf("function isNonProductionSource("));
const allowed = runInNewContext(`${rules}; allowsViewport3DDemandFrameOneShots`, { path });
const nonProductionRules = audit.slice(
  audit.indexOf("function isNonProductionSource("),
  audit.indexOf("function listSourceFiles("),
);
const isNonProductionSource = runInNewContext(
  `${nonProductionRules}; isNonProductionSource`,
);
const viewportScanStart = audit.indexOf(
  "for (const filePath of listSourceFiles(viewportRoot))",
);
const viewportScanEnd = audit.indexOf(
  "\nauditVisualizationDebugIdleContracts();",
  viewportScanStart,
);
const viewportScan = audit.slice(viewportScanStart, viewportScanEnd);
const scenePath = path.join("layers", "Viewport3DScene.tsx");

test("scans production viewport sources without treating test fixtures as runtime", () => {
  assert.match(viewportScan, /if \(isNonProductionSource\(filePath\)\) continue;/);
  assert.equal(
    isNonProductionSource(path.join("layers", "Viewport3DScene.test.ts")),
    true,
  );
  assert.equal(
    isNonProductionSource(path.join("layers", "Viewport3DScene.tsx")),
    false,
  );
  assert.ok(viewportScan.includes('content.includes("requestAnimationFrame(")'));
  assert.ok(viewportScan.includes("allowsViewport3DDemandFrameOneShots(relativePath, content)"));
  assert.ok(viewportScan.includes('content.includes("setInterval(")'));
  assert.ok(viewportScan.includes('content.includes(\'frameloop="always"\')'));
});

test("accepts the current bounded, coalesced scene frame lifecycle", () => {
  assert.equal(allowed(scenePath, source), true);
});

test("rejects an extra frame request and missing cancellation", () => {
  assert.equal(allowed(scenePath, `${source}\nrequestAnimationFrame(loop);`), false);
  assert.equal(allowed(scenePath, source.replace("frameHost.cancelAnimationFrame(frameId)", "undefined")), false);
});

test("requires adoption coalescing, resource scheduling and pointer cleanup", () => {
  for (const contract of [
    'markFrameDirty("resources-updated")',
    'subscribeActive(() => markFrameDirty("render-adoption"))',
    "frameCommitGeneration !== frameCommitGenerationRef.current",
    "frameCommitQueue?.enqueue({ frameState, revision })",
    "inspectClearArbitrator.dispose()",
  ]) {
    assert.ok(source.includes(contract));
    assert.equal(allowed(scenePath, source.replace(contract, "missing_contract")), false, contract);
  }
  const invertedGenerationGuard = source.replace(
    "frameCommitGeneration !== frameCommitGenerationRef.current",
    "frameCommitGeneration === frameCommitGenerationRef.current",
  );
  assert.equal(allowed(scenePath, invertedGenerationGuard), false);
});
