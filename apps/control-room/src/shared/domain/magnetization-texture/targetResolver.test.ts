import { describe, expect, it } from "vitest";

import type { SceneResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  extractMagnetizationTargetInputFromSelection,
  parseRegionVisualizationTarget,
  resolveMagnetizationTextureTarget,
  sameMagnetizationTextureTarget,
} from "./targetResolver";

const TEST_SCENE = {
  revision: 4,
  objects: [
    {
      id: "disk",
      name: "Disk",
      role: "magnet",
      regions: [
        {
          region_id: "ring",
          name: "Ring",
          enabled: true,
          shape: { kind: "cylinder", radius: 40e-9, height: 5e-9 },
        },
      ],
    },
    {
      id: "cpw",
      name: "CPW feedline",
      role: "antenna",
    },
  ],
} as unknown as SceneResource;

describe("magnetization texture target resolver (P0 MT-02 region-safe matrix)", () => {
  it("resolves object.region, object.region.*, frozen-spins with regionId, and region mesh-part to { kind: 'region' }", () => {
    // 1. object.region
    const regionOverviewSel: Selection = {
      kind: "object.region",
      label: "Ring",
      moduleSource: "explorer",
      nodeId: "model:object:disk:region:ring",
      objectId: "disk",
      ref: {
        kind: "object.region",
        nodeId: "model:object:disk:region:ring",
        objectId: "disk",
        regionId: "ring",
        type: "scene-object",
        visualizationTargetId: "region:disk:ring",
      },
    };
    expect(
      resolveMagnetizationTextureTarget(
        extractMagnetizationTargetInputFromSelection(regionOverviewSel),
        TEST_SCENE,
      ),
    ).toEqual({ kind: "region", objectId: "disk", regionId: "ring" });

    // 2. object.region.mesh (non-texture subnode of a region!)
    const regionMeshSel: Selection = {
      kind: "object.region.mesh",
      label: "Mesh",
      moduleSource: "explorer",
      nodeId: "model:object:disk:region:ring:mesh",
      objectId: "disk",
      ref: {
        kind: "object.region.mesh",
        nodeId: "model:object:disk:region:ring:mesh",
        objectId: "disk",
        regionId: "ring",
        type: "scene-object",
        visualizationTargetId: "region:disk:ring",
      },
    };
    expect(
      resolveMagnetizationTextureTarget(
        extractMagnetizationTargetInputFromSelection(regionMeshSel),
        TEST_SCENE,
      ),
    ).toEqual({ kind: "region", objectId: "disk", regionId: "ring" });

    // 3. object.frozen-spins with regionId
    const frozenSpinsSel = {
      kind: "object.frozen-spins",
      label: "Frozen spins",
      moduleSource: "explorer",
      nodeId: "model:object:disk:frozen-spins:ring",
      objectId: "disk",
      ref: {
        type: "frozen-spins",
        objectId: "disk",
        regionId: "ring",
      },
    } as unknown as Selection;
    expect(
      resolveMagnetizationTargetOrNull(frozenSpinsSel, TEST_SCENE),
    ).toEqual({ kind: "region", objectId: "disk", regionId: "ring" });

    // 4. mesh-part with visualizationTargetId: "region:disk:ring"
    const meshPartSel = {
      kind: "mesh.part",
      label: "Ring mesh part",
      moduleSource: "viewport-3d",
      nodeId: "mesh:part:ring",
      objectId: "disk",
      ref: {
        type: "mesh-part",
        partId: "part-ring",
        objectId: "disk",
        visualizationTargetId: "region:disk:ring",
      },
    } as unknown as Selection;
    expect(parseRegionVisualizationTarget("region:disk:ring")).toEqual({
      objectId: "disk",
      regionId: "ring",
    });
    expect(resolveMagnetizationTargetOrNull(meshPartSel, TEST_SCENE)).toEqual({
      kind: "region",
      objectId: "disk",
      regionId: "ring",
    });
  });

  it("returns null for non-magnetic objects (role: 'antenna')", () => {
    const antennaSel: Selection = {
      kind: "object.root",
      label: "CPW feedline",
      moduleSource: "explorer",
      nodeId: "model:object:cpw",
      objectId: "cpw",
      ref: {
        kind: "object.root",
        nodeId: "model:object:cpw",
        objectId: "cpw",
        type: "scene-object",
        visualizationTargetId: "object:cpw",
      },
    };
    expect(resolveMagnetizationTargetOrNull(antennaSel, TEST_SCENE)).toBeNull();
  });

  it("resolves magnetic object selections without regionId to { kind: 'object' } and compares targets", () => {
    const objTarget = resolveMagnetizationTextureTarget(
      { kind: "object.magnetic-texture", objectId: "disk" },
      TEST_SCENE,
    );
    expect(objTarget).toEqual({ kind: "object", objectId: "disk" });
    expect(
      sameMagnetizationTextureTarget(objTarget, { kind: "object", objectId: "disk" }),
    ).toBe(true);
    expect(
      sameMagnetizationTextureTarget(objTarget, {
        kind: "region",
        objectId: "disk",
        regionId: "ring",
      }),
    ).toBe(false);
  });
});

function resolveMagnetizationTargetOrNull(selection: Selection, scene: SceneResource) {
  return resolveMagnetizationTextureTarget(
    extractMagnetizationTargetInputFromSelection(selection),
    scene,
  );
}
