import { startTransition, useEffect, useMemo, useState } from "react";
import type { FemLiveMesh } from "@/lib/session/types";
import { decodeTopology } from "@/src/api/codecs/topologyCodec";
import { buildFemMeshFromDecodedTopology } from "@/src/hooks/resources/meshFemResource";
import type { createControlRoomApi } from "../controlRoomApi";
import { femMeshTransportKey } from "../binaryFieldCache";

const GLOBAL_FEM_MESH_TOPOLOGY_CACHE_MAX_ENTRIES = 2;
const globalFemMeshTopologyCache = new Map<string, FemLiveMesh>();

export function getGlobalFemMeshTopologyFrame(key: string): FemLiveMesh | null {
  const frame = globalFemMeshTopologyCache.get(key) ?? null;
  if (!frame) {
    return null;
  }
  globalFemMeshTopologyCache.delete(key);
  globalFemMeshTopologyCache.set(key, frame);
  return frame;
}

export function putGlobalFemMeshTopologyFrame(key: string, mesh: FemLiveMesh): void {
  globalFemMeshTopologyCache.set(key, mesh);
  while (globalFemMeshTopologyCache.size > GLOBAL_FEM_MESH_TOPOLOGY_CACHE_MAX_ENTRIES) {
    const oldestKey = globalFemMeshTopologyCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    globalFemMeshTopologyCache.delete(oldestKey);
  }
}

export function clearGlobalFemMeshTopologyCache(): void {
  globalFemMeshTopologyCache.clear();
}

export function useFemMeshTopologyHydration(opts: {
  enabled: boolean;
  liveApi: ReturnType<typeof createControlRoomApi>;
  streamFemMesh: FemLiveMesh | null;
}): FemLiveMesh | null {
  const { enabled, liveApi, streamFemMesh } = opts;
  const [hydratedFemMesh, setHydratedFemMesh] = useState<FemLiveMesh | null>(null);
  const streamFemMeshKey = useMemo(() => femMeshTransportKey(streamFemMesh), [streamFemMesh]);
  const needsBinaryFemTopologyHydration =
    enabled &&
    streamFemMesh?.topology_transport === "binary" &&
    !streamFemMesh.topology_buffers;

  useEffect(() => {
    if (!needsBinaryFemTopologyHydration || !streamFemMesh || !streamFemMeshKey) {
      setHydratedFemMesh(null);
      return;
    }
    const cached = getGlobalFemMeshTopologyFrame(streamFemMeshKey);
    if (cached) {
      setHydratedFemMesh(cached);
      return;
    }
    setHydratedFemMesh(null);
    const controller = new AbortController();
    void liveApi
      .getFemMeshTopologyBinary(streamFemMesh.generation_id ?? null, {
        signal: controller.signal,
      })
      .then((buffer) => {
        const topo = decodeTopology(buffer);
        const decodedMesh = buildFemMeshFromDecodedTopology(topo, null, {
          legacyArrays: "lazy",
        });
        const nextMesh: FemLiveMesh = {
          ...streamFemMesh,
          ...decodedMesh,
          mesh_name: streamFemMesh.mesh_name ?? decodedMesh.mesh_name,
          mesh_id: streamFemMesh.mesh_id ?? decodedMesh.mesh_id,
          generation_id: streamFemMesh.generation_id ?? decodedMesh.generation_id,
          object_segments: streamFemMesh.object_segments ?? decodedMesh.object_segments,
          mesh_parts: streamFemMesh.mesh_parts ?? decodedMesh.mesh_parts,
          domain_mesh_mode: streamFemMesh.domain_mesh_mode ?? decodedMesh.domain_mesh_mode ?? null,
          domain_frame: streamFemMesh.domain_frame ?? decodedMesh.domain_frame ?? null,
        };
        putGlobalFemMeshTopologyFrame(streamFemMeshKey, nextMesh);
        if (!controller.signal.aborted) {
          startTransition(() => setHydratedFemMesh(nextMesh));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHydratedFemMesh(null);
        }
      });
    return () => controller.abort();
  }, [
    liveApi,
    needsBinaryFemTopologyHydration,
    streamFemMesh,
    streamFemMeshKey,
  ]);

  return hydratedFemMesh && streamFemMeshKey && femMeshTransportKey(hydratedFemMesh) === streamFemMeshKey
    ? hydratedFemMesh
    : streamFemMesh;
}
