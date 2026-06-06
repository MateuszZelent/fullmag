import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
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
  resolveObjectMeshQualityResourceKey,
  resolveObjectMeshReportResourceKey,
} from "@/kernel/resources/geometryLifecycleResources";

import {
  publishRegionAuthoringScene,
  regionAuthoringInvalidationKeys,
} from "./regionAuthoringInvalidation";

describe("region authoring invalidation", () => {
  it("keeps the latest successful mesh available while marking model resources stale", () => {
    const keys = regionAuthoringInvalidationKeys();

    expect(keys).toContain(SCENE_RESOURCE_KEY);
    expect(keys).toContain(MODEL_REGIONS_RESOURCE_KEY);
    expect(keys).toContain(MODEL_REGION_DIAGNOSTICS_RESOURCE_KEY);
    expect(keys).toContain(MODEL_MATERIAL_FIELDS_RESOURCE_KEY);
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
});
