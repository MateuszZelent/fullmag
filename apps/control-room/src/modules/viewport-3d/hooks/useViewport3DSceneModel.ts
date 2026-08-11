"use client";

import type { components } from "@/kernel/api/generated/openapi-v2-types";
import { DATA_FIELDS_PATH } from "@/kernel/api/apiPaths";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
} from "react";

import type {
  FieldVectorQuery,
  FieldCatalogResource,
  FieldMetaResource,
  LiveStatusResource,
  MeshHistogramBinElementsResource,
  MeshRegionMembershipResource,
  MeshSharedDomainManifestResource,
  RegionListResource,
  ResourceRevision,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  asDecodedComplexFieldVector,
  type DecodedFieldVector,
} from "@/kernel/api/codecs";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";
import {
  isAnalysisFieldQuantityId,
  isMagneticOnlyQuantityId,
  isScalarSpatialQuantityId,
  resolveCanonicalQuantityId,
  sameQuantityId,
} from "@/kernel/api/quantityIds";
import { useCrossSectionResource } from "@/kernel/resources/crossSectionResources";
import {
  useFdmRegionMembershipBinaryResource,
  useFdmMultilayerLayerActiveMasksResource,
  useFdmMultilayerLayoutResource,
  useFdmRegionMembershipResource,
  useMeshRegionMembershipsResource,
  useModelRegionsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { deriveAuthoredFdmUniverseOutsideMagneticSupport } from "@/shared/domain/mesh/domainPresentation";
import {
  resolveFieldMetaResourceKey,
  useMeshPeriodicPairsResource,
  useFieldCatalogResource,
  useFieldMetaResource,
} from "@/kernel/resources/studyRuntimeResources";
import { useResource } from "@/kernel/resources/useResource";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useKernel } from "@/kernel/KernelContext";
import type {
  ResourceResult,
  ResourceStatus,
} from "@/kernel/resources/resourceTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  canonicalVisualizationSceneObjectId,
  visualizationTargetIdForSceneObject,
} from "@/kernel/selection/selectionTypes";
import { buildSemanticRenderTargetCatalog } from "@/kernel/selection/semanticRenderTargetCatalog";
import {
  resolveVisualizationTargetForMeshPart,
  visualizationSceneObjectIds,
} from "@/kernel/selection/visualizationTargetResolver";
import {
  activeCrossSectionFramePreview,
  crossSectionFramePreviewEquals,
  crossSectionFramePreviewToClip,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { usePlanarMonitorFramePreview } from "@/kernel/workspace/planarMonitorFramePreview";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveDefaultVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveFdmViewportVisualizationSettings,
  resolveTargetVisualization,
  surfaceColorSourceToColorMode,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type SurfaceFieldProjectionMode,
  type SurfaceColorSource,
  type VisualizationStoredTargetPatch,
  type VisualizationTargetKind,
  type VisualizationTargetRef,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { useCameraRegistryCamera } from "@/kernel/visualization/useCameraRegistry";
import {
  viewport3DFieldColorLayersEnabledFromBrowserConfig,
  viewport3DVectorLayersEnabledFromBrowserConfig,
} from "@/kernel/browserFullmagConfig";
import {
  useAnalysisFieldOverlay,
  type AnalysisFieldOverlayAppearanceState,
} from "@/kernel/visualization/AnalysisFieldOverlayController";
import { startAnalysisFieldOverlayPhaseAnimation } from "@/kernel/visualization/AnalysisFieldOverlayPhaseAnimation";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { resolveVisualizationEffectiveRenderMode } from "@/kernel/visualization/useVisualizationClientAck";
import { resolveCrossSectionQueryFromVisualizationState } from "@/shared/domain/mesh/crossSectionQuery";
import {
  FDM_DISPLAY_CELL_BUDGET,
  formatFdmDisplaySamplingSummary,
} from "@/shared/domain/mesh/fdmDisplaySampling";
import { buildPeriodicOverlayModel } from "@/shared/domain/mesh/periodicOverlayModel";

import {
  mergeViewport3DFieldScalarColors,
  resolveViewport3DChunkedFieldColorTarget,
  useViewport3DChunkedScalarColors,
} from "./useViewport3DChunkedScalarColors";
import { useViewport3DTopologyIndexBundle } from "./useViewport3DTopologyIndexBundle";
import {
  useViewport3DFieldRenderOptions,
  clampViewport3DInteractiveVectorBudget,
  limitViewport3DFieldRenderVectorBudgets,
  resolveViewport3DAirboxVectorLengthScale,
  viewport3DAirboxVectorsVisible,
} from "./useViewport3DFieldRenderOptions";
import {
  buildHysteresisReplayGlyphModel,
  resolveHysteresisReplayMeshCompatibility,
  resolveHysteresisStepViewportTarget,
  resolveViewport3DSelectionBounds,
  targetForFdmDomain,
  targetForFdmNativeLayer,
  targetForFdmUniverseOutsideSupport,
  type FdmSelectionGrid,
  type HysteresisReplayGlyphModel,
  type HysteresisReplayMeshCompatibility,
} from "../model/viewport3DTargets";
import { resolveFdmUniverseOutsideSupportOverlayFromPresentation } from "../model/fdmUniverseOverlay";
import {
  buildViewport3DTargetRenderPlan,
  buildViewport3DFieldResourceRequestId,
  DEFAULT_VIEWPORT3D_SHADER_MONO_COLOR,
  mergeViewport3DFieldVectorQueries,
  resolveViewport3DAirboxFieldVectorDemandPlan,
  resolveViewport3DPrimaryFieldDemandPlan,
  resolveViewport3DFdmNativeLayerFieldRequests,
  resolveViewport3DScalarComponentRequest,
  resolveViewport3DScopedFieldQuery,
  resolveViewport3DScopedPartVectorFieldDemandPlan,
  resolveViewport3DTargetQuantityFieldDemandPlan,
  resolveViewport3DTargetFieldQuery as resolveViewport3DTargetFieldQueryFromPlan,
  summarizeViewport3DFieldDemandDiagnostics,
  validateViewport3DFieldResourceRequestEquivalence,
  validateViewport3DFieldResourceRequestIdentities,
  type Viewport3DFieldDemandDiagnosticSummary,
  type Viewport3DFieldResourceRequest,
  type Viewport3DTargetRenderPlan,
} from "../model/viewport3DFieldDataPlan";
export {
  resolveViewport3DAirboxFieldVectorDemandPlan,
  resolveViewport3DPrimaryFieldDemandPlan,
  resolveViewport3DPrimaryFieldQuery,
  resolveViewport3DScopedPartVectorFieldDemandPlan,
  resolveViewport3DTargetQuantityFieldDemandPlan,
} from "../model/viewport3DFieldDataPlan";
import {
  buildViewport3DTargetFieldBuffer,
  resolveViewport3DTargetFieldInput,
  type Viewport3DTargetFieldBuffer,
} from "../model/viewport3DTargetFieldBuffer";
import {
  resolveTrustedViewport3DResponseDomainGenerationId,
  resolveViewport3DFieldDomainCompatibility,
  resolveViewport3DFieldVectorForDomain,
  safeViewport3DDomainGenerationId,
} from "../model/viewport3DFieldDomainCompatibility";
import {
  buildFdmVectorSegments,
  buildFdmVectorSampledCellIndices,
  useFdmCuboidBuildResult,
  useFdmCuboidBuildResults,
  type FdmCuboidAsyncBuildEntry,
  type FdmCuboidInstanceModel,
} from "../layers/FdmCuboidLayer";
import { resolveFdmAirboxPassPlan } from "../layers/fdmAirboxPassPlan";
import {
  buildViewport3DFdmTargetSurfaceCellIndices,
  buildViewport3DFdmTargetDefinitions,
  buildViewport3DFdmTargetViews,
  memoizeViewport3DFdmTargetRenderView,
  memoizeViewport3DFdmTargetSurfaceColors,
  memoizeViewport3DFdmSurfaceColors,
  type Viewport3DFdmTargetRenderView,
} from "../model/viewport3DFdmTargetViews";
import {
  buildFdmMultilayerAirboxFieldRequest,
  resolveFdmMultilayerAirboxFieldVector,
  shouldRequestFdmMultilayerAirboxField,
} from "../model/viewport3DFdmMultilayerAirbox";
import { buildViewport3DFdmCuboidJobKey } from "../build-engine/viewport3dBuildJobKeys";
import { Viewport3DScene } from "../layers/Viewport3DScene";
import { buildClipPlaneIntersectionMarkerBuffers } from "../layers/clipPlaneModel";
import {
  buildRegionOverlayModels,
  type RegionOverlayInput,
  type RegionOverlayModel,
  type RegionMeshOverlayOwnerPart,
} from "../layers/regionOverlayModel";
import {
  adaptDomainPresentation,
  adaptFdmDomainPresentation,
  adaptFdmMultilayerAirboxDomain,
  adaptFdmMultilayerNativeLayerDomains,
  adaptFemSharedDomainManifest,
  resolveFdmNativeLayerActiveMaskForRendering,
  resolveViewport3DFdmRealizedRegionIds,
  type FdmNativeLayerRenderView,
  type FdmMultilayerAirboxRenderView,
  type FemManifestRenderDomain,
  type Viewport3DMeshPart,
} from "../viewport3dDomainAdapter";
import {
  buildViewport3DDiagnostics,
  type Viewport3DResourceCounts,
} from "../viewport3dDiagnostics";
import {
  getViewport3DBuildDiagnosticsSnapshotVersion,
  getViewport3DBuildFallbackDiagnosticsSnapshot,
  getViewport3DBuildPipelineDiagnosticsSnapshot,
  subscribeViewport3DBuildDiagnostics,
} from "../build-engine/viewport3dBuildDiagnostics";
import {
  buildFdmSampledScalarColors,
  fieldTransformNeedsChunking,
  resolveScalarRange,
  type ScalarRange,
} from "../viewport3dFieldMapping";
import { buildViewport3DResourceFrameKey } from "../viewport3dInvalidation";
import type { Viewport3DResourceFrameState } from "../viewport3dInvalidation";
import {
  buildViewport3DMagnetizationTexturePreviewMap,
  buildViewport3DPrimitiveRenderModel,
  resolvePrimitiveSelectionBounds,
  type Viewport3DPrimitiveObject,
} from "../viewport3dPrimitiveModel";
import {
  buildMeshQualityVertexColors,
  topologySupportsTet4FmmqQuality,
  type MeshQualityColorMetric,
} from "../viewport3dQualityMapping";
import { buildViewport3DMeshSizeHighlightModel } from "../viewport3dMeshSizeHighlight";
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  combineViewport3DBounds,
  resolveNodeSelectionCount,
  resolveDomainBounds,
  resolveTopologyBounds,
  resolveUniverseBounds,
  resolveViewport3DMaxVectorGlyphs,
  type Viewport3DFieldRenderOptions,
  type Viewport3DRenderablePart,
  type Viewport3DTopologyRenderModel,
  type Viewport3DBounds,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "../viewport3dRenderModel";

export function resolveViewport3DAirboxVectorSampleBudget(
  requestedBudget: number,
  availableAirOnlyNodeCount: number,
): number {
  return Math.max(
    0,
    Math.min(
      Math.floor(requestedBudget),
      Math.floor(availableAirOnlyNodeCount),
    ),
  );
}
import {
  getViewport3DCacheStats as getCacheStats,
  resolveViewport3DFieldVectorResourceKey,
  resolveViewport3DFieldVectorRequestResourceKey,
  useViewport3DAirboxFieldVectors,
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DFieldVectorRequest,
  useViewport3DMeshQualityData,
  useViewport3DPartFieldVectors,
  useViewport3DQuantityFieldVectors,
  useViewport3DScene,
  useViewport3DSharedDomainManifest,
  useViewport3DUniverse,
} from "../viewport3dResources";
import { useViewport3DFieldUpdateHoldActive } from "../viewport3dFieldUpdateHold";
import type { Viewport3DFieldRefreshState } from "../viewport3dRefreshCountdown";
import {
  isViewport3DTopologyCurrent,
  isViewport3DTopologyRenderable,
  resolveViewport3DTopologyFreshnessLabel,
  resolveUnknownTopologyProvenanceRefreshKey,
  resolveViewport3DTopologyFreshness,
  type Viewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import {
  resolveHslReferenceVisible,
  resolveViewport3DCameraOrthographicScale,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3dStore,
  type Viewport3DCommandState,
  type Viewport3DCameraProjection,
  type Viewport3DCameraState,
  type useViewport3DCommandState,
} from "../viewport3dStore";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;
type JsonRecord = Record<string, unknown>;
type SceneRegionShape = components["schemas"]["SceneRegionShape"];

const EMPTY_AIRBOX_FIELD_VECTOR_PARTS: readonly { id: string }[] = [];
const EMPTY_VIEWPORT_3D_FIELD_QUANTITY_IDS: ReadonlySet<string> = new Set();
const EMPTY_FDM_MULTILAYER_AIRBOX_FIELD_REQUEST: Viewport3DFieldResourceRequest = {
  consumers: [],
  quantityId: "H_demag",
  query: { component: "full", scope_id: "airbox", scope_kind: "airbox" },
  requestId: "fdm-multilayer-airbox:idle",
};
const FDM_AIRBOX_VOXEL_TOPOGRAPHY = {
  amplitudeCells: 0,
  component: "z" as const,
  enabled: false,
};

function resolveViewport3DAvailableFieldQuantityIds(
  catalog: FieldCatalogResource | null,
): ReadonlySet<string> | null {
  if (!catalog) return null;
  return new Set(
    catalog.quantities
      .filter((quantity) => quantity.available)
      .map((quantity) => resolveCanonicalQuantityId(quantity.quantity_id)),
  );
}

function viewport3DFieldQuantityAvailable(
  quantityId: string,
  availableQuantityIds: ReadonlySet<string> | null,
): boolean {
  return (
    availableQuantityIds == null ||
    availableQuantityIds.has(resolveCanonicalQuantityId(quantityId))
  );
}

function resolveFdmNativeLayerFieldVector(
  domain: import("../viewport3dDomainAdapter").FdmNativeLayerRenderDomain,
  layoutGenerationId: string,
  fieldVector: DecodedFieldVector | null | undefined,
): DecodedFieldVector | null {
  if (!fieldVector) return null;
  if (
    fieldVector.scopeKind !== "layer" ||
    fieldVector.scopeId !== domain.layerId ||
    fieldVector.grid.some((value, axis) => value !== domain.shape[axis])
  ) {
    return null;
  }
  const compatible = resolveViewport3DFieldDomainCompatibility({
    domain: {
      discretization: "fdm",
      domainGenerationId: layoutGenerationId,
      meshTopologyHash: domain.gridFingerprint,
      meshTopologyRevision: null,
      pointCount: domain.totalCells,
    },
    field: fieldVector,
  });
  return compatible.status === "mismatch" ? null : fieldVector;
}

const EMPTY_FEM_RENDER_DOMAIN: FemManifestRenderDomain = {
  airboxParts: [],
  fieldCapableAirboxParts: [],
  fieldCapableMagneticParts: [],
  magneticParts: [],
  magneticSurfacePartsByPartId: new Map(),
  objectPartIds: new Map(),
  partsById: new Map(),
};

export interface Viewport3DDomainRenderLane {
  femDomain: FemManifestRenderDomain;
  topologyCurrent: boolean;
  topologyRenderable: boolean;
}

export function resolveViewport3DDomainRenderLane({
  fdmActive,
  femDomain,
  topologyFreshness,
}: {
  fdmActive: boolean;
  femDomain: FemManifestRenderDomain;
  topologyFreshness: Viewport3DTopologyFreshness;
}): Viewport3DDomainRenderLane {
  return {
    femDomain: fdmActive ? EMPTY_FEM_RENDER_DOMAIN : femDomain,
    topologyCurrent: !fdmActive && isViewport3DTopologyCurrent(topologyFreshness),
    topologyRenderable:
      !fdmActive && isViewport3DTopologyRenderable(topologyFreshness),
  };
}

export function resolveViewport3DFdmFieldIdentityCompatible({
  fdmFieldCompatibilityStatus,
  fdmLaneActive,
}: {
  fdmFieldCompatibilityStatus:
    | "compatible"
    | "degraded"
    | "mismatch"
    | null;
  fdmLaneActive: boolean;
}): boolean {
  return !fdmLaneActive || fdmFieldCompatibilityStatus !== "mismatch";
}

interface Viewport3DScalarRangeModeFlags {
  magnitude: boolean;
  x: boolean;
  y: boolean;
  z: boolean;
}

function resolveViewport3DScalarRangeModeFlags(
  scalarColorModes: ReadonlySet<string> | null | undefined,
  vectorColorMode: string,
): Viewport3DScalarRangeModeFlags {
  const modes = new Set(scalarColorModes ?? []);
  modes.add(vectorColorMode);
  return {
    magnitude: modes.has("magnitude"),
    x: modes.has("x"),
    y: modes.has("y"),
    z: modes.has("z"),
  };
}

function enabledScalarRangeModes(
  flags: Viewport3DScalarRangeModeFlags,
): Array<"magnitude" | "x" | "y" | "z"> {
  return (["magnitude", "x", "y", "z"] as const).filter(
    (mode) => flags[mode],
  );
}

function resolveViewport3DFieldMetaScalarRange(
  fieldMeta: FieldMetaResource | null | undefined,
): ScalarRange | null {
  const stats = fieldMeta?.stats;
  if (
    !stats ||
    !Number.isFinite(stats.min) ||
    !Number.isFinite(stats.max)
  ) {
    return null;
  }
  return {
    max: stats.max,
    min: stats.min,
  };
}

interface Viewport3DPartScalarRangeRequest {
  component: string;
  mode: string;
  partId: string;
  quantityId: string;
  scopeId: string;
  scopeKind: "object" | "part";
  snapshot_id?: string | null;
  stage_id?: string | null;
}

export function resolveViewport3DPartScalarRangeRequests({
  fieldRenderOptions,
  getPartSettings,
  magneticParts,
  selectedSnapshotQuery,
}: {
  fieldRenderOptions: Pick<
    Viewport3DFieldRenderOptions,
    "partScalarColorModes"
  >;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magneticParts: readonly { part: Viewport3DMeshPart }[];
  selectedSnapshotQuery?: FieldVectorQuery | null;
}): ReadonlyMap<string, Viewport3DPartScalarRangeRequest> {
  const requests = new Map<string, Viewport3DPartScalarRangeRequest>();
  for (const partModel of magneticParts) {
    const partId = partModel.part.id;
    const mode = fieldRenderOptions.partScalarColorModes?.get(partId);
    const component = mode ? fieldColorModeScalarComponent(mode) : null;
    if (!mode || !component) continue;
    const settings = getPartSettings(partModel.part);
    if (!settings.visible || !settings.shaderVisible) continue;
    const quantityId = resolveCanonicalQuantityId(settings.activeQuantityId);
    if (isAnalysisFieldQuantityId(quantityId)) continue;
    const objectScopeId = partModel.part.object_id ?? partModel.part.geometry_id;
    requests.set(partId, {
      component: resolveViewport3DFieldMetaScalarComponent(quantityId, component),
      mode,
      partId,
      quantityId,
      scopeId: objectScopeId ?? partId,
      scopeKind: objectScopeId ? "object" : "part",
      snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
      stage_id: selectedSnapshotQuery?.stage_id ?? null,
    });
  }
  return new Map(
    Array.from(requests).toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function mergeViewport3DPartScalarRanges({
  baseRanges,
  partFieldVectors,
  partScalarColorModes,
  partTargetFieldBuffers,
}: {
  baseRanges?: ReadonlyMap<string, ReadonlyMap<string, ScalarRange>> | null;
  partFieldVectors: ReadonlyMap<string, DecodedFieldVector>;
  partScalarColorModes?: ReadonlyMap<string, string> | null;
  partTargetFieldBuffers?: ReadonlyMap<string, Viewport3DTargetFieldBuffer> | null;
}): ReadonlyMap<string, ReadonlyMap<string, ScalarRange>> {
  const mergedRanges = new Map<string, Map<string, ScalarRange>>();
  if (baseRanges) {
    for (const [partId, rangesByMode] of baseRanges) {
      mergedRanges.set(partId, new Map(rangesByMode));
    }
  }

  const partIds = new Set([
    ...partFieldVectors.keys(),
    ...(partTargetFieldBuffers?.keys() ?? []),
  ]);
  for (const partId of partIds) {
    const scalarColorMode = partScalarColorModes?.get(partId);
    if (
      !scalarColorMode ||
      scalarColorMode === "orientation" ||
      scalarColorMode === "hsl_sphere" ||
      scalarColorMode === "monochrome"
    ) {
      continue;
    }
    const fieldVector = resolveViewport3DTargetFieldInput({
      fallbackFieldVector: null,
      legacyPartFieldVectors: partFieldVectors,
      partId,
      targetFieldBuffers: partTargetFieldBuffers ?? undefined,
    }).fieldVector;
    if (!fieldVector) continue;
    const rangesByMode = mergedRanges.get(partId) ?? new Map<string, ScalarRange>();
    if (rangesByMode.has(scalarColorMode)) {
      mergedRanges.set(partId, rangesByMode);
      continue;
    }
    rangesByMode.set(scalarColorMode, resolveScalarRange(fieldVector, scalarColorMode));
    mergedRanges.set(partId, rangesByMode);
  }

  return new Map(
    Array.from(mergedRanges, ([partId, rangesByMode]) => [
      partId,
      new Map(rangesByMode),
    ]),
  );
}

export function mergeViewport3DPrimaryTargetFieldBuffers({
  fieldRenderOptions,
  fieldRevision = null,
  fieldVector,
  getPartSettings,
  primaryFieldQuantityId,
  primaryFieldRequest,
  primaryFieldResourceKey,
  topology,
  topologyRevision = null,
}: {
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  fieldRevision?: string | null;
  fieldVector: DecodedFieldVector | null;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  primaryFieldQuantityId: string;
  primaryFieldRequest: Viewport3DFieldResourceRequest;
  primaryFieldResourceKey: string;
  topology:
    | Pick<
        Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
        | "magneticParts"
        | "meshGenerationId"
        | "meshRevision"
        | "meshTopologyHash"
        | "nodeCount"
      >
    | null;
  topologyRevision?: string | null;
}): Viewport3DFieldRenderOptions {
  if (!fieldVector || !topology) {
    return fieldRenderOptions;
  }

  let changed = false;
  const partFieldVectors = new Map(fieldRenderOptions.partFieldVectors);
  const partTargetFieldBuffers = new Map(
    fieldRenderOptions.partTargetFieldBuffers,
  );

  for (const partModel of topology.magneticParts) {
    const partId = partModel.part.id;
    if (partFieldVectors.has(partId) || partTargetFieldBuffers.has(partId)) {
      continue;
    }

    const settings = getPartSettings(partModel.part);
    const primaryFieldAppliesToPart =
      isAnalysisFieldQuantityId(primaryFieldQuantityId) ||
      sameViewport3DQuantityId(settings.activeQuantityId, primaryFieldQuantityId);
    if (
      !settings.visible ||
      (!settings.shaderVisible && !settings.vectorsVisible) ||
      !primaryFieldAppliesToPart
    ) {
      continue;
    }

    partTargetFieldBuffers.set(
      partId,
      buildViewport3DTargetFieldBuffer({
        consumers: resolveViewport3DPrimaryTargetBufferConsumers({
          partId,
          primaryFieldRequest,
          settings,
        }),
        fieldRevision,
        fieldVector,
        domain: {
          domainGenerationId: topology.meshGenerationId,
          meshTopologyHash: topology.meshTopologyHash,
          meshTopologyRevision: topology.meshRevision == null ? null : String(topology.meshRevision),
          pointCount: topology.nodeCount,
        },
        query: primaryFieldRequest.query,
        resourceKey: primaryFieldResourceKey,
        targetIds: [partId],
        topologyRevision,
      }),
    );
    changed = true;
  }

  const normalizedPartFieldVectors =
    partTargetFieldBuffers.size > 0
      ? new Map<string, DecodedFieldVector>()
      : partFieldVectors;
  const normalized = normalizedPartFieldVectors.size !== partFieldVectors.size;

  return changed || normalized
    ? {
        ...fieldRenderOptions,
        ...(normalizedPartFieldVectors.size > 0
          ? { partFieldVectors: normalizedPartFieldVectors }
          : { partFieldVectors: undefined }),
        partTargetFieldBuffers,
      }
    : fieldRenderOptions;
}

function resolveViewport3DPrimaryTargetBufferConsumers({
  partId,
  primaryFieldRequest,
  settings,
}: {
  partId: string;
  primaryFieldRequest: Viewport3DFieldResourceRequest;
  settings: VisualizationTargetSettings;
}): readonly string[] {
  const consumers = new Set(primaryFieldRequest.consumers);
  if (settings.visible && settings.shaderVisible) {
    consumers.add(`${partId}:surface`);
  }
  if (
    settings.visible &&
    settings.vectorsVisible &&
    settings.vectorBudget > 0
  ) {
    consumers.add(`${partId}:vector-glyph`);
  }
  return [...consumers].toSorted();
}

type Viewport3DResolvedFieldResourceRequest =
  Pick<Viewport3DFieldResourceRequest, "query"> & {
    consumers?: readonly string[];
    quantityId?: string;
    resourceKey?: string;
  };

export function resolveViewport3DResolvedPartFieldBuffers({
  airboxFieldRevision = null,
  airboxFieldVectorRequests,
  airboxFieldVectors,
  airboxQuantityCompatible = false,
  airboxQuantityId = "m",
  airboxSyntheticVectorsEnabled = false,
  getPartSettings,
  magneticPartFieldQueries,
  magneticPartFieldRevision = null,
  magneticPartFieldVectors,
  targetQuantityFieldRequests,
  targetQuantityFieldRevision = null,
  targetQuantityFieldVectors,
  topology,
  topologyRevision = null,
}: {
  airboxFieldRevision?: ResourceRevision | null;
  airboxFieldVectorRequests?: ReadonlyMap<
    string,
    Viewport3DResolvedFieldResourceRequest
  >;
  airboxFieldVectors?: ReadonlyMap<string, DecodedFieldVector> | null;
  airboxQuantityCompatible?: boolean;
  airboxQuantityId?: string | null;
  airboxSyntheticVectorsEnabled?: boolean;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magneticPartFieldQueries?: ReadonlyMap<
    string,
    Viewport3DResolvedFieldResourceRequest
  >;
  magneticPartFieldRevision?: ResourceRevision | null;
  magneticPartFieldVectors?: ReadonlyMap<string, DecodedFieldVector> | null;
  targetQuantityFieldRequests?: ReadonlyMap<
    string,
    Viewport3DResolvedFieldResourceRequest
  >;
  targetQuantityFieldRevision?: ResourceRevision | null;
  targetQuantityFieldVectors?: ReadonlyMap<string, DecodedFieldVector> | null;
  topology:
    | Pick<
        Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
        | "airboxParts"
        | "magneticParts"
        | "meshGenerationId"
        | "meshRevision"
        | "meshTopologyHash"
        | "nodeCount"
      >
    | null
    | undefined;
  topologyRevision?: string | null;
}): {
  partFieldVectors: Map<string, DecodedFieldVector>;
  partTargetFieldBuffers: Map<string, Viewport3DTargetFieldBuffer>;
} {
  const partFieldVectors = new Map<string, DecodedFieldVector>();
  const partTargetFieldBuffers = new Map<string, Viewport3DTargetFieldBuffer>();
  const resolvedTopologyRevision = topologyRevision ?? null;

  const setResolvedPartFieldVector = ({
    fieldRevision,
    fieldVector,
    partId,
    request,
  }: {
    fieldRevision: ResourceRevision | null;
    fieldVector: DecodedFieldVector;
    partId: string;
    request?: Viewport3DResolvedFieldResourceRequest | null;
  }): void => {
    if (!request) {
      partFieldVectors.set(partId, fieldVector);
      return;
    }
    partTargetFieldBuffers.set(
      partId,
      buildViewport3DTargetFieldBuffer({
        consumers: request.consumers ?? [],
        fieldRevision: fieldRevision == null ? null : String(fieldRevision),
        fieldVector,
        domain: topology
          ? {
              domainGenerationId: topology.meshGenerationId,
              meshTopologyHash: topology.meshTopologyHash,
              meshTopologyRevision:
                topology.meshRevision == null ? null : String(topology.meshRevision),
              pointCount: topology.nodeCount,
            }
          : undefined,
        query: request.query,
        resourceKey:
          request.resourceKey ??
          (request.quantityId
            ? resolveViewport3DFieldVectorResourceKey(
                request.quantityId,
                request.query,
              )
            : null),
        targetIds: [partId],
        topologyRevision: resolvedTopologyRevision,
      }),
    );
  };

  if (targetQuantityFieldVectors && topology) {
    for (const partModel of topology.magneticParts) {
      const partId = partModel.part.id;
      const targetQuantityId = resolveCanonicalQuantityId(
        getPartSettings(partModel.part).activeQuantityId,
      );
      const resolved = resolveViewport3DTargetQuantityFieldVectorForTarget({
        fieldVectors: targetQuantityFieldVectors,
        quantityId: targetQuantityId,
        requests: targetQuantityFieldRequests,
        targetId: partId,
      });
      if (!resolved) continue;
      setResolvedPartFieldVector({
        fieldRevision: targetQuantityFieldRevision,
        fieldVector: resolved.fieldVector,
        partId,
        request: resolved.request,
      });
    }
    if (airboxQuantityCompatible) {
      const targetQuantityId = resolveCanonicalQuantityId(airboxQuantityId ?? "m");
      for (const partModel of topology.airboxParts) {
        const partId = partModel.part.id;
        const resolved = resolveViewport3DTargetQuantityFieldVectorForTarget({
          fieldVectors: targetQuantityFieldVectors,
          quantityId: targetQuantityId,
          requests: targetQuantityFieldRequests,
          targetId: partId,
        });
        if (!resolved) continue;
        setResolvedPartFieldVector({
          fieldRevision: targetQuantityFieldRevision,
          fieldVector: resolved.fieldVector,
          partId,
          request: resolved.request,
        });
      }
    }
  }

  for (const [partId, fieldVector] of magneticPartFieldVectors ?? []) {
    setResolvedPartFieldVector({
      fieldRevision: magneticPartFieldRevision,
      fieldVector,
      partId,
      request: magneticPartFieldQueries?.get(partId),
    });
  }

  for (const [partId, fieldVector] of airboxFieldVectors ?? []) {
    const request = airboxFieldVectorRequests?.get(partId);
    if (!request) continue;
    setResolvedPartFieldVector({
      fieldRevision: airboxFieldRevision,
      fieldVector,
      partId,
      request,
    });
  }

  if (airboxSyntheticVectorsEnabled && topology) {
    const syntheticTopologyIdentity =
      resolvedTopologyRevision ??
      (topology.meshRevision == null ? null : String(topology.meshRevision)) ??
      topology.meshTopologyHash ??
      topology.meshGenerationId;
    const syntheticFieldRevision = syntheticTopologyIdentity
      ? `synthetic:airbox:+z:topology=${encodeURIComponent(syntheticTopologyIdentity)}`
      : null;
    for (const partModel of topology.airboxParts) {
      const partId = partModel.part.id;
      if (partFieldVectors.has(partId) || partTargetFieldBuffers.has(partId)) {
        continue;
      }
      const fieldVector = buildViewport3DAirboxSyntheticVectorField(
        partModel.part,
        topology.nodeCount,
      );
      if (!fieldVector) continue;
      partTargetFieldBuffers.set(
        partId,
        buildViewport3DTargetFieldBuffer({
          fieldRevision: syntheticFieldRevision,
          fieldVector,
          domain: {
            domainGenerationId: topology.meshGenerationId,
            meshTopologyHash: topology.meshTopologyHash,
            meshTopologyRevision:
              topology.meshRevision == null ? null : String(topology.meshRevision),
            pointCount: topology.nodeCount,
          },
          query: {
            component: "full",
            scope_id: partId,
            scope_kind: "airbox",
          },
          resourceKey: null,
          synthetic: true,
          targetIds: [partId],
          topologyRevision: resolvedTopologyRevision,
        }),
      );
    }
  }

  return {
    partFieldVectors:
      partTargetFieldBuffers.size > 0
        ? new Map<string, DecodedFieldVector>()
        : partFieldVectors,
    partTargetFieldBuffers,
  };
}

function resolveViewport3DTargetQuantityFieldVectorForTarget({
  fieldVectors,
  quantityId,
  requests,
  targetId,
}: {
  fieldVectors: ReadonlyMap<string, DecodedFieldVector>;
  quantityId: string;
  requests?: ReadonlyMap<string, Viewport3DResolvedFieldResourceRequest>;
  targetId: string;
}): {
  fieldVector: DecodedFieldVector;
  request: Viewport3DResolvedFieldResourceRequest | null;
  requestId: string;
} | null {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  for (const [requestId, request] of requests ?? []) {
    if (!fieldVectors.has(requestId)) continue;
    if (request.quantityId && !sameViewport3DQuantityId(
      request.quantityId,
      canonicalQuantityId,
    )) {
      continue;
    }
    const consumers = request.consumers ?? [];
    if (
      consumers.length > 0 &&
      !consumers.some((consumer) => consumer.startsWith(`${targetId}:`))
    ) {
      continue;
    }
    return {
      fieldVector: fieldVectors.get(requestId)!,
      request,
      requestId,
    };
  }

  const legacyFieldVector = fieldVectors.get(canonicalQuantityId) ?? null;
  return legacyFieldVector
    ? {
        fieldVector: legacyFieldVector,
        request: null,
        requestId: canonicalQuantityId,
      }
    : null;
}

export function resolveViewport3DFdmTargetFieldVectorForTarget({
  primaryFieldQuantityId,
  primaryFieldVector,
  quantityId,
  targetFieldRequests,
  targetFieldVectors,
  targetId,
}: {
  primaryFieldQuantityId: string;
  primaryFieldVector: DecodedFieldVector | null;
  quantityId: string;
  targetFieldRequests?: ReadonlyMap<string, Viewport3DFieldResourceRequest>;
  targetFieldVectors?: ReadonlyMap<string, DecodedFieldVector> | null;
  targetId: string;
}): {
  fieldVector: DecodedFieldVector;
  request: Viewport3DFieldResourceRequest | null;
  requestId: string;
} | null {
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  if (sameViewport3DQuantityId(primaryFieldQuantityId, canonicalQuantityId)) {
    if (
      !primaryFieldVector ||
      !sameViewport3DQuantityId(primaryFieldVector.quantityId, canonicalQuantityId)
    ) {
      return null;
    }
    return {
      fieldVector: primaryFieldVector,
      request: null,
      requestId: "primary-field-vector",
    };
  }

  if (!targetFieldVectors) return null;
  const resolved = resolveViewport3DTargetQuantityFieldVectorForTarget({
    fieldVectors: targetFieldVectors,
    quantityId: canonicalQuantityId,
    requests: targetFieldRequests,
    targetId,
  });
  if (
    !resolved ||
    !sameViewport3DQuantityId(resolved.fieldVector.quantityId, canonicalQuantityId)
  ) {
    return null;
  }
  return {
    fieldVector: resolved.fieldVector,
    request: targetFieldRequests?.get(resolved.requestId) ?? null,
    requestId: resolved.requestId,
  };
}

function resolveViewport3DPartScalarRangeResourceKey(
  requests: ReadonlyMap<string, Viewport3DPartScalarRangeRequest>,
): string {
  const suffix = Array.from(requests.values(), (request) =>
    resolveFieldMetaResourceKey(request.quantityId, {
      component: request.component,
      scope_id: request.scopeId,
      scope_kind: request.scopeKind,
      snapshot_id: request.snapshot_id,
      stage_id: request.stage_id,
    }),
  ).join("|");
  return suffix
    ? `${DATA_FIELDS_PATH}#viewport-3d:part-scalar-ranges:${suffix}`
    : `${DATA_FIELDS_PATH}#viewport-3d:part-scalar-ranges:none`;
}

function resolveViewport3DPartScalarRangesRevision(
  data: ReadonlyMap<string, ReadonlyMap<string, ScalarRange>>,
): string | null {
  return (
    Array.from(data)
      .map(([partId, ranges]) => {
        const range = ranges.values().next().value as ScalarRange | undefined;
        return range ? `${partId}:${range.min}:${range.max}` : `${partId}:none`;
      })
      .join("|") || null
  );
}

function partScalarRangeMetaUnavailable(error: unknown): boolean {
  return error instanceof ControlRoomApiError && error.status === 404;
}

function useViewport3DPartScalarRanges(
  requests: ReadonlyMap<string, Viewport3DPartScalarRangeRequest>,
  enabled: boolean,
  options: { pauseLoad?: boolean } = {},
): ResourceResult<ReadonlyMap<string, ReadonlyMap<string, ScalarRange>>> {
  const { api } = useKernel();
  const resourceKey = useMemo(
    () => resolveViewport3DPartScalarRangeResourceKey(requests),
    [requests],
  );
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries = await Promise.all(
        Array.from(requests, async ([partId, request]) => {
          const meta = await api.data.fields
            .meta(
              request.quantityId,
              {
                component: request.component,
                scope_id: request.scopeId,
                scope_kind: request.scopeKind,
                snapshot_id: request.snapshot_id,
                stage_id: request.stage_id,
              },
              { signal },
            )
            .catch((error: unknown) => {
              if (partScalarRangeMetaUnavailable(error)) return null;
              throw error;
            });
          const range = resolveViewport3DFieldMetaScalarRange(meta);
          return range
            ? [partId, new Map([[request.mode, range]])] as const
            : null;
        }),
      );
      const ranges = new Map<string, ReadonlyMap<string, ScalarRange>>();
      for (const entry of entries) {
        if (entry) {
          ranges.set(entry[0], entry[1]);
        }
      }
      return ranges;
    },
    [api, requests],
  );
  return useResource({
    abortStaleInflight: true,
    enabled: enabled && requests.size > 0,
    load,
    pauseLoad: options.pauseLoad,
    resolveRevision: resolveViewport3DPartScalarRangesRevision,
    resourceKey,
  });
}

function asJsonRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sceneRegionShape(value: unknown): SceneRegionShape | null {
  const shape = asJsonRecord(value);
  if (!shape) return null;
  const kind = asNonEmptyString(shape.kind);
  if (kind === "box") {
    return isFiniteNumberVector(shape.center, 3) && isFiniteNumberVector(shape.size, 3)
      ? { center: shape.center, kind, size: shape.size }
      : null;
  }
  if (kind === "cylinder") {
    return isFiniteNumberVector(shape.axis, 3) &&
      isFiniteNumberVector(shape.center, 3) &&
      isPositiveFiniteNumber(shape.height) &&
      isPositiveFiniteNumber(shape.radius)
      ? {
          axis: shape.axis,
          center: shape.center,
          height: shape.height,
          kind,
          radius: shape.radius,
        }
      : null;
  }
  if (kind === "sphere") {
    return isFiniteNumberVector(shape.center, 3) && isPositiveFiniteNumber(shape.radius)
      ? { center: shape.center, kind, radius: shape.radius }
      : null;
  }
  return null;
}

function isFiniteNumberVector(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function resolveViewport3DRegionOverlays({
  objectTransformsById,
  realizedRegionKeys,
  regionResource,
  scene,
}: {
  objectTransformsById: ReadonlyMap<string, unknown>;
  realizedRegionKeys?: ReadonlySet<string>;
  regionResource?: RegionListResource | null;
  scene: unknown;
}): RegionOverlayInput[] {
  const overlays: RegionOverlayInput[] = [];
  const seen = new Set<string>();

  for (const region of regionResource?.regions ?? []) {
    if (region.source !== "authored_object_region") continue;
    const regionId = asNonEmptyString(region.region_id);
    const objectId = asNonEmptyString(region.owner_object_id);
    if (!regionId || !objectId) continue;
    if (realizedRegionKeys?.has(regionOverlayKey(objectId, regionId))) continue;
    seen.add(regionOverlayKey(objectId, regionId));
    overlays.push({
      enabled: region.enabled,
      frame: region.frame,
      name: region.name,
      owner_object_id: objectId,
      owner_transform: objectTransformsById.get(objectId) ?? null,
      priority: region.priority,
      region_id: regionId,
      shape: region.shape,
    });
  }

  const sceneRecord = asJsonRecord(scene);
  if (!Array.isArray(sceneRecord?.objects)) return overlays;

  for (const objectValue of sceneRecord.objects) {
    const object = asJsonRecord(objectValue);
    const objectId = asNonEmptyString(object?.id);
    if (!objectId || !Array.isArray(object?.regions)) continue;
    for (const regionValue of object.regions) {
      const region = asJsonRecord(regionValue);
      const regionId = asNonEmptyString(region?.region_id) ?? asNonEmptyString(region?.id);
      if (!regionId || seen.has(regionOverlayKey(objectId, regionId))) continue;
      if (realizedRegionKeys?.has(regionOverlayKey(objectId, regionId))) continue;
      const shape = sceneRegionShape(region?.shape);
      if (!shape) continue;
      seen.add(regionOverlayKey(objectId, regionId));
      overlays.push({
        enabled: region?.enabled !== false && object.visible !== false,
        frame: asNonEmptyString(region?.frame),
        name: asNonEmptyString(region?.name),
        owner_object_id: objectId,
        owner_transform: objectTransformsById.get(objectId) ?? asJsonRecord(object?.transform),
        priority: typeof region?.priority === "number" ? region.priority : null,
        region_id: regionId,
        shape,
      });
    }
  }

  return overlays;
}

function regionOverlayKey(objectId: string, regionId: string): string {
  return `${objectId}\u0000${regionId}`;
}

export function resolveViewport3DMeshBackedRegionKeys(
  regions: MeshSharedDomainManifestResource["regions"] | null | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const region of regions ?? []) {
    const regionId = asNonEmptyString(region.source_region_candidate_id);
    if (!regionId || !region.mesh_part_ids || region.mesh_part_ids.length === 0) {
      continue;
    }
    for (const objectId of region.source_object_ids ?? []) {
      const owner = asNonEmptyString(objectId);
      if (owner) {
        keys.add(regionOverlayKey(canonicalVisualizationSceneObjectId(owner), regionId));
      }
    }
  }
  return keys;
}

export function filterViewport3DMeshBackedRegionOverlays(
  regions: readonly RegionOverlayInput[],
  meshBackedRegionKeys: ReadonlySet<string>,
): RegionOverlayInput[] {
  return regions.filter((region) => {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    return Boolean(
      objectId &&
        regionId &&
        meshBackedRegionKeys.has(regionOverlayKey(objectId, regionId)),
    );
  });
}

export function resolveViewport3DRegionMembershipIds({
  meshBackedRegionKeys,
  regions,
}: {
  meshBackedRegionKeys: ReadonlySet<string>;
  regions: readonly RegionOverlayInput[];
}): string[] {
  const regionIds: string[] = [];
  const seen = new Set<string>();
  for (const region of regions) {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    if (!objectId || !regionId || seen.has(regionId)) continue;
    if (meshBackedRegionKeys.has(regionOverlayKey(objectId, regionId))) continue;
    seen.add(regionId);
    regionIds.push(regionId);
  }
  return regionIds;
}

export function resolveViewport3DMeshBackedRegionOverlays({
  manifestRegions,
  regions,
}: {
  manifestRegions: MeshSharedDomainManifestResource["regions"] | null | undefined;
  regions: readonly RegionOverlayInput[];
}): RegionOverlayInput[] {
  const authoredByKey = new Map<string, RegionOverlayInput>();
  for (const region of regions) {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    if (objectId && regionId) {
      authoredByKey.set(regionOverlayKey(objectId, regionId), region);
    }
  }

  const overlays: RegionOverlayInput[] = [];
  const seen = new Set<string>();
  for (const manifestRegion of manifestRegions ?? []) {
    const regionId = asNonEmptyString(manifestRegion.source_region_candidate_id);
    const meshPartIds = (manifestRegion.mesh_part_ids ?? []).flatMap((entry) => {
      const meshPartId = asNonEmptyString(entry);
      return meshPartId ? [meshPartId] : [];
    });
    if (!regionId || meshPartIds.length === 0) continue;

    for (const sourceObjectId of manifestRegion.source_object_ids ?? []) {
      const objectId = asNonEmptyString(sourceObjectId);
      if (!objectId) continue;
      const key = regionOverlayKey(objectId, regionId);
      if (seen.has(key)) continue;
      seen.add(key);

      const authored = authoredByKey.get(key);
      overlays.push({
        enabled: authored?.enabled ?? true,
        frame: authored?.frame ?? null,
        mesh_part_ids: meshPartIds,
        name: manifestRegion.name ?? authored?.name ?? regionId,
        owner_object_id: objectId,
        owner_transform: authored?.owner_transform ?? null,
        priority: authored?.priority ?? null,
        region_id: regionId,
        shape: authored?.shape ?? null,
      });
    }
  }

  return overlays;
}

export function resolveViewport3DMembershipRegionOverlays({
  memberships,
  regions,
}: {
  memberships: readonly MeshRegionMembershipResource[];
  regions: readonly RegionOverlayInput[];
}): {
  ownerParts: RegionMeshOverlayOwnerPart[];
  regions: RegionOverlayInput[];
} {
  const authoredByKey = new Map<string, RegionOverlayInput>();
  for (const region of regions) {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    if (objectId && regionId) {
      authoredByKey.set(regionOverlayKey(objectId, regionId), region);
    }
  }

  const overlayRegions: RegionOverlayInput[] = [];
  const ownerParts: RegionMeshOverlayOwnerPart[] = [];
  const seen = new Set<string>();
  for (const membership of memberships) {
    const objectId = asNonEmptyString(membership.owner_object_id);
    const regionId = asNonEmptyString(membership.region_id);
    if ((membership.mesh_part_ids ?? []).some((partId) => asNonEmptyString(partId))) {
      continue;
    }
    if (!objectId || !regionId) continue;
    const key = regionOverlayKey(objectId, regionId);
    const authored = authoredByKey.get(key);
    if (!authored || seen.has(key)) {
      continue;
    }

    const syntheticPartId = `membership:${encodeURIComponent(objectId)}:${encodeURIComponent(regionId)}`;
    seen.add(key);
    overlayRegions.push({
      ...authored,
      mesh_part_ids: [syntheticPartId],
    });
    ownerParts.push({
      boundary_face_indices: membership.boundary_face_indices,
      element_indices: membership.element_indices,
      id: syntheticPartId,
      node_indices: membership.node_indices,
      object_id: objectId,
      region_id: regionId,
    });
  }

  return {
    ownerParts,
    regions: overlayRegions,
  };
}

export function resolveViewport3DRegionTargetByPartId(
  regions: MeshSharedDomainManifestResource["regions"] | null | undefined,
): Map<string, VisualizationTargetRef> {
  const targets = new Map<string, VisualizationTargetRef>();
  for (const region of regions ?? []) {
    const regionId = asNonEmptyString(region.source_region_candidate_id);
    if (!regionId || !region.mesh_part_ids || region.mesh_part_ids.length === 0) {
      continue;
    }
    const sourceObjectIds = (region.source_object_ids ?? [])
      .map((sourceObjectId) => asNonEmptyString(sourceObjectId))
      .filter((sourceObjectId): sourceObjectId is string => sourceObjectId !== null);
    if (sourceObjectIds.length !== 1) continue;
    const objectId = sourceObjectIds[0];
    if (!objectId) continue;
    if (
      canonicalVisualizationSceneObjectId(regionId) ===
        canonicalVisualizationSceneObjectId(objectId)
    ) {
      continue;
    }
    const target: VisualizationTargetRef = {
      id: visualizationTargetIdForSceneObject(objectId, regionId),
      kind: "region",
      label: region.name ?? regionId,
    };
    for (const partId of region.mesh_part_ids) {
      const id = asNonEmptyString(partId);
      if (id) targets.set(id, target);
    }
  }
  return targets;
}

export function resolveViewport3DRegionTargetsForMembershipOwnerParts({
  manifestRegions,
  ownerParts,
  regions,
}: {
  manifestRegions: MeshSharedDomainManifestResource["regions"] | null | undefined;
  ownerParts: readonly RegionMeshOverlayOwnerPart[];
  regions: readonly RegionOverlayInput[];
}): Map<string, VisualizationTargetRef> {
  const targets = resolveViewport3DRegionTargetByPartId(manifestRegions);
  const regionsByKey = new Map<string, RegionOverlayInput>();
  for (const region of regions) {
    const objectId = asNonEmptyString(region.owner_object_id);
    const regionId = asNonEmptyString(region.region_id);
    if (objectId && regionId) {
      regionsByKey.set(regionOverlayKey(objectId, regionId), region);
    }
  }

  for (const part of ownerParts) {
    const partId = asNonEmptyString(part.id);
    const objectId = asNonEmptyString(part.object_id);
    const regionId = asNonEmptyString(part.region_id);
    if (!partId || !objectId || !regionId) continue;
    const label = regionsByKey.get(regionOverlayKey(objectId, regionId))?.name ?? regionId;
    targets.set(partId, {
      id: visualizationTargetIdForSceneObject(objectId, regionId),
      kind: "region",
      label,
    });
  }
  return targets;
}

export function resolveViewport3DPartVisualizationSettings({
  objectVisualizationSnapshot,
  part,
  regionTarget,
  renderingState,
  sceneObjectIds,
}: {
  objectVisualizationSnapshot: ObjectVisualizationSnapshot;
  part: Viewport3DMeshPart;
  regionTarget?: VisualizationTargetRef | null;
  renderingState?: VisualizationStateResource | null;
  sceneObjectIds?: ReadonlySet<string>;
}): VisualizationTargetSettings & { target: VisualizationTargetRef } {
  const target = resolveVisualizationTargetForMeshPart({
    part,
    sceneObjectIds: sceneObjectIds ?? new Set(),
    targetRegistry: renderingState?.targets,
  });
  const objectVisualization = resolveTargetVisualization({
    snapshot: objectVisualizationSnapshot,
    target,
    visualizationState: renderingState,
  });
  if (!regionTarget) {
    return { ...objectVisualization.effectiveSettings, target };
  }
  const regionVisualization = resolveTargetVisualization({
    inheritedSettings: objectVisualization.settings,
    snapshot: objectVisualizationSnapshot,
    target: regionTarget,
    visualizationState: renderingState,
  });
  return { ...regionVisualization.effectiveSettings, target };
}

export function resolveViewport3DRegionSelectionBounds(
  selection: Selection,
  regions: readonly RegionOverlayInput[],
): Viewport3DBounds | null {
  const regionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId : null;
  if (!regionId) return null;
  const objectId =
    selection.ref?.type === "scene-object"
      ? selection.ref.objectId
      : selection.objectId;
  const models = buildRegionOverlayModels(regions, {
    selectedObjectId: objectId,
    selectedRegionId: regionId,
  });
  const region = models.find((entry) => entry.regionId === regionId);
  return region ? regionOverlayBounds(region) : null;
}

export function resolveViewport3DRegionSelectionScope(selection: Selection): {
  selectedObjectId: string | null;
  selectedRegionId: string | null;
} {
  if (selection.ref?.type === "scene-object") {
    return {
      selectedObjectId: selection.ref.objectId,
      selectedRegionId: selection.ref.regionId ?? null,
    };
  }

  if (selection.kind?.startsWith("object.")) {
    return {
      selectedObjectId: selection.objectId,
      selectedRegionId: null,
    };
  }

  return {
    selectedObjectId: null,
    selectedRegionId: null,
  };
}

function regionOverlayBounds(region: RegionOverlayModel): Viewport3DBounds {
  const center = transformedRegionCenter(region);
  const size = regionOverlaySize(region);
  return {
    center,
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}

function transformedRegionCenter(
  region: RegionOverlayModel,
): [number, number, number] {
  return [
    region.transform.position[0] + region.center[0],
    region.transform.position[1] + region.center[1],
    region.transform.position[2] + region.center[2],
  ];
}

function regionOverlaySize(region: RegionOverlayModel): [number, number, number] {
  if (region.kind === "box") {
    return [region.size[0], region.size[1], region.size[2]];
  }
  if (region.kind === "sphere") {
    const diameter = region.radius * 2;
    return [diameter, diameter, diameter];
  }
  const diameter = region.radius * 2;
  return [diameter, diameter, region.height];
}

export interface Viewport3DResourceFrameInput {
  dataAvailable: boolean;
  error?: string | null;
  id: string;
  materializationState?:
    | components["schemas"]["FieldMaterializationState"]
    | null;
  payloadRevision: ResourceRevision | null;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export interface Viewport3DFieldDataIssue {
  key: string;
  message: string;
  quantityId: string;
  resourceKey: string;
  retry: () => void;
}

export interface Viewport3DFieldDataIssueInput {
  fieldVectorEnabled: boolean;
  fieldVectorErrorMessage: string | null;
  fieldVectorRefetch: () => void;
  fieldVectorResourceKey: string;
  fieldVectorRevision: ResourceRevision | null;
  fieldVectorStatus?: ResourceStatus;
  fieldVectorDataAvailable?: boolean;
  hysteresisReplayMeshCompatibility: HysteresisReplayMeshCompatibility;
  primaryFieldQuantityId: string;
}

export function resolveViewport3DVisualizationQuantityId(
  state: VisualizationStateResource | null | undefined,
): string {
  return resolveCanonicalQuantityId(
    state?.quantity?.active_quantity_id ?? state?.active_quantity_id ?? "m",
  );
}

export function resolveViewport3DFieldDataIssue({
  fieldVectorEnabled,
  fieldVectorErrorMessage,
  fieldVectorRefetch,
  fieldVectorResourceKey,
  fieldVectorRevision,
  fieldVectorStatus = "ready",
  fieldVectorDataAvailable = true,
  hysteresisReplayMeshCompatibility,
  primaryFieldQuantityId,
}: Viewport3DFieldDataIssueInput): Viewport3DFieldDataIssue | null {
  if (hysteresisReplayMeshCompatibility.status === "mismatch") {
    const message =
      hysteresisReplayMeshCompatibility.reason ??
      "Selected hysteresis snapshot was computed on a different mesh.";
    return {
      key: `${fieldVectorResourceKey}:mesh-mismatch:${hysteresisReplayMeshCompatibility.requiredMeshIdentity ?? "unknown"}:${hysteresisReplayMeshCompatibility.actualMeshIdentity ?? "unknown"}`,
      message,
      quantityId: primaryFieldQuantityId,
      resourceKey: fieldVectorResourceKey,
      retry: fieldVectorRefetch,
    };
  }

  if (!(fieldVectorEnabled && fieldVectorErrorMessage)) {
    if (
      !fieldVectorEnabled ||
      fieldVectorStatus !== "ready" ||
      fieldVectorDataAvailable
    ) {
      return null;
    }
    return {
      key: `${fieldVectorResourceKey}:${fieldVectorRevision ?? "none"}:not-materialized`,
      message:
        "Field vector is not materialized for the selected quantity. Retry to request it again.",
      quantityId: primaryFieldQuantityId,
      resourceKey: fieldVectorResourceKey,
      retry: fieldVectorRefetch,
    };
  }
  const message =
    fieldVectorErrorMessage.trim() || "Field vector resource failed to load.";
  return {
    key: `${fieldVectorResourceKey}:${fieldVectorRevision ?? "none"}:${message}`,
    message,
    quantityId: primaryFieldQuantityId,
    resourceKey: fieldVectorResourceKey,
    retry: fieldVectorRefetch,
  };
}

export function resolveViewport3DSelectedSnapshotId(
  selection: Selection,
): string | null {
  const hysteresisTarget = resolveHysteresisStepViewportTarget(selection);
  if (hysteresisTarget) return hysteresisTarget.snapshotId;
  if (selection.ref?.type !== "analysis-chart-point") return null;
  return selection.ref.snapshotId ?? null;
}

export function resolveViewport3DSelectedSnapshotQuery(
  selection: Selection,
): FieldVectorQuery | null {
  const hysteresisTarget = resolveHysteresisStepViewportTarget(selection);
  if (!hysteresisTarget) {
    const snapshotId =
      selection.ref?.type === "analysis-chart-point"
        ? selection.ref.snapshotId ?? null
        : null;
    return snapshotId ? { snapshot_id: snapshotId } : null;
  }

  const params = resourceRefSearchParams(hysteresisTarget.resourceRef);
  return {
    snapshot_id: params?.get("snapshot_id") ?? hysteresisTarget.snapshotId,
    stage_id: params?.get("stage_id") ?? hysteresisTarget.stageId,
  };
}

function resourceRefSearchParams(resourceRef: string | null): URLSearchParams | null {
  const query = resourceRef?.split("?", 2)[1];
  return query ? new URLSearchParams(query) : null;
}

export function resolveViewport3DActiveQuantityId({
  selectedSnapshotId,
  selection,
  visualizationState,
}: {
  selectedSnapshotId: string | null;
  selection: Selection;
  visualizationState: VisualizationStateResource | null | undefined;
}): string {
  if (selectedSnapshotId) {
    const hysteresisTarget = resolveHysteresisStepViewportTarget(selection);
    if (hysteresisTarget?.quantityId) {
      return resolveCanonicalQuantityId(hysteresisTarget.quantityId);
    }
    if (selection.ref?.type === "analysis-chart-point" && selection.ref.quantity) {
      return resolveCanonicalQuantityId(selection.ref.quantity);
    }
  }
  return resolveViewport3DVisualizationQuantityId(visualizationState);
}

export function resolveViewport3DPrimaryFieldVectorEnabled({
  fdmInstanceModelNeedsFieldVector,
  fdmSurfaceColorMode,
  fdmVectorsVisible,
  fieldRenderOptions,
  selectedSnapshotId,
}: {
  fdmInstanceModelNeedsFieldVector: boolean;
  fdmSurfaceColorMode: string | null;
  fdmVectorsVisible: boolean;
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  selectedSnapshotId: string | null;
}): boolean {
  return (
    Boolean(selectedSnapshotId) ||
    viewport3DFieldRenderOptionsNeedFieldData(fieldRenderOptions) ||
    Boolean(fdmSurfaceColorMode) ||
    fdmVectorsVisible ||
    fdmInstanceModelNeedsFieldVector
  );
}

export function resolveViewport3DDisplayedLiveValue<TValue>(
  incoming: TValue,
  previousDisplayed: TValue,
  holdActive: boolean,
): TValue {
  return holdActive ? previousDisplayed : incoming;
}

export function sameViewport3DQuantityId(left: string, right: string): boolean {
  return sameQuantityId(left, right);
}

export function applyViewport3DFieldLayerDiagnosticOverrides(
  options: Viewport3DFieldRenderOptions,
  {
    fieldColorLayersEnabled,
    vectorLayersEnabled,
  }: {
    fieldColorLayersEnabled: boolean;
    vectorLayersEnabled: boolean;
  },
): Viewport3DFieldRenderOptions {
  if (fieldColorLayersEnabled && vectorLayersEnabled) return options;

  return {
    ...options,
    ...(vectorLayersEnabled
      ? {}
      : {
          fullVectorBudget: 0,
          partVectorBudgets: new Map<string, number>(),
        }),
    ...(fieldColorLayersEnabled
      ? {}
      : {
          scalarColorModes: new Set<string>(),
          scalarColorsVisible: false,
        }),
  };
}

export function resolveViewport3DResourceFrameState({
  dataAvailable,
  error,
  id,
  materializationState,
  payloadRevision,
  revision,
  status,
}: Viewport3DResourceFrameInput): Viewport3DResourceFrameState {
  const visiblePayloadAvailable = dataAvailable && !error;
  return {
    error,
    id,
    revision: visiblePayloadAvailable ? payloadRevision ?? revision : revision,
    status:
      visiblePayloadAvailable &&
      (status === "stale" ||
        materializationState === "stale_complete" ||
        materializationState === "pending")
        ? "ready"
        : status,
  };
}

export function resolveViewport3DTargetFieldQuery({
  surfaceColorMode,
  vectorsVisible,
}: {
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery | null {
  return resolveViewport3DTargetFieldQueryFromPlan({
    surfaceColorMode,
    vectorsVisible,
  });
}

export function resolveViewport3DReplayFieldQuery(
  query: FieldVectorQuery,
  snapshotQuery: FieldVectorQuery | null | undefined,
): FieldVectorQuery {
  return snapshotQuery ? { ...query, ...snapshotQuery } : query;
}

export function resolveViewport3DScopedVectorFieldQuery({
  geometryScope,
  maxSamples,
  surfaceColorMode,
  vectorsVisible,
}: {
  geometryScope: "full" | "surface";
  maxSamples: number;
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery {
  const query = resolveViewport3DScopedFieldQuery({
    maxSamples,
    surfaceColorMode,
    vectorsVisible,
  });
  return geometryScope === "surface"
    ? { ...query, geometry_scope: "surface" }
    : query;
}

export function resolveViewport3DPrimaryFieldRenderOptions({
  analysisOverlayAppearance,
  analysisOverlayActive = false,
  fieldRenderOptions,
  getPartSettings,
  magneticParts,
  quantityId,
  vectorDomain,
}: {
  analysisOverlayAppearance?: AnalysisFieldOverlayAppearanceState | null;
  analysisOverlayActive?: boolean;
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  getPartSettings: (part: Viewport3DMeshPart) => {
    activeQuantityId: string;
    geometryScope?: "surface" | "full";
    scalarColorPalette?: string;
    shaderMonoColor?: string;
    shaderVisible: boolean;
    surfaceColorSource: SurfaceColorSource;
    surfaceProjectionMode?: SurfaceFieldProjectionMode;
    vectorBudget: number;
    vectorCenteringEnabled?: boolean;
    vectorColorMode?: "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
    vectorLengthScale?: number;
    vectorSurfaceOffsetEnabled?: boolean;
    vectorSurfaceOffsetScale?: number;
    vectorsVisible: boolean;
    viewportColorbarVisible?: boolean;
    visible: boolean;
  };
  magneticParts: readonly { part: Viewport3DMeshPart }[];
  quantityId: string;
  vectorDomain: string;
}): Viewport3DFieldRenderOptions {
  if (magneticParts.length === 0) {
    return fieldRenderOptions;
  }

  const magneticVectorsAllowed = vectorDomain !== "airbox_only";
  const partVectorBudgets = new Map(fieldRenderOptions.partVectorBudgets ?? []);
  const partScalarColorModes = analysisOverlayActive
    ? new Map<string, string>()
    : new Map(fieldRenderOptions.partScalarColorModes ?? []);
  const partScalarColorPalettes = analysisOverlayActive
    ? new Map<string, string>()
    : new Map(fieldRenderOptions.partScalarColorPalettes ?? []);
  const scalarColorModes = new Set<string>();
  const targetRenderPlans = new Map<string, Viewport3DTargetRenderPlan>(
    fieldRenderOptions.targetRenderPlans ?? [],
  );

  for (const partModel of magneticParts) {
    const partId = partModel.part.id;
    const settings = getPartSettings(partModel.part);
    const effectiveSurfaceColorSource =
      analysisOverlayAppearance?.surfaceColorSource ?? settings.surfaceColorSource;
    const effectiveVectorBudget =
      analysisOverlayAppearance?.vectorBudget ?? settings.vectorBudget;
    targetRenderPlans.set(
      partId,
      buildViewport3DTargetRenderPlan({
        label: partModel.part.label ?? partId,
        quantityId: analysisOverlayActive ? quantityId : settings.activeQuantityId,
        settings: {
          geometryScope: settings.geometryScope ?? "full",
          scalarColorPalette:
            analysisOverlayAppearance?.scalarColorPalette ??
            settings.scalarColorPalette ??
            fieldRenderOptions.partScalarColorPalettes?.get(partId) ??
            fieldRenderOptions.scalarColorPalette ??
            "viridis",
          shaderMonoColor:
            settings.shaderMonoColor ?? DEFAULT_VIEWPORT3D_SHADER_MONO_COLOR,
          shaderVisible:
            analysisOverlayAppearance?.shaderVisible ?? settings.shaderVisible,
          surfaceColorSource: effectiveSurfaceColorSource,
          surfaceProjectionMode: settings.surfaceProjectionMode ?? "raw_nodal",
          vectorBudget: effectiveVectorBudget,
          vectorCenteringEnabled: settings.vectorCenteringEnabled ?? true,
          vectorColorMode: settings.vectorColorMode ?? "magnitude",
          vectorLengthScale: settings.vectorLengthScale ?? 1,
          vectorSurfaceOffsetEnabled:
            settings.vectorSurfaceOffsetEnabled ?? false,
          vectorSurfaceOffsetScale: settings.vectorSurfaceOffsetScale ?? 0,
          vectorsVisible:
            magneticVectorsAllowed &&
            (analysisOverlayAppearance?.vectorsVisible ?? settings.vectorsVisible),
          viewportColorbarVisible: settings.viewportColorbarVisible ?? false,
          visible: settings.visible,
        },
        targetId: partId,
        targetKind: "part",
      }),
    );
    if (!settings.visible) {
      partVectorBudgets.delete(partId);
      partScalarColorModes.delete(partId);
      partScalarColorPalettes.delete(partId);
      continue;
    }
    const partUsesPrimaryQuantity = sameViewport3DQuantityId(
      settings.activeQuantityId,
      quantityId,
    );
    if (analysisOverlayAppearance?.shaderVisible ?? settings.shaderVisible) {
      const scalarColorMode = surfaceColorSourceToColorMode(
        effectiveSurfaceColorSource,
      );
      if (scalarColorMode) {
        if (analysisOverlayActive || partUsesPrimaryQuantity) {
          scalarColorModes.add(scalarColorMode);
        }
        if (!analysisOverlayActive) {
          partScalarColorModes.set(partId, scalarColorMode);
          partScalarColorPalettes.set(
            partId,
            settings.scalarColorPalette ??
              fieldRenderOptions.partScalarColorPalettes?.get(partId) ??
              fieldRenderOptions.scalarColorPalette ??
              "viridis",
          );
        }
      }
    }
    if (
      magneticVectorsAllowed &&
      (analysisOverlayAppearance?.vectorsVisible ?? settings.vectorsVisible) &&
      effectiveVectorBudget > 0
    ) {
      partVectorBudgets.set(partId, effectiveVectorBudget);
    } else {
      partVectorBudgets.delete(partId);
    }
  }

  return {
    ...fieldRenderOptions,
    fullVectorBudget: 0,
    partVectorBudgets,
    partScalarColorModes:
      partScalarColorModes.size > 0 ? partScalarColorModes : undefined,
    partScalarColorPalettes:
      partScalarColorPalettes.size > 0 ? partScalarColorPalettes : undefined,
    targetRenderPlans:
      targetRenderPlans.size > 0 ? targetRenderPlans : undefined,
    scalarColorPalette:
      analysisOverlayAppearance?.scalarColorPalette ??
      fieldRenderOptions.scalarColorPalette,
    scalarColorModes,
    scalarColorsVisible:
      scalarColorModes.size > 0 || partScalarColorModes.size > 0,
  };
}

export function resolveViewport3DPrimaryFieldDataOptions(
  options: Viewport3DFieldRenderOptions,
  excludedPartIds: ReadonlySet<string>,
): Viewport3DFieldRenderOptions {
  let nextOptions = options;
  if (options.partVectorBudgets && excludedPartIds.size > 0) {
    const partVectorBudgets = new Map<string, number>();
    for (const [partId, budget] of options.partVectorBudgets) {
      if (!excludedPartIds.has(partId)) {
        partVectorBudgets.set(partId, budget);
      }
    }

    if (partVectorBudgets.size !== options.partVectorBudgets.size) {
      nextOptions = {
        ...nextOptions,
        partVectorBudgets,
      };
    }
  }
  if (options.targetRenderPlans && excludedPartIds.size > 0) {
    const targetRenderPlans = new Map<string, Viewport3DTargetRenderPlan>();
    for (const [targetId, plan] of options.targetRenderPlans) {
      if (!excludedPartIds.has(targetId)) {
        targetRenderPlans.set(targetId, plan);
      }
    }

    if (targetRenderPlans.size !== options.targetRenderPlans.size) {
      nextOptions = {
        ...nextOptions,
        targetRenderPlans:
          targetRenderPlans.size > 0 ? targetRenderPlans : undefined,
      };
    }
  }

  if (
    nextOptions.scalarColorsVisible !== false &&
    (nextOptions.scalarColorModes?.size ?? 0) === 0
  ) {
    nextOptions = {
      ...nextOptions,
      scalarColorsVisible: false,
    };
  }

  return nextOptions;
}

export function resolveViewport3DFieldRenderModelBuildOptions({
  complexFieldVector,
  fieldRenderOptions,
  fieldVector,
  topology,
}: {
  complexFieldVector: object | null | undefined;
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  fieldVector: DecodedFieldVector | null | undefined;
  topology:
    | Viewport3DTopologyRenderModel<Viewport3DRenderablePart>
    | null
    | undefined;
}): Viewport3DFieldRenderOptions {
  const scalarModes = fieldRenderOptions.scalarColorModes ?? new Set<string>();
  const fieldColorTarget = resolveViewport3DChunkedFieldColorTarget(
    topology,
    fieldVector,
  );
  const globalOffMainThreadScalarColors =
    !complexFieldVector &&
    fieldRenderOptions.scalarColorsVisible !== false &&
    scalarModes.size > 0 &&
    Boolean(fieldVector) &&
    Boolean(fieldColorTarget) &&
    Boolean(topology) &&
    fieldTransformNeedsChunking(
      Math.max(fieldVector?.pointCount ?? 0, topology?.nodeCount ?? 0),
    );
  const partOffMainThreadScalarColors =
    !complexFieldVector &&
    fieldRenderOptions.scalarColorsVisible !== false &&
    Boolean(topology) &&
    Boolean(fieldRenderOptions.partScalarColorModes) &&
    [...(topology?.magneticParts ?? []), ...(topology?.airboxParts ?? [])].some(
      (partModel) => {
        const colorMode = fieldRenderOptions.partScalarColorModes?.get(
          partModel.part.id,
        );
        if (!colorMode || colorMode === "monochrome") return false;
        const partFieldVector = resolveViewport3DTargetFieldInput({
          fallbackFieldVector: fieldVector,
          legacyPartFieldVectors: fieldRenderOptions.partFieldVectors,
          partId: partModel.part.id,
          targetFieldBuffers: fieldRenderOptions.partTargetFieldBuffers,
        }).fieldVector;
        return (
          Boolean(partFieldVector) &&
          fieldTransformNeedsChunking(
            Math.max(
              partFieldVector?.pointCount ?? 0,
              topology?.nodeCount ?? 0,
            ),
          )
        );
      },
    );
  const offMainThreadScalarColors =
    globalOffMainThreadScalarColors || partOffMainThreadScalarColors;

  if (!offMainThreadScalarColors) return fieldRenderOptions;

  return {
    ...fieldRenderOptions,
    scalarColorModes: new Set<string>(),
    scalarColorsVisible: false,
  };
}

function applyAnalysisOverlayAppearance(
  settings: VisualizationTargetSettings,
  appearance: AnalysisFieldOverlayAppearanceState | null | undefined,
): VisualizationTargetSettings {
  if (!appearance) return settings;
  const surfaceColorSource =
    appearance.surfaceColorSource ?? settings.surfaceColorSource;
  const shaderColorMode =
    surfaceColorSource === "solid"
      ? "monochrome"
      : surfaceColorSourceToColorMode(surfaceColorSource) ??
        settings.shaderColorMode;
  return {
    ...settings,
    ...(appearance.scalarColorPalette
      ? { scalarColorPalette: appearance.scalarColorPalette }
      : {}),
    ...(appearance.shaderMonoColor
      ? { shaderMonoColor: appearance.shaderMonoColor }
      : {}),
    ...(appearance.shaderVisible === undefined
      ? {}
      : { shaderVisible: appearance.shaderVisible }),
    shaderColorMode,
    surfaceColorSource,
    ...(appearance.geometryScope ? { geometryScope: appearance.geometryScope } : {}),
    ...(appearance.vectorBudget === undefined
      ? {}
      : { vectorBudget: appearance.vectorBudget }),
    ...(appearance.vectorScale === undefined && appearance.displayGain === undefined
      ? {}
      : {
          vectorLengthScale:
            (appearance.vectorScale ?? 1) * (appearance.displayGain ?? 1),
        }),
    ...(appearance.vectorsVisible === undefined
      ? {}
      : { vectorsVisible: appearance.vectorsVisible }),
  };
}

export function buildViewport3DAirboxSyntheticVectorField(
  part: Viewport3DMeshPart,
  nodeCount: number,
): DecodedFieldVector | null {
  const pointCount = resolveNodeSelectionCount(part, { nodeCount });
  if (pointCount <= 0) return null;

  const values = new Float64Array(pointCount * 3);
  for (let point = 0; point < pointCount; point += 1) {
    values[point * 3 + 2] = 1;
  }

  return {
    dtype: "float64",
    grid: [pointCount, 1, 1],
    nComp: 3,
    pointCount,
    quantityId: "debug:airbox:synthetic:+z",
    valueCount: values.length,
    values,
  };
}

export function resolveViewport3DScopedPartVectorFieldRequests({
  getPartSettings,
  maxVectorGlyphs,
  magneticParts,
  selectedSnapshotQuery,
  vectorDomain,
}: {
  getPartSettings: (part: Viewport3DMeshPart) => {
    activeQuantityId: string;
    shaderVisible: boolean;
    surfaceColorSource: SurfaceColorSource;
    surfaceProjectionMode?: SurfaceFieldProjectionMode;
    vectorBudget: number;
    vectorsVisible: boolean;
    visible: boolean;
  };
  maxVectorGlyphs: number;
  magneticParts: readonly { part: Viewport3DMeshPart }[];
  selectedSnapshotQuery?: FieldVectorQuery | null;
  vectorDomain: string;
}): Map<string, Viewport3DFieldResourceRequest> {
  return new Map(
    resolveViewport3DScopedPartVectorFieldDemandPlan({
      getPartSettings: (part) => {
        const settings = getPartSettings(part as Viewport3DMeshPart);
        return {
          ...settings,
          surfaceProjectionMode: settings.surfaceProjectionMode ?? "raw_nodal",
        };
      },
      maxVectorGlyphs,
      magneticParts,
      selectedSnapshotQuery,
      vectorDomain,
    }).requests,
  );
}

export function resolveViewport3DTargetQuantityFieldRequests({
  fdmAirboxSettings,
  fdmSettings,
  getPartSettings,
  magneticPartScopedFieldIds,
  magneticParts,
  maxVectorGlyphs,
  primaryFieldQuantityId,
  selectedSnapshotQuery,
}: {
  fdmAirboxSettings?: VisualizationTargetSettings | null;
  fdmSettings: VisualizationTargetSettings | null;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  magneticPartScopedFieldIds: ReadonlySet<string>;
  magneticParts: readonly { part: Viewport3DMeshPart }[];
  maxVectorGlyphs: number;
  primaryFieldQuantityId: string;
  selectedSnapshotQuery?: FieldVectorQuery | null;
}): Map<string, Viewport3DFieldResourceRequest> {
  return new Map(
    resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmAirboxSettings,
      fdmSettings,
      getPartSettings: (part) => getPartSettings(part as Viewport3DMeshPart),
      magneticPartScopedFieldIds,
      magneticParts,
      maxVectorGlyphs,
      primaryFieldQuantityId,
      selectedSnapshotQuery,
    }).requests,
  );
}

export function resolveViewport3DFieldMetaScalarComponent(
  quantityId: string,
  component: string,
): string {
  return isScalarSpatialQuantityId(quantityId) ? "full" : component;
}

function fieldColorModeScalarComponent(mode: string | null | undefined): string | null {
  return resolveViewport3DScalarComponentRequest(null, mode).component;
}

export function mergeViewport3DFieldQuery(
  current: FieldVectorQuery | undefined,
  next: FieldVectorQuery,
): FieldVectorQuery {
  return mergeViewport3DFieldVectorQueries(current, next);
}

export function resolveViewport3DAnalysisComplexFieldQuery(
  query: FieldVectorQuery,
): FieldVectorQuery {
  const next = { ...query };
  delete next.phase_rad;
  return {
    ...next,
    component: "full",
    view: "complex",
  };
}

export function resolveViewport3DAnalysisComplexProjectionEnabled(
  query: FieldVectorQuery | null | undefined,
): boolean {
  return query?.view === "phase_rotated_real";
}

function selectViewport3DComputeRunning(
  status: ResourceResult<LiveStatusResource>,
): boolean {
  return status.data?.solver.state === "running";
}

function resolveSelectionMeshQualityMetric(
  selection: Selection,
): MeshQualityColorMetric {
  const ref = selection.ref;
  const metric =
    ref?.type === "mesh-quality-element" || ref?.type === "mesh-quality-metric"
      ? ref.metric
      : null;
  if (metric === "gamma" || metric === "sicn" || metric === "volume") {
    return metric;
  }
  return "gamma";
}

const VIEWPORT_3D_VISUALIZATION_TARGET_KINDS: readonly VisualizationTargetKind[] = [
  "airbox",
  "fdm-domain",
  "object",
  "part",
  "region",
];

function selectViewport3DObjectVisualizationSnapshot(
  snapshot: ObjectVisualizationSnapshot,
  targets: readonly VisualizationTargetRef[],
): ObjectVisualizationSnapshot {
  const defaults: ObjectVisualizationSnapshot["defaults"] = {};
  const viewportPreferenceDefaults: NonNullable<
    ObjectVisualizationSnapshot["viewportPreferenceDefaults"]
  > = {};
  const viewportPreferences: NonNullable<
    ObjectVisualizationSnapshot["viewportPreferences"]
  > = {};
  const overrides: ObjectVisualizationSnapshot["overrides"] = {};
  const pendingOverrides: NonNullable<
    ObjectVisualizationSnapshot["pendingOverrides"]
  > = {};

  for (const kind of VIEWPORT_3D_VISUALIZATION_TARGET_KINDS) {
    const defaultPatch = snapshot.defaults[kind];
    if (defaultPatch) {
      defaults[kind] = defaultPatch;
    }
    const viewportPreferenceDefault =
      snapshot.viewportPreferenceDefaults?.[kind];
    if (viewportPreferenceDefault) {
      viewportPreferenceDefaults[kind] = viewportPreferenceDefault;
    }
  }

  for (const target of targets) {
    const key = visualizationTargetKey(target);
    const override = snapshot.overrides[key];
    if (override) {
      overrides[key] = override;
    }
    const viewportPreference = snapshot.viewportPreferences?.[key];
    if (viewportPreference) {
      viewportPreferences[key] = viewportPreference;
    }
    const pendingOverride = snapshot.pendingOverrides?.[key];
    if (pendingOverride) {
      pendingOverrides[key] = pendingOverride;
    }
  }

  return {
    defaults,
    viewportPreferenceDefaults,
    viewportPreferences,
    overrides,
    pendingOverrides,
    version: snapshot.version,
  };
}

/**
 * FDM scene targets are client-side structured-grid views. The FEM
 * visualization registry can still be present in the session resource, but
 * it must not replace the local FDM target state used by the grid renderer.
 */
export function resolveViewport3DFdmTargetVisualization({
  inheritedSettings,
  snapshot,
  target,
}: {
  inheritedSettings?: VisualizationTargetSettings;
  snapshot: ObjectVisualizationSnapshot;
  target: VisualizationTargetRef;
}) {
  return resolveTargetVisualization({
    inheritedSettings,
    snapshot,
    target,
    visualizationState: null,
  });
}

function viewport3DObjectVisualizationSnapshotEquals(
  previous: ObjectVisualizationSnapshot,
  next: ObjectVisualizationSnapshot,
): boolean {
  for (const kind of VIEWPORT_3D_VISUALIZATION_TARGET_KINDS) {
    if (!visualizationTargetPatchEquals(previous.defaults[kind], next.defaults[kind])) {
      return false;
    }
    if (
      !visualizationTargetPatchEquals(
        previous.viewportPreferenceDefaults?.[kind],
        next.viewportPreferenceDefaults?.[kind],
      )
    ) {
      return false;
    }
  }

  const overrideKeys = new Set([
    ...Object.keys(previous.overrides),
    ...Object.keys(next.overrides),
  ]);
  for (const key of overrideKeys) {
    if (!visualizationTargetPatchEquals(previous.overrides[key], next.overrides[key])) {
      return false;
    }
  }

  const viewportPreferenceKeys = new Set([
    ...Object.keys(previous.viewportPreferences ?? {}),
    ...Object.keys(next.viewportPreferences ?? {}),
  ]);
  for (const key of viewportPreferenceKeys) {
    if (
      !visualizationTargetPatchEquals(
        previous.viewportPreferences?.[key],
        next.viewportPreferences?.[key],
      )
    ) {
      return false;
    }
  }

  const pendingOverrideKeys = new Set([
    ...Object.keys(previous.pendingOverrides ?? {}),
    ...Object.keys(next.pendingOverrides ?? {}),
  ]);
  for (const key of pendingOverrideKeys) {
    const previousPending = previous.pendingOverrides?.[key];
    const nextPending = next.pendingOverrides?.[key];
    if (
      previousPending?.baseRevision !== nextPending?.baseRevision ||
      !visualizationTargetPatchEquals(previousPending?.patch, nextPending?.patch)
    ) {
      return false;
    }
  }

  return true;
}

function visualizationTargetPatchEquals(
  previous: VisualizationStoredTargetPatch | undefined,
  next: VisualizationStoredTargetPatch | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof VisualizationStoredTargetPatch>);
  for (const key of keys) {
    if (!Object.is(previous[key], next[key])) {
      return false;
    }
  }

  return true;
}

function pushViewportVisualizationTarget(
  targets: VisualizationTargetRef[],
  seen: Set<string>,
  target: VisualizationTargetRef,
): void {
  const key = visualizationTargetKey(target);
  if (seen.has(key)) return;
  seen.add(key);
  targets.push(target);
}

export function resolveViewport3DSceneCameraView({
  cameraRegistryCamera,
  commandState: _commandState,
}: {
  cameraRegistryCamera: VisualizationStateResource["camera"];
  commandState: Pick<Viewport3DCommandState, "camera" | "widgets">;
}): {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraResource: VisualizationStateResource["camera"];
  cameraState: Viewport3DCameraState;
} {
  return {
    cameraOrthographicScale: resolveViewport3DCameraOrthographicScale({
      camera: cameraRegistryCamera,
    }),
    cameraProjection: resolveViewport3DCameraProjection({
      camera: cameraRegistryCamera,
    }),
    cameraResource: cameraRegistryCamera,
    cameraState: resolveViewport3DCameraState({ camera: cameraRegistryCamera }),
  };
}

export function useViewport3DSceneModel({
  commandState,
  colors,
  meshSizeHighlight,
  meshSizeHighlightSelection,
  resourceCounts,
  selection,
}: {
  commandState: ReturnType<typeof useViewport3DCommandState>;
  colors: Viewport3DSceneProps["colors"] | null;
  meshSizeHighlight: MeshSizeHistogramHighlight | null;
  meshSizeHighlightSelection: MeshHistogramBinElementsResource | null;
  resourceCounts: Viewport3DResourceCounts;
  selection: Selection;
}) {
  const { analysisFieldOverlay } = useKernel();
  const analysisOverlay = useAnalysisFieldOverlay(analysisFieldOverlay);
  useEffect(() => {
    const handle = startAnalysisFieldOverlayPhaseAnimation(analysisFieldOverlay);
    return () => {
      handle.stop();
    };
  }, [analysisFieldOverlay]);
  const visualizationState = useVisualizationStateResource();
  const crossSectionFramePreview = useCrossSectionWorkspaceSelector(
    activeCrossSectionFramePreview,
    { isEqual: crossSectionFramePreviewEquals },
  );
  const crossSectionFrameClip = useMemo(
    () => crossSectionFramePreviewToClip(crossSectionFramePreview),
    [crossSectionFramePreview],
  );
  const planarMonitorFramePreview = usePlanarMonitorFramePreview();
  const cameraRegistryCamera = useCameraRegistryCamera();
  const visualProfile = getViewport3DVisualProfile(commandState.visualProfileId);
  const computeRunning = useSessionStatusSelector(selectViewport3DComputeRunning);
  const renderingState = visualizationState.data;
  const maxInteractiveVectorGlyphs = useMemo(
    () => resolveViewport3DMaxVectorGlyphs(renderingState),
    [renderingState],
  );
  const regionSelectionScope = useMemo(
    () => resolveViewport3DRegionSelectionScope(selection),
    [selection],
  );
  const { selectedObjectId, selectedRegionId } = regionSelectionScope;
  const cameraView = resolveViewport3DSceneCameraView({
    cameraRegistryCamera,
    commandState,
  });
  const cameraResource = cameraView.cameraResource;
  const visualizationRevision = renderingState?.revision ?? null;
  const visualizationError = visualizationState.error?.message ?? null;
  const visualizationEffectiveRenderMode = resolveVisualizationEffectiveRenderMode({
    layers: renderingState?.layers,
  });
  const selectedSnapshotId = useMemo(
    () => resolveViewport3DSelectedSnapshotId(selection),
    [selection],
  );
  const selectedSnapshotQuery = useMemo(
    () => resolveViewport3DSelectedSnapshotQuery(selection),
    [selection],
  );
  const hysteresisReplayTarget = useMemo(
    () => resolveHysteresisStepViewportTarget(selection),
    [selection],
  );
  const hysteresisReplayGlyphModel = useMemo<HysteresisReplayGlyphModel | null>(
    () => buildHysteresisReplayGlyphModel(hysteresisReplayTarget),
    [hysteresisReplayTarget],
  );
  const quantityId = resolveViewport3DActiveQuantityId({
    selectedSnapshotId,
    selection,
    visualizationState: renderingState,
  });
  const primaryFieldQuantityId = analysisOverlay?.fieldId ?? quantityId;
  const scalarColorPalette =
    renderingState?.quantity?.colormap ?? renderingState?.colormap ?? "viridis";
  const vectorStyleState = renderingState?.vector_style;
  const vectorColorMode =
    vectorStyleState?.color_mode ?? "orientation";
  const vectorLengthScale = vectorStyleState?.length_scale ?? 1;
  const vectorDomain = renderingState?.layers?.vectors?.domain ?? "auto";
  const vectorStyle = useMemo(
    () => ({
      alpha: vectorStyleState?.alpha ?? 1,
      monoColor:
        vectorStyleState?.mono_color ??
        String(colors?.field ?? "white"),
      thickness: vectorStyleState?.thickness ?? 1,
    }),
    [
      colors?.field,
      vectorStyleState?.alpha,
      vectorStyleState?.mono_color,
      vectorStyleState?.thickness,
    ],
  );
  const domainMeta = useViewport3DDomainMeta();
  const scene = useViewport3DScene();
  const sceneObjectIds = useMemo(
    () => visualizationSceneObjectIds(scene.data),
    [scene.data],
  );
  const modelRegions = useModelRegionsResource({
    enabled: Boolean(scene.data),
  });
  const universe = useViewport3DUniverse();
  const sharedDomainManifest = useViewport3DSharedDomainManifest();
  const sharedDomainTopologyFingerprint =
    sharedDomainManifest.data?.topology_fingerprint ?? null;
  const unknownTopologyProvenanceRefreshRef = useRef<string | null>(null);
  const topology = useViewport3DDomainTopology();
  const fdmLaneActive = domainMeta.data?.discretization === "fdm";
  const fdmMultilayerLayout = useFdmMultilayerLayoutResource({
    enabled: Boolean(fdmLaneActive),
  });
  const fdmMultilayerLayerActiveMasks =
    useFdmMultilayerLayerActiveMasksResource(fdmMultilayerLayout.data, {
      enabled: Boolean(fdmLaneActive && fdmMultilayerLayout.data?.available),
    });
  const fdmNativeLayerDomains = useMemo(
    () =>
      adaptFdmMultilayerNativeLayerDomains(
        fdmMultilayerLayout.data,
        FDM_DISPLAY_CELL_BUDGET,
      ),
    [fdmMultilayerLayout.data],
  );
  const fdmMultilayerAirboxDomain = useMemo(
    () =>
      adaptFdmMultilayerAirboxDomain(
        fdmMultilayerLayout.data,
        FDM_DISPLAY_CELL_BUDGET,
      ),
    [fdmMultilayerLayout.data],
  );
  const fieldCatalog = useFieldCatalogResource({ enabled: Boolean(fdmLaneActive) });
  const availableFieldQuantityIds = useMemo(
    () => resolveViewport3DAvailableFieldQuantityIds(fieldCatalog.data),
    [fieldCatalog.data],
  );
  const availableQuantityIdsForPlanning = fdmLaneActive
    ? availableFieldQuantityIds ?? EMPTY_VIEWPORT_3D_FIELD_QUANTITY_IDS
    : availableFieldQuantityIds;
  const fdmRegionMembership = useFdmRegionMembershipResource({
    enabled: fdmLaneActive,
  });
  const fdmRegionMembershipBinary = useFdmRegionMembershipBinaryResource(null, {
    enabled: Boolean(fdmLaneActive && fdmRegionMembership.data),
    revision: fdmRegionMembership.revision,
  });
  const fdmDomainPresentation = useMemo(
    () =>
      domainMeta.data?.discretization === "fdm"
        ? adaptDomainPresentation({
            domainMeta: domainMeta.data,
            expectedFdmGridFingerprint:
              fdmRegionMembershipBinary.data?.gridFingerprint ?? null,
            fdmMembership: fdmRegionMembership.data,
            fdmMembershipStatus: fdmRegionMembership.error
              ? "error"
              : fdmRegionMembership.status,
            universeOutsideMagneticSupport:
              deriveAuthoredFdmUniverseOutsideMagneticSupport({
                domainBounds: domainMeta.data.bounds,
                objects: scene.data?.objects,
              }),
          })
        : null,
    [
      domainMeta.data,
      fdmRegionMembership.data,
      fdmRegionMembership.error,
      fdmRegionMembership.status,
      fdmRegionMembershipBinary.data?.gridFingerprint,
      scene.data,
    ],
  );
  const fdmDomain = useMemo(
    () => adaptFdmDomainPresentation(fdmDomainPresentation, FDM_DISPLAY_CELL_BUDGET),
    [fdmDomainPresentation],
  );
  const fdmSelectionGrid = useMemo<FdmSelectionGrid | null>(() => {
    if (!fdmDomain) return null;
    return {
      ...fdmDomain,
      // A cell can be focused only while the current membership resource
      // proves the same grid identity. Grid-level nodes remain focusable from
      // the descriptor even when membership is loading or stale.
      gridFingerprint:
        fdmDomainPresentation?.resourceStatus === "realized"
          ? fdmDomainPresentation.fingerprint
          : null,
    };
  }, [fdmDomain, fdmDomainPresentation]);
  const fdmRealizedRegionIds = useMemo<Uint32Array | null>(() => {
    if (fdmRegionMembership.error || fdmRegionMembershipBinary.error) {
      return null;
    }
    return (
      resolveViewport3DFdmRealizedRegionIds(
        fdmDomainPresentation,
        fdmRegionMembershipBinary.data,
      ) ?? null
    );
  }, [
    fdmDomainPresentation,
    fdmRegionMembership.error,
    fdmRegionMembershipBinary.data,
    fdmRegionMembershipBinary.error,
  ]);
  const fdmMembershipCurrent = Boolean(
    fdmDomain &&
      fdmRealizedRegionIds instanceof Uint32Array &&
      fdmRealizedRegionIds.length === fdmDomain.totalCells,
  );
  const fdmTargetDefinitionsResult = useMemo(
    () =>
      buildViewport3DFdmTargetDefinitions(
        fdmRegionMembership.data,
        sceneObjectIds,
      ),
    [fdmRegionMembership.data, sceneObjectIds],
  );
  const femDomain = useMemo(
    () =>
      fdmLaneActive
        ? EMPTY_FEM_RENDER_DOMAIN
        : adaptFemSharedDomainManifest(sharedDomainManifest.data),
    [fdmLaneActive, sharedDomainManifest.data],
  );
  const semanticTargetCatalog = useMemo(
    () =>
      buildSemanticRenderTargetCatalog({
        parts: [...femDomain.partsById.values()],
        sceneObjectIds,
      }),
    [femDomain.partsById, sceneObjectIds],
  );
  const topologyIndexBundle = useViewport3DTopologyIndexBundle({
    airboxParts: femDomain.airboxParts,
    enabled: Boolean(topology.data && !fdmLaneActive),
    magneticParts: femDomain.magneticParts,
    magneticSurfacePartsByPartId: femDomain.magneticSurfacePartsByPartId,
    topology: topology.data,
    topologyRevision: topology.revision == null ? null : String(topology.revision),
  });
  const topologyIndexState =
    topologyIndexBundle.status === "building"
      ? "pending"
      : topologyIndexBundle.status === "ready"
        ? "ready"
        : "unavailable";
  const topologyRenderModel = useMemo(
    () =>
      measureViewport3DModelBuild(
        "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
        () =>
          buildViewport3DTopologyRenderModel(
            topology.data,
            femDomain.magneticParts,
            femDomain.airboxParts,
            femDomain.magneticSurfacePartsByPartId,
            {
              meshGenerationId: sharedDomainManifest.data?.generation_id ?? null,
              meshRevision: sharedDomainManifest.data?.revision ?? null,
              meshTopologyHash: sharedDomainTopologyFingerprint,
            },
            {
              topologyIndexBundle: topologyIndexBundle.bundle,
              topologyIndexState,
            },
          ),
      ),
    [
      femDomain.airboxParts,
      femDomain.magneticParts,
      femDomain.magneticSurfacePartsByPartId,
      sharedDomainManifest.data?.generation_id,
      sharedDomainManifest.data?.revision,
      sharedDomainTopologyFingerprint,
      topology.data,
      topologyIndexBundle.bundle,
      topologyIndexState,
    ],
  );
  const fieldTopologyRenderModel = useMemo(
    () =>
      measureViewport3DModelBuild(
        "fullmag.viewport3d.buildViewport3DFieldTopologyRenderModel",
        () =>
          buildViewport3DTopologyRenderModel(
            topology.data,
            femDomain.fieldCapableMagneticParts ?? femDomain.magneticParts,
            femDomain.fieldCapableAirboxParts ?? femDomain.airboxParts,
            femDomain.magneticSurfacePartsByPartId,
            {
              meshGenerationId: sharedDomainManifest.data?.generation_id ?? null,
              meshRevision: sharedDomainManifest.data?.revision ?? null,
              meshTopologyHash: sharedDomainTopologyFingerprint,
            },
            {
              topologyIndexBundle: topologyIndexBundle.bundle,
              topologyIndexState,
            },
          ),
      ),
    [
      femDomain.fieldCapableAirboxParts,
      femDomain.fieldCapableMagneticParts,
      femDomain.airboxParts,
      femDomain.magneticParts,
      femDomain.magneticSurfacePartsByPartId,
      sharedDomainManifest.data?.generation_id,
      sharedDomainManifest.data?.revision,
      sharedDomainTopologyFingerprint,
      topology.data,
      topologyIndexBundle.bundle,
      topologyIndexState,
    ],
  );
  const primitiveModel = useMemo(
    () =>
      buildViewport3DPrimitiveRenderModel(
        scene.data,
        sharedDomainManifest.data,
      ),
    [scene.data, sharedDomainManifest.data],
  );
  const objectTransformsById = useMemo(() => {
    const sceneRecord = asJsonRecord(scene.data);
    const transforms = new Map<string, unknown>();
    if (!sceneRecord || !Array.isArray(sceneRecord.objects)) {
      return transforms;
    }

    for (const value of sceneRecord.objects) {
      const object = asJsonRecord(value);
      const objectId = asNonEmptyString(object?.id);
      const transform = asJsonRecord(object?.transform);
      if (objectId && transform) {
        transforms.set(objectId, transform);
      }
    }

    return transforms;
  }, [scene.data]);
  const meshBackedRegionKeys = useMemo(
    () =>
      fdmLaneActive
        ? new Set<string>()
        : resolveViewport3DMeshBackedRegionKeys(
            sharedDomainManifest.data?.regions,
          ),
    [fdmLaneActive, sharedDomainManifest.data?.regions],
  );
  const allRegionOverlays = useMemo<RegionOverlayInput[]>(
    () =>
      resolveViewport3DRegionOverlays({
        objectTransformsById,
        regionResource: modelRegions.data,
        scene: scene.data,
      }),
    [modelRegions.data, objectTransformsById, scene.data],
  );
  const regionOverlays = useMemo<RegionOverlayInput[]>(
    () =>
      resolveViewport3DRegionOverlays({
        objectTransformsById,
        realizedRegionKeys: meshBackedRegionKeys,
        regionResource: modelRegions.data,
        scene: scene.data,
      }),
    [meshBackedRegionKeys, modelRegions.data, objectTransformsById, scene.data],
  );
  const topologyFreshness = useMemo(
    () =>
      resolveViewport3DTopologyFreshness(
        scene.data,
        sharedDomainManifest.data,
        {
          domainMeta: domainMeta.data,
          topology: topology.data,
        },
      ),
    [domainMeta.data, scene.data, sharedDomainManifest.data, topology.data],
  );
  useEffect(() => {
    if (fdmLaneActive) return;
    const refreshKey = resolveUnknownTopologyProvenanceRefreshKey(
      scene.data,
      sharedDomainManifest.data,
    );
    if (
      !refreshKey ||
      unknownTopologyProvenanceRefreshRef.current === refreshKey
    ) {
      return;
    }

    unknownTopologyProvenanceRefreshRef.current = refreshKey;
    sharedDomainManifest.refetch();
  }, [fdmLaneActive, scene.data, sharedDomainManifest]);
  const domainRenderLane = resolveViewport3DDomainRenderLane({
    fdmActive: fdmLaneActive,
    femDomain,
    topologyFreshness,
  });
  const topologyCurrent = domainRenderLane.topologyCurrent;
  const topologyRenderable = domainRenderLane.topologyRenderable;
  const periodicPairs = useMeshPeriodicPairsResource({
    enabled: topologyCurrent,
  });
  const periodicOverlayModel = useMemo(
    () =>
      !fdmLaneActive
        ? buildPeriodicOverlayModel({
            currentMeshRevision: sharedDomainManifest.data?.revision ?? null,
            currentTopologyFingerprint: sharedDomainTopologyFingerprint,
            resource: periodicPairs.data,
            topology: topology.data,
          })
        : null,
    [
      periodicPairs.data,
      sharedDomainManifest.data?.revision,
      sharedDomainTopologyFingerprint,
      topology.data,
      fdmLaneActive,
    ],
  );
  const regionMembershipIds = useMemo(
    () =>
      topologyCurrent
        ? resolveViewport3DRegionMembershipIds({
            meshBackedRegionKeys,
            regions: allRegionOverlays,
          })
        : [],
    [allRegionOverlays, meshBackedRegionKeys, topologyCurrent],
  );
  const regionMemberships = useMeshRegionMembershipsResource(regionMembershipIds, {
    enabled: Boolean(topologyCurrent && regionMembershipIds.length > 0),
  });
  const membershipRegionOverlays = useMemo(
    () =>
      topologyCurrent && regionMemberships.data
        ? resolveViewport3DMembershipRegionOverlays({
            memberships: regionMemberships.data,
            regions: allRegionOverlays,
          })
        : { ownerParts: [], regions: [] },
    [allRegionOverlays, regionMemberships.data, topologyCurrent],
  );
  const regionTargetByPartId = useMemo(
    () =>
      resolveViewport3DRegionTargetsForMembershipOwnerParts({
        manifestRegions: sharedDomainManifest.data?.regions,
        ownerParts: membershipRegionOverlays.ownerParts,
        regions: allRegionOverlays,
      }),
    [sharedDomainManifest.data?.regions, membershipRegionOverlays.ownerParts, allRegionOverlays],
  );
  const meshRegionOverlays = useMemo(
    () => {
      if (!topologyCurrent) return [];
      return [
        ...resolveViewport3DMeshBackedRegionOverlays({
          manifestRegions: sharedDomainManifest.data?.regions,
          regions: allRegionOverlays,
        }),
        ...membershipRegionOverlays.regions,
      ];
    },
    [
      allRegionOverlays,
      membershipRegionOverlays.regions,
      sharedDomainManifest.data?.regions,
      topologyCurrent,
    ],
  );
  const meshRegionOverlayParts = useMemo(
    () => [...femDomain.magneticParts, ...membershipRegionOverlays.ownerParts],
    [femDomain.magneticParts, membershipRegionOverlays.ownerParts],
  );
  const topologyRenderModelForGeometry = topologyRenderable ? topologyRenderModel : null;
  const fieldCompatibleTopologyRenderModel = topologyCurrent
    ? fieldTopologyRenderModel
    : null;
  const clipCrossSectionQuery = useMemo(() => {
    const query = resolveCrossSectionQueryFromVisualizationState(renderingState);
    return {
      ...query,
      includePolygons: true,
      includeWireframe: false,
    };
  }, [renderingState]);
  const clipCrossSection = useCrossSectionResource(clipCrossSectionQuery, {
    enabled: Boolean(renderingState?.clip?.enabled && topologyCurrent),
  });
  const clipIntersectionMarkers = useMemo(
    () => buildClipPlaneIntersectionMarkerBuffers(clipCrossSection.data),
    [clipCrossSection.data],
  );
  const meshQualityOverlayVisible =
    selection.kind === "mesh.quality" ||
    selection.ref?.type === "mesh-quality-element";
  const meshQualityMetric = resolveSelectionMeshQualityMetric(selection);
  const tet4FmmqQualitySupported = topologySupportsTet4FmmqQuality(topology.data);
  const meshQualityData = useViewport3DMeshQualityData(
    Boolean(
      fieldCompatibleTopologyRenderModel &&
        meshQualityOverlayVisible &&
        tet4FmmqQualitySupported,
    ),
  );
  const meshQualityColors = useMemo(
    () =>
      meshQualityOverlayVisible && topologyCurrent
        ? measureViewport3DModelBuild(
            "fullmag.viewport3d.buildMeshQualityVertexColors",
            () =>
              buildMeshQualityVertexColors(
                topology.data,
                meshQualityData.data,
                meshQualityMetric,
                scalarColorPalette,
              ),
          )
        : null,
    [
      meshQualityData.data,
      meshQualityMetric,
      meshQualityOverlayVisible,
      scalarColorPalette,
      topology.data,
      topologyCurrent,
    ],
  );
  const meshSizeHighlightModel = useMemo(
    () =>
      topologyCurrent
        ? measureViewport3DModelBuild(
            "fullmag.viewport3d.buildMeshSizeHistogramHighlight",
            () =>
              buildViewport3DMeshSizeHighlightModel(
                topology.data,
                topologyRenderModelForGeometry,
                femDomain,
                meshSizeHighlight,
                meshSizeHighlightSelection
                  ? { elementIndices: meshSizeHighlightSelection.element_indices }
                  : null,
              ),
          )
        : null,
    [
      topologyRenderModelForGeometry,
      femDomain,
      meshSizeHighlight,
      meshSizeHighlightSelection,
      topology.data,
      topologyCurrent,
    ],
  );
  const magnetizationTexturePreviews = useMemo(
    () => buildViewport3DMagnetizationTexturePreviewMap(scene.data),
    [scene.data],
  );
  const primitiveBounds = useMemo(
    () =>
      combineViewport3DBounds(
        primitiveModel.objects.map((object) => object.bounds),
      ),
    [primitiveModel],
  );
  const universeBounds = useMemo(
    () => resolveUniverseBounds(universe.data),
    [universe.data],
  );
  const fdmUniverseOutsideSupport = useMemo(
    () =>
      resolveFdmUniverseOutsideSupportOverlayFromPresentation(
        fdmDomainPresentation,
      ),
    [fdmDomainPresentation],
  );
  const topologyBounds = useMemo(
    () => (topologyCurrent ? resolveTopologyBounds(topology.data) : null),
    [topology.data, topologyCurrent],
  );
  const primaryResourceBounds =
    topologyBounds ??
    (fdmUniverseOutsideSupport?.universeBounds ??
      resolveDomainBounds(domainMeta.data) ??
      universeBounds);
  const resourceBounds =
    combineViewport3DBounds(
      [primaryResourceBounds, fdmMultilayerAirboxDomain?.bounds].filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ),
    ) ?? primaryResourceBounds;
  const bounds =
    combineViewport3DBounds(
      [resourceBounds, primitiveBounds].filter(
        (entry): entry is NonNullable<typeof entry> => Boolean(entry),
      ),
    ) ??
    resourceBounds ??
    primitiveBounds;
  const vectorScale = Math.max(
    Math.max(...(bounds?.size ?? [1e-6, 1e-6, 1e-6])) *
      0.0105 *
      vectorLengthScale,
    1e-12,
  );
  const selectionBounds = useMemo(
    () =>
      resolveViewport3DRegionSelectionBounds(selection, allRegionOverlays) ??
      resolvePrimitiveSelectionBounds(selection, primitiveModel) ??
      resolveViewport3DSelectionBounds(
        selection,
        femDomain,
        bounds,
        fdmSelectionGrid,
        fdmUniverseOutsideSupport,
      ),
    [
      selection,
      allRegionOverlays,
      primitiveModel,
      femDomain,
      bounds,
      fdmSelectionGrid,
      fdmUniverseOutsideSupport,
    ],
  );
  const globalLayers = renderingState?.layers;
  const globalObjectBaseSettings = useMemo(
    () => resolveGlobalObjectVisualizationSettings(renderingState),
    // Explicit deps on global layer fields only; airbox sub-fields excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      globalLayers?.surface?.visible,
      globalLayers?.surface?.opacity,
      globalLayers?.wireframe?.visible,
      globalLayers?.points?.visible,
      globalLayers?.vectors?.visible,
      vectorStyleState?.alpha,
      vectorStyleState?.color_mode,
      vectorStyleState?.mono_color,
      vectorStyleState?.thickness,
      renderingState?.vector_glyphs,
      renderingState?.quantity?.active_quantity_id,
      renderingState?.active_quantity_id,
    ],
  );
  const viewportVisualizationTargets = useMemo(() => {
    const targets: VisualizationTargetRef[] = [];
    const seen = new Set<string>();
    pushViewportVisualizationTarget(
      targets,
      seen,
      AIRBOX_VISUALIZATION_TARGET,
    );

    const fdmDomainId = domainMeta.data?.domain_id ?? null;
    const fdmTarget = fdmDomain ? targetForFdmDomain(fdmDomainId) : null;
    if (fdmTarget) {
      pushViewportVisualizationTarget(targets, seen, fdmTarget);
    }
    for (const domain of fdmNativeLayerDomains) {
      pushViewportVisualizationTarget(
        targets,
        seen,
        targetForFdmNativeLayer(domain.layerId, domain.magnetName),
      );
    }
    if (fdmMembershipCurrent && fdmTargetDefinitionsResult.status === "ready") {
      for (const definition of fdmTargetDefinitionsResult.definitions) {
        pushViewportVisualizationTarget(targets, seen, definition.ownerTarget);
        pushViewportVisualizationTarget(targets, seen, definition.target);
      }
    }
    if (fdmUniverseOutsideSupport) {
      pushViewportVisualizationTarget(
        targets,
        seen,
        targetForFdmUniverseOutsideSupport(),
      );
    }

    for (const object of primitiveModel.objects) {
      pushViewportVisualizationTarget(targets, seen, {
        id: visualizationTargetIdForSceneObject(object.objectId),
        kind: "object",
        label: object.label,
      });
    }

    for (const part of femDomain.magneticParts) {
      pushViewportVisualizationTarget(
        targets,
        seen,
        resolveVisualizationTargetForMeshPart({
          part,
          sceneObjectIds,
          targetRegistry: renderingState?.targets,
        }),
      );
    }
    for (const part of femDomain.airboxParts) {
      pushViewportVisualizationTarget(
        targets,
        seen,
        resolveVisualizationTargetForMeshPart({
          part,
          sceneObjectIds,
          targetRegistry: renderingState?.targets,
        }),
      );
    }
    for (const region of allRegionOverlays) {
      const objectId = asNonEmptyString(region.owner_object_id);
      const regionId = asNonEmptyString(region.region_id);
      if (!objectId || !regionId) continue;
      pushViewportVisualizationTarget(targets, seen, {
        id: visualizationTargetIdForSceneObject(objectId, regionId),
        kind: "region",
        label: region.name ?? regionId,
      });
    }
    for (const target of regionTargetByPartId.values()) {
      pushViewportVisualizationTarget(targets, seen, target);
    }

    return targets;
  }, [
    domainMeta.data?.domain_id,
    fdmDomain,
    fdmNativeLayerDomains,
    fdmMembershipCurrent,
    fdmTargetDefinitionsResult,
    fdmUniverseOutsideSupport,
    femDomain.airboxParts,
    femDomain.magneticParts,
    primitiveModel.objects,
    regionTargetByPartId,
    allRegionOverlays,
    renderingState?.targets,
    sceneObjectIds,
  ]);
  const selectObjectVisualizationSnapshot = useCallback(
    (snapshot: ObjectVisualizationSnapshot) =>
      selectViewport3DObjectVisualizationSnapshot(
        snapshot,
        viewportVisualizationTargets,
      ),
    [viewportVisualizationTargets],
  );
  const objectVisualizationSnapshot = useObjectVisualizationSelector(
    selectObjectVisualizationSnapshot,
    { isEqual: viewport3DObjectVisualizationSnapshotEquals },
  );
  const fallbackSettings = useMemo(
    () =>
      resolveDefaultVisualizationSettings(
        objectVisualizationSnapshot,
        "object",
        globalObjectBaseSettings,
      ),
    [globalObjectBaseSettings, objectVisualizationSnapshot],
  );
  const fdmSettings = useMemo(() => {
    const fdmDomainId = domainMeta.data?.domain_id ?? null;
    const fdmTarget = fdmDomain ? targetForFdmDomain(fdmDomainId) : null;
    if (!fdmTarget) return fallbackSettings;
    const resolved = resolveTargetVisualization({
      snapshot: objectVisualizationSnapshot,
      target: fdmTarget,
      visualizationState: renderingState,
    }).effectiveSettings;
    return resolveFdmViewportVisualizationSettings(
      resolved,
      fdmMembershipCurrent,
    );
  }, [
    domainMeta.data?.domain_id,
    fallbackSettings,
    fdmMembershipCurrent,
    fdmDomain,
    objectVisualizationSnapshot,
    renderingState,
  ]);
  const fdmNativeLayerSettingsById = useMemo(() => {
    const settingsById = new Map<string, VisualizationTargetSettings>();
    for (const domain of fdmNativeLayerDomains) {
      const target = targetForFdmNativeLayer(domain.layerId, domain.magnetName);
      const resolved = resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target,
        visualizationState: renderingState,
      }).effectiveSettings;
      settingsById.set(
        domain.layerId,
        resolveFdmViewportVisualizationSettings(
          resolved,
          !domain.activeMaskPresent ||
            domain.activeCellCount === domain.totalCells ||
            Boolean(
              fdmMultilayerLayerActiveMasks.data?.masks.get(domain.layerId),
            ),
        ),
      );
    }
    return settingsById;
  }, [
    fdmNativeLayerDomains,
    fdmMultilayerLayerActiveMasks.data,
    objectVisualizationSnapshot,
    renderingState,
  ]);
  const nativeLayerFieldRequests = useMemo<
    ReadonlyMap<string, Viewport3DFieldResourceRequest>
  >(() => resolveViewport3DFdmNativeLayerFieldRequests({
    available: Boolean(fdmLaneActive && fdmMultilayerLayout.data?.available),
    layers: fdmNativeLayerDomains.map((domain) => ({
      layerId: domain.layerId,
      settings: fdmNativeLayerSettingsById.get(domain.layerId) ?? null,
    })),
    maxSamples: FDM_DISPLAY_CELL_BUDGET,
  }), [
    fdmLaneActive,
    fdmMultilayerLayout.data,
    fdmNativeLayerDomains,
    fdmNativeLayerSettingsById,
  ]);
  const nativeLayerFieldVectors = useViewport3DQuantityFieldVectors(
    nativeLayerFieldRequests,
    Boolean(fdmLaneActive && nativeLayerFieldRequests.size > 0),
  );
  const fdmTargetSettingsById = useMemo(() => {
    const settingsById = new Map<string, VisualizationTargetSettings>();
    if (!fdmMembershipCurrent || fdmTargetDefinitionsResult.status !== "ready") {
      return settingsById;
    }
    for (const definition of fdmTargetDefinitionsResult.definitions) {
      if (definition.target.kind !== "object") continue;
      const resolved = resolveViewport3DFdmTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: definition.target,
      }).effectiveSettings;
      settingsById.set(
        definition.target.id,
        resolveFdmViewportVisualizationSettings(resolved, true),
      );
    }
    for (const definition of fdmTargetDefinitionsResult.definitions) {
      if (definition.target.kind !== "region") continue;
      const inheritedSettings = settingsById.get(definition.ownerTarget.id);
      if (!inheritedSettings) continue;
      const resolved = resolveViewport3DFdmTargetVisualization({
        inheritedSettings,
        snapshot: objectVisualizationSnapshot,
        target: definition.target,
      }).effectiveSettings;
      settingsById.set(
        definition.target.id,
        resolveFdmViewportVisualizationSettings(resolved, true),
      );
    }
    return settingsById;
  }, [
    fdmMembershipCurrent,
    fdmTargetDefinitionsResult,
    objectVisualizationSnapshot,
  ]);
  const fdmTargetSettings = useMemo(
    () => [...fdmTargetSettingsById.values()],
    [fdmTargetSettingsById],
  );
  const fdmTargetSettingsForPlanning = useMemo(
    () =>
      fdmTargetDefinitionsResult.status === "ready"
        ? fdmTargetDefinitionsResult.definitions.flatMap((definition) => {
            const settings = fdmTargetSettingsById.get(definition.target.id);
            return settings
              ? [{
                  label: definition.target.label ?? definition.target.id,
                  settings,
                  targetId: definition.target.id,
                }]
              : [];
          })
        : [],
    [fdmTargetDefinitionsResult, fdmTargetSettingsById],
  );
  const fdmUniverseOutsideSupportSettings = useMemo(() => {
    if (!fdmUniverseOutsideSupport) return null;
    return resolveTargetVisualization({
      snapshot: objectVisualizationSnapshot,
      target: targetForFdmUniverseOutsideSupport(),
      visualizationState: renderingState,
    }).effectiveSettings;
  }, [
    fdmUniverseOutsideSupport,
    objectVisualizationSnapshot,
    renderingState,
  ]);
  // A published multilayer Airbox is a separate target-only carrier.  Do not
  // issue the legacy single-grid inactive-cell demand alongside it.
  const fdmSingleGridAirboxSettings = fdmMultilayerAirboxDomain
    ? null
    : fdmUniverseOutsideSupportSettings;
  const fdmVectorScale = vectorScale * fdmSettings.vectorLengthScale;
  const airboxSettings = useMemo(
    () =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: AIRBOX_VISUALIZATION_TARGET,
        visualizationState: renderingState,
      }).effectiveSettings,
    [objectVisualizationSnapshot, renderingState],
  );
  const airboxQuantityCompatible =
    !isMagneticOnlyQuantityId(airboxSettings.activeQuantityId) &&
    viewport3DFieldQuantityAvailable(
      airboxSettings.activeQuantityId,
      availableQuantityIdsForPlanning,
    );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      applyAnalysisOverlayAppearance(
        resolveViewport3DPartVisualizationSettings({
          objectVisualizationSnapshot,
          part,
          regionTarget: regionTargetByPartId.get(part.id),
          renderingState,
          sceneObjectIds,
        }),
        analysisOverlay?.appearance,
      ),
    [
      analysisOverlay?.appearance,
      objectVisualizationSnapshot,
      regionTargetByPartId,
      renderingState,
      sceneObjectIds,
    ],
  );
  const getObjectSettings = useCallback(
    (object: Viewport3DPrimitiveObject) =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: {
          id: visualizationTargetIdForSceneObject(object.objectId),
          kind: "object",
          label: object.label,
        },
        visualizationState: fdmLaneActive ? null : renderingState,
      }).effectiveSettings,
    [fdmLaneActive, objectVisualizationSnapshot, renderingState],
  );
  const getRegionSettings = useCallback(
    (region: RegionOverlayInput) => {
      const objectId = asNonEmptyString(region.owner_object_id);
      const regionId = asNonEmptyString(region.region_id);
      if (!objectId || !regionId) return fallbackSettings;
      const objectSettings = resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: {
          id: visualizationTargetIdForSceneObject(objectId),
          kind: "object",
          label: objectId,
        },
        visualizationState: fdmLaneActive ? null : renderingState,
      }).settings;
      return resolveTargetVisualization({
        inheritedSettings: objectSettings,
        snapshot: objectVisualizationSnapshot,
        target: {
          id: visualizationTargetIdForSceneObject(objectId, regionId),
          kind: "region",
          label: region.name ?? regionId,
        },
        visualizationState: fdmLaneActive ? null : renderingState,
      }).effectiveSettings;
    },
    [
      fallbackSettings,
      fdmLaneActive,
      objectVisualizationSnapshot,
      renderingState,
    ],
  );
  const airboxVectorsVisible = viewport3DAirboxVectorsVisible(
    airboxSettings.visible,
    airboxSettings.vectorsVisible,
    airboxQuantityCompatible,
    vectorDomain,
  );
  const airboxFieldVectorEnabled =
    airboxVectorsVisible && !airboxSettings.airboxSyntheticVectorsEnabled;
  const airboxFieldVectorParts = useMemo(
    () =>
      fieldCompatibleTopologyRenderModel?.airboxParts.map((partModel) => partModel.part) ??
      EMPTY_AIRBOX_FIELD_VECTOR_PARTS,
    [fieldCompatibleTopologyRenderModel],
  );
  const airboxAvailableNodeCount = useMemo(() => {
    if (!fieldCompatibleTopologyRenderModel) return 0;
    return fieldCompatibleTopologyRenderModel.airboxParts.reduce(
      (total, partModel) =>
        total +
        resolveNodeSelectionCount(
          airboxSettings.geometryScope === "surface"
            ? partModel.surfaceNodeSelection ?? { nodeIndices: [] }
            : partModel.fullNodeSelection,
          fieldCompatibleTopologyRenderModel,
        ),
      0,
    );
  }, [airboxSettings.geometryScope, fieldCompatibleTopologyRenderModel]);
  const airboxFieldQuery = useMemo(
    () =>
      resolveViewport3DScopedVectorFieldQuery({
        geometryScope: airboxSettings.geometryScope,
        maxSamples: resolveViewport3DAirboxVectorSampleBudget(
          airboxSettings.vectorBudget,
          airboxAvailableNodeCount,
        ),
        surfaceColorMode: null,
        vectorsVisible: airboxVectorsVisible,
      }),
    [
      airboxSettings.geometryScope,
      airboxSettings.vectorBudget,
      airboxAvailableNodeCount,
      airboxVectorsVisible,
    ],
  );
  const airboxFieldDemandPlan = useMemo(
    () =>
      resolveViewport3DAirboxFieldVectorDemandPlan({
        airboxParts: airboxFieldVectorParts,
        availableQuantityIds: availableQuantityIdsForPlanning,
        fieldQuery: airboxFieldQuery,
        quantityId: airboxSettings.activeQuantityId,
        replayQuery: selectedSnapshotQuery,
        vectorBudget: resolveViewport3DAirboxVectorSampleBudget(
          airboxSettings.vectorBudget,
          airboxAvailableNodeCount,
        ),
        vectorsVisible: airboxVectorsVisible,
      }),
    [
      airboxFieldQuery,
      airboxFieldVectorParts,
      airboxSettings.activeQuantityId,
      airboxAvailableNodeCount,
      airboxSettings.vectorBudget,
      airboxVectorsVisible,
      availableQuantityIdsForPlanning,
      selectedSnapshotQuery,
    ],
  );
  const airboxFieldVectorRequests = airboxFieldDemandPlan.requests;
  const fdmSurfaceColorMode = useMemo(() => {
    if (!fdmDomain) return null;
    const settings = fdmTargetSettings.find(
      (targetSettings) => targetSettings.visible && targetSettings.shaderVisible,
    );
    return settings
      ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
      : null;
  }, [fdmDomain, fdmTargetSettings]);
  const magneticPartFieldDemandPlan = useMemo(
    () =>
      resolveViewport3DScopedPartVectorFieldDemandPlan({
        getPartSettings: (part) => getPartSettings(part as Viewport3DMeshPart),
        maxVectorGlyphs: maxInteractiveVectorGlyphs,
        magneticParts: fieldCompatibleTopologyRenderModel?.magneticParts ?? [],
        selectedSnapshotQuery,
        vectorDomain,
      }),
    [
      fieldCompatibleTopologyRenderModel?.magneticParts,
      getPartSettings,
      maxInteractiveVectorGlyphs,
      selectedSnapshotQuery,
      vectorDomain,
    ],
  );
  const magneticPartFieldQueries = magneticPartFieldDemandPlan.requests;
  const magneticPartScopedFieldIds = useMemo(
    () => new Set(magneticPartFieldQueries.keys()),
    [magneticPartFieldQueries],
  );
  const targetQuantityFieldDemandPlan = useMemo(() => {
    return resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmAirboxSettings: fdmSingleGridAirboxSettings,
      fdmSettings: fdmDomain ? fdmSettings : null,
      fdmTargetSettings: fdmTargetSettingsForPlanning,
      getPartSettings: (part) => getPartSettings(part as Viewport3DMeshPart),
      magneticPartScopedFieldIds,
      magneticParts: fieldCompatibleTopologyRenderModel?.magneticParts ?? [],
      maxVectorGlyphs: maxInteractiveVectorGlyphs,
      primaryFieldQuantityId,
      selectedSnapshotQuery,
      availableQuantityIds: availableQuantityIdsForPlanning,
    });
  }, [
    fdmDomain,
    fdmSettings,
    fdmTargetSettingsForPlanning,
    fdmSingleGridAirboxSettings,
    fieldCompatibleTopologyRenderModel?.magneticParts,
    getPartSettings,
    magneticPartScopedFieldIds,
    maxInteractiveVectorGlyphs,
    primaryFieldQuantityId,
    selectedSnapshotQuery,
    availableQuantityIdsForPlanning,
  ]);
  const targetQuantityFieldRequests = targetQuantityFieldDemandPlan.requests;
  const fieldUpdateHoldActive = useViewport3DFieldUpdateHoldActive();
  const fdmMultilayerAirboxFieldRequest = useMemo(
    () =>
      fdmMultilayerAirboxDomain
        ? buildFdmMultilayerAirboxFieldRequest(fdmMultilayerAirboxDomain)
        : EMPTY_FDM_MULTILAYER_AIRBOX_FIELD_REQUEST,
    [fdmMultilayerAirboxDomain],
  );
  const fdmMultilayerAirboxField = useViewport3DFieldVectorRequest(
    fdmMultilayerAirboxFieldRequest,
    Boolean(
        fdmLaneActive &&
        fdmMultilayerAirboxDomain &&
        shouldRequestFdmMultilayerAirboxField(airboxSettings),
    ),
    { pauseLoad: fieldUpdateHoldActive },
  );
  const magneticPartFieldVectors = useViewport3DPartFieldVectors(
    magneticPartFieldQueries,
    magneticPartFieldQueries.size > 0,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const targetQuantityFieldVectors = useViewport3DQuantityFieldVectors(
    targetQuantityFieldRequests,
    targetQuantityFieldRequests.size > 0,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const airboxFieldVectors = useViewport3DAirboxFieldVectors(
    airboxSettings.activeQuantityId,
    airboxFieldVectorParts,
    airboxFieldVectorEnabled && airboxFieldVectorParts.length > 0,
    airboxFieldVectorRequests,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const rawFieldRenderOptions = useViewport3DFieldRenderOptions({
    airboxSettings,
    airboxQuantityCompatible,
    fallbackSettings,
    getPartSettings,
    maxVectorGlyphs: maxInteractiveVectorGlyphs,
    scalarColorPalette,
    topologyRenderModel: fieldCompatibleTopologyRenderModel,
    vectorColorMode,
    vectorDomain,
  });
  const fieldColorLayersEnabled =
    viewport3DFieldColorLayersEnabledFromBrowserConfig();
  const vectorLayersEnabled = viewport3DVectorLayersEnabledFromBrowserConfig();
  const fieldRenderOptions = useMemo(
    () =>
      applyViewport3DFieldLayerDiagnosticOverrides(rawFieldRenderOptions, {
        fieldColorLayersEnabled,
        vectorLayersEnabled,
      }),
    [fieldColorLayersEnabled, rawFieldRenderOptions, vectorLayersEnabled],
  );
  const primaryFieldRenderOptions = useMemo(
    () =>
      fieldCompatibleTopologyRenderModel
        ? limitViewport3DFieldRenderVectorBudgets(
            {
              ...resolveViewport3DPrimaryFieldRenderOptions({
                analysisOverlayAppearance: analysisOverlay?.appearance,
                analysisOverlayActive: Boolean(analysisOverlay),
                fieldRenderOptions,
                getPartSettings,
                magneticParts: fieldCompatibleTopologyRenderModel.magneticParts,
                quantityId: primaryFieldQuantityId,
                vectorDomain,
              }),
              visualizationPhaseRad:
                analysisOverlay?.visualizationPhaseRad ??
                analysisOverlay?.query.phase_rad ??
                null,
            },
            fieldCompatibleTopologyRenderModel,
            maxInteractiveVectorGlyphs,
          )
        : {
            ...fieldRenderOptions,
            visualizationPhaseRad:
              analysisOverlay?.visualizationPhaseRad ??
              analysisOverlay?.query.phase_rad ??
              null,
          },
    [
      analysisOverlay,
      fieldCompatibleTopologyRenderModel,
      fieldRenderOptions,
      getPartSettings,
      maxInteractiveVectorGlyphs,
      primaryFieldQuantityId,
      vectorDomain,
    ],
  );
  const primaryFieldVectorBudgetExclusions = useMemo(() => {
    const excludedPartIds = new Set<string>();
    for (const partModel of fieldCompatibleTopologyRenderModel?.airboxParts ?? []) {
      excludedPartIds.add(partModel.part.id);
    }
    for (const partId of magneticPartScopedFieldIds) {
      excludedPartIds.add(partId);
    }
    if (!analysisOverlay) {
      for (const partModel of fieldCompatibleTopologyRenderModel?.magneticParts ?? []) {
        const settings = getPartSettings(partModel.part);
        if (!sameViewport3DQuantityId(settings.activeQuantityId, primaryFieldQuantityId)) {
          excludedPartIds.add(partModel.part.id);
        }
      }
    }
    return excludedPartIds;
  }, [
    analysisOverlay,
    fieldCompatibleTopologyRenderModel?.airboxParts,
    fieldCompatibleTopologyRenderModel?.magneticParts,
    getPartSettings,
    magneticPartScopedFieldIds,
    primaryFieldQuantityId,
  ]);
  const primaryFieldDataOptions = useMemo(
    () =>
      resolveViewport3DPrimaryFieldDataOptions(
        primaryFieldRenderOptions,
        primaryFieldVectorBudgetExclusions,
      ),
    [primaryFieldRenderOptions, primaryFieldVectorBudgetExclusions],
  );
  const partScalarRangeRequests = useMemo(
    () =>
      resolveViewport3DPartScalarRangeRequests({
        fieldRenderOptions: primaryFieldRenderOptions,
        getPartSettings,
        magneticParts: fieldCompatibleTopologyRenderModel?.magneticParts ?? [],
        selectedSnapshotQuery,
      }),
    [
      fieldCompatibleTopologyRenderModel?.magneticParts,
      getPartSettings,
      primaryFieldRenderOptions,
      selectedSnapshotQuery,
    ],
  );
  const partScalarRanges = useViewport3DPartScalarRanges(
    partScalarRangeRequests,
    partScalarRangeRequests.size > 0,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const resolvedFieldRenderOptions = useMemo(
    () => {
      const { partFieldVectors, partTargetFieldBuffers } =
        resolveViewport3DResolvedPartFieldBuffers({
          airboxFieldRevision: airboxFieldVectors.payloadRevision ?? null,
          airboxFieldVectorRequests,
          airboxFieldVectors: airboxFieldVectors.data,
          airboxQuantityCompatible,
          airboxQuantityId: airboxSettings.activeQuantityId,
          airboxSyntheticVectorsEnabled:
            airboxSettings.airboxSyntheticVectorsEnabled,
          getPartSettings,
          magneticPartFieldQueries,
          magneticPartFieldRevision:
            magneticPartFieldVectors.payloadRevision ?? null,
          magneticPartFieldVectors: magneticPartFieldVectors.data,
          targetQuantityFieldRequests,
          targetQuantityFieldRevision:
            targetQuantityFieldVectors.payloadRevision ?? null,
          targetQuantityFieldVectors: targetQuantityFieldVectors.data,
          topology: fieldCompatibleTopologyRenderModel,
          topologyRevision:
            topology.revision == null ? null : String(topology.revision),
        });
      const partScalarRangesByMode = mergeViewport3DPartScalarRanges({
        baseRanges: partScalarRanges.data,
        partFieldVectors,
        partScalarColorModes: primaryFieldRenderOptions.partScalarColorModes,
        partTargetFieldBuffers,
      });
      return partFieldVectors.size > 0 || partTargetFieldBuffers.size > 0
        ? {
            ...primaryFieldRenderOptions,
            ...(partFieldVectors.size > 0 ? { partFieldVectors } : {}),
            ...(partTargetFieldBuffers.size > 0
              ? { partTargetFieldBuffers }
              : {}),
            ...(partScalarRangesByMode.size > 0
              ? { partScalarRangesByMode }
              : {}),
          }
        : primaryFieldRenderOptions;
    },
    [
      airboxFieldVectorRequests,
      airboxFieldVectors.data,
      airboxFieldVectors.payloadRevision,
      airboxSettings.airboxSyntheticVectorsEnabled,
      airboxSettings.activeQuantityId,
      airboxQuantityCompatible,
      fieldCompatibleTopologyRenderModel,
      getPartSettings,
      magneticPartFieldVectors.data,
      magneticPartFieldVectors.payloadRevision,
      magneticPartFieldQueries,
      partScalarRanges.data,
      primaryFieldRenderOptions,
      targetQuantityFieldVectors.data,
      targetQuantityFieldVectors.payloadRevision,
      targetQuantityFieldRequests,
      topology.revision,
    ],
  );
  const fdmVoxelMagnitudeThreshold =
    fdmDomain
      ? visualProfile.voxelMagnitudeThreshold
      : 0;
  const fdmTopographyEnabled = Boolean(
    fdmDomain &&
      commandState.widgets.fdmTopographyEnabled,
  );
  const fdmVoxelTopography = useMemo(
    () => ({
      amplitudeCells: commandState.widgets.fdmTopographyAmplitudeCells,
      component: commandState.widgets.fdmTopographyComponent,
      enabled: fdmTopographyEnabled,
    }),
    [
      commandState.widgets.fdmTopographyAmplitudeCells,
      commandState.widgets.fdmTopographyComponent,
      fdmTopographyEnabled,
    ],
  );
  const fdmVectorsVisible = Boolean(
    fdmMembershipCurrent &&
      fdmTargetSettings.some(
        (settings) =>
          settings.visible &&
          settings.vectorsVisible &&
          viewport3DFieldQuantityAvailable(
            settings.activeQuantityId,
            availableQuantityIdsForPlanning,
          ),
      ),
  );
  const fdmAirboxVectorsVisible = Boolean(
    !fdmMultilayerAirboxDomain &&
    fdmMembershipCurrent &&
      fdmUniverseOutsideSupport &&
      fdmUniverseOutsideSupportSettings?.visible &&
      fdmUniverseOutsideSupportSettings.vectorsVisible &&
      viewport3DFieldQuantityAvailable(
        fdmUniverseOutsideSupportSettings.activeQuantityId,
        availableQuantityIdsForPlanning,
      ),
  );
  const fdmInstanceModelEnabled = Boolean(
    fdmMembershipCurrent &&
      fdmDomain &&
      fdmTargetDefinitionsResult.status === "ready",
  );
  const fdmInstanceModelNeedsFieldVector =
    fdmVoxelMagnitudeThreshold > 0 || fdmTopographyEnabled;
  const primaryFieldVectorEnabled =
    Boolean(fdmDomain || fieldCompatibleTopologyRenderModel) &&
    (Boolean(analysisOverlay) ||
      (viewport3DFieldQuantityAvailable(
        primaryFieldQuantityId,
        availableQuantityIdsForPlanning,
      ) &&
        resolveViewport3DPrimaryFieldVectorEnabled({
          fdmInstanceModelNeedsFieldVector,
          fdmSurfaceColorMode,
          fdmVectorsVisible: fdmVectorsVisible || fdmAirboxVectorsVisible,
          fieldRenderOptions: primaryFieldDataOptions,
          selectedSnapshotId,
        })));
  const primaryFieldDemandPlan = useMemo(
    () => {
      if (analysisOverlay) {
        const request: Viewport3DFieldResourceRequest = {
          consumers: ["primary-field-vector"],
          quantityId: primaryFieldQuantityId,
          query: analysisOverlay.query,
          requestId: buildViewport3DFieldResourceRequestId(
            primaryFieldQuantityId,
            analysisOverlay.query,
          ),
        };
        return {
          demands: [],
          request,
        };
      }
      return resolveViewport3DPrimaryFieldDemandPlan({
        fdmInstanceModelNeedsFieldVector,
        fdmSurfaceColorMode,
        fdmTopographyEnabled,
        fdmVectorsVisible: fdmVectorsVisible || fdmAirboxVectorsVisible,
        fieldRenderOptions: primaryFieldDataOptions,
        primaryFieldQuantityId,
        snapshotId: selectedSnapshotId,
        snapshotQuery: selectedSnapshotQuery,
      });
    },
    [
      analysisOverlay,
      fdmInstanceModelNeedsFieldVector,
      // The React Compiler cannot prove these derived lane values are immutable;
      // the explicit dependency list is intentional for the viewport model.
      fdmSurfaceColorMode,
      fdmTopographyEnabled,
      fdmVectorsVisible,
      fdmAirboxVectorsVisible,
      primaryFieldDataOptions,
      primaryFieldQuantityId,
      selectedSnapshotId,
      selectedSnapshotQuery,
    ],
  );
  const primaryFieldRequest = primaryFieldDemandPlan.request;
  const fieldDemandDiagnostics = useMemo<Viewport3DFieldDemandDiagnosticSummary[]>(
    () =>
      summarizeViewport3DFieldDemandDiagnostics({
        demands: [
          ...primaryFieldDemandPlan.demands,
          ...magneticPartFieldDemandPlan.demands,
          ...targetQuantityFieldDemandPlan.demands,
          ...airboxFieldDemandPlan.demands,
        ],
        requests: [
          primaryFieldDemandPlan.request,
          ...magneticPartFieldDemandPlan.requests.values(),
          ...targetQuantityFieldDemandPlan.requests.values(),
          ...Array.from(airboxFieldDemandPlan.requests.values(), (request) => ({
            consumers: request.consumers ?? [],
            query: request.query,
            quantityId: request.quantityId,
            requestId:
              request.requestId ??
              buildViewport3DFieldResourceRequestId(
                request.quantityId,
                request.query,
              ),
          })),
        ],
      }),
    [
      airboxFieldDemandPlan,
      magneticPartFieldDemandPlan,
      primaryFieldDemandPlan,
      targetQuantityFieldDemandPlan,
    ],
  );
  const dataPlaneIssues = useMemo(() => {
    const requests: Array<readonly [string, Viewport3DFieldResourceRequest]> = [
      ["primary-field", primaryFieldDemandPlan.request],
      ...Array.from(magneticPartFieldDemandPlan.requests),
      ...Array.from(targetQuantityFieldDemandPlan.requests),
      ...Array.from(airboxFieldDemandPlan.requests, ([targetId, request]) => [
        targetId,
        {
          consumers: request.consumers ?? [],
          query: request.query,
          quantityId: request.quantityId,
          requestId:
            request.requestId ??
            buildViewport3DFieldResourceRequestId(
              request.quantityId,
              request.query,
            ),
        },
      ] as const),
    ];
    return [
      ...validateViewport3DFieldResourceRequestIdentities(requests),
      ...validateViewport3DFieldResourceRequestEquivalence(requests),
    ];
  }, [
    airboxFieldDemandPlan,
    magneticPartFieldDemandPlan,
    primaryFieldDemandPlan,
    targetQuantityFieldDemandPlan,
  ]);
  const fieldVectorResourceKey = useMemo(
    () =>
      resolveViewport3DFieldVectorRequestResourceKey(primaryFieldRequest),
    [primaryFieldRequest],
  );
  const hysteresisReplayMeshCompatibility = useMemo(
    () =>
      resolveHysteresisReplayMeshCompatibility(
        hysteresisReplayTarget,
        fieldCompatibleTopologyRenderModel,
      ),
    [
      fieldCompatibleTopologyRenderModel,
      hysteresisReplayTarget,
    ],
  );
  const fieldVectorEnabled =
    primaryFieldVectorEnabled &&
    hysteresisReplayMeshCompatibility.status !== "mismatch";
  const scalarRangeModeFlags = useMemo(
    () =>
      resolveViewport3DScalarRangeModeFlags(
        primaryFieldRenderOptions.scalarColorModes,
        vectorColorMode,
      ),
    [primaryFieldRenderOptions.scalarColorModes, vectorColorMode],
  );
  const scalarRangeStatsEnabled =
    fieldVectorEnabled && primaryFieldRenderOptions.scalarColorsVisible !== false;
  const primaryFieldMetaEnabled =
    scalarRangeStatsEnabled &&
    !isAnalysisFieldQuantityId(primaryFieldQuantityId) &&
    viewport3DFieldQuantityAvailable(
      primaryFieldQuantityId,
      availableQuantityIdsForPlanning,
    );
  const primaryMagnitudeFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "magnitude",
    ),
    enabled: primaryFieldMetaEnabled && scalarRangeModeFlags.magnitude,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const primaryXFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "x",
    ),
    enabled: primaryFieldMetaEnabled && scalarRangeModeFlags.x,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const primaryYFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "y",
    ),
    enabled: primaryFieldMetaEnabled && scalarRangeModeFlags.y,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const primaryZFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "z",
    ),
    enabled: primaryFieldMetaEnabled && scalarRangeModeFlags.z,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const fieldScalarRangesByMode = useMemo<
    ReadonlyMap<string, ScalarRange> | undefined
  >(() => {
    const entries: [string, ScalarRange][] = [];
    const magnitudeRange = resolveViewport3DFieldMetaScalarRange(
      primaryMagnitudeFieldMeta.data,
    );
    const xRange = resolveViewport3DFieldMetaScalarRange(primaryXFieldMeta.data);
    const yRange = resolveViewport3DFieldMetaScalarRange(primaryYFieldMeta.data);
    const zRange = resolveViewport3DFieldMetaScalarRange(primaryZFieldMeta.data);
    if (magnitudeRange) entries.push(["magnitude", magnitudeRange]);
    if (xRange) entries.push(["x", xRange]);
    if (yRange) entries.push(["y", yRange]);
    if (zRange) entries.push(["z", zRange]);
    const mode = analysisOverlay?.appearance?.colorRangeMode;
    const gain = Math.max(0, analysisOverlay?.appearance?.displayGain ?? 1);
    const configuredMax = analysisOverlay?.appearance?.colorRangeMax;
    const configuredMin = analysisOverlay?.appearance?.colorRangeMin;
    if (mode === "manual" && configuredMin != null && configuredMax != null) {
      const denominator = Math.max(gain, Number.EPSILON);
      const range = {
        max: configuredMax / denominator,
        min: configuredMin / denominator,
      };
      for (const scalarMode of enabledScalarRangeModes(scalarRangeModeFlags)) {
        entries.push([scalarMode, range]);
      }
    } else if (mode === "symmetric" && configuredMax != null) {
      const extent = Math.abs(configuredMax) / Math.max(gain, Number.EPSILON);
      for (const scalarMode of enabledScalarRangeModes(scalarRangeModeFlags)) {
        entries.push([scalarMode, { max: extent, min: -extent }]);
      }
    }
    return entries.length > 0 ? new Map(entries) : undefined;
  }, [
    analysisOverlay?.appearance?.colorRangeMax,
    analysisOverlay?.appearance?.colorRangeMin,
    analysisOverlay?.appearance?.colorRangeMode,
    analysisOverlay?.appearance?.displayGain,
    primaryMagnitudeFieldMeta.data,
    primaryXFieldMeta.data,
    primaryYFieldMeta.data,
    primaryZFieldMeta.data,
    scalarRangeModeFlags,
  ]);
  const fieldVector = useViewport3DFieldVectorRequest(
    primaryFieldRequest,
    fieldVectorEnabled,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const analysisComplexFieldQuery = useMemo(
    () =>
      analysisOverlay
        ? resolveViewport3DAnalysisComplexFieldQuery(analysisOverlay.query)
        : {},
    [analysisOverlay],
  );
  const analysisComplexProjectionEnabled = useMemo(
    () => resolveViewport3DAnalysisComplexProjectionEnabled(analysisOverlay?.query),
    [analysisOverlay?.query],
  );
  const analysisComplexFieldVector = useViewport3DFieldVector(
    primaryFieldQuantityId,
    analysisComplexFieldQuery,
    Boolean(analysisOverlay) &&
      analysisComplexProjectionEnabled &&
      fieldVectorEnabled,
    { pauseLoad: fieldUpdateHoldActive },
  );
  const fieldDataIssue = useMemo<Viewport3DFieldDataIssue | null>(() => {
    const fieldVectorErrorMessage =
      fieldVectorEnabled && fieldVector.error ? fieldVector.error.message : null;
    return resolveViewport3DFieldDataIssue({
      fieldVectorEnabled,
      fieldVectorErrorMessage,
      fieldVectorRefetch: fieldVector.refetch,
      fieldVectorResourceKey,
      fieldVectorRevision: fieldVector.revision,
      fieldVectorStatus: fieldVector.status,
      fieldVectorDataAvailable: fieldVector.data !== null,
      hysteresisReplayMeshCompatibility,
      primaryFieldQuantityId,
    });
  }, [
    fieldVector.error,
    fieldVector.data,
    fieldVector.refetch,
    fieldVector.revision,
    fieldVector.status,
    fieldVectorEnabled,
    fieldVectorResourceKey,
    hysteresisReplayMeshCompatibility,
    primaryFieldQuantityId,
  ]);
  const fieldRefresh = useMemo<Viewport3DFieldRefreshState>(
    () => ({
      enabled: computeRunning && fieldVectorEnabled,
      payloadRevision: fieldVector.payloadRevision ?? null,
      quantityId: primaryFieldQuantityId,
      resourceKey: fieldVectorResourceKey,
      revision: fieldVector.revision,
      requestedRevision: fieldVector.revision,
      status: fieldVector.status,
    }),
    [
      computeRunning,
      fieldVector.revision,
      fieldVector.payloadRevision,
      fieldVector.status,
      fieldVectorEnabled,
      fieldVectorResourceKey,
      primaryFieldQuantityId,
    ],
  );
  const committedFieldVector = fieldVector.data ?? null;
  const primaryFieldRevision =
    fieldVector.payloadRevision ?? fieldVector.revision;
  const fieldRenderOptionsWithPrimaryTargetBuffers = useMemo(
    () =>
      mergeViewport3DPrimaryTargetFieldBuffers({
        fieldRenderOptions: resolvedFieldRenderOptions,
        fieldRevision:
          primaryFieldRevision == null ? null : String(primaryFieldRevision),
        fieldVector: committedFieldVector,
        getPartSettings,
        primaryFieldQuantityId,
        primaryFieldRequest,
        primaryFieldResourceKey: fieldVectorResourceKey,
        topology: fieldCompatibleTopologyRenderModel,
        topologyRevision:
          topology.revision == null ? null : String(topology.revision),
      }),
    [
      committedFieldVector,
      fieldCompatibleTopologyRenderModel,
      getPartSettings,
      primaryFieldQuantityId,
      primaryFieldRequest,
      fieldVectorResourceKey,
      primaryFieldRevision,
      resolvedFieldRenderOptions,
      topology.revision,
    ],
  );
  const analysisComplexField = useMemo(
    () =>
      analysisComplexProjectionEnabled
        ? asDecodedComplexFieldVector(analysisComplexFieldVector.data)
        : null,
    [analysisComplexFieldVector.data, analysisComplexProjectionEnabled],
  );
  const fdmUsesPrimaryField = sameViewport3DQuantityId(
    fdmSettings.activeQuantityId,
    primaryFieldQuantityId,
  );
  const fdmTargetQuantityField =
    !fdmUsesPrimaryField && targetQuantityFieldVectors.data
      ? resolveViewport3DTargetQuantityFieldVectorForTarget({
          fieldVectors: targetQuantityFieldVectors.data,
          quantityId: fdmSettings.activeQuantityId,
          requests: targetQuantityFieldRequests,
          targetId: "fdm-domain",
      })
      : null;
  const fdmAirboxActiveQuantityId =
    fdmUniverseOutsideSupportSettings?.activeQuantityId ?? "m";
  const fdmAirboxUsesPrimaryField = sameViewport3DQuantityId(
    fdmAirboxActiveQuantityId,
    primaryFieldQuantityId,
  );
  const fdmAirboxTargetQuantityField =
    !fdmAirboxUsesPrimaryField && targetQuantityFieldVectors.data
      ? resolveViewport3DTargetQuantityFieldVectorForTarget({
          fieldVectors: targetQuantityFieldVectors.data,
          quantityId: fdmAirboxActiveQuantityId,
          requests: targetQuantityFieldRequests,
          targetId: "fdm-universe-outside-support",
        })
      : null;
  const fdmCandidateFieldVector = fdmUsesPrimaryField
    ? committedFieldVector
    : fdmTargetQuantityField?.fieldVector ?? null;
  const fdmFieldResponseMetadata = fdmUsesPrimaryField
    ? fieldVector.responseMetadata
    : fdmTargetQuantityField
      ? targetQuantityFieldVectors.responseMetadataByRequestId.get(
          fdmTargetQuantityField.requestId,
        ) ?? null
      : null;
  const fdmResponseDomainGenerationId = fdmCandidateFieldVector
    ? resolveTrustedViewport3DResponseDomainGenerationId(
        fdmCandidateFieldVector,
        fdmFieldResponseMetadata,
      )
    : null;
  const fdmDomainGenerationId = safeViewport3DDomainGenerationId(
    domainMeta.data?.generation_id,
  );
  const fdmFieldDomainIdentity = {
    discretization: "fdm" as const,
    domainGenerationId: fdmDomainGenerationId,
    meshTopologyHash: fdmRegionMembershipBinary.data?.gridFingerprint ?? null,
    meshTopologyRevision: null,
    pointCount: fdmDomain?.totalCells ?? 0,
  };
  const fdmFieldCompatibility = fdmCandidateFieldVector
    ? resolveViewport3DFieldDomainCompatibility({
        domain: fdmFieldDomainIdentity,
        field: fdmCandidateFieldVector,
        responseDomainGenerationId: fdmResponseDomainGenerationId,
      })
    : null;
  const fdmFieldVector = resolveViewport3DFieldVectorForDomain({
    domain: fdmFieldDomainIdentity,
    fieldVector: fdmCandidateFieldVector,
    responseDomainGenerationId: fdmResponseDomainGenerationId,
  });
  const fdmPrimaryResponseDomainGenerationId = committedFieldVector
    ? resolveTrustedViewport3DResponseDomainGenerationId(
        committedFieldVector,
        fieldVector.responseMetadata,
      )
    : null;
  const fdmPrimaryFieldVector = resolveViewport3DFieldVectorForDomain({
    domain: fdmFieldDomainIdentity,
    fieldVector: committedFieldVector,
    responseDomainGenerationId: fdmPrimaryResponseDomainGenerationId,
  });
  const fdmAirboxCandidateFieldVector = fdmAirboxUsesPrimaryField
    ? committedFieldVector
    : fdmAirboxTargetQuantityField?.fieldVector ?? null;
  const fdmAirboxFieldResponseMetadata = fdmAirboxUsesPrimaryField
    ? fieldVector.responseMetadata
    : fdmAirboxTargetQuantityField
      ? targetQuantityFieldVectors.responseMetadataByRequestId.get(
          fdmAirboxTargetQuantityField.requestId,
        ) ?? null
      : null;
  const fdmAirboxResponseDomainGenerationId = fdmAirboxCandidateFieldVector
    ? resolveTrustedViewport3DResponseDomainGenerationId(
        fdmAirboxCandidateFieldVector,
        fdmAirboxFieldResponseMetadata,
      )
    : null;
  const fdmAirboxFieldVector = resolveViewport3DFieldVectorForDomain({
    domain: fdmFieldDomainIdentity,
    fieldVector: fdmAirboxCandidateFieldVector,
    responseDomainGenerationId: fdmAirboxResponseDomainGenerationId,
  });
  const fdmFieldRevision =
    sameViewport3DQuantityId(fdmSettings.activeQuantityId, primaryFieldQuantityId)
      ? fieldVector.payloadRevision ?? fieldVector.revision
      : targetQuantityFieldVectors.payloadRevision ??
        targetQuantityFieldVectors.revision;
  const fdmAirboxFieldRevision = fdmAirboxUsesPrimaryField
    ? fieldVector.payloadRevision ?? fieldVector.revision
    : targetQuantityFieldVectors.payloadRevision ??
      targetQuantityFieldVectors.revision;
  const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector
    ? fdmFieldVector
    : null;
  const fdmBuildTopologyRevision =
    domainMeta.revision == null ? null : String(domainMeta.revision);
  const fdmBuildFieldRevision =
    fdmInstanceModelNeedsFieldVector
      ? fdmFieldRevision == null
        ? null
        : String(fdmFieldRevision)
      : null;
  const fdmBuildSamplingRevision = fdmDomain
    ? `shape=${fdmDomain.shape.join("x")}|display=${fdmDomain.displayCellCount}|total=${fdmDomain.totalCells}|stride=${fdmDomain.stride}|membership=${fdmRegionMembership.revision ?? "none"}`
    : "none";
  const fdmBuildStyleRevision = [
    `fill=${visualProfile.voxelFillRatio}`,
    `threshold=${fdmVoxelMagnitudeThreshold}`,
    `topography=${fdmVoxelTopography.enabled}:${fdmVoxelTopography.component}:${fdmVoxelTopography.amplitudeCells}`,
  ].join("|");
  const fdmBuildKey = fdmInstanceModelEnabled
    ? buildViewport3DFdmCuboidJobKey({
        algorithmVersion: 1,
        component: fdmInstanceModelNeedsFieldVector
          ? fdmVoxelTopography.component
          : null,
        domainId: domainMeta.data?.domain_id ?? "shared-domain",
        domainGenerationId: fdmDomainGenerationId,
        fieldRevision: fdmBuildFieldRevision,
        quantityId: fdmInstanceModelNeedsFieldVector
          ? resolveCanonicalQuantityId(fdmFieldVector?.quantityId ?? "m")
          : "geometry",
        samplingRevision: fdmBuildSamplingRevision,
        scopeId: "full",
        scopeKind: "full",
        sessionId: "current",
        styleRevision: fdmBuildStyleRevision,
        targetVisualizationRevision: "shared-model",
        topologyRevision: fdmBuildTopologyRevision,
      })
    : null;
  const fdmBuildGroupKey = fdmInstanceModelEnabled
    ? `fdm-cuboid:session=current:domain=${domainMeta.data?.domain_id ?? "shared-domain"}`
    : null;
  const fdmBuildState = useFdmCuboidBuildResult({
    buildKey: fdmBuildKey,
    cellSelection: "active",
    domain: fdmDomain,
    enabled: fdmInstanceModelEnabled,
    groupKey: fdmBuildGroupKey,
    maxVectorGlyphs: 0,
    modelFieldVector: fdmInstanceModelFieldVector,
    realizedRegionIds: fdmRealizedRegionIds,
    revisionSummary: `domain=${fdmBuildTopologyRevision ?? "none"} field=${fdmBuildFieldRevision ?? "none"} membership=${fdmRegionMembership.revision ?? "none"}`,
    vectorAnchorMode: "center",
    vectorField: null,
    vectorScale: 0,
    voxelFillRatio: visualProfile.voxelFillRatio,
    voxelMagnitudeThreshold: fdmVoxelMagnitudeThreshold,
    voxelTopography: fdmVoxelTopography,
  });
  const fdmBuildResult = fdmBuildState?.result ?? undefined;
  const fdmInstanceModel: FdmCuboidInstanceModel | null | undefined =
    fdmBuildResult?.model;
  const fdmTargetViewsResult = useMemo(
    () =>
      buildViewport3DFdmTargetViews({
        membership: fdmRegionMembership.data,
        model: fdmInstanceModel,
        realizedRegionIds: fdmRealizedRegionIds,
        sceneObjectIds,
      }),
    [
      fdmInstanceModel,
      fdmRealizedRegionIds,
      fdmRegionMembership.data,
      sceneObjectIds,
    ],
  );
  const fdmAirboxPassPlan = resolveFdmAirboxPassPlan(
    fdmSingleGridAirboxSettings ?? { ...fdmSettings, visible: false },
  );
  const fdmAirboxBuildTargetRevision =
    renderingState?.revision == null ? null : String(renderingState.revision);
  const fdmAirboxMaxVectorGlyphs = fdmUniverseOutsideSupportSettings
    ? clampViewport3DInteractiveVectorBudget(
        fdmUniverseOutsideSupportSettings.vectorBudget,
        maxInteractiveVectorGlyphs,
      )
    : 0;
  const fdmAirboxVectorScale = fdmUniverseOutsideSupportSettings
    ? vectorScale *
      resolveViewport3DAirboxVectorLengthScale(
        fdmUniverseOutsideSupportSettings.vectorLengthScale,
      )
    : 0;
  const fdmAirboxVectorAnchorMode =
    fdmUniverseOutsideSupportSettings?.vectorCenteringEnabled ? "center" : "tail";
  const fdmAirboxInstanceModelEnabled = Boolean(
      fdmMembershipCurrent &&
      !fdmMultilayerAirboxDomain &&
      fdmUniverseOutsideSupport &&
      fdmUniverseOutsideSupportSettings?.visible &&
      fdmAirboxPassPlan.needsInactiveCellGeometry,
  );
  const fdmAirboxBuildKey = fdmAirboxInstanceModelEnabled
    ? buildViewport3DFdmCuboidJobKey({
        algorithmVersion: 1,
        component: fdmAirboxVectorsVisible ? "full" : null,
        domainId: domainMeta.data?.domain_id ?? "shared-domain",
        domainGenerationId: fdmDomainGenerationId,
        fieldRevision:
          fdmAirboxVectorsVisible && fdmAirboxFieldRevision != null
            ? String(fdmAirboxFieldRevision)
            : null,
        quantityId: resolveCanonicalQuantityId(
          fdmUniverseOutsideSupportSettings?.activeQuantityId ?? "m",
        ),
        samplingRevision: fdmBuildSamplingRevision,
        scopeId: "airbox",
        scopeKind: "airbox",
        sessionId: "current",
        styleRevision: `fill=${visualProfile.voxelFillRatio}|airbox=true|vectors=${fdmAirboxVectorsVisible}:${fdmAirboxMaxVectorGlyphs}:${fdmAirboxVectorScale}:${fdmAirboxVectorAnchorMode}|field=${fdmAirboxFieldVector ? "ready" : "pending"}`,
        targetVisualizationRevision: fdmAirboxBuildTargetRevision ?? "unknown",
        topologyRevision: fdmBuildTopologyRevision,
      })
    : null;
  const fdmAirboxBuildState = useFdmCuboidBuildResult({
    buildKey: fdmAirboxBuildKey,
    cellSelection: "inactive",
    domain: fdmDomain,
    enabled: fdmAirboxInstanceModelEnabled,
    groupKey: fdmAirboxInstanceModelEnabled
      ? `fdm-cuboid:session=current:domain=${domainMeta.data?.domain_id ?? "shared-domain"}:airbox`
      : null,
    maxVectorGlyphs: fdmAirboxMaxVectorGlyphs,
    modelFieldVector: null,
    realizedRegionIds: fdmRealizedRegionIds,
    revisionSummary: `domain=${fdmBuildTopologyRevision ?? "none"} membership=${fdmRegionMembership.revision ?? "none"} target=${fdmAirboxBuildTargetRevision ?? "none"}`,
    vectorAnchorMode: fdmAirboxVectorAnchorMode,
    vectorField: fdmAirboxVectorsVisible ? fdmAirboxFieldVector : null,
    vectorScale: fdmAirboxVectorScale,
    voxelFillRatio: visualProfile.voxelFillRatio,
    voxelMagnitudeThreshold: 0,
    voxelTopography: FDM_AIRBOX_VOXEL_TOPOGRAPHY,
  });
  const fdmAirboxInstanceModel: FdmCuboidInstanceModel | null | undefined =
    fdmAirboxBuildState?.result?.model;
  const fdmAirboxVectorSegments =
    fdmAirboxBuildState?.result?.vectorSegments ?? null;
  const fdmAirboxVectorCellIndices =
    fdmAirboxBuildState?.result?.vectorCellIndices ?? null;
  const fdmTargetViews: readonly Viewport3DFdmTargetRenderView[] =
    fdmTargetViewsResult.status === "ready"
      ? fdmTargetViewsResult.views.flatMap((view) => {
          const settings = fdmTargetSettingsById.get(view.target.id);
          if (!settings) return [];
          const targetField = resolveViewport3DFdmTargetFieldVectorForTarget({
            primaryFieldQuantityId,
            primaryFieldVector: fdmPrimaryFieldVector,
            quantityId: settings.activeQuantityId,
            targetFieldRequests: targetQuantityFieldRequests,
            targetFieldVectors: targetQuantityFieldVectors.data,
            targetId: view.target.id,
          });
          const targetFieldResponseMetadata =
            targetField?.requestId === "primary-field-vector"
              ? fieldVector.responseMetadata
              : targetField
                ? targetQuantityFieldVectors.responseMetadataByRequestId.get(
                    targetField.requestId,
                  ) ?? null
                : null;
          const targetFieldResponseDomainGenerationId = targetField
            ? resolveTrustedViewport3DResponseDomainGenerationId(
                targetField.fieldVector,
                targetFieldResponseMetadata,
              )
            : null;
          const targetFieldVector = targetField
            ? resolveViewport3DFieldVectorForDomain({
                domain: fdmFieldDomainIdentity,
                fieldVector: targetField.fieldVector,
                responseDomainGenerationId: targetFieldResponseDomainGenerationId,
              })
            : null;
          const targetFieldRevision =
            targetField?.requestId === "primary-field-vector"
              ? fieldVector.payloadRevision ?? fieldVector.revision
              : targetField
                ? targetQuantityFieldVectors.payloadRevision ??
                  targetQuantityFieldVectors.revision
                : null;
          const targetFieldResourceKey =
            targetField?.requestId === "primary-field-vector"
              ? fieldVectorResourceKey
              : targetField?.request
                ? resolveViewport3DFieldVectorResourceKey(
                    targetField.request.quantityId,
                    targetField.request.query,
                  )
                : null;
          const targetSourceFieldBufferId = targetFieldVector
            ? `decoded:${targetFieldVector.quantityId}:${targetFieldVector.pointCount}:${targetFieldVector.values.byteLength}`
            : "none";
          const fieldCompatible = Boolean(
            targetFieldVector &&
              sameViewport3DQuantityId(
                settings.activeQuantityId,
                targetFieldVector.quantityId,
              ),
          );
          const surfaceMode = fieldCompatible
            ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
            : null;
          const surfaceColorKey = [
            targetSourceFieldBufferId,
            targetFieldRevision ?? "none",
            targetFieldResourceKey ?? "none",
            settings.geometryScope,
            settings.surfaceColorSource,
            surfaceMode ?? "none",
            settings.scalarColorPalette,
            view.target.id,
            view.instanceOrdinals.length,
            view.surfaceInstanceOrdinals.length,
          ].join("|");
          const surfaceColors = memoizeViewport3DFdmTargetSurfaceColors({
            build: () => {
              if (!targetFieldVector || !fdmDomain || !surfaceMode) return null;
              const colors = buildFdmSampledScalarColors(
                targetFieldVector,
                settings.geometryScope === "surface"
                  ? buildViewport3DFdmTargetSurfaceCellIndices(view)
                  : view.cellIndices,
                fdmDomain.totalCells,
                surfaceMode,
                settings.scalarColorPalette,
              );
              return colors
                ? {
                    ...colors,
                    buildKey: surfaceColorKey,
                    sourceFieldBufferId: targetSourceFieldBufferId,
                    sourceResourceKey: targetFieldResourceKey,
                  }
                : null;
            },
            colorKey: surfaceColorKey,
            view,
          });
          const renderKey = [
            targetSourceFieldBufferId,
            targetFieldRevision ?? "none",
            targetFieldResourceKey ?? "none",
            maxInteractiveVectorGlyphs,
            vectorScale,
            JSON.stringify(settings),
          ].join("|");
          return [
            memoizeViewport3DFdmTargetRenderView({
              build: () => {
                if (!targetFieldVector || !fdmDomain) {
                  return {
                    ...view,
                    fieldVector: null,
                    settings,
                    surfaceColors: null,
                    vectorColors: null,
                    vectorGlyphColors: null,
                    vectorSegments: null,
                  };
                }
                const vectorsVisible =
                  settings.visible && settings.vectorsVisible && fieldCompatible;
                const vectorColors = vectorsVisible
                  ? buildFdmSampledScalarColors(
                      targetFieldVector,
                      view.cellIndices,
                      fdmDomain.totalCells,
                      settings.vectorColorMode,
                      settings.scalarColorPalette,
                    )
                  : null;
                const maxVectors = clampViewport3DInteractiveVectorBudget(
                  settings.vectorBudget,
                  maxInteractiveVectorGlyphs,
                );
                const vectorInstanceOrdinals =
                  settings.geometryScope === "surface"
                    ? view.surfaceInstanceOrdinals
                    : view.instanceOrdinals;
                const vectorCellIndices = vectorsVisible
                  ? buildFdmVectorSampledCellIndices(
                      view.sourceModel,
                      targetFieldVector,
                      maxVectors,
                      vectorInstanceOrdinals,
                      "full",
                    )
                  : null;
                const vectorGlyphColors =
                  vectorColors && vectorCellIndices
                    ? buildFdmSampledScalarColors(
                        targetFieldVector,
                        vectorCellIndices,
                        fdmDomain.totalCells,
                        vectorColors.colorMode,
                        vectorColors.colorPalette,
                        vectorColors.range,
                      )
                    : null;
                const withSource = (colors: typeof surfaceColors) =>
                  colors
                    ? {
                        ...colors,
                        sourceFieldBufferId: targetSourceFieldBufferId,
                        sourceResourceKey: targetFieldResourceKey,
                      }
                    : null;
                return {
                  ...view,
                  fieldVector: targetFieldVector,
                  settings,
                  surfaceColors,
                  vectorColors: withSource(vectorColors),
                  vectorGlyphColors: withSource(vectorGlyphColors),
                  vectorSegments: vectorsVisible
                    ? buildFdmVectorSegments(
                        view.sourceModel,
                        targetFieldVector,
                        vectorScale * settings.vectorLengthScale,
                        maxVectors,
                        {
                          anchorMode: settings.vectorCenteringEnabled
                            ? "center"
                            : "tail",
                          geometryScope: "full",
                          instanceOrdinals: vectorInstanceOrdinals,
                        },
                      )
                    : null,
                };
              },
              renderKey,
              view,
            }),
          ];
        })
      : [];
  const fdmMultilayerVoxelFillRatio = useMemo(
    () => getViewport3DVisualProfile(commandState.visualProfileId).voxelFillRatio,
    [commandState.visualProfileId],
  );
  const fdmMultilayerCuboidBuildEntries = useMemo<
    readonly FdmCuboidAsyncBuildEntry[]
  >(() => {
    const layoutGenerationId = safeViewport3DDomainGenerationId(
      fdmMultilayerLayout.data?.domain_generation_id,
    );
    if (!fdmMultilayerLayout.data?.available || !layoutGenerationId) return [];
    const entries: FdmCuboidAsyncBuildEntry[] = fdmNativeLayerDomains.map(
      (domain) => {
        const layerLayout = fdmMultilayerLayout.data?.layers.find(
          (layer) => layer.layer_id === domain.layerId,
        );
        const decodedActiveMask = domain.activeMaskPresent
          ? fdmMultilayerLayerActiveMasks.data?.masks.get(domain.layerId) ?? null
          : null;
        const activeMask = resolveFdmNativeLayerActiveMaskForRendering(
          domain,
          fdmMultilayerLayout.data!.layout_revision,
          layerLayout,
          decodedActiveMask,
        );
        const activeMaskRequired = domain.activeMaskPresent;
        const maskRevision = domain.activeMaskPresent
          ? layerLayout?.active_mask_hash ?? "missing"
          : "dense";
        const settings =
          fdmNativeLayerSettingsById.get(domain.layerId) ?? fdmSettings;
        const request = nativeLayerFieldRequests.get(domain.layerId);
        const requestedField = request
          ? nativeLayerFieldVectors.data?.get(request.requestId) ?? null
          : null;
        const compatibleField = resolveFdmNativeLayerFieldVector(
          domain,
          layoutGenerationId,
          requestedField,
        );
        const fieldVector =
          compatibleField &&
          sameViewport3DQuantityId(
            settings.activeQuantityId,
            compatibleField.quantityId,
          )
            ? compatibleField
            : null;
        const vectorsVisible = Boolean(
          settings.visible && settings.vectorsVisible && fieldVector,
        );
        const maxVectors = clampViewport3DInteractiveVectorBudget(
          settings.vectorBudget,
          maxInteractiveVectorGlyphs,
        );
        const fieldRevision = request
          ? String(
              nativeLayerFieldVectors.payloadRevisionByRequestId.get(
                request.requestId,
              ) ?? "missing",
            )
          : "none";
        const targetStyleRevision =
          `visible=${settings.visible}|vectors=${vectorsVisible}|budget=${maxVectors}` +
          `|scale=${settings.vectorLengthScale}|center=${settings.vectorCenteringEnabled}`;
        const buildKey = buildViewport3DFdmCuboidJobKey({
          algorithmVersion: 2,
          component: vectorsVisible ? "full" : null,
          domainId: domain.layerId,
          domainGenerationId: layoutGenerationId,
          fieldRevision: vectorsVisible ? fieldRevision : null,
          quantityId: vectorsVisible
            ? resolveCanonicalQuantityId(settings.activeQuantityId)
            : "geometry",
          samplingRevision: `shape=${domain.shape.join("x")}|display=${domain.displayCellCount}|total=${domain.totalCells}|mask=${maskRevision}`,
          scopeId: domain.layerId,
          scopeKind: "fdm_native_layer",
          sessionId: "current",
          styleRevision: `fill=${fdmMultilayerVoxelFillRatio}|vectors=${vectorsVisible}:${maxVectors}:${vectorScale * settings.vectorLengthScale}:${settings.vectorCenteringEnabled}`,
          targetVisualizationRevision: targetStyleRevision,
          topologyRevision: `${domain.gridFingerprint ?? "missing"}|layout=${fdmMultilayerLayout.data?.layout_revision ?? "missing"}|mask=${maskRevision}`,
        });
        return {
          buildKey,
          cellSelection: "dense",
          domain: { ...domain, kind: "fdm-grid" as const },
          enabled: settings.visible && (!activeMaskRequired || activeMask !== null),
          groupKey: `fdm-cuboid:session=current:native-layer:${domain.layerId}`,
          id: `native:${domain.layerId}`,
          maxVectorGlyphs: maxVectors,
          modelFieldVector: null,
          nativeActiveMask: activeMask,
          realizedRegionIds: null,
          revisionSummary: `carrier=${domain.gridFingerprint ?? "none"} target=${targetStyleRevision} field=${fieldRevision}`,
          vectorAnchorMode: settings.vectorCenteringEnabled ? "center" : "tail",
          vectorField: vectorsVisible ? fieldVector : null,
          vectorScale: vectorScale * settings.vectorLengthScale,
          voxelFillRatio: fdmMultilayerVoxelFillRatio,
          voxelMagnitudeThreshold: 0,
          voxelTopography: FDM_AIRBOX_VOXEL_TOPOGRAPHY,
        };
      },
    );
    if (fdmMultilayerAirboxDomain && airboxSettings.visible) {
      const fieldVector = resolveFdmMultilayerAirboxFieldVector(
        fdmMultilayerAirboxDomain,
        fdmMultilayerAirboxField.data,
      );
      const vectorsVisible = Boolean(
        airboxSettings.vectorsVisible && fieldVector,
      );
      const maxVectors = clampViewport3DInteractiveVectorBudget(
        airboxSettings.vectorBudget,
        maxInteractiveVectorGlyphs,
      );
      const airboxFieldRevision = String(
        fdmMultilayerAirboxField.payloadRevision ?? "missing",
      );
      const airboxStyleRevision =
        `visible=${airboxSettings.visible}|vectors=${vectorsVisible}|budget=${maxVectors}` +
        `|scale=${airboxSettings.vectorLengthScale}|center=${airboxSettings.vectorCenteringEnabled}` +
        `|scope=${airboxSettings.geometryScope}`;
      entries.push({
        buildKey: buildViewport3DFdmCuboidJobKey({
          algorithmVersion: 2,
          component: vectorsVisible ? "full" : null,
          domainId: "fdm-multilayer-airbox",
          domainGenerationId: layoutGenerationId,
          fieldRevision: vectorsVisible ? airboxFieldRevision : null,
          quantityId: vectorsVisible
            ? resolveCanonicalQuantityId(airboxSettings.activeQuantityId)
            : "geometry",
          samplingRevision: `shape=${fdmMultilayerAirboxDomain.shape.join("x")}|display=${fdmMultilayerAirboxDomain.displayCellCount}|total=${fdmMultilayerAirboxDomain.totalCells}`,
          scopeId: "airbox",
          scopeKind: "airbox",
          sessionId: "current",
          styleRevision: `fill=${fdmMultilayerVoxelFillRatio}|vectors=${vectorsVisible}:${maxVectors}:${vectorScale * airboxSettings.vectorLengthScale}:${airboxSettings.vectorCenteringEnabled}`,
          targetVisualizationRevision: airboxStyleRevision,
          topologyRevision: fdmMultilayerAirboxDomain.carrierFingerprint,
        }),
        cellSelection: "dense",
        domain: { ...fdmMultilayerAirboxDomain, kind: "fdm-grid" as const },
        enabled: true,
        groupKey: "fdm-cuboid:session=current:multilayer-airbox",
        id: "airbox",
        maxVectorGlyphs: maxVectors,
        realizedRegionIds: null,
        revisionSummary: `carrier=${fdmMultilayerAirboxDomain.carrierFingerprint} target=${airboxStyleRevision} field=${airboxFieldRevision}`,
        vectorAnchorMode: airboxSettings.vectorCenteringEnabled ? "center" : "tail",
        vectorField: vectorsVisible ? fieldVector : null,
        vectorGeometryScope: airboxSettings.geometryScope,
        vectorScale: vectorScale * airboxSettings.vectorLengthScale,
        voxelFillRatio: fdmMultilayerVoxelFillRatio,
        voxelMagnitudeThreshold: 0,
        voxelTopography: FDM_AIRBOX_VOXEL_TOPOGRAPHY,
      });
    }
    return entries;
  }, [
    airboxSettings,
    fdmMultilayerAirboxDomain,
    fdmMultilayerAirboxField.data,
    fdmMultilayerAirboxField.payloadRevision,
    fdmMultilayerLayout.data,
    fdmMultilayerLayerActiveMasks.data,
    fdmNativeLayerDomains,
    fdmNativeLayerSettingsById,
    fdmSettings,
    maxInteractiveVectorGlyphs,
    nativeLayerFieldRequests,
    nativeLayerFieldVectors.data,
    nativeLayerFieldVectors.payloadRevisionByRequestId,
    vectorScale,
    fdmMultilayerVoxelFillRatio,
  ]);
  const fdmMultilayerCuboidBuildResults = useFdmCuboidBuildResults(
    fdmMultilayerCuboidBuildEntries,
  );
  const fdmNativeLayerViews = useMemo<readonly FdmNativeLayerRenderView[]>(
    () => {
      const layout = fdmMultilayerLayout.data;
      const layoutGenerationId = safeViewport3DDomainGenerationId(
        layout?.domain_generation_id,
      );
      if (!layout?.available || !layoutGenerationId) return [];

      return fdmNativeLayerDomains.map((domain) => {
        const target = targetForFdmNativeLayer(
          domain.layerId,
          domain.magnetName,
        );
        const settings =
          fdmNativeLayerSettingsById.get(domain.layerId) ?? fdmSettings;
        const request = nativeLayerFieldRequests.get(domain.layerId);
        const requestedField = request
          ? nativeLayerFieldVectors.data?.get(request.requestId) ?? null
          : null;
        const compatibleField = resolveFdmNativeLayerFieldVector(
          domain,
          layoutGenerationId,
          requestedField,
        );
        const fieldVector =
          compatibleField &&
          sameViewport3DQuantityId(
            settings.activeQuantityId,
            compatibleField.quantityId,
          )
            ? compatibleField
            : null;
        const buildResult = fdmMultilayerCuboidBuildResults.get(
          `native:${domain.layerId}`,
        )?.result;
        const model = buildResult?.model ?? null;
        const surfaceMode =
          model && fieldVector
            ? surfaceColorSourceToColorMode(settings.surfaceColorSource)
            : null;
        const surfaceColorKey = [
          "native-layer",
          domain.layerId,
          request?.requestId ?? "none",
          request
            ? String(
                nativeLayerFieldVectors.payloadRevisionByRequestId.get(
                  request.requestId,
                ) ?? "missing",
              )
            : "none",
          model?.membershipRevision ?? "none",
          settings.activeQuantityId,
          settings.surfaceColorSource,
          surfaceMode ?? "none",
          settings.scalarColorPalette,
        ].join("|");
        const surfaceColors = memoizeViewport3DFdmSurfaceColors({
          build: () => {
            if (!model || !fieldVector || !surfaceMode) return null;
            const colors = buildFdmSampledScalarColors(
              fieldVector,
              model.cellIndices,
              domain.totalCells,
              surfaceMode,
              settings.scalarColorPalette,
            );
            return colors ? { ...colors, buildKey: surfaceColorKey } : null;
          },
          colorKey: surfaceColorKey,
          owner: domain,
        });
        const vectorsVisible =
          Boolean(model && fieldVector) &&
          settings.visible &&
          settings.vectorsVisible;
        const vectorCellIndices = vectorsVisible
          ? buildResult?.vectorCellIndices ?? null
          : null;
        const vectorGlyphColors =
          vectorsVisible && vectorCellIndices
            ? buildFdmSampledScalarColors(
                fieldVector,
                vectorCellIndices,
                domain.totalCells,
                settings.vectorColorMode,
                settings.scalarColorPalette,
              )
            : null;
        const vectorSegments = vectorsVisible
          ? buildResult?.vectorSegments ?? null
          : null;

        return {
          domain,
          fieldVector,
          model,
          settings,
          surfaceColors,
          target,
          vectorGlyphColors,
          vectorSegments,
        };
      });
    },
    [
      fdmMultilayerLayout.data,
      fdmNativeLayerDomains,
      fdmNativeLayerSettingsById,
      fdmSettings,
      fdmMultilayerCuboidBuildResults,
      nativeLayerFieldRequests,
      nativeLayerFieldVectors.data,
      nativeLayerFieldVectors.payloadRevisionByRequestId,
    ],
  );
  const fdmMultilayerAirboxView = useMemo<FdmMultilayerAirboxRenderView | null>(() => {
    if (!fdmMultilayerAirboxDomain || !airboxSettings.visible) return null;
    const buildResult = fdmMultilayerCuboidBuildResults.get("airbox")?.result;
    const model = buildResult?.model ?? null;
    const compatibleField = resolveFdmMultilayerAirboxFieldVector(
      fdmMultilayerAirboxDomain,
      fdmMultilayerAirboxField.data,
    );
    const fieldVector =
      compatibleField &&
      sameViewport3DQuantityId(airboxSettings.activeQuantityId, compatibleField.quantityId)
        ? compatibleField
        : null;
    const surfaceMode =
      model && fieldVector
        ? surfaceColorSourceToColorMode(airboxSettings.surfaceColorSource)
        : null;
    const surfaceColorKey = [
      "multilayer-airbox",
      String(fdmMultilayerAirboxField.payloadRevision ?? "missing"),
      model?.membershipRevision ?? "none",
      airboxSettings.activeQuantityId,
      airboxSettings.surfaceColorSource,
      surfaceMode ?? "none",
      airboxSettings.scalarColorPalette,
    ].join("|");
    const surfaceColors = memoizeViewport3DFdmSurfaceColors({
      build: () => {
        if (!model || !fieldVector || !surfaceMode) return null;
        const colors = buildFdmSampledScalarColors(
          fieldVector,
          model.cellIndices,
          fdmMultilayerAirboxDomain.totalCells,
          surfaceMode,
          airboxSettings.scalarColorPalette,
        );
        return colors ? { ...colors, buildKey: surfaceColorKey } : null;
      },
      colorKey: surfaceColorKey,
      owner: fdmMultilayerAirboxDomain,
    });
    const vectorsVisible = Boolean(model && fieldVector) && airboxSettings.vectorsVisible;
    const vectorCellIndices = vectorsVisible
      ? buildResult?.vectorCellIndices ?? null
      : null;
    const vectorGlyphColors = vectorsVisible && vectorCellIndices
      ? buildFdmSampledScalarColors(
          fieldVector,
          vectorCellIndices,
          fdmMultilayerAirboxDomain.totalCells,
          airboxSettings.vectorColorMode,
          airboxSettings.scalarColorPalette,
        )
      : null;
    return {
      domain: fdmMultilayerAirboxDomain,
      fieldVector,
      model,
      settings: airboxSettings,
      surfaceColors,
      target: AIRBOX_VISUALIZATION_TARGET,
      vectorGlyphColors,
      vectorSegments: vectorsVisible ? buildResult?.vectorSegments ?? null : null,
    };
  }, [
    airboxSettings,
    fdmMultilayerAirboxDomain,
    fdmMultilayerAirboxField.data,
    fdmMultilayerAirboxField.payloadRevision,
    fdmMultilayerCuboidBuildResults,
  ]);
  const fdmSurfaceColors =
    fdmTargetViews.find((view) => view.surfaceColors)?.surfaceColors ?? null;
  const fdmVectorColors =
    fdmTargetViews.find((view) => view.vectorColors)?.vectorColors ?? null;
  const fdmVectorGlyphColors =
    fdmTargetViews.find((view) => view.vectorGlyphColors)?.vectorGlyphColors ?? null;
  const fdmVectorSegments =
    fdmTargetViews.find((view) => view.vectorSegments)?.vectorSegments ?? null;
  const fdmAirboxVectorColors = useMemo(() => {
    if (!fdmAirboxVectorsVisible || !fdmAirboxFieldVector || !fdmAirboxInstanceModel) {
      return null;
    }
    return buildFdmSampledScalarColors(
      fdmAirboxFieldVector,
      fdmAirboxInstanceModel.cellIndices,
      fdmDomain?.totalCells ?? 0,
      fdmUniverseOutsideSupportSettings?.vectorColorMode ?? "orientation",
      fdmUniverseOutsideSupportSettings?.scalarColorPalette ?? "viridis",
    );
  }, [
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    fdmAirboxFieldVector,
    fdmAirboxInstanceModel,
    fdmAirboxVectorsVisible,
    fdmDomain?.totalCells,
    fdmUniverseOutsideSupportSettings?.scalarColorPalette,
    fdmUniverseOutsideSupportSettings?.vectorColorMode,
  ]);
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const fdmAirboxVectorGlyphColors = useMemo(() => {
    if (!fdmAirboxVectorColors || !fdmAirboxVectorCellIndices) return null;
    return buildFdmSampledScalarColors(
      fdmAirboxFieldVector,
      fdmAirboxVectorCellIndices,
      fdmDomain?.totalCells ?? 0,
      fdmAirboxVectorColors.colorMode,
      fdmAirboxVectorColors.colorPalette,
      fdmAirboxVectorColors.range,
    );
  }, [
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    fdmAirboxFieldVector,
    fdmAirboxVectorCellIndices,
    fdmAirboxVectorColors,
    fdmDomain?.totalCells,
  ]);
  const chunkedScalarColors = useViewport3DChunkedScalarColors({
    buildDomainId: "shared-domain",
    buildSessionId: "current",
    colorModes: primaryFieldRenderOptions.scalarColorModes,
    colorPalette:
      primaryFieldRenderOptions.scalarColorPalette ?? scalarColorPalette,
    enabled: primaryFieldRenderOptions.scalarColorsVisible !== false,
    fieldRevision: primaryFieldRevision,
    fieldScalarRangesByMode,
    fieldVector: committedFieldVector,
    partFieldVectors: fieldRenderOptionsWithPrimaryTargetBuffers.partFieldVectors,
    partTargetFieldBuffers:
      fieldRenderOptionsWithPrimaryTargetBuffers.partTargetFieldBuffers,
    partScalarColorModes:
      fieldRenderOptionsWithPrimaryTargetBuffers.partScalarColorModes,
    partScalarColorPalettes:
      fieldRenderOptionsWithPrimaryTargetBuffers.partScalarColorPalettes,
    partScalarRangesByMode:
      fieldRenderOptionsWithPrimaryTargetBuffers.partScalarRangesByMode,
    targetRenderPlans:
      fieldRenderOptionsWithPrimaryTargetBuffers.targetRenderPlans,
    targetVisualizationRevision: renderingState?.revision ?? null,
    topology: fieldCompatibleTopologyRenderModel,
    topologyRevision: topology.revision,
  });
  const fieldRenderModelBuildOptions = useMemo(
    () =>
      resolveViewport3DFieldRenderModelBuildOptions({
        complexFieldVector: analysisComplexField,
        fieldRenderOptions: fieldRenderOptionsWithPrimaryTargetBuffers,
        fieldVector: committedFieldVector,
        topology: fieldCompatibleTopologyRenderModel,
      }),
    [
      analysisComplexField,
      committedFieldVector,
      fieldCompatibleTopologyRenderModel,
      fieldRenderOptionsWithPrimaryTargetBuffers,
    ],
  );
  const fieldRenderModel = useMemo(() => {
    const model = measureViewport3DModelBuild(
      "fullmag.viewport3d.buildViewport3DFieldRenderModel",
      () =>
        buildViewport3DFieldRenderModel(
          fieldCompatibleTopologyRenderModel,
          committedFieldVector,
          vectorScale,
          {
            ...fieldRenderModelBuildOptions,
            buildDomainId: "shared-domain",
            buildSessionId: "current",
            complexFieldVector: analysisComplexField,
            fieldRevision: fieldVector.payloadRevision ?? fieldVector.revision,
            scalarRangesByMode: fieldScalarRangesByMode,
            targetVisualizationRevision: renderingState?.revision ?? null,
            topologyRevision: topology.revision,
            wavevectorKf: analysisOverlay?.wavevectorKf,
            cellOrigin: analysisOverlay?.cellOrigin,
            floquetSpatialConvention: analysisOverlay?.floquetSpatialConvention,
            phasorConvention: analysisOverlay?.phasorConvention,
          },
        ),
    );
    return mergeViewport3DFieldScalarColors(
      model,
      chunkedScalarColors.colors,
      vectorColorMode,
      chunkedScalarColors.colorsByPartAndMode,
    );
  }, [
    chunkedScalarColors.colors,
    chunkedScalarColors.colorsByPartAndMode,
    committedFieldVector,
    fieldCompatibleTopologyRenderModel,
    analysisComplexField,
    fieldRenderModelBuildOptions,
    fieldScalarRangesByMode,
    fieldVector.payloadRevision,
    fieldVector.revision,
    renderingState?.revision,
    topology.revision,
    vectorColorMode,
    vectorScale,
    analysisOverlay?.cellOrigin,
    analysisOverlay?.floquetSpatialConvention,
    analysisOverlay?.phasorConvention,
    analysisOverlay?.wavevectorKf,
  ]);
  const visualizationDebugTargets = useMemo(
    () =>
      viewportVisualizationTargets.map((target) => {
        const carrierIds = new Set(
          semanticTargetCatalog.byTargetId.get(target.id)?.carrierIds ?? [],
        );
        for (const [carrierId, regionTarget] of regionTargetByPartId) {
          if (regionTarget.id === target.id) carrierIds.add(carrierId);
        }
        return {
          carrierIds: Object.freeze([...carrierIds]),
          target,
        };
      }),
    [regionTargetByPartId, semanticTargetCatalog.byTargetId, viewportVisualizationTargets],
  );
  const visualizationDebugTopologyByteLength = useMemo(() => {
    const decoded = topology.data;
    if (!decoded) return null;
    return (
      decoded.boundaryFaces.byteLength +
      decoded.boundaryMarkers.byteLength +
      decoded.elementMarkers.byteLength +
      decoded.indices.byteLength +
      (decoded.cellNodes?.byteLength ?? 0) +
      (decoded.cellOffsets?.byteLength ?? 0) +
      (decoded.cellTypes?.byteLength ?? 0) +
      (decoded.facetNodes?.byteLength ?? 0) +
      (decoded.facetOffsets?.byteLength ?? 0) +
      (decoded.facetTypes?.byteLength ?? 0) +
      decoded.positions.byteLength
    );
  }, [topology.data]);
  const selectedLabel = selection.label ?? "No selection";
  const topologyFreshnessStatus = fdmLaneActive
    ? null
    : resolveViewport3DTopologyFreshnessLabel(topologyFreshness);
  const status =
    topology.error?.message ??
    fdmBuildState?.error?.message ??
    (renderingState?.clip?.enabled ? clipCrossSection.error?.message : null) ??
    (meshQualityOverlayVisible ? meshQualityData.error?.message : null) ??
    fieldVector.error?.message ??
    (fdmFieldCompatibility?.status === "mismatch"
      ? `FDM field degraded: ${fdmFieldCompatibility.reason}`
      : null) ??
    magneticPartFieldVectors.error?.message ??
    targetQuantityFieldVectors.error?.message ??
    airboxFieldVectors.error?.message ??
    scene.error?.message ??
    universe.error?.message ??
    domainMeta.error?.message ??
    sharedDomainManifest.error?.message ??
    visualizationState.error?.message ??
    topologyFreshnessStatus ??
    topology.status;
  const domainSummary = fdmDomain
    ? formatFdmDisplaySamplingSummary({
        budget: fdmDomain.displayCellBudget,
        displaySamples: fdmDomain.displayCellCount,
        stride: fdmDomain.stride,
        total: fdmDomain.totalCells,
      })
    : `${femDomain.magneticParts.length}+${femDomain.airboxParts.length}`;
  const buildDiagnosticsSnapshotVersion = useSyncExternalStore(
    (onStoreChange) =>
      subscribeViewport3DBuildDiagnostics(() => {
        onStoreChange();
      }),
    getViewport3DBuildDiagnosticsSnapshotVersion,
    getViewport3DBuildDiagnosticsSnapshotVersion,
  );
  const buildFallbackDiagnostics = useMemo(
    () => {
      void buildDiagnosticsSnapshotVersion;
      return getViewport3DBuildFallbackDiagnosticsSnapshot();
    },
    [buildDiagnosticsSnapshotVersion],
  );
  const buildPipelineDiagnostics = useMemo(
    () => {
      void buildDiagnosticsSnapshotVersion;
      return getViewport3DBuildPipelineDiagnosticsSnapshot();
    },
    [buildDiagnosticsSnapshotVersion],
  );
  const diagnostics = buildViewport3DDiagnostics({
    airboxPartCount: femDomain.airboxParts.length,
    buildFallbacks: buildFallbackDiagnostics,
    cache: getCacheStats(),
    dataPlaneIssues,
    fieldDemandDiagnostics,
    fieldPayloadRevision: fieldVector.payloadRevision ?? null,
    fieldRevision: fieldVector.payloadRevision ?? fieldVector.revision,
    fieldRequestedRevision: fieldVector.revision,
    fieldStatus: fieldVector.status,
    manifestCarrierDegradedCount:
      femDomain.renderCarrierDiagnostics?.degradedCarrierCount,
    manifestCarrierKind: femDomain.renderCarrierDiagnostics?.kind,
    manifestCarrierRejectedCount:
      femDomain.renderCarrierDiagnostics?.rejectedCarrierCount,
    objectCount: fdmLaneActive
      ? fdmTargetViews.length
      : femDomain.objectPartIds.size,
    pipelineDiagnostics: buildPipelineDiagnostics,
    quantityId: primaryFieldQuantityId,
    surfaceColorStatus: chunkedScalarColors.status,
    targetDiagnostics: fieldRenderModel?.targetDiagnostics,
    topologyRevision: topology.revision,
    tracker: resourceCounts,
  });
  const hslReferenceVisible = resolveHslReferenceVisible(
    commandState.widgets.hslReferenceMode,
    vectorColorMode,
  );
  const resourceFrameKey = buildViewport3DResourceFrameKey([
    {
      error: topology.error?.message,
      id: "topology",
      revision: topology.revision,
      status: topology.status,
    },
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(fieldVector.data),
      error: fieldVector.error?.message,
      id: "field-vector",
      materializationState: primaryMagnitudeFieldMeta.data?.state ?? null,
      payloadRevision: fieldVector.payloadRevision ?? null,
      revision: fieldVector.revision,
      status: fieldVector.status,
    }),
    {
      error: fdmBuildState?.error?.message ?? null,
      id: "fdm-cuboid-build",
      revision: fdmBuildState?.buildKey ?? null,
      status:
        fdmBuildState?.status === "pending"
          ? "loading"
          : fdmBuildState?.status ?? "idle",
    },
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(magneticPartFieldVectors.data?.size),
      error: magneticPartFieldVectors.error?.message,
      id: "magnetic-part-field-vectors",
      payloadRevision: magneticPartFieldVectors.payloadRevision ?? null,
      revision: magneticPartFieldVectors.revision,
      status: magneticPartFieldVectors.status,
    }),
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(targetQuantityFieldVectors.data?.size),
      error: targetQuantityFieldVectors.error?.message,
      id: "target-quantity-field-vectors",
      payloadRevision: targetQuantityFieldVectors.payloadRevision ?? null,
      revision: targetQuantityFieldVectors.revision,
      status: targetQuantityFieldVectors.status,
    }),
    resolveViewport3DResourceFrameState({
      dataAvailable: Boolean(airboxFieldVectors.data?.size),
      error: airboxFieldVectors.error?.message,
      id: "airbox-field-vectors",
      payloadRevision: airboxFieldVectors.payloadRevision ?? null,
      revision: airboxFieldVectors.revision,
      status: airboxFieldVectors.status,
    }),
    {
      error: meshQualityOverlayVisible
        ? meshQualityData.error?.message
        : undefined,
      id: "mesh-quality-data",
      revision: meshQualityOverlayVisible ? meshQualityData.revision : null,
      status: meshQualityOverlayVisible ? meshQualityData.status : "idle",
    },
    {
      error: renderingState?.clip?.enabled
        ? clipCrossSection.error?.message
        : undefined,
      id: "clip-cross-section",
      revision: renderingState?.clip?.enabled ? clipCrossSection.revision : null,
      status: renderingState?.clip?.enabled ? clipCrossSection.status : "idle",
    },
    {
      error: modelRegions.error?.message,
      id: "model-regions",
      revision: modelRegions.revision,
      status: modelRegions.status,
    },
    {
      error: regionMemberships.error?.message,
      id: "region-memberships",
      revision: regionMemberships.revision,
      status: regionMemberships.status,
    },
    {
      error:
        fdmRegionMembership.error?.message ??
        fdmRegionMembershipBinary.error?.message,
      id: "fdm-region-membership",
      revision:
        fdmRegionMembershipBinary.revision ?? fdmRegionMembership.revision,
      status:
        fdmRegionMembershipBinary.status === "idle" &&
        fdmRegionMembership.status !== "idle"
          ? fdmRegionMembership.status
          : fdmRegionMembershipBinary.status,
    },
    {
      error: scene.error?.message,
      id: "scene",
      revision: scene.revision,
      status: scene.status,
    },
    {
      error: domainMeta.error?.message,
      id: "domain-meta",
      revision: domainMeta.revision,
      status: domainMeta.status,
    },
    {
      error: sharedDomainManifest.error?.message,
      id: "shared-domain-manifest",
      revision: sharedDomainManifest.revision,
      status: sharedDomainManifest.status,
    },
    {
      error: universe.error?.message,
      id: "universe",
      revision: universe.revision,
      status: universe.status,
    },
    {
      error: visualizationState.error?.message,
      id: "visualization-state",
      revision: visualizationState.revision,
      status: visualizationState.status,
    },
  ]);
  const visualizationDebugSource = useMemo(
    () => ({
      carrierRoles: new Map(
        [...femDomain.partsById].map(([carrierId, part]) => [
          carrierId,
          part.role,
        ]),
      ),
      fieldModel: fieldRenderModel,
      fullFieldBufferIdentity: fdmFieldVector
        ? {
            bufferId: `decoded:${fdmFieldVector.quantityId}:${fdmFieldVector.pointCount}:${fdmFieldVector.values.byteLength}`,
            currentDomainGenerationId: fdmDomainGenerationId,
            resourceKey:
              sameViewport3DQuantityId(
                fdmSettings.activeQuantityId,
                primaryFieldQuantityId,
              )
                ? fieldVectorResourceKey
                : null,
          }
        : null,
      fullFieldVector: fdmDomain ? fdmFieldVector ?? null : null,
      targets: visualizationDebugTargets,
      topologyByteLength: visualizationDebugTopologyByteLength,
      visualizationRevision:
        renderingState?.revision == null ? null : String(renderingState.revision),
      webglSharedByteLength: null,
    }),
    [
      fdmDomain,
      // eslint-disable-next-line react-hooks/preserve-manual-memoization
      fdmDomainGenerationId,
      // eslint-disable-next-line react-hooks/preserve-manual-memoization
      fdmFieldVector,
      fdmSettings.activeQuantityId,
      femDomain.partsById,
      fieldRenderModel,
      fieldVectorResourceKey,
      primaryFieldQuantityId,
      renderingState?.revision,
      visualizationDebugTargets,
      visualizationDebugTopologyByteLength,
    ],
  );

  return {
    airboxSettings,
    availableQuantityIds: availableQuantityIdsForPlanning,
    bounds,
    cameraOrthographicScale: cameraView.cameraOrthographicScale,
    cameraProjection: cameraView.cameraProjection,
    cameraResource,
    cameraState: cameraView.cameraState,
    clip: renderingState?.clip ?? null,
    clipFrameRotationDegrees: 0,
    clipIntersectionMarkers,
    crossSectionFrameClip,
    crossSectionFrameRotationDegrees:
      crossSectionFramePreview?.rotationDegrees ?? 0,
    planarMonitorFramePreview,
    diagnostics,
    domainId: domainMeta.data?.domain_id,
    domainSummary,
    fallbackSettings,
    fdmLaneActive,
    fdmFieldIdentityCompatible:
      resolveViewport3DFdmFieldIdentityCompatible({
        fdmFieldCompatibilityStatus: fdmFieldCompatibility?.status ?? null,
        fdmLaneActive,
      }),
    fdmDomain,
    fdmRegionMembership: fdmRegionMembership.data,
    fdmRegionMembershipBinary: fdmRegionMembershipBinary.data,
    fdmAirboxInstanceModel,
    fdmAirboxPassPlan,
    fdmAirboxFieldVector,
    fdmAirboxVectorSegments,
    fdmAirboxVectorGlyphColors,
    fdmInstanceModel: fdmInstanceModel,
    fdmUniverseOutsideSupport,
    fdmUniverseOutsideSupportSettings,
    fdmSettings,
    fdmMultilayerAirboxView,
    fdmNativeLayerViews,
    fdmTargetViews,
    fdmSurfaceColors,
    fdmVectorColors,
    fdmVectorGlyphColors,
    fdmAirboxVectorColors,
    fdmVectorSegments,
    femDomain,
    fieldDataIssue,
    fieldRefresh,
    fieldModel: fieldRenderModel,
    fieldVector: fdmFieldVector,
    getObjectSettings,
    getPartSettings,
    getRegionSettings,
    hysteresisReplayGlyphModel,
    hslReferenceVisible,
    hysteresisReplayTarget,
    magnetizationTexturePreviews,
    maxVectorGlyphs: clampViewport3DInteractiveVectorBudget(
      fdmSettings.vectorBudget,
      maxInteractiveVectorGlyphs,
    ),
    meshQualityColors,
    meshQualityMetric,
    meshQualityOverlayVisible,
    meshRegionOverlayParts,
    periodicOverlayModel,
    meshSizeHighlightModel,
    meshQualityRange: meshQualityColors?.range ?? null,
    meshRegionOverlays,
    primitiveModel,
    quantityId: primaryFieldQuantityId,
    regionOverlays,
    resourceFrameKey,
    selectedLabel,
    selectedObjectId,
    selectedRegionId,
    selectionBounds,
    scalarColorPalette,
    semanticTargetCatalog,
    status,
    renderedMeshRevision: topologyRenderModelForGeometry?.meshRevision ?? null,
    topology: topology.data,
    topologyRevision: topology.revision,
    visualizationDebugSource,
    topologyFreshness,
    topologyModel: topologyRenderModelForGeometry,
    vectorColorMode,
    vectorScale: fdmVectorScale,
    vectorStyle,
    visualizationEffectiveRenderMode,
    visualizationError,
    visualProfileId: commandState.visualProfileId,
    visualizationRevision,
  };
}


function measureViewport3DModelBuild<T>(name: string, build: () => T): T {
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
      // Gracefully ignore measurement errors to prevent crashing the UI
    }
    performanceTarget.clearMarks?.(startMark);
    performanceTarget.clearMarks?.(endMark);
  }
}
