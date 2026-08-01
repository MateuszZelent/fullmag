import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("RegionsListPanel region creation wiring", () => {
  it("uses compact Inspector groups without the legacy accordion shell", () => {
    const source = readFileSync(
      new URL("./RegionsListPanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("InspectorGroup");
    expect(source).not.toContain("InspectorSection");
    expect(source).not.toContain("<Accordion");
  });

  it("selects a newly created region from the committed scene response", () => {
    const source = readFileSync(
      new URL("./RegionsListPanel.tsx", import.meta.url),
      "utf8",
    );
    const selectRegionStart = source.indexOf("function selectRegion");
    const createRegionStart = source.indexOf("async function createRegion");
    const renderStart = source.indexOf("\n  return (", createRegionStart);

    expect(selectRegionStart).toBeGreaterThanOrEqual(0);
    expect(createRegionStart).toBeGreaterThan(selectRegionStart);
    expect(renderStart).toBeGreaterThan(createRegionStart);

    const selectRegionSource = source.slice(selectRegionStart, createRegionStart);
    const createRegionSource = source.slice(createRegionStart, renderStart);

    expect(selectRegionSource).toContain("selectionController.set");
    expect(createRegionSource).toContain("findRegionIdByName");
    expect(createRegionSource).toContain("selectRegion({");
    expect(createRegionSource).toContain("syncAuthoringScriptBestEffort(api)");
  });
});
