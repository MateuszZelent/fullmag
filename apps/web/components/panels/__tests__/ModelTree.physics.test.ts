import { describe, expect, it } from "vitest";

import { buildFullmagModelTree, type TreeNodeData } from "../ModelTree";
import type { BackendCapabilities, ScriptBuilderGeometryEntry } from "@/lib/session/types";

function findNode(nodes: TreeNodeData[], id: string): TreeNodeData | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}

const CAPABILITIES: BackendCapabilities = {
  engine_id: "fem_mfem",
  capability_profile_version: "2026-04-18",
  supported_terms: [
    "exchange",
    "demag_poisson_robin",
    "zeeman",
    "interfacial_dmi",
    "uniaxial_anisotropy",
    "boundary_correction",
  ],
  supported_demag_realizations: ["poisson_robin", "poisson_dirichlet"],
  preview_quantities: [],
  snapshot_quantities: [],
  scalar_outputs: [],
  approximate_operators: [],
  supports_lossy_fallback_override: false,
};

const GEOMETRIES: ScriptBuilderGeometryEntry[] = [
  {
    name: "free",
    region_name: "free",
    geometry_kind: "Cylinder",
    geometry_params: { radius: 25e-9, height: 4e-9 },
    material: {
      Ms: 8e5,
      Aex: 1.3e-11,
      alpha: 0.01,
      Dind: 1e-3,
    },
    physics_stack: [
      { kind: "exchange", enabled: true, params: null },
      { kind: "demag", enabled: true, params: null },
    ],
    magnetization: {
      kind: "uniform",
      value: [0, 0, 1],
      seed: null,
      source_path: null,
      source_format: null,
      dataset: null,
      sample_index: null,
    },
    mesh: null,
  },
];

describe("buildFullmagModelTree physics/study structure", () => {
  it("builds dynamic physics modules and stage-only study branch", () => {
    const roots = buildFullmagModelTree({
      backend: "FEM",
      capabilities: CAPABILITIES,
      geometries: GEOMETRIES,
      demagRealization: "poisson_robin",
      exchangeEnabled: true,
      demagEnabled: true,
      zeemanField: [0, 0, 0.02],
      scalarRowCount: 0,
      studyStageStatuses: ["pending"],
    });

    const studyRoot = findNode(roots, "study-root");
    expect(studyRoot).not.toBeNull();

    expect(findNode(studyRoot?.children ?? [], "runtime")).not.toBeNull();

    const studyNode = findNode(studyRoot?.children ?? [], "study");
    expect(studyNode).not.toBeNull();
    expect(findNode(studyNode?.children ?? [], "study-stages")).not.toBeNull();
    expect(findNode(studyNode?.children ?? [], "study-defaults")).toBeNull();

    const physicsNode = findNode(studyRoot?.children ?? [], "physics");
    expect(physicsNode).not.toBeNull();
    expect(findNode(physicsNode?.children ?? [], "physics-solver")).not.toBeNull();
    expect(findNode(physicsNode?.children ?? [], "physics-module-interfacial_dmi")).not.toBeNull();

    const demagNode = findNode(physicsNode?.children ?? [], "physics-module-demag");
    expect(demagNode).not.toBeNull();
    expect(findNode(demagNode?.children ?? [], "physics-module-demag-method")).not.toBeNull();
    expect(findNode(demagNode?.children ?? [], "physics-module-demag-boundary")).not.toBeNull();

    const sotNode = findNode(physicsNode?.children ?? [], "physics-module-spin_orbit_torque");
    expect(sotNode).toBeNull();
  });

  it("shows backend-only interaction only when active in runtime metadata", () => {
    const roots = buildFullmagModelTree({
      backend: "FEM",
      capabilities: CAPABILITIES,
      geometries: GEOMETRIES,
      demagRealization: "poisson_robin",
      exchangeEnabled: true,
      demagEnabled: true,
      metadata: { sot_active: true },
      scalarRowCount: 0,
      studyStageStatuses: ["pending"],
    });

    const physicsNode = findNode(roots, "physics");
    expect(physicsNode).not.toBeNull();
    const sotNode = findNode(physicsNode?.children ?? [], "physics-module-spin_orbit_torque");
    expect(sotNode).not.toBeNull();
    expect(sotNode?.badge).toBe("active · unsupported");
  });

  it("does not show exchange/demag as unsupported when runtime enables them", () => {
    const roots = buildFullmagModelTree({
      backend: "FEM",
      capabilities: null,
      geometries: GEOMETRIES,
      demagRealization: "poisson_robin",
      exchangeEnabled: true,
      demagEnabled: true,
      scalarRowCount: 0,
      studyStageStatuses: ["pending"],
    });

    const physicsNode = findNode(roots, "physics");
    expect(physicsNode).not.toBeNull();
    const exchangeNode = findNode(physicsNode?.children ?? [], "physics-module-exchange");
    const demagNode = findNode(physicsNode?.children ?? [], "physics-module-demag");
    expect(exchangeNode?.badge).toBe("active");
    expect(demagNode?.badge).toBe("active");
  });

  it("does not show zeeman as unsupported when non-zero external field is set", () => {
    const roots = buildFullmagModelTree({
      backend: "FEM",
      capabilities: null,
      geometries: GEOMETRIES,
      zeemanField: [0, 0, 0.02],
      scalarRowCount: 0,
      studyStageStatuses: ["pending"],
    });

    const physicsNode = findNode(roots, "physics");
    expect(physicsNode).not.toBeNull();
    const zeemanNode = findNode(physicsNode?.children ?? [], "physics-module-zeeman");
    expect(zeemanNode?.badge).toBe("active");
  });
});
