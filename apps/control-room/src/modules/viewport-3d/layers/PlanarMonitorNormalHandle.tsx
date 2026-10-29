"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Quaternion, Vector3 } from "three";

import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorDraftEditorId,
  type PlanarMonitorFramePreview,
} from "@/kernel/workspace/planarMonitorFramePreview";

import type { Viewport3DColors } from "../viewport3dTypes";
import { registerViewport3DProbeGizmo } from "../viewport3dEventManager";
import {
  closestAxisParameter,
  planarFrameCenter,
  translateAlongNormal,
} from "./planarNormalHandleGeometry";

type Vec3 = [number, number, number];

interface NormalDrag {
  pointerId: number;
  startOrigin: Vec3;
  startParameter: number;
  axisPoint: Vec3;
  normal: Vec3;
  target: Element & { releasePointerCapture(pointerId: number): void };
}

/**
 * Translation handle along the normal of a planar monitor frame (F6 B5). It is
 * shown only while an Inspector panel owns that monitor's draft and writes the
 * new origin through that owner, so 3D and Inspector edit one draft.
 */
export function PlanarMonitorNormalHandle({
  colors,
  onGestureActiveChange,
  preview,
}: {
  colors: Viewport3DColors;
  onGestureActiveChange?: (active: boolean) => void;
  preview: PlanarMonitorFramePreview;
}) {
  const editorMonitorId = usePlanarMonitorDraftEditorId();
  const dragRef = useRef<NormalDrag | null>(null);
  const geometry = useMemo(() => {
    const normalLength = Math.hypot(...preview.normal) || 1;
    const normal = preview.normal.map((value) => value / normalLength) as Vec3;
    const center = planarFrameCenter(preview.originM, preview.uAxis, preview.vAxis, preview.boundsUvM);
    const extent = Math.max(preview.boundsUvM[1] - preview.boundsUvM[0], preview.boundsUvM[3] - preview.boundsUvM[2]);
    const length = 0.25 * extent;
    const quaternion = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...normal));
    return { center, length, normal, quaternion };
  }, [preview]);

  const finish = (active: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      drag.target.releasePointerCapture(drag.pointerId);
    } catch {
      // Capture may already be gone (pointer cancelled by the browser).
    }
    if (!active) planarMonitorFramePreviewStore.proposeDraftOrigin(preview.monitorId, drag.startOrigin);
    onGestureActiveChange?.(false);
  };
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current) {
        event.preventDefault();
        finishRef.current(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      finishRef.current(true);
    };
  }, []);

  const shown = editorMonitorId === preview.monitorId && preview.visible !== false;
  // Pointer-down reaches gizmos before orbit only while one is registered.
  useEffect(() => (shown ? registerViewport3DProbeGizmo() : undefined), [shown]);

  if (!shown) return null;
  const { center, length, normal, quaternion } = geometry;
  const rayParameter = (event: ThreeEvent<PointerEvent>, axisPoint: Vec3) =>
    closestAxisParameter(
      [event.ray.origin.x, event.ray.origin.y, event.ray.origin.z],
      [event.ray.direction.x, event.ray.direction.y, event.ray.direction.z],
      axisPoint,
      normal,
    );

  return (
    <group
      name={`planar-monitor-normal-handle:${preview.monitorId}`}
      position={center}
      quaternion={quaternion}
      userData={{ gizmo: "planar-normal", monitorId: preview.monitorId }}
    >
      <mesh
        position={[0, length / 2, 0]}
        userData={{ gizmo: "planar-normal", monitorId: preview.monitorId }}
        onPointerDown={(event) => {
          event.stopPropagation();
          const startParameter = rayParameter(event, center);
          if (startParameter === null) return;
          const target = event.target as Element & {
            releasePointerCapture(pointerId: number): void;
            setPointerCapture(pointerId: number): void;
          };
          try {
            target.setPointerCapture(event.pointerId);
          } catch {
            return;
          }
          dragRef.current = {
            axisPoint: center,
            normal,
            pointerId: event.pointerId,
            startOrigin: [...preview.originM] as Vec3,
            startParameter,
            target,
          };
          onGestureActiveChange?.(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.stopPropagation();
          const parameter = rayParameter(event, drag.axisPoint);
          if (parameter === null) return;
          planarMonitorFramePreviewStore.proposeDraftOrigin(
            preview.monitorId,
            translateAlongNormal(drag.startOrigin, drag.normal, parameter - drag.startParameter),
          );
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          event.stopPropagation();
          finish(true);
        }}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => finish(true)}
      >
        {/* Pick target wider than the drawn shaft, so a few-pixel arrow stays grabbable. */}
        <cylinderGeometry args={[length * 0.16, length * 0.16, length * 1.3, 12]} />
        <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
      </mesh>
      <mesh position={[0, length / 2, 0]} raycast={() => null}>
        <cylinderGeometry args={[length * 0.04, length * 0.04, length, 12]} />
        <meshBasicMaterial color={colors.accent} depthTest={false} />
      </mesh>
      <mesh position={[0, length + length * 0.12, 0]} raycast={() => null}>
        <coneGeometry args={[length * 0.1, length * 0.24, 16]} />
        <meshBasicMaterial color={colors.accent} depthTest={false} />
      </mesh>
    </group>
  );
}
