import { describe, expect, it } from "vitest";

import { resolveVisualizationTopologyFreshness } from "./visualizationDisplayResolution";

describe("resolveVisualizationTopologyFreshness", () => {
  it("treats primitive-only scenes without manifest coverage as unknown topology", () => {
    expect(
      resolveVisualizationTopologyFreshness(
        {
          revision: 3,
          objects: [{ id: "film", visible: true }],
        },
        {
          revision: 1,
          mesh_parts: [],
        },
      ),
    ).toBe("unknown");
  });

  it("accepts topology without source revision only when the manifest covers visible objects", () => {
    expect(
      resolveVisualizationTopologyFreshness(
        {
          revision: 3,
          objects: [{ id: "film", visible: true }],
        },
        {
          revision: 1,
          mesh_parts: [{ id: "part-1", object_id: "film" }],
        },
      ),
    ).toBe("current");
  });
});
