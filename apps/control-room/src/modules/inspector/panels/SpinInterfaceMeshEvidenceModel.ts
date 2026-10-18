import type { DecodedTopology } from "@/kernel/api/codecs/types";
import type { MeshRegionMembershipResource, MeshSharedDomainManifestResource } from "@/kernel/api/apiTypes";
export interface SpinInterfaceMeshCarrier { manifest: MeshSharedDomainManifestResource; topology: DecodedTopology; sideA: MeshRegionMembershipResource; sideB: MeshRegionMembershipResource; geometryRealizationRevision: number }
export function verifySpinInterfaceMeshOrientation(carrier: SpinInterfaceMeshCarrier, authored: readonly number[]) {
  const { manifest, topology, sideA, sideB } = carrier;
  if (manifest.geometry_realization_revision !== carrier.geometryRealizationRevision) throw new Error("Accepted mesh geometry realization differs from the current geometry.");
  if (!manifest.generation_id || !manifest.topology_fingerprint || [sideA, sideB].some((side) => side.freshness !== "current" || side.mesh_revision !== manifest.revision || side.mesh_id !== manifest.mesh_id || side.mesh_generation_id !== manifest.generation_id || side.topology_fingerprint !== manifest.topology_fingerprint)) throw new Error("Current certified memberships must match the same mesh generation and topology.");
  if (sideA.owner_object_id === sideB.owner_object_id && sideA.region_id === sideB.region_id) throw new Error("Interface sides must be distinct.");
  if (!topology.cellOffsets || !topology.cellNodes || !topology.cellTypes || topology.cellCount === undefined) throw new Error("Canonical CSR cell topology is required.");
  if (sideA.element_indices.length + sideB.element_indices.length > 100000) throw new Error("Mesh inspection budget exceeded; use a scoped mesh qualification workflow.");
  if (authored.length !== 3) throw new Error("Authored interface normal must have three components.");
  const norm = Math.hypot(...authored);
  if (authored.length !== 3 || authored.some((item) => !Number.isFinite(item)) || Math.abs(norm - 1) > 1e-8) throw new Error("Authored interface normal must be a unit vector.");
  const position = (node: number) => [0,1,2].map((axis) => topology.positions[3 * node + axis]);
  const cells = (indices: number[]) => indices.map((index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= topology.cellCount! || topology.cellTypes![index] !== 1) throw new Error("This mesh inspection supports canonical tet4 cells only.");
    const nodes = Array.from(topology.cellNodes!.slice(topology.cellOffsets![index], topology.cellOffsets![index + 1]));
    if (nodes.length !== 4 || new Set(nodes).size !== 4 || nodes.some((node) => node >= topology.nodeCount)) throw new Error("Invalid tet4 connectivity.");
    return { index, nodes, center: [0,1,2].map((axis) => nodes.reduce((sum, node) => sum + position(node)[axis], 0) / 4) };
  });
  if (new Set(sideA.element_indices).size !== sideA.element_indices.length || new Set(sideB.element_indices).size !== sideB.element_indices.length) throw new Error("Duplicate membership cells cannot certify an interface.");
  const a = cells(sideA.element_indices); const b = cells(sideB.element_indices);
  const bSet = new Set(b.map((cell) => cell.index));
  if (a.some((cell) => bSet.has(cell.index))) throw new Error("Interface memberships overlap in volume.");
  const faces = new Map<string, { nodes: number[]; center: number[] }>();
  const faceCounts = new Map<string, number>();
  for (const cell of a) for (let omitted = 0; omitted < 4; omitted++) {
    const nodes = cell.nodes.filter((_, index) => index !== omitted);
    const key = [...nodes].sort((x,y) => x-y).join(",");
    const count = (faceCounts.get(key) ?? 0) + 1; faceCounts.set(key, count);
    if (count > 2) throw new Error("Nonmanifold cell face cannot certify an interface.");
    if (faces.has(key)) faces.delete(key); else faces.set(key, { nodes, center: cell.center });
  }
  let count = 0; let area = 0; const average = [0,0,0];
  const sharedFaces = new Set<string>();
  for (const cell of b) for (let omitted = 0; omitted < 4; omitted++) {
    const nodes = cell.nodes.filter((_, index) => index !== omitted);
    const key = [...nodes].sort((x,y) => x-y).join(",");
    const face = faces.get(key);
    if (!face) continue;
    if (sharedFaces.has(key)) throw new Error("Nonmanifold shared facet cannot certify an interface.");
    sharedFaces.add(key);
    const [p0,p1,p2] = face.nodes.map(position);
    const u = p1.map((entry,i) => entry-p0[i]); const v = p2.map((entry,i) => entry-p0[i]);
    let normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    const length = Math.hypot(...normal);
    if (!Number.isFinite(length) || length <= 0) throw new Error("Degenerate interface facet.");
    const direction = cell.center.map((entry,i) => entry-face.center[i]);
    if (normal.reduce((sum,entry,i) => sum+entry*direction[i],0) < 0) normal = normal.map((entry) => -entry);
    if (normal.reduce((sum,entry,i) => sum+entry*authored[i]/length,0) < 1-1e-6) throw new Error("Authored normal does not match a shared facet oriented from side A to B.");
    count++; area += length/2; normal.forEach((entry,i) => { average[i] += entry/2; });
  }
  if (!count) throw new Error("No shared tet4 facets: sides are not adjacent in the accepted mesh.");
  const averageNorm = Math.hypot(...average);
  return { status: "mesh_verified" as const, sharedFacetCount: count, interfaceAreaM2: area, normalAToB: average.map((entry) => entry/averageNorm), meshGenerationId: manifest.generation_id, topologyFingerprint: manifest.topology_fingerprint };
}
