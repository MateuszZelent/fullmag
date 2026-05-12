"use client";

import { Canvas } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, type ComponentProps } from "react";

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { useSelection } from "@/kernel/selection/useSelection";
import type { ModuleProps } from "@/kernel/types";
import {
  AIRBOX_VISUALIZATION_TARGET,
  resolveVisualizationSettings,
  surfaceColorSourceToColorMode,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { VIEWPORT_3D_WORLD_UP } from "./layers/CameraControls";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import {
  FULL_FIELD_QUERY,
  resolveAirboxBaseVisualizationSettings,
  resolveGlobalObjectVisualizationSettings,
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
  useViewport3DCommandState,
  viewport3dStore,
} from "./viewport3dStore";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;

function unitHash(seed: number): number {
  let value = seed | 0;
  value = Math.imul(value ^ (value >>> 16), 2246822507);
  value = Math.imul(value ^ (value >>> 13), 3266489909);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function mockUnitVector(index: number, tick: number): [number, number, number] {
  const base =
    Math.imul(index + 1, 374761393) ^ Math.imul(tick + 1, 668265263);
  for (let attempt = 0; attempt < 8; attempt++) {
    const x = unitHash(base + attempt * 2) * 2 - 1;
    const y = unitHash(base + attempt * 2 + 1) * 2 - 1;
    const s = x * x + y * y;
    if (s > 0 && s < 1) {
      const r = 2 * Math.sqrt(1 - s);
      return [x * r, y * r, 1 - 2 * s];
    }
  }
  return [0, 0, 1];
}

interface Viewport3DFrameProps
  extends Omit<Viewport3DSceneProps, "colors"> {
  clientReady: boolean;
  colors: Viewport3DSceneProps["colors"] | null;
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
    objectVisualizationSnapshot,
    resourceCounts,
    selection,
  });
  const { onSelectDomain, onSelectObject, onSelectPart } =
    useViewport3DSelectionHandlers({
      domainId,
      select,
    });

  useRegisterViewportProjectionCommand(kernel);

  return (
    <Viewport3DFrame
      {...sceneModel}
      cameraProjection={commandState.widgets.cameraProjection}
      cameraState={commandState.camera}
      clientReady={clientReady}
      colors={colors}
      fitRevision={commandState.fitRevision}
      kernel={kernel}
      onClearSelection={clear}
      onSelectDomain={onSelectDomain}
      onSelectObject={onSelectObject}
      onSelectPart={onSelectPart}
      resetCameraRevision={commandState.resetCameraRevision}
      slotId={slotId}
      tracker={tracker}
      viewCubeVisible={commandState.widgets.viewCubeVisible}
    />
  );
}

function useRegisterViewportProjectionCommand(
  kernel: ModuleProps["kernel"],
): void {
  useEffect(() => {
    const { commands } = kernel;
    commands.register({
      id: "view-projection",
      title: "Toggle projection",
      group: "viewport",
      category: "viewport",
      scope: "viewport",
      isActive: () =>
        viewport3dStore.getSnapshot().widgets.cameraProjection === "orthographic",
      run: () => {
        viewport3dStore.toggleCameraProjection();
        return Promise.resolve({ status: "completed" as const });
      },
    });
    return () => {
      commands.unregister("view-projection");
    };
  }, [kernel]);
}

function useViewport3DSceneModel({
  commandState,
  objectVisualizationSnapshot,
  resourceCounts,
  selection,
}: {
  commandState: ReturnType<typeof useViewport3DCommandState>;
  objectVisualizationSnapshot: ReturnType<typeof useObjectVisualizationRegistry>["snapshot"];
  resourceCounts: ReturnType<typeof useViewport3DResourceCounts>;
  selection: ReturnType<typeof useSelection>["selection"];
}) {
  const visualizationState = useViewport3DVisualizationState();
  const quantityId = visualizationState.data?.active_quantity_id ?? "m";
  const vectorColorMode =
    visualizationState.data?.vector_style.color_mode ?? "orientation";
  const vectorLengthScale =
    visualizationState.data?.vector_style.length_scale ?? 1;
  const vectorDomain = visualizationState.data?.layers?.vectors?.domain ?? "auto";
  const vectorStyle = useMemo(
    () => ({
      alpha: visualizationState.data?.vector_style.alpha ?? 1,
      monoColor: visualizationState.data?.vector_style.mono_color ?? "#00c2ff",
      thickness: visualizationState.data?.vector_style.thickness ?? 1,
    }),
    [
      visualizationState.data?.vector_style.alpha,
      visualizationState.data?.vector_style.mono_color,
      visualizationState.data?.vector_style.thickness,
    ],
  );
  const maxVectorGlyphs = resolveViewport3DMaxVectorGlyphs(
    visualizationState.data,
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
  const bounds =
    resolveTopologyBounds(topology.data) ??
    resolveDomainBounds(domainMeta.data) ??
    resolveUniverseBounds(universe.data) ??
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
  const objectKindDefaults = objectVisualizationSnapshot.defaults.object;
  const fallbackSettings = useMemo(
    () => ({
      ...resolveGlobalObjectVisualizationSettings(visualizationState.data),
      // Overlay local per-kind defaults (e.g. boundsVisible from the ribbon's
      // "Object frame" toggle) so that DomainBoxLayer and other consumers that
      // read fallbackSettings directly get the correct frame visibility.
      ...(objectKindDefaults ?? {}),
    }),
    // Explicit deps on global layer fields only – airbox sub-fields excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      globalLayers?.surface?.visible,
      globalLayers?.surface?.opacity,
      globalLayers?.wireframe?.visible,
      globalLayers?.points?.visible,
      globalLayers?.vectors?.visible,
      objectKindDefaults,
      visualizationState.data?.vector_style.alpha,
      visualizationState.data?.vector_style.color_mode,
      visualizationState.data?.vector_style.mono_color,
      visualizationState.data?.vector_style.thickness,
      visualizationState.data?.vector_glyphs,
    ],
  );
  const airboxBaseSettings = useMemo(
    () => resolveAirboxBaseVisualizationSettings(visualizationState.data),
    [visualizationState.data],
  );
  const airboxSettings = useMemo(
    () =>
      resolveVisualizationSettings(
        objectVisualizationSnapshot,
        AIRBOX_VISUALIZATION_TARGET,
        airboxBaseSettings,
      ),
    [airboxBaseSettings, objectVisualizationSnapshot],
  );
  const getPartSettings = useCallback(
    (part: Viewport3DMeshPart) =>
      resolveVisualizationSettings(
        objectVisualizationSnapshot,
        targetForMeshPart(part),
        fallbackSettings,
      ),
    [fallbackSettings, objectVisualizationSnapshot],
  );
  const getObjectSettings = useCallback(
    (object: Viewport3DPrimitiveObject) =>
      resolveVisualizationSettings(
        objectVisualizationSnapshot,
        {
          id: object.objectId,
          kind: "object",
          label: object.label,
        },
        fallbackSettings,
      ),
    [fallbackSettings, objectVisualizationSnapshot],
  );
  const fieldRenderOptions = useViewport3DFieldRenderOptions({
    airboxSettings,
    fallbackSettings,
    getPartSettings,
    maxAirboxVectorGlyphs,
    maxVectorGlyphs,
    topologyRenderModel,
    vectorColorMode,
    vectorDomain,
  });
  const mockField = commandState.mockField;
  // When mock animation is running, generate random unit-vector field data
  // instead of fetching from the API. The tick counter causes this memo to
  // re-run on every animation frame (~8 fps) so the viewport gets fresh data.
  const mockFieldVector = useMemo(() => {
    if (!mockField.running || !topologyRenderModel) return null;
    const pointCount = topologyRenderModel.nodeCount;
    if (pointCount === 0) return null;
    const tick = mockField.tick;
    const values = new Float64Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      const [x, y, z] = mockUnitVector(i, tick);
      values[i * 3] = x;
      values[i * 3 + 1] = y;
      values[i * 3 + 2] = z;
    }
    return {
      dtype: "float64" as const,
      grid: [pointCount, 1, 1] as [number, number, number],
      nComp: 3,
      pointCount,
      quantityId: "m",
      valueCount: pointCount * 3,
      values,
    };
  }, [mockField.running, mockField.tick, topologyRenderModel]);

  const fieldVectorEnabled =
    !mockField.running && viewport3DFieldRenderOptionsNeedFieldData(fieldRenderOptions);
  const fieldVector = useViewport3DFieldVector(
    quantityId,
    FULL_FIELD_QUERY,
    fieldVectorEnabled,
  );
  const effectiveFieldData = mockFieldVector ?? fieldVector.data;
  const fieldRenderModel = useMemo(
    () =>
      buildViewport3DFieldRenderModel(
        topologyRenderModel,
        effectiveFieldData,
        vectorScale,
        fieldRenderOptions,
      ),
    [fieldRenderOptions, effectiveFieldData, topologyRenderModel, vectorScale],
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
    diagnostics,
    domainId: domainMeta.data?.domain_id,
    domainSummary,
    fallbackSettings,
    fdmDomain,
    femDomain,
    fieldModel: fieldRenderModel,
    getObjectSettings,
    getPartSettings,
    hslReferenceVisible,
    magnetizationTexturePreviews,
    primitiveModel,
    quantityId,
    resourceFrameKey,
    selectedLabel,
    selectionBounds,
    status,
    topologyModel: topologyRenderModel,
    vectorColorMode,
    vectorStyle,
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
  const primitiveObjectIds =
    sceneProps.primitiveModel?.objects.map((object) => object.objectId).join(" ") ??
    "";
  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      data-primitive-object-count={sceneProps.primitiveModel?.objects.length ?? 0}
      data-primitive-object-ids={primitiveObjectIds}
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
          frameloop={VIEWPORT_3D_FRAMELOOP}
          gl={{
            alpha: false,
            antialias: true,
            powerPreference: "high-performance",
          }}
          onPointerMissed={onClearSelection}
        >
          <Viewport3DScene
            {...sceneProps}
            colors={colors}
          />
        </Canvas>
      ) : (
        <div className="fm-viewport-3d__placeholder">Preparing viewport</div>
      )}
    </section>
  );
}
