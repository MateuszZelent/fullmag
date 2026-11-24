import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = readFileSync(new URL("../src/modules/viewport-3d/viewport3dDiagnostics.ts", import.meta.url), "utf8");
const interpreted = stripTypeScriptTypes(source, { mode: "transform" })
  .replace(/^import[\s\S]*?from ["'][^"']+["'];\s*/gm, "")
  .replaceAll("export ", "");
const Tracker = vm.runInNewContext(interpreted + "\nViewport3DResourceTracker;", {
  recordVisualizationDebugViewportFrame: () => {},
});
const tracker = new Tracker();
let notifications = 0;
const unsubscribe = tracker.subscribe(() => { notifications += 1; });
assert.equal(tracker.getCommittedFrameCount(), 0);
tracker.recordDirtyFrame("camera-fit");
tracker.recordDirtyFrame("canvas-mounted");
assert.equal(tracker.getCommittedFrameCount(), 0, "invalidations are not rendered frames");
tracker.recordDirtyFrame("frame-commit");
tracker.recordDirtyFrame("camera-control-target");
tracker.recordDirtyFrame("frame-commit");
assert.equal(tracker.getCommittedFrameCount(), 2);
assert.equal(notifications, 0, "frame measurement must not trigger React updates");
assert.equal(new Tracker().getCommittedFrameCount(), 0, "each viewport owns its counter");
unsubscribe();
console.log("PASS committed frames: invalidations excluded, commits counted, no subscriptions notified, instance isolation");
