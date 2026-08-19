import type {
  DomainMetaResource,
  UniverseResource,
} from "@/kernel/api/apiTypes";
import type {
  DecodedComplexFieldVector,
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";
import {
  memoryBudgetRegistry,
  type MemoryBudgetEntry,
} from "@/kernel/performance/MemoryBudgetRegistry";
import type { SurfaceFieldProjectionMode } from "@/kernel/visualization/ObjectVisualizationController";
import { buildAirOnlyVisualizationNodeSelection } from "@/shared/domain/mesh/visualizationNodeSelection";

import {
  buildMappedVertexScalarColors,
  buildSurfaceFaceScalarColors,
  buildThicknessAverageZScalarColors,
  buildVertexScalarColors,
  fieldVectorUsesDirectNodeOrder,
  type ScalarColorBuffer,
  type ScalarRange,
} from "./viewport3dFieldMapping";
import { buildViewport3DVectorGlyphJobKey } from "./build-engine/viewport3dBuildJobKeys";
import {
  planViewport3DDerivedWorkItems,
  type Viewport3DDerivedWorkItem,
} from "./model/viewport3DDerivedWorkPlan";
import type { Viewport3DTargetRenderPlan } from "./model/viewport3DFieldDataPlan";
import {
  summarizeViewport3DTargetDiagnostics,
  type Viewport3DTargetDiagnosticSummary,
} from "./model/viewport3DTargetDiagnostics";
import {
  resolveViewport3DTargetFieldInput,
  viewport3DTargetFieldBufferCanServeSurface,
  viewport3DTargetFieldBufferCanServeVectors,
  viewport3DTargetFieldBufferMatchesQuantity,
  type Viewport3DTargetFieldBuffer,
} from "./model/viewport3DTargetFieldBuffer";
import { resolveViewport3DFieldDomainCompatibility } from "./model/viewport3DFieldDomainCompatibility";
import {
  buildPartSurfaceIndices as buildPartSurfaceIndicesUncached,
  buildPartSurfaceIndicesWithSupplemental as buildPartSurfaceIndicesWithSupplementalUncached,
  buildPartSurfaceEdgeIndicesWithSupplemental,
  buildPartSurfaceTriangleFacetIndicesWithSupplemental,
  buildPartVolumeEdgeIndices as buildPartVolumeEdgeIndicesUncached,
  buildTopologySurfaceIndices,
  buildTopologySurfaceEdgeIndices,
  buildTopologyVolumeEdgeIndices,
  buildUnclaimedVolumeEdgeIndices,
  uniqueSortedIndices,
  type Viewport3DPreparedPartTopologyIndices,
  type Viewport3DTopologyIndexBundle,
} from "./viewport3dTopologyIndexModel";

export {
  buildTetraSurfaceIndices,
  buildTetraVolumeEdgeIndices,
} from "./viewport3dTopologyIndexModel";

export const FULL_VIEWPORT_3D_TARGET_ID = "full";

export interface Viewport3DNodeSelection {
  nodeCount?: number;
  node_count?: number;
  nodeIndices?: readonly number[];
  node_indices?: readonly number[];
  nodeStart?: number;
  node_start?: number;
}

export interface Viewport3DSurfacePart extends Viewport3DNodeSelection {
  boundary_face_count: number;
  boundary_face_indices?: readonly number[];
  boundary_face_start: number;
  element_count?: number;
  element_start?: number;
  surface_node_indices?: readonly number[] | null;
  surface_faces?: readonly (readonly number[])[];
}

export interface Viewport3DRenderablePart extends Viewport3DSurfacePart {
  id: string;
}

export interface Viewport3DBounds {
  center: [number, number, number];
  radius: number;
  size: [number, number, number];
}

export interface Viewport3DTopologyPartRenderModel<
  TPart extends Viewport3DRenderablePart = Viewport3DRenderablePart,
> {
  edgeIndices: Uint32Array | null;
  fullNodeSelection: Viewport3DNodeSelection;
  part: TPart;
  surfaceIndices: Uint32Array | null;
  surfaceTriangleCellTypes?: Uint32Array | null;
  surfaceTriangleFacetIndices?: Uint32Array | null;
  surfaceTriangleGlobalCellOrdinals?: BigUint64Array | null;
  surfaceNodeIndices: Uint32Array | null;
  surfaceNodeSelection: Viewport3DNodeSelection | null;
  volumeEdgeIndices: Uint32Array | null;
}

export interface Viewport3DTopologyRenderModel<
  TPart extends Viewport3DRenderablePart = Viewport3DRenderablePart,
> {
  fallbackSurfaceEdgeIndices: Uint32Array | null;
  fallbackSurfaceIndices: Uint32Array;
  fallbackSurfaceNodeIndices: Uint32Array;
  fallbackVolumeEdgeIndices: Uint32Array;
  magneticParts: Array<Viewport3DTopologyPartRenderModel<TPart>>;
  airboxParts: Array<Viewport3DTopologyPartRenderModel<TPart>>;
  meshGenerationId: string | null;
  meshRevision: number | string | null;
  meshTopologyHash: string | null;
  nodeCount: number;
  positions: Float32Array;
}

export const EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES = new Uint32Array();
const EMPTY_VIEWPORT_3D_NODE_SELECTION: Viewport3DNodeSelection = {
  nodeIndices: [],
};

export type Viewport3DTopologyIndexState =
  | "pending"
  | "ready"
  | "unavailable";

export interface Viewport3DTopologyRenderModelOptions {
  topologyIndexBundle?: Viewport3DTopologyIndexBundle | null;
  topologyIndexState?: Viewport3DTopologyIndexState;
}

export interface Viewport3DFieldRenderModel {
  /**
   * Analysis overlay intent is active even while its binary payload is still
   * loading. Mesh layers use this to suppress authored magnetization previews
   * during the handoff to the analysis shader.
   */
  analysisOverlayActive?: boolean;
  /** Legacy global overlay is retained only for driven frequency response. */
  legacyResponseOverlayActive?: boolean;
  complexFieldVector: DecodedComplexFieldVector | null;
  derivedWorkItems: Viewport3DDerivedWorkItem[];
  fullVectorBuild: Viewport3DVectorBuildReference | null;
  fullVectorSegments: Float32Array | null;
  modeOverlay: Viewport3DModeFieldOverlayRenderState | null;
  partVectorBuilds: Map<string, Viewport3DVectorBuildReference | null>;
  partVectorSegments: Map<string, Float32Array | null>;
  scalarColors: ScalarColorBuffer | null;
  scalarColorsByPartAndMode: Map<string, Map<string, ScalarColorBuffer | null>>;
  scalarColorsByMode: Map<string, ScalarColorBuffer | null>;
  targetDiagnostics: Viewport3DTargetDiagnosticSummary[];
  targetPasses: Map<string, Viewport3DTargetRenderPassModel>;
  visualizationPhaseRad: number | null;
}

export interface Viewport3DModeFieldOverlayRenderState {
  phasorAmplitudeMax: number;
  phasorPhaseRad: number;
  representation: string;
}

export type Viewport3DTargetFieldBufferState =
  | "derived-global"
  | "legacy-implicit"
  | "missing"
  | "target-buffer";

export type Viewport3DTargetPassDegradation =
  | "buffer-quantity-mismatch"
  | "buffer-not-surface-capable"
  | "buffer-not-vector-capable"
  | "sampled-buffer-not-surface-capable"
  | "scalar-buffer-not-vector-capable"
  | "surface-colors-unavailable"
  | "vector-segments-unavailable";

export interface Viewport3DTargetFieldBufferSource {
  bufferId: string;
  capability: Viewport3DTargetFieldBuffer["capability"];
  component: Viewport3DTargetFieldBuffer["component"];
  consumers: readonly string[];
  currentDomainGenerationId?: string | null;
  currentMeshTopologyHash?: string | null;
  decodedFieldVector: DecodedFieldVector | null;
  fieldRevision: string | null;
  indexing?: Viewport3DTargetFieldBuffer["indexing"];
  meshTopologyHash?: string | null;
  domainGenerationId?: string | null;
  nodeIndexCount?: number | null;
  nodeIndices?: Viewport3DTargetFieldBuffer["nodeIndices"];
  pointCount: number;
  quantityId: string;
  requestId: string | null;
  resourceKey: string | null;
  sampled: boolean;
  scopeId: string | null;
  scopeKind: Viewport3DTargetFieldBuffer["scopeKind"];
  topologyRevision: string | null;
  componentCount: number;
  values: Viewport3DTargetFieldBuffer["values"];
  vectorComponentCount: number;
}

export interface Viewport3DTargetRenderPassModel {
  fieldBuffer: Viewport3DTargetFieldBufferSource | null;
  fieldBufferState: Viewport3DTargetFieldBufferState;
  surface: {
    degradation: Viewport3DTargetPassDegradation | null;
    passId: string;
    projectionMode?: SurfaceFieldProjectionMode;
    scalarColorMode: string | null;
    scalarColors: ScalarColorBuffer | null;
  };
  vectors: {
    buildReference: Viewport3DVectorBuildReference | null;
    degradation: Viewport3DTargetPassDegradation | null;
    passId: string;
    segments: Float32Array | null;
  };
}

export interface Viewport3DVectorBuildReference {
  buildKey: string;
  fieldBufferId?: string | null;
  fieldRevision: string;
  groupKey: string;
  resourceKey?: string | null;
  revisionSummary: string;
  targetRevision: string;
  topologyRevision: string;
}

export interface Viewport3DFieldRenderOptions {
  analysisOverlayActive?: boolean;
  legacyResponseOverlayActive?: boolean;
  buildDomainId?: string;
  buildSessionId?: string;
  fullScalarColorMode?: string;
  fullScalarColorPalette?: string;
  fullVectorBudget?: number;
  fullVectorAnchorMode?: Viewport3DVectorAnchorMode;
  fullVectorSurfaceOffsetEnabled?: boolean;
  fullVectorSurfaceOffsetScale?: number;
  complexFieldVector?: DecodedComplexFieldVector | null;
  modeOverlay?: {
    phasorAmplitudeMax: number;
    representation: string;
  } | null;
  partFieldVectors?: ReadonlyMap<string, DecodedFieldVector>;
  partTargetFieldBuffers?: ReadonlyMap<string, Viewport3DTargetFieldBuffer>;
  partQuantityIds?: ReadonlyMap<string, string>;
  partScalarColorModes?: ReadonlyMap<string, string>;
  partScalarColorPalettes?: ReadonlyMap<string, string>;
  partScalarRangesByMode?: ReadonlyMap<string, ReadonlyMap<string, ScalarRange>>;
  targetRenderPlans?: ReadonlyMap<string, Viewport3DTargetRenderPlan>;
  partVectorAnchorModes?: ReadonlyMap<string, Viewport3DVectorAnchorMode>;
  partVectorBudgets?: ReadonlyMap<string, number>;
  partVectorScales?: ReadonlyMap<string, number>;
  partVectorScopes?: ReadonlyMap<string, "surface" | "full">;
  partVectorSurfaceOffsetEnabled?: ReadonlySet<string>;
  partVectorSurfaceOffsetScales?: ReadonlyMap<string, number>;
  scalarColorModes?: ReadonlySet<string>;
  scalarColorPalette?: string;
  scalarRangesByMode?: ReadonlyMap<string, ScalarRange>;
  scalarColorsVisible?: boolean;
  fieldRevision?: string | number | null;
  targetVisualizationRevision?: string | number | null;
  topologyRevision?: string | number | null;
  vectorColorMode?: string;
  visualizationPhaseRad?: number | null;
  wavevectorKf?: [number, number, number];
  cellOrigin?: [number, number, number];
  floquetSpatialConvention?: string;
  phasorConvention?: string;
}

export type Viewport3DVectorAnchorMode = "center" | "tail";

export interface Viewport3DVectorSegmentOptions {
  anchorMode?: Viewport3DVectorAnchorMode;
  surfaceOffsetEnabled?: boolean;
  surfaceOffsetScale?: number;
  surfaceTriangleIndices?: ArrayLike<number> | null;
}

export interface Viewport3DVectorBudgetTarget {
  id: string;
  nodeCount: number;
  visible: boolean;
}

interface Viewport3DVectorBudgetState {
  layers?: { vectors?: { density?: number | null } | null } | null;
  sampling?: { max_glyphs?: number | null } | null;
  vector_density?: number | null;
}

interface Viewport3DPositionSource {
  nodeCount: number;
  positions: ArrayLike<number>;
}

type Viewport3DVectorFieldValueResolver = (
  globalNodeIndex: number,
  selectedOffset: number,
) => number | null;

const DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET = 2048;
const RENDER_CACHE_MAX_ENTRIES_PER_OWNER = 8;

interface Viewport3DRenderCacheCounter {
  byteLength: number;
  entryCount: number;
  id: string;
  label: string;
}

const renderCacheCounters = new Map<string, Viewport3DRenderCacheCounter>();

const VIEWPORT_3D_RENDER_CACHE_DEFINITIONS = [
  ["viewport3d.render.scalarColorCache", "Scalar color cache"],
  ["viewport3d.render.partScalarColorCache", "Part scalar color cache"],
  ["viewport3d.render.mappedScalarColorCache", "Mapped scalar color cache"],
  [
    "viewport3d.render.complexPhaseProjectionCache",
    "Complex phase projection cache",
  ],
  ["viewport3d.render.fullVectorSegmentCache", "Full vector segment cache"],
  ["viewport3d.render.partVectorSegmentCache", "Part vector segment cache"],
] as const;

for (const [id, label] of VIEWPORT_3D_RENDER_CACHE_DEFINITIONS) {
  renderCacheCounters.set(id, {
    byteLength: 0,
    entryCount: 0,
    id,
    label,
  });
  memoryBudgetRegistry.register(id, () => {
    const counter = renderCacheCounters.get(id);
    if (!counter) return null;
    return {
      byteLength: counter.byteLength,
      category: "render-buffer",
      entryCount: counter.entryCount,
      id,
      label: counter.label,
      maxBytes: null,
    };
  });
}

const scalarColorCache = new WeakMap<
  DecodedFieldVector,
  Map<string, ScalarColorBuffer | null>
>();
const complexPhaseProjectionCache = new WeakMap<
  DecodedComplexFieldVector,
  Map<string, DecodedFieldVector>
>();
const partScalarColorCache = new WeakMap<
  Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  WeakMap<DecodedFieldVector, Map<string, ScalarColorBuffer | null>>
>();
const mappedScalarColorCache = new WeakMap<
  Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  WeakMap<DecodedFieldVector, Map<string, ScalarColorBuffer | null>>
>();
const fullVectorSegmentCache = new WeakMap<
  Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  WeakMap<DecodedFieldVector, Map<string, Float32Array | null>>
>();
const partVectorSegmentCache = new WeakMap<
  Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  WeakMap<DecodedFieldVector, Map<string, Float32Array | null>>
>();
const topologyPositionCache = new WeakMap<DecodedTopology, Float32Array>();
const topologySurfaceIndexCache = new WeakMap<DecodedTopology, Uint32Array>();
const topologySurfaceEdgeIndexCache = new WeakMap<
  DecodedTopology,
  Uint32Array | null
>();
const topologyVolumeEdgeIndexCache = new WeakMap<DecodedTopology, Uint32Array>();
const partSurfaceIndexCache = new WeakMap<
  DecodedTopology,
  WeakMap<Viewport3DSurfacePart, Uint32Array | null>
>();
const partVolumeEdgeIndexCache = new WeakMap<
  DecodedTopology,
  WeakMap<Viewport3DSurfacePart, Uint32Array | null>
>();
const surfaceEdgeIndexCache = new WeakMap<Uint32Array, Uint32Array | null>();
const surfaceNodeIndexCache = new WeakMap<Uint32Array, Uint32Array>();
const surfaceNodeNormalCache = new WeakMap<
  Viewport3DPositionSource,
  WeakMap<object, Float32Array | null>
>();

function buildTopologyPositions(topology: DecodedTopology): Float32Array {
  const cached = topologyPositionCache.get(topology);
  if (cached) return cached;

  const positions =
    topology.positions instanceof Float32Array
      ? topology.positions
      : Float32Array.from(topology.positions);
  topologyPositionCache.set(topology, positions);
  return positions;
}

function buildCachedTopologySurfaceIndices(
  topology: DecodedTopology,
): Uint32Array {
  const cached = topologySurfaceIndexCache.get(topology);
  if (cached) return cached;

  const surfaceIndices = measureViewport3DTopologyBuild(
    "fullmag.viewport3d.buildTopologySurfaceIndices",
    () => buildTopologySurfaceIndices(topology),
  );
  topologySurfaceIndexCache.set(topology, surfaceIndices);
  return surfaceIndices;
}

function buildCachedTopologyVolumeEdgeIndices(
  topology: DecodedTopology,
): Uint32Array {
  const cached = topologyVolumeEdgeIndexCache.get(topology);
  if (cached) return cached;

  const volumeEdgeIndices = measureViewport3DTopologyBuild(
    "fullmag.viewport3d.buildTopologyVolumeEdgeIndices",
    () => buildTopologyVolumeEdgeIndices(topology),
  );
  topologyVolumeEdgeIndexCache.set(topology, volumeEdgeIndices);
  return volumeEdgeIndices;
}

function buildCachedTopologySurfaceEdgeIndices(
  topology: DecodedTopology,
): Uint32Array | null {
  if (topologySurfaceEdgeIndexCache.has(topology)) {
    return topologySurfaceEdgeIndexCache.get(topology) ?? null;
  }
  const edges = measureViewport3DTopologyBuild(
    "fullmag.viewport3d.buildTopologySurfaceEdgeIndices",
    () => buildTopologySurfaceEdgeIndices(topology),
  );
  topologySurfaceEdgeIndexCache.set(topology, edges);
  return edges;
}

function getCachedPartTopologyValue<TValue>(
  cache: WeakMap<DecodedTopology, WeakMap<Viewport3DSurfacePart, TValue>>,
  topology: DecodedTopology,
  part: Viewport3DSurfacePart,
  measureName: string,
  build: () => TValue,
): TValue {
  let partCache = cache.get(topology);
  if (!partCache) {
    partCache = new WeakMap<Viewport3DSurfacePart, TValue>();
    cache.set(topology, partCache);
  }

  if (partCache.has(part)) {
    return partCache.get(part) as TValue;
  }

  const value = measureViewport3DTopologyBuild(measureName, build);
  partCache.set(part, value);
  return value;
}

function buildCachedSurfaceNodeIndices(
  surfaceIndices: Uint32Array | null,
): Uint32Array | null {
  if (!surfaceIndices) return null;
  const cached = surfaceNodeIndexCache.get(surfaceIndices);
  if (cached) return cached;

  const nodeIndices = measureViewport3DTopologyBuild(
    "fullmag.viewport3d.buildSurfaceNodeIndices",
    () => uniqueSortedIndices(surfaceIndices),
  );
  surfaceNodeIndexCache.set(surfaceIndices, nodeIndices);
  return nodeIndices;
}

function buildCachedRequiredSurfaceNodeIndices(
  surfaceIndices: Uint32Array,
): Uint32Array {
  return (
    buildCachedSurfaceNodeIndices(surfaceIndices) ??
    EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES
  );
}

function measureViewport3DTopologyBuild<TValue>(
  name: string,
  build: () => TValue,
): TValue {
  const performanceTarget =
    typeof performance !== "undefined" ? performance : null;
  if (
    !performanceTarget ||
    typeof performanceTarget.mark !== "function" ||
    typeof performanceTarget.measure !== "function"
  ) {
    return build();
  }

  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  performanceTarget.mark(startMark);
  try {
    return build();
  } finally {
    performanceTarget.mark(endMark);
    try {
      performanceTarget.measure(name, startMark, endMark);
    } catch {
      // Diagnostics must never break viewport rendering.
    }
    performanceTarget.clearMarks?.(startMark);
    performanceTarget.clearMarks?.(endMark);
  }
}

function lazyValue<TValue>(build: () => TValue): () => TValue {
  let cached = false;
  let value: TValue;
  return () => {
    if (!cached) {
      value = build();
      cached = true;
    }
    return value;
  };
}

export function buildViewport3DTopologyRenderModel<
  TPart extends Viewport3DRenderablePart,
>(
  topology: DecodedTopology | null | undefined,
  magneticParts: readonly TPart[],
  airboxParts: readonly TPart[],
  magneticSurfacePartsByPartId?: ReadonlyMap<string, readonly TPart[]>,
  meshIdentity: {
    meshGenerationId?: string | null;
    meshRevision?: number | string | null;
    meshTopologyHash?: string | null;
  } = {},
  options: Viewport3DTopologyRenderModelOptions = {},
): Viewport3DTopologyRenderModel<TPart> | null {
  if (!topology) return null;

  const topologyIndexBundle = options.topologyIndexBundle ?? null;
  const topologyIndexPending = options.topologyIndexState === "pending";
  const fallbackSurfaceIndices = lazyValue(() =>
    topologyIndexBundle?.fallbackSurfaceIndices ??
    (topologyIndexPending
      ? EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES
      : buildCachedTopologySurfaceIndices(topology)),
  );
  const fallbackSurfaceEdgeIndices = lazyValue(() =>
    topologyIndexBundle?.fallbackSurfaceEdgeIndices ??
    (topologyIndexPending
      ? null
      : buildCachedTopologySurfaceEdgeIndices(topology)),
  );
  const fallbackSurfaceNodeIndices = lazyValue(() =>
    topologyIndexBundle?.fallbackSurfaceNodeIndices ??
    (topologyIndexPending
      ? EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES
      : buildCachedRequiredSurfaceNodeIndices(fallbackSurfaceIndices())),
  );
  const fallbackVolumeEdgeIndices = lazyValue(() =>
    topologyIndexBundle?.fallbackVolumeEdgeIndices ??
    (topologyIndexPending
      ? EMPTY_VIEWPORT_3D_TOPOLOGY_INDICES
      : buildCachedTopologyVolumeEdgeIndices(topology)),
  );
  const airboxVolumeEdgeFallback = lazyValue(() =>
    topologyIndexPending
      ? null
      : airboxParts.length > 0
      ? buildUnclaimedVolumeEdgeIndices(topology, magneticParts) ??
        fallbackVolumeEdgeIndices()
      : null,
  );

  return {
    airboxParts: airboxParts.map((part) =>
      buildViewport3DTopologyPartRenderModel(
        part,
        topology,
        airboxVolumeEdgeFallback,
        [],
        topologyIndexBundle?.airboxPartsById.get(part.id) ?? null,
        topologyIndexPending,
        magneticParts,
      ),
    ),
    get fallbackSurfaceIndices() {
      return fallbackSurfaceIndices();
    },
    get fallbackSurfaceEdgeIndices() {
      return fallbackSurfaceEdgeIndices();
    },
    get fallbackSurfaceNodeIndices() {
      return fallbackSurfaceNodeIndices();
    },
    get fallbackVolumeEdgeIndices() {
      return fallbackVolumeEdgeIndices();
    },
    magneticParts: magneticParts.map((part) =>
      buildViewport3DTopologyPartRenderModel(
        part,
        topology,
        null,
        magneticSurfacePartsByPartId?.get(part.id) ?? [],
        topologyIndexBundle?.magneticPartsById.get(part.id) ?? null,
        topologyIndexPending,
      ),
    ),
    meshGenerationId: meshIdentity.meshGenerationId ?? null,
    meshRevision: meshIdentity.meshRevision ?? null,
    meshTopologyHash: meshIdentity.meshTopologyHash ?? null,
    nodeCount: topology.nodeCount,
    positions: buildTopologyPositions(topology),
  };
}

function buildViewport3DTopologyPartRenderModel<
  TPart extends Viewport3DRenderablePart,
>(
  part: TPart,
  topology: DecodedTopology,
  fallbackVolumeEdgeIndices: (() => Uint32Array | null) | null = null,
  supplementalSurfaceParts: readonly TPart[] = [],
  preparedIndices: Viewport3DPreparedPartTopologyIndices | null = null,
  topologyIndexPending = false,
  excludedNodeSelections: readonly Viewport3DNodeSelection[] = [],
): Viewport3DTopologyPartRenderModel<TPart> {
  const topologyModel = buildPartTopologyModel(
    part,
    topology,
    fallbackVolumeEdgeIndices,
    supplementalSurfaceParts,
    preparedIndices,
    topologyIndexPending,
  );
  const fullNodeSelection = lazyValue(() =>
    excludedNodeSelections.length > 0
      ? buildAirOnlyVisualizationNodeSelection({
          airSelection: part,
          magneticSelections: excludedNodeSelections,
          nodeCount: topology.nodeCount,
        })
      : part,
  );
  const surfaceNodeSelection = lazyValue(() => {
    const selection = topologyModel.surfaceNodeSelection;
    if (!selection || excludedNodeSelections.length === 0) return selection;
    return buildAirOnlyVisualizationNodeSelection({
      airSelection: selection,
      magneticSelections: excludedNodeSelections,
      nodeCount: topology.nodeCount,
    });
  });
  return {
    get edgeIndices() {
      return topologyModel.edgeIndices;
    },
    get fullNodeSelection() {
      return fullNodeSelection();
    },
    part,
    get surfaceIndices() {
      return topologyModel.surfaceIndices;
    },
    get surfaceTriangleCellTypes() {
      return topologyModel.surfaceTriangleCellTypes;
    },
    get surfaceTriangleFacetIndices() {
      return topologyModel.surfaceTriangleFacetIndices;
    },
    get surfaceTriangleGlobalCellOrdinals() {
      return topologyModel.surfaceTriangleGlobalCellOrdinals;
    },
    get surfaceNodeIndices() {
      return topologyModel.surfaceNodeIndices;
    },
    get surfaceNodeSelection() {
      return surfaceNodeSelection();
    },
    get volumeEdgeIndices() {
      return topologyModel.volumeEdgeIndices;
    },
  };
}

export function buildViewport3DFieldRenderModel(
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  options: Viewport3DFieldRenderOptions = {},
): Viewport3DFieldRenderModel | null {
  if (!topology) return null;
  const visualizationPhaseRad = finitePhaseRad(options.visualizationPhaseRad);
  const modeOverlay = resolveViewport3DModeFieldOverlayRenderState(
    options.modeOverlay,
    visualizationPhaseRad,
  );
  const renderFieldVector =
    buildCachedComplexPhaseProjection(
      options.complexFieldVector,
      visualizationPhaseRad,
    ) ?? fieldVector;
  const fullFieldVector = isFullTopologyFieldVector(
    renderFieldVector,
    topology,
  )
    ? renderFieldVector
    : null;
  const magneticFieldNodeIndices =
    !fullFieldVector && renderFieldVector
      ? resolveFieldVectorNodeIndices(renderFieldVector, topology)
      : null;
  const magneticFieldValueResolver = magneticFieldNodeIndices
    ? buildNodeIndexFieldValueResolver(
        magneticFieldNodeIndices,
        topology.nodeCount,
      )
    : null;

  const requestedScalarColorModes = new Set(
    options.scalarColorModes && options.scalarColorModes.size > 0
      ? [...options.scalarColorModes]
      : [],
  );
  requestedScalarColorModes.add(options.vectorColorMode ?? "magnitude");
  requestedScalarColorModes.delete("monochrome");
  const scalarColorsByMode =
    options.scalarColorsVisible === false
      ? new Map<string, ScalarColorBuffer | null>()
      : new Map(
          [...requestedScalarColorModes].map((colorMode) => [
            colorMode,
            fullFieldVector
              ? buildCachedVertexScalarColors(
                  fullFieldVector,
                  topology.nodeCount,
                  colorMode,
                  options.scalarColorPalette,
                  options.scalarRangesByMode?.get(colorMode),
                )
              : buildCachedMappedVertexScalarColors(
                  topology,
                  renderFieldVector,
                  magneticFieldNodeIndices,
                  colorMode,
                  options.scalarColorPalette,
                  options.scalarRangesByMode?.get(colorMode),
                ),
          ]),
        );
  attachComplexShaderValuesByMode(
    scalarColorsByMode,
    options.complexFieldVector,
    fullFieldVector ? null : magneticFieldNodeIndices,
    topology.nodeCount,
    visualizationPhaseRad,
    options.wavevectorKf,
    options.cellOrigin,
    options.floquetSpatialConvention,
    options.phasorConvention,
  );
  const scalarColors =
    scalarColorsByMode.get(options.vectorColorMode ?? "magnitude") ?? null;
  const partVectorBuilds = new Map<
    string,
    Viewport3DVectorBuildReference | null
  >();
  const partVectorSegments = new Map<string, Float32Array | null>();
  const scalarColorsByPartAndMode = new Map<
    string,
    Map<string, ScalarColorBuffer | null>
  >();
  const targetPasses = new Map<string, Viewport3DTargetRenderPassModel>();
  const hasPartBudgetPlan = Boolean(options.partVectorBudgets);
  const magneticPartSet = new Set(topology.magneticParts);
  const airboxPartSet = new Set(topology.airboxParts);

  for (const partModel of [...topology.magneticParts, ...topology.airboxParts]) {
    const partId = partModel.part.id;
    const targetRenderPlan = options.targetRenderPlans?.get(partId) ?? null;
    const partBudget = targetRenderPlan
      ? targetRenderPlan.vectors.visible
        ? targetRenderPlan.vectors.budget
        : 0
      : hasPartBudgetPlan
      ? options.partVectorBudgets?.get(partId) ?? 0
      : DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET;
    const vectorScope =
      targetRenderPlan?.vectors.scope ?? options.partVectorScopes?.get(partId) ?? "full";
    const vectorSelection =
      vectorScope === "surface"
        ? partModel.surfaceNodeSelection ?? EMPTY_VIEWPORT_3D_NODE_SELECTION
        : partModel.fullNodeSelection;
    const partScale =
      targetRenderPlan?.vectors.lengthScale ??
      options.partVectorScales?.get(partId) ??
      1;
    const surfaceOffsetEnabled =
      targetRenderPlan?.vectors.surfaceOffsetEnabled ??
      options.partVectorSurfaceOffsetEnabled?.has(partId) ??
      false;
    const surfaceOffsetScale =
      targetRenderPlan?.vectors.surfaceOffsetScale ??
      options.partVectorSurfaceOffsetScales?.get(partId) ??
      0;
    const {
      explicitFieldBuffer: explicitPartFieldBuffer,
      explicitFieldVector: explicitPartFieldVector,
      fieldVector: resolvedPartFieldVector,
    } = resolveViewport3DTargetFieldInput({
      fallbackFieldVector: fullFieldVector,
      legacyPartFieldVectors: options.partFieldVectors,
      partId,
      targetFieldBuffers: options.partTargetFieldBuffers,
    });
    const partUsesMagneticOnlyField = Boolean(
      !explicitPartFieldVector &&
        !fullFieldVector &&
        magneticFieldValueResolver &&
        magneticPartSet.has(partModel),
    );
    const partFieldVector =
      resolvedPartFieldVector ??
      (partUsesMagneticOnlyField ? renderFieldVector : null);
    const partFieldMatchesTopology = fieldVectorMatchesTopology(
      partFieldVector,
      topology,
    );
    const isScopedPartFieldVector = Boolean(
      partFieldVector &&
        partFieldVector !== renderFieldVector &&
        partFieldVector.pointCount < topology.nodeCount,
    );
    const partFieldNodeIndices =
      partFieldVector && partFieldVector !== renderFieldVector
        ? resolveFieldVectorNodeIndices(partFieldVector, topology)
        : null;
    const scopedPartFieldNodeIndices =
      isScopedPartFieldVector ? partFieldNodeIndices : null;
    const partProjectionFieldNodeIndices =
      partFieldVector && partFieldVector !== renderFieldVector
        ? partFieldNodeIndices ??
          resolveLegacyPartFieldNodeIndices(
            partFieldVector,
            partModel,
            topology,
          )
        : null;
    const scopedPartFieldNodeSelection = scopedPartFieldNodeIndices
      ? nodeIndicesToSelection(scopedPartFieldNodeIndices)
      : null;
    const scopedVectorSelection =
      isScopedPartFieldVector && partFieldVector
        ? {
            renderSelection: scopedPartFieldNodeSelection
              ? airboxPartSet.has(partModel)
                ? intersectNodeSelections(
                    scopedPartFieldNodeSelection,
                    vectorSelection,
                    topology,
                  )
                : scopedPartFieldNodeSelection
              : { nodeCount: 0, nodeStart: 0 },
          }
        : { renderSelection: vectorSelection };
    const renderVectorSelection = scopedVectorSelection.renderSelection;
    const scopedFieldExceedsCarrier = Boolean(
      airboxPartSet.has(partModel) &&
        partFieldVector &&
        partFieldVector.pointCount >
          resolveNodeSelectionCount(vectorSelection, topology),
    );
    const partScalarColorMode = targetRenderPlan
      ? targetRenderPlan.colorbar.scalarColorMode
      : options.partScalarColorModes?.get(partId);
    const partSurfaceScalarColorMode = targetRenderPlan
      ? targetRenderPlan.shader.visible
        ? targetRenderPlan.shader.scalarColorMode
        : null
      : partScalarColorMode;
    const partQuantityId =
      targetRenderPlan?.quantityId ?? options.partQuantityIds?.get(partId);
    const partScalarColorPalette =
      targetRenderPlan?.shader.palette ??
      options.partScalarColorPalettes?.get(partId) ??
      options.scalarColorPalette;
    const partScalarColorModes =
      targetRenderPlan
        ? new Set(
            [partSurfaceScalarColorMode, partScalarColorMode].filter(
              (mode): mode is string => mode != null,
            ),
          )
        : partScalarColorMode === undefined
        ? partFieldVector && partFieldVector !== renderFieldVector
          ? requestedScalarColorModes
          : null
        : new Set([partScalarColorMode]);
    let partScalarColorsByMode: Map<string, ScalarColorBuffer | null> | null =
      null;
    if (
      options.scalarColorsVisible !== false &&
      partFieldVector &&
      partScalarColorModes &&
      partScalarColorModes.size > 0
    ) {
      const partScalarRangesByMode =
        options.partScalarRangesByMode?.get(partId) ??
        (partFieldVector === renderFieldVector ? options.scalarRangesByMode : null);
      partScalarColorsByMode = new Map<string, ScalarColorBuffer | null>();
      for (const colorMode of partScalarColorModes) {
        if (!colorMode) continue;
        const builtScalarColors =
          !partFieldMatchesTopology
            ? null
            : explicitPartFieldBuffer &&
              !viewport3DTargetFieldBufferCanServeSurface(
                explicitPartFieldBuffer,
                colorMode,
                partQuantityId,
                targetRenderPlan?.shader.projectionMode ?? "raw_nodal",
              )
            ? null
            : targetRenderPlan?.shader.projectionMode === "surface_faces"
            ? buildCachedSurfaceFaceScalarColors(
                partModel,
                topology,
                partFieldVector,
                colorMode,
                partScalarColorPalette,
                partScalarRangesByMode?.get(colorMode),
                partProjectionFieldNodeIndices,
              )
            : targetRenderPlan?.shader.projectionMode === "thickness_average_z"
            ? buildCachedThicknessAverageZScalarColors(
                partModel,
                topology,
                partFieldVector,
                colorMode,
                partScalarColorPalette,
                partScalarRangesByMode?.get(colorMode),
                partProjectionFieldNodeIndices,
              )
            : buildCachedPartVertexScalarColors(
                partModel,
                topology,
                partFieldVector,
                partFieldNodeIndices,
                colorMode,
                partScalarColorPalette,
                partScalarRangesByMode?.get(colorMode),
              );
        partScalarColorsByMode.set(
          colorMode,
          attachScalarColorSourceIdentity(
            builtScalarColors,
            resolveFieldBufferSourceIdentity(
              explicitPartFieldBuffer,
              partFieldVector,
            ),
          ),
        );
      }
      scalarColorsByPartAndMode.set(partId, partScalarColorsByMode);
    }
    // Only build a scoped resolver when the part field data is genuinely scoped (fewer points
    // than the full topology). When the API returns full-domain data for a scoped request
    // (e.g. scope_kind=airbox returning all 18701 nodes), applying the resolver would read
    // field values at the wrong (local) indices instead of the correct global node indices.
    const fieldValueResolver =
      partFieldVector &&
      (partUsesMagneticOnlyField
        ? magneticFieldValueResolver
        : partFieldNodeIndices
          ? buildNodeIndexFieldValueResolver(
              partFieldNodeIndices,
              topology.nodeCount,
            )
          : null);
    const anchorMode =
      targetRenderPlan?.vectors.anchorMode ??
      options.partVectorAnchorModes?.get(partId) ??
      "center";
    const partSegments =
      scopedFieldExceedsCarrier || !partFieldMatchesTopology
        ? null
        : isScopedPartFieldVector && !scopedPartFieldNodeIndices
        ? null
        : explicitPartFieldBuffer &&
      !viewport3DTargetFieldBufferCanServeVectors(
        explicitPartFieldBuffer,
        partQuantityId,
      )
        ? null
        : buildCachedPartVectorSegments(
            partModel,
            topology,
            partFieldVector,
            renderVectorSelection,
            vectorScope,
            scale * partScale,
            partBudget,
            {
              anchorMode,
              surfaceOffsetEnabled,
              surfaceOffsetScale,
              surfaceTriangleIndices:
                surfaceOffsetEnabled ? partModel.surfaceIndices : null,
            },
            fieldValueResolver,
          );
    partVectorSegments.set(partId, partSegments);
    const partVectorBuildReference = buildVectorGlyphBuildReference({
      budget: partBudget,
      fieldVector: partFieldVector,
      fieldBuffer: explicitPartFieldBuffer,
      options,
      scale: scale * partScale,
      scopeId: partId,
      scopeKind: vectorScope,
      segments: partSegments,
      topology,
      vectorAnchorMode: anchorMode,
      vectorSurfaceOffsetEnabled: surfaceOffsetEnabled,
      vectorSurfaceOffsetScale: surfaceOffsetScale,
    });
    partVectorBuilds.set(partId, partVectorBuildReference);
    const activePartScalarColors =
      partSurfaceScalarColorMode == null
        ? null
        : partScalarColorsByMode?.get(partSurfaceScalarColorMode) ?? null;
    targetPasses.set(partId, {
      fieldBuffer: explicitPartFieldBuffer
        ? targetFieldBufferSource(explicitPartFieldBuffer)
        : null,
      fieldBufferState: resolveViewport3DTargetFieldBufferState({
        explicitPartFieldBuffer,
        explicitPartFieldVector,
        partFieldVector: partFieldVector ?? null,
      }),
      surface: {
        degradation: resolveViewport3DTargetSurfaceDegradation({
          colorMode: partSurfaceScalarColorMode ?? null,
          explicitPartFieldBuffer,
          quantityId: partQuantityId,
          projectionMode: targetRenderPlan?.shader.projectionMode ?? "raw_nodal",
          scalarColors: activePartScalarColors,
        }),
        passId: `${partId}:surface`,
        projectionMode:
          targetRenderPlan?.shader.projectionMode ?? "raw_nodal",
        scalarColorMode: partSurfaceScalarColorMode ?? null,
        scalarColors: activePartScalarColors,
      },
      vectors: {
        buildReference: partVectorBuildReference,
        degradation: resolveViewport3DTargetVectorDegradation({
          explicitPartFieldBuffer,
          partBudget,
          quantityId: partQuantityId,
          segments: partSegments,
        }),
        passId: `${partId}:vector-glyph`,
        segments: partSegments,
      },
    });
  }

  const fullVectorBudget =
    options.fullVectorBudget ?? DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET;
  const fullVectorAnchorMode = options.fullVectorAnchorMode ?? "center";
  const fullVectorSurfaceOffsetEnabled =
    options.fullVectorSurfaceOffsetEnabled ?? false;
  const fullVectorSurfaceOffsetScale =
    options.fullVectorSurfaceOffsetScale ?? 0;
  const fullVectorSegments = buildCachedFullVectorSegments(
    topology,
    fullFieldVector,
    scale,
    fullVectorBudget,
    {
      anchorMode: fullVectorAnchorMode,
      surfaceOffsetEnabled: fullVectorSurfaceOffsetEnabled,
      surfaceOffsetScale: fullVectorSurfaceOffsetScale,
      surfaceTriangleIndices:
        fullVectorSurfaceOffsetEnabled === true
          ? topology.fallbackSurfaceIndices
          : null,
    },
  );
  const fullVectorBuild = buildVectorGlyphBuildReference({
    budget: fullVectorBudget,
    fieldVector: fullFieldVector,
    options,
    scale,
    scopeId: "full",
    scopeKind: "full",
    segments: fullVectorSegments,
    topology,
    vectorAnchorMode: fullVectorAnchorMode,
    vectorSurfaceOffsetEnabled: fullVectorSurfaceOffsetEnabled,
    vectorSurfaceOffsetScale: fullVectorSurfaceOffsetScale,
  });
  const fullScalarColorMode = options.fullScalarColorMode ?? null;
  const fullScalarColorPalette =
    options.fullScalarColorPalette ?? options.scalarColorPalette;
  const fullTargetVectorsRequested = (options.fullVectorBudget ?? 0) > 0;
  const fullScalarColors =
    options.scalarColorsVisible === false || !fullScalarColorMode
      ? null
      : fullScalarColorPalette === options.scalarColorPalette
        ? scalarColorsByMode.get(fullScalarColorMode) ?? null
        : fullFieldVector
          ? buildCachedVertexScalarColors(
              fullFieldVector,
              topology.nodeCount,
              fullScalarColorMode,
              fullScalarColorPalette,
              options.scalarRangesByMode?.get(fullScalarColorMode),
            )
          : buildCachedMappedVertexScalarColors(
              topology,
              renderFieldVector,
              magneticFieldNodeIndices,
              fullScalarColorMode,
              fullScalarColorPalette,
              options.scalarRangesByMode?.get(fullScalarColorMode),
            );
  if (fullScalarColorMode || fullTargetVectorsRequested) {
    targetPasses.set(FULL_VIEWPORT_3D_TARGET_ID, {
      fieldBuffer: null,
      fieldBufferState: fullFieldVector ? "derived-global" : "missing",
      surface: {
        degradation: resolveViewport3DTargetSurfaceDegradation({
          colorMode: fullScalarColorMode,
          explicitPartFieldBuffer: null,
          projectionMode: "raw_nodal",
          scalarColors: fullScalarColors,
        }),
        passId: `${FULL_VIEWPORT_3D_TARGET_ID}:surface`,
        projectionMode: "raw_nodal",
        scalarColorMode: fullScalarColorMode,
        scalarColors: fullScalarColors,
      },
      vectors: {
        buildReference: fullTargetVectorsRequested ? fullVectorBuild : null,
        degradation: resolveViewport3DTargetVectorDegradation({
          explicitPartFieldBuffer: null,
          partBudget: fullTargetVectorsRequested ? fullVectorBudget : 0,
          segments: fullTargetVectorsRequested ? fullVectorSegments : null,
        }),
        passId: `${FULL_VIEWPORT_3D_TARGET_ID}:vector-glyph`,
        segments: fullTargetVectorsRequested ? fullVectorSegments : null,
      },
    });
  }
  const derivedWorkItems = planViewport3DDerivedWorkItems({
    complexFieldVector: options.complexFieldVector,
    targetPasses,
    visualizationPhaseRad,
  });
  const targetDiagnostics = summarizeViewport3DTargetDiagnostics({
    derivedWorkItems,
    targetPasses,
  });

  return {
    analysisOverlayActive: Boolean(options.analysisOverlayActive),
    legacyResponseOverlayActive: Boolean(options.legacyResponseOverlayActive),
    complexFieldVector: options.complexFieldVector ?? null,
    derivedWorkItems,
    fullVectorBuild,
    fullVectorSegments,
    modeOverlay,
    partVectorBuilds,
    partVectorSegments,
    scalarColors,
    scalarColorsByPartAndMode,
    scalarColorsByMode,
    targetDiagnostics,
    targetPasses,
    visualizationPhaseRad,
  };
}

function resolveViewport3DModeFieldOverlayRenderState(
  modeOverlay: Viewport3DFieldRenderOptions["modeOverlay"],
  phaseRad: number | null,
): Viewport3DModeFieldOverlayRenderState | null {
  if (
    !modeOverlay ||
    phaseRad === null ||
    !Number.isFinite(modeOverlay.phasorAmplitudeMax) ||
    modeOverlay.phasorAmplitudeMax < 0 ||
    modeOverlay.representation.length === 0
  ) {
    return null;
  }
  return {
    phasorAmplitudeMax: modeOverlay.phasorAmplitudeMax,
    phasorPhaseRad: phaseRad,
    representation: modeOverlay.representation,
  };
}

function resolveViewport3DTargetFieldBufferState({
  explicitPartFieldBuffer,
  explicitPartFieldVector,
  partFieldVector,
}: {
  explicitPartFieldBuffer: Viewport3DTargetFieldBuffer | null;
  explicitPartFieldVector: DecodedFieldVector | null;
  partFieldVector: DecodedFieldVector | null;
}): Viewport3DTargetFieldBufferState {
  if (explicitPartFieldBuffer) return "target-buffer";
  if (explicitPartFieldVector) return "legacy-implicit";
  if (partFieldVector) return "derived-global";
  return "missing";
}

function targetFieldBufferSource(
  buffer: Viewport3DTargetFieldBuffer,
): Viewport3DTargetFieldBufferSource {
  return {
    bufferId: buffer.bufferId,
    capability: buffer.capability,
    component: buffer.component,
    componentCount: buffer.componentCount,
    consumers: buffer.consumers,
    currentDomainGenerationId: buffer.currentDomainGenerationId,
    currentMeshTopologyHash: buffer.currentMeshTopologyHash,
    decodedFieldVector:
      buffer.capability === "synthetic-full-vector" ? null : buffer.fieldVector,
    fieldRevision: buffer.fieldRevision,
    indexing: buffer.indexing,
    meshTopologyHash: buffer.meshTopologyHash,
    domainGenerationId: buffer.domainGenerationId,
    nodeIndexCount: buffer.nodeIndices?.length ?? null,
    nodeIndices: buffer.nodeIndices,
    pointCount: buffer.pointCount,
    quantityId: buffer.quantityId,
    requestId: buffer.requestId,
    resourceKey: buffer.resourceKey,
    sampled: buffer.sampled,
    scopeId: buffer.scopeId,
    scopeKind: buffer.scopeKind,
    topologyRevision: buffer.topologyRevision,
    values: buffer.values,
    vectorComponentCount: buffer.vectorComponentCount,
  };
}

function resolveViewport3DTargetSurfaceDegradation({
  colorMode,
  explicitPartFieldBuffer,
  projectionMode,
  quantityId,
  scalarColors,
}: {
  colorMode: string | null;
  explicitPartFieldBuffer: Viewport3DTargetFieldBuffer | null;
  projectionMode: SurfaceFieldProjectionMode;
  quantityId?: string | null;
  scalarColors: ScalarColorBuffer | null;
}): Viewport3DTargetPassDegradation | null {
  if (!colorMode) return null;
  if (
    explicitPartFieldBuffer &&
    !viewport3DTargetFieldBufferMatchesQuantity(
      explicitPartFieldBuffer,
      quantityId,
    )
  ) {
    return "buffer-quantity-mismatch";
  }
  if (
    explicitPartFieldBuffer &&
    !viewport3DTargetFieldBufferCanServeSurface(
      explicitPartFieldBuffer,
      colorMode,
      quantityId,
      projectionMode,
    )
  ) {
    return explicitPartFieldBuffer.sampled
      ? "sampled-buffer-not-surface-capable"
      : "buffer-not-surface-capable";
  }
  return scalarColors ? null : "surface-colors-unavailable";
}

function resolveViewport3DTargetVectorDegradation({
  explicitPartFieldBuffer,
  partBudget,
  quantityId,
  segments,
}: {
  explicitPartFieldBuffer: Viewport3DTargetFieldBuffer | null;
  partBudget: number;
  quantityId?: string | null;
  segments: Float32Array | null;
}): Viewport3DTargetPassDegradation | null {
  if (partBudget <= 0) return null;
  if (
    explicitPartFieldBuffer &&
    !viewport3DTargetFieldBufferMatchesQuantity(
      explicitPartFieldBuffer,
      quantityId,
    )
  ) {
    return "buffer-quantity-mismatch";
  }
  if (
    explicitPartFieldBuffer &&
    !viewport3DTargetFieldBufferCanServeVectors(
      explicitPartFieldBuffer,
      quantityId,
    )
  ) {
    return explicitPartFieldBuffer.capability === "scalar-complete"
      ? "scalar-buffer-not-vector-capable"
      : "buffer-not-vector-capable";
  }
  return segments ? null : "vector-segments-unavailable";
}

function buildVectorGlyphBuildReference({
  budget,
  fieldVector,
  fieldBuffer,
  options,
  scale,
  scopeId,
  scopeKind,
  segments,
  topology,
  vectorAnchorMode,
  vectorSurfaceOffsetEnabled,
  vectorSurfaceOffsetScale,
}: {
  budget: number;
  fieldVector: DecodedFieldVector | null | undefined;
  fieldBuffer?: Viewport3DTargetFieldBuffer | null;
  options: Viewport3DFieldRenderOptions;
  scale: number;
  scopeId: string;
  scopeKind: string;
  segments: Float32Array | null;
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>;
  vectorAnchorMode: Viewport3DVectorAnchorMode;
  vectorSurfaceOffsetEnabled: boolean;
  vectorSurfaceOffsetScale: number;
}): Viewport3DVectorBuildReference | null {
  if (!segments || !fieldVector) return null;
  const topologyRevision = revisionToString(
    options.topologyRevision ?? topology.meshRevision,
  );
  const fieldRevision = revisionToString(
    fieldBuffer ? fieldBuffer.fieldRevision : options.fieldRevision,
  );
  if (!topologyRevision || !fieldRevision) return null;

  const sessionId = options.buildSessionId ?? "current";
  const domainId =
    options.buildDomainId ?? topology.meshGenerationId ?? "viewport-3d";
  const quantityId = fieldVector.quantityId;
  const samplingRevision = [
    options.vectorColorMode ?? "magnitude",
    scopeKind,
    scopeId,
    budget,
    scale,
    vectorAnchorMode,
    vectorSurfaceOffsetEnabled,
    vectorSurfaceOffsetScale,
  ].join(":");
  const styleRevision = "vector-segments-v1";
  const targetVisualizationRevision =
    revisionToString(options.targetVisualizationRevision) ?? "unknown";
  const buildKey = buildViewport3DVectorGlyphJobKey({
    algorithmVersion: 1,
    component: "full",
    domainId,
    domainGenerationId: fieldVector.domainGenerationId ?? topology.meshGenerationId,
    fieldRevision,
    quantityId,
    samplingRevision,
    scopeId,
    scopeKind,
    sessionId,
    styleRevision,
    targetVisualizationRevision,
    topologyRevision,
  });
  const groupKey = [
    "vector-glyph",
    sessionId,
    domainId,
    quantityId,
    scopeKind,
    scopeId,
  ].join(":");
  const revisionSummary = [
    `topology=${topologyRevision}`,
    `field=${fieldRevision}`,
    `quantity=${quantityId}`,
    `scope=${scopeKind}:${scopeId}`,
  ].join(" ");

  return {
    buildKey,
    ...resolveFieldBufferSourceIdentity(fieldBuffer ?? null, fieldVector),
    fieldRevision,
    groupKey,
    revisionSummary,
    targetRevision: `field=${fieldRevision}`,
    topologyRevision,
  };
}

function attachScalarColorSourceIdentity(
  scalarColors: ScalarColorBuffer | null,
  identity: { fieldBufferId: string | null; resourceKey: string | null },
): ScalarColorBuffer | null {
  if (!scalarColors) return null;
  if (
    scalarColors.sourceFieldBufferId !== undefined ||
    scalarColors.sourceResourceKey !== undefined
  ) {
    return scalarColors;
  }
  return {
    ...scalarColors,
    sourceFieldBufferId: identity.fieldBufferId,
    sourceResourceKey: identity.resourceKey,
  };
}

function resolveFieldBufferSourceIdentity(
  fieldBuffer: Viewport3DTargetFieldBuffer | null,
  fieldVector: DecodedFieldVector | null | undefined,
): { fieldBufferId: string | null; resourceKey: string | null } {
  if (fieldBuffer) {
    return {
      fieldBufferId: fieldBuffer.bufferId,
      resourceKey: fieldBuffer.resourceKey,
    };
  }
  return {
    fieldBufferId: fieldVector
      ? `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`
      : null,
    resourceKey: null,
  };
}

function revisionToString(
  revision: string | number | null | undefined,
): string | null {
  if (typeof revision === "number" && Number.isFinite(revision)) {
    return String(revision);
  }
  if (typeof revision === "string" && revision.length > 0) {
    return revision;
  }
  return null;
}

function finitePhaseRad(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildCachedComplexPhaseProjection(
  complexFieldVector: DecodedComplexFieldVector | null | undefined,
  phaseRad: number | null | undefined,
): DecodedFieldVector | null {
  const phase = finitePhaseRad(phaseRad);
  if (!complexFieldVector || phase === null) return null;
  const cacheKey = `${complexFieldVector.componentCount}:${phase}`;
  return getCachedValue(
    complexPhaseProjectionCache,
    complexFieldVector,
    cacheKey,
    () => buildComplexPhaseProjection(complexFieldVector, phase),
    "viewport3d.render.complexPhaseProjectionCache",
  );
}

function buildComplexPhaseProjection(
  complexFieldVector: DecodedComplexFieldVector,
  phaseRad: number,
): DecodedFieldVector {
  const componentCount = complexFieldVector.componentCount;
  const projectedValues = new Float64Array(
    complexFieldVector.pointCount * componentCount,
  );
  const cosPhase = Math.cos(phaseRad);
  const sinPhase = Math.sin(phaseRad);

  for (
    let pointIndex = 0;
    pointIndex < complexFieldVector.pointCount;
    pointIndex += 1
  ) {
    for (
      let componentIndex = 0;
      componentIndex < componentCount;
      componentIndex += 1
    ) {
      const source = (pointIndex * componentCount + componentIndex) * 2;
      const target = pointIndex * componentCount + componentIndex;
      const real = complexFieldVector.values[source] ?? 0;
      const imag = complexFieldVector.values[source + 1] ?? 0;
      projectedValues[target] = real * cosPhase - imag * sinPhase;
    }
  }

  return {
    dtype: "float64",
    domainGenerationId: complexFieldVector.domainGenerationId,
    formatVersion: complexFieldVector.formatVersion,
    grid: complexFieldVector.grid,
    indexing: complexFieldVector.indexing,
    meshTopologyHash: complexFieldVector.meshTopologyHash,
    meshTopologyRevision: complexFieldVector.meshTopologyRevision,
    nComp: componentCount,
    nodeIndices: complexFieldVector.nodeIndices,
    pointCount: complexFieldVector.pointCount,
    quantityId: complexFieldVector.quantityId,
    scopeId: complexFieldVector.scopeId,
    scopeKind: complexFieldVector.scopeKind,
    valueCount: projectedValues.length,
    values: projectedValues,
  };
}

function attachComplexShaderValuesByMode(
  scalarColorsByMode: Map<string, ScalarColorBuffer | null>,
  complexFieldVector: DecodedComplexFieldVector | null | undefined,
  targetNodeIndices: Uint32Array | null,
  vertexCount: number,
  phaseRad: number | null,
  wavevectorKf?: [number, number, number],
  cellOrigin?: [number, number, number],
  floquetSpatialConvention?: string,
  phasorConvention?: string,
): void {
  if (!complexFieldVector || phaseRad === null) return;
  for (const buffer of scalarColorsByMode.values()) {
    attachComplexShaderValues(
      buffer,
      complexFieldVector,
      targetNodeIndices,
      vertexCount,
      phaseRad,
      wavevectorKf,
      cellOrigin,
      floquetSpatialConvention,
      phasorConvention,
    );
  }
}

function attachComplexShaderValues(
  buffer: ScalarColorBuffer | null,
  complexFieldVector: DecodedComplexFieldVector,
  targetNodeIndices: Uint32Array | null,
  vertexCount: number,
  phaseRad: number,
  wavevectorKf?: [number, number, number],
  cellOrigin?: [number, number, number],
  floquetSpatialConvention?: string,
  phasorConvention?: string,
): void {
  if (!buffer || complexFieldVector.pointCount <= 0) return;
  const fullTopologyField = complexFieldVector.pointCount === vertexCount;
  if (!fullTopologyField && !targetNodeIndices) return;
  if (targetNodeIndices && targetNodeIndices.length < complexFieldVector.pointCount) {
    return;
  }

  const complexRealValues = new Float32Array(vertexCount * 3);
  const complexImagValues = new Float32Array(vertexCount * 3);
  const componentCount = complexFieldVector.componentCount;

  for (
    let pointIndex = 0;
    pointIndex < complexFieldVector.pointCount;
    pointIndex += 1
  ) {
    const nodeIndex = fullTopologyField
      ? pointIndex
      : targetNodeIndices?.[pointIndex] ?? -1;
    if (nodeIndex < 0 || nodeIndex >= vertexCount) continue;

    const target = nodeIndex * 3;
    const source = pointIndex * componentCount * 2;
    complexRealValues[target] = complexFieldVector.values[source] ?? 0;
    complexImagValues[target] = complexFieldVector.values[source + 1] ?? 0;
    if (componentCount > 1) {
      complexRealValues[target + 1] =
        complexFieldVector.values[source + 2] ?? 0;
      complexImagValues[target + 1] =
        complexFieldVector.values[source + 3] ?? 0;
    }
    if (componentCount > 2) {
      complexRealValues[target + 2] =
        complexFieldVector.values[source + 4] ?? 0;
      complexImagValues[target + 2] =
        complexFieldVector.values[source + 5] ?? 0;
    }
  }

  buffer.complexRealValues = complexRealValues;
  buffer.complexImagValues = complexImagValues;
  buffer.complexPhaseRad = phaseRad;
  buffer.wavevectorKf = wavevectorKf;
  buffer.cellOrigin = cellOrigin;
  buffer.floquetSpatialConvention = floquetSpatialConvention;
  buffer.phasorConvention = phasorConvention;
}

function isFullTopologyFieldVector(
  fieldVector: DecodedFieldVector | null | undefined,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): fieldVector is DecodedFieldVector {
  return Boolean(fieldVector) &&
    fieldVectorMatchesTopology(fieldVector, topology) &&
    fieldVectorUsesDirectNodeOrder(fieldVector, topology.nodeCount);
}

function buildCachedSurfaceFaceScalarColors(
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  colorMode: string | undefined,
  colorPalette: string | undefined,
  scalarRange?: ScalarRange | null,
  targetNodeIndices?: Uint32Array | null,
): ScalarColorBuffer | null {
  if (!fieldVector || !partModel.surfaceIndices) return null;

  return getCachedNestedFieldValue(
    mappedScalarColorCache,
    topology,
    fieldVector,
    [
      "surface-faces",
      partModel.part.id,
      partModel.surfaceIndices.length,
      partModel.surfaceIndices[0] ?? "none",
      partModel.surfaceIndices[partModel.surfaceIndices.length - 1] ?? "none",
      topology.nodeCount,
      nodeIndexMappingCacheKey(targetNodeIndices),
      colorMode ?? "magnitude",
      colorPalette ?? "viridis",
      scalarRangeCacheKey(scalarRange),
    ].join(":"),
    () =>
      buildSurfaceFaceScalarColors(
        fieldVector,
        partModel.surfaceIndices,
        topology.nodeCount,
        colorMode,
        colorPalette,
        scalarRange,
        Number.POSITIVE_INFINITY,
        targetNodeIndices,
      ),
    "viewport3d.render.surfaceFaceScalarColorCache",
  );
}

function buildCachedThicknessAverageZScalarColors(
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  colorMode: string | undefined,
  colorPalette: string | undefined,
  scalarRange?: ScalarRange | null,
  targetNodeIndices?: Uint32Array | null,
): ScalarColorBuffer | null {
  if (!fieldVector || !partModel.surfaceIndices) return null;

  return getCachedNestedFieldValue(
    mappedScalarColorCache,
    topology,
    fieldVector,
    [
      "thickness-average-z",
      partModel.part.id,
      partModel.surfaceIndices.length,
      partModel.surfaceIndices[0] ?? "none",
      partModel.surfaceIndices[partModel.surfaceIndices.length - 1] ?? "none",
      topology.nodeCount,
      topology.positions.length,
      nodeIndexMappingCacheKey(targetNodeIndices),
      colorMode ?? "magnitude",
      colorPalette ?? "viridis",
      scalarRangeCacheKey(scalarRange),
    ].join(":"),
    () =>
      buildThicknessAverageZScalarColors(
        fieldVector,
        topology.positions,
        partModel.surfaceIndices,
        topology.nodeCount,
        colorMode,
        colorPalette,
        scalarRange,
        Number.POSITIVE_INFINITY,
        targetNodeIndices,
      ),
    "viewport3d.render.thicknessAverageZScalarColorCache",
  );
}

function buildCachedMappedVertexScalarColors(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  targetNodeIndices: Uint32Array | null | undefined,
  colorMode: string | undefined,
  colorPalette: string | undefined,
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer | null {
  if (!fieldVector || !targetNodeIndices) return null;

  return getCachedNestedFieldValue(
    mappedScalarColorCache,
    topology,
    fieldVector,
    `${targetNodeIndices.length}:${topology.nodeCount}:${colorMode ?? "magnitude"}:${colorPalette ?? "viridis"}:${scalarRangeCacheKey(scalarRange)}:mapped`,
    () =>
      buildMappedVertexScalarColors(
        fieldVector,
        targetNodeIndices,
        topology.nodeCount,
        Number.POSITIVE_INFINITY,
        colorMode,
        colorPalette,
        scalarRange,
      ),
    "viewport3d.render.mappedScalarColorCache",
  );
}

function buildCachedVertexScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  vertexCount: number,
  colorMode: string | undefined,
  colorPalette: string | undefined,
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer | null {
  if (!fieldVector) return null;

  return getCachedValue(
    scalarColorCache,
    fieldVector,
    `${vertexCount}:${colorMode ?? "magnitude"}:${colorPalette ?? "viridis"}:${scalarRangeCacheKey(scalarRange)}`,
    () =>
      buildVertexScalarColors(
        fieldVector,
        vertexCount,
        undefined,
        colorMode,
        colorPalette,
        scalarRange,
      ),
    "viewport3d.render.scalarColorCache",
  );
}

function scalarRangeCacheKey(range: ScalarRange | null | undefined): string {
  if (
    !range ||
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max)
  ) {
    return "auto";
  }
  return `range=${range.min}:${range.max}`;
}

function nodeIndexMappingCacheKey(
  targetNodeIndices: ArrayLike<number> | null | undefined,
): string {
  if (!targetNodeIndices) return "identity";
  let hash = 2166136261;
  for (let index = 0; index < targetNodeIndices.length; index += 1) {
    hash ^= targetNodeIndices[index] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `${targetNodeIndices.length}:${hash >>> 0}`;
}

function intersectNodeSelections(
  selection: Viewport3DNodeSelection,
  includedSelection: Viewport3DNodeSelection,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
): Viewport3DNodeSelection {
  const includedNodeIndices = new Set(
    buildNodeSelectionIndices(includedSelection, topology) ?? [],
  );
  const selectedNodeCount = resolveNodeSelectionCount(selection, topology);
  if (selectedNodeCount <= 0 || includedNodeIndices.size === 0) {
    return { nodeCount: 0, nodeStart: 0 };
  }

  const nodeIndices: number[] = [];
  for (let offset = 0; offset < selectedNodeCount; offset += 1) {
    const nodeIndex = resolveNodeSelectionIndex(selection, offset);
    if (
      nodeIndex === null ||
      !Number.isInteger(nodeIndex) ||
      nodeIndex < 0 ||
      nodeIndex >= topology.nodeCount
    ) {
      continue;
    }
    if (includedNodeIndices.has(nodeIndex)) nodeIndices.push(nodeIndex);
  }

  return nodeIndices.length > 0
    ? { nodeIndices }
    : { nodeCount: 0, nodeStart: 0 };
}

function buildNodeIndexFieldValueResolver(
  targetNodeIndices: Uint32Array,
  nodeCount: number,
): Viewport3DVectorFieldValueResolver {
  const localIndexByGlobalNode = new Map<number, number>();
  for (
    let localIndex = 0;
    localIndex < targetNodeIndices.length;
    localIndex += 1
  ) {
    const globalNodeIndex = targetNodeIndices[localIndex] ?? -1;
    if (globalNodeIndex >= 0 && globalNodeIndex < nodeCount) {
      localIndexByGlobalNode.set(globalNodeIndex, localIndex);
    }
  }

  return (globalNodeIndex) => localIndexByGlobalNode.get(globalNodeIndex) ?? null;
}

function buildCachedPartVertexScalarColors(
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  targetNodeIndices: Uint32Array | null,
  colorMode: string | undefined,
  colorPalette: string | undefined,
  scalarRange?: ScalarRange | null,
): ScalarColorBuffer | null {
  if (!fieldVector) return null;
  if (
    fieldVectorMatchesTopology(fieldVector, topology) &&
    fieldVectorUsesDirectNodeOrder(fieldVector, topology.nodeCount)
  ) {
    return buildCachedVertexScalarColors(
      fieldVector,
      topology.nodeCount,
      colorMode,
      colorPalette,
      scalarRange,
    );
  }

  const resolvedNodeIndices =
    targetNodeIndices ?? resolveFieldVectorNodeIndices(fieldVector, topology);
  if (
    !resolvedNodeIndices ||
    resolvedNodeIndices.length !== fieldVector.pointCount
  ) {
    return null;
  }

  return getCachedNestedFieldValue(
    partScalarColorCache,
    partModel,
    fieldVector,
    `${topology.nodeCount}:${colorMode ?? "magnitude"}:${colorPalette ?? "viridis"}:${scalarRangeCacheKey(scalarRange)}:scoped`,
    () =>
      buildMappedVertexScalarColors(
        fieldVector,
        resolvedNodeIndices,
        topology.nodeCount,
        undefined,
        colorMode,
        colorPalette,
        scalarRange,
      ),
    "viewport3d.render.partScalarColorCache",
  );
}

function buildNodeSelectionIndices(
  selection: Viewport3DNodeSelection,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
): Uint32Array | null {
  const selectedNodeCount = resolveNodeSelectionCount(selection, topology);
  if (selectedNodeCount <= 0) return null;

  const indices: number[] = [];
  for (let offset = 0; offset < selectedNodeCount; offset += 1) {
    const nodeIndex = resolveNodeSelectionIndex(selection, offset);
    if (
      nodeIndex !== null &&
      Number.isInteger(nodeIndex) &&
      nodeIndex >= 0 &&
      nodeIndex < topology.nodeCount
    ) {
      indices.push(nodeIndex);
    }
  }

  return indices.length > 0 ? Uint32Array.from(indices) : null;
}

function resolveLegacyPartFieldNodeIndices(
  fieldVector: DecodedFieldVector,
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): Uint32Array | null {
  if (
    fieldVector.pointCount <= 0 ||
    fieldVector.indexing === "explicit_node_indices" ||
    fieldVector.indexing === "sampled_node_indices"
  ) {
    return null;
  }
  const nodeIndices = buildNodeSelectionIndices(partModel.fullNodeSelection, topology);
  return nodeIndices && nodeIndices.length === fieldVector.pointCount
    ? nodeIndices
    : null;
}

function nodeIndicesToSelection(
  nodeIndices: Uint32Array,
): Viewport3DNodeSelection {
  return { nodeIndices: Array.from(nodeIndices) };
}

function resolveFieldVectorNodeIndices(
  fieldVector: DecodedFieldVector | null | undefined,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): Uint32Array | null {
  if (!fieldVector || fieldVector.pointCount <= 0) return null;
  if (!fieldVectorMatchesTopology(fieldVector, topology)) return null;
  const nodeIndices = fieldVector.nodeIndices;
  if (!nodeIndices || nodeIndices.length !== fieldVector.pointCount) {
    return null;
  }

  const resolved = new Uint32Array(nodeIndices.length);
  for (let index = 0; index < nodeIndices.length; index += 1) {
    const nodeIndex = nodeIndices[index];
    if (
      nodeIndex === undefined ||
      !Number.isInteger(nodeIndex) ||
      nodeIndex < 0 ||
      nodeIndex >= topology.nodeCount
    ) {
      return null;
    }
    resolved[index] = nodeIndex;
  }
  return resolved;
}

function fieldVectorMatchesTopology(
  fieldVector: DecodedFieldVector | null | undefined,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): boolean {
  if (!fieldVector) return false;
  return resolveViewport3DFieldDomainCompatibility({
      domain: {
        domainGenerationId: topology.meshGenerationId,
        meshTopologyHash: topology.meshTopologyHash,
        meshTopologyRevision: revisionToString(topology.meshRevision),
        pointCount: topology.nodeCount,
      },
    field: fieldVector,
  }).status !== "mismatch";
}

function buildCachedFullVectorSegments(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  budget: number,
  vectorOptions: Viewport3DVectorSegmentOptions = {},
): Float32Array | null {
  if (!fieldVector || budget <= 0) return null;

  const anchorMode = vectorOptions.anchorMode ?? "center";
  const surfaceOffsetEnabled = vectorOptions.surfaceOffsetEnabled === true;
  const surfaceOffsetScale = vectorOptions.surfaceOffsetScale ?? 0;
  return getCachedNestedFieldValue(
    fullVectorSegmentCache,
    topology,
    fieldVector,
    `${scale}:${budget}:${anchorMode}:${surfaceOffsetEnabled}:${surfaceOffsetScale}`,
    () =>
      buildVectorLineSegmentsFromPositions(
        topology,
        fieldVector,
        scale,
        budget,
        vectorOptions,
      ),
    "viewport3d.render.fullVectorSegmentCache",
  );
}

function buildCachedPartVectorSegments(
  partModel: Viewport3DTopologyPartRenderModel<Viewport3DRenderablePart>,
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  vectorSelection: Viewport3DNodeSelection,
  vectorScope: "surface" | "full",
  scale: number,
  budget: number,
  vectorOptions: Viewport3DVectorSegmentOptions = {},
  fieldValueResolver: Viewport3DVectorFieldValueResolver | null = null,
): Float32Array | null {
  if (!fieldVector || budget <= 0) return null;

  const anchorMode = vectorOptions.anchorMode ?? "center";
  const surfaceOffsetEnabled = vectorOptions.surfaceOffsetEnabled === true;
  const surfaceOffsetScale = vectorOptions.surfaceOffsetScale ?? 0;
  const fieldValueMode = fieldValueResolver ? "scoped" : "full";
  return getCachedNestedFieldValue(
    partVectorSegmentCache,
    partModel,
    fieldVector,
    `${vectorScope}:${fieldValueMode}:${scale}:${budget}:${anchorMode}:${surfaceOffsetEnabled}:${surfaceOffsetScale}`,
    () =>
      buildVectorLineSegmentsForNodeSelectionFromPositions(
        topology,
        fieldVector,
        vectorSelection,
        scale,
        budget,
        vectorOptions,
        fieldValueResolver,
      ),
    "viewport3d.render.partVectorSegmentCache",
  );
}

function getCachedValue<TKey extends object, TValue>(
  cache: WeakMap<TKey, Map<string, TValue>>,
  owner: TKey,
  key: string,
  build: () => TValue,
  statsId?: string,
): TValue {
  let entries = cache.get(owner);
  if (!entries) {
    entries = new Map<string, TValue>();
    cache.set(owner, entries);
  }

  if (entries.has(key)) {
    const value = entries.get(key) as TValue;
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  const value = build();
  entries.set(key, value);
  recordRenderCacheInsert(statsId, value);
  evictOldestRenderCacheEntries(entries, statsId);
  return value;
}

function getCachedNestedFieldValue<TOwner extends object, TValue>(
  cache: WeakMap<
    TOwner,
    WeakMap<DecodedFieldVector, Map<string, TValue>>
  >,
  owner: TOwner,
  fieldVector: DecodedFieldVector,
  key: string,
  build: () => TValue,
  statsId?: string,
): TValue {
  let fieldCache = cache.get(owner);
  if (!fieldCache) {
    fieldCache = new WeakMap<DecodedFieldVector, Map<string, TValue>>();
    cache.set(owner, fieldCache);
  }

  return getCachedValue(fieldCache, fieldVector, key, build, statsId);
}

function evictOldestRenderCacheEntries<TValue>(
  entries: Map<string, TValue>,
  statsId: string | undefined,
): void {
  while (entries.size > RENDER_CACHE_MAX_ENTRIES_PER_OWNER) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey === undefined) return;
    const value = entries.get(oldestKey);
    entries.delete(oldestKey);
    recordRenderCacheEviction(statsId, value);
  }
}

function recordRenderCacheInsert(statsId: string | undefined, value: unknown) {
  const counter = statsId ? renderCacheCounters.get(statsId) : null;
  if (!counter) return;
  counter.entryCount += 1;
  counter.byteLength += estimateRenderCacheValueByteLength(value);
}

function recordRenderCacheEviction(statsId: string | undefined, value: unknown) {
  const counter = statsId ? renderCacheCounters.get(statsId) : null;
  if (!counter) return;
  counter.entryCount = Math.max(0, counter.entryCount - 1);
  counter.byteLength = Math.max(
    0,
    counter.byteLength - estimateRenderCacheValueByteLength(value),
  );
}

function estimateRenderCacheValueByteLength(value: unknown): number {
  if (!value) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value !== "object") return 0;

  const maybeDecodedFieldVector = value as Partial<DecodedFieldVector>;
  if (ArrayBuffer.isView(maybeDecodedFieldVector.values)) {
    return maybeDecodedFieldVector.values.byteLength;
  }

  const maybeScalarColorBuffer = value as Partial<ScalarColorBuffer>;
  return (
    (maybeScalarColorBuffer.colors?.byteLength ?? 0) +
    (maybeScalarColorBuffer.complexImagValues?.byteLength ?? 0) +
    (maybeScalarColorBuffer.complexRealValues?.byteLength ?? 0) +
    (maybeScalarColorBuffer.scalarValues?.byteLength ?? 0) +
    (maybeScalarColorBuffer.vectorValues?.byteLength ?? 0)
  );
}

export function getViewport3DRenderCacheStats(): MemoryBudgetEntry[] {
  return VIEWPORT_3D_RENDER_CACHE_DEFINITIONS.map(([id]) => {
    const counter = renderCacheCounters.get(id);
    return {
      byteLength: counter?.byteLength ?? 0,
      category: "render-buffer",
      createdAtMs: 0,
      entryCount: counter?.entryCount ?? 0,
      id,
      label: counter?.label ?? id,
      maxBytes: null,
      owner: "viewport-3d",
      releaseReason: null,
    };
  });
}

export function viewport3DFieldRenderOptionsNeedFieldData(
  options: Viewport3DFieldRenderOptions = {},
): boolean {
  if (options.scalarColorsVisible !== false) return true;
  if (
    (options.fullVectorBudget ?? DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET) > 0
  ) {
    return true;
  }
  if (!options.partVectorBudgets) return true;

  for (const budget of options.partVectorBudgets.values()) {
    if (budget > 0) return true;
  }

  for (const plan of options.targetRenderPlans?.values() ?? []) {
    if (!plan.visible) continue;
    if (plan.shader.visible && plan.shader.scalarColorMode) return true;
    if (plan.vectors.visible && plan.vectors.budget > 0) return true;
  }

  return false;
}

export function resolveViewport3DMaxVectorGlyphs(
  state: Viewport3DVectorBudgetState | null | undefined,
  fallback = DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET,
): number {
  const maxGlyphs =
    state?.sampling?.max_glyphs ??
    state?.layers?.vectors?.density ??
    state?.vector_density ??
    fallback;
  return Math.max(0, Math.floor(maxGlyphs));
}

export function distributeVectorGlyphBudget(
  targets: readonly Viewport3DVectorBudgetTarget[],
  maxGlyphs: number,
): Map<string, number> {
  const budget = Math.max(0, Math.floor(maxGlyphs));
  const visibleTargets = targets.reduce<Viewport3DVectorBudgetTarget[]>(
    (accumulator, target) => {
      if (!target.visible || target.nodeCount <= 0) return accumulator;
      accumulator.push({
        ...target,
        nodeCount: Math.max(1, Math.floor(target.nodeCount)),
      });
      return accumulator;
    },
    [],
  );
  const result = new Map<string, number>();
  if (budget === 0 || visibleTargets.length === 0) return result;

  const totalWeight = visibleTargets.reduce(
    (sum, target) => sum + target.nodeCount,
    0,
  );
  let allocated = 0;

  for (const target of visibleTargets) {
    const targetBudget = Math.floor((budget * target.nodeCount) / totalWeight);
    if (targetBudget > 0) {
      result.set(target.id, targetBudget);
      allocated += targetBudget;
    }
  }

  let remaining = budget - allocated;
  const byWeight = visibleTargets.toSorted((left, right) =>
    right.nodeCount === left.nodeCount
      ? left.id.localeCompare(right.id)
      : right.nodeCount - left.nodeCount,
  );

  for (const target of byWeight) {
    if (remaining <= 0) break;
    result.set(target.id, (result.get(target.id) ?? 0) + 1);
    remaining -= 1;
  }

  return result;
}

export function buildPartSurfaceIndices(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  return getCachedPartTopologyValue(
    partSurfaceIndexCache,
    topology,
    part,
    "fullmag.viewport3d.buildPartSurfaceIndices",
    () => buildPartSurfaceIndicesUncached(part, topology),
  );
}

export function buildPartVolumeEdgeIndices(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  return getCachedPartTopologyValue(
    partVolumeEdgeIndexCache,
    topology,
    part,
    "fullmag.viewport3d.buildPartVolumeEdgeIndices",
    () => buildPartVolumeEdgeIndicesUncached(part, topology),
  );
}

function buildPartTopologyModel(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
  fallbackVolumeEdgeIndices: (() => Uint32Array | null) | null = null,
  supplementalSurfaceParts: readonly Viewport3DSurfacePart[] = [],
  preparedIndices: Viewport3DPreparedPartTopologyIndices | null = null,
  topologyIndexPending = false,
): Pick<
  Viewport3DTopologyPartRenderModel,
  | "edgeIndices"
  | "surfaceIndices"
  | "surfaceTriangleCellTypes"
  | "surfaceTriangleFacetIndices"
  | "surfaceTriangleGlobalCellOrdinals"
  | "surfaceNodeIndices"
  | "surfaceNodeSelection"
  | "volumeEdgeIndices"
> {
  const surfaceIndices = lazyValue(() =>
    preparedIndices
      ? preparedIndices.surfaceIndices
      : topologyIndexPending
        ? null
        : buildCachedPartSurfaceIndicesWithSupplemental(
            part,
            topology,
            supplementalSurfaceParts,
          ),
  );
  const edgeIndices = lazyValue(() =>
    preparedIndices
      ? preparedIndices.edgeIndices
      : topologyIndexPending
        ? null
        : buildCachedPartSurfaceEdgeIndicesWithSupplemental(
            part,
            topology,
            supplementalSurfaceParts,
            surfaceIndices(),
          ),
  );
  const surfaceTriangleFacetIndices = lazyValue(() =>
    preparedIndices
      ? preparedIndices.surfaceTriangleFacetIndices
      : topologyIndexPending
        ? null
        : buildPartSurfaceTriangleFacetIndicesWithSupplemental(
            part,
            topology,
            supplementalSurfaceParts,
            surfaceIndices(),
          ),
  );
  const surfaceTriangleCellTypes = lazyValue(() =>
    preparedIndices ? preparedIndices.surfaceTriangleCellTypes : null,
  );
  const surfaceTriangleGlobalCellOrdinals = lazyValue(() =>
    preparedIndices
      ? preparedIndices.surfaceTriangleGlobalCellOrdinals
      : null,
  );
  const surfaceNodeSelection = lazyValue(() => {
    if (preparedIndices) return preparedIndices.surfaceNodeSelection;
    if (part.surface_node_indices != null) {
      return { nodeIndices: Array.from(part.surface_node_indices) };
    }
    if (topologyIndexPending) return null;
    const indices = surfaceIndices();
    const nodeIndices = buildCachedSurfaceNodeIndices(indices);
    return nodeIndices ? { nodeIndices: Array.from(nodeIndices) } : null;
  });
  const surfaceNodeIndices = lazyValue(() => {
    if (preparedIndices) return preparedIndices.surfaceNodeIndices;
    if (part.surface_node_indices != null) {
      return Uint32Array.from(part.surface_node_indices);
    }
    if (topologyIndexPending) return null;
    const indices = surfaceIndices();
    return buildCachedSurfaceNodeIndices(indices);
  });
  const volumeEdgeIndices = lazyValue(
    () =>
      preparedIndices
        ? preparedIndices.volumeEdgeIndices
        : topologyIndexPending
          ? null
          : buildPartVolumeEdgeIndices(part, topology) ??
            fallbackVolumeEdgeIndices?.() ??
            null,
  );
  return {
    get edgeIndices() {
      return edgeIndices();
    },
    get surfaceIndices() {
      return surfaceIndices();
    },
    get surfaceTriangleCellTypes() {
      return surfaceTriangleCellTypes();
    },
    get surfaceTriangleFacetIndices() {
      return surfaceTriangleFacetIndices();
    },
    get surfaceTriangleGlobalCellOrdinals() {
      return surfaceTriangleGlobalCellOrdinals();
    },
    get surfaceNodeIndices() {
      return surfaceNodeIndices();
    },
    get surfaceNodeSelection() {
      return surfaceNodeSelection();
    },
    get volumeEdgeIndices() {
      return volumeEdgeIndices();
    },
  };
}

function buildCachedPartSurfaceEdgeIndicesWithSupplemental(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
  supplementalSurfaceParts: readonly Viewport3DSurfacePart[],
  surfaceIndices: Uint32Array | null,
): Uint32Array | null {
  if (!surfaceIndices) return null;
  if (surfaceEdgeIndexCache.has(surfaceIndices)) {
    return surfaceEdgeIndexCache.get(surfaceIndices) ?? null;
  }
  const edges = measureViewport3DTopologyBuild(
    "fullmag.viewport3d.buildPartSurfaceEdgeIndices",
    () =>
      buildPartSurfaceEdgeIndicesWithSupplemental(
        part,
        topology,
        supplementalSurfaceParts,
      ),
  );
  surfaceEdgeIndexCache.set(surfaceIndices, edges);
  return edges;
}

function buildCachedPartSurfaceIndicesWithSupplemental(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
  supplementalSurfaceParts: readonly Viewport3DSurfacePart[],
): Uint32Array | null {
  if (supplementalSurfaceParts.length === 0) {
    return buildPartSurfaceIndices(part, topology);
  }
  return buildPartSurfaceIndicesWithSupplementalUncached(
    part,
    topology,
    supplementalSurfaceParts,
  );
}

export function resolveDomainBounds(
  meta: DomainMetaResource | null | undefined,
): Viewport3DBounds | null {
  const min = meta?.bounds.min;
  const max = meta?.bounds.max;
  if (!min || !max || min.length < 3 || max.length < 3) {
    return null;
  }

  return boundsFromMinMax(
    [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  );
}

export function resolveUniverseBounds(
  universe: UniverseResource | null | undefined,
): Viewport3DBounds | null {
  if (!universe) return null;

  return (
    boundsFromUniverseConfig(universe.universe) ??
    boundsFromUniverseConfig(universe.study_universe_mesh) ??
    boundsFromOptionalMinMax(
      universe.object_bounds_min,
      universe.object_bounds_max,
    )
  );
}

export function resolveTopologyBounds(
  topology: DecodedTopology | null | undefined,
): Viewport3DBounds | null {
  if (!topology || topology.positions.length < 3) {
    return null;
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < topology.positions.length; index += 3) {
    const x = topology.positions[index] ?? 0;
    const y = topology.positions[index + 1] ?? 0;
    const z = topology.positions[index + 2] ?? 0;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }

  return boundsFromMinMax(min, max);
}

export function combineViewport3DBounds(
  boundsList: Array<Viewport3DBounds | null | undefined>,
): Viewport3DBounds | null {
  const validBounds = boundsList.filter(
    (entry): entry is Viewport3DBounds => Boolean(entry),
  );
  if (!validBounds.length) return null;

  const min = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.min(current[0], bounds.center[0] - bounds.size[0] / 2),
      Math.min(current[1], bounds.center[1] - bounds.size[1] / 2),
      Math.min(current[2], bounds.center[2] - bounds.size[2] / 2),
    ],
    [Infinity, Infinity, Infinity],
  );
  const max = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.max(current[0], bounds.center[0] + bounds.size[0] / 2),
      Math.max(current[1], bounds.center[1] + bounds.size[1] / 2),
      Math.max(current[2], bounds.center[2] + bounds.size[2] / 2),
    ],
    [-Infinity, -Infinity, -Infinity],
  );

  return boundsFromMinMax(min, max);
}

export function buildVectorLineSegments(
  topology: DecodedTopology | null | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors = 2048,
  options: Viewport3DVectorSegmentOptions = {},
): Float32Array | null {
  if (!topology) return null;
  return buildVectorLineSegmentsFromPositions(
    topology,
    fieldVector,
    scale,
    maxVectors,
    {
      ...options,
      surfaceTriangleIndices:
        options.surfaceTriangleIndices ?? topology.boundaryFaces,
    },
  );
}

/** Number of floats per vector segment: [sx,sy,sz, ex,ey,ez, relMag] */
const VECTOR_SEGMENT_STRIDE = 7;
const VECTOR_SCALE_SAMPLE_LIMIT = 512;
const VECTOR_LOCAL_SPACING_RATIO = 0.9;

export function resolveViewport3DVectorSegmentScale(
  topology: Viewport3DPositionSource,
  requestedScale: number,
  nodeSelection?: Viewport3DNodeSelection | null,
): number {
  const safeScale = Math.max(requestedScale, 1e-12);
  const selectedNodeCount = Math.max(
    0,
    Math.floor(resolveNodeSelectionCount(nodeSelection, topology)),
  );
  if (selectedNodeCount <= 1) return safeScale;

  const sampleCount = Math.min(selectedNodeCount, VECTOR_SCALE_SAMPLE_LIMIT);
  const stride = Math.max(1, Math.floor(selectedNodeCount / sampleCount));
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let acceptedSamples = 0;

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const pointIndex = resolveNodeSelectionIndex(nodeSelection, sample * stride);
    if (pointIndex === null || pointIndex >= topology.nodeCount) continue;

    const positionOffset = pointIndex * 3;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
    acceptedSamples += 1;
  }

  if (acceptedSamples <= 1) return safeScale;

  const maxExtent = Math.max(
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  );
  if (!Number.isFinite(maxExtent) || maxExtent <= 0) return safeScale;

  const approximateSpacing =
    maxExtent / Math.cbrt(Math.max(selectedNodeCount, 1));
  const localCap = Math.max(
    approximateSpacing * VECTOR_LOCAL_SPACING_RATIO,
    1e-12,
  );
  return Math.min(safeScale, localCap);
}

function buildVectorLineSegmentsFromPositions(
  topology: Viewport3DPositionSource,
  fieldVector: DecodedFieldVector | null | undefined,
  scale: number,
  maxVectors = 2048,
  options: Viewport3DVectorSegmentOptions = {},
): Float32Array | null {
  if (
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    topology.nodeCount === 0
  ) {
    return null;
  }

  const vectorCount = Math.min(
    topology.nodeCount,
    fieldVector.pointCount,
    maxVectors,
  );
  const stride = Math.max(
    1,
    Math.floor(Math.min(topology.nodeCount, fieldVector.pointCount) / vectorCount),
  );

  // First pass: compute maximum magnitude for relative-magnitude channel.
  let maxMag = 0;
  for (let vector = 0; vector < vectorCount; vector += 1) {
    const valueOffset = vector * stride * fieldVector.nComp;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const mag = Math.hypot(vx, vy, vz);
    if (mag > maxMag) maxMag = mag;
  }
  const scaleMag = Math.max(maxMag, 1e-12);
  const effectiveScale = resolveViewport3DVectorSegmentScale(topology, scale);
  const anchorMode = options.anchorMode ?? "center";
  const surfaceOffsetEnabled = options.surfaceOffsetEnabled === true;
  const surfaceOffsetScale = Math.max(options.surfaceOffsetScale ?? 0, 0);
  const surfaceNormals =
    surfaceOffsetEnabled
      ? cachedAveragedSurfaceNodeNormals(
          topology,
          options.surfaceTriangleIndices,
        )
      : null;
  const surfaceOffsetDistance = resolveVectorSurfaceOffsetDistance(
    effectiveScale,
    anchorMode,
    surfaceOffsetEnabled,
    surfaceOffsetScale,
  );

  const segments = new Float32Array(vectorCount * VECTOR_SEGMENT_STRIDE);
  let visibleVectorCount = 0;

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const pointIndex = vector * stride;
    const positionOffset = pointIndex * 3;
    const valueOffset = pointIndex * fieldVector.nComp;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz);
    if (length === 0) continue; // skip zero-magnitude nodes (no visible vector)
    const target = visibleVectorCount * VECTOR_SEGMENT_STRIDE;
    const ux = vx / length;
    const uy = vy / length;
    const uz = vz / length;
    const halfScale = effectiveScale / 2;
    const [ax, ay, az] = offsetVectorAnchor(
      x,
      y,
      z,
      pointIndex,
      surfaceNormals,
      surfaceOffsetDistance,
    );

    if (anchorMode === "tail") {
      segments[target] = ax;
      segments[target + 1] = ay;
      segments[target + 2] = az;
      segments[target + 3] = ax + ux * effectiveScale;
      segments[target + 4] = ay + uy * effectiveScale;
      segments[target + 5] = az + uz * effectiveScale;
    } else {
      segments[target] = ax - ux * halfScale;
      segments[target + 1] = ay - uy * halfScale;
      segments[target + 2] = az - uz * halfScale;
      segments[target + 3] = ax + ux * halfScale;
      segments[target + 4] = ay + uy * halfScale;
      segments[target + 5] = az + uz * halfScale;
    }
    segments[target + 6] = length / scaleMag; // relative magnitude [0..1]
    visibleVectorCount += 1;
  }

  return visibleVectorCount > 0
    ? segments.slice(0, visibleVectorCount * VECTOR_SEGMENT_STRIDE)
    : null;
}

export function buildVectorLineSegmentsForNodeSelection(
  topology: DecodedTopology | null | undefined,
  fieldVector: DecodedFieldVector | null | undefined,
  nodeSelection: Viewport3DNodeSelection | null | undefined,
  scale: number,
  maxVectors = 2048,
  options: Viewport3DVectorSegmentOptions = {},
): Float32Array | null {
  if (!topology) return null;
  return buildVectorLineSegmentsForNodeSelectionFromPositions(
    topology,
    fieldVector,
    nodeSelection,
    scale,
    maxVectors,
    {
      ...options,
      surfaceTriangleIndices:
        options.surfaceTriangleIndices ?? topology.boundaryFaces,
    },
  );
}

function buildVectorLineSegmentsForNodeSelectionFromPositions(
  topology: Viewport3DPositionSource,
  fieldVector: DecodedFieldVector | null | undefined,
  nodeSelection: Viewport3DNodeSelection | null | undefined,
  scale: number,
  maxVectors = 2048,
  options: Viewport3DVectorSegmentOptions = {},
  fieldValueResolver: Viewport3DVectorFieldValueResolver | null = null,
): Float32Array | null {
  if (
    !fieldVector ||
    fieldVector.nComp < 3 ||
    fieldVector.pointCount === 0 ||
    topology.nodeCount === 0
  ) {
    return null;
  }

  const totalSelectedNodes = resolveNodeSelectionCount(nodeSelection, topology);
  if (totalSelectedNodes <= 0) {
    return null;
  }

  const vectorCount = Math.min(totalSelectedNodes, maxVectors);
  const stride = Math.max(1, Math.floor(totalSelectedNodes / vectorCount));
  const samples: Array<{
    pointIndex: number;
    valuePointIndex: number;
  }> = [];

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const selectedOffset = vector * stride;
    const pointIndex = resolveNodeSelectionIndex(
      nodeSelection,
      selectedOffset,
    );
    if (pointIndex === null || pointIndex >= topology.nodeCount) {
      continue;
    }
    const valuePointIndex = fieldValueResolver
      ? fieldValueResolver(pointIndex, selectedOffset)
      : pointIndex;
    if (valuePointIndex === null) {
      continue;
    }
    if (valuePointIndex < 0 || valuePointIndex >= fieldVector.pointCount) {
      continue;
    }
    samples.push({ pointIndex, valuePointIndex });
  }

  if (samples.length === 0) {
    return null;
  }

  // First pass: compute maximum magnitude for relative-magnitude channel.
  let maxMag = 0;
  for (const sample of samples) {
    const valueOffset = sample.valuePointIndex * fieldVector.nComp;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const mag = Math.hypot(vx, vy, vz);
    if (mag > maxMag) maxMag = mag;
  }
  const scaleMag = Math.max(maxMag, 1e-12);
  const effectiveScale = resolveViewport3DVectorSegmentScale(
    topology,
    scale,
    nodeSelection,
  );
  const anchorMode = options.anchorMode ?? "center";
  const surfaceOffsetEnabled = options.surfaceOffsetEnabled === true;
  const surfaceOffsetScale = Math.max(options.surfaceOffsetScale ?? 0, 0);
  const surfaceNormals =
    surfaceOffsetEnabled
      ? cachedAveragedSurfaceNodeNormals(
          topology,
          options.surfaceTriangleIndices,
        )
      : null;
  const surfaceOffsetDistance = resolveVectorSurfaceOffsetDistance(
    effectiveScale,
    anchorMode,
    surfaceOffsetEnabled,
    surfaceOffsetScale,
  );

  const segments = new Float32Array(samples.length * VECTOR_SEGMENT_STRIDE);
  let visibleVectorCount = 0;

  for (let vector = 0; vector < samples.length; vector += 1) {
    const sample = samples[vector];
    if (!sample) continue;
    const positionOffset = sample.pointIndex * 3;
    const valueOffset = sample.valuePointIndex * fieldVector.nComp;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz);
    if (length === 0) continue; // skip zero-magnitude nodes (no visible vector)
    const target = visibleVectorCount * VECTOR_SEGMENT_STRIDE;
    const ux = vx / length;
    const uy = vy / length;
    const uz = vz / length;
    const halfScale = effectiveScale / 2;
    const [ax, ay, az] = offsetVectorAnchor(
      x,
      y,
      z,
      sample.pointIndex,
      surfaceNormals,
      surfaceOffsetDistance,
    );

    if (anchorMode === "tail") {
      segments[target] = ax;
      segments[target + 1] = ay;
      segments[target + 2] = az;
      segments[target + 3] = ax + ux * effectiveScale;
      segments[target + 4] = ay + uy * effectiveScale;
      segments[target + 5] = az + uz * effectiveScale;
    } else {
      segments[target] = ax - ux * halfScale;
      segments[target + 1] = ay - uy * halfScale;
      segments[target + 2] = az - uz * halfScale;
      segments[target + 3] = ax + ux * halfScale;
      segments[target + 4] = ay + uy * halfScale;
      segments[target + 5] = az + uz * halfScale;
    }
    segments[target + 6] = length / scaleMag; // relative magnitude [0..1]
    visibleVectorCount += 1;
  }

  return visibleVectorCount > 0
    ? segments.slice(0, visibleVectorCount * VECTOR_SEGMENT_STRIDE)
    : null;
}

function cachedAveragedSurfaceNodeNormals(
  topology: Viewport3DPositionSource,
  triangleIndices: ArrayLike<number> | null | undefined,
): Float32Array | null {
  if (!triangleIndices || triangleIndices.length < 3) return null;
  if (typeof triangleIndices !== "object") {
    return buildAveragedSurfaceNodeNormals(topology, triangleIndices);
  }

  let normalCache = surfaceNodeNormalCache.get(topology);
  if (!normalCache) {
    normalCache = new WeakMap<object, Float32Array | null>();
    surfaceNodeNormalCache.set(topology, normalCache);
  }

  const cacheKey = triangleIndices;
  if (normalCache.has(cacheKey)) {
    return normalCache.get(cacheKey) ?? null;
  }

  const normals = buildAveragedSurfaceNodeNormals(topology, triangleIndices);
  normalCache.set(cacheKey, normals);
  return normals;
}

function buildAveragedSurfaceNodeNormals(
  topology: Viewport3DPositionSource,
  triangleIndices: ArrayLike<number> | null | undefined,
): Float32Array | null {
  if (!triangleIndices || triangleIndices.length < 3) return null;

  const normals = new Float32Array(topology.nodeCount * 3);
  for (let index = 0; index + 2 < triangleIndices.length; index += 3) {
    const a = triangleIndices[index] ?? 0;
    const b = triangleIndices[index + 1] ?? 0;
    const c = triangleIndices[index + 2] ?? 0;
    if (
      a >= topology.nodeCount ||
      b >= topology.nodeCount ||
      c >= topology.nodeCount
    ) {
      continue;
    }

    const ao = a * 3;
    const bo = b * 3;
    const co = c * 3;
    const ax = topology.positions[ao] ?? 0;
    const ay = topology.positions[ao + 1] ?? 0;
    const az = topology.positions[ao + 2] ?? 0;
    const abx = (topology.positions[bo] ?? 0) - ax;
    const aby = (topology.positions[bo + 1] ?? 0) - ay;
    const abz = (topology.positions[bo + 2] ?? 0) - az;
    const acx = (topology.positions[co] ?? 0) - ax;
    const acy = (topology.positions[co + 1] ?? 0) - ay;
    const acz = (topology.positions[co + 2] ?? 0) - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const length = Math.hypot(nx, ny, nz);
    if (length <= 0) continue;

    const ux = nx / length;
    const uy = ny / length;
    const uz = nz / length;
    for (const point of [a, b, c]) {
      const offset = point * 3;
      normals[offset] += ux;
      normals[offset + 1] += uy;
      normals[offset + 2] += uz;
    }
  }

  let hasNormal = false;
  for (let point = 0; point < topology.nodeCount; point += 1) {
    const offset = point * 3;
    const nx = normals[offset] ?? 0;
    const ny = normals[offset + 1] ?? 0;
    const nz = normals[offset + 2] ?? 0;
    const length = Math.hypot(nx, ny, nz);
    if (length <= 0) continue;
    normals[offset] = nx / length;
    normals[offset + 1] = ny / length;
    normals[offset + 2] = nz / length;
    hasNormal = true;
  }

  return hasNormal ? normals : null;
}

function offsetVectorAnchor(
  x: number,
  y: number,
  z: number,
  pointIndex: number,
  surfaceNormals: Float32Array | null,
  surfaceOffsetDistance: number,
): [number, number, number] {
  if (!surfaceNormals || surfaceOffsetDistance <= 0) {
    return [x, y, z];
  }

  const offset = pointIndex * 3;
  return [
    x + (surfaceNormals[offset] ?? 0) * surfaceOffsetDistance,
    y + (surfaceNormals[offset + 1] ?? 0) * surfaceOffsetDistance,
    z + (surfaceNormals[offset + 2] ?? 0) * surfaceOffsetDistance,
  ];
}

function resolveVectorSurfaceOffsetDistance(
  effectiveScale: number,
  anchorMode: Viewport3DVectorAnchorMode,
  surfaceOffsetEnabled: boolean,
  extraSurfaceOffsetScale: number,
): number {
  if (!surfaceOffsetEnabled) return 0;
  const baseClearance =
    anchorMode === "tail" ? effectiveScale : effectiveScale / 2;
  return baseClearance + effectiveScale * Math.max(extraSurfaceOffsetScale, 0);
}

function boundsFromMinMax(
  min: [number, number, number],
  max: [number, number, number],
): Viewport3DBounds {
  const size: [number, number, number] = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];
  const radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12);

  return {
    center: [
      min[0] + size[0] / 2,
      min[1] + size[1] / 2,
      min[2] + size[2] / 2,
    ],
    radius,
    size,
  };
}

function boundsFromOptionalMinMax(
  min: readonly number[] | null | undefined,
  max: readonly number[] | null | undefined,
): Viewport3DBounds | null {
  if (!min || !max || min.length < 3 || max.length < 3) {
    return null;
  }

  return boundsFromMinMax(
    [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  );
}

function boundsFromUniverseConfig(value: unknown): Viewport3DBounds | null {
  const record = asRecord(value);
  if (!record) return null;

  const explicitBounds = boundsFromOptionalMinMax(
    asVec3(record.bounds_min) ?? asVec3(record.min),
    asVec3(record.bounds_max) ?? asVec3(record.max),
  );
  if (explicitBounds) return explicitBounds;

  const size = asVec3(record.size);
  if (!size) return null;

  const center = asVec3(record.center) ?? [0, 0, 0];
  const half: [number, number, number] = [
    size[0] / 2,
    size[1] / 2,
    size[2] / 2,
  ];

  return boundsFromMinMax(
    [
      center[0] - half[0],
      center[1] - half[1],
      center[2] - half[2],
    ],
    [
      center[0] + half[0],
      center[1] + half[1],
      center[2] + half[2],
    ],
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asVec3(value: unknown): [number, number, number] | null {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.slice(0, 3).every((entry) =>
      typeof entry === "number" && Number.isFinite(entry),
    )
  ) {
    return [value[0], value[1], value[2]];
  }
  return null;
}

export function resolveNodeSelectionCount(
  selection: Viewport3DNodeSelection | null | undefined,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
): number {
  const explicitIndices = selection?.nodeIndices ?? selection?.node_indices;
  if (explicitIndices !== undefined) {
    return explicitIndices.length;
  }

  const start = Math.max(
    0,
    Math.floor(selection?.nodeStart ?? selection?.node_start ?? 0),
  );
  if (start >= topology.nodeCount) {
    return 0;
  }

  const rawCount = selection?.nodeCount ?? selection?.node_count;
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? topology.nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  return Math.min(count, topology.nodeCount - start);
}

export function resolveNodeSelectionIndex(
  selection: Viewport3DNodeSelection | null | undefined,
  offset: number,
): number | null {
  const explicitIndices = selection?.nodeIndices ?? selection?.node_indices;
  if (explicitIndices !== undefined) {
    return explicitIndices[offset] ?? null;
  }

  return (selection?.nodeStart ?? selection?.node_start ?? 0) + offset;
}
