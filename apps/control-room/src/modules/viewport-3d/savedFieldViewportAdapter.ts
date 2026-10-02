import type { DecodedTopology } from "@/kernel/api/codecs";
import type { SavedFieldGeometryResource } from "@/kernel/api/apiTypes";
import {
  savedSupportNodeIsActive,
  type DecodedSavedSupport,
} from "@/kernel/api/codecs/savedSupportCodec";
import type { SavedFieldViewportValues } from "@/kernel/resources/savedFieldViewportResources";

import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  resolveTopologyBounds,
  type Viewport3DBounds,
  type Viewport3DFieldVector,
  type Viewport3DFieldRenderModel,
  type Viewport3DTopologyRenderModel,
} from "./viewport3dRenderModel";
import type { ScalarColorBuffer } from "./viewport3dFieldMapping";
import type {
  FemManifestRenderDomain,
  Viewport3DMeshPart,
} from "./viewport3dDomainAdapter";
import { srgbToLinearChannel } from "./viewport3dColorSpace";

/**
 * Saved geometry has no per-object or Airbox ownership in v1.  The viewport
 * therefore renders one explicit whole-domain carrier and keeps the object
 * index empty instead of guessing physical ownership from the mesh.
 */
export interface SavedFieldViewportSceneModel {
  bounds: Viewport3DBounds | null;
  carrier: Viewport3DMeshPart;
  fieldModel: Viewport3DFieldRenderModel | null;
  femDomain: FemManifestRenderDomain;
  representationEvidence: "not_verified";
  topologyModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
}

function savedCarrier(
  geometry: SavedFieldGeometryResource,
  topology: DecodedTopology,
  bounds: Viewport3DBounds | null,
): Viewport3DMeshPart {
  return {
    boundary_face_count: topology.facetCount ?? topology.boundaryFaceCount,
    boundary_face_start: 0,
    bounds_max: bounds
      ? [
          bounds.center[0] + bounds.size[0] / 2,
          bounds.center[1] + bounds.size[1] / 2,
          bounds.center[2] + bounds.size[2] / 2,
        ]
      : null,
    bounds_min: bounds
      ? [
          bounds.center[0] - bounds.size[0] / 2,
          bounds.center[1] - bounds.size[1] / 2,
          bounds.center[2] - bounds.size[2] / 2,
        ]
      : null,
    element_count: topology.cellCount ?? topology.elementCount,
    element_start: 0,
    fieldCapable: true,
    geometry_id: null,
    id: `saved-domain:${geometry.geometry_manifest.object_ref}`,
    label: "Saved FEM domain",
    node_count: topology.nodeCount,
    node_start: 0,
    object_id: null,
    role: "saved-domain",
  };
}

interface SavedFieldRenderVector {
  activeNodeIndices: Uint32Array;
  activeNodeMask: Uint8Array;
  vector: Viewport3DFieldVector;
}

function savedFieldVector(
  geometry: SavedFieldGeometryResource,
  field: SavedFieldViewportValues,
  support: DecodedSavedSupport,
): SavedFieldRenderVector | null {
  const activeNodeIndices = new Uint32Array(field.nodeCount);
  const activeNodeMask = new Uint8Array(field.nodeCount);
  let activeNodeCount = 0;
  for (let node = 0; node < field.nodeCount; node += 1) {
    if (!savedSupportNodeIsActive(support, node)) continue;
    activeNodeIndices[activeNodeCount] = node;
    activeNodeMask[node] = 1;
    activeNodeCount += 1;
  }
  if (activeNodeCount === 0) return null;

  const compact = activeNodeCount !== field.nodeCount;
  const values = compact
    ? field.dtype === "f32"
      ? new Float32Array(activeNodeCount * field.componentCount)
      : new Float64Array(activeNodeCount * field.componentCount)
    : field.values;
  if (compact) {
    for (let active = 0; active < activeNodeCount; active += 1) {
      const sourceNode = activeNodeIndices[active]!;
      const sourceOffset = sourceNode * field.componentCount;
      const targetOffset = active * field.componentCount;
      for (let component = 0; component < field.componentCount; component += 1) {
        values[targetOffset + component] = field.values[sourceOffset + component]!;
      }
    }
  }

  // Preserve the producer's f32/f64 typed array and compact support view;
  // never relabel f32 as f64 or copy it solely for rendering.
  const vector: Viewport3DFieldVector = {
    dtype: field.dtype === "f32" ? "float32" : "float64",
    fieldGenerationId: field.savedScopeKey,
    grid: [activeNodeCount, 1, 1] as [number, number, number],
    indexing: compact ? "explicit_node_indices" : "full_domain",
    meshTopologyHash: field.topologyFingerprint,
    // The field's saved scope key fences transport/cache ownership.  The
    // renderer compatibility gate compares this value with the topology
    // model's mesh revision, so use the immutable geometry object reference
    // for the mesh identity and keep savedScopeKey in the scope/build fields.
    meshTopologyRevision: geometry.geometry_manifest.object_ref,
    nComp: field.componentCount,
    nodeIndices: compact ? activeNodeIndices.subarray(0, activeNodeCount) : null,
    pointCount: activeNodeCount,
    quantityId: field.quantityId,
    scopeId: field.savedScopeKey,
    scopeKind: "full",
    sourceId: field.savedScopeKey,
    sourceRevision: geometry.owner_solution_revision,
    valueCount: values.length,
    values,
  };
  return {
    activeNodeIndices: activeNodeIndices.subarray(0, activeNodeCount),
    activeNodeMask,
    vector,
  };
}

const SAVED_INACTIVE_LINEAR_CHANNEL = srgbToLinearChannel(0.5);

function neutralizeScalarColorBuffer(
  buffer: ScalarColorBuffer,
  activeNodeMask: Uint8Array,
  nodeCount: number,
): void {
  const vertexBuffer = buffer.colors.length === nodeCount * 3;
  if (!vertexBuffer) {
    for (let offset = 0; offset < buffer.colors.length; offset += 3) {
      buffer.colors[offset] = SAVED_INACTIVE_LINEAR_CHANNEL;
      buffer.colors[offset + 1] = SAVED_INACTIVE_LINEAR_CHANNEL;
      buffer.colors[offset + 2] = SAVED_INACTIVE_LINEAR_CHANNEL;
    }
    buffer.scalarValues?.fill(Number.NaN);
    buffer.vectorValues?.fill(Number.NaN);
    buffer.complexRealValues?.fill(Number.NaN);
    buffer.complexImagValues?.fill(Number.NaN);
    return;
  }
  for (let node = 0; node < nodeCount; node += 1) {
    if (activeNodeMask[node] === 1) continue;
    const colorOffset = node * 3;
    buffer.colors[colorOffset] = SAVED_INACTIVE_LINEAR_CHANNEL;
    buffer.colors[colorOffset + 1] = SAVED_INACTIVE_LINEAR_CHANNEL;
    buffer.colors[colorOffset + 2] = SAVED_INACTIVE_LINEAR_CHANNEL;
    if (buffer.scalarValues && node < buffer.scalarValues.length) {
      buffer.scalarValues[node] = Number.NaN;
    }
    if (buffer.vectorValues && colorOffset + 2 < buffer.vectorValues.length) {
      buffer.vectorValues[colorOffset] = Number.NaN;
      buffer.vectorValues[colorOffset + 1] = Number.NaN;
      buffer.vectorValues[colorOffset + 2] = Number.NaN;
    }
    if (buffer.complexRealValues && node < buffer.complexRealValues.length) {
      buffer.complexRealValues[node] = Number.NaN;
    }
    if (buffer.complexImagValues && node < buffer.complexImagValues.length) {
      buffer.complexImagValues[node] = Number.NaN;
    }
  }
}

function maskSavedFieldColors(
  fieldModel: Viewport3DFieldRenderModel,
  activeNodeMask: Uint8Array,
  nodeCount: number,
): void {
  const seen = new Set<ScalarColorBuffer>();
  const visit = (buffer: ScalarColorBuffer | null | undefined) => {
    if (!buffer || seen.has(buffer)) return;
    seen.add(buffer);
    neutralizeScalarColorBuffer(buffer, activeNodeMask, nodeCount);
  };
  visit(fieldModel.scalarColors);
  for (const buffer of fieldModel.scalarColorsByMode.values()) visit(buffer);
  for (const byMode of fieldModel.scalarColorsByPartAndMode.values()) {
    for (const buffer of byMode.values()) visit(buffer);
  }
  for (const pass of fieldModel.targetPasses.values()) {
    visit(pass.surface.scalarColors);
  }
}

export function buildSavedFieldViewportSceneModel({
  geometry,
  field,
  palette,
  support,
  topology,
  vectorColorMode,
  vectorScale,
}: {
  geometry: SavedFieldGeometryResource;
  field: SavedFieldViewportValues;
  palette: string;
  support: DecodedSavedSupport;
  topology: DecodedTopology;
  vectorColorMode: string;
  vectorScale: number;
}): SavedFieldViewportSceneModel | null {
  if (
    field.representationEvidence !== "not_verified" ||
    field.nodeCount !== topology.nodeCount ||
    support.nodeCount !== topology.nodeCount ||
    field.values.length !== field.nodeCount * field.componentCount ||
    topology.positions.length !== topology.nodeCount * 3
  ) {
    return null;
  }

  const bounds = resolveTopologyBounds(topology);
  const carrier = savedCarrier(geometry, topology, bounds);
  const topologyModel = buildViewport3DTopologyRenderModel(
    topology,
    [carrier],
    [],
    new Map(),
    {
      meshGenerationId: `saved:${geometry.geometry_manifest.object_ref}`,
      meshRevision: geometry.geometry_manifest.object_ref,
      meshTopologyHash: geometry.topology_fingerprint,
    },
  );
  if (!topologyModel) return null;

  const quantityVectorColorMode = field.componentCount >= 3
    ? vectorColorMode
    : "magnitude";
  const savedRenderVector = savedFieldVector(geometry, field, support);
  if (!savedRenderVector) return null;
  const fieldVector = savedRenderVector.vector;
  const fieldModel = buildViewport3DFieldRenderModel(
    topologyModel,
    fieldVector,
    vectorScale,
    {
      buildDomainId: field.savedScopeKey,
      buildSessionId: field.savedScopeKey,
      fieldRevision: field.savedScopeKey,
      fullScalarColorMode: "magnitude",
      fullScalarColorPalette: palette,
      fullVectorBudget: field.componentCount >= 3
        ? Math.min(2048, field.nodeCount)
        : 0,
      partScalarColorModes: new Map([[carrier.id, "magnitude"]]),
      partScalarColorPalettes: new Map([[carrier.id, palette]]),
      partVectorBudgets: new Map([
        [carrier.id, field.componentCount >= 3 ? Math.min(2048, field.nodeCount) : 0],
      ]),
      partVectorScopes: new Map([[carrier.id, "full"]]),
      scalarColorModes: new Set(["magnitude"]),
      scalarColorPalette: palette,
      scalarColorsVisible: true,
      topologyRevision: field.savedScopeKey,
      vectorColorMode: quantityVectorColorMode,
    },
  );
  if (fieldModel) {
    maskSavedFieldColors(
      fieldModel,
      savedRenderVector.activeNodeMask,
      topology.nodeCount,
    );
  }

  const femDomain: FemManifestRenderDomain = {
    airboxParts: [],
    // The carrier is present only in the topology/field render models. It is
    // deliberately absent from semantic magnetic/object ownership maps.
    fieldCapableAirboxParts: [],
    fieldCapableMagneticParts: [],
    magneticParts: [],
    magneticSurfacePartsByPartId: new Map(),
    objectPartIds: new Map(),
    partsById: new Map(),
  };
  return {
    bounds,
    carrier,
    fieldModel,
    femDomain,
    representationEvidence: "not_verified",
    topologyModel,
  };
}
