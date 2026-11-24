import { geometryOperandGhostKey } from "@/kernel/visualization/geometryGhostVisibilityStore";
import {
  geometryKindOf,
  parseCompositeGeometry,
  unwrapTransformGeometry,
  type CompositeGeometryOp,
  type NormalizedGeometryOperand,
} from "@/kernel/authoring/compositeGeometryModel";
import type { ExplorerIconToken, ExplorerNode } from "../explorerTypes";

function iconForGeometry(geometry: Record<string, unknown>): ExplorerIconToken {
  const kind = (geometryKindOf(unwrapTransformGeometry(geometry)) ?? "").toLowerCase();
  if (
    kind === "union" ||
    kind === "difference" ||
    kind === "intersection" ||
    kind === "xor" ||
    kind === "csg" ||
    kind === "array3d" ||
    kind === "array_3d"
  ) {
    return "layers";
  }
  if (kind === "sphere" || kind === "ellipsoid" || kind === "torus") return "circle";
  if (kind === "cone" || kind === "polygonprism") return "triangle";
  return "box";
}

function resolveExplorerNodeLabel(
  parsedOp: CompositeGeometryOp | null,
  operand: NormalizedGeometryOperand,
  parentLabel?: string,
): string {
  if (parsedOp !== "array") return operand.label;
  const childKind = geometryKindOf(unwrapTransformGeometry(operand.geometry));
  if (parentLabel && parentLabel.trim().length > 0) {
    const cleanParent = parentLabel.trim();
    if (!childKind) return `${cleanParent} (Unit)`;
    const lowerParent = cleanParent.toLowerCase();
    const lowerKind = childKind.toLowerCase();
    if (lowerParent === lowerKind || lowerParent.includes(`(${lowerKind})`)) {
      return `${childKind} (Unit)`;
    }
    return `${cleanParent} (${childKind})`;
  }
  return operand.label;
}

export function buildGeometryTreeExplorerNodes(
  objectId: string,
  parentId: string,
  geometry: unknown,
  ghostKeys?: ReadonlySet<string>,
  depth = 0,
  parentPath = "",
  parentLabel?: string,
): ExplorerNode[] {
  if (depth > 8) return [];
  const parsed = parseCompositeGeometry(geometry);
  if (parsed.operands.length === 0) return [];

  const isTopLevelBoolean =
    depth === 0 && parsed.op !== null && parsed.op !== "array" && parsed.op !== "slice";

  return parsed.operands.map((operand) => {
    const geometryNodePath = parentPath
      ? `${parentPath}/${operand.operandId}`
      : operand.operandId;
    const nodeId = `${parentId}:${operand.operandId}`;
    const ghostVisible =
      ghostKeys?.has(geometryOperandGhostKey(objectId, geometryNodePath)) ?? false;
    const activeToken = operand.enabled ? "●" : "○";
    const ghostToken = ghostVisible ? " · 👻" : "";
    const operandInput = {
      objectId,
      operandId: geometryNodePath,
    };
    const displayLabel = resolveExplorerNodeLabel(parsed.op, operand, parentLabel);
    const unwrappedKind = geometryKindOf(unwrapTransformGeometry(operand.geometry));
    const children = buildGeometryTreeExplorerNodes(
      objectId,
      nodeId,
      operand.geometry,
      ghostKeys,
      depth + 1,
      geometryNodePath,
      displayLabel,
    );

    return {
      id: nodeId,
      kind: "object.geometry.node",
      label: displayLabel,
      parentId,
      badge: `${operand.roleBadge} ${activeToken}${ghostToken}`,
      icon: iconForGeometry(operand.geometry),
      objectId,
      geometryNodeId: geometryNodePath,
      operandId: operand.operandId,
      geometryNodeEnabled: operand.enabled,
      geometryNodeRole: operand.role,
      selectable: true,
      status: operand.enabled ? "ready" : "skipped",
      statusReason: operand.enabled
        ? `${operand.roleBadge} (${unwrappedKind ?? "primitive"})${ghostVisible ? ", ghost wireframe visible" : ""}.`
        : `${operand.roleBadge} operand is disabled and excluded from evaluation.`,
      contextCommands: isTopLevelBoolean
        ? [
            "geometry.operand-toggle",
            "geometry.operand-toggle-ghost",
            "geometry.operand-move-up",
            "geometry.operand-move-down",
            "geometry.extract-operand",
            "workspace.focus-selection",
          ]
        : ["geometry.operand-toggle-ghost", "workspace.focus-selection"],
      contextCommandInputs: isTopLevelBoolean
        ? {
            "geometry.operand-toggle": { ...operandInput, enabled: !operand.enabled },
            "geometry.operand-toggle-ghost": operandInput,
            "geometry.operand-move-up": operandInput,
            "geometry.operand-move-down": operandInput,
            "geometry.extract-operand": operandInput,
          }
        : {
            "geometry.operand-toggle-ghost": operandInput,
          },
      ...(children.length > 0 ? { children } : {}),
    };
  });
}
