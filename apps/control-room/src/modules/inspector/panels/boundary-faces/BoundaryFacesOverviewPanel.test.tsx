import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const panelMocks = vi.hoisted(() => ({
  manifest: { data: null as unknown, status: "idle" as string },
  scene: { data: null as unknown, status: "idle" as string },
  topologyMatches: true,
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useMeshSharedDomainManifestResource: () => panelMocks.manifest,
  useSceneResource: () => panelMocks.scene,
}));

vi.mock("../airbox/airboxInspectorRuntimeStatus", () => ({
  matchesAirboxTopologyIdentity: () => panelMocks.topologyMatches,
  shouldLoadAirboxMeshManifest: () => true,
  useAirboxInspectorRuntimeStatus: () => ({}),
}));

import { BoundaryFacesOverviewPanel } from "./BoundaryFacesOverviewPanel";

function renderPanel() {
  return renderToStaticMarkup(
    <BoundaryFacesOverviewPanel selection={null as never} />,
  );
}

describe("BoundaryFacesOverviewPanel", () => {
  beforeEach(() => {
    panelMocks.manifest = {
      data: {
        source_scene_revision: 7,
        mesh_parts: [{ boundary_face_count: 12, role: "outer_boundary" }],
      },
      status: "ready",
    };
    panelMocks.scene = { data: { revision: 7 }, status: "ready" };
    panelMocks.topologyMatches = true;
  });

  it("shows carrier facts only for a current FEM manifest and scene", () => {
    const markup = renderPanel();

    expect(markup).toContain("realized");
    expect(markup).toContain(">12<");
  });

  it.each([
    ["stale manifest", "stale", 7, true],
    ["source-scene revision mismatch", "ready", 8, true],
    ["FEM topology identity mismatch", "ready", 7, false],
  ] as const)(
    "hides positive carrier facts when %s",
    (_reason, manifestStatus, sceneRevision, topologyMatches) => {
      panelMocks.manifest = {
        data: {
          source_scene_revision: 7,
          mesh_parts: [{ boundary_face_count: 12, role: "outer_boundary" }],
        },
        status: manifestStatus,
      };
      panelMocks.scene = { data: { revision: sceneRevision }, status: "ready" };
      panelMocks.topologyMatches = topologyMatches;

      const markup = renderPanel();

      expect(markup).toContain("unavailable");
      expect(markup).not.toContain(">12<");
    },
  );
});
