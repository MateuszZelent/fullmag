import { describe, expect, it } from "vitest";

import { resolveArtifactAssessment } from "./artifactAssessment";

describe("artifactAssessment", () => {
  it("resolves not-built presence when no mesh manifest is available", () => {
    const assessment = resolveArtifactAssessment({
      manifest: null,
      sceneRevision: 10,
      statusMeshRevision: 0,
    });
    expect(assessment.presence).toBe("not-built");
    expect(assessment.state).toBeNull();
    expect(assessment.runAllowed).toBe(false);
  });

  it("resolves current when manifest source scene revision exactly matches scene", () => {
    const assessment = resolveArtifactAssessment({
      manifest: { source_scene_revision: 10 },
      sceneRevision: 10,
      statusMeshRevision: 4,
    });
    expect(assessment.presence).toBe("present");
    expect(assessment.state).toBe("current");
    expect(assessment.runAllowed).toBe(true);
  });

  it("honors current scene validation independently of immutable build provenance", () => {
    const manifest = { source_scene_revision: 8, validated_for_scene_revision: 10 };

    expect(resolveArtifactAssessment({ manifest, sceneRevision: 10, statusMeshRevision: 4 }))
      .toMatchObject({ state: "current", runAllowed: true });
    expect(resolveArtifactAssessment({ manifest, sceneRevision: 11, statusMeshRevision: 4 }))
      .toMatchObject({ state: "stale", runAllowed: false });
    expect(resolveArtifactAssessment({ manifest, sceneRevision: 9, statusMeshRevision: 4 }))
      .toMatchObject({ state: "inconsistent", runAllowed: false });
  });

  it("resolves stale when manifest source scene revision is older than scene", () => {
    const assessment = resolveArtifactAssessment({
      manifest: { source_scene_revision: 9 },
      sceneRevision: 10,
      statusMeshRevision: 4,
    });
    expect(assessment.presence).toBe("present");
    expect(assessment.state).toBe("stale");
    expect(assessment.runAllowed).toBe(false);
  });

  it("resolves inconsistent when manifest source scene revision is ahead of scene (F19)", () => {
    const assessment = resolveArtifactAssessment({
      manifest: { source_scene_revision: 11 },
      sceneRevision: 10,
      statusMeshRevision: 4,
    });
    expect(assessment.presence).toBe("present");
    expect(assessment.state).toBe("inconsistent");
    expect(assessment.runAllowed).toBe(false);
  });

  it("resolves loading when active build is running", () => {
    const assessment = resolveArtifactAssessment({
      activeBuild: { status: "running" },
      manifest: { source_scene_revision: 10 },
      sceneRevision: 10,
      statusMeshRevision: 4,
    });
    expect(assessment.presence).toBe("present");
    expect(assessment.state).toBe("loading");
    expect(assessment.runAllowed).toBe(false);
  });
});
