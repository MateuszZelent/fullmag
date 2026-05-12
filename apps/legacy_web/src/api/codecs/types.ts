/**
 * Codec types for binary field and topology payloads.
 */

export interface DecodedFieldVector {
  quantityId: string;
  nComp: number;
  grid: [number, number, number];
  pointCount: number;
  valueCount: number;
  dtype: "float64";
  values: Float64Array;
}

export interface DecodedTopology {
  nodeCount: number;
  elementCount: number;
  boundaryFaceCount: number;
  positions: Float64Array;
  indices: Uint32Array;
  boundaryFaces: Uint32Array;
  elementMarkers: Uint32Array;
  boundaryMarkers: Uint32Array;
}
