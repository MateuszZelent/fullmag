import { sliceAxisBoundsFromMesh, sliceAxisMagneticExtent } from "./axisMapping";

export function computeSliceAutoCenter(args: {
  meshNodes: ArrayLike<number>;
  nNodes: number;
  normalAxisIndex: 0 | 1 | 2;
  visibleElements?: Uint8Array | null;
  elements?: ArrayLike<number> | null;
  nElements?: number;
}): { centerWorld: number; magneticMin: number; magneticMax: number } {
  const axis = args.normalAxisIndex === 0 ? "x" : args.normalAxisIndex === 1 ? "y" : "z";
  const fullBounds = sliceAxisBoundsFromMesh(args.meshNodes, args.nNodes, axis);
  const extent = sliceAxisMagneticExtent(
    args.meshNodes,
    args.nNodes,
    axis,
    args.visibleElements,
    args.elements,
  ) ?? fullBounds;
  return {
    centerWorld: (extent.min + extent.max) * 0.5,
    magneticMin: extent.min,
    magneticMax: extent.max,
  };
}
