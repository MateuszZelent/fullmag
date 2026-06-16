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

import {
  buildMappedVertexScalarColors,
  buildVertexScalarColors,
  type ScalarColorBuffer,
} from "./viewport3dFieldMapping";
import { buildSurfaceEdgeIndices } from "./viewport3dSurfaceEdges";

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
  part: TPart;
  surfaceIndices: Uint32Array | null;
  surfaceNodeSelection: Viewport3DNodeSelection | null;
  volumeEdgeIndices: Uint32Array | null;
}

export interface Viewport3DTopologyRenderModel<
  TPart extends Viewport3DRenderablePart = Viewport3DRenderablePart,
> {
  fallbackSurfaceIndices: Uint32Array;
  fallbackVolumeEdgeIndices: Uint32Array;
  magneticParts: Array<Viewport3DTopologyPartRenderModel<TPart>>;
  airboxParts: Array<Viewport3DTopologyPartRenderModel<TPart>>;
  meshGenerationId: string | null;
  meshRevision: number | string | null;
  nodeCount: number;
  positions: Float32Array;
}

export interface Viewport3DFieldRenderModel {
  complexFieldVector: DecodedComplexFieldVector | null;
  fullVectorSegments: Float32Array | null;
  partVectorSegments: Map<string, Float32Array | null>;
  scalarColors: ScalarColorBuffer | null;
  scalarColorsByPartAndMode: Map<string, Map<string, ScalarColorBuffer | null>>;
  scalarColorsByMode: Map<string, ScalarColorBuffer | null>;
  visualizationPhaseRad: number | null;
}

export interface Viewport3DFieldRenderOptions {
  fullVectorBudget?: number;
  fullVectorAnchorMode?: Viewport3DVectorAnchorMode;
  fullVectorSurfaceOffsetEnabled?: boolean;
  fullVectorSurfaceOffsetScale?: number;
  complexFieldVector?: DecodedComplexFieldVector | null;
  partFieldVectors?: ReadonlyMap<string, DecodedFieldVector>;
  partVectorAnchorModes?: ReadonlyMap<string, Viewport3DVectorAnchorMode>;
  partVectorBudgets?: ReadonlyMap<string, number>;
  partVectorScales?: ReadonlyMap<string, number>;
  partVectorScopes?: ReadonlyMap<string, "surface" | "full">;
  partVectorSurfaceOffsetEnabled?: ReadonlySet<string>;
  partVectorSurfaceOffsetScales?: ReadonlyMap<string, number>;
  scalarColorModes?: ReadonlySet<string>;
  scalarColorPalette?: string;
  scalarColorsVisible?: boolean;
  vectorColorMode?: string;
  visualizationPhaseRad?: number | null;
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

interface ScopedVectorSelectionResolution {
  resolverSelection: Viewport3DNodeSelection;
  renderSelection: Viewport3DNodeSelection;
}

const renderCacheCounters = new Map<string, Viewport3DRenderCacheCounter>();

const VIEWPORT_3D_RENDER_CACHE_DEFINITIONS = [
  ["viewport3d.render.scalarColorCache", "Scalar color cache"],
  ["viewport3d.render.partScalarColorCache", "Part scalar color cache"],
  ["viewport3d.render.mappedScalarColorCache", "Mapped scalar color cache"],
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
const surfaceNodeNormalCache = new WeakMap<
  Viewport3DPositionSource,
  WeakMap<object, Float32Array | null>
>();

function buildTopologyPositions(topology: DecodedTopology): Float32Array {
  const cached = topologyPositionCache.get(topology);
  if (cached) return cached;

  const positions = Float32Array.from(topology.positions);
  topologyPositionCache.set(topology, positions);
  return positions;
}

function buildCachedTopologySurfaceIndices(
  topology: DecodedTopology,
): Uint32Array {
  const cached = topologySurfaceIndexCache.get(topology);
  if (cached) return cached;

  const surfaceIndices = buildTetraSurfaceIndices(topology.indices);
  topologySurfaceIndexCache.set(topology, surfaceIndices);
  return surfaceIndices;
}

function buildCachedTopologyVolumeEdgeIndices(
  topology: DecodedTopology,
): Uint32Array {
  const cached = topologyVolumeEdgeIndexCache.get(topology);
  if (cached) return cached;

  const volumeEdgeIndices = buildTetraVolumeEdgeIndices(topology.indices);
  topologyVolumeEdgeIndexCache.set(topology, volumeEdgeIndices);
  return volumeEdgeIndices;
}

function getCachedPartTopologyValue<TValue>(
  cache: WeakMap<DecodedTopology, WeakMap<Viewport3DSurfacePart, TValue>>,
  topology: DecodedTopology,
  part: Viewport3DSurfacePart,
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

  const value = build();
  partCache.set(part, value);
  return value;
}

function buildCachedSurfaceEdgeIndices(
  surfaceIndices: Uint32Array | null,
): Uint32Array | null {
  if (!surfaceIndices) return null;
  if (surfaceEdgeIndexCache.has(surfaceIndices)) {
    return surfaceEdgeIndexCache.get(surfaceIndices) ?? null;
  }

  const edgeIndices = buildSurfaceEdgeIndices(surfaceIndices);
  surfaceEdgeIndexCache.set(surfaceIndices, edgeIndices);
  return edgeIndices;
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
  } = {},
): Viewport3DTopologyRenderModel<TPart> | null {
  if (!topology) return null;

  const fallbackSurfaceIndices = lazyValue(() =>
    buildCachedTopologySurfaceIndices(topology),
  );
  const fallbackVolumeEdgeIndices = lazyValue(() =>
    buildCachedTopologyVolumeEdgeIndices(topology),
  );
  const airboxVolumeEdgeFallback = lazyValue(() =>
    airboxParts.length > 0
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
      ),
    ),
    get fallbackSurfaceIndices() {
      return fallbackSurfaceIndices();
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
      ),
    ),
    meshGenerationId: meshIdentity.meshGenerationId ?? null,
    meshRevision: meshIdentity.meshRevision ?? null,
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
): Viewport3DTopologyPartRenderModel<TPart> {
  const topologyModel = buildPartTopologyModel(
    part,
    topology,
    fallbackVolumeEdgeIndices,
    supplementalSurfaceParts,
  );
  return {
    get edgeIndices() {
      return topologyModel.edgeIndices;
    },
    part,
    get surfaceIndices() {
      return topologyModel.surfaceIndices;
    },
    get surfaceNodeSelection() {
      return topologyModel.surfaceNodeSelection;
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
  const renderFieldVector =
    buildCachedComplexPhaseProjection(
      options.complexFieldVector,
      visualizationPhaseRad,
    ) ?? fieldVector;
  const fullFieldVector = isFullTopologyFieldVector(
    renderFieldVector,
    topology.nodeCount,
  )
    ? renderFieldVector
    : null;
  const magneticFieldNodeIndices =
    !fullFieldVector && renderFieldVector
      ? buildMagneticFieldNodeIndices(topology, renderFieldVector.pointCount)
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
                )
              : buildCachedMappedVertexScalarColors(
                  topology,
                  renderFieldVector,
                  magneticFieldNodeIndices,
                  colorMode,
                  options.scalarColorPalette,
                ),
          ]),
        );
  attachComplexShaderValuesByMode(
    scalarColorsByMode,
    options.complexFieldVector,
    fullFieldVector ? null : magneticFieldNodeIndices,
    topology.nodeCount,
    visualizationPhaseRad,
  );
  const scalarColors =
    scalarColorsByMode.get(options.vectorColorMode ?? "magnitude") ?? null;
  const partVectorSegments = new Map<string, Float32Array | null>();
  const scalarColorsByPartAndMode = new Map<
    string,
    Map<string, ScalarColorBuffer | null>
  >();
  const hasPartBudgetPlan = Boolean(options.partVectorBudgets);
  const magneticPartSet = new Set(topology.magneticParts);
  const airboxPartSet = new Set(topology.airboxParts);
  const magneticVectorNodeIndices =
    topology.airboxParts.length > 0
      ? buildMagneticPartNodeIndexSet(topology)
      : null;

  for (const partModel of [...topology.magneticParts, ...topology.airboxParts]) {
    const partId = partModel.part.id;
    const partBudget = hasPartBudgetPlan
      ? options.partVectorBudgets?.get(partId) ?? 0
      : DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET;
    const vectorScope = options.partVectorScopes?.get(partId) ?? "full";
    const vectorSelection =
      vectorScope === "surface"
        ? partModel.surfaceNodeSelection ?? partModel.part
        : partModel.part;
    const partScale = options.partVectorScales?.get(partId) ?? 1;
    const surfaceOffsetEnabled =
      options.partVectorSurfaceOffsetEnabled?.has(partId) ?? false;
    const surfaceOffsetScale =
      options.partVectorSurfaceOffsetScales?.get(partId) ?? 0;
    const explicitPartFieldVector =
      options.partFieldVectors?.get(partId) ?? null;
    const partUsesMagneticOnlyField = Boolean(
      !explicitPartFieldVector &&
        !fullFieldVector &&
        magneticFieldValueResolver &&
        magneticPartSet.has(partModel),
    );
    const partFieldVector =
      explicitPartFieldVector ??
      (partUsesMagneticOnlyField ? renderFieldVector : fullFieldVector);
    const isScopedPartFieldVector = Boolean(
      partFieldVector &&
        partFieldVector !== renderFieldVector &&
        partFieldVector.pointCount < topology.nodeCount,
    );
    const scopedVectorSelection =
      isScopedPartFieldVector && partFieldVector
        ? resolveScopedPartVectorSelection(
            vectorSelection,
            topology,
            partFieldVector.pointCount,
            airboxPartSet.has(partModel) ? magneticVectorNodeIndices : null,
          )
        : {
            renderSelection:
              airboxPartSet.has(partModel) && magneticVectorNodeIndices
                ? filterNodeSelectionExcludingIndices(
                    vectorSelection,
                    topology,
                    magneticVectorNodeIndices,
                  )
                : vectorSelection,
            resolverSelection: vectorSelection,
          };
    const renderVectorSelection = scopedVectorSelection.renderSelection;
    if (partFieldVector && partFieldVector !== renderFieldVector) {
      scalarColorsByPartAndMode.set(
        partId,
        new Map(
          [...requestedScalarColorModes].map((colorMode) => [
            colorMode,
            buildCachedPartVertexScalarColors(
              partModel,
              topology,
              partFieldVector,
              colorMode,
              options.scalarColorPalette,
            ),
          ]),
        ),
      );
    }
    // Only build a scoped resolver when the part field data is genuinely scoped (fewer points
    // than the full topology). When the API returns full-domain data for a scoped request
    // (e.g. scope_kind=airbox returning all 18701 nodes), applying the resolver would read
    // field values at the wrong (local) indices instead of the correct global node indices.
    const fieldValueResolver =
      partFieldVector &&
      (partUsesMagneticOnlyField
        ? magneticFieldValueResolver
        : isScopedPartFieldVector
          ? buildScopedPartFieldValueResolver(
              scopedVectorSelection.resolverSelection,
              topology,
              partFieldVector.pointCount,
            )
          : null);
    partVectorSegments.set(
      partId,
      buildCachedPartVectorSegments(
        partModel,
        topology,
        partFieldVector,
        renderVectorSelection,
        vectorScope,
        scale * partScale,
        partBudget,
        {
          anchorMode: options.partVectorAnchorModes?.get(partId) ?? "center",
          surfaceOffsetEnabled,
          surfaceOffsetScale,
          surfaceTriangleIndices:
            surfaceOffsetEnabled ? partModel.surfaceIndices : null,
        },
        fieldValueResolver,
      ),
    );
  }

  const fullVectorBudget =
    options.fullVectorBudget ?? DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET;

  return {
    complexFieldVector: options.complexFieldVector ?? null,
    fullVectorSegments: buildCachedFullVectorSegments(
      topology,
      fullFieldVector,
      scale,
      fullVectorBudget,
      {
        anchorMode: options.fullVectorAnchorMode ?? "center",
        surfaceOffsetEnabled: options.fullVectorSurfaceOffsetEnabled ?? false,
        surfaceOffsetScale: options.fullVectorSurfaceOffsetScale ?? 0,
        surfaceTriangleIndices:
          options.fullVectorSurfaceOffsetEnabled === true
            ? topology.fallbackSurfaceIndices
            : null,
      },
    ),
    partVectorSegments,
    scalarColors,
    scalarColorsByPartAndMode,
    scalarColorsByMode,
    visualizationPhaseRad,
  };
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
  let cachedByPhase = complexPhaseProjectionCache.get(complexFieldVector);
  if (!cachedByPhase) {
    cachedByPhase = new Map();
    complexPhaseProjectionCache.set(complexFieldVector, cachedByPhase);
  }
  const cached = cachedByPhase.get(cacheKey);
  if (cached) return cached;

  const projected = buildComplexPhaseProjection(complexFieldVector, phase);
  cachedByPhase.set(cacheKey, projected);
  return projected;
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
    grid: complexFieldVector.grid,
    nComp: componentCount,
    pointCount: complexFieldVector.pointCount,
    quantityId: complexFieldVector.quantityId,
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
): void {
  if (!complexFieldVector || phaseRad === null) return;
  for (const buffer of scalarColorsByMode.values()) {
    attachComplexShaderValues(
      buffer,
      complexFieldVector,
      targetNodeIndices,
      vertexCount,
      phaseRad,
    );
  }
}

function attachComplexShaderValues(
  buffer: ScalarColorBuffer | null,
  complexFieldVector: DecodedComplexFieldVector,
  targetNodeIndices: Uint32Array | null,
  vertexCount: number,
  phaseRad: number,
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
}

function isFullTopologyFieldVector(
  fieldVector: DecodedFieldVector | null | undefined,
  nodeCount: number,
): fieldVector is DecodedFieldVector {
  return Boolean(fieldVector) && fieldVector!.pointCount === nodeCount;
}

function buildCachedMappedVertexScalarColors(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  fieldVector: DecodedFieldVector | null | undefined,
  targetNodeIndices: Uint32Array | null | undefined,
  colorMode: string | undefined,
  colorPalette: string | undefined,
): ScalarColorBuffer | null {
  if (!fieldVector || !targetNodeIndices) return null;

  return getCachedNestedFieldValue(
    mappedScalarColorCache,
    topology,
    fieldVector,
    `${targetNodeIndices.length}:${topology.nodeCount}:${colorMode ?? "magnitude"}:${colorPalette ?? "viridis"}:mapped`,
    () =>
      buildMappedVertexScalarColors(
        fieldVector,
        targetNodeIndices,
        topology.nodeCount,
        Number.POSITIVE_INFINITY,
        colorMode,
        colorPalette,
      ),
    "viewport3d.render.mappedScalarColorCache",
  );
}

function buildCachedVertexScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  vertexCount: number,
  colorMode: string | undefined,
  colorPalette: string | undefined,
): ScalarColorBuffer | null {
  if (!fieldVector) return null;

  return getCachedValue(
    scalarColorCache,
    fieldVector,
    `${vertexCount}:${colorMode ?? "magnitude"}:${colorPalette ?? "viridis"}`,
    () =>
      buildVertexScalarColors(
        fieldVector,
        vertexCount,
        undefined,
        colorMode,
        colorPalette,
      ),
    "viewport3d.render.scalarColorCache",
  );
}

function buildMagneticFieldNodeIndices(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
  pointCount: number,
): Uint32Array | null {
  if (pointCount <= 0 || pointCount > topology.nodeCount) return null;

  const nodeIndices = new Set<number>();
  for (const partModel of topology.magneticParts) {
    const partNodeIndices = buildNodeSelectionIndices(partModel.part, topology);
    if (!partNodeIndices) continue;
    for (let index = 0; index < partNodeIndices.length; index += 1) {
      const nodeIndex = partNodeIndices[index] ?? -1;
      if (nodeIndex >= 0 && nodeIndex < topology.nodeCount) {
        nodeIndices.add(nodeIndex);
      }
    }
  }

  if (nodeIndices.size !== pointCount) return null;
  return Uint32Array.from(
    [...nodeIndices].toSorted((left, right) => left - right),
  );
}

function buildMagneticPartNodeIndexSet(
  topology: Viewport3DTopologyRenderModel<Viewport3DRenderablePart>,
): ReadonlySet<number> | null {
  const nodeIndices = new Set<number>();
  for (const partModel of topology.magneticParts) {
    const partNodeIndices = buildNodeSelectionIndices(partModel.part, topology);
    if (!partNodeIndices) continue;
    for (let index = 0; index < partNodeIndices.length; index += 1) {
      const nodeIndex = partNodeIndices[index] ?? -1;
      if (nodeIndex >= 0 && nodeIndex < topology.nodeCount) {
        nodeIndices.add(nodeIndex);
      }
    }
  }
  return nodeIndices.size > 0 ? nodeIndices : null;
}

function filterNodeSelectionExcludingIndices(
  selection: Viewport3DNodeSelection,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
  excludedNodeIndices: ReadonlySet<number>,
): Viewport3DNodeSelection {
  if (excludedNodeIndices.size === 0) return selection;
  const selectedNodeCount = resolveNodeSelectionCount(selection, topology);
  if (selectedNodeCount <= 0) return selection;

  const nodeIndices: number[] = [];
  let removed = false;
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
    if (excludedNodeIndices.has(nodeIndex)) {
      removed = true;
      continue;
    }
    nodeIndices.push(nodeIndex);
  }

  if (!removed) return selection;
  return nodeIndices.length > 0
    ? { nodeIndices }
    : { nodeCount: 0, nodeStart: 0 };
}

function resolveScopedPartVectorSelection(
  vectorSelection: Viewport3DNodeSelection,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
  fieldPointCount: number,
  excludedNodeIndices: ReadonlySet<number> | null,
): ScopedVectorSelectionResolution {
  const sampledVectorSelection = buildScopedPartFieldSampleSelection(
    vectorSelection,
    topology,
    fieldPointCount,
  );
  if (!excludedNodeIndices || excludedNodeIndices.size === 0) {
    return {
      renderSelection: sampledVectorSelection,
      resolverSelection: vectorSelection,
    };
  }

  const filteredSampledSelection = filterNodeSelectionExcludingIndices(
    sampledVectorSelection,
    topology,
    excludedNodeIndices,
  );
  const filteredBaseSelection = filterNodeSelectionExcludingIndices(
    vectorSelection,
    topology,
    excludedNodeIndices,
  );
  const filteredSampledCount = resolveNodeSelectionCount(
    filteredSampledSelection,
    topology,
  );
  const filteredBaseCount = resolveNodeSelectionCount(
    filteredBaseSelection,
    topology,
  );
  const expectedVisibleCount = Math.min(fieldPointCount, filteredBaseCount);
  if (filteredSampledCount >= expectedVisibleCount) {
    return {
      renderSelection: filteredSampledSelection,
      resolverSelection: vectorSelection,
    };
  }

  return {
    renderSelection: buildScopedPartFieldSampleSelection(
      filteredBaseSelection,
      topology,
      fieldPointCount,
    ),
    resolverSelection: filteredBaseSelection,
  };
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
  colorMode: string | undefined,
  colorPalette: string | undefined,
): ScalarColorBuffer | null {
  if (!fieldVector) return null;
  if (fieldVector.pointCount >= topology.nodeCount) {
    return buildCachedVertexScalarColors(
      fieldVector,
      topology.nodeCount,
      colorMode,
      colorPalette,
    );
  }

  const targetNodeIndices = buildNodeSelectionIndices(partModel.part, topology);
  if (!targetNodeIndices || targetNodeIndices.length !== fieldVector.pointCount) {
    return null;
  }

  return getCachedNestedFieldValue(
    partScalarColorCache,
    partModel,
    fieldVector,
    `${topology.nodeCount}:${colorMode ?? "magnitude"}:${colorPalette ?? "viridis"}:scoped`,
    () =>
      buildMappedVertexScalarColors(
        fieldVector,
        targetNodeIndices,
        topology.nodeCount,
        undefined,
        colorMode,
        colorPalette,
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
    return entries.get(key) as TValue;
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
      entryCount: counter?.entryCount ?? 0,
      id,
      label: counter?.label ?? id,
      maxBytes: null,
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

export function buildTetraSurfaceIndices(indices: Uint32Array): Uint32Array {
  const tetraCount = Math.floor(indices.length / 4);
  const faces = new Uint32Array(tetraCount * 12);

  for (let tetra = 0; tetra < tetraCount; tetra += 1) {
    const source = tetra * 4;
    const target = tetra * 12;
    const a = indices[source] ?? 0;
    const b = indices[source + 1] ?? 0;
    const c = indices[source + 2] ?? 0;
    const d = indices[source + 3] ?? 0;

    faces.set([a, b, c, a, b, d, a, c, d, b, c, d], target);
  }

  return faces;
}

export function buildTetraVolumeEdgeIndices(indices: Uint32Array): Uint32Array {
  const tetraCount = Math.floor(indices.length / 4);
  const edges: number[] = [];
  const numericKeyBase = resolveNumericEdgeKeyBase(indices);

  if (numericKeyBase !== null) {
    const seen = new Set<number>();
    for (let tetra = 0; tetra < tetraCount; tetra += 1) {
      const source = tetra * 4;
      const a = indices[source] ?? 0;
      const b = indices[source + 1] ?? 0;
      const c = indices[source + 2] ?? 0;
      const d = indices[source + 3] ?? 0;

      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, a, b);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, a, c);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, a, d);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, b, c);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, b, d);
      appendTetraEdgeByNumericKey(edges, seen, numericKeyBase, c, d);
    }

    return new Uint32Array(edges);
  }

  const seen = new Set<string>();

  for (let tetra = 0; tetra < tetraCount; tetra += 1) {
    const source = tetra * 4;
    const a = indices[source] ?? 0;
    const b = indices[source + 1] ?? 0;
    const c = indices[source + 2] ?? 0;
    const d = indices[source + 3] ?? 0;

    appendTetraEdgeByStringKey(edges, seen, a, b);
    appendTetraEdgeByStringKey(edges, seen, a, c);
    appendTetraEdgeByStringKey(edges, seen, a, d);
    appendTetraEdgeByStringKey(edges, seen, b, c);
    appendTetraEdgeByStringKey(edges, seen, b, d);
    appendTetraEdgeByStringKey(edges, seen, c, d);
  }

  return new Uint32Array(edges);
}

function resolveNumericEdgeKeyBase(indices: Uint32Array): number | null {
  let maxIndex = 0;
  for (let index = 0; index < indices.length; index += 1) {
    const nodeIndex = indices[index] ?? 0;
    if (nodeIndex > maxIndex) {
      maxIndex = nodeIndex;
    }
  }

  const keyBase = maxIndex + 1;
  return keyBase * keyBase <= Number.MAX_SAFE_INTEGER ? keyBase : null;
}

function appendTetraEdgeByNumericKey(
  edges: number[],
  seen: Set<number>,
  keyBase: number,
  first: number,
  second: number,
): void {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = a * keyBase + b;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a, b);
}

function appendTetraEdgeByStringKey(
  edges: number[],
  seen: Set<string>,
  first: number,
  second: number,
): void {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = `${a}:${b}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a, b);
}

export function buildPartSurfaceIndices(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  return getCachedPartTopologyValue(
    partSurfaceIndexCache,
    topology,
    part,
    () => buildPartSurfaceIndicesUncached(part, topology),
  );
}

function buildPartSurfaceIndicesUncached(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  if (part.surface_faces?.length) {
    return flattenSurfaceFaces(part.surface_faces);
  }

  if (part.boundary_face_indices?.length) {
    return surfaceIndicesFromBoundaryFaces(
      topology,
      part.boundary_face_indices,
    );
  }

  if (part.boundary_face_count <= 0) {
    return null;
  }

  return surfaceIndicesFromBoundaryFaceRange(
    topology,
    part.boundary_face_start,
    part.boundary_face_count,
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
    () => buildPartVolumeEdgeIndicesUncached(part, topology),
  );
}

function buildPartVolumeEdgeIndicesUncached(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  if (elementCount > 0) {
    const indexStart = elementStart * 4;
    const indexEnd = Math.min(
      topology.indices.length,
      indexStart + elementCount * 4,
    );
    if (indexStart < topology.indices.length && indexEnd > indexStart) {
      return buildTetraVolumeEdgeIndices(
        topology.indices.subarray(indexStart, indexEnd),
      );
    }
  }

  return buildPartVolumeEdgeIndicesFromNodes(part, topology);
}

function buildPartVolumeEdgeIndicesFromNodes(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): Uint32Array | null {
  const nodeSet = buildPartNodeSet(part, topology.nodeCount);
  if (!nodeSet) return null;

  const selectedTetraIndices: number[] = [];
  for (let source = 0; source + 3 < topology.indices.length; source += 4) {
    const a = topology.indices[source] ?? 0;
    const b = topology.indices[source + 1] ?? 0;
    const c = topology.indices[source + 2] ?? 0;
    const d = topology.indices[source + 3] ?? 0;
    if (
      nodeSet.has(a) &&
      nodeSet.has(b) &&
      nodeSet.has(c) &&
      nodeSet.has(d)
    ) {
      selectedTetraIndices.push(a, b, c, d);
    }
  }

  return selectedTetraIndices.length
    ? buildTetraVolumeEdgeIndices(new Uint32Array(selectedTetraIndices))
    : null;
}

function buildUnclaimedVolumeEdgeIndices(
  topology: DecodedTopology,
  claimedParts: readonly Viewport3DSurfacePart[],
): Uint32Array | null {
  if (topology.indices.length < 4) return null;
  if (claimedParts.length === 0) {
    return buildTetraVolumeEdgeIndices(topology.indices);
  }

  const claims: PartElementClaim[] = [];
  for (const part of claimedParts) {
    const claim = buildPartElementClaim(part, topology);
    if (claim) {
      claims.push(claim);
    }
  }
  if (claims.length === 0) return null;

  const selectedTetraIndices: number[] = [];
  let claimedElementCount = 0;
  for (
    let elementIndex = 0, source = 0;
    source + 3 < topology.indices.length;
    elementIndex += 1, source += 4
  ) {
    const a = topology.indices[source] ?? 0;
    const b = topology.indices[source + 1] ?? 0;
    const c = topology.indices[source + 2] ?? 0;
    const d = topology.indices[source + 3] ?? 0;
    if (isElementClaimed(elementIndex, a, b, c, d, claims)) {
      claimedElementCount += 1;
      continue;
    }
    selectedTetraIndices.push(a, b, c, d);
  }

  if (claimedElementCount === 0) return null;

  return selectedTetraIndices.length
    ? buildTetraVolumeEdgeIndices(new Uint32Array(selectedTetraIndices))
    : null;
}

type PartElementClaim =
  | { end: number; start: number; type: "range" }
  | { nodeSet: Set<number>; type: "nodes" };

function buildPartElementClaim(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
): PartElementClaim | null {
  const elementStart = Math.max(0, Math.floor(part.element_start ?? 0));
  const elementCount = Math.max(0, Math.floor(part.element_count ?? 0));
  const topologyElementCount = Math.floor(topology.indices.length / 4);
  if (elementCount > 0 && elementStart < topologyElementCount) {
    const end = Math.min(topologyElementCount, elementStart + elementCount);
    return { end, start: elementStart, type: "range" };
  }

  const nodeSet = buildPartNodeSet(part, topology.nodeCount);
  return nodeSet ? { nodeSet, type: "nodes" } : null;
}

function isElementClaimed(
  elementIndex: number,
  a: number,
  b: number,
  c: number,
  d: number,
  claims: readonly PartElementClaim[],
): boolean {
  for (const claim of claims) {
    if (claim.type === "range") {
      if (elementIndex >= claim.start && elementIndex < claim.end) {
        return true;
      }
      continue;
    }
    const nodeSet = claim.nodeSet;
    if (nodeSet.has(a) && nodeSet.has(b) && nodeSet.has(c) && nodeSet.has(d)) {
      return true;
    }
  }
  return false;
}

function buildPartNodeSet(
  part: Viewport3DSurfacePart,
  nodeCount: number,
): Set<number> | null {
  if (part.node_indices?.length) {
    return new Set(
      part.node_indices.filter(
        (nodeIndex) =>
          Number.isInteger(nodeIndex) && nodeIndex >= 0 && nodeIndex < nodeCount,
      ),
    );
  }

  const start = Math.max(0, Math.floor(part.node_start ?? 0));
  const rawCount = part.node_count ?? part.nodeCount;
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  if (count <= 0 || start >= nodeCount) return null;

  const end = Math.min(nodeCount, start + count);
  const nodes = new Set<number>();
  for (let nodeIndex = start; nodeIndex < end; nodeIndex += 1) {
    nodes.add(nodeIndex);
  }
  return nodes;
}

function buildPartTopologyModel(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
  fallbackVolumeEdgeIndices: (() => Uint32Array | null) | null = null,
  supplementalSurfaceParts: readonly Viewport3DSurfacePart[] = [],
): Pick<
  Viewport3DTopologyPartRenderModel,
  | "edgeIndices"
  | "surfaceIndices"
  | "surfaceNodeSelection"
  | "volumeEdgeIndices"
> {
  const surfaceIndices = lazyValue(() =>
    buildPartSurfaceIndicesWithSupplemental(
      part,
      topology,
      supplementalSurfaceParts,
    ),
  );
  const edgeIndices = lazyValue(() =>
    buildCachedSurfaceEdgeIndices(surfaceIndices()),
  );
  const surfaceNodeSelection = lazyValue(() => {
    const indices = surfaceIndices();
    return indices ? { nodeIndices: uniqueSortedIndices(indices) } : null;
  });
  const volumeEdgeIndices = lazyValue(
    () =>
      buildPartVolumeEdgeIndices(part, topology) ??
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
    get surfaceNodeSelection() {
      return surfaceNodeSelection();
    },
    get volumeEdgeIndices() {
      return volumeEdgeIndices();
    },
  };
}

function buildPartSurfaceIndicesWithSupplemental(
  part: Viewport3DSurfacePart,
  topology: DecodedTopology,
  supplementalSurfaceParts: readonly Viewport3DSurfacePart[],
): Uint32Array | null {
  const primarySurfaceIndices = buildPartSurfaceIndices(part, topology);
  if (supplementalSurfaceParts.length === 0) return primarySurfaceIndices;

  const surfaceIndexBuffers: Uint32Array[] = [];
  if (primarySurfaceIndices?.length) {
    surfaceIndexBuffers.push(primarySurfaceIndices);
  }
  for (const supplementalPart of supplementalSurfaceParts) {
    const supplementalSurfaceIndices = buildPartSurfaceIndices(
      supplementalPart,
      topology,
    );
    if (supplementalSurfaceIndices?.length) {
      surfaceIndexBuffers.push(supplementalSurfaceIndices);
    }
  }

  return mergeSurfaceIndexBuffers(surfaceIndexBuffers, topology.nodeCount);
}

function mergeSurfaceIndexBuffers(
  buffers: readonly Uint32Array[],
  nodeCount: number,
): Uint32Array | null {
  const validBuffers = buffers.filter((buffer) => buffer.length >= 3);
  if (validBuffers.length === 0) return null;
  if (validBuffers.length === 1) return validBuffers[0] ?? null;

  const totalLength = validBuffers.reduce(
    (sum, buffer) => sum + buffer.length - (buffer.length % 3),
    0,
  );
  if (totalLength <= 0) return null;

  const merged = new Uint32Array(totalLength);
  const numericKeyBase = resolveNumericTriangleKeyBase(nodeCount);
  const seenNumeric = numericKeyBase ? new Set<number>() : null;
  const seenString = seenNumeric ? null : new Set<string>();
  let target = 0;

  for (const buffer of validBuffers) {
    for (let index = 0; index + 2 < buffer.length; index += 3) {
      const a = buffer[index] ?? 0;
      const b = buffer[index + 1] ?? 0;
      const c = buffer[index + 2] ?? 0;
      if (a >= nodeCount || b >= nodeCount || c >= nodeCount) continue;
      const key = numericKeyBase
        ? triangleNumericKey(numericKeyBase, a, b, c)
        : triangleStringKey(a, b, c);
      if (seenNumeric) {
        if (seenNumeric.has(key as number)) continue;
        seenNumeric.add(key as number);
      } else if (seenString) {
        const stringKey = key as string;
        if (seenString.has(stringKey)) continue;
        seenString.add(stringKey);
      }
      merged[target++] = a;
      merged[target++] = b;
      merged[target++] = c;
    }
  }

  return target > 0 ? merged.slice(0, target) : null;
}

function resolveNumericTriangleKeyBase(nodeCount: number): number | null {
  const keyBase = Math.max(0, Math.floor(nodeCount)) + 1;
  return keyBase ** 3 <= Number.MAX_SAFE_INTEGER ? keyBase : null;
}

function triangleNumericKey(
  keyBase: number,
  first: number,
  second: number,
  third: number,
): number {
  let a = first;
  let b = second;
  let c = third;
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  if (b > c) {
    const next = b;
    b = c;
    c = next;
  }
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  return (a * keyBase + b) * keyBase + c;
}

function triangleStringKey(first: number, second: number, third: number): string {
  let a = first;
  let b = second;
  let c = third;
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  if (b > c) {
    const next = b;
    b = c;
    c = next;
  }
  if (a > b) {
    const next = a;
    a = b;
    b = next;
  }
  return `${a}:${b}:${c}`;
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

  for (let vector = 0; vector < vectorCount; vector += 1) {
    const pointIndex = vector * stride;
    const positionOffset = pointIndex * 3;
    const valueOffset = pointIndex * fieldVector.nComp;
    const target = vector * VECTOR_SEGMENT_STRIDE;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz);
    if (length === 0) continue; // skip zero-magnitude nodes (no visible vector)
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
  }

  return segments;
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

  for (let vector = 0; vector < samples.length; vector += 1) {
    const sample = samples[vector];
    if (!sample) continue;
    const positionOffset = sample.pointIndex * 3;
    const valueOffset = sample.valuePointIndex * fieldVector.nComp;
    const target = vector * VECTOR_SEGMENT_STRIDE;
    const x = topology.positions[positionOffset] ?? 0;
    const y = topology.positions[positionOffset + 1] ?? 0;
    const z = topology.positions[positionOffset + 2] ?? 0;
    const vx = fieldVector.values[valueOffset] ?? 0;
    const vy = fieldVector.values[valueOffset + 1] ?? 0;
    const vz = fieldVector.values[valueOffset + 2] ?? 0;
    const length = Math.hypot(vx, vy, vz);
    if (length === 0) continue; // skip zero-magnitude nodes (no visible vector)
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
  }

  return segments;
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

function flattenSurfaceFaces(
  surfaceFaces: readonly (readonly number[])[],
): Uint32Array {
  const indices: number[] = [];

  for (const face of surfaceFaces) {
    if (face.length < 3) continue;
    const anchor = face[0] ?? 0;
    for (let index = 1; index + 1 < face.length; index += 1) {
      indices.push(anchor, face[index] ?? 0, face[index + 1] ?? 0);
    }
  }

  return new Uint32Array(indices);
}

function surfaceIndicesFromBoundaryFaces(
  topology: DecodedTopology,
  faceIndices: readonly number[],
): Uint32Array | null {
  if (!faceIndices.length) return null;

  const indices = new Uint32Array(faceIndices.length * 3);

  for (let index = 0; index < faceIndices.length; index += 1) {
    const faceIndex = faceIndices[index] ?? 0;
    const sourceOffset = faceIndex * 3;
    const targetOffset = index * 3;
    indices[targetOffset] = topology.boundaryFaces[sourceOffset] ?? 0;
    indices[targetOffset + 1] = topology.boundaryFaces[sourceOffset + 1] ?? 0;
    indices[targetOffset + 2] = topology.boundaryFaces[sourceOffset + 2] ?? 0;
  }

  return indices;
}

function surfaceIndicesFromBoundaryFaceRange(
  topology: DecodedTopology,
  start: number,
  count: number,
): Uint32Array | null {
  const safeStart = Math.max(0, Math.floor(start));
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount === 0) return null;

  const source = topology.boundaryFaces.slice(
    safeStart * 3,
    (safeStart + safeCount) * 3,
  );
  return source.length ? new Uint32Array(source) : null;
}

function uniqueSortedIndices(indices: Uint32Array): number[] {
  const unique = new Set<number>();
  for (let index = 0; index < indices.length; index += 1) {
    unique.add(indices[index] ?? 0);
  }
  return Array.from(unique).toSorted((left, right) => left - right);
}

function buildScopedPartFieldValueResolver(
  partSelection: Viewport3DNodeSelection,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
  fieldPointCount: number,
): Viewport3DVectorFieldValueResolver {
  const selectedNodeCount = resolveNodeSelectionCount(partSelection, topology);
  if (fieldPointCount > 0 && fieldPointCount < selectedNodeCount) {
    const stride = Math.max(1, Math.floor(selectedNodeCount / fieldPointCount));
    const sampleIndexByGlobalNode = new Map<number, number>();
    for (
      let selectedOffset = 0;
      selectedOffset < selectedNodeCount;
      selectedOffset += 1
    ) {
      if (selectedOffset % stride !== 0) continue;
      const sampleIndex = Math.floor(selectedOffset / stride);
      if (sampleIndex >= fieldPointCount) continue;
      const globalNodeIndex = resolveNodeSelectionIndex(
        partSelection,
        selectedOffset,
      );
      if (
        globalNodeIndex === null ||
        globalNodeIndex < 0 ||
        globalNodeIndex >= topology.nodeCount
      ) {
        continue;
      }
      sampleIndexByGlobalNode.set(globalNodeIndex, sampleIndex);
    }
    return (globalNodeIndex) =>
      sampleIndexByGlobalNode.get(globalNodeIndex) ?? null;
  }

  const localIndexByGlobalNode = new Map<number, number>();
  for (let localIndex = 0; localIndex < selectedNodeCount; localIndex += 1) {
    const globalNodeIndex = resolveNodeSelectionIndex(partSelection, localIndex);
    if (
      globalNodeIndex === null ||
      globalNodeIndex < 0 ||
      globalNodeIndex >= topology.nodeCount
    ) {
      continue;
    }
    localIndexByGlobalNode.set(globalNodeIndex, localIndex);
  }

  return (globalNodeIndex) => localIndexByGlobalNode.get(globalNodeIndex) ?? null;
}

function buildScopedPartFieldSampleSelection(
  partSelection: Viewport3DNodeSelection,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
  fieldPointCount: number,
): Viewport3DNodeSelection {
  const selectedNodeCount = resolveNodeSelectionCount(partSelection, topology);
  if (fieldPointCount <= 0 || fieldPointCount >= selectedNodeCount) {
    return partSelection;
  }

  const stride = Math.max(1, Math.floor(selectedNodeCount / fieldPointCount));
  const nodeIndices: number[] = [];
  for (
    let selectedOffset = 0;
    selectedOffset < selectedNodeCount;
    selectedOffset += 1
  ) {
    if (selectedOffset % stride !== 0) continue;
    const sampleIndex = Math.floor(selectedOffset / stride);
    if (sampleIndex >= fieldPointCount) continue;
    const globalNodeIndex = resolveNodeSelectionIndex(
      partSelection,
      selectedOffset,
    );
    if (
      globalNodeIndex === null ||
      globalNodeIndex < 0 ||
      globalNodeIndex >= topology.nodeCount
    ) {
      continue;
    }
    nodeIndices.push(globalNodeIndex);
  }

  return nodeIndices.length > 0 ? { nodeIndices } : { nodeCount: 0, nodeStart: 0 };
}

export function resolveNodeSelectionCount(
  selection: Viewport3DNodeSelection | null | undefined,
  topology: Pick<Viewport3DPositionSource, "nodeCount">,
): number {
  if (selection?.nodeIndices?.length) {
    return selection.nodeIndices.length;
  }
  if (selection?.node_indices?.length) {
    return selection.node_indices.length;
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
  if (selection?.nodeIndices?.length) {
    return selection.nodeIndices[offset] ?? null;
  }
  if (selection?.node_indices?.length) {
    return selection.node_indices[offset] ?? null;
  }

  return (selection?.nodeStart ?? selection?.node_start ?? 0) + offset;
}
