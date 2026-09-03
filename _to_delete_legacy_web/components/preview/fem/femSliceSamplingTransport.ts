import type { FemMeshPart } from "../../../lib/session/types";
import type { FemMeshData } from "./femMeshTypes";
import type {
  SliceBoundsStrategy,
  SliceCollection,
  SlicePlane,
  SliceTopologyCollection,
  VectorComponent,
} from "./femSliceGeometry";
import type { SliceVisibilityState } from "./femSliceUtils";

type TransferListItem = ArrayBuffer;

export interface FemSliceSamplingMeshPayload {
  nodes: Float32Array | Float64Array;
  elements: Int32Array | Uint32Array | Uint16Array;
  boundaryFaces: Int32Array | Uint32Array | Uint16Array;
  nNodes: number;
  nElements: number;
  fieldData?: {
    x: Float32Array | Float64Array;
    y: Float32Array | Float64Array;
    z: Float32Array | Float64Array;
  };
  fieldNComp?: number;
  fieldRevision?: number | string | null;
}

export interface FemSliceSamplingVisibilityPayload {
  visibleElements: Uint8Array | null;
  visibleBoundaryFaces: Uint8Array | null;
  elementPartIds: (string | null)[];
  boundaryFacePartIds: (string | null)[];
  visiblePartIds: string[];
  visibleParts: Array<Pick<FemMeshPart, "id" | "bounds_min" | "bounds_max">>;
}

export interface FemSliceSamplingPayload {
  meshData: FemSliceSamplingMeshPayload;
  plane: SlicePlane;
  planeCoord: number;
  component: VectorComponent;
  visibilityState: FemSliceSamplingVisibilityPayload;
  boundsStrategy: SliceBoundsStrategy;
}

export interface FemSliceSamplingRequest {
  id: number;
  type: "compute";
  payload: FemSliceSamplingPayload;
}

export interface FemSliceSamplingSuccess {
  id: number;
  ok: true;
  topology: SliceTopologyCollection;
  slice: SliceCollection;
  topologyDurationMs: number;
  fieldDurationMs: number;
}

export interface FemSliceSamplingFailure {
  id: number;
  ok: false;
  error: string;
}

export type FemSliceSamplingResponse = FemSliceSamplingSuccess | FemSliceSamplingFailure;

export interface BuiltFemSliceSamplingWorkerPayload {
  message: FemSliceSamplingRequest;
  transferList: TransferListItem[];
  estimatedBytes: number;
}

function addTransfer(view: ArrayBufferView, transferList: TransferListItem[]): number {
  if (!(view.buffer instanceof ArrayBuffer)) {
    return 0;
  }
  transferList.push(view.buffer);
  return view.buffer.byteLength;
}

function copyFloatArray(source: ArrayLike<number>): Float32Array | Float64Array {
  if (source instanceof Float32Array) return new Float32Array(source);
  if (source instanceof Float64Array) return new Float64Array(source);
  return new Float64Array(Array.from(source));
}

function copyIndexArray(source: ArrayLike<number>): Int32Array | Uint32Array | Uint16Array {
  if (source instanceof Uint16Array) return new Uint16Array(source);
  if (source instanceof Uint32Array) return new Uint32Array(source);
  if (source instanceof Int32Array) return new Int32Array(source);
  return new Uint32Array(Array.from(source));
}

function copyUint8Array(source: Uint8Array | null): Uint8Array | null {
  return source ? new Uint8Array(source) : null;
}

function buildVisibilityPayload(
  visibilityState: SliceVisibilityState,
  transferList: TransferListItem[],
): { payload: FemSliceSamplingVisibilityPayload; estimatedBytes: number } {
  let estimatedBytes = 0;
  const visibleElements = copyUint8Array(visibilityState.visibleElements);
  const visibleBoundaryFaces = copyUint8Array(visibilityState.visibleBoundaryFaces);
  if (visibleElements) estimatedBytes += addTransfer(visibleElements, transferList);
  if (visibleBoundaryFaces) estimatedBytes += addTransfer(visibleBoundaryFaces, transferList);

  const visiblePartIds = Array.from(visibilityState.visiblePartIds);
  const visibleParts = visiblePartIds.flatMap((partId) => {
    const part = visibilityState.partById.get(partId);
    return part
      ? [
          {
            id: part.id,
            bounds_min: part.bounds_min,
            bounds_max: part.bounds_max,
          },
        ]
      : [];
  });

  return {
    payload: {
      visibleElements,
      visibleBoundaryFaces,
      elementPartIds: visibilityState.elementPartIds.slice(),
      boundaryFacePartIds: visibilityState.boundaryFacePartIds.slice(),
      visiblePartIds,
      visibleParts,
    },
    estimatedBytes,
  };
}

export function visibilityPayloadToState(payload: FemSliceSamplingVisibilityPayload): SliceVisibilityState {
  return {
    visibleElements: payload.visibleElements,
    visibleBoundaryFaces: payload.visibleBoundaryFaces,
    elementPartIds: payload.elementPartIds,
    boundaryFacePartIds: payload.boundaryFacePartIds,
    partById: new Map(payload.visibleParts.map((part) => [part.id, part as FemMeshPart])),
    visiblePartIds: new Set(payload.visiblePartIds),
  };
}

export function buildFemSliceSamplingWorkerPayload(args: {
  id: number;
  meshData: FemMeshData;
  plane: SlicePlane;
  planeCoord: number;
  component: VectorComponent;
  visibilityState: SliceVisibilityState;
  boundsStrategy: SliceBoundsStrategy;
}): BuiltFemSliceSamplingWorkerPayload {
  const transferList: TransferListItem[] = [];
  let estimatedBytes = 0;
  const nodes = copyFloatArray(args.meshData.nodes);
  const elements = copyIndexArray(args.meshData.elements);
  const boundaryFaces = copyIndexArray(args.meshData.boundaryFaces);
  estimatedBytes += addTransfer(nodes, transferList);
  estimatedBytes += addTransfer(elements, transferList);
  estimatedBytes += addTransfer(boundaryFaces, transferList);

  const fieldData = args.meshData.fieldData
    ? {
        x: copyFloatArray(args.meshData.fieldData.x),
        y: copyFloatArray(args.meshData.fieldData.y),
        z: copyFloatArray(args.meshData.fieldData.z),
      }
    : undefined;
  if (fieldData) {
    estimatedBytes += addTransfer(fieldData.x, transferList);
    estimatedBytes += addTransfer(fieldData.y, transferList);
    estimatedBytes += addTransfer(fieldData.z, transferList);
  }

  const visibility = buildVisibilityPayload(args.visibilityState, transferList);
  estimatedBytes += visibility.estimatedBytes;

  return {
    message: {
      id: args.id,
      type: "compute",
      payload: {
        meshData: {
          nodes,
          elements,
          boundaryFaces,
          nNodes: args.meshData.nNodes,
          nElements: args.meshData.nElements,
          fieldData,
          fieldNComp: args.meshData.fieldNComp,
          fieldRevision: args.meshData.fieldRevision,
        },
        plane: args.plane,
        planeCoord: args.planeCoord,
        component: args.component,
        visibilityState: visibility.payload,
        boundsStrategy: args.boundsStrategy,
      },
    },
    transferList,
    estimatedBytes,
  };
}
