"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";
import { VISUALIZATION_STATE_RESOURCE_KEY } from "@/kernel/visualization/useVisualizationStateResource";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveDefaultVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
  resolveTargetVisualization,
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import {
  mergeViewport3DFieldScalarColors,
  useViewport3DChunkedScalarColors,
} from "./hooks/useViewport3DChunkedScalarColors";
import { buildFdmCuboidInstanceModel } from "./layers/FdmCuboidLayer";
import { VIEWPORT_3D_WORLD_UP } from "./layers/CameraControls";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import {
  FULL_FIELD_QUERY,
  resolveViewport3DSelectionBounds,
  targetForMeshPart,
} from "./model/viewport3DTargets";
import {
  adaptFdmDomainMeta,
  adaptFemSharedDomainManifest,
  type Viewport3DMeshPart,
  type Viewport3DPartSelection,
} from "./viewport3dDomainAdapter";
import {
  buildViewport3DDiagnostics,
  useViewport3DResourceCounts,
  useViewport3DResourceTracker,
} from "./viewport3dDiagnostics";
import { buildSampledScalarColors } from "./viewport3dFieldMapping";
import {
  buildViewport3DFieldRenderModel,
  buildViewport3DTopologyRenderModel,
  combineViewport3DBounds,
  distributeVectorGlyphBudget,
  resolveNodeSelectionCount,
  resolveDomainBounds,
  resolveTopologyBounds,
  resolveUniverseBounds,
  resolveViewport3DMaxVectorGlyphs,
  viewport3DFieldRenderOptionsNeedFieldData,
  type Viewport3DFieldRenderOptions,
  type Viewport3DTopologyRenderModel,
  type Viewport3DVectorBudgetTarget,
} from "./viewport3dRenderModel";
import {
  buildViewport3DMagnetizationTexturePreviewMap,
  buildViewport3DPrimitiveRenderModel,
  resolvePrimitiveSelectionBounds,
  type Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import {
  isViewport3DTopologyCurrent,
  resolveViewport3DTopologyFreshness,
} from "./viewport3dTopologyStaleness";
import {
  getViewport3DCacheStats,
  useViewport3DDomainMeta,
  useViewport3DDomainTopology,
  useViewport3DFieldVector,
  useViewport3DScene,
  useViewport3DSharedDomainManifest,
  useViewport3DUniverse,
  useViewport3DVisualizationState,
} from "./viewport3dResources";
import { buildViewport3DResourceFrameKey } from "./viewport3dInvalidation";
import {
  resolveHslReferenceVisible,
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  resolveViewport3DCameraProjection,
  resolveViewport3DCameraState,
  viewport3dStore,
  useViewport3DCommandState,
} from "./viewport3dStore";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";
import {
  configureViewport3DRenderer,
  getViewport3DVisualProfile,
  resolveViewport3DCanvasDpr,
  resolveViewport3DCanvasGlOptions,
} from "./viewport3dVisualProfile";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;

interface Viewport3DFrameProps
  extends Omit<Viewport3DSceneProps, "colors"> {
  clientReady: boolean;
  colors: Viewport3DSceneProps["colors"] | null;
  captureRevision: number;
  diagnostics: string;
  domainSummary: string;
  kernel: ModuleProps["kernel"];
  onClearSelection: () => void;
  quantityId: string;
  selectedLabel: string;
  slotId: ModuleProps["slotId"];
  status: string;
}

export default function Viewport3DModule({
  kernel,
  moduleId,
  slotId,
}: ModuleProps) {
  const { clientReady, colors } = useViewport3DColors();
  const { selection, select, clear } = useSelection(moduleId);
  const { snapshot: objectVisualizationSnapshot } =
    useObjectVisualizationRegistry();
  const tracker = useViewport3DResourceTracker();
  const resourceCounts = useViewport3DResourceCounts(tracker);
  const commandState = useViewport3DCommandState();
  const { domainId, ...sceneModel } = useViewport3DSceneModel({
    commandState,
    colors,
    objectVisualizationSnapshot,
    resourceCounts,
    selection,
  });
  const { onSelectDomain, onSelectObject, onSelectPart } =
    useViewport3DSelectionHandlers({
      domainId,
      select,
  });
  const saveCameraState = useCallback(
    async (camera: {
      position: [number, number, number];
      target: [number, number, number];
    }) => {
      const next = await kernel.api.visualization.patch({
        camera: {
          position: camera.position,
          target: camera.target,
          up: VIEWPORT_3D_WORLD_UP,
        },
      });
      kernel.resources.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, next.revision);
    },
    [kernel.api, kernel.resources],
  );

  return (
    <Viewport3DFrame
      {...sceneModel}
      clientReady={clientReady}
      colors={colors}
      fitRevision={commandState.fitRevision}
      kernel={kernel}
      onClearSelection={clear}
      onSelectDomain={onSelectDomain}
      onSelectObject={onSelectObject}
      onSelectPart={onSelectPart}
      onCameraChange={saveCameraState}
      captureRevision={commandState.captureRevision}
      resetCameraRevision={commandState.resetCameraRevision}
      slotId={slotId}
      tracker={tracker}
      viewCubeVisible={commandState.widgets.viewCubeVisible}
    />
  );
}

function useViewport3DSceneModel({
  commandState,
  colors,
  objectVisualizationSnapshot,
  resourceCounts,
  selection,
}: {
  commandState: ReturnType<typeof useViewport3DCommandState>;
  colors: Viewport3DSceneProps["colors"] | null;
  objectVisualizationSnapshot: ReturnType<typeof useObjectVisualizationRegistry>["snapshot"];
  resourceCounts: ReturnType<typeof useViewport3DResourceCounts>;
  selection: ReturnType<typeof useSelection>["selection"];
}) {
  const visualizationState = useViewport3DVisualizationState();
  const visualProfile = getViewport3DVisualProfile(commandState.visualProfileId);
  const quantityId = visualizationState.data?.active_quantity_id ?? "m";
  const vectorColorMode =
    visualizationState.data?.vector_style.color_mode ?? "orientation";
  const vectorLengthScale =
    visualizationState.data?.vector_style.length_scale ?? 1;
  const vectorDomain = visualizationState.data?.layers?.vectors?.domain ?? "auto";
  const vectorStyle = useMemo(
    () => ({
      alpha: visualizationState.data?.vector_style.alpha ?? 1,
      monoColor:
        visualizationState.data?.vector_style.mono_color ??
        String(colors?.field ?? "white"),
      thickness: visualizationState.data?.vector_style.thickness ?? 1,
    }),
    [
      colors?.field,
      visualizationState.data?.vector_style.alpha,
      visualizationState.data?.vector_style.mono_color,
      visualizationState.data?.vector_style.thickness,
    ],
  );
  const maxVectorGlyphs = resolveViewport3DMaxVectorGlyphs(
    visualizationState.data,
    visualProfile.glyphBudget,
  );
  const maxAirboxVectorGlyphs = resolveViewport3DAirboxMaxVectorGlyphs(
    visualizationState.data,
    maxVectorGlyphs,
  );
  const domainMeta = useViewport3DDomainMeta();
  const scene = useViewport3DScene();
  const universe = useViewport3DUniverse();
  const sharedDomainManifest = useViewport3DSharedDomainManifest();
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
  const topologyCurrent = isViewport3DTopologyCurrent(topologyFreshness);
  const currentTopologyRenderModel = topologyCurrent ? topologyRenderModel : null;
  const magnetizationTexturePreviews = useMemo(
    () => buildViewport3DMagnetizationTexturePreviewMap(scene.data),
    [scene.data],
  );
  const primitiveBounds = useMemo(
    () => combineViewport3DBounds(
      primitiveModel.objects.map((object) => object.bounds),
    ),
    [primitiveModel],
  );
  const topologyBounds = topologyCurrent ? resolveTopologyBounds(topology.data) : null;
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
    Math.max(...(bounds?.size ?? [1e-6, 1e-6, 1e-6])) * 0.035 * vectorLengthScale,
    1e-12,
  );
  const selectionBounds =
    resolvePrimitiveSelectionBounds(selection, primitiveModel) ??
    resolveViewport3DSelectionBounds(
      selection,
      femDomain,
      bounds,
    );
  // Derive fallback settings only from global (non-airbox) layers so that
  // airbox-specific API patches cannot inadvertently alter the appearance
  // of regular mesh objects.
  const globalLayers = visualizationState.data?.layers;
  const globalObjectBaseSettings = useMemo(
    () => resolveGlobalObjectVisualizationSettings(visualizationState.data),
    // Explicit deps on global layer fields only – airbox sub-fields excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      globalLayers?.surface?.visible,
      globalLayers?.surface?.opacity,
      globalLayers?.wireframe?.visible,
      globalLayers?.points?.visible,
      globalLayers?.vectors?.visible,
      visualizationState.data?.vector_style.alpha,
      visualizationState.data?.vector_style.color_mode,
      visualizationState.data?.vector_style.mono_color,
      visualizationState.data?.vector_style.thickness,
      visualizationState.data?.vector_glyphs,
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
      visualizationState: visualizationState.data,
    }).settings;
  }, [
    domainMeta.data?.domain_id,
    fallbackSettings,
    fdmDomain,
    objectVisualizationSnapshot,
    visualizationState.data,
  ]);
  const airboxSettings = useMemo(
    () =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: AIRBOX_VISUALIZATION_TARGET,
        visualizationState: visualizationState.data,
      }).settings,
    [objectVisualizationSnapshot, visualizationState.data],
  );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      resolveTargetVisualization({
        snapshot: objectVisualizationSnapshot,
        target: targetForMeshPart(part),
        visualizationState: visualizationState.data,
      }).settings,
    [objectVisualizationSnapshot, visualizationState.data],
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
        visualizationState: visualizationState.data,
      }).settings,
    [objectVisualizationSnapshot, visualizationState.data],
  );
  const fieldRenderOptions = useViewport3DFieldRenderOptions({
    airboxSettings,
    fallbackSettings,
    getPartSettings,
    maxAirboxVectorGlyphs,
    maxVectorGlyphs,
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
  const fieldRenderModel = useMemo(
    () => {
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
    },
    [
      chunkedScalarColors,
      currentTopologyRenderModel,
      fieldRenderOptions,
      fieldVector.data,
      vectorColorMode,
      vectorScale,
    ],
  );
  const selectedLabel = selection.label ?? "No selection";
  const status =
    topology.error?.message ??
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
    cache: getViewport3DCacheStats(),
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
    cameraProjection: resolveViewport3DCameraProjection(visualizationState.data),
    cameraState: resolveViewport3DCameraState(visualizationState.data),
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
    maxVectorGlyphs,
    primitiveModel,
    quantityId,
    resourceFrameKey,
    selectedLabel,
    selectionBounds,
    status,
    topologyFreshness,
    topologyModel: topologyRenderModel,
    vectorColorMode,
    vectorScale,
    vectorStyle,
    visualProfileId: commandState.visualProfileId,
  };
}

function useViewport3DSelectionHandlers({
  domainId,
  select,
}: {
  domainId: string | null | undefined;
  select: ReturnType<typeof useSelection>["select"];
}) {
  const onSelectDomain = useCallback(() => {
    select({
      kind: "domain",
      label: domainId ?? "Domain",
      nodeId: "domain",
      objectId: domainId ?? null,
    });
  }, [domainId, select]);
  const onSelectPart = useCallback(
    (partSelection: Viewport3DPartSelection) => {
      select({
        kind: partSelection.kind,
        label: partSelection.label,
        nodeId: partSelection.nodeId,
        objectId: partSelection.objectId,
      });
    },
    [select],
  );
  const onSelectObject = useCallback(
    (object: Viewport3DPrimitiveObject) => {
      select({
        kind: "object.root",
        label: object.label,
        nodeId: `model:object:${object.objectId}`,
        objectId: object.objectId,
        ref: {
          kind: "object.root",
          nodeId: `model:object:${object.objectId}`,
          objectId: object.objectId,
          type: "scene-object",
          visualizationTargetId: `object:${object.objectId}`,
        },
      });
    },
    [select],
  );

  return { onSelectDomain, onSelectObject, onSelectPart };
}

function useViewport3DFieldRenderOptions({
  airboxSettings,
  fallbackSettings,
  getPartSettings,
  maxAirboxVectorGlyphs,
  maxVectorGlyphs,
  topologyRenderModel,
  vectorColorMode,
  vectorDomain,
}: {
  airboxSettings: VisualizationTargetSettings;
  fallbackSettings: VisualizationTargetSettings;
  getPartSettings: (part: Viewport3DMeshPart) => VisualizationTargetSettings;
  maxAirboxVectorGlyphs: number;
  maxVectorGlyphs: number;
  topologyRenderModel: Viewport3DTopologyRenderModel<Viewport3DMeshPart> | null;
  vectorColorMode: string;
  vectorDomain: string;
}): Viewport3DFieldRenderOptions {
  return useMemo(() => {
    if (!topologyRenderModel) {
      return {
        fullVectorBudget: 0,
        partVectorBudgets: new Map(),
        scalarColorModes: new Set(),
        scalarColorsVisible: false,
      };
    }

    const fullVectorTargetId = "__full__";
    const magneticVectorTargets: Viewport3DVectorBudgetTarget[] = [];
    const airboxVectorTargets: Viewport3DVectorBudgetTarget[] = [];
    const partVectorScopes = new Map<string, "surface" | "full">();
    const scalarColorModes = new Set<string>();
    let scalarColorsVisible = false;
    const magneticVectorsAllowed = vectorDomain !== "airbox_only";
    const airboxVectorsAllowed =
      vectorDomain !== "magnetic_only" &&
      vectorDomain !== "object" &&
      vectorDomain !== "part";

    if (topologyRenderModel.magneticParts.length > 0) {
      for (const partModel of topologyRenderModel.magneticParts) {
        const settings = getPartSettings(partModel.part);
        const visible =
          magneticVectorsAllowed &&
          settings.visible &&
          settings.vectorsVisible;
        if (settings.visible && settings.shaderVisible) {
          const scalarColorMode = surfaceColorSourceToColorMode(
            settings.surfaceColorSource,
          );
          if (scalarColorMode) {
            scalarColorsVisible = true;
            scalarColorModes.add(scalarColorMode);
          }
        }
        partVectorScopes.set(partModel.part.id, settings.geometryScope);
        magneticVectorTargets.push({
          id: partModel.part.id,
          nodeCount: resolveNodeSelectionCount(
            settings.geometryScope === "surface"
              ? partModel.surfaceNodeSelection ?? partModel.part
              : partModel.part,
            topologyRenderModel,
          ),
          visible,
        });
      }
    } else {
      scalarColorsVisible =
        fallbackSettings.visible && fallbackSettings.shaderVisible;
      if (scalarColorsVisible) {
        const scalarColorMode = surfaceColorSourceToColorMode(
          fallbackSettings.surfaceColorSource,
        );
        if (scalarColorMode) {
          scalarColorModes.add(scalarColorMode);
        } else {
          scalarColorsVisible = false;
        }
      }
      magneticVectorTargets.push({
        id: fullVectorTargetId,
        nodeCount: topologyRenderModel.nodeCount,
        visible:
          magneticVectorsAllowed &&
          fallbackSettings.visible &&
          fallbackSettings.vectorsVisible,
      });
    }

    for (const partModel of topologyRenderModel.airboxParts) {
      if (airboxSettings.visible && airboxSettings.shaderVisible) {
        const scalarColorMode = surfaceColorSourceToColorMode(
          airboxSettings.surfaceColorSource,
        );
        if (scalarColorMode) {
          scalarColorsVisible = true;
          scalarColorModes.add(scalarColorMode);
        }
      }
      partVectorScopes.set(partModel.part.id, airboxSettings.geometryScope);
      airboxVectorTargets.push({
        id: partModel.part.id,
        nodeCount: resolveNodeSelectionCount(
          airboxSettings.geometryScope === "surface"
            ? partModel.surfaceNodeSelection ?? partModel.part
            : partModel.part,
          topologyRenderModel,
        ),
        visible:
          airboxVectorsAllowed &&
          airboxSettings.visible &&
          airboxSettings.vectorsVisible,
      });
    }

    const magneticBudgets = distributeVectorGlyphBudget(
      magneticVectorTargets,
      maxVectorGlyphs,
    );
    const airboxBudgets = distributeVectorGlyphBudget(
      airboxVectorTargets,
      maxAirboxVectorGlyphs,
    );
    const fullVectorBudget = magneticBudgets.get(fullVectorTargetId) ?? 0;
    magneticBudgets.delete(fullVectorTargetId);

    return {
      fullVectorBudget,
      partVectorBudgets: new Map([...magneticBudgets, ...airboxBudgets]),
      partVectorScopes,
      scalarColorModes,
      scalarColorsVisible,
      vectorColorMode,
    };
  }, [
    airboxSettings.vectorsVisible,
    airboxSettings.geometryScope,
    airboxSettings.surfaceColorSource,
    airboxSettings.shaderVisible,
    airboxSettings.visible,
    fallbackSettings.surfaceColorSource,
    fallbackSettings.shaderVisible,
    fallbackSettings.vectorsVisible,
    fallbackSettings.visible,
    getPartSettings,
    maxAirboxVectorGlyphs,
    maxVectorGlyphs,
    topologyRenderModel,
    vectorColorMode,
    vectorDomain,
  ]);
}

function resolveViewport3DAirboxMaxVectorGlyphs(
  state: VisualizationStateResource | null | undefined,
  fallback: number,
): number {
  const density = state?.layers?.airbox?.vectors?.density ?? fallback;
  return Math.max(0, Math.floor(density));
}

function Viewport3DFrame({
  captureRevision,
  clientReady,
  colors,
  diagnostics,
  domainSummary,
  kernel,
  onClearSelection,
  quantityId,
  selectedLabel,
  slotId,
  status,
  ...sceneProps
}: Viewport3DFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const primitiveObjectIds =
    sceneProps.primitiveModel?.objects.map((object) => object.objectId).join(" ") ??
    "";
  const visualProfile = getViewport3DVisualProfile(
    sceneProps.visualProfileId,
  );
  const canvasDpr = resolveViewport3DCanvasDpr({
    devicePixelRatio:
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    profile: visualProfile,
  });
  const canvasGlOptions = resolveViewport3DCanvasGlOptions(visualProfile);
  const discretizationKind = sceneProps.fdmDomain
    ? "FDM"
    : sceneProps.femDomain.magneticParts.length > 0
      ? "FEM"
      : null;
  useEffect(() => {
    if (captureRevision <= 0 || typeof window === "undefined") return;
    let disposed = false;
    const captureFrame = () => {
      if (disposed) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const link = document.createElement("a");
      link.download = "fullmag-viewport-3d.png";
      link.href = canvas.toDataURL("image/png");
      link.click();
      viewport3dStore.completeCapture();
    };
    const captureTimer = window.setTimeout(captureFrame, 80);
    return () => {
      disposed = true;
      window.clearTimeout(captureTimer);
    };
  }, [captureRevision]);

  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      data-primitive-object-count={sceneProps.primitiveModel?.objects.length ?? 0}
      data-primitive-object-ids={primitiveObjectIds}
      data-visual-profile-id={sceneProps.visualProfileId}
      onPointerDown={() => kernel.layout.setFocusedSlot(slotId)}
    >
      <div aria-live="polite" className="fm-viewport-3d__hud">
        <span>{quantityId}</span>
        <span>{selectedLabel}</span>
        <span>{domainSummary}</span>
        <span>{status}</span>
        <span>{diagnostics}</span>
      </div>
      {clientReady && colors ? (
        <Canvas
          camera={{
            far: 1e-3,
            fov: 42,
            near: 1e-12,
            position: DEFAULT_VIEWPORT_3D_CAMERA_STATE.position,
            up: VIEWPORT_3D_WORLD_UP,
          }}
          className="fm-viewport-3d__canvas"
          dpr={canvasDpr}
          frameloop={VIEWPORT_3D_FRAMELOOP}
          gl={canvasGlOptions}
          onCreated={({ gl }) => {
            canvasRef.current = gl.domElement;
            configureViewport3DRenderer(gl, visualProfile);
          }}
          onPointerMissed={onClearSelection}
        >
          <Viewport3DScene
            {...sceneProps}
            colors={colors}
            visualProfileId={visualProfile.id}
          />
        </Canvas>
      ) : (
        <div className="fm-viewport-3d__placeholder">Preparing viewport</div>
      )}
      {discretizationKind && (
        <div
          aria-label={`Discretization method: ${discretizationKind}`}
          className="fm-viewport-3d__method-badge"
        >
          {discretizationKind}
        </div>
      )}
    </section>
  );
}
