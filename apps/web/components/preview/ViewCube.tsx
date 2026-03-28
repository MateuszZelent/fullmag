// @ts-nocheck
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
import s from "./ViewCube.module.css";

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
    const scene = sceneRef.current;
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
      const scene = sceneRef.current;
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
      <div className={s.vc}>
        <div
          ref={cubeSceneRef}
          className={s.vcScene}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {faces.map((face, fi) => (
            <div key={fi} className={`${s.vcFace} ${s[face.cssTransform]}`}>
              {face.zones.flat().map((zone, zi) => (
                <button
                  key={zi}
                  className={`${s.vcZone} ${s[`vcZone${zone.type}`]}`}
                  onClick={() => handleZoneClick(zone.dir)}
                  title={zone.label ?? ""}
                >
                  {zone.label && <span className={s.vcLabel}>{zone.label}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <button className={s.vcHome} onClick={resetCamera} title="Reset view">
          ⌂
        </button>
      </div>

      {/* Axis Gizmo */}
      <div className={s.ag}>
        <div ref={axisSceneRef} className={s.agScene}>
          {/* X axis (red) */}
          <div className={`${s.agShaft} ${s.agShaftX} ${s.agShaftXTransform}`} />
          <div className={`${s.agTip} ${s.agTipX} ${s.agTipXTransform}`} />
          <div className={`${s.agLbl} ${s.agLblX} ${s.agLblXTransform}`}>X</div>
          {/* Z axis (blue) */}
          <div className={`${s.agShaft} ${s.agShaftZ} ${s.agShaftZTransform}`} />
          <div className={`${s.agTip} ${s.agTipZ} ${s.agTipZTransform}`} />
          <div className={`${s.agLbl} ${s.agLblZ} ${s.agLblZTransform}`}>Z</div>
          {/* Y axis (green) */}
          <div className={`${s.agShaft} ${s.agShaftY} ${s.agShaftYTransform}`} />
          <div className={`${s.agTip} ${s.agTipY} ${s.agTipYTransform}`} />
          <div className={`${s.agLbl} ${s.agLblY} ${s.agLblYTransform}`}>Y</div>
        </div>
      </div>
    </>
  );
}
