import { describe, expect, it, vi } from "vitest";

import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_OBJECT_POLICY_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SUMMARY_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import {
  defaultObjectMeshPolicyResource,
  draftFromObjectMeshPolicyResource,
  objectMeshPolicyDraftDirty,
} from "@/modules/inspector/panels/ObjectMeshPolicyPanelModel";
import { buildMeshJobsModel } from "@/modules/footer/meshJobsModel";
import {
  normalizeMeshBuildPhases,
  resolveMeshBuildTerminalStatus,
} from "@/shared/domain/mesh/meshBuildPhases";
import { resolveMeshBuildFreshness } from "@/shared/domain/mesh/meshBuildFreshness";

describe("MeshBuildLifecycleSmokeScript", () => {
  it("covers no-scene authoring through apply-build, invalidation, and rendered delivery", async () => {
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const invalidated = vi.fn();
    const commands: string[] = [];

    bus.on("resource:invalidated", invalidated);

    expect(
      resolveMeshBuildFreshness({
        activeBuild: null,
        latestBuild: null,
        manifest: null,
        sceneRevision: null,
        statusMeshRevision: 0,
      }).state,
    ).toBe("not-built");

    const objectId = "free-layer";
    const baseDraft = draftFromObjectMeshPolicyResource(
      defaultObjectMeshPolicyResource(objectId),
    );
    const draft = {
      ...baseDraft,
      maximumElementSize: "5e-9",
    };

    expect(objectMeshPolicyDraftDirty(draft, baseDraft)).toBe(true);

    const applyPolicy = vi.fn(async () => {
      resources.invalidate(
        MESHING_OBJECT_POLICY_PATH.replace(
          "{object_id}",
          encodeURIComponent(objectId),
        ),
        2,
      );
      return { ok: true };
    });
    const executeBuild = vi.fn(async () => {
      commands.push("mesh.build-selected");
      bus.emit("mesh:build-submitted", {
        commandId: "cmd-mesh-1",
        objectId,
        reason: "selected-object",
        targetKind: "object_mesh",
      });
      return { ok: true };
    });

    if (objectMeshPolicyDraftDirty(draft, baseDraft)) {
      const applied = await applyPolicy();
      expect(applied.ok).toBe(true);
    }
    await executeBuild();

    expect(applyPolicy.mock.invocationCallOrder[0]).toBeLessThan(
      executeBuild.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(commands).toEqual(["mesh.build-selected"]);

    const phases = normalizeMeshBuildPhases([
      { id: "queued", status: "completed" },
      { id: "scene_snapshot", status: "completed" },
      { id: "geometry_realization", status: "completed" },
      { id: "policy_resolution", status: "completed" },
      { id: "size_field_planning", status: "completed" },
      { id: "gmsh_meshing", progress_percent: 100, status: "completed" },
      { id: "mesh_extraction", status: "completed" },
      { id: "quality_analysis", status: "completed" },
      { id: "resource_publish", status: "completed" },
      { id: "viewport_delivery", status: "completed" },
    ]);
    expect(resolveMeshBuildTerminalStatus(phases)).toBe("completed");

    for (const [resourceKey, revision] of [
      [MESHING_BUILDS_CURRENT_PATH, 57],
      [MESHING_BUILDS_LATEST_SUCCESSFUL_PATH, 57],
      [MESHING_SUMMARY_PATH, 42],
      [MESHING_SHARED_DOMAIN_MANIFEST_PATH, 42],
      [MESHING_SHARED_DOMAIN_QUALITY_PATH, 42],
      [MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH, 42],
      [VISUALIZATION_STATE_PATH, 8],
    ] as const) {
      resources.invalidate(resourceKey, revision);
    }

    expect(invalidated).toHaveBeenCalledWith({
      resourceKey: MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
      revision: 57,
    });
    expect(resources.getRevision(MESHING_SHARED_DOMAIN_MANIFEST_PATH)).toBe(42);

    const manifest = { revision: 42, source_scene_revision: 3 };
    expect(
      resolveMeshBuildFreshness({
        activeBuild: { status: "completed" },
        latestBuild: { source_scene_revision: 3, status: "completed" },
        manifest,
        sceneRevision: 3,
        statusMeshRevision: 42,
      }).state,
    ).toBe("current");

    let viewportConfirmation: { meshRevision: number; rendererId: string } | null =
      null;
    bus.on("mesh:topology-rendered", (event) => {
      viewportConfirmation = {
        meshRevision: Number(event.meshRevision),
        rendererId: event.rendererId,
      };
    });
    bus.emit("mesh:topology-rendered", {
      meshRevision: 42,
      rendererId: "viewport-3d",
    });

    expect(
      buildMeshJobsModel({
        activeBuild: {
          published_resources: {
            mesh_build_revision: 57,
            mesh_revision: 42,
          },
        },
        loadedMeshRevision: 42,
        viewportConfirmation,
      }).viewportRows,
    ).toEqual([
      { label: "Published", value: "42" },
      { label: "Loaded", value: "42" },
      { label: "Rendered", value: "42 via viewport-3d" },
    ]);
  });
});
