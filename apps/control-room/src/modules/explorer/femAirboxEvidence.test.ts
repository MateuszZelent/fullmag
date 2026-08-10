import { describe, expect, it } from "vitest";

import type {
  MeshSharedDomainManifestResource,
  MeshSummaryResource,
  MeshUniverseConfigResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { ResourceState } from "@/kernel/resources/resourceState";

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
    id: "airbox",
    label: "Airbox",
    node_count: 0,
    node_start: 0,
    role: "airbox",
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

  it("rejects mesh evidence from another mesh or scene identity", () => {
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

    expect(resolveCurrentFemAirboxEvidence({
      currentMeshRevision: 7,
      manifest: resource({ ...manifest.data!, source_scene_revision: 11 }),
      policy,
      scene,
      summary,
    })).toEqual({
      authoredPolicy: true,
      realizedCarrier: false,
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
});
