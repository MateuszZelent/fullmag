export type DecodedFieldVectorIndexing =
  | "explicit_node_indices"
  | "full_domain"
  | "legacy_count_only"
  | "sampled_node_indices";

export type DecodedFieldVectorScopeKind =
  | "airbox"
  | "full"
  | "layer"
  | "magnetic_only"
  | "object"
  | "part"
  | "region"
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
  /** Canonical CSR cell count. */
  cellCount?: number;
  /** Canonical Fullmag cell type codes: 1=tet4, 2=prism6, 3=pyramid5, 4=hex8. */
  cellTypes?: Uint32Array;
  cellOffsets?: Uint32Array;
  cellNodes?: Uint32Array;
  cellMarkers?: Uint32Array;
  /** Exact backend-owned cell identities. Empty for legacy FMMT payloads. */
  cellGlobalOrdinals?: BigUint64Array;
  /** Canonical CSR facet count. */
  facetCount?: number;
  /** Canonical Fullmag facet type codes: 1=tri3, 2=quad4. */
  facetTypes?: Uint32Array;
  /** Canonical facet role codes: 1=exterior, 2=material_interface, 3=periodic_seam. */
  facetRoles?: Uint32Array;
  facetOffsets?: Uint32Array;
  facetNodes?: Uint32Array;
  facetMarkers?: Uint32Array;
  /** Exact backend-owned facet identities. Empty for legacy FMMT payloads. */
  facetGlobalOrdinals?: BigUint64Array;
  formatVersion?: 1 | 2;
  /** @deprecated Use facetCount. Kept during the FMMT v1 migration window. */
  boundaryFaceCount: number;
  /** @deprecated Use facetNodes. Kept during the FMMT v1 migration window. */
  boundaryFaces: Uint32Array;
  /** @deprecated Use facetMarkers. Kept during the FMMT v1 migration window. */
  boundaryMarkers: Uint32Array;
  /** @deprecated Use cellCount. Kept during the FMMT v1 migration window. */
  elementCount: number;
  /** @deprecated Use cellMarkers. Kept during the FMMT v1 migration window. */
  elementMarkers: Uint32Array;
  /** @deprecated Use cellNodes. Kept during the FMMT v1 migration window. */
  indices: Uint32Array;
  nodeCount: number;
  positions: Float64Array;
}

export type {
  DecodedPeriodicFacePair,
  DecodedPeriodicPair,
  DecodedPeriodicPairs,
  DecodedPeriodicPairsStatus,
} from "./periodicPairsCodec";

export interface DecodedMeshQualityData {
  elementCount: number;
  gamma: Float64Array | null;
  sicn: Float64Array | null;
  volume: Float64Array | null;
  /**
   * v2 channels preserved from the immutable FMMQ carrier.  The legacy
   * ``gamma``/``sicn``/``volume`` projections above remain for existing
   * viewport consumers; typed family and pair metrics must not be discarded
   * merely because they have no v1 projection yet.
   */
  formatVersion?: 1 | 2;
  identity?: Readonly<Record<string, unknown>>;
  metrics?: readonly DecodedMeshQualityMetric[];
}

export interface DecodedMeshQualityMetric {
  id: string;
  unit: string;
  family: string | null;
  ordinalArity: number;
  ordinals: readonly number[];
  values: Float64Array;
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
