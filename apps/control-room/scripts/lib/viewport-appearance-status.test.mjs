import assert from "node:assert/strict";
import { test } from "vitest";
import { parseViewportEffectStatuses } from "./viewport-appearance-browser-qa.mjs";

test("keeps quantitative protection reasons behind readable effect labels", () => {
  const reason = "Quantitative field colors are protected";
  assert.deepEqual(parseViewportEffectStatuses([
    `Ambient occlusion: requested, inactive — ${reason}.`,
    `Bloom: requested, inactive — ${reason}.`,
  ]), { ambientOcclusion: reason, bloom: reason });
});
test("preserves browser disable punctuation and effective state", () => {
  const reason = "Post-processing is disabled by browser configuration.";
  assert.deepEqual(parseViewportEffectStatuses([
    `Ambient occlusion: requested, inactive — ${reason}.`,
    "Bloom: requested, effective.",
  ]), { ambientOcclusion: reason, bloom: "effective" });
});
test("does not mistake missing status controls for absent quantitative data", () => {
  assert.throws(() => parseViewportEffectStatuses(["Bloom: requested, inactive."]), /omitted Ambient occlusion or Bloom/);
});
