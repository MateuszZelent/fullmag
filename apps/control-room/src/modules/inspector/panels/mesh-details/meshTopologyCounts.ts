import { asRecord } from "../MeshResourceView";

type MeshTopologyCounts = {
  node_count: number | null;
  element_count: number | null;
  boundary_face_count: number | null;
};

function safeMeshCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function resolveMeshTopologyCounts(value: unknown): MeshTopologyCounts | null {
  const record = asRecord(value);
  if (!record) return null;
  const counts = {
    node_count: safeMeshCount(record.node_count),
    element_count: safeMeshCount(record.element_count),
    boundary_face_count: safeMeshCount(record.boundary_face_count),
  };
  return Object.values(counts).some((count) => count !== null) ? counts : null;
}
