import type { Viewport3DVisibleColorScale } from "../model/viewport3DVisibleColorScale";
import {
  buildVectorGlyphColors,
  buildVectorGlyphTransforms,
  type VectorGlyphInstanceOptions,
  type VectorGlyphTransforms,
} from "./vectorGlyphGeometry";

export interface VectorGlyphBuildRequest {
  colorScale?: Viewport3DVisibleColorScale | null;
  colorsOverride?: Float32Array | null;
  colorMode?: string;
  headLengthRatio?: number;
  headRadiusRatio?: number;
  segments: Float32Array;
  shaftRadiusRatio?: number;
}

export interface VectorGlyphBuildResult {
  colorScale?: Viewport3DVisibleColorScale | null;
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
  const transforms = buildVectorGlyphTransforms(request.segments, options);
  if (request.colorsOverride && request.colorsOverride.length !== transforms.count * 3) {
    throw new RangeError("Vector glyph colors do not match the source transforms");
  }
  return {
    ...(request.colorScale !== undefined ? { colorScale: request.colorScale
      ? { ...request.colorScale, range: { ...request.colorScale.range } } : null } : {}),
    // Own this copy: worker output transfer must not detach the input buffer.
    colors: request.colorsOverride?.slice() ?? buildVectorGlyphColors(request.segments, request.colorMode),
    transforms,
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
