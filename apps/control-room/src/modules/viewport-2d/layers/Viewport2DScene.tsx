"use client";

import { type ThreeEvent, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CrossSectionHoverOutlineLayer } from "./CrossSectionHoverOutlineLayer";
import { CrossSectionPolygonLayer } from "./CrossSectionPolygonLayer";
import { CrossSectionWireframeLayer } from "./CrossSectionWireframeLayer";
import { Viewport2DGridLayer } from "./Viewport2DGridLayer";
import {
  DEFAULT_VIEWPORT_2D_INTERACTION,
  panViewport2DInteraction,
  zoomViewport2DInteraction,
} from "../viewport2dInteraction";
import type { Viewport2DPolygonHover } from "../viewport2dHoverTooltip";
import type {
  Viewport2DPolygonSummary,
  Viewport2DRenderModel,
} from "../viewport2dRenderModel";

export function Viewport2DScene({
  fitRequestVersion,
  hoveredPolygon,
  hoverColor,
  model,
  onHoverPolygon,
  onSelectPolygon,
  selectedPolygon,
  selectionColor,
  wireframeColor,
}: {
  fitRequestVersion: number;
  hoveredPolygon: Viewport2DPolygonSummary | null;
  hoverColor?: readonly [number, number, number];
  model: Viewport2DRenderModel;
  onHoverPolygon: (hover: Viewport2DPolygonHover | null) => void;
  onSelectPolygon: (polygon: Viewport2DPolygonSummary) => void;
  selectedPolygon: Viewport2DPolygonSummary | null;
  selectionColor?: readonly [number, number, number];
  wireframeColor?: readonly [number, number, number];
}) {
  const resetKey = [
    fitRequestVersion,
    model.bounds.uMin,
    model.bounds.uMax,
    model.bounds.vMin,
    model.bounds.vMax,
  ].join(":");

  return (
    <Viewport2DInteractiveScene
      key={resetKey}
      fitRequestVersion={fitRequestVersion}
      hoveredPolygon={hoveredPolygon}
      hoverColor={hoverColor}
      model={model}
      onHoverPolygon={onHoverPolygon}
      onSelectPolygon={onSelectPolygon}
      selectedPolygon={selectedPolygon}
      selectionColor={selectionColor}
      wireframeColor={wireframeColor}
    />
  );
}

function Viewport2DInteractiveScene({
  fitRequestVersion,
  hoveredPolygon,
  hoverColor,
  model,
  onHoverPolygon,
  onSelectPolygon,
  selectedPolygon,
  selectionColor,
  wireframeColor,
}: {
  fitRequestVersion: number;
  hoveredPolygon: Viewport2DPolygonSummary | null;
  hoverColor?: readonly [number, number, number];
  model: Viewport2DRenderModel;
  onHoverPolygon: (hover: Viewport2DPolygonHover | null) => void;
  onSelectPolygon: (polygon: Viewport2DPolygonSummary) => void;
  selectedPolygon: Viewport2DPolygonSummary | null;
  selectionColor?: readonly [number, number, number];
  wireframeColor?: readonly [number, number, number];
}) {
  const viewportHeight = useThree((state) => state.size.height);
  const viewport = useThree((state) => state.viewport);
  const [interaction, setInteraction] = useState(
    DEFAULT_VIEWPORT_2D_INTERACTION,
  );
  const middleDragPointerRef = useRef<number | null>(null);
  const transform = useMemo(
    () => fitTransform(model.bounds, viewport.aspect),
    [model.bounds, viewport.aspect],
  );
  const scale = transform.scale * interaction.scale;
  const positionX = -transform.centerU * scale + interaction.offsetX;
  const positionY = -transform.centerV * scale + interaction.offsetY;
  const handleWheel = useCallback((event: ThreeEvent<WheelEvent>) => {
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    const deltaY = event.deltaY;
    setInteraction((state) => zoomViewport2DInteraction(state, deltaY));
  }, []);
  const handlePointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (event.button !== 1 && !(event.button === 0 && event.shiftKey)) return;
      event.stopPropagation();
      event.nativeEvent.preventDefault();
      middleDragPointerRef.current = event.pointerId;
      if (hasPointerCapture(event.target)) {
        event.target.setPointerCapture(event.pointerId);
      }
      onHoverPolygon(null);
    },
    [onHoverPolygon],
  );
  const handlePointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>): boolean => {
      if (middleDragPointerRef.current !== event.pointerId) return false;
      event.stopPropagation();
      event.nativeEvent.preventDefault();
      const { movementX, movementY } = event;
      setInteraction((state) =>
        panViewport2DInteraction(
          state,
          movementX,
          movementY,
          viewportHeight,
        ),
      );
      return true;
    },
    [viewportHeight],
  );
  const handlePointerEnd = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (middleDragPointerRef.current !== event.pointerId) return;
    event.stopPropagation();
    event.nativeEvent.preventDefault();
    if (hasPointerCapture(event.target)) {
      event.target.releasePointerCapture(event.pointerId);
    }
    middleDragPointerRef.current = null;
  }, []);

  return (
    <>
      <Viewport2DInteractionSurface
        height={viewport.height}
        onPointerDown={handlePointerDown}
        onPointerEnd={handlePointerEnd}
        onPointerMove={handlePointerMove}
        onWheel={handleWheel}
        width={viewport.width}
      />
      <group position={[positionX, positionY, 0]} scale={[scale, scale, 1]}>
        <Viewport2DGridLayer bounds={model.bounds} />
        <CrossSectionPolygonLayer
          model={model}
          onHoverPolygon={onHoverPolygon}
          onPanEnd={handlePointerEnd}
          onPanMove={handlePointerMove}
          onPanStart={handlePointerDown}
          onSelectPolygon={onSelectPolygon}
          onZoom={handleWheel}
        />
        <CrossSectionWireframeLayer model={model} wireframeColor={wireframeColor} />
        <CrossSectionHoverOutlineLayer
          color={selectionColor ?? [0.58, 0.86, 1]}
          model={model}
          opacity={0.9}
          polygon={selectedPolygon}
          renderOrder={4}
        />
        <CrossSectionHoverOutlineLayer
          color={hoverColor}
          model={model}
          polygon={hoveredPolygon}
        />
      </group>
      <Viewport2DFitController fitRequestVersion={fitRequestVersion} />
    </>
  );
}

function Viewport2DInteractionSurface({
  height,
  onPointerDown,
  onPointerEnd,
  onPointerMove,
  onWheel,
  width,
}: {
  height: number;
  onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
  onPointerEnd: (event: ThreeEvent<PointerEvent>) => void;
  onPointerMove: (event: ThreeEvent<PointerEvent>) => boolean;
  onWheel: (event: ThreeEvent<WheelEvent>) => void;
  width: number;
}) {
  return (
    <mesh
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onWheel={onWheel}
      position={[0, 0, -0.1]}
    >
      <planeGeometry args={[Math.max(2, width), Math.max(2, height)]} />
      <meshBasicMaterial
        depthTest={false}
        depthWrite={false}
        opacity={0}
        transparent
      />
    </mesh>
  );
}

function Viewport2DFitController({
  fitRequestVersion,
}: {
  fitRequestVersion: number;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    camera.position.set(0, 0, 10);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, fitRequestVersion, invalidate]);

  return null;
}

function fitTransform(
  bounds: Viewport2DRenderModel["bounds"],
  aspect: number,
): {
  centerU: number;
  centerV: number;
  scale: number;
} {
  const uSpan = Math.max(Math.abs(bounds.uMax - bounds.uMin), Number.EPSILON);
  const vSpan = Math.max(Math.abs(bounds.vMax - bounds.vMin), Number.EPSILON);
  const scale = Math.min((1.8 * aspect) / uSpan, 1.8 / vSpan);
  return {
    centerU: (bounds.uMin + bounds.uMax) * 0.5,
    centerV: (bounds.vMin + bounds.vMax) * 0.5,
    scale,
  };
}

interface PointerCaptureTarget extends EventTarget {
  releasePointerCapture(pointerId: number): void;
  setPointerCapture(pointerId: number): void;
}

function hasPointerCapture(
  target: EventTarget | null,
): target is PointerCaptureTarget {
  const candidate = target as Partial<PointerCaptureTarget> | null;
  return (
    typeof candidate?.releasePointerCapture === "function" &&
    typeof candidate.setPointerCapture === "function"
  );
}
