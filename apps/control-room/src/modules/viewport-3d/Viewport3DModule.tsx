"use client";

import { Canvas } from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useRef,
  type ComponentProps,
} from "react";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { useSelection } from "@/kernel/selection/useSelection";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import type { ModuleProps } from "@/kernel/types";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";
import {
  useVisualizationClientAck,
  useVisualizationClientAckSender,
} from "@/kernel/visualization/useVisualizationClientAck";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import { useViewport3DSceneModel } from "./hooks/useViewport3DSceneModel";
import {
  resolveViewport3DCameraFit,
  VIEWPORT_3D_WORLD_UP,
} from "./layers/CameraControls";
import { Viewport3DScene } from "./layers/Viewport3DScene";
import { Viewport3DCameraDialog } from "./components/Viewport3DCameraDialog";
import { Viewport3DSettingsDialog } from "./components/Viewport3DSettingsDialog";
import {
  type Viewport3DPartSelection,
} from "./viewport3dDomainAdapter";
import {
  useViewport3DResourceCounts,
  useViewport3DResourceTracker,
} from "./viewport3dDiagnostics";
import { createViewport3DEventManager } from "./viewport3dEventManager";
import {
  type Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { toCameraTuple } from "./viewport3dCameraModel";
import {
  DEFAULT_VIEWPORT_3D_CAMERA_STATE,
  viewport3dStore,
  useViewport3DCommandState,
} from "./viewport3dStore";
import type { MeshQualityColorMetric } from "./viewport3dQualityMapping";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";
import {
  configureViewport3DRenderer,
  getViewport3DVisualProfile,
  resolveViewport3DCanvasDpr,
  resolveViewport3DCanvasGlOptions,
} from "./viewport3dVisualProfile";

type Viewport3DSceneProps = ComponentProps<typeof Viewport3DScene>;

interface MeshQualityRange {
  max: number;
  min: number;
}

function formatLegendValue(value: number): string {
  return Number.isFinite(value) ? Number(value.toPrecision(4)).toString() : "unknown";
}

export function resolveViewport3DMeshQualityLegend(
  visible: boolean,
  metric: MeshQualityColorMetric,
  range: MeshQualityRange | null,
): string | null {
  if (!visible || !range) return null;
  const metricLabel = metric === "sicn" ? "SICN" : metric;
  return `Mesh quality ${metricLabel} ${formatLegendValue(range.min)} to ${formatLegendValue(range.max)}`;
}

interface Viewport3DFrameProps
  extends Omit<
    Viewport3DSceneProps,
    "colors" | "onVisualizationFrameCommitted"
  > {
  cameraDialogOpen: boolean;
  cameraDialogState: Viewport3DSceneProps["cameraState"];
  cameraResource: VisualizationStateResource["camera"] | null;
  clientReady: boolean;
  colors: Viewport3DSceneProps["colors"] | null;
  captureRevision: number;
  diagnostics: string;
  domainSummary: string;
  effectAntialias: boolean;
  kernel: ModuleProps["kernel"];
  meshQualityMetric: MeshQualityColorMetric;
  meshQualityRange: MeshQualityRange | null;
  onCameraPatch: (
    patch: NonNullable<VisualizationStatePatch["camera"]>,
  ) => void;
  onClearSelection: () => void;
  quantityId: string;
  selectedLabel: string;
  slotId: ModuleProps["slotId"];
  status: string;
  visualizationEffectiveRenderMode: string;
  visualizationError: string | null;
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
  const patchCameraState = useCallback(
    (patch: NonNullable<VisualizationStatePatch["camera"]>) => {
      kernel.visualizationSync.queuePatch({ camera: patch });
      if (patch.position && patch.target) {
        viewport3dStore.setCamera({
          position: toCameraTuple(patch.position),
          target: toCameraTuple(patch.target),
          up: toCameraTuple(patch.up ?? VIEWPORT_3D_WORLD_UP),
        });
      }
      if (patch.projection) {
        viewport3dStore.setCameraProjection(patch.projection);
      }
    },
    [kernel.visualizationSync],
  );
  const saveCameraState = useCallback(
    (camera: {
      position: [number, number, number];
      target: [number, number, number];
      up?: [number, number, number];
    }) => {
      viewport3dStore.setCamera({
        position: camera.position,
        target: camera.target,
        up: camera.up ?? VIEWPORT_3D_WORLD_UP,
      });
    },
    [],
  );

  return (
    <WorkspaceRenderProfiler id="Viewport3DModule">
      <Viewport3DFrame
      {...sceneModel}
      clientReady={clientReady}
      colors={colors}
      cameraDialogOpen={commandState.widgets.cameraDialogOpen}
      cameraDialogState={commandState.camera}
      effectAntialias={commandState.widgets.effectAntialias}
      fitRevision={commandState.fitRevision}
      kernel={kernel}
      onCameraPatch={patchCameraState}
      onClearSelection={clear}
      onSelectDomain={onSelectDomain}
      onSelectObject={onSelectObject}
      onSelectPart={onSelectPart}
      onCameraChange={saveCameraState}
      captureRevision={commandState.captureRevision}
      resetCameraRevision={commandState.resetCameraRevision}
      rotationMode={commandState.widgets.rotationMode}
      slotId={slotId}
      tracker={tracker}
      viewCubeVisible={commandState.widgets.viewCubeVisible}
      />
    </WorkspaceRenderProfiler>
  );
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

function Viewport3DFrame({
  captureRevision,
  cameraDialogOpen,
  cameraDialogState,
  cameraResource,
  clientReady,
  colors,
  diagnostics,
  domainSummary,
  effectAntialias,
  kernel,
  meshQualityMetric,
  meshQualityRange,
  onCameraPatch,
  onClearSelection,
  quantityId,
  selectedLabel,
  slotId,
  status,
  visualizationEffectiveRenderMode,
  visualizationError,
  ...sceneProps
}: Viewport3DFrameProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const primitiveObjectIds =
    sceneProps.primitiveModel?.objects
      .map((object) => object.objectId)
      .join(" ") ?? "";
  const visualProfile = getViewport3DVisualProfile(
    sceneProps.visualProfileId,
  );
  const canvasDpr = resolveViewport3DCanvasDpr({
    devicePixelRatio:
      typeof window === "undefined" ? 1 : window.devicePixelRatio,
    profile: visualProfile,
  });
  const canvasGlOptions = resolveViewport3DCanvasGlOptions(
    visualProfile,
    effectAntialias,
  );
  const sendVisualizationAck = useVisualizationClientAckSender({ api: kernel.api });
  const initialCameraFit = resolveViewport3DCameraFit(null);
  const discretizationKind = sceneProps.fdmDomain
    ? "FDM"
    : sceneProps.femDomain.magneticParts.length > 0
      ? "FEM"
      : null;
  const meshQualityLegend = resolveViewport3DMeshQualityLegend(
    sceneProps.meshQualityOverlayVisible,
    meshQualityMetric,
    meshQualityRange,
  );
  const onVisualizationFrameCommitted = useCallback((revision: number) => {
    sendVisualizationAck({
      effectiveRenderMode: visualizationEffectiveRenderMode,
      enabled: clientReady && !visualizationError,
      revision,
      status: "rendered",
      viewportId: slotId,
    });
  }, [
    clientReady,
    sendVisualizationAck,
    slotId,
    visualizationEffectiveRenderMode,
    visualizationError,
  ]);
  useVisualizationClientAck({
    api: kernel.api,
    effectiveRenderMode: visualizationEffectiveRenderMode,
    enabled: clientReady,
    error: visualizationError,
    revision: sceneProps.visualizationRevision,
    status: visualizationError ? "failed" : "applied",
    viewportId: slotId,
  });
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
        {meshQualityLegend ? <span>{meshQualityLegend}</span> : null}
        <span>{status}</span>
        <span>{diagnostics}</span>
      </div>
      {clientReady && colors ? (
        <Canvas
          camera={{
            far: initialCameraFit.far,
            fov: 42,
            near: initialCameraFit.near,
            position: DEFAULT_VIEWPORT_3D_CAMERA_STATE.position,
            up: VIEWPORT_3D_WORLD_UP,
          }}
          className="fm-viewport-3d__canvas"
          dpr={canvasDpr}
          events={createViewport3DEventManager}
          frameloop={VIEWPORT_3D_FRAMELOOP}
          gl={canvasGlOptions}
          key={`viewport-3d-canvas-${visualProfile.id}-${effectAntialias ? "aa" : "no-aa"}`}
          onCreated={({ gl }) => {
            canvasRef.current = gl.domElement;
            configureViewport3DRenderer(gl, visualProfile);
          }}
          onPointerMissed={onClearSelection}
        >
          <Viewport3DScene
            {...sceneProps}
            colors={colors}
            onVisualizationFrameCommitted={onVisualizationFrameCommitted}
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
      <Viewport3DCameraDialog
        cameraProjection={sceneProps.cameraProjection}
        cameraResource={cameraResource}
        cameraState={cameraDialogState}
        onCameraPatch={onCameraPatch}
        onOpenChange={(open) => viewport3dStore.setCameraDialogOpen(open)}
        open={cameraDialogOpen}
      />
      <Viewport3DSettingsDialog />
    </section>
  );
}
