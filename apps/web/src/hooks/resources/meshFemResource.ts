"use client";

import type { DecodedTopology } from "../../api/codecs/types";
import type { MeshSharedDomainManifestResource } from "../../api/types";
import type { FemLiveMesh, MeshSummaryState } from "@/lib/session/types";

function tripleAt(
  values: Float64Array,
  index: number,
): [number, number, number] {
  const base = index * 3;
  return [
    values[base] ?? 0,
    values[base + 1] ?? 0,
    values[base + 2] ?? 0,
  ];
}

function faceAt(
  values: Uint32Array,
  index: number,
): [number, number, number] {
  const base = index * 3;
  return [
    values[base] ?? 0,
    values[base + 1] ?? 0,
    values[base + 2] ?? 0,
  ];
}

function tetAt(
  values: Uint32Array,
  index: number,
): [number, number, number, number] {
  const base = index * 4;
  return [
    values[base] ?? 0,
    values[base + 1] ?? 0,
    values[base + 2] ?? 0,
    values[base + 3] ?? 0,
  ];
}

function meshIdentity(mesh: FemLiveMesh | null): string | null {
  if (!mesh) {
    return null;
  }
  if (mesh.generation_id && mesh.generation_id.length > 0) {
    return `gen:${mesh.generation_id}`;
  }
  if (mesh.mesh_id && mesh.mesh_id.length > 0) {
    return `mesh:${mesh.mesh_id}`;
  }
  return null;
}

export function buildFemMeshFromDecodedTopology(
  topology: DecodedTopology,
  summary: MeshSummaryState | null,
): FemLiveMesh {
  const generationId =
    summary?.generation_id && summary.generation_id.length > 0
      ? summary.generation_id
      : summary?.mesh_id;
  const meshId =
    summary?.mesh_id ??
    (generationId ? `resource-mesh:${generationId}` : "resource-mesh:shared-domain");

  return {
    mesh_name:
      summary?.mesh_name && summary.mesh_name.length > 0
        ? summary.mesh_name
        : "resource-shared-domain-mesh",
    mesh_id: meshId,
    generation_id: generationId ?? null,
    nodes: Array.from({ length: topology.nodeCount }, (_, index) =>
      tripleAt(topology.positions, index),
    ),
    elements: Array.from({ length: topology.elementCount }, (_, index) =>
      tetAt(topology.indices, index),
    ),
    element_markers: Array.from(topology.elementMarkers),
    boundary_faces: Array.from({ length: topology.boundaryFaceCount }, (_, index) =>
      faceAt(topology.boundaryFaces, index),
    ),
    boundary_markers: Array.from(topology.boundaryMarkers),
    topology_buffers: {
      nodes: topology.positions,
      elements: topology.indices,
      boundary_faces: topology.boundaryFaces,
      element_markers: topology.elementMarkers,
      boundary_markers: topology.boundaryMarkers,
    },
    topology_transport: "binary",
    node_count: topology.nodeCount,
    element_count: topology.elementCount,
    boundary_face_count: topology.boundaryFaceCount,
    object_segments: [],
    mesh_parts: [],
    domain_mesh_mode: summary?.domain_mesh_mode ?? null,
    domain_frame: summary?.domain_frame ?? null,
    per_domain_quality: null,
  };
}

export function applyMeshSharedDomainManifest(
  mesh: FemLiveMesh,
  manifest: MeshSharedDomainManifestResource | null,
): FemLiveMesh {
  if (!manifest) {
    return mesh;
  }
  return {
    ...mesh,
    mesh_name:
      manifest.mesh_name && manifest.mesh_name.length > 0
        ? manifest.mesh_name
        : mesh.mesh_name,
    mesh_id:
      manifest.mesh_id && manifest.mesh_id.length > 0
        ? manifest.mesh_id
        : mesh.mesh_id,
    generation_id: manifest.generation_id ?? mesh.generation_id ?? null,
    domain_mesh_mode: manifest.domain_mesh_mode ?? mesh.domain_mesh_mode ?? null,
    object_segments: manifest.object_segments.map((segment) => ({
      object_id: segment.object_id,
      geometry_id: segment.geometry_id ?? null,
      node_start: segment.node_start,
      node_count: segment.node_count,
      element_start: segment.element_start,
      element_count: segment.element_count,
      boundary_face_start: segment.boundary_face_start,
      boundary_face_count: segment.boundary_face_count,
    })),
    mesh_parts: manifest.mesh_parts.map((part) => ({
      id: part.id,
      label: part.label,
      role:
        part.role === "air" ||
        part.role === "magnetic_object" ||
        part.role === "interface" ||
        part.role === "outer_boundary"
          ? part.role
          : "magnetic_object",
      object_id: part.object_id ?? null,
      geometry_id: part.geometry_id ?? null,
      material_id: part.material_id ?? null,
      element_start: part.element_start,
      element_count: part.element_count,
      boundary_face_start: part.boundary_face_start,
      boundary_face_count: part.boundary_face_count,
      boundary_face_indices: part.boundary_face_indices ?? [],
      node_start: part.node_start,
      node_count: part.node_count,
      node_indices: part.node_indices ?? [],
      surface_faces: part.surface_faces ?? [],
      bounds_min: part.bounds_min ?? null,
      bounds_max: part.bounds_max ?? null,
    })),
  };
}

export function mergeFemMeshResource(
  resourceMesh: FemLiveMesh | null,
  currentMesh: FemLiveMesh | null,
): FemLiveMesh | null {
  if (!resourceMesh) {
    return currentMesh;
  }
  if (!currentMesh) {
    return resourceMesh;
  }

  if (meshIdentity(resourceMesh) !== meshIdentity(currentMesh)) {
    return resourceMesh;
  }

  return {
    ...currentMesh,
    ...resourceMesh,
    mesh_name: resourceMesh.mesh_name ?? currentMesh.mesh_name ?? null,
    mesh_id: resourceMesh.mesh_id ?? currentMesh.mesh_id ?? null,
    generation_id: resourceMesh.generation_id ?? currentMesh.generation_id ?? null,
    object_segments:
      currentMesh.object_segments && currentMesh.object_segments.length > 0
        ? currentMesh.object_segments
        : (resourceMesh.object_segments ?? []),
    mesh_parts:
      currentMesh.mesh_parts && currentMesh.mesh_parts.length > 0
        ? currentMesh.mesh_parts
        : (resourceMesh.mesh_parts ?? []),
    per_domain_quality:
      currentMesh.per_domain_quality ?? resourceMesh.per_domain_quality ?? null,
    domain_mesh_mode:
      resourceMesh.domain_mesh_mode ?? currentMesh.domain_mesh_mode ?? null,
    domain_frame:
      resourceMesh.domain_frame ?? currentMesh.domain_frame ?? null,
    topology_buffers:
      resourceMesh.topology_buffers ?? currentMesh.topology_buffers ?? null,
    topology_transport:
      resourceMesh.topology_transport ?? currentMesh.topology_transport ?? null,
    nodes: resourceMesh.nodes,
    elements: resourceMesh.elements,
    boundary_faces: resourceMesh.boundary_faces,
    element_markers:
      resourceMesh.element_markers && resourceMesh.element_markers.length > 0
        ? resourceMesh.element_markers
        : currentMesh.element_markers,
    boundary_markers:
      resourceMesh.boundary_markers && resourceMesh.boundary_markers.length > 0
        ? resourceMesh.boundary_markers
        : currentMesh.boundary_markers,
    node_count: resourceMesh.node_count ?? currentMesh.node_count ?? null,
    element_count: resourceMesh.element_count ?? currentMesh.element_count ?? null,
    boundary_face_count:
      resourceMesh.boundary_face_count ?? currentMesh.boundary_face_count ?? null,
  };
}
