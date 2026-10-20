import type { MeshObjectConfigReplaceRequest } from "./apiTypes";

// ScriptBuilderPerGeometryMeshState stores these authoring values as text.
// Meshing algorithms, counts, booleans and nested numerical size fields retain their types.
const TEXT_NUMERIC_FIELDS = [
  "hmax", "hmin", "maximum_element_size", "minimum_element_size",
  "curvature_factor", "growth_rate", "maximum_element_growth_rate",
  "narrow_region_resolution", "resolved_growth_rate", "bulk_hmax", "bulk_hmin",
  "interface_hmax", "interface_thickness", "edge_maximum_element_size", "edge_hmax",
  "edge_thickness", "edge_transition_distance", "corner_maximum_element_size", "corner_hmax",
  "corner_extent", "corner_transition_distance", "transition_distance",
] as const;

/** Serialize the object-policy authoring contract at the shared API boundary. */
export function objectMeshPolicyWireRequest(request: MeshObjectConfigReplaceRequest): MeshObjectConfigReplaceRequest {
  if (request.config == null) return request;
  const config = { ...request.config };
  for (const key of TEXT_NUMERIC_FIELDS) {
    const value = config[key];
    if (typeof value === "number" && Number.isFinite(value)) config[key] = String(value);
  }
  return { ...request, config };
}
