"use client";

import { useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
// @ts-ignore – OrbitControls may not have types in all setups
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface Props {
  grid: [number, number, number];
  magnetization: Float64Array | null;
}

const ARROW_SCALE = 0.8;

function magnetizationHSL(mx: number, my: number, mz: number): [number, number, number] {
  // Hue from in-plane angle, lightness from z-component
  const hue = (Math.atan2(my, mx) / (2 * Math.PI) + 1) % 1;
  const lightness = 0.3 + 0.4 * (mz * 0.5 + 0.5);
  return [hue, 0.85, lightness];
}

function createArrowGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6);
  shaft.translate(0, -0.1, 0);
  const head = new THREE.ConeGeometry(0.2, 0.4, 6);
  head.translate(0, 0.3, 0);

  const merged = new THREE.BufferGeometry();
  merged.copy(shaft);
  // For simplicity, just use the cone as a separate merged geometry
  const shaftPositions = shaft.getAttribute("position").array;
  const headPositions = head.getAttribute("position").array;
  const positions = new Float32Array(shaftPositions.length + headPositions.length);
  positions.set(shaftPositions, 0);
  positions.set(headPositions, shaftPositions.length);

  const shaftIndices = Array.from(shaft.getIndex()!.array);
  const headIndices = Array.from(head.getIndex()!.array).map(
    (i) => i + shaftPositions.length / 3
  );

  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  merged.setIndex([...shaftIndices, ...headIndices]);
  merged.computeVertexNormals();
  return merged;
}

export default function MagnetizationView3D({ grid, magnetization }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    mesh: THREE.InstancedMesh;
    frameId: number;
  } | null>(null);

  const initScene = useCallback(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight || 400;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x0d1117, 1);
    container.appendChild(renderer.domElement);

    // Scene
    const scene = new THREE.Scene();

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(5, 10, 7);
    scene.add(directional);
    const hemisphere = new THREE.HemisphereLight(0x4488ff, 0x002244, 0.3);
    scene.add(hemisphere);

    // Camera
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    const [nx, ny, nz] = grid;
    const maxDim = Math.max(nx, ny, nz);
    camera.position.set(maxDim * 1.5, maxDim * 1.5, maxDim * 1.5);
    camera.lookAt(nx / 2, ny / 2, nz / 2);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(nx / 2, ny / 2, nz / 2);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    // Instanced mesh
    const count = nx * ny * nz;
    const geometry = createArrowGeometry();
    const material = new THREE.MeshPhongMaterial({
      vertexColors: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    scene.add(mesh);

    // Animation loop
    const animate = () => {
      const id = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      if (sceneRef.current) sceneRef.current.frameId = id;
    };
    const frameId = requestAnimationFrame(animate);

    // Resize
    const observer = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight || 400;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    observer.observe(container);

    sceneRef.current = { scene, camera, renderer, controls, mesh, frameId };

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, [grid]);

  // Initialize scene
  useEffect(() => {
    const cleanup = initScene();
    return cleanup;
  }, [initScene]);

  // Update magnetization
  useEffect(() => {
    if (!sceneRef.current || !magnetization) return;
    const { mesh } = sceneRef.current;
    const [nx, ny, nz] = grid;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);

    let idx = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const base = idx * 3;
          const mx = magnetization[base];
          const my = magnetization[base + 1];
          const mz = magnetization[base + 2];

          // Position
          dummy.position.set(ix, iy, iz);
          dummy.scale.setScalar(ARROW_SCALE);

          // Orientation — align arrow (Y-up) to magnetization direction
          const dir = new THREE.Vector3(mx, my, mz).normalize();
          const q = new THREE.Quaternion();
          q.setFromUnitVectors(up, dir);
          dummy.quaternion.copy(q);

          dummy.updateMatrix();
          mesh.setMatrixAt(idx, dummy.matrix);

          // Color
          const [h, s, l] = magnetizationHSL(mx, my, mz);
          color.setHSL(h, s, l);
          mesh.setColorAt(idx, color);

          idx++;
        }
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [magnetization, grid]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "500px",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        background: "#0d1117",
      }}
    />
  );
}
