import {
  buildViewport3DTopologyIndexBundle,
  transferablesForTopologyIndexBundle,
  type Viewport3DTopologyIndexPartInput,
} from "./viewport3dTopologyIndexModel";

interface TopologyIndexWorkerRequest {
  airboxParts: readonly Viewport3DTopologyIndexPartInput[];
  id: number;
  magneticParts: readonly Viewport3DTopologyIndexPartInput[];
  magneticSurfacePartsByPartIdEntries: Array<
    [string, Viewport3DTopologyIndexPartInput[]]
  >;
  topology: {
    boundaryFaces: Uint32Array;
    cellNodes?: Uint32Array;
    cellOffsets?: Uint32Array;
    cellTypes?: Uint32Array;
    facetNodes?: Uint32Array;
    facetOffsets?: Uint32Array;
    facetTypes?: Uint32Array;
    indices: Uint32Array;
    nodeCount: number;
  };
}

interface TopologyIndexWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<TopologyIndexWorkerRequest>) => void,
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as TopologyIndexWorkerScope;

workerScope.addEventListener(
  "message",
  (event: MessageEvent<TopologyIndexWorkerRequest>) => {
    const {
      airboxParts,
      id,
      magneticParts,
      magneticSurfacePartsByPartIdEntries,
      topology,
    } = event.data;
    try {
      const data = buildViewport3DTopologyIndexBundle({
        airboxParts,
        magneticParts,
        magneticSurfacePartsByPartId: new Map(
          magneticSurfacePartsByPartIdEntries,
        ),
        topology,
      });
      workerScope.postMessage(
        { data, id, ok: true },
        transferablesForTopologyIndexBundle(data),
      );
    } catch (error) {
      workerScope.postMessage({
        error: serializeError(error),
        id,
        ok: false,
      });
    }
  },
);

function serializeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: String(error),
    name: "Error",
  };
}
