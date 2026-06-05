"use client";

import { Canvas } from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  memo,
  type ComponentProps,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { viewport3DOrbitDebugEnabledFromBrowserConfig } from "@/kernel/browserFullmagConfig";
import type { MeshSizeHistogramHighlight } from "@/kernel/events/eventTypes";
import { useMeshHistogramBinElementsResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  selectionSnapshotEquals,
  useSelectionActions,
  useSelectionSelector,
} from "@/kernel/selection/useSelection";
import { WorkspaceRenderProfiler } from "@/kernel/performance/reactRenderProfiler";
import type { ModuleProps } from "@/kernel/types";
import {
  useVisualizationClientAck,
  useVisualizationClientAckSender,
} from "@/kernel/visualization/useVisualizationClientAck";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import { useViewport3DColors } from "./hooks/useViewport3DColors";
import {
  useViewport3DSceneModel,
  type Viewport3DFieldDataIssue,
} from "./hooks/useViewport3DSceneModel";
import {
  resolveViewport3DCameraFit,
  normalizeViewport3DOrbitDebugAngles,
  shouldApplyViewport3DOrbitDebugAngles,
  type Viewport3DCameraChange,
  type Viewport3DOrbitDebugAngles,
  VIEWPORT_3D_WORLD_UP,
  VIEWPORT_3D_ORBIT_DEBUG_LIMITS,
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
  formatViewport3DInspectComponents,
  type Viewport3DInspectSample,
  type Viewport3DInspectScreenPosition,
} from "./viewport3dInspect";
import {
  type Viewport3DPrimitiveObject,
} from "./viewport3dPrimitiveModel";
import { toCameraTuple } from "./viewport3dCameraModel";
import {
  EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
  resolveViewport3DRefreshCountdownDisplay,
  updateViewport3DRefreshSample,
  type Viewport3DFieldRefreshState,
} from "./viewport3dRefreshCountdown";
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

interface Viewport3DInspectHover {
  inspectRevision: number;
  sample: Viewport3DInspectSample;
  screenPosition: Viewport3DInspectScreenPosition;
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

function useMeshSizeHistogramHighlight(
  bus: ModuleProps["kernel"]["bus"],
): MeshSizeHistogramHighlight | null {
  const [highlight, setHighlight] =
    useState<MeshSizeHistogramHighlight | null>(null);
  useEffect(
    () =>
      bus.on("viewport:mesh-size-bin-hovered", (event) => {
        setHighlight(event.highlight);
      }),
    [bus],
  );
  return highlight;
}

interface Viewport3DFrameProps
  extends Omit<
    Viewport3DSceneProps,
    | "colors"
    | "onOrbitDebugAnglesChange"
    | "onVisualizationFrameCommitted"
    | "orbitDebugAngles"
    | "orbitDebugCommitRevision"
    | "orbitDebugRevision"
  > {
  cameraDialogOpen: boolean;
  cameraDialogState: Viewport3DSceneProps["cameraState"];
  cameraResource: VisualizationStateResource["camera"] | null;
  clientReady: boolean;
  colors: Viewport3DSceneProps["colors"] | null;
  captureRevision: number;
  diagnostics: string;
  domainSummary: string;
  fieldDataIssue: Viewport3DFieldDataIssue | null;
  fieldRefresh: Viewport3DFieldRefreshState;
  inspectRevision: number;
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
  const selection = useSelectionSelector((state) => state, {
    isEqual: selectionSnapshotEquals,
  });
  const { select, clear } = useSelectionActions(moduleId);
  const tracker = useViewport3DResourceTracker();
  const resourceCounts = useViewport3DResourceCounts(tracker);
  const commandState = useViewport3DCommandState();
  const meshSizeHighlight = useMeshSizeHistogramHighlight(kernel.bus);
  const meshHistogramBinElements = useMeshHistogramBinElementsResource(
    meshSizeHighlight?.resource ?? null,
  );
  const { domainId, ...sceneModel } = useViewport3DSceneModel({
    commandState,
    colors,
    meshSizeHighlight,
    meshSizeHighlightSelection: meshSizeHighlight
      ? meshHistogramBinElements.data
      : null,
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
      kernel.cameraRegistry.patchCamera(patch);
      if (patch.position && patch.target) {
        const nextCamera = {
          position: toCameraTuple(patch.position),
          target: toCameraTuple(patch.target),
          up: toCameraTuple(patch.up ?? VIEWPORT_3D_WORLD_UP),
        };
        if (patch.projection || "orthographic_scale" in patch) {
          viewport3dStore.setCameraView({
            camera: nextCamera,
            orthographicScale: patch.orthographic_scale,
            projection:
              patch.projection ??
              viewport3dStore.getSnapshot().widgets.cameraProjection,
          });
        } else {
          viewport3dStore.setCamera(nextCamera);
        }
      }
      if (patch.projection) {
        viewport3dStore.setCameraProjection(patch.projection);
      }
      if ("orthographic_scale" in patch) {
        viewport3dStore.setCameraOrthographicScale(patch.orthographic_scale ?? null);
      }
    },
    [kernel.cameraRegistry],
  );
  const saveCameraState = useCallback(
    (camera: Viewport3DCameraChange) => {
      const nextCamera = {
        position: camera.position,
        target: camera.target,
        up: camera.up ?? VIEWPORT_3D_WORLD_UP,
      };
      if (
        camera.projection !== undefined ||
        camera.orthographicScale !== undefined
      ) {
        viewport3dStore.setCameraView({
          camera: nextCamera,
          orthographicScale: camera.orthographicScale ?? null,
          projection:
            camera.projection ??
            viewport3dStore.getSnapshot().widgets.cameraProjection,
        });
      } else {
        viewport3dStore.setCamera(nextCamera);
      }
    },
    [],
  );
  const beginCameraInteraction = useCallback(() => {
    kernel.cameraRegistry.beginInteraction();
  }, [kernel.cameraRegistry]);
  const endCameraInteraction = useCallback(() => {
    kernel.cameraRegistry.endInteraction();
  }, [kernel.cameraRegistry]);

  return (
    <WorkspaceRenderProfiler id="Viewport3DModule">
      <Viewport3DFrame
      {...sceneModel}
      clientReady={clientReady}
      colors={colors}
      cameraDialogOpen={commandState.widgets.cameraDialogOpen}
      cameraDialogState={commandState.camera}
      dimensionFrameDensity={commandState.widgets.dimensionFrameDensity}
      dimensionFrameMode={commandState.widgets.dimensionFrameMode}
      fitRevision={commandState.fitRevision}
      kernel={kernel}
      onCameraPatch={patchCameraState}
      onClearSelection={clear}
      onSelectDomain={onSelectDomain}
      onSelectObject={onSelectObject}
      onSelectPart={onSelectPart}
      onCameraChange={saveCameraState}
      onCameraInteractionEnd={endCameraInteraction}
      onCameraInteractionStart={beginCameraInteraction}
      captureRevision={commandState.captureRevision}
      inspectEnabled={commandState.widgets.inspectEnabled}
      inspectQuantityId={sceneModel.quantityId}
      inspectRevision={commandState.widgets.inspectRevision}
      requestDiagnostics={kernel.diagnostics}
      resetCameraRevision={commandState.resetCameraRevision}
      rotationMode={commandState.widgets.rotationMode}
      scaleLabelsVisible={commandState.widgets.scaleLabelsVisible}
      scaleUnitMode={commandState.widgets.scaleUnitMode}
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
  select: ReturnType<typeof useSelectionActions>["select"];
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

const Viewport3DFrame = memo(function Viewport3DFrame({
  captureRevision,
  cameraDialogOpen,
  cameraDialogState,
  cameraResource,
  clientReady,
  colors,
  diagnostics,
  domainSummary,
  fieldDataIssue,
  fieldRefresh,
  inspectRevision,
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
  const canvasGlOptions = resolveViewport3DCanvasGlOptions(visualProfile);
  const orbitDebugEnabled = viewport3DOrbitDebugEnabledFromBrowserConfig();
  const [orbitDebugAngles, setOrbitDebugAngles] =
    useState<Viewport3DOrbitDebugAngles>(() =>
      normalizeViewport3DOrbitDebugAngles(null),
    );
  const [orbitDebugRevision, setOrbitDebugRevision] = useState(0);
  const [orbitDebugCommitRevision, setOrbitDebugCommitRevision] = useState(0);
  const [dismissedResourceIssueKey, setDismissedResourceIssueKey] =
    useState<string | null>(null);
  const [inspectHover, setInspectHover] =
    useState<Viewport3DInspectHover | null>(null);
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
  const resourceIssueOpen = Boolean(
    fieldDataIssue && dismissedResourceIssueKey !== fieldDataIssue.key,
  );
  const setResourceIssueOpen = useCallback(
    (open: boolean) => {
      if (open) {
        setDismissedResourceIssueKey(null);
        return;
      }
      setDismissedResourceIssueKey(fieldDataIssue?.key ?? null);
    },
    [fieldDataIssue?.key],
  );
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
  const syncOrbitDebugAngles = useCallback(
    (angles: Viewport3DOrbitDebugAngles) => {
      const nextAngles = normalizeViewport3DOrbitDebugAngles(angles);
      setOrbitDebugAngles((currentAngles) =>
        shouldApplyViewport3DOrbitDebugAngles(currentAngles, nextAngles)
          ? nextAngles
          : currentAngles,
      );
    },
    [],
  );
  const applyOrbitDebugAngles = useCallback(
    (angles: Viewport3DOrbitDebugAngles) => {
      const nextAngles = normalizeViewport3DOrbitDebugAngles(angles);
      setOrbitDebugAngles(nextAngles);
      setOrbitDebugRevision((revision) => revision + 1);
    },
    [],
  );
  const commitOrbitDebugAngles = useCallback(() => {
    setOrbitDebugCommitRevision((revision) => revision + 1);
  }, []);
  const clearInspectHover = useCallback(() => {
    setInspectHover(null);
  }, []);
  const updateInspectHover = useCallback(
    (
      sample: Viewport3DInspectSample,
      screenPosition: Viewport3DInspectScreenPosition,
    ) => {
      setInspectHover({ inspectRevision, sample, screenPosition });
    },
    [inspectRevision],
  );
  const visibleInspectHover =
    sceneProps.inspectEnabled &&
    inspectHover?.inspectRevision === inspectRevision &&
    inspectHover.sample.quantityId === quantityId
      ? inspectHover
      : null;

  return (
    <section
      aria-label="3D viewport"
      className="fm-viewport-3d"
      data-camera-position={sceneProps.cameraState.position.join(" ")}
      data-camera-projection={sceneProps.cameraProjection}
      data-camera-target={sceneProps.cameraState.target.join(" ")}
      data-camera-up={sceneProps.cameraState.up.join(" ")}
      data-inspect-enabled={sceneProps.inspectEnabled ? "true" : "false"}
      data-primitive-object-count={sceneProps.primitiveModel?.objects.length ?? 0}
      data-primitive-object-ids={primitiveObjectIds}
      data-topology-freshness={sceneProps.topologyFreshness}
      data-visual-profile-id={sceneProps.visualProfileId}
      onPointerDown={() => kernel.layout.setFocusedSlot(slotId)}
    >
      <div aria-live="polite" className="fm-viewport-3d__hud">
        <span>{quantityId}</span>
        <span>{selectedLabel}</span>
        <span>{domainSummary}</span>
        {meshQualityLegend ? <span>{meshQualityLegend}</span> : null}
        {sceneProps.meshSizeHighlightModel ? (
          <span>
            {sceneProps.meshSizeHighlightModel.label} ·{" "}
            {sceneProps.meshSizeHighlightModel.sampledElementCount.toLocaleString(
              "en-US",
            )}
            /
            {sceneProps.meshSizeHighlightModel.matchedElementCount.toLocaleString(
              "en-US",
            )} highlighted
          </span>
        ) : null}
        <span>{status}</span>
        <Viewport3DFieldRefreshCountdown refresh={fieldRefresh} />
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
          key={`viewport-3d-canvas-${visualProfile.id}`}
          onCreated={({ gl }) => {
            canvasRef.current = gl.domElement;
            configureViewport3DRenderer(gl, visualProfile);
          }}
          onPointerMissed={() => {
            clearInspectHover();
            onClearSelection();
          }}
        >
          <Viewport3DScene
            {...sceneProps}
            colors={colors}
            orbitDebugAngles={orbitDebugAngles}
            orbitDebugCommitRevision={orbitDebugCommitRevision}
            orbitDebugRevision={orbitDebugRevision}
            onOrbitDebugAnglesChange={
              orbitDebugEnabled ? syncOrbitDebugAngles : undefined
            }
            onInspectClear={clearInspectHover}
            onInspectSample={updateInspectHover}
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
      {visibleInspectHover ? (
        <Viewport3DInspectTooltip hover={visibleInspectHover} />
      ) : null}
      {orbitDebugEnabled && clientReady && colors ? (
        <Viewport3DOrbitDebugPanel
          angles={orbitDebugAngles}
          onAnglesChange={applyOrbitDebugAngles}
          onAnglesCommit={commitOrbitDebugAngles}
          onInteractionStart={sceneProps.onCameraInteractionStart}
        />
      ) : null}
      <Viewport3DCameraDialog
        cameraOrthographicScale={sceneProps.cameraOrthographicScale}
        cameraProjection={sceneProps.cameraProjection}
        cameraResource={cameraResource}
        cameraState={cameraDialogState}
        onCameraPatch={onCameraPatch}
        onOpenChange={(open) => viewport3dStore.setCameraDialogOpen(open)}
        open={cameraDialogOpen}
      />
      <Viewport3DSettingsDialog />
      <Viewport3DResourceIssueDialog
        issue={fieldDataIssue}
        open={Boolean(fieldDataIssue && resourceIssueOpen)}
        onOpenChange={setResourceIssueOpen}
      />
    </section>
  );
});

const INSPECT_TOOLTIP_OFFSET_PX = 14;

const Viewport3DInspectTooltip = memo(function Viewport3DInspectTooltip({
  hover,
}: {
  hover: Viewport3DInspectHover;
}) {
  const { sample, screenPosition } = hover;
  const lines =
    sample.status === "ready"
      ? formatViewport3DInspectComponents(sample)
      : [sample.message];
  return (
    <div
      aria-live="polite"
      className="fm-viewport-3d__inspect-tooltip"
      role="status"
      style={{
        left: screenPosition.x + INSPECT_TOOLTIP_OFFSET_PX,
        top: screenPosition.y + INSPECT_TOOLTIP_OFFSET_PX,
      }}
    >
      <div className="fm-viewport-3d__inspect-tooltip-header">
        <span>{sample.quantityId}</span>
        <span>{sample.targetLabel}</span>
      </div>
      <div className="fm-viewport-3d__inspect-tooltip-values">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
});

const VIEWPORT_3D_REFRESH_COUNTDOWN_TICK_MS = 100;

interface Viewport3DRefreshCountdownState {
  nowMs: number;
  sample: typeof EMPTY_VIEWPORT_3D_REFRESH_SAMPLE;
}

interface Viewport3DRefreshCountdownTick {
  nowMs: number;
  revision: Viewport3DFieldRefreshState["revision"];
  status: Viewport3DFieldRefreshState["status"];
}

const INITIAL_VIEWPORT_3D_REFRESH_COUNTDOWN: Viewport3DRefreshCountdownState = {
  nowMs: 0,
  sample: EMPTY_VIEWPORT_3D_REFRESH_SAMPLE,
};

function reduceViewport3DRefreshCountdown(
  current: Viewport3DRefreshCountdownState,
  tick: Viewport3DRefreshCountdownTick,
): Viewport3DRefreshCountdownState {
  return {
    nowMs: tick.nowMs,
    sample: updateViewport3DRefreshSample(current.sample, tick),
  };
}

const Viewport3DFieldRefreshCountdown = memo(
  function Viewport3DFieldRefreshCountdown({
    refresh,
  }: {
    refresh: Viewport3DFieldRefreshState;
  }) {
    const [countdown, dispatchCountdownTick] = useReducer(
      reduceViewport3DRefreshCountdown,
      INITIAL_VIEWPORT_3D_REFRESH_COUNTDOWN,
    );

    useEffect(() => {
      if (!refresh.enabled) {
        return;
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const tick = () => {
        const nowMs = Date.now();
        dispatchCountdownTick({
          nowMs,
          revision: refresh.revision,
          status: refresh.status,
        });
        timeoutId = setTimeout(tick, VIEWPORT_3D_REFRESH_COUNTDOWN_TICK_MS);
      };
      const initialTimeoutId = setTimeout(tick, 0);
      return () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
        clearTimeout(initialTimeoutId);
      };
    }, [refresh.enabled, refresh.revision, refresh.status]);

    const display = resolveViewport3DRefreshCountdownDisplay({
      enabled: refresh.enabled,
      nowMs: countdown.nowMs,
      sample: countdown.sample,
      status: refresh.status,
    });
    if (!display) return null;

    const progressDegrees = `${Math.round(display.progress * 360)}deg`;
    const style = {
      "--fm-refresh-progress": progressDegrees,
    } as CSSProperties;

    return (
      <span
        aria-label={`${display.ariaLabel} for ${refresh.quantityId}`}
        className="fm-viewport-3d__refresh-countdown"
        data-pulse-id={countdown.sample.pulseId}
        data-refresh-state={display.state}
        data-resource-key={refresh.resourceKey}
        data-revision={refresh.revision ?? "none"}
        style={style}
      >
        <span
          aria-hidden="true"
          className="fm-viewport-3d__refresh-countdown-ring"
        >
          <span className="fm-viewport-3d__refresh-countdown-core" />
        </span>
        <span className="fm-viewport-3d__refresh-countdown-copy">
          <span className="fm-viewport-3d__refresh-countdown-title">
            {display.title}
          </span>
          <span className="fm-viewport-3d__refresh-countdown-detail">
            {display.detail}
          </span>
        </span>
      </span>
    );
  },
);

function Viewport3DResourceIssueDialog({
  issue,
  onOpenChange,
  open,
}: {
  issue: Viewport3DFieldDataIssue | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-viewport-field-data-issue-description">
        <DialogHeader>
          <DialogTitle>Magnetic field data unavailable</DialogTitle>
          <DialogDescription id="fm-viewport-field-data-issue-description">
            {issue
              ? `Quantity ${issue.quantityId} cannot be rendered because ${issue.message}`
              : "The active field resource cannot be rendered."}
          </DialogDescription>
        </DialogHeader>
        {issue ? (
          <div className="fm-dialog__body">
            <dl className="fm-dialog__details">
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Resource</dt>
                <dd className="fm-dialog__details-value">{issue.resourceKey}</dd>
              </div>
              <div className="fm-dialog__details-row">
                <dt className="fm-dialog__details-label">Reason</dt>
                <dd className="fm-dialog__details-value">{issue.message}</dd>
              </div>
            </dl>
          </div>
        ) : null}
        <DialogFooter>
          {issue ? (
            <Button type="button" variant="secondary" onClick={issue.retry}>
              Retry
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button type="button" variant="primary">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Viewport3DOrbitDebugPanel({
  angles,
  onAnglesChange,
  onAnglesCommit,
  onInteractionStart,
}: {
  angles: Viewport3DOrbitDebugAngles;
  onAnglesChange: (angles: Viewport3DOrbitDebugAngles) => void;
  onAnglesCommit: () => void;
  onInteractionStart?: () => void;
}) {
  const updateAngle = useCallback(
    (axis: keyof Viewport3DOrbitDebugAngles, value: string) => {
      onAnglesChange(
        normalizeViewport3DOrbitDebugAngles({
          ...angles,
          [axis]: Number(value),
        }),
      );
    },
    [angles, onAnglesChange],
  );

  function beginInputInteraction(
    event: ReactPointerEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onInteractionStart?.();
  }

  function beginKeyboardInteraction(
    event: ReactFocusEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onInteractionStart?.();
  }

  function endInputInteraction(
    event:
      | ReactFocusEvent<HTMLInputElement>
      | ReactPointerEvent<HTMLInputElement>,
  ): void {
    event.stopPropagation();
    onAnglesCommit();
  }

  return (
    <aside
      aria-label="Temporary orbit controls"
      className="fm-viewport-3d__orbit-debug"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="fm-viewport-3d__orbit-debug-header">
        <strong>Orbit Debug</strong>
        <span>rad</span>
      </div>
      <Viewport3DOrbitDebugSlider
        label="Azimuth"
        max={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMax}
        min={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.azimuthMin}
        value={angles.azimuth}
        onChange={(value) => updateAngle("azimuth", value)}
        onInteractionBegin={beginKeyboardInteraction}
        onInteractionEnd={endInputInteraction}
        onInteractionStart={beginInputInteraction}
      />
      <Viewport3DOrbitDebugSlider
        label="Polar"
        max={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMax}
        min={VIEWPORT_3D_ORBIT_DEBUG_LIMITS.polarMin}
        value={angles.polar}
        onChange={(value) => updateAngle("polar", value)}
        onInteractionBegin={beginKeyboardInteraction}
        onInteractionEnd={endInputInteraction}
        onInteractionStart={beginInputInteraction}
      />
    </aside>
  );
}

function Viewport3DOrbitDebugSlider({
  label,
  max,
  min,
  onChange,
  onInteractionBegin,
  onInteractionEnd,
  onInteractionStart,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  onInteractionBegin: (event: ReactFocusEvent<HTMLInputElement>) => void;
  onInteractionEnd: (
    event:
      | ReactFocusEvent<HTMLInputElement>
      | ReactPointerEvent<HTMLInputElement>,
  ) => void;
  onInteractionStart: (event: ReactPointerEvent<HTMLInputElement>) => void;
  value: number;
}) {
  return (
    <label className="fm-viewport-3d__orbit-debug-field">
      <span>{label}</span>
      <output>{value.toFixed(3)}</output>
      <input
        max={max}
        min={min}
        step="0.001"
        type="range"
        value={value}
        onBlur={onInteractionEnd}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onInteractionBegin}
        onPointerCancel={onInteractionEnd}
        onPointerDown={onInteractionStart}
        onPointerUp={onInteractionEnd}
      />
    </label>
  );
}
