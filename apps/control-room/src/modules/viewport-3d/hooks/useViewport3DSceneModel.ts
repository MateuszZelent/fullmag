"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
} from "react";

import type {
  LiveStatusResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { CameraRegistrySnapshot } from "@/kernel/visualization/CameraRegistryController";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveDefaultVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
  surfaceColorSourceToColorMode,
  visualizationTargetKey,
  type ObjectVisualizationSnapshot,
  type VisualizationTargetKind,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { useCameraRegistrySnapshot } from "@/kernel/visualization/useCameraRegistry";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { resolveVisualizationEffectiveRenderMode } from "@/kernel/visualization/useVisualizationClientAck";

import {
  mergeViewport3DFieldScalarColors,
  useViewport3DChunkedScalarColors,
} from "./useViewport3DChunkedScalarColors";
import {
  useViewport3DFieldRenderOptions,
  viewport3DAirboxVectorsVisible,
} from "./useViewport3DFieldRenderOptions";
import {
  FULL_FIELD_QUERY,
  resolveViewport3DSelectionBounds,
  targetForMeshPart,
} from "../model/viewport3DTargets";
import {
  buildFdmCuboidInstanceModel,
  type FdmCuboidInstanceModel,
} from "../layers/FdmCuboidLayer";
import { Viewport3DScene } from "../layers/Viewport3DScene";
import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
  type Viewport3DMeshPart,
} from "../viewport3dDomainAdapter";
import {
  buildViewport3DDiagnostics,
  type Viewport3DResourceCounts,
} from "../viewport3dDiagnostics";
import { buildSampledScalarColors } from "../viewport3dFieldMapping";
import { buildViewport3DResourceFrameKey } from "../viewport3dInvalidation";
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
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  combineViewport3DBounds,
  resolveDomainBounds,
  resolveTopologyBounds,
  resolveUniverseBounds,
  viewport3DFieldRenderOptionsNeedFieldData,
} from "../viewport3dRenderModel";
import {
  getViewport3DCacheStats as getCacheStats,
  resolveViewport3DFieldVectorResourceKey,
  useViewport3DAirboxFieldVectors,
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DMeshQualityData,
  useViewport3DQuantityFieldVectors,
  useViewport3DScene,
  useViewport3DSharedDomainManifest,
  useViewport3DUniverse,
} from "../viewport3dResources";
import type { Viewport3DFieldRefreshState } from "../viewport3dRefreshCountdown";
import {
  isViewport3DTopologyCurrent,
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
const EMPTY_AIRBOX_FIELD_VECTOR_PARTS: readonly { id: string }[] = [];

export interface Viewport3DFieldDataIssue {
  key: string;
  message: string;
  quantityId: string;
  resourceKey: string;
  retry: () => void;
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
  previous: VisualizationTargetPatch | undefined,
  next: VisualizationTargetPatch | undefined,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;

  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(next),
  ] as Array<keyof VisualizationTargetPatch>);
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
  cameraRegistrySnapshot,
  commandState,
}: {
  cameraRegistrySnapshot: Pick<
    CameraRegistrySnapshot,
    "camera" | "interactionActive"
  >;
  commandState: Pick<Viewport3DCommandState, "camera" | "widgets">;
}): {
  cameraOrthographicScale: number | null;
  cameraProjection: Viewport3DCameraProjection;
  cameraResource: VisualizationStateResource["camera"];
  cameraState: Viewport3DCameraState;
  interactionActive: boolean;
} {
  if (cameraRegistrySnapshot.interactionActive) {
    return {
      cameraOrthographicScale: commandState.widgets.cameraOrthographicScale,
      cameraProjection: commandState.widgets.cameraProjection,
      cameraResource: cameraRegistrySnapshot.camera,
      cameraState: commandState.camera,
      interactionActive: true,
    };
  }

  return {
    cameraOrthographicScale: resolveViewport3DCameraOrthographicScale({
      camera: cameraRegistrySnapshot.camera,
    }),
    cameraProjection: resolveViewport3DCameraProjection({
      camera: cameraRegistrySnapshot.camera,
    }),
    cameraResource: cameraRegistrySnapshot.camera,
    cameraState: resolveViewport3DCameraState({
      camera: cameraRegistrySnapshot.camera,
    }),
    interactionActive: false,
  };
}

export function useViewport3DSceneModel({
  commandState,
  colors,
  resourceCounts,
  selection,
}: {
  commandState: ReturnType<typeof useViewport3DCommandState>;
  colors: Viewport3DSceneProps["colors"] | null;
  resourceCounts: Viewport3DResourceCounts;
  selection: Selection;
}) {
  const visualizationState = useVisualizationStateResource();
  const cameraRegistrySnapshot = useCameraRegistrySnapshot();
  const visualProfile = getViewport3DVisualProfile(commandState.visualProfileId);
  const computeRunning = useSessionStatusSelector(selectViewport3DComputeRunning);
  const renderingState = visualizationState.data;
  const cameraView = resolveViewport3DSceneCameraView({
    cameraRegistrySnapshot,
    commandState,
  });
  const cameraResource = cameraView.cameraResource;
  useViewport3DCameraRegistryStoreSync(cameraResource);
  const visualizationRevision = renderingState?.revision ?? null;
  const visualizationError = visualizationState.error?.message ?? null;
  const visualizationEffectiveRenderMode = resolveVisualizationEffectiveRenderMode({
    layers: renderingState?.layers,
  });
  const quantityId = renderingState?.active_quantity_id ?? "m";
  const scalarColorPalette =
    renderingState?.quantity?.colormap ?? renderingState?.colormap ?? "viridis";
  const vectorColorMode =
    renderingState?.vector_style.color_mode ?? "orientation";
  const vectorLengthScale = renderingState?.vector_style.length_scale ?? 1;
  const vectorDomain = renderingState?.layers?.vectors?.domain ?? "auto";
  const vectorStyle = useMemo(
    () => ({
      alpha: renderingState?.vector_style.alpha ?? 1,
      monoColor:
        renderingState?.vector_style.mono_color ??
        String(colors?.field ?? "white"),
      thickness: renderingState?.vector_style.thickness ?? 1,
    }),
    [
      colors?.field,
      renderingState?.vector_style.alpha,
      renderingState?.vector_style.mono_color,
      renderingState?.vector_style.thickness,
    ],
  );
  const domainMeta = useViewport3DDomainMeta();
  const scene = useViewport3DScene();
  const universe = useViewport3DUniverse();
  const sharedDomainManifest = useViewport3DSharedDomainManifest();
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
  const topologyRenderModel = useMemo(
    () =>
      measureViewport3DModelBuild(
        "fullmag.viewport3d.buildViewport3DTopologyRenderModel",
        () =>
          buildViewport3DTopologyRenderModel(
            topology.data,
            femDomain.magneticParts,
            femDomain.airboxParts,
          ),
      ),
    [femDomain.airboxParts, femDomain.magneticParts, topology.data],
  );
  const primitiveModel = useMemo(
    () =>
      buildViewport3DPrimitiveRenderModel(
        scene.data,
        sharedDomainManifest.data,
      ),
    [scene.data, sharedDomainManifest.data],
  );
  const topologyFreshness = useMemo(
    () =>
      resolveViewport3DTopologyFreshness(
        scene.data,
        sharedDomainManifest.data,
      ),
    [scene.data, sharedDomainManifest.data],
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
  const currentTopologyRenderModel = topologyCurrent ? topologyRenderModel : null;
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
              ),
          )
        : null,
    [
      meshQualityData.data,
      meshQualityMetric,
      meshQualityOverlayVisible,
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
      resolvePrimitiveSelectionBounds(selection, primitiveModel) ??
      resolveViewport3DSelectionBounds(selection, femDomain, bounds),
    [selection, primitiveModel, femDomain, bounds],
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
      renderingState?.vector_style.alpha,
      renderingState?.vector_style.color_mode,
      renderingState?.vector_style.mono_color,
      renderingState?.vector_style.thickness,
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
    if (fdmDomain && fdmDomainId) {
      pushViewportVisualizationTarget(targets, seen, {
        id: fdmDomainId,
        kind: "object",
        label: fdmDomainId,
      });
    }

    for (const object of primitiveModel.objects) {
      pushViewportVisualizationTarget(targets, seen, {
        id: object.objectId,
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

    return targets;
  }, [
    domainMeta.data?.domain_id,
    fdmDomain,
    femDomain.airboxParts,
    femDomain.magneticParts,
    primitiveModel.objects,
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
    if (!fdmDomain || !fdmDomainId) return fallbackSettings;
    return resolveTargetVisualization({
      snapshot: objectVisualizationSnapshot,
      target: { id: fdmDomainId, kind: "object" },
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
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: targetForMeshPart(part),
        visualizationState: renderingState,
      }).effectiveSettings,
    [objectVisualizationSnapshot, renderingState],
  );
  const getObjectSettings = useCallback(
    (object: Viewport3DPrimitiveObject) =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: {
          id: object.objectId,
          kind: "object",
          label: object.label,
        },
        visualizationState: renderingState,
      }).effectiveSettings,
    [objectVisualizationSnapshot, renderingState],
  );
  const airboxVectorsVisible = viewport3DAirboxVectorsVisible(
    airboxSettings.visible,
    airboxSettings.vectorsVisible,
    vectorDomain,
  );
  const airboxFieldVectorParts = useMemo(
    () =>
      currentTopologyRenderModel?.airboxParts.map((partModel) => partModel.part) ??
      EMPTY_AIRBOX_FIELD_VECTOR_PARTS,
    [currentTopologyRenderModel],
  );
  const targetQuantityIds = useMemo(() => {
    if (!currentTopologyRenderModel) return [];
    const ids = new Set<string>();
    for (const partModel of currentTopologyRenderModel.magneticParts) {
      const settings = getPartSettings(partModel.part);
      if (
        settings.activeQuantityId !== quantityId &&
        settings.visible &&
        (settings.shaderVisible || settings.vectorsVisible)
      ) {
        ids.add(settings.activeQuantityId);
      }
    }
    if (
      airboxSettings.activeQuantityId !== quantityId &&
      airboxSettings.visible &&
      (airboxSettings.shaderVisible || airboxSettings.vectorsVisible)
    ) {
      ids.add(airboxSettings.activeQuantityId);
    }
    if (
      fdmSettings.activeQuantityId !== quantityId &&
      fdmSettings.visible &&
      (fdmSettings.shaderVisible || fdmSettings.vectorsVisible)
    ) {
      ids.add(fdmSettings.activeQuantityId);
    }
    return Array.from(ids).toSorted();
  }, [
    airboxSettings.activeQuantityId,
    airboxSettings.shaderVisible,
    airboxSettings.vectorsVisible,
    airboxSettings.visible,
    currentTopologyRenderModel,
    fdmSettings.activeQuantityId,
    fdmSettings.shaderVisible,
    fdmSettings.vectorsVisible,
    fdmSettings.visible,
    getPartSettings,
    quantityId,
  ]);
  const targetQuantityFieldVectors = useViewport3DQuantityFieldVectors(
    targetQuantityIds,
    targetQuantityIds.length > 0,
  );
  const airboxFieldVectors = useViewport3DAirboxFieldVectors(
    airboxSettings.activeQuantityId,
    airboxFieldVectorParts,
    airboxVectorsVisible && airboxFieldVectorParts.length > 0,
  );
  const fieldRenderOptions = useViewport3DFieldRenderOptions({
    airboxSettings,
    fallbackSettings,
    getPartSettings,
    scalarColorPalette,
    topologyRenderModel: currentTopologyRenderModel,
    vectorColorMode,
    vectorDomain,
  });
  const resolvedFieldRenderOptions = useMemo(
    () => {
      const partFieldVectors = new Map<string, DecodedFieldVector>();
      if (targetQuantityFieldVectors.data && currentTopologyRenderModel) {
        for (const partModel of currentTopologyRenderModel.magneticParts) {
          const targetQuantityId = getPartSettings(partModel.part).activeQuantityId;
          const fieldVector = targetQuantityFieldVectors.data.get(targetQuantityId);
          if (fieldVector) {
            partFieldVectors.set(partModel.part.id, fieldVector);
          }
        }
        for (const partModel of currentTopologyRenderModel.airboxParts) {
          const fieldVector = targetQuantityFieldVectors.data.get(
            airboxSettings.activeQuantityId,
          );
          if (fieldVector) {
            partFieldVectors.set(partModel.part.id, fieldVector);
          }
        }
      }
      if (airboxFieldVectors.data) {
        for (const [partId, fieldVector] of airboxFieldVectors.data) {
          partFieldVectors.set(partId, fieldVector);
        }
      }
      return partFieldVectors.size > 0
        ? {
            ...fieldRenderOptions,
            partFieldVectors,
          }
        : fieldRenderOptions;
    },
    [
      airboxFieldVectors.data,
      airboxSettings.activeQuantityId,
      currentTopologyRenderModel,
      fieldRenderOptions,
      getPartSettings,
      targetQuantityFieldVectors.data,
    ],
  );
  const fdmSurfaceColorMode =
    fdmDomain && fdmSettings.visible && fdmSettings.shaderVisible
      ? surfaceColorSourceToColorMode(fdmSettings.surfaceColorSource)
      : null;
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
  const fieldVectorEnabled =
    viewport3DFieldRenderOptionsNeedFieldData(fieldRenderOptions) ||
    Boolean(fdmSurfaceColorMode) ||
    fdmVectorsVisible ||
    fdmInstanceModelNeedsFieldVector;
  const fieldVector = useViewport3DFieldVector(
    quantityId,
    FULL_FIELD_QUERY,
    fieldVectorEnabled,
  );
  const fieldVectorResourceKey = useMemo(
    () => resolveViewport3DFieldVectorResourceKey(quantityId, FULL_FIELD_QUERY),
    [quantityId],
  );
  const fieldDataIssue = useMemo<Viewport3DFieldDataIssue | null>(() => {
    if (!(fieldVectorEnabled && fieldVector.error)) return null;
    const message =
      fieldVector.error.message.trim() || "Field vector resource failed to load.";
    return {
      key: `${fieldVectorResourceKey}:${fieldVector.revision ?? "none"}:${message}`,
      message,
      quantityId,
      resourceKey: fieldVectorResourceKey,
      retry: fieldVector.refetch,
    };
  }, [
    fieldVector.error,
    fieldVector.refetch,
    fieldVector.revision,
    fieldVectorEnabled,
    fieldVectorResourceKey,
    quantityId,
  ]);
  const fieldRefresh = useMemo<Viewport3DFieldRefreshState>(
    () => ({
      enabled: computeRunning && fieldVectorEnabled,
      quantityId,
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
      quantityId,
    ],
  );
  const fdmFieldVector =
    fdmSettings.activeQuantityId === quantityId
      ? fieldVector.data
      : targetQuantityFieldVectors.data?.get(fdmSettings.activeQuantityId) ?? null;
  const fdmInstanceModelFieldVector = fdmInstanceModelNeedsFieldVector
    ? fdmFieldVector
    : null;
  const fdmInstanceModel = useMemo<
    FdmCuboidInstanceModel | null | undefined
  >(() => {
    if (!fdmInstanceModelEnabled) return undefined;
    return measureViewport3DModelBuild(
      "fullmag.viewport3d.buildFdmCuboidInstanceModel",
      () =>
        buildFdmCuboidInstanceModel(fdmDomain, {
          fieldVector: fdmInstanceModelFieldVector,
          voxelFillRatio: visualProfile.voxelFillRatio,
          voxelMagnitudeThreshold: fdmVoxelMagnitudeThreshold,
          voxelTopography: fdmVoxelTopography,
        }),
    );
  }, [
    fdmDomain,
    fdmInstanceModelEnabled,
    fdmInstanceModelFieldVector,
    fdmVoxelMagnitudeThreshold,
    fdmVoxelTopography,
    visualProfile.voxelFillRatio,
  ]);
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
    colorModes: fieldRenderOptions.scalarColorModes,
    colorPalette: scalarColorPalette,
    enabled: fieldRenderOptions.scalarColorsVisible !== false,
    fieldVector: fieldVector.data,
    topology: currentTopologyRenderModel,
  });
  const fieldRenderModel = useMemo(() => {
    const model = measureViewport3DModelBuild(
      "fullmag.viewport3d.buildViewport3DFieldRenderModel",
      () =>
          buildViewport3DFieldRenderModel(
          currentTopologyRenderModel,
          fieldVector.data,
          vectorScale,
          resolvedFieldRenderOptions,
        ),
    );
    return mergeViewport3DFieldScalarColors(
      model,
      chunkedScalarColors,
      vectorColorMode,
    );
  }, [
    chunkedScalarColors,
    currentTopologyRenderModel,
    fieldVector.data,
    resolvedFieldRenderOptions,
    vectorColorMode,
    vectorScale,
  ]);
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
    (meshQualityOverlayVisible ? meshQualityData.error?.message : null) ??
    fieldVector.error?.message ??
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
  const diagnostics = buildViewport3DDiagnostics({
    airboxPartCount: femDomain.airboxParts.length,
    cache: getCacheStats(),
    fieldRevision: fieldVector.revision,
    objectCount: femDomain.objectPartIds.size,
    quantityId,
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
    {
      error: fieldVector.error?.message,
      id: "field-vector",
      revision: fieldVector.revision,
      status: fieldVector.status,
    },
    {
      error: targetQuantityFieldVectors.error?.message,
      id: "target-quantity-field-vectors",
      revision: targetQuantityFieldVectors.revision,
      status: targetQuantityFieldVectors.status,
    },
    {
      error: airboxFieldVectors.error?.message,
      id: "airbox-field-vectors",
      revision: airboxFieldVectors.revision,
      status: airboxFieldVectors.status,
    },
    {
      error: meshQualityOverlayVisible
        ? meshQualityData.error?.message
        : undefined,
      id: "mesh-quality-data",
      revision: meshQualityOverlayVisible ? meshQualityData.revision : null,
      status: meshQualityOverlayVisible ? meshQualityData.status : "idle",
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
    diagnostics,
    domainId: domainMeta.data?.domain_id,
    domainSummary,
    fallbackSettings,
    fdmDomain,
    fdmInstanceModel: fdmInstanceModel,
    fdmSettings,
    fdmSurfaceColors,
    femDomain,
    fieldDataIssue,
    fieldRefresh,
    fieldModel: fieldRenderModel,
    fieldVector: fieldVector.data,
    getObjectSettings,
    getPartSettings,
    hslReferenceVisible,
    interactionActive: cameraView.interactionActive,
    magnetizationTexturePreviews,
    maxVectorGlyphs: fdmSettings.vectorBudget,
    meshQualityColors,
    meshQualityMetric,
    meshQualityOverlayVisible,
    meshQualityRange: meshQualityColors?.range ?? null,
    primitiveModel,
    quantityId,
    resourceFrameKey,
    selectedLabel,
    selectionBounds,
    status,
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
