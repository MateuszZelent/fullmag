import type { FrozenSpinsSelectionExpression, SelectionGeometryPredicate, SelectionScalarExpression } from "@/kernel/api/apiTypes";

export interface SelectionReferenceOption { id: string; label: string }
export interface SelectionReferenceCatalog {
  ready: boolean;
  objects: (SelectionReferenceOption & { regions: SelectionReferenceOption[] })[];
  selections: SelectionReferenceOption[];
}

interface SceneReferenceSource {
  objects?: readonly {
    id: string; name?: string | null;
    regions?: readonly { region_id?: string; name: string }[];
  }[];
  selections?: readonly { id: string; name?: string | null }[];
}

const option = (id: string, name?: string | null): SelectionReferenceOption => ({ id, label: name && name !== id ? `${name} (${id})` : id });

/** Names are labels only. A region without an explicit ID is not a candidate. */
export function selectionReferenceCatalog(scene: SceneReferenceSource | null, ready: boolean): SelectionReferenceCatalog {
  return {
    ready: ready && scene !== null,
    objects: (scene?.objects ?? []).map((object) => ({
      ...option(object.id, object.name),
      regions: (object.regions ?? []).flatMap((region) => region.region_id ? [option(region.region_id, region.name)] : []),
    })),
    selections: (scene?.selections ?? []).map((selection) => option(selection.id, selection.name)),
  };
}

export function selectionUnsupportedReason(expression: FrozenSpinsSelectionExpression, depth = 1): string | undefined {
  if (depth > 64) return "Selector depth exceeds the editor limit. The original expression is preserved.";
  switch (expression.kind) {
    case "and": case "or": case "xor":
      return expression.expressions.map((child) => selectionUnsupportedReason(child, depth + 1)).find(Boolean);
    case "not": return selectionUnsupportedReason(expression.expression, depth + 1);
    case "inside_geometry": return unsupportedGeometry(expression.geometry, depth + 1);
    case "compare": return unsupportedScalar(expression.lhs, depth + 1) ?? unsupportedScalar(expression.rhs, depth + 1);
    case "approx": return unsupportedScalar(expression.value, depth + 1) ?? unsupportedScalar(expression.target, depth + 1);
    case "between": return unsupportedScalar(expression.value, depth + 1);
    case "all_magnetic": case "in_object": case "in_region": case "ref": return undefined;
    default: return "This selector kind is unsupported by this editor. The original expression is preserved.";
  }
}

function unsupportedScalar(scalar: SelectionScalarExpression, depth: number): string | undefined {
  if (depth > 64) return "Scalar expression depth exceeds the editor limit. The original expression is preserved.";
  switch (scalar.kind) {
    case "abs": return unsupportedScalar(scalar.value, depth + 1);
    case "constant": case "coordinate": case "magnetization_component": case "magnetization_norm": case "magnetization_dot": return undefined;
    default: return "This scalar kind is unsupported by this editor. The original expression is preserved.";
  }
}

function unsupportedGeometry(geometry: SelectionGeometryPredicate, depth: number): string | undefined {
  if (depth > 64) return "Geometry depth exceeds the editor limit. The original expression is preserved.";
  switch (geometry.kind) {
    case "imported_solid": return "Imported-solid selection occupancy is not qualified. This authored selector is preserved read-only.";
    case "union": case "intersection": case "xor": return unsupportedGeometry(geometry.a, depth + 1) ?? unsupportedGeometry(geometry.b, depth + 1);
    case "difference": return unsupportedGeometry(geometry.base, depth + 1) ?? unsupportedGeometry(geometry.tool, depth + 1);
    case "complement": return unsupportedGeometry(geometry.geometry, depth + 1) ?? unsupportedGeometry(geometry.domain, depth + 1);
    case "affine": return unsupportedGeometry(geometry.geometry, depth + 1);
    case "box": case "sphere": case "cylinder": case "ellipsoid": return undefined;
    default: return "This geometry kind is unsupported by this editor. The original expression is preserved.";
  }
}

/** Checks direct references only; graph validity and target compatibility remain canonical. */
export function selectionReferenceIssue(expression: FrozenSpinsSelectionExpression, catalog: SelectionReferenceCatalog, depth = 1): string | undefined {
  const unsupported = selectionUnsupportedReason(expression, depth);
  if (unsupported) return unsupported;
  const objectIssue = (id: string, label = "Object ID") => !id.trim() ? `${label} cannot be empty.`
    : !catalog.ready ? "Load the current scene catalog before using selector references."
      : !catalog.objects.some((object) => object.id === id) ? `${label} is unavailable: ${id}` : undefined;
  const scalarIssue = (scalar: SelectionScalarExpression, scalarDepth = depth): string | undefined => {
    if (scalarDepth > 64) return "Scalar expression depth exceeds the editor limit.";
    if (scalar.kind === "coordinate" && scalar.frame.kind === "object") return objectIssue(scalar.frame.object_id, "Frame object ID");
    if (scalar.kind === "abs") return scalarIssue(scalar.value, scalarDepth + 1);
    return undefined;
  };
  switch (expression.kind) {
    case "in_object": return objectIssue(expression.object_id);
    case "in_region":
      return objectIssue(expression.object_id) ?? (!expression.region_id.trim() ? "Region ID cannot be empty."
        : !catalog.objects.find((object) => object.id === expression.object_id)?.regions.some((region) => region.id === expression.region_id)
          ? `Region ID is unavailable for this object: ${expression.region_id}` : undefined);
    case "ref": return !expression.selection_id.trim() ? "Selection ID cannot be empty."
      : !catalog.ready ? "Load the current scene catalog before using selector references."
        : !catalog.selections.some((selection) => selection.id === expression.selection_id) ? `Selection ID is unavailable: ${expression.selection_id}` : undefined;
    case "and": case "or": case "xor": return expression.expressions.length === 0 ? "At least one sub-expression clause is required."
      : expression.expressions.map((child) => selectionReferenceIssue(child, catalog, depth + 1)).find(Boolean);
    case "not": return selectionReferenceIssue(expression.expression, catalog, depth + 1);
    case "inside_geometry": return expression.frame.kind === "object" ? objectIssue(expression.frame.object_id, "Frame object ID") : undefined;
    case "compare": return scalarIssue(expression.lhs) ?? scalarIssue(expression.rhs);
    case "approx": return scalarIssue(expression.value) ?? scalarIssue(expression.target);
    case "between": return expression.lower > expression.upper ? "Lower bound cannot exceed upper bound." : scalarIssue(expression.value);
    case "all_magnetic": return undefined;
  }
}
