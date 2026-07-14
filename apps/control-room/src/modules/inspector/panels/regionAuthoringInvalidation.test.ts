import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import { MODEL_MATERIAL_PATH } from "@/kernel/api/apiPaths";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { ResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  MODEL_MATERIAL_FIELDS_RESOURCE_KEY,
  MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY,
  MODEL_REGIONS_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  MESH_REGION_MEMBERSHIPS_RESOURCE_KEY,
  FDM_REGION_MEMBERSHIPS_RESOURCE_KEY,
  resolveMeshRegionQualityResourceKey,
  resolveObjectMeshQualityResourceKey,
  resolveObjectTopologyResourceKey,
  resolveObjectMeshReportResourceKey,
} from "@/kernel/resources/geometryLifecycleResources";

import {
  publishRegionAuthoringScene,
  regionMeshInvalidationKeys,
  regionAuthoringInvalidationKeys,
} from "./regionAuthoringInvalidation";

describe("region authoring invalidation", () => {
  it("does not invalidate mesh resources for a clean metadata-only scene", () => {
    expect(
      regionMeshInvalidationKeys({
        objects: [{ id: "film", tags: [], regions: [] }],
        revision: 8,
      }),
    ).toEqual([]);
  });

  it("keeps the latest successful mesh available while marking model resources stale", () => {
    const keys = regionAuthoringInvalidationKeys();

    expect(keys).toContain(SCENE_RESOURCE_KEY);
    expect(keys).toContain(MODEL_REGIONS_RESOURCE_KEY);
    expect(keys).toContain(MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY);
    expect(keys).toContain(MODEL_MATERIAL_FIELDS_RESOURCE_KEY);
    expect(keys).toContain(MODEL_MATERIAL_PATH);
    expect(keys).not.toContain(MESH_BUILD_CURRENT_RESOURCE_KEY);
    expect(keys).not.toContain(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY);
    expect(keys).not.toContain(resolveObjectMeshReportResourceKey("film"));
    expect(keys).not.toContain(resolveObjectMeshQualityResourceKey("film"));
  });

  it("publishes the committed scene immediately for region overlays", () => {
    const resources = new ResourceInvalidationController(
      new EventBus<KernelEventMap>(),
    );
    const runtimeStore = new ResourceRuntimeStore();

    publishRegionAuthoringScene(
      resources,
      {
        objects: [
          {
            id: "film",
            name: "Film",
            regions: [{ name: "core", region_id: "film:r1" } as never],
          },
        ],
        revision: 9,
      },
      9,
      runtimeStore as never,
    );

    expect(resources.getRevision(SCENE_RESOURCE_KEY)).toBe(9);
    expect(resources.getRevision(MODEL_REGIONS_RESOURCE_KEY)).toBe(9);
    expect(runtimeStore.getSnapshot(SCENE_RESOURCE_KEY)).toMatchObject({
      data: {
        objects: [
          {
            id: "film",
            regions: [{ region_id: "film:r1" }],
          },
        ],
        revision: 9,
      },
      status: "ready",
    });
  });

  it("invalidates current mesh and realized membership for dirty objects", () => {
    const scene = {
      objects: [
        {
          id: "film",
          regions: [{ region_id: "film:r1" } as never],
          tags: ["mesh:dirty"],
        },
      ],
      revision: 10,
    };
    const keys = regionMeshInvalidationKeys(scene);

    expect(keys).toContain(MESH_BUILD_CURRENT_RESOURCE_KEY);
    expect(keys).toContain(MESH_REGION_MEMBERSHIPS_RESOURCE_KEY);
    expect(keys).toContain(FDM_REGION_MEMBERSHIPS_RESOURCE_KEY);
    expect(keys).toContain(resolveObjectTopologyResourceKey("film"));
    expect(keys).toContain(resolveObjectMeshQualityResourceKey("film"));
    expect(keys).toContain(resolveMeshRegionQualityResourceKey("film:r1"));
    expect(keys).not.toContain(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY);

    const resources = new ResourceInvalidationController(
      new EventBus<KernelEventMap>(),
    );
    publishRegionAuthoringScene(resources, scene, 10);
    expect(resources.getRevision(MESH_BUILD_CURRENT_RESOURCE_KEY)).toBe(10);
    expect(resources.getRevision(MESH_REGION_MEMBERSHIPS_RESOURCE_KEY)).toBe(10);
    expect(resources.getRevision(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY)).toBeNull();
  });
});
