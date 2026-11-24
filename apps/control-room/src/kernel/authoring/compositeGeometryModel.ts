import {
  array3DDimensionsLabel,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";

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

export function geometryKindOf(geometry: Record<string, unknown>): string | null {
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

export function unwrapTransformGeometry(
  geometry: Record<string, unknown>,
): Record<string, unknown> {
  let current = geometry;
  for (let i = 0; i < 8; i += 1) {
    const kind = (geometryKindOf(current) ?? "").toLowerCase();
    if (kind !== "translate" && kind !== "transform") break;
    const params = geometryParamsOf(current);
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (!child) break;
    current = child;
  }
  return current;
}

function roleBadgeForOperandGeometry(
  role: NormalizedGeometryOperand["role"],
  childGeometry: Record<string, unknown>,
): string {
  const parsedArray = parseArray3DGeometry(unwrapTransformGeometry(childGeometry));
  const arrayDims = parsedArray ? array3DDimensionsLabel(parsedArray.axes) : null;
  if (arrayDims) {
    return role === "base"
      ? `⊞ Array 3D (${arrayDims})`
      : `${roleBadgeForCompositeOp(role)} · ${arrayDims}`;
  }
  return roleBadgeForCompositeOp(role);
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
    const child = asRecord(params.child) ?? asRecord(params.base);
    if (!child) return { op, operands: [], rawKind };
    if (op === "array") {
      const childKind = geometryKindOf(unwrapTransformGeometry(child));
      const childTransform = asRecord(params.child_transform) ?? undefined;
      return {
        op,
        operands: [
          {
            enabled: true,
            geometry: child,
            index: 0,
            label:
              asString(params.child_label) ??
              asString(params.label) ??
              (childKind ? `${childKind} (Unit)` : "Base Unit"),
            operandId: "array-child",
            role: "child",
            roleBadge: "Base Unit",
            total: 1,
            ...(childTransform ? { transform: childTransform } : {}),
          },
        ],
        rawKind,
      };
    }
    return {
      op,
      operands: [
        {
          enabled: true,
          geometry: child,
          index: 0,
          label: asString(params.label) ?? defaultOperandLabel(child, 0),
          operandId: "slice-child",
          role: "slice",
          roleBadge: roleBadgeForCompositeOp("slice"),
          total: 1,
        },
      ],
      rawKind,
    };
  }

  const rawOperands = params.operands ?? params.children;
  if (Array.isArray(rawOperands)) {
    const entries = rawOperands.map((entry) => asRecord(entry));
    const reservedIds = new Set(entries.map((entry) => asString(entry?.operand_id)));
    const total = entries.filter((entry) => entry !== null).length;
    const operands: NormalizedGeometryOperand[] = [];
    let nextLegacyId = 1;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const childGeometry = asRecord(entry.geometry) ?? entry;
      let operandId = asString(entry.operand_id);
      if (!operandId) {
        do {
          operandId = `op:${nextLegacyId++}`;
        } while (reservedIds.has(operandId));
      }
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
        roleBadge: roleBadgeForOperandGeometry(role, childGeometry),
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
            operandId: "op:1",
            role: "base",
            roleBadge: roleBadgeForOperandGeometry("base", first),
            total: 2,
          },
          {
            enabled: true,
            geometry: second,
            index: 1,
            label: defaultOperandLabel(second, 1),
            operandId: "op:2",
            role: op,
            roleBadge: roleBadgeForOperandGeometry(op, second),
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
