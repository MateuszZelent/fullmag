// @ts-nocheck
"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import ViewCube from "./ViewCube";
import s from "./FemMeshView3D.module.css";

/* ── Types ─────────────────────────────────────────────────────────── */

export interface FemMeshData {
  nodes: number[];           // flattened [x0,y0,z0, x1,y1,z1, ...]
  boundaryFaces: number[];   // flattened [n0,n1,n2, ...]
  nNodes: number;
  nElements: number;
  magnetization?: {
    mx: number[];
    my: number[];
    mz: number[];
  };
}

export type FemColorField = "mz" | "mx" | "my" | "|m|" | "none";

interface Props {
  meshData: FemMeshData;
  colorField?: FemColorField;
  showWireframe?: boolean;
}

/* ── Constants ─────────────────────────────────────────────────────── */

const BG_COLOR = 0x0c121f;

const COMP_NEGATIVE = new THREE.Color("#2f6caa");
const COMP_NEUTRAL  = new THREE.Color("#f4f1ed");
const COMP_POSITIVE = new THREE.Color("#cf6256");

/* ── Coloring ──────────────────────────────────────────────────────── */

function divergingColor(value: number, color: THREE.Color): void {
  const v = THREE.MathUtils.clamp(value, -1, 1);
  if (v < 0) {
    color.copy(COMP_NEUTRAL).lerp(COMP_NEGATIVE, Math.abs(v));
  } else {
    color.copy(COMP_NEUTRAL).lerp(COMP_POSITIVE, v);
  }
}

function magnitudeColor(mag: number, color: THREE.Color): void {
  const t = THREE.MathUtils.clamp(mag, 0, 1);
  /* Viridis-like: dark purple → teal → yellow */
  const stops = [
    new THREE.Color(0x440154),
    new THREE.Color(0x31688e),
    new THREE.Color(0x35b779),
    new THREE.Color(0xfde725),
  ];
  const idx = Math.min(Math.floor(t * 3), 2);
  const frac = t * 3 - idx;
  color.copy(stops[idx]).lerp(stops[idx + 1], frac);
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function FemMeshView3D({
  meshData,
  colorField = "mz",
  showWireframe: initialWireframe = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<TrackballControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const wireRef = useRef<THREE.LineSegments | null>(null);
  const animIdRef = useRef<number>(0);

  const [wireframe, setWireframe] = useState(initialWireframe);
  const [field, setField] = useState<FemColorField>(colorField);

  useEffect(() => {
    setField(colorField);
  }, [colorField]);

  /* ── Build geometry from mesh data ───────────────────────────────── */
  const buildGeometry = useCallback((): THREE.BufferGeometry => {
    const { nodes, boundaryFaces, nNodes } = meshData;
    const positions = new Float32Array(nNodes * 3);
    for (let i = 0; i < nNodes * 3; i++) {
      positions[i] = nodes[i];
    }

    const nFaces = boundaryFaces.length / 3;
    const indices = new Uint32Array(nFaces * 3);
    for (let i = 0; i < nFaces * 3; i++) {
      indices[i] = boundaryFaces[i];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();

    /* Vertex colors */
    const colors = new Float32Array(nNodes * 3);
    const _c = new THREE.Color();
    const mag = meshData.magnetization;

    for (let i = 0; i < nNodes; i++) {
      if (!mag || field === "none") {
        _c.setHSL(0, 0, 0.6);
      } else {
        const mx = mag.mx[i] ?? 0;
        const my = mag.my[i] ?? 0;
        const mz = mag.mz[i] ?? 0;

        switch (field) {
          case "mx": divergingColor(mx, _c); break;
          case "my": divergingColor(my, _c); break;
          case "mz": divergingColor(mz, _c); break;
          case "|m|": magnitudeColor(Math.sqrt(mx*mx + my*my + mz*mz), _c); break;
        }
      }
      colors[i * 3 + 0] = _c.r;
      colors[i * 3 + 1] = _c.g;
      colors[i * 3 + 2] = _c.b;
    }
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geom;
  }, [meshData, field]);

  /* ── Init scene ──────────────────────────────────────────────────── */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    /* Renderer */
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(BG_COLOR);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    /* Scene */
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    /* Lights */
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(1, 2, 3);
    scene.add(dirLight);
    const backLight = new THREE.DirectionalLight(0x6688cc, 0.3);
    backLight.position.set(-1, -1, -2);
    scene.add(backLight);

    /* Camera */
    const camera = new THREE.PerspectiveCamera(45, width / height, 1e-12, 1);
    cameraRef.current = camera;

    /* Controls */
    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 3;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 0.8;
    controlsRef.current = controls;

    /* Build mesh */
    const geom = buildGeometry();
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const center = new THREE.Vector3();
    bb.getCenter(center);
    const size = new THREE.Vector3();
    bb.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    /* Translate geometry to center */
    geom.translate(-center.x, -center.y, -center.z);

    /* Surface mesh */
    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      flatShading: false,
      shininess: 40,
    });
    const mesh = new THREE.Mesh(geom, material);
    scene.add(mesh);
    meshRef.current = mesh;

    /* Wireframe */
    const edges = new THREE.EdgesGeometry(geom, 15);
    const wire = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x334455, opacity: 0.3, transparent: true })
    );
    wire.visible = wireframe;
    scene.add(wire);
    wireRef.current = wire;

    /* Position camera */
    camera.position.set(maxDim * 1.5, maxDim * 1.2, maxDim * 1.5);
    camera.lookAt(0, 0, 0);
    camera.near = maxDim * 0.001;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);

    /* Animate */
    function animate() {
      animIdRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    /* Resize */
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);

    return () => {
      cancelAnimationFrame(animIdRef.current);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [meshData]); // re-init on new mesh data

  /* ── Wireframe toggle ────────────────────────────────────────────── */
  useEffect(() => {
    if (wireRef.current) wireRef.current.visible = wireframe;
  }, [wireframe]);

  /* ── Field change → recolor ──────────────────────────────────────── */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const geom = buildGeometry();
    const oldGeom = mesh.geometry;
    mesh.geometry = geom;
    oldGeom.dispose();

    const wire = wireRef.current;
    if (wire) {
      const edges = new THREE.EdgesGeometry(geom, 15);
      wire.geometry.dispose();
      wire.geometry = edges;
    }
  }, [field, buildGeometry]);

  /* ── Camera sync for ViewCube ────────────────────────────────────── */
  const handleViewCubeRotate = useCallback((quaternion: THREE.Quaternion) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const dist = camera.position.length();
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).multiplyScalar(dist);
    camera.position.copy(dir);
    camera.lookAt(0, 0, 0);
    camera.up.set(0, 1, 0).applyQuaternion(quaternion);
    controls.target.set(0, 0, 0);
  }, []);

  return (
    <div className={s.container} ref={containerRef}>
      {/* Toolbar */}
      <div className={s.toolbar}>
        <button
          className={s.toolBtn}
          data-active={wireframe}
          onClick={() => setWireframe((v) => !v)}
        >
          Wire
        </button>
        {(["mz", "mx", "my", "|m|", "none"] as FemColorField[]).map((f) => (
          <button
            key={f}
            className={s.toolBtn}
            data-active={field === f}
            onClick={() => setField(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Info */}
      <div className={s.info}>
        {meshData.nNodes.toLocaleString()} nodes · {meshData.nElements.toLocaleString()} tets ·{" "}
        {(meshData.boundaryFaces.length / 3).toLocaleString()} faces
      </div>

      {/* ViewCube */}
      <div className={s.viewCubeWrapper}>
        <ViewCube onRotate={handleViewCubeRotate} />
      </div>
    </div>
  );
}
