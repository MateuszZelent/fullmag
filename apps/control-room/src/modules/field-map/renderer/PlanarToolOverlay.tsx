"use client";

import { useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { Check, X } from "lucide-react";

import {
  planarToolStore,
  type PlanarCursorUv,
  type PlanarUvRect,
  type PlanarUvSegment,
} from "@/kernel/visualization/planarToolStore";
import { Button } from "@/shared/ui/Button";

import {
  PLANAR_CROP_HANDLES,
  measureSegment,
  resizeUvRect,
  uvToCanvasPercent,
  type PlanarCropHandle,
} from "../model/planarToolGeometry";

type UvBounds = readonly [number, number, number, number];

const cropDraftSnapshot = () => planarToolStore.getSnapshot().cropDraft;
const measureSnapshot = () => planarToolStore.getSnapshot().measure;
const noShape = () => null;

export interface PlanarToolOverlayProps {
  /** Visible u/v range of the canvas (`model.viewport`). */
  viewport: UvBounds;
  /** Zoom-box rectangle while it is dragged. */
  zoomBox: PlanarUvRect | null;
  /** Formats a length in the axis unit (e.g. `42.7 nm`). */
  formatLength: (metres: number) => string;
  /** World-axis names of the horizontal (u) and vertical (v) directions. */
  axisLabels: { horizontal: string; vertical: string };
  /** Why the crop draft cannot be committed; null when it can. */
  cropDisabledReason: string | null;
  onCropCommit: () => void;
  onCropCancel: () => void;
}

function percentRect(rect: PlanarUvRect, viewport: UvBounds) {
  const topLeft = uvToCanvasPercent(rect.u_min_m, rect.v_max_m, viewport);
  const bottomRight = uvToCanvasPercent(rect.u_max_m, rect.v_min_m, viewport);
  return {
    height: bottomRight.top - topLeft.top,
    left: topLeft.left,
    top: topLeft.top,
    width: bottomRight.left - topLeft.left,
  };
}

function handlePosition(handle: PlanarCropHandle, box: ReturnType<typeof percentRect>) {
  const left = handle.includes("w") ? box.left : handle.includes("e") ? box.left + box.width : box.left + box.width / 2;
  const top = handle.includes("n") ? box.top : handle.includes("s") ? box.top + box.height : box.top + box.height / 2;
  return { left: `${left}%`, top: `${top}%` };
}

/**
 * Canvas-tool shapes over the 2D field (plan §2.3): the zoom box, the crop
 * draft with dimmed surroundings, eight resize handles, its size and the
 * apply/cancel buttons, and the ruler with its length, components and angle.
 * The overlay ignores the pointer except on its handles and buttons, so the
 * canvas keeps every gesture.
 */
export function PlanarToolOverlay({
  viewport,
  zoomBox,
  formatLength,
  axisLabels,
  cropDisabledReason,
  onCropCommit,
  onCropCancel,
}: PlanarToolOverlayProps) {
  const cropDraft = useSyncExternalStore(planarToolStore.subscribe, cropDraftSnapshot, noShape);
  const measure = useSyncExternalStore(planarToolStore.subscribe, measureSnapshot, noShape);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ handle: PlanarCropHandle; pointerId: number } | null>(null);
  if (!cropDraft && !measure && !zoomBox) return null;

  const pointerUv = (clientX: number, clientY: number): PlanarCursorUv | null => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      u_m: viewport[0] + ((clientX - rect.left) / rect.width) * (viewport[1] - viewport[0]),
      v_m: viewport[3] - ((clientY - rect.top) / rect.height) * (viewport[3] - viewport[2]),
    };
  };
  const onHandleDown = (handle: PlanarCropHandle) => (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { handle, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current;
    const draft = planarToolStore.getSnapshot().cropDraft;
    if (!resize || resize.pointerId !== event.pointerId || !draft) return;
    const point = pointerUv(event.clientX, event.clientY);
    if (point) planarToolStore.setCropDraft(resizeUvRect(draft, resize.handle, point));
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const crop = cropDraft ? percentRect(cropDraft, viewport) : null;
  const zoom = zoomBox ? percentRect(zoomBox, viewport) : null;
  return (
    <div ref={rootRef} className="fm-planar-tool-overlay" data-planar-tool-overlay="">
      <svg aria-hidden="true" className="fm-planar-tool-overlay__shapes" preserveAspectRatio="none" viewBox="0 0 100 100">
        {crop ? (
          <path
            className="fm-planar-tool-overlay__dim"
            d={`M0 0H100V100H0Z M${crop.left} ${crop.top}V${crop.top + crop.height}H${crop.left + crop.width}V${crop.top}Z`}
            fillRule="evenodd"
          />
        ) : null}
        {crop ? (
          <rect
            className="fm-planar-tool-overlay__crop"
            height={crop.height}
            vectorEffect="non-scaling-stroke"
            width={crop.width}
            x={crop.left}
            y={crop.top}
          />
        ) : null}
        {zoom ? (
          <rect
            className="fm-planar-tool-overlay__zoom-box"
            data-planar-zoom-box=""
            height={zoom.height}
            vectorEffect="non-scaling-stroke"
            width={zoom.width}
            x={zoom.left}
            y={zoom.top}
          />
        ) : null}
        {measure ? <RulerLine segment={measure} viewport={viewport} /> : null}
      </svg>
      {crop && cropDraft ? (
        <>
          {PLANAR_CROP_HANDLES.map((handle) => (
            <span
              key={handle}
              aria-hidden="true"
              className={`fm-planar-tool-overlay__handle fm-planar-tool-overlay__handle--${handle}`}
              data-planar-crop-handle={handle}
              style={handlePosition(handle, crop)}
              onPointerCancel={onHandleUp}
              onPointerDown={onHandleDown(handle)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
            />
          ))}
          <div
            className="fm-planar-tool-overlay__crop-panel"
            style={{ left: `${crop.left + crop.width / 2}%`, top: `${crop.top + crop.height / 2}%` }}
          >
            <span className="fm-planar-tool-overlay__label" data-planar-crop-size="">
              {`${formatLength(cropDraft.u_max_m - cropDraft.u_min_m)} × ${formatLength(cropDraft.v_max_m - cropDraft.v_min_m)}`}
            </span>
            <span className="fm-planar-tool-overlay__actions">
              <Button
                aria-keyshortcuts="Enter"
                aria-label="Apply crop"
                disabled={cropDisabledReason !== null}
                disabledReason={cropDisabledReason}
                size="icon"
                type="button"
                variant="primary"
                onClick={onCropCommit}
              >
                <Check aria-hidden="true" size={14} />
              </Button>
              <Button
                aria-keyshortcuts="Escape"
                aria-label="Cancel crop"
                size="icon"
                type="button"
                variant="ghost"
                onClick={onCropCancel}
              >
                <X aria-hidden="true" size={14} />
              </Button>
            </span>
          </div>
        </>
      ) : null}
      {measure ? (
        <RulerLabel axisLabels={axisLabels} formatLength={formatLength} segment={measure} viewport={viewport} />
      ) : null}
    </div>
  );
}

function RulerLine({ segment, viewport }: { segment: PlanarUvSegment; viewport: UvBounds }) {
  const start = uvToCanvasPercent(segment.u0_m, segment.v0_m, viewport);
  const end = uvToCanvasPercent(segment.u1_m, segment.v1_m, viewport);
  return (
    <line
      className="fm-planar-tool-overlay__ruler"
      vectorEffect="non-scaling-stroke"
      x1={start.left}
      x2={end.left}
      y1={start.top}
      y2={end.top}
    />
  );
}

function RulerLabel({
  axisLabels,
  formatLength,
  segment,
  viewport,
}: {
  axisLabels: PlanarToolOverlayProps["axisLabels"];
  formatLength: (metres: number) => string;
  segment: PlanarUvSegment;
  viewport: UvBounds;
}) {
  const measured = measureSegment(segment);
  const start = uvToCanvasPercent(segment.u0_m, segment.v0_m, viewport);
  const end = uvToCanvasPercent(segment.u1_m, segment.v1_m, viewport);
  return (
    <>
      {[start, end].map((point, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="fm-planar-tool-overlay__ruler-end"
          style={{ left: `${point.left}%`, top: `${point.top}%` }}
        />
      ))}
      <output
        aria-label="Measured distance"
        className="fm-planar-tool-overlay__label fm-planar-tool-overlay__ruler-label"
        data-planar-measure-length-m={String(measured.length_m)}
        style={{ left: `${(start.left + end.left) / 2}%`, top: `${(start.top + end.top) / 2}%` }}
      >
        <strong>{formatLength(measured.length_m)}</strong>
        <span>
          {`Δ${axisLabels.horizontal} ${formatLength(measured.du_m)} · Δ${axisLabels.vertical} ${formatLength(measured.dv_m)} · ${measured.angle_deg.toFixed(1)}°`}
        </span>
      </output>
    </>
  );
}

/**
 * Ring on the projection of a probed node (plan §2.3). A node off the
 * section plane gets a dashed ring.
 */
export function PlanarNodeRing({
  node,
  viewport,
}: {
  node: { u_m: number; v_m: number; normal_offset_m: number };
  viewport: UvBounds;
}) {
  const position = uvToCanvasPercent(node.u_m, node.v_m, viewport);
  if (position.left < 0 || position.left > 100 || position.top < 0 || position.top > 100) return null;
  return (
    <span
      aria-hidden="true"
      className={node.normal_offset_m !== 0
        ? "fm-planar-node-ring fm-planar-node-ring--off-plane"
        : "fm-planar-node-ring"}
      data-planar-node-ring=""
      style={{ left: `${position.left}%`, top: `${position.top}%` }}
    />
  );
}
