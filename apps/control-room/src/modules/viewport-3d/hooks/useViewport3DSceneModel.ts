"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
} from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import type { useSelection } from "@/kernel/selection/useSelection";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveDefaultVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
  surfaceColorSourceToColorMode,
} from "@/kernel/visualization/ObjectVisualizationController";
import type { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";
import { resolveVisualizationEffectiveRenderMode } from "@/kernel/visualization/useVisualizationClientAck";

import {
  mergeViewport3DFieldScalarColors,
  useViewport3DChunkedScalarColors,
} from "./useViewport3DChunkedScalarColors";
import { useViewport3DFieldRenderOptions } from "./useViewport3DFieldRenderOptions";
import {
  FULL_FIELD_QUERY,
  resolveViewport3DSelectionBounds,
  targetForMeshPart,
} from "../model/viewport3DTargets";
import { buildFdmCuboidInstanceModel } from "../layers/FdmCuboidLayer";
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
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DMeshQualityData,
  useViewport3DScene,
  useViewport3DSharedDomainManifest,
  useViewport3DUniverse,
  useViewport3DVisualizationState,
} from "../viewport3dResources";
import {
  isViewport3DTopologyCurrent,
  resolveUnknownTopologyProvenanceRefreshKey,
  resolveViewport3DTopologyFreshness,
} from "../viewport3dTopologyStaleness";
import {
  resolveHslReferenceVisible,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3DCameraViewSignature,
  viewport3dStore,
  type useViewport3DCommandState,
} from "../viewport3dStore";
import { getViewport3DVisualProfile } from "../viewport3dVisualProfile";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;

function resolveSelectionMeshQualityMetric(
  selection: ReturnType<typeof useSelection>["selection"],
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

export function useViewport3DSceneModel({
  commandState,
  colors,
  objectVisualizationSnapshot,
  resourceCounts,
  selection,
}: {
  commandState: ReturnType<typeof useViewport3DCommandState>;
  colors: Viewport3DSceneProps["colors"] | null;
  objectVisualizationSnapshot: ReturnType<typeof useObjectVisualizationRegistry>["snapshot"];
  resourceCounts: Viewport3DResourceCounts;
  selection: ReturnType<typeof useSelection>["selection"];
}) {
  const visualizationState = useViewport3DVisualizationState();
  const visualProfile = getViewport3DVisualProfile(commandState.visualProfileId);
  const renderingState = visualizationState.data;
  const cameraResource = renderingState?.camera ?? null;
  useViewport3DRemoteCameraSync(cameraResource);
  const visualizationRevision = renderingState?.revision ?? null;
  const visualizationError = visualizationState.error?.message ?? null;
  const visualizationEffectiveRenderMode = resolveVisualizationEffectiveRenderMode({
    layers: renderingState?.layers,
  });
  const quantityId = renderingState?.active_quantity_id ?? "m";
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
      buildViewport3DTopologyRenderModel(
        topology.data,
        femDomain.magneticParts,
        femDomain.airboxParts,
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
        ? buildMeshQualityVertexColors(
            topology.data,
            meshQualityData.data,
            meshQualityMetric,
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
  const topologyBounds = topologyCurrent
    ? resolveTopologyBounds(topology.data)
    : null;
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
  const selectionBounds =
    resolvePrimitiveSelectionBounds(selection, primitiveModel) ??
    resolveViewport3DSelectionBounds(selection, femDomain, bounds);
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
    ],
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
    }).settings;
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
      }).settings,
    [objectVisualizationSnapshot, renderingState],
  );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: targetForMeshPart(part),
        visualizationState: renderingState,
      }).settings,
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
      }).settings,
    [objectVisualizationSnapshot, renderingState],
  );
  const fieldRenderOptions = useViewport3DFieldRenderOptions({
    airboxSettings,
    fallbackSettings,
    getPartSettings,
    topologyRenderModel: currentTopologyRenderModel,
    vectorColorMode,
    vectorDomain,
  });
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
      visualProfile.voxelTopography.enabled,
  );
  const fdmVectorsVisible = Boolean(
    fdmDomain && fdmSettings.visible && fdmSettings.vectorsVisible,
  );
  const fieldVectorEnabled =
    viewport3DFieldRenderOptionsNeedFieldData(fieldRenderOptions) ||
    Boolean(fdmSurfaceColorMode) ||
    fdmVectorsVisible ||
    fdmVoxelMagnitudeThreshold > 0 ||
    fdmTopographyEnabled;
  const fieldVector = useViewport3DFieldVector(
    quantityId,
    FULL_FIELD_QUERY,
    fieldVectorEnabled,
  );
  const fdmSurfaceColors = useMemo(() => {
    if (!fdmSurfaceColorMode) return null;
    const model = buildFdmCuboidInstanceModel(fdmDomain, {
      fieldVector: fieldVector.data,
      voxelFillRatio: visualProfile.voxelFillRatio,
      voxelMagnitudeThreshold: fdmVoxelMagnitudeThreshold,
      voxelTopography: visualProfile.voxelTopography,
    });
    return buildSampledScalarColors(
      fieldVector.data,
      model?.cellIndices,
      fdmSurfaceColorMode,
    );
  }, [
    fdmDomain,
    fdmSurfaceColorMode,
    fdmVoxelMagnitudeThreshold,
    fieldVector.data,
    visualProfile.voxelFillRatio,
    visualProfile.voxelTopography,
  ]);
  const chunkedScalarColors = useViewport3DChunkedScalarColors({
    colorModes: fieldRenderOptions.scalarColorModes,
    enabled: fieldRenderOptions.scalarColorsVisible !== false,
    fieldVector: fieldVector.data,
    topology: currentTopologyRenderModel,
  });
  const fieldRenderModel = useMemo(() => {
    const model = buildViewport3DFieldRenderModel(
      currentTopologyRenderModel,
      fieldVector.data,
      vectorScale,
      fieldRenderOptions,
    );
    return mergeViewport3DFieldScalarColors(
      model,
      chunkedScalarColors,
      vectorColorMode,
    );
  }, [
    chunkedScalarColors,
    currentTopologyRenderModel,
    fieldRenderOptions,
    fieldVector.data,
    vectorColorMode,
    vectorScale,
  ]);
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
    (meshQualityOverlayVisible ? meshQualityData.error?.message : null) ??
    fieldVector.error?.message ??
    scene.error?.message ??
    universe.error?.message ??
    domainMeta.error?.message ??
    sharedDomainManifest.error?.message ??
    visualizationState.error?.message ??
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
    cameraProjection: commandState.widgets.cameraProjection,
    cameraResource,
    cameraState: commandState.camera,
    diagnostics,
    domainId: domainMeta.data?.domain_id,
    domainSummary,
    fallbackSettings,
    fdmDomain,
    fdmSettings,
    fdmSurfaceColors,
    femDomain,
    fieldModel: fieldRenderModel,
    fieldVector: fieldVector.data,
    getObjectSettings,
    getPartSettings,
    hslReferenceVisible,
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

function useViewport3DRemoteCameraSync(
  cameraResource: VisualizationStateResource["camera"] | null,
) {
  const lastRemoteSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cameraResource) return;
    const camera = resolveViewport3DCameraState({ camera: cameraResource });
    const projection = resolveViewport3DCameraProjection({
      camera: cameraResource,
    });
    const signature = viewport3DCameraViewSignature({ camera, projection });
    if (lastRemoteSignatureRef.current === signature) return;

    lastRemoteSignatureRef.current = signature;
    viewport3dStore.setCameraView({ camera, projection });
  }, [cameraResource]);
}
