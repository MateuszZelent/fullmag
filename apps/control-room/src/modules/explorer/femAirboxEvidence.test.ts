import { describe, expect, it } from "vitest";

import type {
  MeshSharedDomainManifestResource,
  MeshSummaryResource,
  MeshUniverseConfigResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { ResourceState } from "@/kernel/resources/resourceState";

import {
  buildModelTree,
  flattenExplorerNodes,
} from "./builders/buildModelTree";
import { resolveCurrentFemAirboxEvidence } from "./femAirboxEvidence";

function resource<T>(
  data: T,
  status: ResourceState<T>["status"] = "ready",
): ResourceState<T> {
  return { data, error: null, revision: 7, status };
}

const scene = resource<SceneResource>({ revision: 12 });
const policy = resource<MeshUniverseConfigResource>({
  config: { hmax: 1e-8 },
  revision: 7,
});
const summary = resource<MeshSummaryResource>({
  effective_airbox_target: { hmax: 1e-8 },
  revision: 7,
});
const manifest = resource<MeshSharedDomainManifestResource>({
  mesh_id: "mesh-7",
  mesh_name: "Shared domain",
  mesh_parts: [{
    boundary_face_count: 0,
    boundary_face_start: 0,
    element_count: 0,
    element_start: 0,
    id: "part:__air__",
    label: "Airbox",
    node_count: 0,
    node_start: 0,
    role: "air",
  }],
  revision: 7,
  source_scene_revision: 12,
  topology_fingerprint: "topology-7",
});

describe("resolveCurrentFemAirboxEvidence", () => {
  it("rejects retained stale policy, summary, and manifest data", () => {
    expect(resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest: { ...manifest, status: "stale" },
      policy: { ...policy, status: "stale" },
      scene,
      summary: { ...summary, status: "stale" },
    })).toEqual({
      authoredPolicy: false,
      realizedCarrier: false,
      resolvedTarget: false,
    });
  });

  it("rejects mesh evidence from another mesh revision", () => {
    expect(resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 8,
      manifest,
      policy,
      scene,
      summary,
    })).toEqual({
      authoredPolicy: false,
      realizedCarrier: false,
      resolvedTarget: false,
    });
  });

  it("keeps a ready current FEM Airbox carrier when scene provenance is stale", () => {
    expect(resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest: resource({ ...manifest.data!, source_scene_revision: 11 }),
      policy,
      scene,
      summary,
    })).toEqual({
      authoredPolicy: true,
      realizedCarrier: true,
      resolvedTarget: true,
    });
  });

  it("accepts only ready evidence matching the current scene and mesh", () => {
    expect(resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest,
      policy,
      scene,
      summary,
    })).toEqual({
      authoredPolicy: true,
      realizedCarrier: true,
      resolvedTarget: true,
    });
  });

  it("adds the real FEM Airbox carrier with unavailable source scene provenance below Universe", () => {
    const airbox = resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest: resource({
        ...manifest.data!,
        source_scene_revision: null,
      }),
      policy,
      scene,
      summary,
    });
    expect(airbox).toEqual({
      authoredPolicy: true,
      realizedCarrier: true,
      resolvedTarget: true,
    });

    const [session] = buildModelTree({
      airbox,
      domainDiscretization: "fem",
      mesh: {
        manifestSourceSceneRevision: null,
        meshName: "Shared domain",
        meshRevision: 7,
        sourceSceneRevision: 12,
      },
    });
    const universe = session?.children?.find((node) => node.id === "model:universe");
    const airboxes = universe?.children?.filter((node) => node.id === "model:airbox");
    const flattened = flattenExplorerNodes([session!]);

    expect(airboxes).toEqual([
      expect.objectContaining({
        id: "model:airbox",
        kind: "airbox.root",
        parentId: "model:universe",
      }),
    ]);
    expect(flattened.map((node) => node.id)).not.toEqual(expect.arrayContaining([
      "model:airbox:multilayer-target",
      "model:universe:grid",
    ]));
    expect(flattened.map((node) => node.kind)).not.toContain("mesh.grid.descriptor");
  });

  it("keeps a realized FEM Airbox stale for an older source scene", () => {
    const airbox = resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest: resource({ ...manifest.data!, source_scene_revision: 11 }),
      policy,
      scene,
      summary,
    });
    const nodes = flattenExplorerNodes(buildModelTree({
      airbox,
      domainDiscretization: "fem",
      mesh: {
        manifestSourceSceneRevision: 11,
        meshName: "Shared domain",
        meshRevision: 7,
        sourceSceneRevision: 12,
      },
    }));

    expect(nodes.find((node) => node.id === "model:airbox")).toMatchObject({
      status: "mesh-stale",
    });
  });

  it("marks a realized FEM Airbox mesh-ready for a matching source scene", () => {
    const airbox = resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest,
      policy,
      scene,
      summary,
    });
    const nodes = flattenExplorerNodes(buildModelTree({
      airbox,
      domainDiscretization: "fem",
      mesh: {
        manifestSourceSceneRevision: 12,
        meshName: "Shared domain",
        meshRevision: 7,
        sourceSceneRevision: 12,
      },
    }));

    expect(nodes.find((node) => node.id === "model:airbox")).toMatchObject({
      status: "mesh-ready",
    });
  });
});
