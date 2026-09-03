import type { FemLiveMesh } from "./types";

export function getFemNodeCount(mesh: FemLiveMesh): number {
  const buffered = mesh.topology_buffers?.nodes;
  if (buffered) return Math.floor(buffered.length / 3);
  return mesh.node_count ?? mesh.nodes.length;
}

export function getFemElementCount(mesh: FemLiveMesh): number {
  const buffered = mesh.topology_buffers?.elements;
  if (buffered) return Math.floor(buffered.length / 4);
  return mesh.element_count ?? mesh.elements.length;
}

export function getFemBoundaryFaceCount(mesh: FemLiveMesh): number {
  const buffered = mesh.topology_buffers?.boundary_faces;
  if (buffered) return Math.floor(buffered.length / 3);
  return mesh.boundary_face_count ?? mesh.boundary_faces.length;
}

export function getFemElementMarkerCount(mesh: FemLiveMesh): number {
  return mesh.topology_buffers?.element_markers.length ?? mesh.element_markers?.length ?? 0;
}

export function getFemBoundaryMarkerCount(mesh: FemLiveMesh): number {
  return mesh.topology_buffers?.boundary_markers.length ?? mesh.boundary_markers?.length ?? 0;
}

export function readFemNode(mesh: FemLiveMesh, index: number): [number, number, number] | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const flat = mesh.topology_buffers?.nodes;
  const offset = index * 3;
  if (flat && offset + 2 < flat.length) {
    return [Number(flat[offset]), Number(flat[offset + 1]), Number(flat[offset + 2])];
  }
  const node = mesh.nodes[index];
  return node ? [Number(node[0]), Number(node[1]), Number(node[2])] : null;
}

export function readFemElementNode(
  mesh: FemLiveMesh,
  elementIndex: number,
  localIndex: number,
): number | null {
  if (
    !Number.isInteger(elementIndex) ||
    !Number.isInteger(localIndex) ||
    elementIndex < 0 ||
    localIndex < 0 ||
    localIndex >= 4
  ) {
    return null;
  }
  const flat = mesh.topology_buffers?.elements;
  const offset = elementIndex * 4 + localIndex;
  if (flat && offset < flat.length) return Number(flat[offset]);
  const element = mesh.elements[elementIndex];
  return element ? Number(element[localIndex]) : null;
}

export function readFemBoundaryFace(
  mesh: FemLiveMesh,
  faceIndex: number,
): [number, number, number] | null {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) return null;
  const flat = mesh.topology_buffers?.boundary_faces;
  const offset = faceIndex * 3;
  if (flat && offset + 2 < flat.length) {
    return [Number(flat[offset]), Number(flat[offset + 1]), Number(flat[offset + 2])];
  }
  const face = mesh.boundary_faces[faceIndex];
  return face ? [Number(face[0]), Number(face[1]), Number(face[2])] : null;
}

export function readFemElementMarker(mesh: FemLiveMesh, elementIndex: number): number | null {
  if (!Number.isInteger(elementIndex) || elementIndex < 0) return null;
  const flat = mesh.topology_buffers?.element_markers;
  if (flat && elementIndex < flat.length) return Number(flat[elementIndex]);
  const marker = mesh.element_markers?.[elementIndex];
  return marker == null ? null : Number(marker);
}
