"use client";

/**
 * ViewCube + Axis Gizmo — 1:1 port of amumax ViewCube.svelte.
 *
 * Renders a small interactive orientation cube (top-right corner of the 3D
 * viewport) that stays in sync with the Three.js camera. Clicking a face/edge
 * snaps the camera to that direction. Dragging orbits the camera.
 *
 * Below the cube, a colour-coded XYZ axis gizmo shows the current orientation.
 */

import { useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import type { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { cn } from "@/lib/utils";
import { setCameraPresetAroundTarget } from "./camera/cameraHelpers";

type SceneHandle = {
  camera: THREE.Camera;
  controls: TrackballControls | {
    target: THREE.Vector3;
    update(): void;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
};

interface ViewCubeProps {
  sceneRef?: React.MutableRefObject<SceneHandle | null>;
  onRotate?: (quaternion: THREE.Quaternion) => void;
  onReset?: () => void;
  className?: string;
  cubeClassName?: string;
  axisClassName?: string;
  embedded?: boolean;
}

type FaceZone = {
  dir: [number, number, number];
  type: "face" | "edge" | "corner";
  label?: string;
};

const _m = new THREE.Matrix4();

function add(a: number[], b: number[], c?: number[]): [number, number, number] {
  const r: [number, number, number] = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  if (c) { r[0] += c[0]; r[1] += c[1]; r[2] += c[2]; }
  return r;
}
function neg(a: number[]): number[] { return [-a[0], -a[1], -a[2]]; }

function buildZones(
  n: [number, number, number],
  u: [number, number, number],
  r: [number, number, number],
  label: string,
): FaceZone[][] {
  return [
    [{ dir: add(n, u, neg(r)), type: "corner" }, { dir: add(n, u), type: "edge" }, { dir: add(n, u, r), type: "corner" }],
    [{ dir: add(n, neg(r)), type: "edge" }, { dir: [n[0], n[1], n[2]], type: "face", label }, { dir: add(n, r), type: "edge" }],
    [{ dir: add(n, neg(u), neg(r)), type: "corner" }, { dir: add(n, neg(u)), type: "edge" }, { dir: add(n, neg(u), r), type: "corner" }],
  ];
}

const faces: { cssTransform: string; zones: FaceZone[][] }[] = [
  { cssTransform: "vcFaceTop", zones: buildZones([0, 1, 0], [0, 0, 1], [1, 0, 0], "+Y") },
  { cssTransform: "vcFaceBottom", zones: buildZones([0, -1, 0], [0, 0, 1], [-1, 0, 0], "-Y") },
  { cssTransform: "vcFaceRight", zones: buildZones([1, 0, 0], [0, 0, 1], [0, -1, 0], "+X") },
  { cssTransform: "vcFaceLeft", zones: buildZones([-1, 0, 0], [0, 0, 1], [0, 1, 0], "-X") },
  { cssTransform: "vcFaceFront", zones: buildZones([0, 0, 1], [0, 1, 0], [1, 0, 0], "+Z") },
  { cssTransform: "vcFaceBack", zones: buildZones([0, 0, -1], [0, -1, 0], [1, 0, 0], "-Z") },
];

export default function ViewCube({
  sceneRef,
  onRotate,
  onReset,
  className,
  cubeClassName,
  axisClassName,
  embedded,
}: ViewCubeProps & { className?: string }) {
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, hasDragged: false, pointerId: -1 });
  const cubeSceneRef = useRef<HTMLDivElement | null>(null);
  const axisSceneRef = useRef<HTMLDivElement | null>(null);
  const attachedControlsRef = useRef<SceneHandle["controls"] | null>(null);

  // ─── Camera matrix → CSS ──────────────────────────────────────────
  const getCameraMatrix = useCallback((): string => {
    const scene = sceneRef?.current;
    if (!scene) return "none";
    const { camera } = scene;
    camera.updateMatrixWorld?.(true);
    camera.updateWorldMatrix?.(true, false);
    _m.copy(camera.matrixWorldInverse);
    _m.elements[12] = 0;
    _m.elements[13] = 0;
    _m.elements[14] = 0;
    const e = _m.elements;
    return `matrix3d(${e[0]},${e[1]},${e[2]},0,${e[4]},${e[5]},${e[6]},0,${e[8]},${e[9]},${e[10]},0,0,0,0,1)`;
  }, [sceneRef]);

  // ─── Sync transform on camera/control changes ─────────────────────
  const lastTransformRef = useRef<string>("");
  const syncTransform = useCallback(() => {
    const transform = getCameraMatrix();
    if (transform === lastTransformRef.current) {
      return;
    }
    lastTransformRef.current = transform;
    if (cubeSceneRef.current) cubeSceneRef.current.style.transform = transform;
    if (axisSceneRef.current) axisSceneRef.current.style.transform = transform;
  }, [getCameraMatrix]);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const handleChange = () => syncTransform();

    const attachIfReady = () => {
      const scene = sceneRef?.current;
      const controls = scene?.controls as any;
      if (!controls || attachedControlsRef.current === controls) {
        syncTransform();
        return Boolean(controls);
      }
      attachedControlsRef.current?.removeEventListener?.("change", handleChange);
      attachedControlsRef.current = controls;
      controls.addEventListener?.("change", handleChange);
      syncTransform();
      return true;
    };

    const poll = () => {
      if (cancelled) return;
      if (!attachIfReady()) {
        raf = window.requestAnimationFrame(poll);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      attachedControlsRef.current?.removeEventListener?.("change", handleChange);
      attachedControlsRef.current = null;
    };
  }, [sceneRef, syncTransform]);

  // ─── Click face → snap camera ────────────────────────────────────
  const handleZoneClick = useCallback(
    (dir: [number, number, number]) => {
      if (dragRef.current.hasDragged) return;
      if (!onRotate) return;
      const targetDirection = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
      const quaternion = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        targetDirection,
      );
      onRotate(quaternion);
    },
    [onRotate],
  );

  // ─── Reset camera ────────────────────────────────────────────────
  const resetCamera = useCallback(() => {
    if (onReset) {
      onReset();
      return;
    }
    const scene = sceneRef?.current;
    if (scene) {
      setCameraPresetAroundTarget(scene.camera, scene.controls, "reset", scene.camera.position.clone().sub(scene.controls.target).length() || 1);
      syncTransform();
      return;
    }
    if (onRotate) {
      onRotate(new THREE.Quaternion());
    }
  }, [onRotate, onReset, sceneRef, syncTransform]);

  // ─── Drag orbit ──────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = {
      dragging: true,
      hasDragged: false,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    };
    (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d.dragging) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.hasDragged = true;
      if (!d.hasDragged) return;
      // Orbit the actual Three.js camera
      const scene = sceneRef?.current;
      if (scene) {
        const { camera, controls } = scene;
        const target = controls.target.clone();
        const offset = camera.position.clone().sub(target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.theta -= dx * 0.01;
        spherical.phi -= dy * 0.01;
        spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi));
        offset.setFromSpherical(spherical);
        camera.position.copy(target).add(offset);
        camera.lookAt(target);
        controls.update();
      }
      d.startX = e.clientX;
      d.startY = e.clientY;
    },
    [sceneRef],
  );

  const onPointerUp = useCallback(() => {
    const current = cubeSceneRef.current;
    const pointerId = dragRef.current.pointerId;
    if (pointerId >= 0 && current?.hasPointerCapture?.(pointerId)) {
      current.releasePointerCapture(pointerId);
    }
    dragRef.current.dragging = false;
    dragRef.current.pointerId = -1;
  }, []);

  return (
    <div className={cn("flex flex-col items-center gap-4", embedded ? "select-none" : null, className)}>
      {/* ViewCube */}
      <div
        className={cn(
          "relative flex h-[5.5rem] w-size-viewcube flex-col items-center rounded-xl border border-border/40 bg-gradient-to-b from-card to-[hsl(var(--background))] pt-[6px] shadow-xl backdrop-blur-md [perspective:220px]",
          cubeClassName,
        )}
      >
        <div
          ref={cubeSceneRef}
          className="relative w-size-viewcube-button h-size-viewcube-button [transform-style:preserve-3d] cursor-grab active:cursor-grabbing touch-none pointer-events-auto"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {faces.map((face, fi) => (
            <div key={fi} className="absolute inset-0 grid h-size-viewcube-button w-size-viewcube-button grid-cols-[10px_1fr_10px] grid-rows-[10px_1fr_10px] border border-border/30 bg-gradient-to-br from-card to-muted [backface-visibility:visible]" style={{ transform: face.cssTransform === "vcFaceTop" ? "translateZ(30px)" : face.cssTransform === "vcFaceBottom" ? "rotateY(180deg) translateZ(30px)" : face.cssTransform === "vcFaceRight" ? "rotateY(90deg) translateZ(30px)" : face.cssTransform === "vcFaceLeft" ? "rotateY(-90deg) translateZ(30px)" : face.cssTransform === "vcFaceFront" ? "rotateX(90deg) translateZ(30px)" : "rotateX(-90deg) translateZ(30px)" }}>
              {face.zones.flat().map((zone, zi) => (
                <button
                  key={zi}
                  type="button"
                  className={cn(
                    "m-0 flex cursor-pointer items-center justify-center border-none bg-transparent p-0 transition-colors",
                    zone.type === "face"
                      ? "text-foreground/80 hover:bg-muted/50 hover:text-white"
                      : zone.type === "edge"
                        ? "hover:bg-teal-500/30"
                        : "hover:bg-amber-500/30",
                  )}
                  onClick={() => handleZoneClick(zone.dir)}
                  title={zone.label ?? ""}
                >
                  {zone.label && <span className="text-[8px] font-bold tracking-wider uppercase">{zone.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <button type="button" className="mt-[5px] flex h-size-viewcube-indicator w-size-viewcube-indicator cursor-pointer items-center justify-center rounded-full border border-border/40 bg-card text-[12px] leading-none text-muted-foreground transition-all backdrop-blur-md hover:border-primary hover:bg-primary/20 hover:text-white" onClick={resetCamera} title="Reset view">
          ⌂
        </button>
      </div>

      {/* Axis Gizmo */}
      <div
        className={cn("relative h-[90px] w-[90px] [perspective:200px]", axisClassName)}
      >
        <div ref={axisSceneRef} className="relative w-[90px] h-[90px] [transform-style:preserve-3d]">
          {/* X axis (red) */}
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] w-[2px] h-[36px] -ml-[1px] origin-top rounded-[1px] bg-red-500" style={{ transform: "rotateZ(-90deg) translateY(-18px)" }} />
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent -ml-[5px] -mt-[5px] origin-center border-b-[10px] border-b-red-500" style={{ transform: "translateX(26px) rotateZ(-90deg)" }} />
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] text-[13px] font-extrabold pointer-events-none -ml-[5px] -mt-[8px] text-red-500" style={{ transform: "translateX(36px)" }}>X</div>
          {/* Z axis (blue) */}
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] w-[2px] h-[36px] -ml-[1px] origin-top rounded-[1px] bg-blue-500" style={{ transform: "translateY(-18px)" }} />
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent -ml-[5px] -mt-[5px] origin-center border-b-[10px] border-b-blue-500" style={{ transform: "translateY(-26px)" }} />
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] text-[13px] font-extrabold pointer-events-none -ml-[5px] -mt-[8px] text-blue-500" style={{ transform: "translateY(-36px)" }}>Z</div>
          {/* Y axis (green) */}
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] w-[2px] h-[36px] -ml-[1px] origin-top rounded-[1px] bg-green-500" style={{ transform: "rotateX(90deg) translateY(-18px)" }} />
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent -ml-[5px] -mt-[5px] origin-center border-b-[10px] border-b-green-500" style={{ transform: "translateZ(26px) rotateX(90deg)" }} />
          <div className="absolute left-1/2 top-1/2 [transform-style:preserve-3d] text-[13px] font-extrabold pointer-events-none -ml-[5px] -mt-[8px] text-green-500" style={{ transform: "translateZ(36px)" }}>Y</div>
        </div>
      </div>
    </div>
  );
}
