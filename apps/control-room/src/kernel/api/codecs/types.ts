export interface DecodedFieldVector {
  dtype: "float64";
  grid: [number, number, number];
  nComp: number;
  pointCount: number;
  quantityId: string;
  valueCount: number;
  values: Float64Array;
}

export interface DecodedTopology {
  boundaryFaceCount: number;
  boundaryFaces: Uint32Array;
  boundaryMarkers: Uint32Array;
  elementCount: number;
  elementMarkers: Uint32Array;
  indices: Uint32Array;
  nodeCount: number;
  positions: Float64Array;
}

export interface DecodedMeshQualityData {
  elementCount: number;
  gamma: Float64Array | null;
  sicn: Float64Array | null;
  volume: Float64Array | null;
}
