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
  orthonormalFrame,
  planarFrameCenter,
  ringAngle,
  rotateAboutAxis,
  rotateFrame,
  type FrameAxes,
} from "./planarNormalHandleGeometry";

type Vec3 = [number, number, number];

/** Rotation step of Shift+[ / Shift+] and of Shift-snapped ring drags. */
export const PLANAR_ROTATION_STEP_RAD = (5 * Math.PI) / 180;

interface RingDrag {
  pointerId: number;
  axis: Vec3;
  e1: Vec3;
  e2: Vec3;
  startAngle: number;
  startFrame: FrameAxes;
  startOrigin: Vec3;
  center: Vec3;
  target: Element & { releasePointerCapture(pointerId: number): void };
}

/** Frame and origin rotated about `axis` through `center`, as a draft proposal. */
function rotatedProposal(frame: FrameAxes, origin: Vec3, center: Vec3, axis: Vec3, angle: number) {
  const rotated = rotateFrame(frame, axis, angle);
  const offset = rotateAboutAxis([origin[0] - center[0], origin[1] - center[1], origin[2] - center[2]], axis, angle);
  return {
    normal: rotated.normal,
    origin_m: [center[0] + offset[0], center[1] + offset[1], center[2] + offset[2]] as Vec3,
    u_axis: rotated.uAxis,
    v_axis: rotated.vAxis,
  };
}

/**
 * Two rotation rings of a planar monitor frame (F6 B5): about its u and v
 * axes through the frame centre. Like the normal handle they edit the draft
 * owned by the Inspector; Shift snaps the drag to 5°, Shift+[ / Shift+]
 * rotate about u by one step, Escape restores the frame.
 */
export function PlanarMonitorRotationRings({
  colors,
  onGestureActiveChange,
  preview,
}: {
  colors: Viewport3DColors;
  onGestureActiveChange?: (active: boolean) => void;
  preview: PlanarMonitorFramePreview;
}) {
  const editorMonitorId = usePlanarMonitorDraftEditorId();
  const dragRef = useRef<RingDrag | null>(null);
  const geometry = useMemo(() => {
    const frame = orthonormalFrame(preview.normal, preview.uAxis);
    const center = planarFrameCenter(preview.originM, preview.uAxis, preview.vAxis, preview.boundsUvM);
    const extent = Math.max(preview.boundsUvM[1] - preview.boundsUvM[0], preview.boundsUvM[3] - preview.boundsUvM[2]);
    const radius = 0.32 * extent;
    const ring = (axis: Vec3) =>
      new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(...axis));
    return { center, frame, radius, uRing: ring(frame.uAxis), vRing: ring(frame.vAxis) };
  }, [preview]);
  const shown = editorMonitorId === preview.monitorId && preview.visible !== false;
  const stateRef = useRef({ geometry, monitorId: preview.monitorId, origin: [...preview.originM] as Vec3, shown });
  useEffect(() => {
    stateRef.current = { geometry, monitorId: preview.monitorId, origin: [...preview.originM] as Vec3, shown };
  });

  const finish = (keep: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      drag.target.releasePointerCapture(drag.pointerId);
    } catch {
      // Capture may already be gone (pointer cancelled by the browser).
    }
    if (!keep) {
      planarMonitorFramePreviewStore.proposeDraftFrame(stateRef.current.monitorId, {
        normal: drag.startFrame.normal,
        origin_m: drag.startOrigin,
        u_axis: drag.startFrame.uAxis,
        v_axis: drag.startFrame.vAxis,
      });
    }
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
        return;
      }
      const state = stateRef.current;
      const target = event.target as HTMLElement | null;
      if (!state.shown || !event.shiftKey || target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const step = event.code === "BracketLeft" ? -1 : event.code === "BracketRight" ? 1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const { center, frame } = state.geometry;
      planarMonitorFramePreviewStore.proposeDraftFrame(
        state.monitorId,
        rotatedProposal(frame, state.origin, center, frame.uAxis, step * PLANAR_ROTATION_STEP_RAD),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      finishRef.current(true);
    };
  }, []);

  useEffect(() => (shown ? registerViewport3DProbeGizmo() : undefined), [shown]);
  if (!shown) return null;

  const { center, frame, radius } = geometry;
  const ray = (event: ThreeEvent<PointerEvent>) => ({
    direction: [event.ray.direction.x, event.ray.direction.y, event.ray.direction.z] as Vec3,
    origin: [event.ray.origin.x, event.ray.origin.y, event.ray.origin.z] as Vec3,
  });
  const ringHandlers = (axis: Vec3, e1: Vec3, e2: Vec3) => ({
    onPointerDown: (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      const { direction, origin } = ray(event);
      const startAngle = ringAngle(origin, direction, center, axis, e1, e2);
      if (startAngle === null) return;
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
        axis, center, e1, e2, pointerId: event.pointerId, startAngle, startFrame: frame,
        startOrigin: [...preview.originM] as Vec3, target,
      };
      onGestureActiveChange?.(true);
    },
    onPointerMove: (event: ThreeEvent<PointerEvent>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      const { direction, origin } = ray(event);
      const angle = ringAngle(origin, direction, drag.center, drag.axis, drag.e1, drag.e2);
      if (angle === null) return;
      let delta = Math.atan2(Math.sin(angle - drag.startAngle), Math.cos(angle - drag.startAngle));
      if (event.shiftKey) delta = Math.round(delta / PLANAR_ROTATION_STEP_RAD) * PLANAR_ROTATION_STEP_RAD;
      planarMonitorFramePreviewStore.proposeDraftFrame(
        preview.monitorId,
        rotatedProposal(drag.startFrame, drag.startOrigin, drag.center, drag.axis, delta),
      );
    },
    onPointerUp: (event: ThreeEvent<PointerEvent>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      event.stopPropagation();
      finish(true);
    },
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => finish(true),
  });

  // Ring about u sweeps v→n; ring about v sweeps n→u (right-handed: u × v = n).
  const rings = [
    { axis: frame.uAxis, color: colors.danger, e1: frame.vAxis, e2: frame.normal, id: "u", quaternion: geometry.uRing },
    { axis: frame.vAxis, color: colors.success, e1: frame.normal, e2: frame.uAxis, id: "v", quaternion: geometry.vRing },
  ];
  return (
    <group name={`planar-monitor-rotation-rings:${preview.monitorId}`} position={center}>
      {rings.map((ring) => (
        <group key={ring.id} quaternion={ring.quaternion}>
          <mesh
            userData={{ axis: ring.id, gizmo: "planar-rotate", monitorId: preview.monitorId }}
            {...ringHandlers(ring.axis, ring.e1, ring.e2)}
          >
            {/* Invisible pick torus wider than the drawn ring. */}
            <torusGeometry args={[radius, radius * 0.07, 8, 64]} />
            <meshBasicMaterial depthTest={false} depthWrite={false} opacity={0} transparent />
          </mesh>
          <mesh raycast={() => null}>
            <torusGeometry args={[radius, radius * 0.015, 8, 96]} />
            <meshBasicMaterial color={ring.color} depthTest={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
