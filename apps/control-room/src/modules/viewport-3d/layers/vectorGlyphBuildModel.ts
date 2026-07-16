import {
  buildVectorGlyphColors,
  buildVectorGlyphTransforms,
  type VectorGlyphInstanceOptions,
  type VectorGlyphTransforms,
} from "./vectorGlyphGeometry";

export interface VectorGlyphBuildRequest {
  colorMode?: string;
  headLengthRatio?: number;
  headRadiusRatio?: number;
  segments: Float32Array;
  shaftRadiusRatio?: number;
}

export interface VectorGlyphBuildResult {
  colors: Float32Array | null;
  sourceFieldBufferId?: string | null;
  sourceResourceKey?: string | null;
  sourceVectorBuildKey?: string | null;
  transforms: VectorGlyphTransforms;
}

export function buildViewport3DVectorGlyphs(
  request: VectorGlyphBuildRequest,
): VectorGlyphBuildResult {
  const options: VectorGlyphInstanceOptions = {
    colorMode: request.colorMode,
    headLengthRatio: request.headLengthRatio,
    headRadiusRatio: request.headRadiusRatio,
    shaftRadiusRatio: request.shaftRadiusRatio,
  };
  return {
    colors: buildVectorGlyphColors(request.segments, request.colorMode),
    transforms: buildVectorGlyphTransforms(request.segments, options),
  };
}

export function transferablesForVectorGlyphBuildResult(
  result: VectorGlyphBuildResult,
): Transferable[] {
  const transferables: Transferable[] = [];
  addArrayBufferTransferable(transferables, result.colors?.buffer);
  addArrayBufferTransferable(
    transferables,
    result.transforms.directions.buffer,
  );
  addArrayBufferTransferable(
    transferables,
    result.transforms.headCenters.buffer,
  );
  addArrayBufferTransferable(
    transferables,
    result.transforms.headScales.buffer,
  );
  addArrayBufferTransferable(
    transferables,
    result.transforms.shaftCenters.buffer,
  );
  addArrayBufferTransferable(
    transferables,
    result.transforms.shaftScales.buffer,
  );
  return transferables;
}

function addArrayBufferTransferable(
  transferables: Transferable[],
  buffer: ArrayBufferLike | undefined,
): void {
  if (buffer instanceof ArrayBuffer) {
    transferables.push(buffer);
  }
}
