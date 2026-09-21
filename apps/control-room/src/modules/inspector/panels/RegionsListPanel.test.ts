import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readSource(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

describe("RegionsListPanel region creation wiring", () => {
  it("passes the resolved discretization lane into the regions model", () => {
    const source = readSource(new URL("./RegionsListPanel.tsx", import.meta.url));

    expect(source).toContain("useSessionStatusSelector(");
    expect(source).toContain("resolveMeshInspectorLane(sessionDiscretization)");
    expect(source).toContain("regionDiagnostics.data ?? null,\n        meshLane,");
  });

  it("uses compact Inspector groups without the legacy accordion shell", () => {
    const source = readSource(new URL("./RegionsListPanel.tsx", import.meta.url));

    expect(source).toContain("InspectorGroup");
    expect(source).not.toContain("InspectorSection");
    expect(source).not.toContain("<Accordion");
  });

  it("selects a newly created region from the committed scene response", () => {
    const source = readSource(new URL("./RegionsListPanel.tsx", import.meta.url));
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
