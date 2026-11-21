
import type { MaterializedDatasetResource, SavedFieldGeometryResource } from "../api/apiTypes";
import { canonicalSavedGeometryJson } from "../api/savedGeometryIdentity";

/** Historical identity remains independent of the active session and mesh. */
export function savedGeometryResourceKey(dataset: MaterializedDatasetResource): string {
  return `saved-field-geometry:${canonicalSavedGeometryJson(dataset)}`;
}

export function savedGeometryBinaryResourceKey(
  dataset: MaterializedDatasetResource, geometry: SavedFieldGeometryResource, kind: "topology" | "support",
): string {
  return `${savedGeometryResourceKey(dataset)}:${kind}:${canonicalSavedGeometryJson(geometry)}`;
}
