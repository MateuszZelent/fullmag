import { describe, expect, it } from "vitest";

import {
  resolveStaleTopologyVisualizationSettings,
  resolveViewport3DTopologyFreshness,
} from "./viewport3dTopologyStaleness";
import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";

describe("viewport3dTopologyStaleness", () => {
  it("marks shared-domain topology stale when manifest provenance lags the scene", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        { revision: 12 },
        { source_scene_revision: 11 },
      ),
    ).toBe("stale");
  });

  it("keeps matching manifest provenance current", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        { revision: 12 },
        { source_scene_revision: 12 },
      ),
    ).toBe("current");
  });

  it("renders stale topology as an edge ghost without shader, points, or vectors", () => {
    expect(
      resolveStaleTopologyVisualizationSettings({
        ...DEFAULT_OBJECT_VISUALIZATION,
        shaderVisible: true,
        wireframeVisible: false,
      }),
    ).toMatchObject({
      pointsVisible: false,
      shaderVisible: false,
      vectorsVisible: false,
      visible: true,
      wireframeVisible: true,
    });
  });

  it("respects hidden targets while resolving stale display settings", () => {
    expect(
      resolveStaleTopologyVisualizationSettings({
        ...DEFAULT_OBJECT_VISUALIZATION,
        visible: false,
      }),
    ).toMatchObject({
      shaderVisible: false,
      visible: false,
      wireframeVisible: false,
    });
  });
});
