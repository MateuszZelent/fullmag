export type DecodedFieldVectorIndexing =
  | "explicit_node_indices"
  | "full_domain"
  | "legacy_count_only"
  | "sampled_node_indices";

export type DecodedFieldVectorScopeKind =
  | "airbox"
  | "full"
  | "magnetic_only"
  | "object"
  | "part"
  | "selection";

export interface DecodedFieldVector {
  dtype: "float64";
  domainGenerationId?: string | null;
  formatVersion?: 2 | 3;
  grid: [number, number, number];
  indexing?: DecodedFieldVectorIndexing;
  meshTopologyHash?: string | null;
  meshTopologyRevision?: string | null;
  nComp: number;
  nodeIndices?: readonly number[] | Uint32Array | null;
  pointCount: number;
  quantityId: string;
  scopeId?: string | null;
  scopeKind?: DecodedFieldVectorScopeKind | null;
  valueCount: number;
  values: Float64Array;
}

export interface DecodedComplexFieldVector {
  componentCount: number;
  dtype: "complex128";
  domainGenerationId?: string | null;
  formatVersion?: 2 | 3;
  grid: [number, number, number];
  indexing?: DecodedFieldVectorIndexing;
  meshTopologyHash?: string | null;
  meshTopologyRevision?: string | null;
  nodeIndices?: readonly number[] | Uint32Array | null;
  pointCount: number;
  quantityId: string;
  scopeId?: string | null;
  scopeKind?: DecodedFieldVectorScopeKind | null;
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

export interface DecodedTableRows {
  columnCount: number;
  cursorEnd: number;
  cursorStart: number;
  resyncRequired: boolean;
  revision: number;
  rowCount: number;
  schemaRevision: number;
  totalRows: number;
  values: Float64Array;
}
