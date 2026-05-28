import type {
  DomainMetaResource,
  UniverseResource,
} from "@/kernel/api/apiTypes";
import type {
  DecodedFieldVector,
  DecodedTopology,
} from "@/kernel/api/codecs";

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
  nodeCount: number;
  positions: Float32Array;
}

export interface Viewport3DFieldRenderModel {
  fullVectorSegments: Float32Array | null;
  partVectorSegments: Map<string, Float32Array | null>;
  scalarColors: ScalarColorBuffer | null;
  scalarColorsByPartAndMode: Map<string, Map<string, ScalarColorBuffer | null>>;
  scalarColorsByMode: Map<string, ScalarColorBuffer | null>;
}

export interface Viewport3DFieldRenderOptions {
  fullVectorBudget?: number;
  fullVectorAnchorMode?: Viewport3DVectorAnchorMode;
  fullVectorSurfaceOffsetScale?: number;
  partFieldVectors?: ReadonlyMap<string, DecodedFieldVector>;
  partVectorAnchorModes?: ReadonlyMap<string, Viewport3DVectorAnchorMode>;
  partVectorBudgets?: ReadonlyMap<string, number>;
  partVectorScales?: ReadonlyMap<string, number>;
  partVectorScopes?: ReadonlyMap<string, "surface" | "full">;
  partVectorSurfaceOffsetScales?: ReadonlyMap<string, number>;
  scalarColorModes?: ReadonlySet<string>;
  scalarColorPalette?: string;
  scalarColorsVisible?: boolean;
  vectorColorMode?: string;
}

export type Viewport3DVectorAnchorMode = "center" | "tail";

export interface Viewport3DVectorSegmentOptions {
  anchorMode?: Viewport3DVectorAnchorMode;
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

const scalarColorCache = new WeakMap<
  DecodedFieldVector,
  Map<string, ScalarColorBuffer | null>
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

export function buildViewport3DTopologyRenderModel<
  TPart extends Viewport3DRenderablePart,
>(
  topology: DecodedTopology | null | undefined,
  magneticParts: readonly TPart[],
  airboxParts: readonly TPart[],
): Viewport3DTopologyRenderModel<TPart> | null {
  if (!topology) return null;

  const fallbackSurfaceIndices = buildCachedTopologySurfaceIndices(topology);
  const fallbackVolumeEdgeIndices = buildCachedTopologyVolumeEdgeIndices(topology);
  const airboxVolumeEdgeFallback =
    airboxParts.length > 0
      ? buildUnclaimedVolumeEdgeIndices(topology, magneticParts) ??
        fallbackVolumeEdgeIndices
      : null;

  return {
    airboxParts: airboxParts.map((part) => ({
      part,
      ...buildPartTopologyModel(part, topology, airboxVolumeEdgeFallback),
    })),
    fallbackSurfaceIndices,
    fallbackVolumeEdgeIndices,
    magneticParts: magneticParts.map((part) => ({
      part,
      ...buildPartTopologyModel(part, topology),
    })),
    nodeCount: topology.nodeCount,
    positions: buildTopologyPositions(topology),
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
  const fullFieldVector = isFullTopologyFieldVector(
    fieldVector,
    topology.nodeCount,
  )
    ? fieldVector
    : null;
  const magneticFieldNodeIndices =
    !fullFieldVector && fieldVector
      ? buildMagneticFieldNodeIndices(topology, fieldVector.pointCount)
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
                  fieldVector,
                  magneticFieldNodeIndices,
                  colorMode,
                  options.scalarColorPalette,
                ),
          ]),
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
      (partUsesMagneticOnlyField ? fieldVector : fullFieldVector);
    if (partFieldVector && partFieldVector !== fieldVector) {
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
        : partFieldVector !== fieldVector &&
            partFieldVector.pointCount < topology.nodeCount
          ? buildScopedPartFieldValueResolver(partModel.part, topology)
          : null);
    partVectorSegments.set(
      partId,
      buildCachedPartVectorSegments(
        partModel,
        topology,
        partFieldVector,
        vectorSelection,
        vectorScope,
        scale * partScale,
        partBudget,
        {
          anchorMode: options.partVectorAnchorModes?.get(partId) ?? "center",
          surfaceOffsetScale,
          surfaceTriangleIndices:
            surfaceOffsetScale > 0 ? partModel.surfaceIndices : null,
        },
        fieldValueResolver,
      ),
    );
  }

  const fullVectorBudget =
    options.fullVectorBudget ?? DEFAULT_VIEWPORT_3D_VECTOR_GLYPH_BUDGET;

  return {
    fullVectorSegments: buildCachedFullVectorSegments(
      topology,
      fullFieldVector,
      scale,
      fullVectorBudget,
      {
        anchorMode: options.fullVectorAnchorMode ?? "center",
        surfaceOffsetScale: options.fullVectorSurfaceOffsetScale ?? 0,
        surfaceTriangleIndices: topology.fallbackSurfaceIndices,
      },
    ),
    partVectorSegments,
    scalarColors,
    scalarColorsByPartAndMode,
    scalarColorsByMode,
  };
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
  const surfaceOffsetScale = vectorOptions.surfaceOffsetScale ?? 0;
  return getCachedNestedFieldValue(
    fullVectorSegmentCache,
    topology,
    fieldVector,
    `${scale}:${budget}:${anchorMode}:${surfaceOffsetScale}`,
    () =>
      buildVectorLineSegmentsFromPositions(
        topology,
        fieldVector,
        scale,
        budget,
        vectorOptions,
      ),
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
  const surfaceOffsetScale = vectorOptions.surfaceOffsetScale ?? 0;
  const fieldValueMode = fieldValueResolver ? "scoped" : "full";
  return getCachedNestedFieldValue(
    partVectorSegmentCache,
    partModel,
    fieldVector,
    `${vectorScope}:${fieldValueMode}:${scale}:${budget}:${anchorMode}:${surfaceOffsetScale}`,
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
  );
}

function getCachedValue<TKey extends object, TValue>(
  cache: WeakMap<TKey, Map<string, TValue>>,
  owner: TKey,
  key: string,
  build: () => TValue,
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
): TValue {
  let fieldCache = cache.get(owner);
  if (!fieldCache) {
    fieldCache = new WeakMap<DecodedFieldVector, Map<string, TValue>>();
    cache.set(owner, fieldCache);
  }

  return getCachedValue(fieldCache, fieldVector, key, build);
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
  const seen = new Set<string>();
  const edges: number[] = [];

  for (let tetra = 0; tetra < tetraCount; tetra += 1) {
    const source = tetra * 4;
    const a = indices[source] ?? 0;
    const b = indices[source + 1] ?? 0;
    const c = indices[source + 2] ?? 0;
    const d = indices[source + 3] ?? 0;

    appendTetraEdge(edges, seen, a, b);
    appendTetraEdge(edges, seen, a, c);
    appendTetraEdge(edges, seen, a, d);
    appendTetraEdge(edges, seen, b, c);
    appendTetraEdge(edges, seen, b, d);
    appendTetraEdge(edges, seen, c, d);
  }

  return new Uint32Array(edges);
}

function appendTetraEdge(
  edges: number[],
  seen: Set<string>,
  first: number,
  second: number,
): void {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  const key = edgeKey(a, b);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(a, b);
}

function edgeKey(first: number, second: number): string {
  return `${first}:${second}`;
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
  fallbackVolumeEdgeIndices: Uint32Array | null = null,
): Pick<
  Viewport3DTopologyPartRenderModel,
  | "edgeIndices"
  | "surfaceIndices"
  | "surfaceNodeSelection"
  | "volumeEdgeIndices"
> {
  const surfaceIndices = buildPartSurfaceIndices(part, topology);
  return {
    edgeIndices: buildCachedSurfaceEdgeIndices(surfaceIndices),
    surfaceIndices,
    surfaceNodeSelection: surfaceIndices
      ? { nodeIndices: uniqueSortedIndices(surfaceIndices) }
      : null,
    volumeEdgeIndices:
      buildPartVolumeEdgeIndices(part, topology) ?? fallbackVolumeEdgeIndices,
  };
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
  const surfaceOffsetScale = Math.max(options.surfaceOffsetScale ?? 0, 0);
  const surfaceNormals =
    surfaceOffsetScale > 0
      ? cachedAveragedSurfaceNodeNormals(
          topology,
          options.surfaceTriangleIndices,
        )
      : null;
  const surfaceOffsetDistance = effectiveScale * surfaceOffsetScale;

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
  const surfaceOffsetScale = Math.max(options.surfaceOffsetScale ?? 0, 0);
  const surfaceNormals =
    surfaceOffsetScale > 0
      ? cachedAveragedSurfaceNodeNormals(
          topology,
          options.surfaceTriangleIndices,
        )
      : null;
  const surfaceOffsetDistance = effectiveScale * surfaceOffsetScale;

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
): Viewport3DVectorFieldValueResolver {
  const selectedNodeCount = resolveNodeSelectionCount(partSelection, topology);
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
