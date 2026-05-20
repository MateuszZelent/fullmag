import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/ObjectVisualizationPanel.tsx"),
  "utf8",
);

describe("ObjectVisualizationPanel performance contracts", () => {
  it("debounces range-field commits and flushes them at interaction boundaries", () => {
    expect(panelSource).toContain("VISUALIZATION_NUMBER_COMMIT_DELAY_MS");
    expect(panelSource).toContain("window.setTimeout(");
    expect(panelSource).toContain("flushDraft,");
    expect(panelSource).toContain("onPointerUp={flushDraft}");
    expect(panelSource).toContain("onKeyUp={flushDraft}");
    expect(panelSource).toContain("onBlur={flushDraft}");
  });
});
