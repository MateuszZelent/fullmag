import { describe, expect, it } from "vitest";

import { resolveMeshBuildFreshness } from "./meshBuildFreshness";

describe("mesh build freshness", () => {
  it("reports building when the active build is running", () => {
    expect(
      resolveMeshBuildFreshness({
        activeBuild: { status: "running" },
        manifest: { source_scene_revision: 10 },
        sceneRevision: 10,
        statusMeshRevision: 4,
      }).state,
    ).toBe("building");
  });

  it("distinguishes missing, current, stale, failed, and unknown meshes", () => {
    expect(
      resolveMeshBuildFreshness({
        manifest: null,
        sceneRevision: 10,
        statusMeshRevision: 0,
      }).state,
    ).toBe("not-built");

    expect(
      resolveMeshBuildFreshness({
        manifest: { source_scene_revision: 10 },
        sceneRevision: 10,
        statusMeshRevision: 4,
      }).state,
    ).toBe("current");

    expect(
      resolveMeshBuildFreshness({
        manifest: { source_scene_revision: 9 },
        sceneRevision: 10,
        statusMeshRevision: 4,
      }).state,
    ).toBe("stale");

    expect(
      resolveMeshBuildFreshness({
        latestBuild: { source_scene_revision: 10, status: "failed" },
        manifest: { source_scene_revision: 9 },
        sceneRevision: 10,
        statusMeshRevision: 4,
      }).state,
    ).toBe("failed");

    expect(
      resolveMeshBuildFreshness({
        manifest: { revision: 4 },
        sceneRevision: 10,
        statusMeshRevision: 4,
      }).state,
    ).toBe("unknown");
  });
});
