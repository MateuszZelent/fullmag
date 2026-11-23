import { describe, expect, it } from "vitest";

import {
  buildGeometryTreeExplorerNodes,
  parseCompositeGeometry,
} from "./geometryTreeExplorerNodes";
import { buildObjectsRootNode } from "./modelRootNodes";
import { buildObjectExplorerNode } from "./objectExplorerNodes";

describe("Explorer Geometry Tree & model:objects context menu (Etap B)", () => {
  it("parses canonical operands for Difference/Union/Intersection/Xor and legacy base/tool Difference", () => {
    const canonical = parseCompositeGeometry({
      geometry_kind: "Difference",
      geometry_params: {
        operands: [
          {
            enabled: true,
            geometry: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
            label: "Film",
            operand_id: "base_1",
          },
          {
            enabled: false,
            geometry: { geometry_kind: "Cylinder", geometry_params: { height: 2e-8, radius: 1e-8 } },
            label: "Via hole",
            operand_id: "hole_1",
          },
        ],
      },
    });
    expect(canonical.op).toBe("subtract");
    expect(canonical.operands).toHaveLength(2);
    expect(canonical.operands[0]).toMatchObject({ operandId: "base_1", role: "base", roleBadge: "Base" });
    expect(canonical.operands[1]).toMatchObject({ enabled: false, operandId: "hole_1", role: "subtract", roleBadge: "− Subtract" });

    const legacy = parseCompositeGeometry({
      geometry_kind: "Difference",
      geometry_params: {
        base: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        tool: { geometry_kind: "Sphere", geometry_params: { radius: 2e-8 } },
      },
    });
    expect(legacy.operands.map((op) => op.operandId)).toEqual(["base", "tool"]);
    expect(legacy.operands.every((op) => op.enabled)).toBe(true);

    const legacyAB = parseCompositeGeometry({
      geometry_kind: "Intersection",
      geometry_params: {
        a: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        b: { geometry_kind: "Cylinder", geometry_params: { height: 2e-8, radius: 3e-8 } },
      },
    });
    expect(legacyAB.op).toBe("intersect");
    expect(legacyAB.operands.map((op) => op.operandId)).toEqual(["a", "b"]);

    const legacyLeftRight = parseCompositeGeometry({
      geometry_kind: "Xor",
      geometry_params: {
        left: { geometry_kind: "Box", geometry_params: { size: [1e-7, 1e-7, 1e-8] } },
        right: { geometry_kind: "Sphere", geometry_params: { radius: 2e-8 } },
      },
    });
    expect(legacyLeftRight.op).toBe("xor");
    expect(legacyLeftRight.operands.map((op) => op.operandId)).toEqual(["left", "right"]);
  });

  it("parses SlicePlane and builds recursive Geometry Tree nodes attached under object:geometry", () => {
    const sliced = {
      geometry_kind: "SlicePlane",
      geometry_params: {
        child: {
          geometry_kind: "Union",
          geometry_params: {
            operands: [
              { enabled: true, geometry: { geometry_kind: "Box" }, label: "Arm A", operand_id: "a" },
              { enabled: true, geometry: { geometry_kind: "Box" }, label: "Arm B", operand_id: "b" },
            ],
          },
        },
        keep_side: "positive",
        plane_normal: [1, 0, 0],
        plane_origin_m: [0, 0, 0],
      },
    };

    const nodes = buildGeometryTreeExplorerNodes("obj_1", "model:object:obj_1:geometry", sliced);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: "object.geometry.node",
      operandId: "slice-child",
    });
    expect(nodes[0]?.children?.map((child) => child.operandId)).toEqual(["a", "b"]);

    const objectNode = buildObjectExplorerNode({
      geometry: sliced,
      geometryKind: "SlicePlane",
      id: "obj_1",
      label: "Sliced Cross",
    });
    const geomNode = objectNode.children?.find((child) => child.kind === "object.geometry");
    expect(geomNode?.children).toHaveLength(1);
    expect(geomNode?.children?.[0]?.kind).toBe("object.geometry.node");
  });

  it("exposes primitive creation context commands on model:objects root (P1-FE-08)", () => {
    const root = buildObjectsRootNode([], {}, null);
    expect(root.selectable).toBe(true);
    expect(root.contextCommands).toEqual(
      expect.arrayContaining([
        "geometry.add-box",
        "geometry.add-thin-film",
        "geometry.add-cylinder",
        "geometry.add-sphere",
        "geometry.add-ellipsoid",
        "geometry.add-cone",
        "geometry.add-torus",
        "geometry.add-polygon-prism",
        "geometry.import-stl",
      ]),
    );
  });
});
