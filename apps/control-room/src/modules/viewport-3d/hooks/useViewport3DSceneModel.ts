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
  isMagneticOnlyQuantityId,
  isScalarSpatialQuantityId,
  resolveCanonicalQuantityId,
  sameQuantityId,
} from "@/kernel/api/quantityIds";
import { useCrossSectionResource } from "@/kernel/resources/crossSectionResources";
import {
  useMeshRegionMembershipsResource,
  useModelRegionsResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  resolveFieldMetaResourceKey,
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
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import {
  activeCrossSectionFramePreview,
  crossSectionFramePreviewEquals,
  crossSectionFramePreviewToClip,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveDefaultVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
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
  mergeViewport3DFieldScalarColors,
  resolveViewport3DChunkedFieldColorTarget,
  useViewport3DChunkedScalarColors,
} from "./useViewport3DChunkedScalarColors";
import { useViewport3DTopologyIndexBundle } from "./useViewport3DTopologyIndexBundle";
import {
  useViewport3DFieldRenderOptions,
  clampViewport3DInteractiveVectorBudget,
  limitViewport3DFieldRenderVectorBudgets,
  viewport3DAirboxVectorsVisible,
} from "./useViewport3DFieldRenderOptions";
import {
  buildHysteresisReplayGlyphModel,
  resolveHysteresisReplayMeshCompatibility,
  resolveHysteresisStepViewportTarget,
  resolveViewport3DSelectionBounds,
  targetForFdmDomain,
  targetForMeshPart,
  type HysteresisReplayGlyphModel,
  type HysteresisReplayMeshCompatibility,
} from "../model/viewport3DTargets";
import {
  buildViewport3DTargetRenderPlan,
  buildViewport3DFieldResourceRequestId,
  mergeViewport3DFieldVectorQueries,
  resolveViewport3DAirboxFieldVectorDemandPlan,
  resolveViewport3DPrimaryFieldDemandPlan,
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
  useFdmCuboidBuildResult,
  type FdmCuboidInstanceModel,
} from "../layers/FdmCuboidLayer";
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
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
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
  buildSampledScalarColors,
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
import {
  getViewport3DCacheStats as getCacheStats,
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
} from "../viewport3dTopologyStaleness";
import {
  resolveHslReferenceVisible,
  resolveViewport3DCameraOrthographicScale,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3DCameraViewSignature,
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
  topology,
  topologyRevision = null,
}: {
  fieldRenderOptions: Viewport3DFieldRenderOptions;
  fieldRevision?: string | null;
  fieldVector: DecodedFieldVector | null;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  primaryFieldQuantityId: string;
  primaryFieldRequest: Viewport3DFieldResourceRequest;
  topology:
    | Pick<
        Viewport3DTopologyRenderModel<Viewport3DMeshPart>,
        "magneticParts"
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
    if (
      !settings.visible ||
      (!settings.shaderVisible && !settings.vectorsVisible) ||
      !sameViewport3DQuantityId(settings.activeQuantityId, primaryFieldQuantityId)
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
        query: primaryFieldRequest.query,
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
        "airboxParts" | "magneticParts" | "nodeCount"
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
        query: request.query,
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
          fieldVector,
          query: {
            component: "full",
            scope_id: partId,
            scope_kind: "airbox",
          },
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
    };
  }

  const legacyFieldVector = fieldVectors.get(canonicalQuantityId) ?? null;
  return legacyFieldVector
    ? {
        fieldVector: legacyFieldVector,
        request: null,
      }
    : null;
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
    resolveRevision: (data) =>
      Array.from(data)
        .map(([partId, ranges]) => {
          const range = ranges.values().next().value as ScalarRange | undefined;
          return range ? `${partId}:${range.min}:${range.max}` : `${partId}:none`;
        })
        .join("|") || null,
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
      if (owner) keys.add(regionOverlayKey(owner, regionId));
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
  const authoredByRegionId = new Map<string, RegionOverlayInput>();
  for (const region of regions) {
    const regionId = asNonEmptyString(region.region_id);
    if (regionId) {
      authoredByRegionId.set(regionId, region);
    }
  }

  const overlayRegions: RegionOverlayInput[] = [];
  const ownerParts: RegionMeshOverlayOwnerPart[] = [];
  const seen = new Set<string>();
  for (const membership of memberships) {
    const regionId = asNonEmptyString(membership.region_id);
    if ((membership.mesh_part_ids ?? []).some((partId) => asNonEmptyString(partId))) {
      continue;
    }
    const authored = regionId ? authoredByRegionId.get(regionId) : null;
    const objectId = asNonEmptyString(authored?.owner_object_id);
    if (!regionId || !authored || !objectId || seen.has(regionId)) {
      continue;
    }

    const syntheticPartId = `membership:${encodeURIComponent(regionId)}`;
    seen.add(regionId);
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
    let objectId: string | null = null;
    for (const sourceObjectId of region.source_object_ids ?? []) {
      objectId = asNonEmptyString(sourceObjectId);
      if (objectId) break;
    }
    if (!objectId) continue;
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

export function resolveViewport3DPartVisualizationSettings({
  objectVisualizationSnapshot,
  part,
  regionTarget,
  renderingState,
}: {
  objectVisualizationSnapshot: ObjectVisualizationSnapshot;
  part: Viewport3DMeshPart;
  regionTarget?: VisualizationTargetRef | null;
  renderingState?: VisualizationStateResource | null;
}): VisualizationTargetSettings {
  const objectTarget = targetForMeshPart(part);
  const objectVisualization = resolveTargetVisualization({
    snapshot: objectVisualizationSnapshot,
    target: objectTarget,
    visualizationState: renderingState,
  });
  if (!regionTarget) return objectVisualization.effectiveSettings;
  return resolveTargetVisualization({
    inheritedSettings: objectVisualization.settings,
    snapshot: objectVisualizationSnapshot,
    target: regionTarget,
    visualizationState: renderingState,
  }).effectiveSettings;
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

  if (!(fieldVectorEnabled && fieldVectorErrorMessage)) return null;
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
      visiblePayloadAvailable && status === "stale" ? "ready" : status,
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
  maxSamples,
  surfaceColorMode,
  vectorsVisible,
}: {
  maxSamples: number;
  surfaceColorMode: string | null;
  vectorsVisible: boolean;
}): FieldVectorQuery {
  return resolveViewport3DScopedFieldQuery({
    maxSamples,
    surfaceColorMode,
    vectorsVisible,
  });
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
          shaderMonoColor: settings.shaderMonoColor ?? "#ffffff",
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
  fdmSettings,
  getPartSettings,
  magneticPartScopedFieldIds,
  magneticParts,
  maxVectorGlyphs,
  primaryFieldQuantityId,
  selectedSnapshotQuery,
}: {
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
  "object",
  "part",
  "region",
];

function selectViewport3DObjectVisualizationSnapshot(
  snapshot: ObjectVisualizationSnapshot,
  targets: readonly VisualizationTargetRef[],
): ObjectVisualizationSnapshot {
  const defaults: ObjectVisualizationSnapshot["defaults"] = {};
  const overrides: ObjectVisualizationSnapshot["overrides"] = {};

  for (const kind of VIEWPORT_3D_VISUALIZATION_TARGET_KINDS) {
    const defaultPatch = snapshot.defaults[kind];
    if (defaultPatch) {
      defaults[kind] = defaultPatch;
    }
  }

  for (const target of targets) {
    const key = visualizationTargetKey(target);
    const override = snapshot.overrides[key];
    if (override) {
      overrides[key] = override;
    }
  }

  return { defaults, overrides, version: snapshot.version };
}

function viewport3DObjectVisualizationSnapshotEquals(
  previous: ObjectVisualizationSnapshot,
  next: ObjectVisualizationSnapshot,
): boolean {
  for (const kind of VIEWPORT_3D_VISUALIZATION_TARGET_KINDS) {
    if (!visualizationTargetPatchEquals(previous.defaults[kind], next.defaults[kind])) {
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
  commandState,
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
    cameraOrthographicScale: commandState.widgets.cameraOrthographicScale,
    cameraProjection: commandState.widgets.cameraProjection,
    cameraResource: cameraRegistryCamera,
    cameraState: commandState.camera,
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
  useViewport3DCameraRegistryStoreSync(cameraResource);
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
  const modelRegions = useModelRegionsResource({
    enabled: Boolean(scene.data),
  });
  const universe = useViewport3DUniverse();
  const sharedDomainManifest = useViewport3DSharedDomainManifest();
  const sharedDomainTopologyFingerprint =
    sharedDomainManifest.data?.topology_fingerprint ?? null;
  const unknownTopologyProvenanceRefreshRef = useRef<string | null>(null);
  const topology = useViewport3DDomainTopology();
  const fdmDomain = useMemo(
    () => adaptFdmDomainMeta(domainMeta.data, 120_000),
    [domainMeta.data],
  );
  const femDomain = useMemo(
    () => adaptFemSharedDomainManifest(sharedDomainManifest.data),
    [sharedDomainManifest.data],
  );
  const topologyIndexBundle = useViewport3DTopologyIndexBundle({
    airboxParts: femDomain.airboxParts,
    enabled: Boolean(topology.data),
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
  const regionTargetByPartId = useMemo(() => {
    return resolveViewport3DRegionTargetByPartId(sharedDomainManifest.data?.regions);
  }, [sharedDomainManifest.data?.regions]);
  const meshBackedRegionKeys = useMemo(
    () => resolveViewport3DMeshBackedRegionKeys(sharedDomainManifest.data?.regions),
    [sharedDomainManifest.data?.regions],
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
  }, [scene.data, sharedDomainManifest]);
  const topologyCurrent = isViewport3DTopologyCurrent(topologyFreshness);
  const topologyRenderable = isViewport3DTopologyRenderable(topologyFreshness);
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
  const regionOverlays = allRegionOverlays;
  const currentTopologyRenderModel = topologyRenderable ? topologyRenderModel : null;
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
  const meshQualityData = useViewport3DMeshQualityData(
    Boolean(currentTopologyRenderModel && meshQualityOverlayVisible),
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
                currentTopologyRenderModel,
                femDomain,
                meshSizeHighlight,
                meshSizeHighlightSelection
                  ? { elementIndices: meshSizeHighlightSelection.element_indices }
                  : null,
              ),
          )
        : null,
    [
      currentTopologyRenderModel,
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
  const topologyBounds = useMemo(
    () => (topologyCurrent ? resolveTopologyBounds(topology.data) : null),
    [topology.data, topologyCurrent],
  );
  const resourceBounds =
    topologyBounds ??
    resolveDomainBounds(domainMeta.data) ??
    resolveUniverseBounds(universe.data);
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
      resolveViewport3DSelectionBounds(selection, femDomain, bounds),
    [selection, allRegionOverlays, primitiveModel, femDomain, bounds],
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

    for (const object of primitiveModel.objects) {
      pushViewportVisualizationTarget(targets, seen, {
        id: visualizationTargetIdForSceneObject(object.objectId),
        kind: "object",
        label: object.label,
      });
    }

    for (const part of femDomain.magneticParts) {
      pushViewportVisualizationTarget(targets, seen, targetForMeshPart(part));
    }
    for (const part of femDomain.airboxParts) {
      pushViewportVisualizationTarget(targets, seen, targetForMeshPart(part));
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
    femDomain.airboxParts,
    femDomain.magneticParts,
    primitiveModel.objects,
    regionTargetByPartId,
    allRegionOverlays,
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
    return resolveTargetVisualization({
      snapshot: objectVisualizationSnapshot,
      target: fdmTarget,
      visualizationState: renderingState,
    }).effectiveSettings;
  }, [
    domainMeta.data?.domain_id,
    fallbackSettings,
    fdmDomain,
    objectVisualizationSnapshot,
    renderingState,
  ]);
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
  const airboxQuantityCompatible = !isMagneticOnlyQuantityId(
    airboxSettings.activeQuantityId,
  );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      applyAnalysisOverlayAppearance(
        resolveViewport3DPartVisualizationSettings({
          objectVisualizationSnapshot,
          part,
          regionTarget: regionTargetByPartId.get(part.id),
          renderingState,
        }),
        analysisOverlay?.appearance,
      ),
    [
      analysisOverlay?.appearance,
      objectVisualizationSnapshot,
      regionTargetByPartId,
      renderingState,
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
        visualizationState: renderingState,
      }).effectiveSettings,
    [objectVisualizationSnapshot, renderingState],
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
        visualizationState: renderingState,
      }).settings;
      return resolveTargetVisualization({
        inheritedSettings: objectSettings,
        snapshot: objectVisualizationSnapshot,
        target: {
          id: visualizationTargetIdForSceneObject(objectId, regionId),
          kind: "region",
          label: region.name ?? regionId,
        },
        visualizationState: renderingState,
      }).effectiveSettings;
    },
    [fallbackSettings, objectVisualizationSnapshot, renderingState],
  );
  const airboxVectorsVisible = viewport3DAirboxVectorsVisible(
    airboxSettings.visible,
    airboxSettings.vectorsVisible,
    airboxQuantityCompatible,
    vectorDomain,
  );
  const airboxSurfaceColorMode =
    airboxQuantityCompatible &&
    airboxSettings.visible &&
    airboxSettings.shaderVisible
      ? surfaceColorSourceToColorMode(airboxSettings.surfaceColorSource)
      : null;
  const airboxFieldVectorEnabled = Boolean(
    (airboxVectorsVisible && !airboxSettings.airboxSyntheticVectorsEnabled) ||
      airboxSurfaceColorMode,
  );
  const airboxFieldVectorParts = useMemo(
    () =>
      currentTopologyRenderModel?.airboxParts.map((partModel) => partModel.part) ??
      EMPTY_AIRBOX_FIELD_VECTOR_PARTS,
    [currentTopologyRenderModel],
  );
  const airboxFieldQuery = useMemo(
    () =>
      resolveViewport3DScopedVectorFieldQuery({
        maxSamples: clampViewport3DInteractiveVectorBudget(
          airboxSettings.vectorBudget,
          maxInteractiveVectorGlyphs,
        ),
        surfaceColorMode: airboxSurfaceColorMode,
        vectorsVisible: airboxVectorsVisible,
      }),
    [
      airboxSettings.vectorBudget,
      airboxSurfaceColorMode,
      airboxVectorsVisible,
      maxInteractiveVectorGlyphs,
    ],
  );
  const airboxFieldDemandPlan = useMemo(
    () =>
      resolveViewport3DAirboxFieldVectorDemandPlan({
        airboxParts: airboxFieldVectorParts,
        fieldQuery: airboxFieldQuery,
        quantityId: airboxSettings.activeQuantityId,
        replayQuery: selectedSnapshotQuery,
        shaderVisible: Boolean(airboxSurfaceColorMode),
        surfaceColorSource: airboxSettings.surfaceColorSource,
        vectorBudget: clampViewport3DInteractiveVectorBudget(
          airboxSettings.vectorBudget,
          maxInteractiveVectorGlyphs,
        ),
        vectorsVisible: airboxVectorsVisible,
      }),
    [
      airboxFieldQuery,
      airboxFieldVectorParts,
      airboxSettings.activeQuantityId,
      airboxSettings.surfaceColorSource,
      airboxSettings.vectorBudget,
      airboxSurfaceColorMode,
      airboxVectorsVisible,
      maxInteractiveVectorGlyphs,
      selectedSnapshotQuery,
    ],
  );
  const airboxFieldVectorRequests = airboxFieldDemandPlan.requests;
  const fdmSurfaceColorMode =
    fdmDomain && fdmSettings.visible && fdmSettings.shaderVisible
      ? surfaceColorSourceToColorMode(fdmSettings.surfaceColorSource)
      : null;
  const magneticPartFieldDemandPlan = useMemo(
    () =>
      resolveViewport3DScopedPartVectorFieldDemandPlan({
        getPartSettings: (part) => getPartSettings(part as Viewport3DMeshPart),
        maxVectorGlyphs: maxInteractiveVectorGlyphs,
        magneticParts: currentTopologyRenderModel?.magneticParts ?? [],
        selectedSnapshotQuery,
        vectorDomain,
      }),
    [
      currentTopologyRenderModel?.magneticParts,
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
    if (!currentTopologyRenderModel) {
      return {
        demands: [],
        requests: new Map<string, Viewport3DFieldResourceRequest>(),
      };
    }
    return resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmSettings,
      getPartSettings: (part) => getPartSettings(part as Viewport3DMeshPart),
      magneticPartScopedFieldIds,
      magneticParts: currentTopologyRenderModel.magneticParts,
      maxVectorGlyphs: maxInteractiveVectorGlyphs,
      primaryFieldQuantityId,
      selectedSnapshotQuery,
    });
  }, [
    currentTopologyRenderModel,
    fdmSettings,
    getPartSettings,
    magneticPartScopedFieldIds,
    maxInteractiveVectorGlyphs,
    primaryFieldQuantityId,
    selectedSnapshotQuery,
  ]);
  const targetQuantityFieldRequests = targetQuantityFieldDemandPlan.requests;
  const fieldUpdateHoldActive = useViewport3DFieldUpdateHoldActive();
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
    topologyRenderModel: currentTopologyRenderModel,
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
      currentTopologyRenderModel
        ? limitViewport3DFieldRenderVectorBudgets(
            {
              ...resolveViewport3DPrimaryFieldRenderOptions({
                analysisOverlayAppearance: analysisOverlay?.appearance,
                analysisOverlayActive: Boolean(analysisOverlay),
                fieldRenderOptions,
                getPartSettings,
                magneticParts: currentTopologyRenderModel.magneticParts,
                quantityId: primaryFieldQuantityId,
                vectorDomain,
              }),
              visualizationPhaseRad:
                analysisOverlay?.visualizationPhaseRad ??
                analysisOverlay?.query.phase_rad ??
                null,
            },
            currentTopologyRenderModel,
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
      currentTopologyRenderModel,
      fieldRenderOptions,
      getPartSettings,
      maxInteractiveVectorGlyphs,
      primaryFieldQuantityId,
      vectorDomain,
    ],
  );
  const primaryFieldVectorBudgetExclusions = useMemo(() => {
    const excludedPartIds = new Set<string>();
    for (const partModel of currentTopologyRenderModel?.airboxParts ?? []) {
      excludedPartIds.add(partModel.part.id);
    }
    for (const partId of magneticPartScopedFieldIds) {
      excludedPartIds.add(partId);
    }
    if (!analysisOverlay) {
      for (const partModel of currentTopologyRenderModel?.magneticParts ?? []) {
        const settings = getPartSettings(partModel.part);
        if (!sameViewport3DQuantityId(settings.activeQuantityId, primaryFieldQuantityId)) {
          excludedPartIds.add(partModel.part.id);
        }
      }
    }
    return excludedPartIds;
  }, [
    analysisOverlay,
    currentTopologyRenderModel?.airboxParts,
    currentTopologyRenderModel?.magneticParts,
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
        magneticParts: currentTopologyRenderModel?.magneticParts ?? [],
        selectedSnapshotQuery,
      }),
    [
      currentTopologyRenderModel?.magneticParts,
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
          topology: currentTopologyRenderModel,
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
      currentTopologyRenderModel,
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
    fdmDomain && fdmSettings.visible && fdmSettings.shaderVisible
      ? visualProfile.voxelMagnitudeThreshold
      : 0;
  const fdmTopographyEnabled = Boolean(
    fdmDomain &&
      fdmSettings.visible &&
      fdmSettings.shaderVisible &&
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
    fdmDomain && fdmSettings.visible && fdmSettings.vectorsVisible,
  );
  const fdmInstanceModelEnabled = Boolean(
    fdmDomain &&
      fdmSettings.visible &&
      (fdmSettings.shaderVisible || fdmSettings.wireframeVisible || fdmVectorsVisible),
  );
  const fdmInstanceModelNeedsFieldVector =
    fdmVoxelMagnitudeThreshold > 0 || fdmTopographyEnabled;
  const primaryFieldVectorEnabled =
    Boolean(analysisOverlay) ||
    resolveViewport3DPrimaryFieldVectorEnabled({
      fdmInstanceModelNeedsFieldVector,
      fdmSurfaceColorMode,
      fdmVectorsVisible,
      fieldRenderOptions: primaryFieldDataOptions,
      selectedSnapshotId,
    });
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
        fdmVectorsVisible,
        fieldRenderOptions: primaryFieldDataOptions,
        primaryFieldQuantityId,
        snapshotId: selectedSnapshotId,
        snapshotQuery: selectedSnapshotQuery,
      });
    },
    [
      analysisOverlay,
      fdmInstanceModelNeedsFieldVector,
      fdmSurfaceColorMode,
      fdmTopographyEnabled,
      fdmVectorsVisible,
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
        currentTopologyRenderModel,
      ),
    [
      currentTopologyRenderModel,
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
  const primaryMagnitudeFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "magnitude",
    ),
    enabled: scalarRangeStatsEnabled && scalarRangeModeFlags.magnitude,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const primaryXFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "x",
    ),
    enabled: scalarRangeStatsEnabled && scalarRangeModeFlags.x,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const primaryYFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "y",
    ),
    enabled: scalarRangeStatsEnabled && scalarRangeModeFlags.y,
    quantityId: primaryFieldQuantityId,
    snapshot_id: selectedSnapshotQuery?.snapshot_id ?? null,
    stage_id: selectedSnapshotQuery?.stage_id ?? null,
  });
  const primaryZFieldMeta = useFieldMetaResource({
    component: resolveViewport3DFieldMetaScalarComponent(
      primaryFieldQuantityId,
      "z",
    ),
    enabled: scalarRangeStatsEnabled && scalarRangeModeFlags.z,
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
    return entries.length > 0 ? new Map(entries) : undefined;
  }, [
    primaryMagnitudeFieldMeta.data,
    primaryXFieldMeta.data,
    primaryYFieldMeta.data,
    primaryZFieldMeta.data,
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
  const analysisComplexFieldVector = useViewport3DFieldVector(
    primaryFieldQuantityId,
    analysisComplexFieldQuery,
    Boolean(analysisOverlay) && fieldVectorEnabled,
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
      hysteresisReplayMeshCompatibility,
      primaryFieldQuantityId,
    });
  }, [
    fieldVector.error,
    fieldVector.refetch,
    fieldVector.revision,
    fieldVectorEnabled,
    fieldVectorResourceKey,
    hysteresisReplayMeshCompatibility,
    primaryFieldQuantityId,
  ]);
  const fieldRefresh = useMemo<Viewport3DFieldRefreshState>(
    () => ({
      enabled: computeRunning && fieldVectorEnabled,
      quantityId: primaryFieldQuantityId,
      resourceKey: fieldVectorResourceKey,
      revision: fieldVector.revision,
      status: fieldVector.status,
    }),
    [
      computeRunning,
      fieldVector.revision,
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
        topology: currentTopologyRenderModel,
        topologyRevision:
          topology.revision == null ? null : String(topology.revision),
      }),
    [
      committedFieldVector,
      currentTopologyRenderModel,
      getPartSettings,
      primaryFieldQuantityId,
      primaryFieldRequest,
      primaryFieldRevision,
      resolvedFieldRenderOptions,
      topology.revision,
    ],
  );
  const analysisComplexField = useMemo(
    () => asDecodedComplexFieldVector(analysisComplexFieldVector.data),
    [analysisComplexFieldVector.data],
  );
  const fdmFieldVector =
    sameViewport3DQuantityId(fdmSettings.activeQuantityId, primaryFieldQuantityId)
      ? committedFieldVector
      : targetQuantityFieldVectors.data
        ? resolveViewport3DTargetQuantityFieldVectorForTarget({
            fieldVectors: targetQuantityFieldVectors.data,
            quantityId: fdmSettings.activeQuantityId,
            requests: targetQuantityFieldRequests,
            targetId: "fdm-domain",
          })?.fieldVector ?? null
        : null;
  const fdmFieldRevision =
    sameViewport3DQuantityId(fdmSettings.activeQuantityId, primaryFieldQuantityId)
      ? fieldVector.payloadRevision ?? fieldVector.revision
      : targetQuantityFieldVectors.payloadRevision ??
        targetQuantityFieldVectors.revision;
  const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector
    ? fdmFieldVector
    : null;
  const fdmMaxVectorGlyphs = clampViewport3DInteractiveVectorBudget(
    fdmSettings.vectorBudget,
    maxInteractiveVectorGlyphs,
  );
  const fdmVectorAnchorMode = fdmSettings.vectorCenteringEnabled
    ? "center"
    : "tail";
  const fdmBuildTopologyRevision =
    domainMeta.revision == null ? null : String(domainMeta.revision);
  const fdmBuildFieldRevision =
    fdmInstanceModelNeedsFieldVector || fdmVectorsVisible
      ? fdmFieldRevision == null
        ? null
        : String(fdmFieldRevision)
      : null;
  const fdmBuildTargetRevision =
    renderingState?.revision == null ? null : String(renderingState.revision);
  const fdmBuildSamplingRevision = fdmDomain
    ? `shape=${fdmDomain.shape.join("x")}|display=${fdmDomain.displayCellCount}|total=${fdmDomain.totalCells}|stride=${fdmDomain.stride}`
    : "none";
  const fdmBuildStyleRevision = [
    `fill=${visualProfile.voxelFillRatio}`,
    `threshold=${fdmVoxelMagnitudeThreshold}`,
    `topography=${fdmVoxelTopography.enabled}:${fdmVoxelTopography.component}:${fdmVoxelTopography.amplitudeCells}`,
    `vectors=${fdmVectorsVisible}:${fdmMaxVectorGlyphs}:${fdmVectorScale}:${fdmVectorAnchorMode}`,
  ].join("|");
  const fdmBuildKey = fdmInstanceModelEnabled
    ? buildViewport3DFdmCuboidJobKey({
        algorithmVersion: 1,
        component: fdmVectorsVisible ? "full" : null,
        domainId: domainMeta.data?.domain_id ?? "shared-domain",
        fieldRevision: fdmBuildFieldRevision,
        quantityId: resolveCanonicalQuantityId(fdmSettings.activeQuantityId),
        samplingRevision: fdmBuildSamplingRevision,
        scopeId: "full",
        scopeKind: "full",
        sessionId: "current",
        styleRevision: fdmBuildStyleRevision,
        targetVisualizationRevision: fdmBuildTargetRevision ?? "unknown",
        topologyRevision: fdmBuildTopologyRevision,
      })
    : null;
  const fdmBuildGroupKey = fdmInstanceModelEnabled
    ? `fdm-cuboid:session=current:domain=${domainMeta.data?.domain_id ?? "shared-domain"}`
    : null;
  const fdmBuildResult = useFdmCuboidBuildResult({
    buildKey: fdmBuildKey,
    domain: fdmDomain,
    enabled: fdmInstanceModelEnabled,
    groupKey: fdmBuildGroupKey,
    maxVectorGlyphs: fdmMaxVectorGlyphs,
    modelFieldVector: fdmInstanceModelFieldVector,
    revisionSummary: `domain=${fdmBuildTopologyRevision ?? "none"} field=${fdmBuildFieldRevision ?? "none"} target=${fdmBuildTargetRevision ?? "none"}`,
    vectorAnchorMode: fdmVectorAnchorMode,
    vectorField: fdmVectorsVisible ? fdmFieldVector : null,
    vectorScale: fdmVectorScale,
    voxelFillRatio: visualProfile.voxelFillRatio,
    voxelMagnitudeThreshold: fdmVoxelMagnitudeThreshold,
    voxelTopography: fdmVoxelTopography,
  });
  const fdmInstanceModel: FdmCuboidInstanceModel | null | undefined =
    fdmBuildResult?.model;
  const fdmVectorSegments = fdmBuildResult?.vectorSegments ?? null;
  const fdmSurfaceColors = useMemo(() => {
    if (!fdmSurfaceColorMode) return null;
    return buildSampledScalarColors(
      fdmFieldVector,
      fdmInstanceModel?.cellIndices,
      fdmSurfaceColorMode,
      scalarColorPalette,
    );
  }, [
    fdmFieldVector,
    fdmSurfaceColorMode,
    fdmInstanceModel,
    scalarColorPalette,
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
    topology: currentTopologyRenderModel,
    topologyRevision: topology.revision,
  });
  const fieldRenderModelBuildOptions = useMemo(
    () =>
      resolveViewport3DFieldRenderModelBuildOptions({
        complexFieldVector: analysisComplexField,
        fieldRenderOptions: fieldRenderOptionsWithPrimaryTargetBuffers,
        fieldVector: committedFieldVector,
        topology: currentTopologyRenderModel,
      }),
    [
      analysisComplexField,
      committedFieldVector,
      currentTopologyRenderModel,
      fieldRenderOptionsWithPrimaryTargetBuffers,
    ],
  );
  const fieldRenderModel = useMemo(() => {
    const model = measureViewport3DModelBuild(
      "fullmag.viewport3d.buildViewport3DFieldRenderModel",
      () =>
        buildViewport3DFieldRenderModel(
          currentTopologyRenderModel,
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
    currentTopologyRenderModel,
    analysisComplexField,
    fieldRenderModelBuildOptions,
    fieldScalarRangesByMode,
    fieldVector.payloadRevision,
    fieldVector.revision,
    renderingState?.revision,
    topology.revision,
    vectorColorMode,
    vectorScale,
  ]);
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
    (renderingState?.clip?.enabled ? clipCrossSection.error?.message : null) ??
    (meshQualityOverlayVisible ? meshQualityData.error?.message : null) ??
    fieldVector.error?.message ??
    magneticPartFieldVectors.error?.message ??
    targetQuantityFieldVectors.error?.message ??
    airboxFieldVectors.error?.message ??
    scene.error?.message ??
    universe.error?.message ??
    domainMeta.error?.message ??
    sharedDomainManifest.error?.message ??
    visualizationState.error?.message ??
    resolveViewport3DTopologyFreshnessLabel(topologyFreshness) ??
    topology.status;
  const domainSummary = fdmDomain
    ? `${fdmDomain.displayCellCount}/${fdmDomain.totalCells}`
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
    fieldRevision: fieldVector.payloadRevision ?? fieldVector.revision,
    objectCount: femDomain.objectPartIds.size,
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
      payloadRevision: fieldVector.payloadRevision ?? null,
      revision: fieldVector.revision,
      status: fieldVector.status,
    }),
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

  return {
    airboxSettings,
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
    diagnostics,
    domainId: domainMeta.data?.domain_id,
    domainSummary,
    fallbackSettings,
    fdmDomain,
    fdmInstanceModel: fdmInstanceModel,
    fdmSettings,
    fdmSurfaceColors,
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
    status,
    renderedMeshRevision: currentTopologyRenderModel?.meshRevision ?? null,
    topology: topology.data,
    topologyRevision: topology.revision,
    topologyFreshness,
    topologyModel: topologyRenderModel,
    vectorColorMode,
    vectorScale: fdmVectorScale,
    vectorStyle,
    visualizationEffectiveRenderMode,
    visualizationError,
    visualProfileId: commandState.visualProfileId,
    visualizationRevision,
  };
}

function useViewport3DCameraRegistryStoreSync(
  cameraResource: VisualizationStateResource["camera"],
) {
  const lastRemoteSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    const camera = resolveViewport3DCameraState({ camera: cameraResource });
    const projection = resolveViewport3DCameraProjection({
      camera: cameraResource,
    });
    const orthographicScale = resolveViewport3DCameraOrthographicScale({
      camera: cameraResource,
    });
    const signature = viewport3DCameraViewSignature({
      camera,
      orthographicScale,
      projection,
    });
    if (lastRemoteSignatureRef.current === signature) return;

    lastRemoteSignatureRef.current = signature;
    viewport3dStore.setCameraView({ camera, orthographicScale, projection });
  }, [cameraResource]);
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
