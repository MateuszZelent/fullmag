import type { FrozenSpinsSelectionExpression, SelectionGeometryPredicate, SelectionScalarExpression } from "@/kernel/api/apiTypes";

// Matches canonical selection validation in crates/fullmag-ir/src/validation.rs.
const UNIT_NORM_SQUARED_TOLERANCE = 1e-12;
const MAX_DEPTH = 64;

function vectorIssue(values: readonly number[], path: string, rule: "finite" | "positive" | "nonzero" | "unit" = "finite", dimension = 3): string | undefined {
  if (values.length !== dimension || !values.every(Number.isFinite)) return `${path} requires ${dimension} finite components.`;
  if (rule === "positive" && values.some((value) => value <= 0)) return `${path} components must be positive.`;
  if (rule === "nonzero" && values.some((value) => value === 0)) return `${path} components must be nonzero; the transform must be invertible.`;
  const normSquared = rule === "unit" ? values.reduce((sum, value) => sum + value * value, 0) : 1;
  if (!Number.isFinite(normSquared) || Math.abs(normSquared - 1) > UNIT_NORM_SQUARED_TOLERANCE) return `${path} must be normalized (unit length). Values are preserved without automatic normalization.`;
  return undefined;
}

function positiveIssue(value: number, path: string): string | undefined {
  return !Number.isFinite(value) || value <= 0 ? `${path} must be finite and positive.` : undefined;
}

function toleranceIssue(absolute: number, relative: number, path: string, requirePositive = false): string | undefined {
  if (!Number.isFinite(absolute) || !Number.isFinite(relative) || absolute < 0 || relative < 0) return `${path} tolerances must be finite and non-negative.`;
  return requirePositive && absolute === 0 && relative === 0 ? `${path} requires at least one positive tolerance.` : undefined;
}

function scalarIssue(value: SelectionScalarExpression, path: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return "Scalar expression exceeds the editor depth limit.";
  switch (value.kind) {
    case "constant": return Number.isFinite(value.value) ? undefined : `${path} must be finite.`;
    case "magnetization_dot": return vectorIssue(value.axis, `${path}.axis`, "unit");
    case "abs": return scalarIssue(value.value, `${path}.abs`, depth + 1);
    default: return undefined;
  }
}

function geometryIssue(geometry: SelectionGeometryPredicate, path: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return "Geometry exceeds the editor depth limit.";
  switch (geometry.kind) {
    case "box": return vectorIssue(geometry.center_m, `${path}.center_m`) ?? vectorIssue(geometry.size_m, `${path}.size_m`, "positive");
    case "sphere": return vectorIssue(geometry.center_m, `${path}.center_m`) ?? positiveIssue(geometry.radius_m, `${path}.radius_m`);
    case "ellipsoid": return vectorIssue(geometry.center_m, `${path}.center_m`) ?? vectorIssue(geometry.radii_m, `${path}.radii_m`, "positive");
    case "cylinder": return vectorIssue(geometry.center_m, `${path}.center_m`) ?? vectorIssue(geometry.axis, `${path}.axis`, "unit")
      ?? positiveIssue(geometry.radius_m, `${path}.radius_m`) ?? positiveIssue(geometry.height_m, `${path}.height_m`);
    case "affine": return vectorIssue(geometry.translation_m, `${path}.translation_m`) ?? vectorIssue(geometry.pivot_m, `${path}.pivot_m`)
      ?? vectorIssue(geometry.rotation_xyzw, `${path}.rotation_xyzw`, "unit", 4) ?? vectorIssue(geometry.scale, `${path}.scale`, "nonzero")
      ?? geometryIssue(geometry.geometry, `${path}.geometry`, depth + 1);
    case "union": case "intersection": case "xor": return geometryIssue(geometry.a, `${path}.a`, depth + 1) ?? geometryIssue(geometry.b, `${path}.b`, depth + 1);
    case "difference": return geometryIssue(geometry.base, `${path}.base`, depth + 1) ?? geometryIssue(geometry.tool, `${path}.tool`, depth + 1);
    case "complement": return geometryIssue(geometry.geometry, `${path}.geometry`, depth + 1) ?? geometryIssue(geometry.domain, `${path}.domain`, depth + 1);
    default: return undefined;
  }
}

/** Local value checks only: canonical graph, lane and runtime validation remain authoritative. */
export function selectionValueIssue(expression: FrozenSpinsSelectionExpression, path = "Selector", depth = 1): string | undefined {
  if (depth > MAX_DEPTH) return "Selector exceeds the editor depth limit.";
  switch (expression.kind) {
    case "and": case "or": case "xor": {
      const minimum = expression.kind === "xor" ? 2 : 1;
      if (expression.expressions.length < minimum) return minimum === 2 ? "XOR requires at least two expressions." : "At least one expression is required.";
      for (const [index, child] of expression.expressions.entries()) {
        const issue = selectionValueIssue(child, `${path}[${index + 1}]`, depth + 1);
        if (issue) return issue;
      }
      return undefined;
    }
    case "not": return selectionValueIssue(expression.expression, `${path}.not`, depth + 1);
    case "inside_geometry": return toleranceIssue(expression.boundary.absolute_tolerance_m, expression.boundary.relative_tolerance, `${path}.boundary`)
      ?? geometryIssue(expression.geometry, `${path}.geometry`, depth + 1);
    case "compare": return scalarIssue(expression.lhs, `${path}.left`, depth + 1) ?? scalarIssue(expression.rhs, `${path}.right`, depth + 1)
      ?? toleranceIssue(expression.tolerance?.atol ?? 0, expression.tolerance?.rtol ?? 0, path)
      ?? ((expression.tolerance?.atol ?? 0) !== 0 || (expression.tolerance?.rtol ?? 0) !== 0 ? "Scalar comparison requires zero tolerances in V1. Use Approximate scalar equality for a tolerance." : undefined);
    case "approx": return scalarIssue(expression.value, `${path}.value`, depth + 1) ?? scalarIssue(expression.target, `${path}.target`, depth + 1)
      ?? toleranceIssue(expression.atol, expression.rtol, path, true);
    case "between": return scalarIssue(expression.value, `${path}.value`, depth + 1)
      ?? (!Number.isFinite(expression.lower) || !Number.isFinite(expression.upper) ? "Interval bounds must be finite." : expression.lower > expression.upper ? "Lower bound cannot exceed upper bound." : undefined);
    default: return undefined;
  }
}
