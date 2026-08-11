import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const smokeScriptUrl = new URL(
  "../../../scripts/smoke-inspector.mjs",
  import.meta.url,
);

describe("explorer Inspector browser smoke script", () => {
  it("qualifies the dedicated routing matrix and viewport lifecycle", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");

    expect(smokeScript).toContain('page.route("**/v2/**"');
    expect(smokeScript).toContain("installInspectorFixtureApi");
    expect(smokeScript).toContain("model:airbox:visualization");
    expect(smokeScript).toContain("model:object:film:visualization");
    expect(smokeScript).toContain("model:mesh:unassigned:orphan-part");
    expect(smokeScript).toContain(
      "model:object:film:visualization:mode-visualization",
    );
    expect(smokeScript).toContain("data-inspector-owner");
    expect(smokeScript).toContain("ArrowRight");
    expect(smokeScript).toContain("Inspect response point 7");
    expect(smokeScript).toContain("Open sample 0 mode 2");
    expect(smokeScript).toContain('press("Space")');
    expect(smokeScript).toContain('press("Enter")');
    expect(smokeScript).toContain("isContextLost");
    expect(smokeScript).toContain("drawingBufferWidth");
    expect(smokeScript).toContain("drawingBufferHeight");
    expect(smokeScript).toContain("[360, 416, 560]");
    expect(smokeScript).toContain("No placeholder");
  });
});
