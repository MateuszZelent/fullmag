import {
  array3DDimensionsLabel,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";
import { geometryOperandGhostKey } from "@/kernel/visualization/geometryGhostVisibilityStore";
import type { ExplorerIconToken, ExplorerNode } from "../explorerTypes";

export type CompositeGeometryOp =
  | "union"
  | "subtract"
  | "intersect"
  | "xor"
  | "slice"
  | "array";

export interface NormalizedGeometryOperand {
  enabled: boolean;
  geometry: Record<string, unknown>;
  index: number;
  label: string;
  operandId: string;
  role: "base" | CompositeGeometryOp | "child";
  roleBadge: string;
  sourceObjectId?: string;
  total: number;
  transform?: Record<string, unknown>;
}

export interface ParsedCompositeGeometry {
  op: CompositeGeometryOp | null;
  operands: NormalizedGeometryOperand[];
  rawKind: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function geometryKindOf(geometry: Record<string, unknown>): string | null {
  return asString(geometry.geometry_kind) ?? asString(geometry.kind);
}

function geometryParamsOf(geometry: Record<string, unknown>): Record<string, unknown> {
  return asRecord(geometry.geometry_params) ?? asRecord(geometry.params) ?? geometry;
}

function normalizeCompositeOp(
  kind: string | null,
  params: Record<string, unknown>,
): CompositeGeometryOp | null {
  const normalized = (kind ?? "").trim().toLowerCase();
  if (normalized === "union") return "union";
  if (normalized === "difference" || normalized === "subtract") return "subtract";
  if (normalized === "intersection" || normalized === "intersect") return "intersect";
  if (normalized === "xor") return "xor";
  if (normalized === "sliceplane" || normalized === "slice_plane") return "slice";
  if (normalized === "array3d" || normalized === "array_3d") return "array";
  if (normalized === "csg") {
    const op = (asString(params.op) ?? asString(params.operation) ?? "").toLowerCase();
    if (op === "union") return "union";
    if (op === "difference" || op === "subtract") return "subtract";
    if (op === "intersection" || op === "intersect") return "intersect";
    if (op === "xor") return "xor";
  }
  return null;
}

export function roleBadgeForCompositeOp(
  op: CompositeGeometryOp | "base" | "child",
): string {
  switch (op) {
    case "base":
      return "Base";
    case "union":
      return "+ Union";
    case "subtract":
      return "− Subtract";
    case "intersect":
      return "∩ Intersect";
    case "xor":
      return "⊕ XOR";
    case "slice":
      return "✂ Slice";
    case "array":
      return "⊞ Array";
    default:
      return "Child";
  }
}

function defaultOperandLabel(geometry: Record<string, unknown>, index: number): string {
  const kind = geometryKindOf(geometry);
  if (kind) return index === 0 ? `Base (${kind})` : `${kind} ${index}`;
  return index === 0 ? "Base" : `Operand ${index + 1}`;
}

function iconForGeometry(geometry: Record<string, unknown>): ExplorerIconToken {
  const kind = (geometryKindOf(geometry) ?? "").toLowerCase();
  if (kind === "union" || kind === "difference" || kind === "intersection" || kind === "xor" || kind === "csg") {
    return "layers";
  }
  if (kind === "sphere" || kind === "ellipsoid" || kind === "torus") return "circle";
  if (kind === "cone" || kind === "polygonprism") return "triangle";
  return "box";
}

function unwrapTransformGeometry(
  geometry: Record<string, unknown>,
): Record<string, unknown> {
  const kind = (geometryKindOf(geometry) ?? "").toLowerCase();
  if (kind === "translate" || kind === "transform") {
    const params = geometryParamsOf(geometry);
    const child = asRecord(params.child);
    if (child) return child;
  }
  return geometry;
}

export function parseCompositeGeometry(geometry: unknown): ParsedCompositeGeometry {
  const rawRecord = asRecord(geometry);
  if (!rawRecord) return { op: null, operands: [], rawKind: null };

  const record = unwrapTransformGeometry(rawRecord);
  const rawKind = geometryKindOf(record);
  const params = geometryParamsOf(record);
  const op = normalizeCompositeOp(rawKind, params);
  if (!op) return { op: null, operands: [], rawKind };

  if (op === "slice" || op === "array") {
    const child = asRecord(params.child);
    if (!child) return { op, operands: [], rawKind };
    const parsedArray = op === "array" ? parseArray3DGeometry(record) : null;
    const arrayDims = parsedArray ? array3DDimensionsLabel(parsedArray.axes) : null;
    return {
      op,
      operands: [
        {
          enabled: true,
          geometry: child,
          index: 0,
          label:
            asString(params.label) ??
            (arrayDims ? `Array 3D (${arrayDims})` : defaultOperandLabel(child, 0)),
          operandId: op === "slice" ? "slice-child" : "array-child",
          role: op,
          roleBadge: arrayDims ? `⊞ Array 3D (${arrayDims})` : roleBadgeForCompositeOp(op),
          total: 1,
        },
      ],
      rawKind,
    };
  }

  if (Array.isArray(params.operands)) {
    const entries = params.operands
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const total = entries.length;
    const operands: NormalizedGeometryOperand[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const childGeometry = asRecord(entry.geometry) ?? entry;
      const operandId = asString(entry.operand_id) ?? `operand-${index}`;
      const label = asString(entry.label) ?? defaultOperandLabel(childGeometry, index);
      const enabled = typeof entry.enabled === "boolean" ? entry.enabled : true;
      const role: NormalizedGeometryOperand["role"] = index === 0 ? "base" : op;
      const transform = asRecord(entry.transform) ?? undefined;
      const sourceObjectId = asString(entry.source_object_id) ?? undefined;
      operands.push({
        enabled,
        geometry: childGeometry,
        index,
        label,
        operandId,
        role,
        roleBadge: roleBadgeForCompositeOp(role),
        ...(sourceObjectId ? { sourceObjectId } : {}),
        total,
        ...(transform ? { transform } : {}),
      });
    }
    return { op, operands, rawKind };
  }

  // Backward-compatible legacy 2-operand CSG shapes: { base, tool }, { a, b }, { left, right }
  const legacyPairs: readonly (readonly [string, string])[] = [
    ["base", "tool"],
    ["a", "b"],
    ["left", "right"],
  ];
  for (const [firstKey, secondKey] of legacyPairs) {
    const first = asRecord(params[firstKey]);
    const second = asRecord(params[secondKey]);
    if (first && second) {
      return {
        op,
        operands: [
          {
            enabled: true,
            geometry: first,
            index: 0,
            label: defaultOperandLabel(first, 0),
            operandId: firstKey,
            role: "base",
            roleBadge: roleBadgeForCompositeOp("base"),
            total: 2,
          },
          {
            enabled: true,
            geometry: second,
            index: 1,
            label: defaultOperandLabel(second, 1),
            operandId: secondKey,
            role: op,
            roleBadge: roleBadgeForCompositeOp(op),
            total: 2,
          },
        ],
        rawKind,
      };
    }
  }

  return { op, operands: [], rawKind };
}

export function isCompositeGeometry(geometry: unknown): boolean {
  return parseCompositeGeometry(geometry).operands.length > 0;
}

export function buildGeometryTreeExplorerNodes(
  objectId: string,
  parentId: string,
  geometry: unknown,
  ghostKeys?: ReadonlySet<string>,
  depth = 0,
): ExplorerNode[] {
  if (depth > 8) return [];
  const parsed = parseCompositeGeometry(geometry);
  if (parsed.operands.length === 0) return [];

  return parsed.operands.map((operand) => {
    const nodeId = `${parentId}:${operand.operandId}`;
    const ghostVisible = ghostKeys?.has(
      geometryOperandGhostKey(objectId, operand.operandId),
    ) ?? false;
    const activeToken = operand.enabled ? "●" : "○";
    const ghostToken = ghostVisible ? " · 👻" : "";
    const operandInput = {
      objectId,
      operandId: operand.operandId,
    };
    const children = buildGeometryTreeExplorerNodes(
      objectId,
      nodeId,
      operand.geometry,
      ghostKeys,
      depth + 1,
    );

    return {
      id: nodeId,
      kind: "object.geometry.node",
      label: operand.label,
      parentId,
      badge: `${operand.roleBadge} ${activeToken}${ghostToken}`,
      icon: iconForGeometry(operand.geometry),
      objectId,
      geometryNodeId: operand.operandId,
      operandId: operand.operandId,
      geometryNodeEnabled: operand.enabled,
      geometryNodeRole: operand.role,
      selectable: true,
      status: operand.enabled ? "ready" : "skipped",
      statusReason: operand.enabled
        ? `${operand.roleBadge} operand (${geometryKindOf(operand.geometry) ?? "primitive"})${ghostVisible ? ", ghost wireframe visible" : ""}.`
        : `${operand.roleBadge} operand is disabled and excluded from evaluation.`,
      contextCommands: [
        "geometry.operand-toggle",
        "geometry.operand-toggle-ghost",
        "geometry.operand-move-up",
        "geometry.operand-move-down",
        "geometry.extract-operand",
        "workspace.focus-selection",
      ],
      contextCommandInputs: {
        "geometry.operand-toggle": { ...operandInput, enabled: !operand.enabled },
        "geometry.operand-toggle-ghost": operandInput,
        "geometry.operand-move-up": operandInput,
        "geometry.operand-move-down": operandInput,
        "geometry.extract-operand": operandInput,
      },
      ...(children.length > 0 ? { children } : {}),
    };
  });
}
