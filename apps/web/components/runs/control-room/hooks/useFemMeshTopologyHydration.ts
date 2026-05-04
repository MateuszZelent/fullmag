import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { FemLiveMesh } from "@/lib/session/types";
import { decodeTopology } from "@/src/api/codecs/topologyCodec";
import { buildFemMeshFromDecodedTopology } from "@/src/hooks/resources/meshFemResource";
import type { createControlRoomApi } from "../controlRoomApi";
import { femMeshTransportKey } from "../binaryFieldCache";

export function useFemMeshTopologyHydration(opts: {
  enabled: boolean;
  liveApi: ReturnType<typeof createControlRoomApi>;
  streamFemMesh: FemLiveMesh | null;
}): FemLiveMesh | null {
  const { enabled, liveApi, streamFemMesh } = opts;
  const femMeshTopologyCacheRef = useRef<Map<string, FemLiveMesh>>(new Map());
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
    const cached = femMeshTopologyCacheRef.current.get(streamFemMeshKey) ?? null;
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
        const cache = femMeshTopologyCacheRef.current;
        cache.set(streamFemMeshKey, nextMesh);
        while (cache.size > 2) {
          const oldestKey = cache.keys().next().value;
          if (!oldestKey) {
            break;
          }
          cache.delete(oldestKey);
        }
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
