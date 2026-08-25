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
    expect(smokeScript).toContain("results:run:inspector-run");
    expect(smokeScript).toContain("result_manifest");
    expect(smokeScript).not.toContain('expandInspectorNode(page, "results:frequency-domain"');
    expect(smokeScript).toContain("ArrowRight");
    expect(smokeScript).toContain("Plot this response field with phase-rotated real display");
    expect(smokeScript).toContain("response-fields");
    expect(smokeScript).toContain("Mode visualization Plot 3D action is disabled");
    expect(smokeScript).toContain("physics-first-frequency-points-416.png");
    expect(smokeScript).toContain("physics-first-response-fields-416.png");
    expect(smokeScript).toContain("physics-first-dispersion-relation-416.png");
    expect(smokeScript).toContain("physics-first-mode-branches-416.png");
    expect(smokeScript).toContain('fixture.analysisProduct = "modal_eigen"');
    expect(smokeScript).toContain('"Analysis Views"');
    expect(smokeScript).toContain('"Derived Values"');
    expect(smokeScript).toContain('"Tables"');
    expect(smokeScript).toContain('"Exports"');
    expect(smokeScript).toContain("mode-visualization-phase-controls-416.png");
    expect(smokeScript).toContain("Loop mode phase animation");
    expect(smokeScript).toContain('press("Space")');
    expect(smokeScript).toContain('press("Enter")');
    expect(smokeScript).toContain("isContextLost");
    expect(smokeScript).toContain("drawingBufferWidth");
    expect(smokeScript).toContain("drawingBufferHeight");
    expect(smokeScript).toContain("qualifyVisualizationMutationStability");
    expect(smokeScript).toContain("visualizationPatchDelayMs");
    expect(smokeScript).toContain("getAnimations({ subtree: true })");
    expect(smokeScript).toContain("Visualization Inspector remounted during mutation");
    expect(smokeScript).toContain("unrelated visibility control was disabled");
    expect(smokeScript).toContain("mutation changed Inspector opacity");
    expect(smokeScript).toContain("mutation changed Inspector scroll position");
    expect(smokeScript).toContain("mutation lost control focus");
    expect(smokeScript).toContain("qualifyMagneticTextureMutationStability");
    expect(smokeScript).toContain("model:object:film:magnetic-texture:asset");
    expect(smokeScript).toContain("Magnetic Texture Inspector remounted during mutation");
    expect(smokeScript).toContain("unrelated Asset label control was disabled");
    expect(smokeScript).toContain("Magnetic Texture mutation changed Inspector opacity");
    expect(smokeScript).toContain("Magnetic Texture mutation changed Inspector scroll position");
    expect(smokeScript).toContain("Magnetic Texture mutation lost control focus");
    expect(smokeScript).toContain("fullmag.react.render.InspectorModule");
    expect(smokeScript).toContain("Magnetic texture request budget");
    expect(smokeScript).toContain("mutation budget: 20");
    expect(smokeScript).toContain("[360, 416, 560]");
    expect(smokeScript).toContain('document.body.style.zoom = "200%"');
    expect(smokeScript).toContain("visualization-overview-zoom-200.png");
    expect(smokeScript).toContain("Inspector overflows at 200% zoom");
    expect(smokeScript).toContain("No placeholder");
    expect(smokeScript).toContain("INSPECTOR_REQUEST_LIMITS");
    expect(smokeScript).toContain("unknownGetPaths");
    expect(smokeScript).toContain("unknownMutationPaths");
    expect(smokeScript).toContain("inspector_fixture_unknown_resource");
    expect(smokeScript).toContain("inspector_fixture_unknown_mutation");
    expect(smokeScript).not.toContain(
      "return fulfillJson(route, { revision: fixture.revision });",
    );
  });
});
