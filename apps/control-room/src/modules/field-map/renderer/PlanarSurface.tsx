"use client";

import {
  Children,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  planarToolStore,
  usePlanarActiveTool,
  type PlanarUvRect,
} from "@/kernel/visualization/planarToolStore";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";

import type { PlanarRenderEvidence } from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { resolvePlanarAxes } from "../model/planarAxisModel";
import type { PlanarCompositionFrame } from "../model/planarCompositionFrame";
import { normalizeUvRect } from "../model/planarToolGeometry";
import {
  isPlanarDragTool,
  planarToolKeyAction,
  resolvePlanarCropCommit,
  resolvePlanarToolDrag,
  type PlanarDragTool,
} from "../model/planarToolGestures";
import { PlanarAxes } from "./PlanarAxes";
import { PlanarToolOverlay } from "./PlanarToolOverlay";
import {
  fitPlanarInteraction,
  panPlanarInteraction,
  zoomPlanarInteractionAt,
  type PlanarInteraction,
} from "./planarInteraction";
import { usePlanarSurfaceRenderer } from "./usePlanarSurfaceRenderer";

/** Line-profile segment in frame coordinates (metres). */
export interface PlanarProfileSegment {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

interface PlanarSurfaceProps {
  model: FieldMapRenderModel;
  onInteraction?: (interaction: PlanarInteraction) => void;
  onPin?: (u: number, v: number) => void;
  /** Shift + drag draws a line-profile segment; Escape clears it (F6 B1). */
  onProfileSegment?: (segment: PlanarProfileSegment | null) => void;
  profileSegment?: PlanarProfileSegment | null;
  onRenderEvidence?: (evidence: PlanarRenderEvidence) => void;
  probeOverlay?: ReactNode;
  /** Additional composited fields; children are renderer-owned and non-interactive. */
  fieldOverlayContent?: ReactNode;
  /** Full frame of the sample (`meta.frame.full_bounds_uv_m`); a crop is clipped to it. */
  cropFullBounds?: readonly [number, number, number, number];
  /** Commits a crop rectangle (already clipped to `cropFullBounds`). */
  onCropCommit?: (rect: PlanarUvRect) => void;
  /** A pinned node readout is open; Escape in the inspect tool closes it. */
  pinnedOpen?: boolean;
  onClosePinned?: () => void;
  /**
   * Receives the displayed composition frame. Consumed by
   * `PlanarCompositionBuffers`, which renders this surface; ignored here.
   */
  onCompositionFrame?: (frame: PlanarCompositionFrame) => void;
  /**
   * The toolbar legend toggle for the field-layer legends. Consumed by
   * `PlanarCompositionBuffers`; ignored here.
   */
  legendsVisible?: boolean;
}

/** CSS size of a canvas at the moment it is read. */
function measuredCanvasSize(canvas: HTMLCanvasElement): { height: number; width: number } {
  const rect = canvas.getBoundingClientRect();
  return { height: rect.height, width: rect.width };
}

export function PlanarSurface({
  model,
  onInteraction,
  onPin,
  onProfileSegment,
  onRenderEvidence,
  probeOverlay,
  fieldOverlayContent,
  profileSegment = null,
  cropFullBounds,
  onCropCommit,
  pinnedOpen = false,
  onClosePinned,
}: PlanarSurfaceProps) {
  const activeTool = usePlanarActiveTool();
  const segmentDragRef = useRef<{ pointerId: number; u0: number; v0: number } | null>(null);
  const toolDragRef = useRef<{
    tool: PlanarDragTool;
    pointerId: number;
    start: { u_m: number; v_m: number };
    startClient: readonly [number, number];
  } | null>(null);
  const [draftSegment, setDraftSegment] = useState<PlanarProfileSegment | null>(null);
  const [zoomBox, setZoomBox] = useState<PlanarUvRect | null>(null);
  const shownSegment = draftSegment ?? profileSegment;
  const hasFieldOverlayContent = Children.count(fieldOverlayContent) > 0;
  const hoverFrameRef = useRef<number | null>(null);
  const hoverPointerRef = useRef<readonly [number, number] | null>(null);
  const interactionRef = useRef<PlanarInteraction>(model.interaction);
  const dragRef = useRef<{ pointerId: number; u: number; v: number } | null>(null);
  const pointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const pinchRef = useRef<{
    anchorU: number;
    anchorV: number;
    distance: number;
    interaction: PlanarInteraction;
  } | null>(null);
  const gestureMovedRef = useRef(false);
  const {
    canvasRef,
    drawOverlayRef,
    modelRef,
    overlayRef,
    plotSize,
    renderStateRef,
  } = usePlanarSurfaceRenderer(model, onRenderEvidence);
  const axisFrame = useMemo(() => ({
    normal: model.frame.normal,
    origin: model.frame.origin,
    uAxis: model.frame.uAxis,
    vAxis: model.frame.vAxis,
  }), [model.frame]);
  const axes = useMemo(
    () => resolvePlanarAxes(
      axisFrame,
      model.bounds,
      model.viewport,
      plotSize.width,
      plotSize.height,
    ),
    [axisFrame, model.bounds, model.viewport, plotSize.height, plotSize.width],
  );

  useEffect(() => {
    interactionRef.current = model.interaction;
  }, [model.interaction]);

  // The cursor position belongs to this surface: clear it when it unmounts.
  useEffect(() => () => {
    if (hoverFrameRef.current !== null && hoverFrameRef.current !== -1) {
      cancelAnimationFrame(hoverFrameRef.current);
    }
    hoverFrameRef.current = null;
    planarToolStore.setCursorUv(null);
  }, []);

  // The axis crosshair follows the probes layer; the cursor readout does not.
  useEffect(() => {
    if (model.layers.probes) return;
    renderStateRef.current.axisPointer = null;
    drawOverlayRef.current();
  }, [drawOverlayRef, model.layers.probes, renderStateRef]);

  // The plot area is a size container so the canvas keeps the physical
  // u:v aspect ratio whichever dimension (width or height) is limiting.
  const aspect = Math.abs((model.bounds[1] - model.bounds[0]) / (model.bounds[3] - model.bounds[2])) || 1;
  const summaryId = useId();
  const length = (metres: number) =>
    formatValueWithUnit(metres * axes.displayLengthUnit.scale, axes.displayLengthUnit.symbol);
  const fullBounds = cropFullBounds ?? model.bounds;
  const cropDraft = useCropDraft();
  const cropCommit = resolvePlanarCropCommit({
    canvas: plotSize,
    draft: cropDraft,
    fullBounds,
    viewport: model.viewport,
  });
  // Measured at commit time: the observed plot size can lag a resize.
  const commitCrop = (canvas: HTMLCanvasElement | null) => {
    const commit = resolvePlanarCropCommit({
      canvas: canvas ? measuredCanvasSize(canvas) : plotSize,
      draft: planarToolStore.getSnapshot().cropDraft,
      fullBounds,
      viewport: model.viewport,
    });
    if (!commit.rect || !onCropCommit) return;
    onCropCommit(commit.rect);
    planarToolStore.setActiveTool("navigate");
  };
  const summary = [
    `2D field map, ${axes.horizontal.label} from ${length(axes.horizontal.rangeMetres[0])} to ${length(axes.horizontal.rangeMetres[1])}`,
    `${axes.vertical.label} from ${length(axes.vertical.rangeMetres[0])} to ${length(axes.vertical.rangeMetres[1])}`,
    model.directionVectors
      ? "coloured by vector direction"
      : model.range
        ? `colour range ${formatValueWithUnit(model.range.min * model.display.probeScale, model.display.legendUnit)} to ${formatValueWithUnit(model.range.max * model.display.probeScale, model.display.legendUnit)}`
        : "colour range unavailable",
    "Arrow keys pan, plus and minus zoom, 0 fits, Enter pins a probe or applies a crop, Shift and drag draws a line profile, Escape cancels the current tool.",
  ].join("; ");
  return (
    <div className="fm-field-map__plot-area">
      <div
        className="fm-field-map__canvas-stack"
        style={{ "--fm-planar-aspect": String(aspect) } as CSSProperties}
      >
        <PlanarAxes
          bounds={model.bounds}
          frame={axisFrame}
          plotSize={plotSize}
          viewport={model.viewport}
        />
        <canvas
          ref={canvasRef}
          aria-describedby={summaryId}
          aria-label="Planar scalar field"
          className="fm-field-map__canvas"
          role="img"
          data-probes-enabled={String(model.layers.probes)}
          // Keyboard pan, zoom and fit must stay reachable without probes.
          tabIndex={0}
          onClick={(event) => {
            if (gestureMovedRef.current) {
              gestureMovedRef.current = false;
              return;
            }
            if (activeTool !== "inspect" && (activeTool !== "navigate" || !model.layers.probes)) return;
            const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
            onPin?.(u, v);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && profileSegment) {
              event.preventDefault();
              onProfileSegment?.(null);
              return;
            }
            const toolState = planarToolStore.getSnapshot();
            const toolAction = planarToolKeyAction(event.key, { ...toolState, pinned: pinnedOpen });
            if (toolAction) {
              event.preventDefault();
              if (toolAction === "commit-crop") commitCrop(event.currentTarget);
              else if (toolAction === "cancel-crop") planarToolStore.setCropDraft(null);
              else if (toolAction === "clear-measure") planarToolStore.setMeasure(null);
              else if (toolAction === "close-pinned") onClosePinned?.();
              // Esc returns to the navigate tool (plan 2.2).
              else planarToolStore.setActiveTool("navigate");
              return;
            }
            if (event.key === "0") {
              event.preventDefault();
              interactionRef.current = fitPlanarInteraction();
              onInteraction?.(interactionRef.current);
              return;
            }
            if (event.key === "+" || event.key === "-") {
              event.preventDefault();
              interactionRef.current = zoomPlanarInteractionAt(
                model.bounds,
                interactionRef.current,
                model.boundsCenter[0],
                model.boundsCenter[1],
                interactionRef.current.zoom * (event.key === "+" ? 1.25 : 0.8),
              );
              onInteraction?.(interactionRef.current);
              return;
            }
            if (event.key.startsWith("Arrow")) {
              event.preventDefault();
              const spanU = (model.bounds[1] - model.bounds[0]) / interactionRef.current.zoom;
              const spanV = (model.bounds[3] - model.bounds[2]) / interactionRef.current.zoom;
              const delta = event.key === "ArrowLeft" ? [-spanU / 10, 0]
                : event.key === "ArrowRight" ? [spanU / 10, 0]
                  : event.key === "ArrowUp" ? [0, spanV / 10]
                    : [0, -spanV / 10];
              interactionRef.current = panPlanarInteraction(interactionRef.current, delta[0]!, delta[1]!);
              onInteraction?.(interactionRef.current);
              return;
            }
            if (!model.layers.probes) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onPin?.(model.boundsCenter[0], model.boundsCenter[1]);
            }
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            interactionRef.current = fitPlanarInteraction();
            onInteraction?.(interactionRef.current);
          }}
          onPointerDown={(event) => {
            pointersRef.current.set(event.pointerId, {
              clientX: event.clientX,
              clientY: event.clientY,
            });
            const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
            // Shift + drag draws a line profile in every tool.
            if (pointersRef.current.size === 1 && event.shiftKey && onProfileSegment) {
              gestureMovedRef.current = true;
              segmentDragRef.current = { pointerId: event.pointerId, u0: u, v0: v };
              setDraftSegment({ u0: u, u1: u, v0: v, v1: v });
            } else if (
              pointersRef.current.size === 1 &&
              isPlanarDragTool(activeTool) &&
              (activeTool !== "profile" || onProfileSegment) &&
              (activeTool !== "crop" || onCropCommit)
            ) {
              gestureMovedRef.current = false;
              toolDragRef.current = {
                pointerId: event.pointerId,
                start: { u_m: u, v_m: v },
                startClient: [event.clientX, event.clientY],
                tool: activeTool,
              };
            } else if (pointersRef.current.size === 1) {
              gestureMovedRef.current = false;
              dragRef.current = { pointerId: event.pointerId, u, v };
            } else if (pointersRef.current.size === 2) {
              const [first, second] = [...pointersRef.current.values()];
              if (first && second) {
                const [anchorU, anchorV] = pointerUv(
                  event.currentTarget,
                  (first.clientX + second.clientX) / 2,
                  (first.clientY + second.clientY) / 2,
                  model.viewport,
                );
                pinchRef.current = {
                  anchorU,
                  anchorV,
                  distance: pointerDistance(first, second),
                  interaction: interactionRef.current,
                };
                gestureMovedRef.current = true;
                dragRef.current = null;
                // A second finger turns a tool drag into a pinch zoom.
                if (toolDragRef.current) {
                  toolDragRef.current = null;
                  setZoomBox(null);
                  setDraftSegment(null);
                }
              }
            }
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerUp={(event) => {
            releasePlanarPointer(event.currentTarget, event.pointerId, pointersRef.current);
            pinchRef.current = null;
            if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
            const toolDrag = toolDragRef.current;
            if (toolDrag && toolDrag.pointerId === event.pointerId) {
              toolDragRef.current = null;
              const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
              const result = resolvePlanarToolDrag({
                canvas: measuredCanvasSize(event.currentTarget),
                end: { u_m: u, v_m: v },
                endClient: [event.clientX, event.clientY],
                frameBounds: model.bounds,
                start: toolDrag.start,
                startClient: toolDrag.startClient,
                tool: toolDrag.tool,
                viewport: model.viewport,
              });
              setZoomBox(null);
              setDraftSegment(null);
              if (result.kind === "interaction") {
                // One interaction patch on release, then back to navigate.
                interactionRef.current = result.interaction;
                onInteraction?.(result.interaction);
                planarToolStore.setActiveTool("navigate");
              } else if (result.kind === "crop-draft") {
                planarToolStore.setCropDraft(result.rect);
              } else if (result.kind === "measure") {
                planarToolStore.setMeasure(result.segment);
              } else if (result.kind === "profile") {
                const segment = result.segment;
                onProfileSegment?.({ u0: segment.u0_m, u1: segment.u1_m, v0: segment.v0_m, v1: segment.v1_m });
              }
              return;
            }
            const segmentDrag = segmentDragRef.current;
            if (segmentDrag && segmentDrag.pointerId === event.pointerId) {
              segmentDragRef.current = null;
              const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
              setDraftSegment(null);
              if (u !== segmentDrag.u0 || v !== segmentDrag.v0) {
                onProfileSegment?.({ u0: segmentDrag.u0, u1: u, v0: segmentDrag.v0, v1: v });
              }
            }
          }}
          onPointerCancel={(event) => {
            releasePlanarPointer(event.currentTarget, event.pointerId, pointersRef.current);
            pinchRef.current = null;
            dragRef.current = null;
            segmentDragRef.current = null;
            toolDragRef.current = null;
            setDraftSegment(null);
            setZoomBox(null);
          }}
          onWheel={(event) => {
            event.preventDefault();
            const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
            interactionRef.current = zoomPlanarInteractionAt(
              model.bounds,
              interactionRef.current,
              u,
              v,
              interactionRef.current.zoom * Math.exp(-event.deltaY * 0.001),
            );
            onInteraction?.(interactionRef.current);
          }}
          onPointerMove={(event) => {
            if (pointersRef.current.has(event.pointerId)) {
              pointersRef.current.set(event.pointerId, {
                clientX: event.clientX,
                clientY: event.clientY,
              });
            }
            const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
            const segmentDrag = segmentDragRef.current;
            if (segmentDrag && segmentDrag.pointerId === event.pointerId) {
              setDraftSegment({ u0: segmentDrag.u0, u1: u, v0: segmentDrag.v0, v1: v });
              return;
            }
            const toolDrag = toolDragRef.current;
            if (toolDrag && toolDrag.pointerId === event.pointerId) {
              gestureMovedRef.current = true;
              const end = { u_m: u, v_m: v };
              if (toolDrag.tool === "zoom-box") setZoomBox(normalizeUvRect(toolDrag.start, end));
              else if (toolDrag.tool === "crop") planarToolStore.setCropDraft(normalizeUvRect(toolDrag.start, end));
              else if (toolDrag.tool === "measure") {
                planarToolStore.setMeasure({ u0_m: toolDrag.start.u_m, u1_m: u, v0_m: toolDrag.start.v_m, v1_m: v });
              } else setDraftSegment({ u0: toolDrag.start.u_m, u1: u, v0: toolDrag.start.v_m, v1: v });
              return;
            }
            const pinch = pinchRef.current;
            if (pinch && pointersRef.current.size >= 2) {
              const [first, second] = [...pointersRef.current.values()];
              if (first && second && pinch.distance > 0) {
                interactionRef.current = zoomPlanarInteractionAt(
                  model.bounds,
                  pinch.interaction,
                  pinch.anchorU,
                  pinch.anchorV,
                  pinch.interaction.zoom * pointerDistance(first, second) / pinch.distance,
                );
                gestureMovedRef.current = true;
                onInteraction?.(interactionRef.current);
              }
              return;
            }
            const drag = dragRef.current;
            if (drag && drag.pointerId === event.pointerId) {
              interactionRef.current = panPlanarInteraction(interactionRef.current, drag.u - u, drag.v - v);
              dragRef.current = { ...drag, u, v };
              gestureMovedRef.current = true;
              onInteraction?.(interactionRef.current);
            }
            // Publish the cursor at most once per animation frame; the
            // status bar reads it from the tool store.
            hoverPointerRef.current = [u, v];
            if (hoverFrameRef.current !== null) return;
            hoverFrameRef.current = -1;
            let frame = -1;
            frame = requestAnimationFrame(() => {
              if (hoverFrameRef.current !== -1 && hoverFrameRef.current !== frame) return;
              hoverFrameRef.current = null;
              const point = hoverPointerRef.current;
              if (!point) return;
              planarToolStore.setCursorUv({ u_m: point[0], v_m: point[1] });
              if (!modelRef.current.layers.probes) return;
              renderStateRef.current.axisPointer = { u: point[0], v: point[1] };
              drawOverlayRef.current();
            });
            if (hoverFrameRef.current === -1) hoverFrameRef.current = frame;
          }}
          onPointerLeave={() => {
            if (dragRef.current) return;
            hoverPointerRef.current = null;
            planarToolStore.setCursorUv(null);
            renderStateRef.current.axisPointer = null;
            drawOverlayRef.current();
          }}
        />
        <canvas
          ref={overlayRef}
          aria-hidden="true"
          className="fm-field-map__canvas fm-field-map__canvas--overlay"
        />
        {hasFieldOverlayContent ? (
          <div
            aria-hidden="true"
            className="fm-field-map__field-overlays"
            style={{ inset: 0, pointerEvents: "none", position: "absolute" }}
          >
            {fieldOverlayContent}
          </div>
        ) : null}
        {shownSegment ? (
          <svg
            aria-hidden="true"
            className="fm-field-map__profile-segment"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            <line
              vectorEffect="non-scaling-stroke"
              x1={viewportX(shownSegment.u0, model.viewport)}
              x2={viewportX(shownSegment.u1, model.viewport)}
              y1={viewportY(shownSegment.v0, model.viewport)}
              y2={viewportY(shownSegment.v1, model.viewport)}
            />
          </svg>
        ) : null}
        <PlanarToolOverlay
          axisLabels={{ horizontal: axes.horizontal.label, vertical: axes.vertical.label }}
          cropDisabledReason={cropCommit.disabledReason}
          formatLength={length}
          viewport={model.viewport}
          zoomBox={zoomBox}
          onCropCancel={() => planarToolStore.setCropDraft(null)}
          onCropCommit={() => commitCrop(canvasRef.current)}
        />
        <p className="fm-visually-hidden" id={summaryId}>{summary}</p>
        {probeOverlay}
      </div>
    </div>
  );
}

const cropDraftSnapshot = () => planarToolStore.getSnapshot().cropDraft;
const noCropDraft = () => null;

/** The uncommitted crop rectangle; this surface re-renders only when it changes. */
function useCropDraft(): PlanarUvRect | null {
  return useSyncExternalStore(planarToolStore.subscribe, cropDraftSnapshot, noCropDraft);
}

function pointerUv(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
  bounds: readonly [number, number, number, number],
): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const tx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  const ty = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
  return [
    bounds[0] + tx * (bounds[1] - bounds[0]),
    bounds[3] - ty * (bounds[3] - bounds[2]),
  ];
}

/** Inverse of `pointerUv` in percent of the canvas box. */
function viewportX(u: number, viewport: readonly [number, number, number, number]): number {
  return ((u - viewport[0]) / (viewport[1] - viewport[0])) * 100;
}

function viewportY(v: number, viewport: readonly [number, number, number, number]): number {
  return ((viewport[3] - v) / (viewport[3] - viewport[2])) * 100;
}

function pointerDistance(
  first: { clientX: number; clientY: number },
  second: { clientX: number; clientY: number },
): number {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function releasePlanarPointer(
  canvas: HTMLCanvasElement,
  pointerId: number,
  pointers: Map<number, { clientX: number; clientY: number }>,
): void {
  pointers.delete(pointerId);
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
}
