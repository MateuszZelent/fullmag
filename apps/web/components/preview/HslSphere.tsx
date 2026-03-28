"use client";

/**
 * HSL Colour Sphere – a 3D colour reference that rotates in sync with the
 * main magnetization view camera.
 *
 * The sphere surface is coloured with the exact same `magnetizationHSL`
 * mapping used for arrow colouring:
 *   hue        = atan2(y, x) / 2π
 *   saturation = 1
 *   lightness  = (z + 1) / 2
 *
 * Three axis labels (X / Y / Z) protrude from the sphere to make the
 * mapping unambiguous. The whole thing rotates with the main viewport camera.
 */

import { useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import type { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { magnetizationHslColor } from "./magnetizationColor";
import { cn } from "@/lib/utils";

/* ── Types ─────────────────────────────────────────────────── */

interface HslSphereProps {
  sceneRef: React.MutableRefObject<{
    camera: THREE.PerspectiveCamera;
    controls: TrackballControls;
  } | null>;
}

/* ── Constants ─────────────────────────────────────────────── */

const SIZE = 110; // px  (canvas size)
const SPHERE_RADIUS = 0.9;
const SEGMENTS = 64;

/* ── Build sphere mesh with vertex colours ────────────────── */

function buildColoredSphere(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(SPHERE_RADIUS, SEGMENTS, SEGMENTS);
  const posAttr = geo.attributes.position;
  const colors = new Float32Array(posAttr.count * 3);
  const _v = new THREE.Vector3();

  for (let i = 0; i < posAttr.count; i++) {
    _v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).normalize();
    // Simulation convention: sim-X → world-X, sim-Z → world-Y, sim-Y → world-Z
    // The sphere directions map: world (x, y, z) → sim (x, z, y)
    const c = magnetizationHslColor(_v.x, _v.z, _v.y);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  return new THREE.Mesh(geo, mat);
}

/* ── Build axis labels as sprites ─────────────────────────── */

function makeLabel(text: string, color: string, pos: THREE.Vector3): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 64);

  // Background circle
  ctx.beginPath();
  ctx.arc(32, 32, 22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(10, 15, 30, 0.75)";
  ctx.fill();

  // Border
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Text
  ctx.font = "bold 28px Inter, system-ui, sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.position.copy(pos);
  sprite.scale.set(0.32, 0.32, 1);
  return sprite;
}

/* ── Component ─────────────────────────────────────────────── */

export default function HslSphere({ sceneRef }: HslSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const internalsRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  // ── Setup inset scene once ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
    cam.position.set(0, 0, 3);
    cam.lookAt(0, 0, 0);

    scene.add(buildColoredSphere());

    // Axis labels — using simulation convention (sim-Y → world-Z, sim-Z → world-Y)
    const labelDist = 1.18;
    scene.add(makeLabel("X", "#e65050", new THREE.Vector3(labelDist, 0, 0)));
    scene.add(makeLabel("X", "#e65050", new THREE.Vector3(-labelDist, 0, 0)));
    scene.add(makeLabel("Z", "#5090e6", new THREE.Vector3(0, labelDist, 0)));
    scene.add(makeLabel("Z", "#5090e6", new THREE.Vector3(0, -labelDist, 0)));
    scene.add(makeLabel("Y", "#50c850", new THREE.Vector3(0, 0, labelDist)));
    scene.add(makeLabel("Y", "#50c850", new THREE.Vector3(0, 0, -labelDist)));

    // Thin axis lines through sphere
    const lineGeo = (from: THREE.Vector3, to: THREE.Vector3, color: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, opacity: 0.5, transparent: true }));
    };
    scene.add(lineGeo(new THREE.Vector3(-1.05, 0, 0), new THREE.Vector3(1.05, 0, 0), 0xe65050));
    scene.add(lineGeo(new THREE.Vector3(0, -1.05, 0), new THREE.Vector3(0, 1.05, 0), 0x5090e6));
    scene.add(lineGeo(new THREE.Vector3(0, 0, -1.05), new THREE.Vector3(0, 0, 1.05), 0x50c850));

    internalsRef.current = { renderer, scene, camera: cam };

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      renderer.dispose();
    };
  }, []);

  // ── Sync rotation with main camera ──
  const syncRotation = useCallback(() => {
    const inset = internalsRef.current;
    const main = sceneRef.current;
    if (!inset || !main) return;

    // Copy camera rotation (orientation only, no translation)
    inset.camera.quaternion.copy(main.camera.quaternion);
    inset.camera.position
      .set(0, 0, 3)
      .applyQuaternion(inset.camera.quaternion);
    inset.camera.lookAt(0, 0, 0);

    inset.renderer.render(inset.scene, inset.camera);
  }, [sceneRef]);

  useEffect(() => {
    function loop() {
      syncRotation();
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [syncRotation]);

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 h-[110px] w-[110px]">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className={cn("block h-full w-full rounded-full")}
      />
    </div>
  );
}
