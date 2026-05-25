import { describe, expect, it } from "vitest";

import {
  isViewport3DTopologyCurrent,
  resolveStaleTopologyVisualizationSettings,
  resolveUnknownTopologyProvenanceRefreshKey,
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

  it("keeps shared-domain topology current if no objects are dirty or building even if manifest provenance lags", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        {
          objects: [
            { id: "box", tags: ["mesh:ready"] }
          ],
          revision: 12,
        },
        { source_scene_revision: 11 },
      ),
    ).toBe("current");
  });

  it("keeps matching manifest provenance current", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        { revision: 12 },
        { source_scene_revision: 12 },
      ),
    ).toBe("current");
  });

  it("only allows full field rendering for topology proven current", () => {
    expect(isViewport3DTopologyCurrent("current")).toBe(true);
    expect(isViewport3DTopologyCurrent("stale")).toBe(false);
    expect(isViewport3DTopologyCurrent("unknown")).toBe(false);
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

  it("requests one manifest refresh when loaded topology provenance is unknown", () => {
    expect(
      resolveUnknownTopologyProvenanceRefreshKey(
        { revision: 12 },
        { revision: 4, source_scene_revision: null },
      ),
    ).toBe("12:4");
    expect(
      resolveUnknownTopologyProvenanceRefreshKey(
        { revision: 12 },
        { revision: 4, source_scene_revision: 12 },
      ),
    ).toBeNull();
  });
});
