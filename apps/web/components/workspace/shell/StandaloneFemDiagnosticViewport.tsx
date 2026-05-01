"use client";

import { useEffect, useMemo, useState } from "react";
import FemMeshView3D, { type FemMeshData } from "@/components/preview/FemMeshView3D";
import { useResourceApi } from "@/src/providers/ResourceApiProvider";
import { decodeTopology } from "@/src/api/codecs/topologyCodec";
import type { FemLiveMesh } from "@/lib/session/types";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendRender } from "@/lib/debug/frontendPerfDebug";

function flattenFemMesh(mesh: FemLiveMesh): FemMeshData {
  // Fast path: topology_buffers are the canonical typed representation.
  // Avoid per-element Proxy traversal when binary topology is available.
  const tb = mesh.topology_buffers;
  if (tb && tb.nodes.length > 0) {
    return {
      nodes: tb.nodes,
      elements: tb.elements,
      boundaryFaces: tb.boundary_faces,
      nNodes: mesh.node_count ?? Math.floor(tb.nodes.length / 3),
      nElements: mesh.element_count ?? Math.floor(tb.elements.length / 4),
      meshGenerationId: mesh.generation_id ?? mesh.mesh_id ?? null,
      fieldData: undefined,
      activeMask: null,
      quantityDomain: "full_domain",
    };
  }
  // Legacy fallback for JSON-transported meshes without typed buffers.
  const flatNodes = new Float64Array(mesh.nodes.length * 3);
  for (let i = 0; i < mesh.nodes.length; i += 1) {
    const node = mesh.nodes[i];
    flatNodes[i * 3] = node[0];
    flatNodes[i * 3 + 1] = node[1];
    flatNodes[i * 3 + 2] = node[2];
  }
  const flatElements = new Uint32Array(mesh.elements.length * 4);
  for (let i = 0; i < mesh.elements.length; i += 1) {
    const element = mesh.elements[i];
    flatElements[i * 4] = element[0];
    flatElements[i * 4 + 1] = element[1];
    flatElements[i * 4 + 2] = element[2];
    flatElements[i * 4 + 3] = element[3];
  }
  const flatFaces = new Uint32Array(mesh.boundary_faces.length * 3);
  for (let i = 0; i < mesh.boundary_faces.length; i += 1) {
    const face = mesh.boundary_faces[i];
    flatFaces[i * 3] = face[0];
    flatFaces[i * 3 + 1] = face[1];
    flatFaces[i * 3 + 2] = face[2];
  }
  return {
    nodes: flatNodes,
    elements: flatElements,
    boundaryFaces: flatFaces,
    nNodes: mesh.nodes.length,
    nElements: mesh.elements.length,
    meshGenerationId: mesh.generation_id ?? mesh.mesh_id ?? null,
    fieldData: undefined,
    activeMask: null,
    quantityDomain: "full_domain",
  };
}

export default function StandaloneFemDiagnosticViewport() {
  const client = useResourceApi();

  if (FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging) {
    recordFrontendRender("StandaloneFemDiagnosticViewport");
  }

  const [mesh, setMesh] = useState<FemLiveMesh | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fps, setFps] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void client
      .domain.getTopology()
      .then((buffer) => {
        if (cancelled) return;
        const topology = decodeTopology(buffer);
        const nextMesh: FemLiveMesh = {
          mesh_name: "diagnostic-topology",
          mesh_id: "diagnostic-topology",
          generation_id: "diagnostic-topology",
          nodes: Array.from({ length: topology.nodeCount }, (_, index) => {
            const base = index * 3;
            return [
              topology.positions[base] ?? 0,
              topology.positions[base + 1] ?? 0,
              topology.positions[base + 2] ?? 0,
            ];
          }),
          elements: Array.from({ length: topology.elementCount }, (_, index) => {
            const base = index * 4;
            return [
              topology.indices[base] ?? 0,
              topology.indices[base + 1] ?? 0,
              topology.indices[base + 2] ?? 0,
              topology.indices[base + 3] ?? 0,
            ];
          }),
          element_markers: Array.from(topology.elementMarkers),
          boundary_faces: Array.from({ length: topology.boundaryFaceCount }, (_, index) => {
            const base = index * 3;
            return [
              topology.boundaryFaces[base] ?? 0,
              topology.boundaryFaces[base + 1] ?? 0,
              topology.boundaryFaces[base + 2] ?? 0,
            ];
          }),
          boundary_markers: Array.from(topology.boundaryMarkers),
          object_segments: [],
          mesh_parts: [],
          node_count: topology.nodeCount,
          element_count: topology.elementCount,
          boundary_face_count: topology.boundaryFaceCount,
        };
        if (!nextMesh || nextMesh.nodes.length === 0 || nextMesh.elements.length === 0) {
          setError("Topology loaded, but no FEM mesh was available.");
          setMesh(null);
          return;
        }
        setMesh(nextMesh);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setMesh(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let frameId = 0;
    let disposed = false;
    let frames = 0;
    const sampleRef = { time: performance.now() };

    const tick = () => {
      if (disposed) {
        return;
      }
      frameId = window.requestAnimationFrame(tick);
      frames += 1;
      const now = performance.now();
      const elapsed = now - sampleRef.time;
      if (elapsed >= 500) {
        setFps(Math.round((frames * 1000) / elapsed));
        frames = 0;
        sampleRef.time = now;
      }
    };

    frameId = window.requestAnimationFrame(tick);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
    };
  }, []);

  const meshData = useMemo(() => (mesh ? flattenFemMesh(mesh) : null), [mesh]);
  const topologyKey = useMemo(() => {
    if (!meshData) {
      return null;
    }
    const generation = mesh?.generation_id ?? mesh?.mesh_id ?? meshData.meshGenerationId ?? null;
    if (typeof generation === "string" && generation.length > 0) {
      return `gen:${generation}`;
    }
    return `diag:${meshData.nNodes}:${meshData.nElements}:${meshData.boundaryFaces.length}`;
  }, [mesh, meshData]);

  return (
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
      {meshData && topologyKey ? (
        <FemMeshView3D
          topologyKey={topologyKey}
          meshData={meshData}
          toolbarMode="hidden"
          renderMode="surface"
          objectSegments={mesh?.object_segments ?? []}
          meshParts={mesh?.mesh_parts ?? []}
          elementMarkers={mesh?.element_markers ?? null}
          perDomainQuality={mesh?.per_domain_quality ?? null}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {loading ? "Loading FEM topology..." : error ?? "No FEM mesh available"}
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80">
        <div>Standalone FEM diagnostic viewport</div>
        <div>{loading ? "Status: loading" : meshData ? "Status: loaded" : `Status: ${error ?? "empty"}`}</div>
        <div>{fps == null ? "FPS: measuring..." : `FPS: ${fps}`}</div>
        {mesh ? <div>{`${mesh.nodes.length.toLocaleString()} nodes, ${mesh.elements.length.toLocaleString()} tets`}</div> : null}
      </div>
    </div>
  );
}
