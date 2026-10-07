import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/ObjectGeneralPanel.tsx"),
  "utf8",
);
const objectVisualizationSource = readFileSync(
  join(process.cwd(), "src/modules/inspector/panels/ObjectVisualizationPanel.tsx"),
  "utf8",
);

describe("ObjectGeneralPanel visualization commands", () => {
  it("routes object colors through the shared visualization command registry", () => {
    expect(source).not.toContain("visualization.patchTarget(");
    expect(source).toContain('"visualization.target.set-primitive-mono-color"');
    expect(source).not.toContain('"visualization.target.set-shader-mono-color"');
    expect(source).toContain('"visualization.target.set-wireframe-color"');
    expect(source).toContain("commands.execute(");
    expect(source).toContain("createCommandContext(\"inspector\"");
  });

  it("keeps primitive and shader colors separate and shares frame commands", () => {
    expect(source).toContain("visualizationSettings.primitiveMonoColor");
    expect(objectVisualizationSource).toContain('"visualization.target.set-shader-mono-color"');
    expect(source).toContain('"visualization.target.set-wireframe-color"');
    expect(objectVisualizationSource).toContain('"visualization.target.set-wireframe-color"');
    expect(source).toContain("displayVisualizationState");
    expect(source).toContain("[VISUALIZATION_STATE_PATH]");
    expect(source).toContain('sourceDetail: "ObjectGeneralPanel"');
  });
});
