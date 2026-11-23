import { describe, expect, it } from "vitest";

import { selectionFromExplorerNode } from "../explorerSelection";
import type { ExplorerNode } from "../explorerTypes";
import { buildFieldDrivesNode } from "./modelRootNodes";
import { buildObjectExplorerNode } from "./objectExplorerNodes";

function flattenNodes(nodes: readonly ExplorerNode[]): ExplorerNode[] {
  const out: ExplorerNode[] = [];
  const visit = (node: ExplorerNode) => {
    out.push(node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  };
  for (const n of nodes) visit(n);
  return out;
}

describe("Wave 4 Explorer Node Builders (Tasks 13, 15, 16, 17)", () => {
  it("replaces object.magnetic-parameters with unified object.material + object.physics and preserves clean texture leaves", () => {
    const objectNode = buildObjectExplorerNode(
      {
        id: "strip-1",
        label: "Permalloy Strip",
        geometryKind: "Box",
        material: "py",
        materialLabel: "Permalloy",
        hasAbsorbingBoundary: true,
        magnetization: "vortex",
        magnetizationKind: "preset_texture",
        meshStatus: "mesh-ready",
        physicsInteractions: [
          {
            id: "exchange",
            label: "Exchange",
            enabledCount: 1,
            objectCount: 1,
          },
          {
            id: "uniaxial_anisotropy",
            label: "Uniaxial Anisotropy",
            enabledCount: 1,
            objectCount: 1,
          },
        ],
        regions: [
          {
            id: "reg-core",
            label: "Core",
            enabled: true,
            source: "authored",
            materialOverrideCount: 2,
            materialFieldCount: 1,
            meshPolicyActive: true,
            textureOverrideActive: false,
          },
        ],
        materialFields: [
          {
            id: "field-ms",
            label: "Ms (A/m)",
            regionId: "reg-core",
          },
        ],
      },
      {},
      null,
    );

    const flat = flattenNodes([objectNode]);
    const kinds = flat.map((n) => n.kind);

    // Redundant object.magnetic-parameters branch is removed
    expect(kinds).not.toContain("object.magnetic-parameters");

    // Direct Material, Absorbing Boundary, Magnetic Texture, and unified Physics exist
    expect(flat.find((n) => n.id === "model:object:strip-1:material")).toMatchObject({
      kind: "object.material",
      label: "Material",
      badge: "Permalloy",
      status: "ready",
    });
    expect(
      flat.find((n) => n.id === "model:object:strip-1:absorbing-boundary"),
    ).toMatchObject({
      kind: "object.absorbing-boundary",
      label: "Absorbing Boundary",
    });
    expect(flat.find((n) => n.id === "model:object:strip-1:physics")).toMatchObject({
      kind: "object.physics",
      label: "Physics",
      selectable: true,
    });

    // Task 9 magnetic texture leaf cleanup is preserved 100%
    const objTex = flat.find((n) => n.id === "model:object:strip-1:magnetic-texture");
    expect(objTex).toMatchObject({
      kind: "object.magnetic-texture",
      icon: "compass",
    });
    expect(objTex?.children).toBeUndefined();

    // Region children are clean: no .geometry, .regions degraded stub, .diagnostics, or field grandchildren
    expect(kinds).not.toContain("object.region.geometry");
    expect(kinds).not.toContain("object.region.regions");
    expect(kinds).not.toContain("object.region.diagnostics");

    const regMat = flat.find(
      (n) => n.id === "model:object:strip-1:regions:reg-core:magnetic-parameters",
    );
    expect(regMat).toMatchObject({
      kind: "object.region.magnetic-parameters",
      label: "Material",
    });
    expect(regMat?.children).toBeUndefined();

    const regTex = flat.find(
      (n) => n.id === "model:object:strip-1:regions:reg-core:texture",
    );
    expect(regTex).toMatchObject({
      kind: "object.region.texture",
      badge: "Inherited",
      icon: "compass",
      status: "ready",
    });
  });

  it("builds selectable physics.field-drives collection node with child physics.field-drive items", () => {
    const node = buildFieldDrivesNode([
      {
        id: "sinc-1",
        label: "Sinc Pulse",
        driveKind: "regional",
        enabled: true,
        waveformKind: "sinc_pulse",
      },
    ]);
    expect(node).toMatchObject({
      id: "model:physics:field-drives",
      kind: "physics.field-drives",
      parentId: "model:session",
      selectable: true,
    });
    expect(node?.children).toHaveLength(1);
    expect(node?.children?.[0]).toMatchObject({
      kind: "physics.module",
      physicsModuleId: "sinc-1",
      physicsModuleKind: "regional_field_drive",
      physicsScopeKind: "global",
    });
    expect(selectionFromExplorerNode(node!.children![0]!)).toMatchObject({
      kind: "physics.field-drive",
      ref: {
        fieldDriveId: "sinc-1",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:sinc-1",
        type: "physics-field-drive",
      },
    });
  });
});
