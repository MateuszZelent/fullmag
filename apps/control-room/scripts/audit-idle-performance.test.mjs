import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const audit = readFileSync(new URL("./audit-idle-performance.mjs", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/modules/viewport-3d/layers/Viewport3DScene.tsx", import.meta.url), "utf8");
const rules = audit.slice(audit.indexOf("function allowsViewport3DDemandFrameOneShots("), audit.indexOf("function isNonProductionSource("));
const allowed = runInNewContext(`${rules}; allowsViewport3DDemandFrameOneShots`, { path });
const scenePath = path.join("layers", "Viewport3DScene.tsx");

test("accepts the current bounded, coalesced scene frame lifecycle", () => {
  assert.equal(allowed(scenePath, source), true);
});

test("rejects an extra frame request and missing cancellation", () => {
  assert.equal(allowed(scenePath, `${source}\nrequestAnimationFrame(loop);`), false);
  assert.equal(allowed(scenePath, source.replace("frameHost.cancelAnimationFrame(frameId)", "undefined")), false);
});

test("requires adoption coalescing, resource scheduling and pointer cleanup", () => {
  for (const contract of [
    "frameIdRef.current !== null ||",
    'scheduleFrame("resources-updated")',
    "inspectClearArbitrator.dispose()",
  ]) {
    assert.ok(source.includes(contract));
    assert.equal(allowed(scenePath, source.replace(contract, "missing_contract")), false, contract);
  }
});
