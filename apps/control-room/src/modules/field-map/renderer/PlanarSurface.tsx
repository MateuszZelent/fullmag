"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";

import type { PlanarRenderEvidence } from "../model/fieldMapEvidence";
import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import {
  resolvePlanarAxes,
  resolvePlanarProbeCoordinates,
} from "../model/planarAxisModel";
import { PlanarAxes } from "./PlanarAxes";
import { localProbe } from "../model/fieldMapProbe";
import {
  fitPlanarInteraction,
  panPlanarInteraction,
  zoomPlanarInteractionAt,
  type PlanarInteraction,
} from "./planarInteraction";
import { usePlanarSurfaceRenderer } from "./usePlanarSurfaceRenderer";

interface PlanarSurfaceProps {
  model: FieldMapRenderModel;
  onInteraction?: (interaction: PlanarInteraction) => void;
  onPin?: (u: number, v: number) => void;
  onRenderEvidence?: (evidence: PlanarRenderEvidence) => void;
  probeOverlay?: ReactNode;
}

export function PlanarSurface({
  model,
  onInteraction,
  onPin,
  onRenderEvidence,
  probeOverlay,
}: PlanarSurfaceProps) {
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
  const [hoverProbe, setHoverProbe] = useState<{
    u: number;
    v: number;
    value: number | null;
  } | null>(null);
  const {
    canvasKey,
    canvasRef,
    drawOverlayRef,
    maskRef,
    modelRef,
    overlayRef,
    plotSize,
    renderStateRef,
    valuesRef,
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
  const hoverCoordinates = hoverProbe
    ? resolvePlanarProbeCoordinates(axisFrame, hoverProbe.u, hoverProbe.v)
    : null;

  useEffect(() => {
    interactionRef.current = model.interaction;
  }, [model.interaction]);

  useEffect(() => () => {
    if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  useEffect(() => {
    if (model.layers.probes) return;
    if (hoverFrameRef.current !== null && hoverFrameRef.current !== -1) {
      cancelAnimationFrame(hoverFrameRef.current);
    }
    hoverFrameRef.current = null;
    hoverPointerRef.current = null;
    renderStateRef.current.axisPointer = null;
    drawOverlayRef.current();
    resetHoverProbe(setHoverProbe);
  }, [drawOverlayRef, model.layers.probes, renderStateRef]);

  return (
    <div
      className="fm-field-map__canvas-stack"
      style={{
        aspectRatio: String(
          Math.abs((model.bounds[1] - model.bounds[0]) / (model.bounds[3] - model.bounds[2])) || 1,
        ),
      }}
    >
      <PlanarAxes
        bounds={model.bounds}
        frame={axisFrame}
        plotSize={plotSize}
        viewport={model.viewport}
      />
      <canvas
        key={canvasKey}
        ref={canvasRef}
        aria-label="Planar scalar field"
        className="fm-field-map__canvas"
        role="img"
        data-probes-enabled={String(model.layers.probes)}
        tabIndex={model.layers.probes ? 0 : -1}
        onClick={(event) => {
          if (gestureMovedRef.current) {
            gestureMovedRef.current = false;
            return;
          }
          if (!model.layers.probes) return;
          const [u, v] = pointerUv(event.currentTarget, event.clientX, event.clientY, model.viewport);
          onPin?.(u, v);
        }}
        onKeyDown={(event) => {
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
          if (pointersRef.current.size === 1) {
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
            }
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          releasePlanarPointer(event.currentTarget, event.pointerId, pointersRef.current);
          pinchRef.current = null;
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onPointerCancel={(event) => {
          releasePlanarPointer(event.currentTarget, event.pointerId, pointersRef.current);
          pinchRef.current = null;
          dragRef.current = null;
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
          if (!model.layers.probes) return;
          const values = valuesRef.current;
          if (!values) return;
          hoverPointerRef.current = [u, v];
          if (hoverFrameRef.current !== null) return;
          hoverFrameRef.current = -1;
          let frame = -1;
          frame = requestAnimationFrame(() => {
            if (hoverFrameRef.current !== -1 && hoverFrameRef.current !== frame) return;
            hoverFrameRef.current = null;
            const point = hoverPointerRef.current;
            const latestValues = valuesRef.current;
            const current = modelRef.current;
            if (!current.layers.probes || !point || !latestValues) return;
            const probe = localProbe(
              point[0],
              point[1],
              current.bounds,
              current.resolution,
              latestValues,
              maskRef.current ?? undefined,
              { continuous: true, probeKind: "interpolated_raster_preview" },
            );
            renderStateRef.current.axisPointer = { u: point[0], v: point[1] };
            drawOverlayRef.current();
            setHoverProbe({ u: point[0], v: point[1], value: probe.value });
          });
          if (hoverFrameRef.current === -1) hoverFrameRef.current = frame;
        }}
        onPointerLeave={() => {
          if (dragRef.current) return;
          hoverPointerRef.current = null;
          renderStateRef.current.axisPointer = null;
          drawOverlayRef.current();
          resetHoverProbe(setHoverProbe);
        }}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        className="fm-field-map__canvas fm-field-map__canvas--overlay"
      />
      {probeOverlay}
      <output className="fm-field-map__probe" aria-live="polite">
        {!model.layers.probes || hoverProbe?.value === null || !hoverCoordinates
          ? "No sample"
          : [
              `${hoverCoordinates.horizontal.label} ${formatValueWithUnit(
                hoverCoordinates.horizontal.valueMetres * axes.displayLengthUnit.scale,
                axes.displayLengthUnit.symbol,
              )}`,
              `${hoverCoordinates.vertical.label} ${formatValueWithUnit(
                hoverCoordinates.vertical.valueMetres * axes.displayLengthUnit.scale,
                axes.displayLengthUnit.symbol,
              )}`,
              formatValueWithUnit(
                hoverProbe!.value! * model.display.probeScale,
                model.display.legendUnit,
              ),
            ].join(" · ")}
      </output>
    </div>
  );
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

function resetHoverProbe(
  setHoverProbe: (value: { u: number; v: number; value: number | null } | null) => void,
): void {
  setHoverProbe(null);
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
