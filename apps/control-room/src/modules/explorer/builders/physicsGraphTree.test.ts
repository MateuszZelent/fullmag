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
});
