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

export interface DecodedCrossSection {
  bounds: {
    uMax: number;
    uMin: number;
    vMax: number;
    vMin: number;
  };
  intersectionEdgeNodeIds: Uint32Array;
  intersectionEdgeT: Float32Array;
  intersectionKinds: Uint32Array;
  intersectionWorld: Float32Array;
  parentElementIds: Uint32Array;
  polygonCount: number;
  polygonOffsets: Uint32Array;
  segmentCount: number;
  segments: Float32Array;
  vertexCount: number;
  vertices: Float32Array;
}

export interface DecodedCrossSectionQuality {
  perElementQuality: Float32Array;
  range: {
    max: number;
    min: number;
  };
}
