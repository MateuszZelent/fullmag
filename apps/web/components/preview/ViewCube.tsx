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

type SceneHandle = {
  camera: THREE.PerspectiveCamera;
  controls: TrackballControls;
};

interface ViewCubeProps {
  sceneRef?: React.MutableRefObject<SceneHandle | null>;
  grid?: [number, number, number];
  onRotate?: (quaternion: THREE.Quaternion) => void;
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

export default function ViewCube({ sceneRef, grid, onRotate }: ViewCubeProps) {
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, hasDragged: false });
  const cubeSceneRef = useRef<HTMLDivElement | null>(null);
  const axisSceneRef = useRef<HTMLDivElement | null>(null);

  // ─── Camera matrix → CSS ──────────────────────────────────────────
  const getCameraMatrix = useCallback((): string => {
    if (!sceneRef?.current) return "none";
    const scene = sceneRef.current;
    const { camera } = scene;
    _m.copy(camera.matrixWorldInverse);
    _m.elements[12] = 0;
    _m.elements[13] = 0;
    _m.elements[14] = 0;
    const e = _m.elements;
    return `matrix3d(${e[0]},${e[1]},${e[2]},0,${e[4]},${e[5]},${e[6]},0,${e[8]},${e[9]},${e[10]},0,0,0,0,1)`;
  }, [sceneRef]);

  // ─── Sync loop ────────────────────────────────────────────────────
  useEffect(() => {
    function loop() {
      const transform = getCameraMatrix();
      if (cubeSceneRef.current && cubeSceneRef.current.style.transform !== transform) {
        cubeSceneRef.current.style.transform = transform;
      }
      if (axisSceneRef.current && axisSceneRef.current.style.transform !== transform) {
        axisSceneRef.current.style.transform = transform;
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [getCameraMatrix]);

  // ─── Click face → snap camera ────────────────────────────────────
  const handleZoneClick = useCallback(
    (dir: [number, number, number]) => {
      if (dragRef.current.hasDragged) return;
      if (onRotate) {
        const targetDirection = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
        const quaternion = new THREE.Quaternion().setFromUnitVectors(
          new THREE.Vector3(0, 0, 1),
          targetDirection,
        );
        onRotate(quaternion);
        return;
      }
      if (!sceneRef?.current || !grid) return;
      const scene = sceneRef.current;
      const { camera, controls } = scene;
      const [nx, ny, nz] = grid;
      const cx = nx / 2, cy = nz / 2, cz = ny / 2;
      const dist = Math.max(nx, ny, nz) * 1.5;
      camera.position.set(
        cx + dir[0] * dist,
        cy + dir[1] * dist,
        cz + dir[2] * dist,
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(cx, cy, cz);
      controls.target.set(cx, cy, cz);
      controls.update();
    },
    [sceneRef, grid, onRotate],
  );

  // ─── Reset camera ────────────────────────────────────────────────
  const resetCamera = useCallback(() => {
    if (onRotate) {
      onRotate(new THREE.Quaternion());
      return;
    }
    const scene = sceneRef?.current;
    if (!scene || !grid) return;
    const { camera, controls } = scene;
    const [nx, ny, nz] = grid;
    const cx = nx / 2, cy = nz / 2, cz = ny / 2;
    const dist = Math.max(nx, ny, nz) * 1.5;
    camera.position.set(cx, cy, cz + dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(cx, cy, cz);
    controls.target.set(cx, cy, cz);
    controls.update();
  }, [sceneRef, grid, onRotate]);

  // ─── Drag orbit ──────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragRef.current = { dragging: true, hasDragged: false, startX: e.clientX, startY: e.clientY };
    (e.target as HTMLElement)?.setPointerCapture?.(e.pointerId);
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
    dragRef.current.dragging = false;
  }, []);

  return (
    <>
      {/* ViewCube */}
      <div className="absolute top-16 right-8 w-[88px] h-[98px] z-10 flex flex-col items-center pointer-events-none pt-[6px] rounded-xl bg-gradient-to-b from-slate-800/90 to-slate-900/80 border border-slate-500/20 shadow-xl backdrop-blur-md [perspective:220px]">
        <div
          ref={cubeSceneRef}
          className="relative w-[60px] h-[60px] [transform-style:preserve-3d] cursor-grab active:cursor-grabbing touch-none pointer-events-auto"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {faces.map((face, fi) => (
            <div key={fi} className={`absolute inset-0 w-[60px] h-[60px] grid grid-cols-[10px_1fr_10px] grid-rows-[10px_1fr_10px] [backface-visibility:visible] bg-gradient-to-br from-card to-muted border border-slate-400/20`} style={{ transform: face.cssTransform === "vcFaceTop" ? "translateZ(30px)" : face.cssTransform === "vcFaceBottom" ? "rotateY(180deg) translateZ(30px)" : face.cssTransform === "vcFaceRight" ? "rotateY(90deg) translateZ(30px)" : face.cssTransform === "vcFaceLeft" ? "rotateY(-90deg) translateZ(30px)" : face.cssTransform === "vcFaceFront" ? "rotateX(90deg) translateZ(30px)" : "rotateX(-90deg) translateZ(30px)" }}>
              {face.zones.flat().map((zone, zi) => (
                <button
                  key={zi}
                  className={`flex items-center justify-center border-none bg-transparent cursor-pointer p-0 m-0 transition-colors hover:bg-slate-400/20 ${zone.type === "face" ? "text-slate-200/80 hover:bg-slate-400/40 hover:text-white" : zone.type === "edge" ? "hover:bg-teal-500/30" : "hover:bg-amber-500/30"}`}
                  onClick={() => handleZoneClick(zone.dir)}
                  title={zone.label ?? ""}
                >
                  {zone.label && <span className="text-[8px] font-bold tracking-wider uppercase">{zone.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <button className="mt-[5px] w-[20px] h-[20px] rounded-full bg-slate-800/90 border border-slate-500/30 text-slate-200/70 text-[12px] cursor-pointer flex items-center justify-center transition-all backdrop-blur-md leading-none pointer-events-auto hover:bg-primary/20 hover:border-primary hover:text-white" onClick={resetCamera} title="Reset view">
          ⌂
        </button>
      </div>

      {/* Axis Gizmo */}
      <div className="absolute bottom-5 right-5 w-[90px] h-[90px] z-10 pointer-events-none [perspective:200px]">
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
    </>
  );
}
