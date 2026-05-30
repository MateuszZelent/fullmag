"use client";

import { type ThreeEvent } from "@react-three/fiber";
import { useCallback, useEffect, useMemo } from "react";
import * as THREE from "three";

import {
  resolveViewport2DPolygonHit,
  type Viewport2DPolygonSummary,
  type Viewport2DRenderModel,
} from "../viewport2dRenderModel";
import type {
  Viewport2DHoverPointer,
  Viewport2DPolygonHover,
} from "../viewport2dHoverTooltip";

export function CrossSectionPolygonLayer({
  model,
  onHoverPolygon,
  onPanEnd,
  onPanMove,
  onPanStart,
  onSelectPolygon,
  onZoom,
}: {
  model: Viewport2DRenderModel;
  onHoverPolygon: (hover: Viewport2DPolygonHover | null) => void;
  onPanEnd: (event: ThreeEvent<PointerEvent>) => void;
  onPanMove: (event: ThreeEvent<PointerEvent>) => boolean;
  onPanStart: (event: ThreeEvent<PointerEvent>) => void;
  onSelectPolygon: (polygon: Viewport2DPolygonSummary) => void;
  onZoom: (event: ThreeEvent<WheelEvent>) => void;
}) {
  const geometry = useMemo(() => {
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    next.setAttribute("color", new THREE.BufferAttribute(model.colors, 3));
    next.setIndex(new THREE.BufferAttribute(model.indices, 1));
    next.computeBoundingSphere();
    return next;
  }, [model]);
  const handlePointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      if (onPanMove(event)) {
        onHoverPolygon(null);
        return;
      }
      event.stopPropagation();
      const polygon = resolveViewport2DPolygonHit(model, event.faceIndex);
      onHoverPolygon(
        polygon
          ? { pointer: resolveHoverPointer(event.nativeEvent), polygon }
          : null,
      );
    },
    [model, onHoverPolygon, onPanMove],
  );
  const handlePointerOut = useCallback(
    () => onHoverPolygon(null),
    [onHoverPolygon],
  );
  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      event.stopPropagation();
      const polygon = resolveViewport2DPolygonHit(model, event.faceIndex);
      if (polygon) onSelectPolygon(polygon);
    },
    [model, onSelectPolygon],
  );

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      onClick={handleClick}
      onPointerCancel={onPanEnd}
      onPointerDown={onPanStart}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
      onPointerUp={onPanEnd}
      onWheel={onZoom}
    >
      <meshBasicMaterial
        depthTest={false}
        side={THREE.DoubleSide}
        vertexColors
      />
    </mesh>
  );
}

function resolveHoverPointer(event: PointerEvent): Viewport2DHoverPointer {
  const target = event.target;
  const viewportWidth =
    target && "clientWidth" in target ? Number(target.clientWidth) : 1;
  const viewportHeight =
    target && "clientHeight" in target ? Number(target.clientHeight) : 1;
  return {
    viewportHeight: Math.max(1, viewportHeight),
    viewportWidth: Math.max(1, viewportWidth),
    viewportX: event.offsetX,
    viewportY: event.offsetY,
  };
}
