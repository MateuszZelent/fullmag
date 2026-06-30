import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const smokeScript = readFileSync(
  new URL("../../../../scripts/smoke-study-authoring-ui.mjs", import.meta.url),
  "utf8",
);

describe("study authoring smoke script", () => {
  it("asserts current FMR modal spectrum headings", () => {
    expect(smokeScript).toContain(
      '[data-inspector-surface="fmr-modal-spectrum"]',
    );
    expect(smokeScript).toContain("FMR Modal Spectrum Control");
    expect(smokeScript).toContain("FMR Modal Spectrum Chart");
    expect(smokeScript).not.toContain('name: "Modal Spectrum"');
  });

  it("reports Explorer row selection state after smoke clicks", () => {
    expect(smokeScript).toContain("assertExplorerRowSelected");
    expect(smokeScript).toContain('aria-selected="true"');
    expect(smokeScript).toContain("Explorer row did not become selected");
  });
});
