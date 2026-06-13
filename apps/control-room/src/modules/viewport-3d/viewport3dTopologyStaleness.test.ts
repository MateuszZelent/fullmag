import { describe, expect, it } from "vitest";

import {
  isViewport3DTopologyCurrent,
  isViewport3DTopologyRenderable,
  resolveUnavailableTopologyVisualizationSettings,
  resolveUnknownTopologyProvenanceRefreshKey,
  resolveViewport3DTopologyFreshnessLabel,
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

  it("keeps shared-domain topology current after region authoring without mesh dirty tags", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        {
          objects: [
            {
              id: "film",
              regions: [
                {
                  region_id: "film:r1",
                  shape: { height: 2e-9, kind: "cylinder", radius: 50e-9 },
                },
              ],
              tags: ["mesh:ready"],
            },
          ],
          revision: 13,
        },
        { source_scene_revision: 12 },
      ),
    ).toBe("current");
  });

  it("treats clean topology coverage as current while manifest provenance refresh is pending", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        {
          objects: [
            {
              id: "film",
              regions: [
                {
                  region_id: "film:r1",
                  shape: { height: 2e-9, kind: "cylinder", radius: 50e-9 },
                },
              ],
              tags: ["mesh:ready"],
              visible: true,
            },
          ],
          revision: 13,
        },
        {
          mesh_parts: [
            {
              id: "part-film",
              object_id: "film",
              role: "magnetic",
            },
          ],
          revision: 4,
          source_scene_revision: null,
        },
      ),
    ).toBe("current");
  });

  it("keeps clean FDM domain topology current when no shared-domain manifest exists", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        {
          objects: [
            {
              id: "strip",
              regions: [
                {
                  region_id: "strip:r1",
                  shape: { height: 2.5e-9, kind: "cylinder", radius: 8e-9 },
                },
              ],
              tags: ["mesh:ready"],
              visible: true,
            },
          ],
          revision: 3,
        },
        null,
      ),
    ).toBe("current");
  });

  it("keeps loaded FEM domain topology renderable while scene resources are unavailable", () => {
    expect(
      resolveViewport3DTopologyFreshness(
        null,
        null,
        {
          domainMeta: { discretization: "fem" },
          topology: { nodeCount: 76 },
        },
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

  it("keeps stale topology renderable so region authoring preserves the current view", () => {
    expect(isViewport3DTopologyRenderable("current")).toBe(true);
    expect(isViewport3DTopologyRenderable("stale")).toBe(true);
    expect(isViewport3DTopologyRenderable("unknown")).toBe(false);
  });

  it("keeps stale topology on the normal render path", () => {
    const settings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      pointsVisible: true,
      shaderVisible: true,
      vectorsVisible: true,
      wireframeVisible: false,
    };

    expect(isViewport3DTopologyRenderable("stale")).toBe(true);
    expect(settings).toMatchObject({
      pointsVisible: true,
      shaderVisible: true,
      vectorsVisible: true,
      wireframeVisible: false,
    });
  });

  it("renders unavailable topology as an edge ghost without shader, points, or vectors", () => {
    expect(
      resolveUnavailableTopologyVisualizationSettings({
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

  it("surfaces stale topology as explicit viewport HUD status", () => {
    expect(resolveViewport3DTopologyFreshnessLabel("current")).toBeNull();
    expect(resolveViewport3DTopologyFreshnessLabel("stale")).toBe(
      "topology stale",
    );
    expect(resolveViewport3DTopologyFreshnessLabel("unknown")).toBe(
      "topology freshness unknown",
    );
  });

  it("respects hidden targets while resolving unavailable display settings", () => {
    expect(
      resolveUnavailableTopologyVisualizationSettings({
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
