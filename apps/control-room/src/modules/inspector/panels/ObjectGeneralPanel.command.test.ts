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
    expect(source).toContain('"visualization.target.set-shader-mono-color"');
    expect(source).toContain('"visualization.target.set-wireframe-color"');
    expect(source).toContain("commands.execute(");
    expect(source).toContain("createCommandContext(\"inspector\"");
  });

  it("uses the same color command ids and optimistic resource context as visualization", () => {
    for (const commandId of [
      "visualization.target.set-shader-mono-color",
      "visualization.target.set-wireframe-color",
    ]) {
      expect(source).toContain(`"${commandId}"`);
      expect(objectVisualizationSource).toContain(`"${commandId}"`);
    }
    expect(source).toContain("displayVisualizationState");
    expect(source).toContain("[VISUALIZATION_STATE_PATH]");
    expect(source).toContain('sourceDetail: "ObjectGeneralPanel"');
  });
});
