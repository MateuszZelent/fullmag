import type { FemLiveMesh } from "./types";
import {
  getFemBoundaryFaceCount,
  getFemBoundaryMarkerCount,
  getFemElementCount,
  getFemElementMarkerCount,
  getFemNodeCount,
} from "./femTopology";

export function validateFemMeshPayload(mesh: FemLiveMesh): string[] {
  const errors: string[] = [];

  const nodeCount = getFemNodeCount(mesh);
  const elementCount = getFemElementCount(mesh);
  const boundaryFaceCount = getFemBoundaryFaceCount(mesh);
  const elementMarkerCount = getFemElementMarkerCount(mesh);
  const boundaryMarkerCount = getFemBoundaryMarkerCount(mesh);

  if (elementMarkerCount > 0 && elementMarkerCount !== elementCount) {
    errors.push(
      `element_markers length (${elementMarkerCount}) != elements length (${elementCount})`,
    );
  }
  if (boundaryMarkerCount > 0 && boundaryMarkerCount !== boundaryFaceCount) {
    errors.push(
      `boundary_markers length (${boundaryMarkerCount}) != boundary_faces length (${boundaryFaceCount})`,
    );
  }
  for (const part of mesh.mesh_parts ?? []) {
    if (part.element_start + part.element_count > elementCount) {
      errors.push(`part ${part.id} element range exceeds mesh`);
    }
    if (part.boundary_face_start + part.boundary_face_count > boundaryFaceCount) {
      errors.push(`part ${part.id} boundary_face range exceeds mesh`);
    }
    if (part.node_start + part.node_count > nodeCount) {
      errors.push(`part ${part.id} node range exceeds mesh`);
    }
  }

  return errors;
}
