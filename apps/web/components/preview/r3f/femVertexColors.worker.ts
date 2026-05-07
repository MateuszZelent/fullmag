import type { FemColorField, FemMeshData } from "../fem/femMeshTypes";
import { computeVertexColors } from "./femVertexColorsCore";

interface ComputeVertexColorsRequest {
  id: number;
  type: "compute";
  payload: {
    nNodes: number;
    field: FemColorField;
    fieldData: FemMeshData["fieldData"] | undefined;
    fieldNComp: number;
    nodes: ArrayLike<number>;
    boundaryFaces: ArrayLike<number>;
    qualityPerFace?: number[] | null;
  };
}

type ComputeVertexColorsResponse =
  | { id: number; ok: true; colors: Float32Array }
  | { id: number; ok: false; error: string };

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ComputeVertexColorsRequest>) => void) | null;
  postMessage: (message: ComputeVertexColorsResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = (event: MessageEvent<ComputeVertexColorsRequest>) => {
  const message = event.data;
  if (!message || message.type !== "compute") {
    return;
  }
  try {
    const { nNodes, field, fieldData, fieldNComp, nodes, boundaryFaces, qualityPerFace } = message.payload;
    const colors = computeVertexColors(
      nNodes,
      field,
      fieldData,
      fieldNComp,
      nodes,
      boundaryFaces,
      qualityPerFace,
    );
    workerScope.postMessage({ id: message.id, ok: true, colors }, [colors.buffer]);
  } catch (error) {
    workerScope.postMessage({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : "vertex color worker failure",
    });
  }
};

export {};
