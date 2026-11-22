"use client";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { viewport3DVectorLayersEnabledFromBrowserConfig } from "@/kernel/browserFullmagConfig";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";

import type { VisualizationTargetSettings } from "@/kernel/visualization/ObjectVisualizationController";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { type ThreeEvent, useThree } from "@react-three/fiber";
import {
  useEffect,
  useId,
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  memo,
  type RefObject,
} from "react";
import { BoxGeometry, BufferAttribute, BufferGeometry, type Camera, InstancedBufferAttribute, InstancedMesh, MeshBasicMaterial, MeshLambertMaterial, MeshStandardMaterial, Raycaster, Vector2, Vector3 } from "three";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";

import {
  RENDER_POLICIES,
  materialPolicyProps,
  resolveSurfacePolicy,
  surfaceMaterialPolicyProps,
} from "./viewport3DRenderPolicy";

import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { type ScalarColorBuffer } from "../viewport3dFieldMapping";
import type { Viewport3DColors } from "../viewport3dTypes";
import type { Viewport3DMaterialProfile } from "./viewport3DMaterialProfile";
import { resolveFdmCuboidSurfaceMaterialPlan } from "./viewport3DSurfaceMaterialPlans";
import {
  buildViewport3DFdmInspectSample,
  type Viewport3DInspectSample,
  type Viewport3DInspectScreenPosition,
} from "../viewport3dInspect";
import {
  pointColorFromSettings,
  surfaceMaterialColorFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeColorFromSettings,
} from "./viewport3DLayerSettings";
import {
  resolveViewport3DTargetRenderPlan,
  type Viewport3DTargetRenderPlan,
} from "./viewport3DTargetRenderPlan";
import { VectorFieldLayer } from "./VectorFieldLayer";
import { type VectorFieldLayerVectorStyle } from "./VectorFieldLayer.model";
import type { Viewport3DRenderAdoptionRegistry } from "../model/viewport3DRenderAdoptionRegistry";

import type { Viewport3DVectorBuildReference } from "../viewport3dRenderModel";
import {
  eventIntersectsRegionOverlay,
  pickRegionOverlayFromRay,
} from "./regionOverlayPicking";
import {
  buildRegionOverlayModels,
  type RegionOverlayInput,
} from "./regionOverlayModel";
import type { RegionOverlaySelection } from "./RegionOverlayLayer";
import { buildFdmPointPositions, type FdmCuboidBuildRequest, type FdmCuboidInstanceModel } from "./fdmCuboidBuildModel";
import { buildViewport3DFdmCuboidOffMainThread } from "./fdmCuboidBuildScheduler";
import { createFdmCuboidBuildStateController, EMPTY_FDM_CUBOID_BUILD_SNAPSHOT, resolveFdmCuboidBuildState, type FdmCuboidBuildState } from "./fdmCuboidBuildState";
import { resolveFdmCuboidPassPlan } from "./fdmCuboidPasses";
import { fdmVectorSegmentCacheCounter, FDM_VECTOR_SEGMENT_CACHE_MAX_BYTES_PER_FIELD, resolveFdmCuboidSourceInstanceOrdinal, type FdmCuboidAsyncBuildEntry, createFdmCuboidBatchBuildController, EMPTY_FDM_CUBOID_BUILD_RESULTS, type FdmCuboidAsyncBuildInput, type FdmCuboidPreparedInstances, fdmCuboidUsesInstanceColors, recordFdmCuboidSurfaceAdoption, fdmCuboidSurfaceAdoptionIdentity, uploadFdmCuboidAttribute, disposeFdmCuboidInstanceColorBeforeReplace, resolveFdmCuboidColorUploadRevision, handleFdmCuboidContextLost, resolveFdmCuboidGeometryScopeInstanceOrdinals, prepareFdmCuboidInstanceMatrices, shouldAttachFdmCuboidInspectListener, visibleFdmCuboidInspectTargets, resolveFdmCuboidPreparedSourceOrdinal, fdmCuboidVectorPassCanRenderWithoutCellModel } from "./FdmCuboidLayer.model";

export {
  buildFdmCuboidInstanceModel,
  buildFdmDenseNativeLayerInstanceModel,
  buildFdmPointPositions,
  createFdmVectorOnlyBuildInput,
  buildFdmVectorSampledCellIndices,
  resolveFdmCuboidMembershipRevision,
  resolveFdmVectorGlyphScale,
  resolveFdmVectorGlyphScaleForCellSize,
  resolveFdmVectorGlyphSamplingSpacingScale,
  type FdmCuboidInstanceModel,
  type FdmCuboidInstanceModelOptions,
  type FdmVoxelTopographyOptions,
} from "./fdmCuboidBuildModel";

export { resolveFdmCuboidPassPlan } from "./fdmCuboidPasses";

const FDM_INSPECT_PROJECTION_FALLBACK_LIMIT = 5000;
const FDM_INSPECT_PROJECTION_HIT_RADIUS_PX = 36;
const FDM_VECTOR_SEGMENT_CACHE_MEMORY_BUDGET_ID =
  "viewport3d.render.fdmVectorSegmentCache";

memoryBudgetRegistry.register(FDM_VECTOR_SEGMENT_CACHE_MEMORY_BUDGET_ID, () => ({
  byteLength: fdmVectorSegmentCacheCounter.byteLength,
  category: "render-buffer",
  entryCount: fdmVectorSegmentCacheCounter.entryCount,
  id: FDM_VECTOR_SEGMENT_CACHE_MEMORY_BUDGET_ID,
  label: "FDM vector segment cache",
  maxBytes: FDM_VECTOR_SEGMENT_CACHE_MAX_BYTES_PER_FIELD,
}));

function markFdmCuboidUpload(name: string): string | null {
  const target = globalThis.performance;
  if (!target?.mark || !target?.measure) return null;

  const startMark = `${name}:start:${Date.now()}:${Math.random()}`;
  target.mark(startMark);
  return startMark;
}

function measureFdmCuboidUpload(name: string, startMark: string | null): void {
  const target = globalThis.performance;
  if (!startMark || !target?.mark || !target?.measure) return;

  const endMark = `${name}:end:${Date.now()}:${Math.random()}`;
  target.mark(endMark);
  try {
    target.measure(name, startMark, endMark);
  } catch {
    // Gracefully ignore measurement errors
  }
}

interface FdmInspectProjectionFallbackInput {
  camera: Camera;
  instanceOrdinals?: Uint32Array | null;
  model: FdmCuboidInstanceModel;
  pointerX: number;
  pointerY: number;
  projected: Vector3;
  rectHeight: number;
  rectWidth: number;
}

function resolveProjectedFdmInspectHit({
  camera,
  model,
  pointerX,
  pointerY,
  projected,
  rectHeight,
  rectWidth,
  instanceOrdinals,
}: FdmInspectProjectionFallbackInput): {
  instanceId: number;
  worldPosition: [number, number, number];
} | null {
  const renderCount = instanceOrdinals?.length ?? model.count;
  if (renderCount > FDM_INSPECT_PROJECTION_FALLBACK_LIMIT) return null;

  const maxDistanceSq =
    FDM_INSPECT_PROJECTION_HIT_RADIUS_PX *
    FDM_INSPECT_PROJECTION_HIT_RADIUS_PX;
  let bestDistanceSq = maxDistanceSq;
  let bestInstanceId = -1;

  for (let instanceId = 0; instanceId < renderCount; instanceId += 1) {
    const sourceInstance = resolveFdmCuboidSourceInstanceOrdinal(
      instanceId,
      instanceOrdinals,
      model.count,
    );
    if (sourceInstance === null) continue;
    const offset = sourceInstance * 3;
    const worldX = model.centers[offset] ?? 0;
    const worldY = model.centers[offset + 1] ?? 0;
    const worldZ = model.centers[offset + 2] ?? 0;

    projected.set(worldX, worldY, worldZ).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;

    const screenX = (projected.x * 0.5 + 0.5) * rectWidth;
    const screenY = (-projected.y * 0.5 + 0.5) * rectHeight;
    const dx = screenX - pointerX;
    const dy = screenY - pointerY;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq >= bestDistanceSq) continue;

    bestDistanceSq = distanceSq;
    bestInstanceId = instanceId;
  }

  if (bestInstanceId < 0) return null;

  const sourceInstance = resolveFdmCuboidSourceInstanceOrdinal(
    bestInstanceId,
    instanceOrdinals,
    model.count,
  );
  if (sourceInstance === null) return null;
  const offset = sourceInstance * 3;
  return {
    instanceId: bestInstanceId,
    worldPosition: [
      model.centers[offset] ?? 0,
      model.centers[offset + 1] ?? 0,
      model.centers[offset + 2] ?? 0,
    ],
  };
}

export function useFdmCuboidBuildResults(
  entries: readonly FdmCuboidAsyncBuildEntry[],
): ReadonlyMap<string, FdmCuboidBuildState> {
  const controller = useMemo(() => createFdmCuboidBatchBuildController(), []);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => EMPTY_FDM_CUBOID_BUILD_RESULTS,
  );

  useEffect(() => {
    controller.reconcile(entries);
  }, [controller, entries]);

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);

  return snapshot;
}

export function useFdmCuboidBuildResult({
  buildKey,
  cellSelection,
  domain,
  enabled,
  groupKey,
  maxVectorGlyphs,
  modelFieldVector,
  realizedRegionIds,
  revisionSummary,
  topologyKey,
  vectorAnchorMode,
  vectorField,
  vectorGeometryScope,
  vectorOnly,
  vectorScale,
  vectorSurfaceOffsetEnabled,
  vectorSurfaceOffsetScale,
  voxelFillRatio,
  voxelMagnitudeThreshold,
  voxelTopography,
}: FdmCuboidAsyncBuildInput): FdmCuboidBuildState | undefined {
  const store = useMemo(() => createFdmCuboidBuildStateController(), []);
  const request = useMemo<FdmCuboidBuildRequest | null>(
    () =>
      enabled && domain
        ? {
            cellSelection,
            domain,
            maxVectorGlyphs,
            modelFieldVector,
            realizedRegionIds: realizedRegionIds ?? null,
            vectorAnchorMode,
            vectorField,
            vectorGeometryScope: vectorGeometryScope ?? "full",
            vectorOnly: vectorOnly ?? null,
            vectorScale,
            vectorSurfaceOffsetEnabled: vectorSurfaceOffsetEnabled ?? false,
            vectorSurfaceOffsetScale: vectorSurfaceOffsetScale ?? 0,
            voxelFillRatio,
            voxelMagnitudeThreshold,
            voxelTopography,
          }
        : null,
    [
      cellSelection,
      domain,
      enabled,
      maxVectorGlyphs,
      modelFieldVector,
      realizedRegionIds,
      vectorAnchorMode,
      vectorField,
      vectorGeometryScope,
      vectorOnly,
      vectorScale,
      vectorSurfaceOffsetEnabled,
      vectorSurfaceOffsetScale,
      voxelFillRatio,
      voxelMagnitudeThreshold,
      voxelTopography,
    ],
  );
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => EMPTY_FDM_CUBOID_BUILD_SNAPSHOT,
  );

  useEffect(() => {
    if (!request || !buildKey) {
      return;
    }

    if (topologyKey) {
      store.begin(buildKey, topologyKey);
    } else {
      store.begin(buildKey);
    }
    const abortController = new AbortController();
    void buildViewport3DFdmCuboidOffMainThread(request, {
      buildKey,
      groupKey: groupKey ?? undefined,
      latestWins: true,
      revisionSummary,
      signal: abortController.signal,
    })
      .then((result) => {
        if (abortController.signal.aborted) return;
        store.resolve(buildKey, result);
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) return;
        store.reject(buildKey, error);
      });

    return () => {
      abortController.abort();
    };
  }, [buildKey, groupKey, request, revisionSummary, store, topologyKey]);

  if (!request) return undefined;
  return resolveFdmCuboidBuildState({
    currentBuildKey: buildKey,
    currentTopologyKey: topologyKey ?? null,
    snapshot,
  });
}

const FdmCuboidSurfacePass = memo(function FdmCuboidSurfacePass({
  adoptionRegistry,
  carrierId,
  colors,
  materialProfile,
  preparedInstances,
  fieldBufferId,
  onPointerMove,
  onPointerOut,
  renderSettings,
  renderPlan,
  sessionIdentity,
  surfaceColors,
  surfaceRef,
  tracker,
  wireframeRef,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  carrierId: string;
  colors: Viewport3DColors;
  materialProfile: Viewport3DMaterialProfile;
  preparedInstances: FdmCuboidPreparedInstances;
  fieldBufferId: string | null;
  onPointerMove: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut: () => void;
  renderSettings: VisualizationTargetSettings;
  renderPlan: Viewport3DTargetRenderPlan;
  sessionIdentity?: SessionResourceIdentity | null;
  surfaceColors: ScalarColorBuffer | null;
  surfaceRef: RefObject<InstancedMesh | null>;
  tracker: Viewport3DResourceTracker;
  wireframeRef: RefObject<InstancedMesh | null>;
}) {
  const invalidate = useBatchedInvalidate();
  const { gl } = useThree();
  const geometry = useMemo(
    () => {
      const next = new BoxGeometry(1, 1, 1);
      // Keep the regular vertex-color channel neutral because instance colors
      // share the material's color path and must not gain an extra multiplier.
      const color = new Float32Array(next.getAttribute("position").count * 3);
      color.fill(1);
      next.setAttribute("color", new BufferAttribute(color, 3));
      return tracker.track("geometry", next);
    },
    [tracker],
  );
  const surfaceOpacity = renderPlan.surface.opacity;
  const surfacePolicy = resolveSurfacePolicy(surfaceOpacity);
  const renderCount = preparedInstances.count;
  const usesInstanceColors = fdmCuboidUsesInstanceColors(
    renderSettings,
    surfaceColors,
    renderCount,
  );
  const lastAdoptedSurfaceRef = useRef<{
    fieldBufferId: string | null;
    sessionIdentity: SessionResourceIdentity | null | undefined;
    scalarBuffer: ScalarColorBuffer;
  } | null>(null);
  const adoptionOwnerId = `fdm-cuboid-surface:${useId()}`;
  const recordSurfaceAdoption = useCallback(() => {
    if (!adoptionRegistry || !surfaceColors) return;
    const adoption = recordFdmCuboidSurfaceAdoption({
      carrierId,
      fieldBufferId,
      ownerId: adoptionOwnerId,
      registry: adoptionRegistry,
      sessionIdentity,
      scalarBuffer: surfaceColors,
    });
    lastAdoptedSurfaceRef.current =
      adoption.fieldBufferId && sessionIdentity &&
        adoptionRegistry.hasActiveAdoption({
          fieldBufferId: adoption.fieldBufferId,
          resourceKey: adoption.resourceKey,
          sessionEpoch: sessionIdentity.sessionEpoch,
          sessionId: sessionIdentity.sessionId,
        })
        ? {
            fieldBufferId,
            sessionIdentity,
            scalarBuffer: surfaceColors,
          }
        : null;
  }, [
    adoptionOwnerId,
    adoptionRegistry,
    carrierId,
    fieldBufferId,
    sessionIdentity,
    surfaceColors,
  ]);
  useEffect(() => {
    if (!adoptionRegistry) return;
    const unregister = adoptionRegistry.registerCarrierAdoptionReplay(carrierId, () => {
      const adopted = lastAdoptedSurfaceRef.current;
      if (!adopted) return;
      recordFdmCuboidSurfaceAdoption({
        carrierId,
        fieldBufferId: adopted.fieldBufferId,
        ownerId: adoptionOwnerId,
        registry: adoptionRegistry,
        sessionIdentity: adopted.sessionIdentity,
        scalarBuffer: adopted.scalarBuffer,
      });
    });
    return () => {
      unregister();
      const adopted = lastAdoptedSurfaceRef.current;
      if (!adopted) return;
      adoptionRegistry.clearAdoption(
        adoptionOwnerId,
        fdmCuboidSurfaceAdoptionIdentity({ ...adopted, carrierId }),
      );
    };
  }, [adoptionOwnerId, adoptionRegistry, carrierId]);
  useEffect(() => {
    if (usesInstanceColors || !adoptionRegistry) return;
    const adopted = lastAdoptedSurfaceRef.current;
    if (!adopted) return;
    adoptionRegistry.clearAdoption(
      adoptionOwnerId,
      fdmCuboidSurfaceAdoptionIdentity({ ...adopted, carrierId }),
    );
    lastAdoptedSurfaceRef.current = null;
  }, [adoptionOwnerId, adoptionRegistry, carrierId, usesInstanceColors]);
  const surfaceMaterialColor = surfaceMaterialColorFromSettings(
    renderSettings,
    colors.mesh,
    usesInstanceColors,
  );
  const surfaceMaterialPlan = resolveFdmCuboidSurfaceMaterialPlan(
    materialProfile,
    usesInstanceColors,
  );
  const materialMetalness = surfaceMaterialPlan.kind === "standard" ? surfaceMaterialPlan.metalness : undefined;
  const materialRoughness = surfaceMaterialPlan.kind === "standard" ? surfaceMaterialPlan.roughness : undefined;
  // Only parameters that change the shader program (material kind, vertex
  // colours, transparency/depth policy) create a new material. Colour,
  // opacity and PBR scalars are applied in place below, so dragging an
  // opacity slider no longer disposes the material and recompiles the
  // program on every tick (audit 2026-11-19).
  const surfacePolicyKey = JSON.stringify(surfaceMaterialPolicyProps(surfaceOpacity));
  // The layout effect below writes colour, opacity and PBR scalars before
  // the first frame of a new material is drawn.
  const surfaceMaterial = useMemo(
    () => {
      const materialParameters = {
        toneMapped: surfaceMaterialPlan.toneMapped,
        vertexColors: surfaceMaterialPlan.vertexColors,
        ...(JSON.parse(surfacePolicyKey) as ReturnType<
          typeof surfaceMaterialPolicyProps
        >),
      };
      if (surfaceMaterialPlan.kind === "standard") {
        return tracker.track(
          "material",
          new MeshStandardMaterial(materialParameters),
        );
      }
      if (surfaceMaterialPlan.kind === "lambert") {
        return tracker.track(
          "material",
          new MeshLambertMaterial(materialParameters),
        );
      }
      return tracker.track("material", new MeshBasicMaterial(materialParameters));
    },
    [
      surfaceMaterialPlan.kind,
      surfaceMaterialPlan.toneMapped,
      surfaceMaterialPlan.vertexColors,
      surfacePolicyKey,
      tracker,
    ],
  );
  const surfaceMaterialRef = useRef<
    MeshBasicMaterial | MeshLambertMaterial | MeshStandardMaterial
  >(null);
  // Runs after the <primitive> ref is attached and before the frame is drawn.
  useLayoutEffect(() => {
    const material = surfaceMaterialRef.current;
    if (!material) return;
    material.color.set(surfaceMaterialColor);
    material.opacity = surfaceOpacity;
    if (material instanceof MeshStandardMaterial) {
      if (materialMetalness !== undefined) material.metalness = materialMetalness;
      if (materialRoughness !== undefined) material.roughness = materialRoughness;
    }
    invalidate();
  }, [
    invalidate,
    materialMetalness,
    materialRoughness,
    surfaceMaterial,
    surfaceMaterialColor,
    surfaceOpacity,
  ]);
  const wireframePolicy = RENDER_POLICIES.featureEdges;
  const wireframeColor = wireframeColorFromSettings(renderSettings, colors.wire);
  const wireframeOpacity = renderPlan.wireframe.opacity;
  const wireframeMaterial = useMemo(
    () =>
      tracker.track(
        "material",
        new MeshBasicMaterial({
          transparent: wireframePolicy.transparent,
          depthWrite: wireframePolicy.depthWrite,
          depthTest: wireframePolicy.depthTest,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          side: wireframePolicy.side,
          wireframe: true,
        }),
      ),
    [tracker, wireframePolicy],
  );
  const wireframeMaterialRef = useRef<MeshBasicMaterial>(null);
  useLayoutEffect(() => {
    const material = wireframeMaterialRef.current;
    if (!material) return;
    material.color.set(wireframeColor);
    material.opacity = wireframeOpacity;
    invalidate();
  }, [invalidate, wireframeColor, wireframeMaterial, wireframeOpacity]);
  useEffect(() => () => tracker.release("geometry", geometry), [geometry, tracker]);
  useEffect(
    () => () => tracker.release("material", surfaceMaterial),
    [surfaceMaterial, tracker],
  );
  useEffect(
    () => () => tracker.release("material", wireframeMaterial),
    [wireframeMaterial, tracker],
  );

  const surfaceMatrixRevisionRef = useRef<string | null>(null);
  const wireframeMatrixRevisionRef = useRef<string | null>(null);
  const colorRevisionRef = useRef<string | null>(null);
  const uploadPreparedCarriers = useCallback(() => {
    const surface = surfaceRef.current;
    const wireframe = wireframeRef.current;
    if (!surface || !wireframe) return;
    const matrixChanged =
      surfaceMatrixRevisionRef.current !== preparedInstances.contentRevision ||
      wireframeMatrixRevisionRef.current !== preparedInstances.contentRevision;
    const startMark = matrixChanged
      ? markFdmCuboidUpload("fullmag.viewport3d.uploadFdmCuboidMatrices")
      : null;
    surfaceMatrixRevisionRef.current = uploadFdmCuboidAttribute(
      surface.instanceMatrix,
      preparedInstances.matrices,
      preparedInstances.contentRevision,
      surfaceMatrixRevisionRef.current,
    );
    wireframeMatrixRevisionRef.current = uploadFdmCuboidAttribute(
      wireframe.instanceMatrix,
      preparedInstances.matrices,
      preparedInstances.contentRevision,
      wireframeMatrixRevisionRef.current,
    );
    surface.count = preparedInstances.count;
    wireframe.count = preparedInstances.count;
    if (matrixChanged) {
      measureFdmCuboidUpload(
        "fullmag.viewport3d.uploadFdmCuboidMatrices",
        startMark,
      );
    }

    let colorChanged = false;
    // Instance colors are enabled by Three.js independently of vertexColors.
    // Drop the previous quantity's attribute when no compatible buffer exists.
    if (!usesInstanceColors && surface.instanceColor !== null) {
      disposeFdmCuboidInstanceColorBeforeReplace(surface, null);
      surface.instanceColor = null;
      colorRevisionRef.current = null;
      const mountedSurfaceMaterial = surface.material;
      if (
        mountedSurfaceMaterial === surfaceMaterial &&
        (mountedSurfaceMaterial instanceof MeshBasicMaterial ||
          mountedSurfaceMaterial instanceof MeshLambertMaterial ||
          mountedSurfaceMaterial instanceof MeshStandardMaterial)
      ) {
        mountedSurfaceMaterial.needsUpdate = true;
      }
      colorChanged = true;
    }
    if (usesInstanceColors && surfaceColors) {
      const colorRevision = resolveFdmCuboidColorUploadRevision(
        preparedInstances,
        surfaceColors,
      );
      if (
        !surface.instanceColor ||
        surface.instanceColor.array.length !== surfaceColors.colors.length
      ) {
        const nextInstanceColor = new InstancedBufferAttribute(
          new Float32Array(surfaceColors.colors.length),
          3,
        );
        disposeFdmCuboidInstanceColorBeforeReplace(
          surface,
          nextInstanceColor,
        );
        surface.instanceColor = nextInstanceColor;
        colorRevisionRef.current = null;
      }
      colorChanged = colorRevisionRef.current !== colorRevision;
      const colorStartMark = colorChanged
        ? markFdmCuboidUpload("fullmag.viewport3d.uploadFdmCuboidColors")
        : null;
      colorRevisionRef.current = uploadFdmCuboidAttribute(
        surface.instanceColor,
        surfaceColors.colors,
        colorRevision,
        colorRevisionRef.current,
      );
      if (colorChanged) {
        measureFdmCuboidUpload(
          "fullmag.viewport3d.uploadFdmCuboidColors",
          colorStartMark,
        );
      }
      const previousAdoption = lastAdoptedSurfaceRef.current;
      const adoptionIdentityChanged =
        previousAdoption?.fieldBufferId !== fieldBufferId ||
        previousAdoption?.scalarBuffer !== surfaceColors ||
        previousAdoption?.sessionIdentity?.sessionEpoch !==
          sessionIdentity?.sessionEpoch ||
        previousAdoption?.sessionIdentity?.requestScopeEpoch !==
          sessionIdentity?.requestScopeEpoch ||
        previousAdoption?.sessionIdentity?.sessionId !== sessionIdentity?.sessionId;
      if (colorChanged || adoptionIdentityChanged) {
        recordSurfaceAdoption();
      }
    }
    if (matrixChanged || colorChanged) {
      tracker.recordDirtyFrame("fdm-cuboids");
      invalidate();
    }
  }, [
    invalidate,
    preparedInstances,
    recordSurfaceAdoption,
    surfaceMaterial,
    fieldBufferId,
    sessionIdentity,
    surfaceColors,
    surfaceRef,
    tracker,
    usesInstanceColors,
    wireframeRef,
  ]);
  const uploadPreparedCarriersAfterContextRestore = useEffectEvent(() => {
    uploadPreparedCarriers();
  });
  useEffect(() => {
    uploadPreparedCarriers();
  }, [uploadPreparedCarriers]);
  useEffect(() => {
    const canvas = gl.domElement;
    const invalidateUploadedRevisions = () => {
      surfaceMatrixRevisionRef.current = null;
      wireframeMatrixRevisionRef.current = null;
      colorRevisionRef.current = null;
    };
    const handleContextLost = (event: Event) => {
      handleFdmCuboidContextLost(event, invalidateUploadedRevisions);
    };
    const restore = () => {
      surfaceMatrixRevisionRef.current = null;
      wireframeMatrixRevisionRef.current = null;
      colorRevisionRef.current = null;
      uploadPreparedCarriersAfterContextRestore();
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", restore);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", restore);
    };
  }, [gl]);

  return (
    <>
      <instancedMesh
        args={[geometry, undefined, renderCount]}
        castShadow={surfaceMaterialPlan.castShadow}
        frustumCulled={false}
        onPointerMove={renderPlan.surface.visible ? onPointerMove : undefined}
        onPointerOut={renderPlan.surface.visible ? onPointerOut : undefined}
        receiveShadow={surfaceMaterialPlan.receiveShadow}
        ref={surfaceRef}
        renderOrder={surfacePolicy.renderOrder}
        visible={renderPlan.surface.visible}
      >
        <primitive
          ref={surfaceMaterialRef}
          attach="material"
          object={surfaceMaterial}
        />
      </instancedMesh>
      <instancedMesh
        args={[geometry, undefined, renderCount]}
        frustumCulled={false}
        onPointerMove={renderPlan.wireframe.visible ? onPointerMove : undefined}
        onPointerOut={renderPlan.wireframe.visible ? onPointerOut : undefined}
        ref={wireframeRef}
        renderOrder={wireframePolicy.renderOrder}
        visible={renderPlan.wireframe.visible}
      >
        <primitive
          ref={wireframeMaterialRef}
          attach="material"
          object={wireframeMaterial}
        />
      </instancedMesh>
    </>
  );
});

const FdmCuboidPointsPass = memo(function FdmCuboidPointsPass({
  colors,
  instanceOrdinals,
  model,
  renderSettings,
  opacity,
  tracker,
}: {
  colors: Viewport3DColors;
  instanceOrdinals?: Uint32Array | null;
  model: FdmCuboidInstanceModel;
  renderSettings: VisualizationTargetSettings;
  opacity: number;
  tracker: Viewport3DResourceTracker;
}) {
  const geometry = useMemo(() => {
    const positions = buildFdmPointPositions(
      model,
      renderSettings.geometryScope,
      instanceOrdinals,
    );
    if (!positions) return null;
    return tracker.track(
      "geometry",
      new BufferGeometry().setAttribute(
        "position",
        new BufferAttribute(positions, 3),
      ),
    );
  }, [instanceOrdinals, model, renderSettings.geometryScope, tracker]);
  useEffect(
    () => () => tracker.release("geometry", geometry),
    [geometry, tracker],
  );
  if (!geometry) return null;
  return (
    <points
      geometry={geometry}
      renderOrder={RENDER_POLICIES.points.renderOrder}
    >
      <pointsMaterial
        color={pointColorFromSettings(renderSettings, colors.wire)}
        opacity={opacity}
        sizeAttenuation={false}
        size={3}
        {...materialPolicyProps("points")}
      />
    </points>
  );
});

export const FdmCuboidLayer = memo(function FdmCuboidLayer({
  adoptionRegistry,
  carrierId = "fdm-domain",
  colors,
  materialProfile,
  onSelectDomain,
  onSelectTarget,
  onSelectFdmCell,
  onSelectRegion,
  regionOverlays,
  settings,
  sessionIdentity,
  selectedObjectId,
  selectedRegionId,
  surfaceColors,
  tracker,
  vectorColorMode,
  vectorStyle,
  fieldVector,
  geometryScopeInstanceOrdinals,
  vectorGlyphColors,
  vectorBuildReference,
  instanceModel,
  instanceOrdinals,
  inspectEnabled,
  inspectQuantityId,
  onInspectClear,
  onInspectSample,
  vectorSegments,
}: {
  adoptionRegistry?: Viewport3DRenderAdoptionRegistry;
  carrierId?: string;
  colors: Viewport3DColors;
  fieldVector: DecodedFieldVector | null | undefined;
  geometryScopeInstanceOrdinals?: Uint32Array | null;
  vectorGlyphColors?: Float32Array | null;
  vectorBuildReference?: Viewport3DVectorBuildReference | null;
  instanceModel?: FdmCuboidInstanceModel | null;
  instanceOrdinals?: Uint32Array | null;
  inspectEnabled: boolean;
  inspectQuantityId: string;
  materialProfile: Viewport3DMaterialProfile;
  onInspectClear?: () => void;
  onInspectSample?: (
    sample: Viewport3DInspectSample,
    screenPosition: Viewport3DInspectScreenPosition,
  ) => void;
  onSelectDomain: () => void;
  /** Target-aware selection for a target-partitioned FDM render view. */
  onSelectTarget?: () => void;
  /** Optional identity-gated cell selection; absent means fail closed. */
  onSelectFdmCell?: (instanceId: number) => void;
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  regionOverlays?: readonly RegionOverlayInput[];
  selectedObjectId?: string | null;
  selectedRegionId?: string | null;
  settings: VisualizationTargetSettings;
  sessionIdentity?: SessionResourceIdentity | null;
  surfaceColors: ScalarColorBuffer | null;
  tracker: Viewport3DResourceTracker;
  vectorColorMode: string;
  vectorSegments: Float32Array | null;
  vectorStyle: VectorFieldLayerVectorStyle;
}) {
  const surfaceRef = useRef<InstancedMesh>(null);
  const wireframeRef = useRef<InstancedMesh>(null);
  const { camera, gl } = useThree();
  const inspectRaycastState = useMemo(
    () => ({
      pointer: new Vector2(),
      projected: new Vector3(),
      raycaster: new Raycaster(),
    }),
    [],
  );
  const inspectFrameRef = useRef(0);
  const r3fInspectHitFrameRef = useRef(0);
  const renderSettings = settings;
  const geometryScopeOrdinals = resolveFdmCuboidGeometryScopeInstanceOrdinals(
    renderSettings.geometryScope,
    instanceOrdinals,
    geometryScopeInstanceOrdinals,
  );
  const targetRenderPlan = resolveViewport3DTargetRenderPlan(
    renderSettings,
    materialProfile,
  );
  const passPlan = resolveFdmCuboidPassPlan(renderSettings);
  const regionPickModels = useMemo(
    () =>
      buildRegionOverlayModels(regionOverlays ?? [], {
        selectedObjectId,
        selectedRegionId,
      }),
    [regionOverlays, selectedObjectId, selectedRegionId],
  );
  const model = instanceModel ?? null;
  const preparedInstances = useMemo(
    () =>
      model
        ? prepareFdmCuboidInstanceMatrices(
            model,
            geometryScopeOrdinals,
            carrierId,
          )
        : null,
    [carrierId, geometryScopeOrdinals, model],
  );
  const rawInspectListenerEnabled = shouldAttachFdmCuboidInspectListener({
    inspectEnabled,
    prepared: Boolean(preparedInstances),
    surfaceVisible: targetRenderPlan.surface.visible,
    targetVisible: renderSettings.visible,
    wireframeVisible: targetRenderPlan.wireframe.visible,
  });
  useEffect(() => {
    if (!rawInspectListenerEnabled || !model || !preparedInstances) {
      return undefined;
    }

    const canvas = gl.domElement;
    let cachedRect = canvas.getBoundingClientRect();
    let pendingEvent: PointerEvent | null = null;
    let pendingFrame = 0;
    let rafId: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      cachedRect = canvas.getBoundingClientRect();
    });

    const processInspectPointerMove = (event: PointerEvent) => {
      const rect = cachedRect;
      if (rect.width <= 0 || rect.height <= 0) return;

      inspectRaycastState.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      inspectRaycastState.raycaster.setFromCamera(
        inspectRaycastState.pointer,
        camera,
      );

      const targets = visibleFdmCuboidInspectTargets([
        surfaceRef.current,
        wireframeRef.current,
      ]);
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const hit = inspectRaycastState.raycaster
        .intersectObjects(targets, false)
        .find((intersection) => typeof intersection.instanceId === "number");

      const fallbackHit = hit
        ? null
        : resolveProjectedFdmInspectHit({
            camera,
            model,
            instanceOrdinals: preparedInstances.ordinals,
            pointerX,
            pointerY,
            projected: inspectRaycastState.projected,
            rectHeight: rect.height,
            rectWidth: rect.width,
          });
      const instanceId = hit?.instanceId ?? fallbackHit?.instanceId;
      const worldPosition: [number, number, number] | null = hit
        ? [hit.point.x, hit.point.y, hit.point.z]
        : (fallbackHit?.worldPosition ?? null);

      if (typeof instanceId !== "number" || !worldPosition) {
        onInspectClear?.();
        return;
      }
      const sourceInstance = resolveFdmCuboidPreparedSourceOrdinal(
        preparedInstances,
        instanceId,
      );
      if (sourceInstance === null) {
        onInspectClear?.();
        return;
      }

      onInspectSample?.(
        buildViewport3DFdmInspectSample({
          fieldVector,
          instanceId: sourceInstance,
          model,
          quantityId: inspectQuantityId,
          worldPosition,
        }),
        {
          x: pointerX,
          y: pointerY,
        },
      );
    };
    const handleInspectPointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) return;

      pendingEvent = event;
      inspectFrameRef.current += 1;
      pendingFrame = inspectFrameRef.current;
      if (rafId !== null) return;

      rafId = requestAnimationFrame(() => {
        rafId = null;
        const eventToProcess = pendingEvent;
        const eventFrame = pendingFrame;
        pendingEvent = null;
        if (!eventToProcess) return;
        if (r3fInspectHitFrameRef.current === eventFrame) return;
        processInspectPointerMove(eventToProcess);
      });
    };
    const handleInspectPointerLeave = () => {
      pendingEvent = null;
      onInspectClear?.();
    };

    resizeObserver.observe(canvas);
    canvas.addEventListener("pointermove", handleInspectPointerMove, {
      passive: true,
    });
    canvas.addEventListener("pointerleave", handleInspectPointerLeave, {
      passive: true,
    });
    return () => {
      canvas.removeEventListener("pointermove", handleInspectPointerMove);
      canvas.removeEventListener("pointerleave", handleInspectPointerLeave);
      resizeObserver.disconnect();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    camera,
    fieldVector,
    gl,
    inspectQuantityId,
    inspectRaycastState,
    model,
    onInspectClear,
    onInspectSample,
    preparedInstances,
    rawInspectListenerEnabled,
  ]);

  const handlePointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (!inspectEnabled || !model || !preparedInstances) return;
    event.stopPropagation();
    r3fInspectHitFrameRef.current = inspectFrameRef.current;
    onInspectSample?.(
      buildViewport3DFdmInspectSample({
        fieldVector,
        instanceId:
          typeof event.instanceId === "number"
            ? resolveFdmCuboidPreparedSourceOrdinal(
                preparedInstances,
                event.instanceId,
              )
            : null,
        model,
        quantityId: inspectQuantityId,
        worldPosition: [event.point.x, event.point.y, event.point.z],
      }),
      {
        x: event.nativeEvent.offsetX,
        y: event.nativeEvent.offsetY,
      },
    );
  }, [fieldVector, inspectEnabled, inspectQuantityId, model, onInspectSample, preparedInstances]);
  const handlePointerOut = useCallback(() => {
    if (!inspectEnabled) return;
    onInspectClear?.();
  }, [inspectEnabled, onInspectClear]);

  if (!renderSettings.visible || !passPlan.needsCellModel) {
    return null;
  }

  const vectorsEnabled = viewport3DVectorLayersEnabledFromBrowserConfig();
  const vectorPass =
    vectorsEnabled && passPlan.needsVectors ? (
      <VectorFieldLayer
        adoptionRegistry={adoptionRegistry}
        buildReference={vectorBuildReference}
        carrierId={carrierId}
        colors={colors}
        colorMode={vectorColorModeFromSettings(renderSettings, vectorColorMode)}
        glyphColorsOverride={vectorGlyphColors}
        materialProfile={materialProfile.glyphs}
        opacity={targetRenderPlan.vectors.opacity}
        sessionIdentity={sessionIdentity}
        renderOnTop
        fieldBufferId={
          fieldVector
            ? `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`
            : null
        }
        segments={vectorSegments}
        style={vectorStyleFromSettings(renderSettings, vectorStyle)}
        tracker={tracker}
      />
    ) : null;

  if (!model || !preparedInstances) {
    return fdmCuboidVectorPassCanRenderWithoutCellModel({
      targetVisible: renderSettings.visible,
      vectorsEnabled,
      vectorsVisible: passPlan.needsVectors,
      vectorSegments,
    })
      ? vectorPass
      : null;
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (eventIntersectsRegionOverlay(event)) return;
    const pickedRegion = pickRegionOverlayFromRay(event.ray, regionPickModels);
    if (pickedRegion) {
      event.stopPropagation();
      onSelectRegion?.(pickedRegion);
      return;
    }
    if (Number.isInteger(event.instanceId) && onSelectFdmCell) {
      const sourceInstance = resolveFdmCuboidPreparedSourceOrdinal(
        preparedInstances,
        event.instanceId as number,
      );
      if (sourceInstance === null) return;
      event.stopPropagation();
      onSelectFdmCell(sourceInstance);
      return;
    }
    if (onSelectTarget) {
      event.stopPropagation();
      onSelectTarget();
      return;
    }
    onSelectDomain();
  };
  return (
    <group onPointerDown={handlePointerDown}>
      {passPlan.needsSurfaceInstances ? (
        <FdmCuboidSurfacePass
          adoptionRegistry={adoptionRegistry}
          carrierId={carrierId}
          colors={colors}
          materialProfile={materialProfile}
          fieldBufferId={
            fieldVector
              ? `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`
              : null
          }
          preparedInstances={preparedInstances}
          onPointerMove={handlePointerMove}
          onPointerOut={handlePointerOut}
          renderSettings={renderSettings}
          renderPlan={targetRenderPlan}
          sessionIdentity={sessionIdentity}
          surfaceColors={surfaceColors}
          surfaceRef={surfaceRef}
          tracker={tracker}
          wireframeRef={wireframeRef}
        />
      ) : null}
      {passPlan.needsPointGeometry ? (
        <FdmCuboidPointsPass
          colors={colors}
          instanceOrdinals={geometryScopeOrdinals}
          model={model}
          opacity={targetRenderPlan.points.opacity}
          renderSettings={renderSettings}
          tracker={tracker}
        />
      ) : null}
      {vectorPass}
    </group>
  );
});
