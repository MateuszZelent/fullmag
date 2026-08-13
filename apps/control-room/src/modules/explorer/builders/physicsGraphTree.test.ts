import { describe, expect, it } from "vitest";

import type { ExplorerNode } from "../explorerTypes";
import { buildPhysicsGraphTree } from "./physicsGraphTree";

const graph = {
  schema_version: "physics_graph.v1",
  modules: [
    {
      id: "current:film",
      kind: "current_transport",
      applies_to: [{ kind: "object", object_id: "film" }],
      depends_on: [],
      activation: "active",
      capability: "semantic_only",
    },
    {
      id: "spin:film",
      kind: "spin_transport",
      applies_to: [{ kind: "object", object_id: "film" }],
      depends_on: ["current:film"],
      activation: "active",
      capability: "semantic_only",
    },
    {
      id: "torque:free-layer",
      kind: "spin_torque",
      presentation: { family: "slonczewski", label: "Slonczewski STT" },
      applies_to: [{ kind: "region", object_id: "film", region_id: "free" }],
      depends_on: ["spin:film"],
      activation: "active",
      capability: "semantic_only",
    },
    {
      id: "oersted:film",
      kind: "oersted_field",
      applies_to: [{ kind: "object", object_id: "film" }],
      depends_on: ["current:film"],
      activation: "active",
      capability: "semantic_only",
    },
    {
      id: "field:global",
      kind: "regional_field_drive",
      applies_to: [{ kind: "global" }],
      depends_on: [],
      activation: "active",
      capability: "reference_executable",
    },
    {
      id: "interface:stack",
      kind: "spin_interface",
      applies_to: [{ kind: "cross_object", object_ids: ["film", "lead"] }],
      depends_on: ["spin:film"],
      activation: "active",
      capability: "semantic_only",
    },
  ],
  edges: [],
} as const;

function flatten(nodes: readonly ExplorerNode[]): ExplorerNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])]);
}

describe("buildPhysicsGraphTree", () => {
  it("keeps the zero-current racetrack transport graph object-scoped with semantic labels", () => {
    const nodes = flatten(buildPhysicsGraphTree({
      graph: {
        schema_version: "physics_graph.v1",
        modules: [
          {
            activation: "inactive",
            applies_to: [{ kind: "object", object_id: "racetrack" }],
            capability: "semantic_only",
            id: "charge:racetrack",
            kind: "current_transport",
          },
          {
            activation: "inactive",
            applies_to: [{ kind: "object", object_id: "racetrack" }],
            capability: "semantic_only",
            depends_on: ["charge:racetrack"],
            id: "spin:racetrack",
            kind: "spin_transport",
          },
          {
            activation: "inactive",
            applies_to: [{ kind: "cross_object", object_ids: ["heavy-metal", "racetrack"] }],
            capability: "semantic_only",
            depends_on: ["spin:racetrack"],
            id: "interface:hm-fm",
            kind: "spin_interface",
          },
          {
            activation: "inactive",
            applies_to: [{ kind: "object", object_id: "racetrack" }],
            capability: "semantic_only",
            depends_on: ["spin:racetrack"],
            id: "torque:racetrack",
            kind: "spin_torque",
          },
        ],
        edges: [],
      },
      objects: [
        { id: "heavy-metal", label: "Heavy metal" },
        { id: "racetrack", label: "Racetrack" },
      ],
    }));

    expect(nodes.filter((node) => node.kind === "physics.scope.global")).toHaveLength(0);
    expect(nodes.find((node) => node.physicsModuleId === "charge:racetrack")).toMatchObject({
      label: "Charge transport · charge:racetrack",
      parentId: "model:object:racetrack:physics",
      status: "degraded",
    });
    expect(nodes.find((node) => node.physicsModuleId === "spin:racetrack")).toMatchObject({
      label: "Spin transport · spin:racetrack",
      parentId: "model:object:racetrack:physics",
    });
    expect(nodes.find((node) => node.physicsModuleId === "interface:hm-fm")).toMatchObject({
      label: "HM/FM interface · interface:hm-fm",
      parentId: "model:physics:cross-object",
    });
    expect(nodes.find((node) => node.physicsModuleId === "torque:racetrack")).toMatchObject({
      label: "Transport torque · torque:racetrack",
      parentId: "model:object:racetrack:physics",
    });
  });

  it("places object-local, global and cross-object modules under stable scope branches", () => {
    const nodes = flatten(
      buildPhysicsGraphTree({
        graph,
        objects: [
          { id: "film", label: "Film" },
          { id: "lead", label: "Lead" },
        ],
      }),
    );

    expect(nodes.find((node) => node.id === "model:physics:global")).toMatchObject({
      kind: "physics.scope.global",
    });
    expect(nodes.find((node) => node.id === "model:object:film:physics")).toMatchObject({
      kind: "object.physics.scope",
      objectId: "film",
    });
    expect(nodes.find((node) => node.id === "model:physics:cross-object")).toMatchObject({
      kind: "physics.scope.cross-object",
    });
    expect(nodes.find((node) => node.physicsModuleId === "torque:free-layer")).toMatchObject({
      label: "Slonczewski STT",
      parentId: "model:object:film:physics",
      physicsModuleFamily: "slonczewski",
      regionId: "free",
      status: "unavailable",
    });
    expect(nodes.find((node) => node.physicsModuleId === "interface:stack")).toMatchObject({
      parentId: "model:physics:cross-object",
      status: "unavailable",
    });
  });

  it("preserves blocked dependent modules from the authoritative graph", () => {
    const nodes = flatten(
      buildPhysicsGraphTree({
        graph: {
          schema_version: "physics_graph.v1",
          modules: [
            {
              id: "spin:stale",
              kind: "spin_transport",
              applies_to: [{ kind: "object", object_id: "film" }],
              depends_on: ["current:missing"],
              activation: "blocked",
              capability: "semantic_only",
            },
            {
              id: "oersted:stale",
              kind: "oersted_field",
              applies_to: [{ kind: "global" }],
              depends_on: ["current:missing"],
              activation: "blocked",
              capability: "semantic_only",
            },
          ],
          edges: [],
        },
      }),
    );

    expect(nodes.filter((node) => node.kind === "physics.module")).toEqual([
      expect.objectContaining({
        physicsModuleId: "oersted:stale",
        physicsActivation: "blocked",
        status: "validation-blocked",
      }),
      expect.objectContaining({
        physicsModuleId: "spin:stale",
        physicsActivation: "blocked",
        status: "validation-blocked",
      }),
    ]);
  });

  it("keeps module identity stable when input order changes", () => {
    const reversed = { ...graph, modules: [...graph.modules].reverse() };
    const first = flatten(buildPhysicsGraphTree({ graph }));
    const second = flatten(buildPhysicsGraphTree({ graph: reversed }));
    expect(second.map((node) => node.id)).toEqual(first.map((node) => node.id));
  });

  it("adds typed closed-geometry closure and source-cut children to the current module", () => {
    const nodes = flatten(buildPhysicsGraphTree({
      currentTransports: {
        items: [{
          boundaries: [],
          coupling: "one_way",
          domain: [{ object_id: "ring" }],
          gauge: "zero_mean",
          kind: "current_transport",
          materials: [],
          model: "ohmic_poisson",
          name: "current:film",
          solver: {
            engine: "cg",
            linear: { absolute_tolerance: 1e-14, max_iterations: 1000, relative_tolerance: 1e-10 },
            operator_version: "fv_charge_harmonic_source_cut_v1",
            physical_residual_version: "charge_balance_integrated_l2.v1",
          },
          structured_current_closure: {
            closure_id: "ring-closure",
            kind: "closed_geometry",
            schema_version: "structured_current_closure.v1",
            source_cuts: [{
              circuit_id: "ring-circuit",
              drive: { drive_id: "ring-drive", kind: "impressed_potential_jump", potential_jump_V: 0.125, schema_version: "impressed_potential_jump.v1" },
              plane: { axis: "y", normal: "positive_axis", offset_m: 2e-9 },
              region: { object_id: "ring", region_id: "source-arm" },
              source_cut_id: "ring-cut",
            }],
          },
        }],
        scene_revision: 7,
      },
      graph,
      objects: [{ id: "film", label: "Film" }],
    }));

    expect(nodes.find((node) => node.kind === "physics.structured-current-closure")).toMatchObject({
      currentTransportId: "current:film",
      label: "ring-closure",
      status: "unavailable",
      structuredCurrentClosureId: "ring-closure",
    });
    expect(nodes.find((node) => node.kind === "physics.structured-current-source-cut")).toMatchObject({
      badge: "Y · 2 nm · 0.125 V",
      currentTransportId: "current:film",
      label: "ring-cut",
      structuredCurrentSourceCutId: "ring-cut",
    });
  });
});
