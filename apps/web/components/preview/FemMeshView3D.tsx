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
  fieldData?: {
    x: number[];
    y: number[];
    z: number[];
  };
}

export type FemColorField = "x" | "y" | "z" | "magnitude" | "quality" | "none";
export type RenderMode = "surface" | "surface+edges" | "wireframe" | "points";
export type ClipAxis = "x" | "y" | "z";

interface Props {
  meshData: FemMeshData;
  colorField?: FemColorField;
  fieldLabel?: string;
  showWireframe?: boolean;
  topologyKey?: string;
  sessionId?: string;
}

/* ── Constants ─────────────────────────────────────────────────────── */

const BG_COLOR = 0x0c121f;

const COMP_NEGATIVE = new THREE.Color("#2f6caa");
const COMP_NEUTRAL  = new THREE.Color("#f4f1ed");
const COMP_POSITIVE = new THREE.Color("#cf6256");

const QUALITY_GOOD   = new THREE.Color("#35b779");
const QUALITY_MID    = new THREE.Color("#fde725");
const QUALITY_BAD    = new THREE.Color("#cf6256");

const RENDER_OPTIONS: { value: RenderMode; label: string }[] = [
  { value: "surface",        label: "Surface" },
  { value: "surface+edges",  label: "S+E" },
  { value: "wireframe",      label: "Wire" },
  { value: "points",         label: "Pts" },
];

const COLOR_OPTIONS: { value: FemColorField; label: string }[] = [
  { value: "z",          label: "Fz" },
  { value: "x",          label: "Fx" },
  { value: "y",          label: "Fy" },
  { value: "magnitude",  label: "|F|" },
  { value: "quality",    label: "Q" },
  { value: "none",       label: "—" },
];

/* ── Color helpers ─────────────────────────────────────────────────── */

function divergingColor(value: number, color: THREE.Color): void {
  const v = THREE.MathUtils.clamp(value, -1, 1);
  if (v < 0) color.copy(COMP_NEUTRAL).lerp(COMP_NEGATIVE, Math.abs(v));
  else       color.copy(COMP_NEUTRAL).lerp(COMP_POSITIVE, v);
}

function magnitudeColor(mag: number, color: THREE.Color): void {
  const t = THREE.MathUtils.clamp(mag, 0, 1);
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

function qualityColor(ar: number, color: THREE.Color): void {
  // AR=1 is perfect, >5 is bad
  const t = THREE.MathUtils.clamp((ar - 1) / 9, 0, 1); // 1→0, 10→1
  if (t < 0.5) color.copy(QUALITY_GOOD).lerp(QUALITY_MID, t * 2);
  else         color.copy(QUALITY_MID).lerp(QUALITY_BAD, (t - 0.5) * 2);
}

/* ── Per-face aspect ratio (boundary triangle) ─────────────────────── */

function computeFaceAspectRatios(nodes: number[], faces: number[]): Float32Array {
  const nFaces = faces.length / 3;
  const ars = new Float32Array(nFaces);
  for (let f = 0; f < nFaces; f++) {
    const ia = faces[f * 3], ib = faces[f * 3 + 1], ic = faces[f * 3 + 2];
    const ax = nodes[ia * 3], ay = nodes[ia * 3 + 1], az = nodes[ia * 3 + 2];
    const bx = nodes[ib * 3], by = nodes[ib * 3 + 1], bz = nodes[ib * 3 + 2];
    const cx = nodes[ic * 3], cy = nodes[ic * 3 + 1], cz = nodes[ic * 3 + 2];
    const ab = Math.sqrt((bx-ax)**2 + (by-ay)**2 + (bz-az)**2);
    const bc = Math.sqrt((cx-bx)**2 + (cy-by)**2 + (cz-bz)**2);
    const ca = Math.sqrt((ax-cx)**2 + (ay-cy)**2 + (az-cz)**2);
    const maxEdge = Math.max(ab, bc, ca);
    const sp = (ab + bc + ca) / 2;
    const area = Math.sqrt(Math.max(0, sp * (sp - ab) * (sp - bc) * (sp - ca)));
    // Circumradius-to-inradius ratio (normalized): AR = (maxEdge * sp) / (4 * area)
    const inradius = area / sp;
    ars[f] = inradius > 1e-18 ? maxEdge / (2 * inradius) : 1;
  }
  return ars;
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function FemMeshView3D({
  meshData,
  colorField = "z",
  fieldLabel,
  topologyKey,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<TrackballControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const wireRef = useRef<THREE.LineSegments | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const arrowGroupRef = useRef<THREE.Group | null>(null);
  const animIdRef = useRef<number>(0);
  const maxDimRef = useRef<number>(1);
  const centerRef = useRef<THREE.Vector3>(new THREE.Vector3());

  /* ── State ─────────────────────────────────────────────────────── */
  const [renderMode, setRenderMode] = useState<RenderMode>("surface");
  const [field, setField] = useState<FemColorField>(colorField);
  const [opacity, setOpacity] = useState(100);
  const [clipEnabled, setClipEnabled] = useState(false);
  const [clipAxis, setClipAxis] = useState<ClipAxis>("x");
  const [clipPos, setClipPos] = useState(50); // percentage 0-100
  const [showClipDrop, setShowClipDrop] = useState(false);
  const [showArrows, setShowArrows] = useState(false);

  useEffect(() => { setField(colorField); }, [colorField]);

  /* ── Aspect ratios (computed once per topology) ─────────────── */
  const faceARs = useRef<Float32Array | null>(null);

  /* ── Build geometry from mesh data ───────────────────────────── */
  const buildGeometry = useCallback((): THREE.BufferGeometry => {
    const { nodes, boundaryFaces, nNodes } = meshData;
    const positions = new Float32Array(nNodes * 3);
    for (let i = 0; i < nNodes * 3; i++) positions[i] = nodes[i];

    const nFaces = boundaryFaces.length / 3;
    const indices = new Uint32Array(nFaces * 3);
    for (let i = 0; i < nFaces * 3; i++) indices[i] = boundaryFaces[i];

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();

    /* Vertex colors */
    const colors = new Float32Array(nNodes * 3);
    const _c = new THREE.Color();
    const fld = meshData.fieldData;
    let scaleX = 1;
    let scaleY = 1;
    let scaleZ = 1;
    let scaleMagnitude = 1;

    if (fld) {
      let maxAbsX = 0;
      let maxAbsY = 0;
      let maxAbsZ = 0;
      let maxMag = 0;
      for (let i = 0; i < nNodes; i++) {
        const fx = fld.x[i] ?? 0;
        const fy = fld.y[i] ?? 0;
        const fz = fld.z[i] ?? 0;
        maxAbsX = Math.max(maxAbsX, Math.abs(fx));
        maxAbsY = Math.max(maxAbsY, Math.abs(fy));
        maxAbsZ = Math.max(maxAbsZ, Math.abs(fz));
        maxMag = Math.max(maxMag, Math.sqrt(fx * fx + fy * fy + fz * fz));
      }
      scaleX = maxAbsX > 1e-12 ? maxAbsX : 1;
      scaleY = maxAbsY > 1e-12 ? maxAbsY : 1;
      scaleZ = maxAbsZ > 1e-12 ? maxAbsZ : 1;
      scaleMagnitude = maxMag > 1e-12 ? maxMag : 1;
    }

    if (field === "quality") {
      // Compute AR per face, then average per vertex
      if (!faceARs.current) {
        faceARs.current = computeFaceAspectRatios(nodes, boundaryFaces);
      }
      const ars = faceARs.current;
      const vertexAR = new Float32Array(nNodes);
      const vertexCount = new Uint16Array(nNodes);
      for (let f = 0; f < nFaces; f++) {
        const ar = ars[f];
        for (let v = 0; v < 3; v++) {
          const vi = boundaryFaces[f * 3 + v];
          vertexAR[vi] += ar;
          vertexCount[vi]++;
        }
      }
      for (let i = 0; i < nNodes; i++) {
        const avg = vertexCount[i] > 0 ? vertexAR[i] / vertexCount[i] : 1;
        qualityColor(avg, _c);
        colors[i * 3] = _c.r;
        colors[i * 3 + 1] = _c.g;
        colors[i * 3 + 2] = _c.b;
      }
    } else {
      for (let i = 0; i < nNodes; i++) {
        if (!fld || field === "none") {
          _c.setHSL(0, 0, 0.6);
        } else {
          const fx = fld.x[i] ?? 0;
          const fy = fld.y[i] ?? 0;
          const fz = fld.z[i] ?? 0;
          switch (field) {
            case "x": divergingColor(fx / scaleX, _c); break;
            case "y": divergingColor(fy / scaleY, _c); break;
            case "z": divergingColor(fz / scaleZ, _c); break;
            case "magnitude": magnitudeColor(Math.sqrt(fx*fx + fy*fy + fz*fz) / scaleMagnitude, _c); break;
          }
        }
        colors[i * 3] = _c.r;
        colors[i * 3 + 1] = _c.g;
        colors[i * 3 + 2] = _c.b;
      }
    }

    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geom;
  }, [meshData, field]);

  /* ── Init scene ──────────────────────────────────────────────── */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    /* Renderer */
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(BG_COLOR);
    renderer.localClippingEnabled = true;
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
    faceARs.current = null; // reset on topology change
    const geom = buildGeometry();
    geom.computeBoundingBox();
    const bb = geom.boundingBox!;
    const center = new THREE.Vector3();
    bb.getCenter(center);
    const size = new THREE.Vector3();
    bb.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    maxDimRef.current = maxDim;


    /* Translate geometry to center */
    centerRef.current.copy(center);
    geom.translate(-center.x, -center.y, -center.z);

    /* Surface mesh */
    const material = new THREE.MeshPhongMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      flatShading: false,
      shininess: 40,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geom, material);
    scene.add(mesh);
    meshRef.current = mesh;

    /* Wireframe / edges */
    const edges = new THREE.EdgesGeometry(geom, 15);
    const wire = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x334455, opacity: 0.3, transparent: true })
    );
    wire.visible = false;
    scene.add(wire);
    wireRef.current = wire;

    /* Points cloud */
    const pointsMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: maxDim * 0.008,
      sizeAttenuation: true,
    });
    const pts = new THREE.Points(geom, pointsMat);
    pts.visible = false;
    scene.add(pts);
    pointsRef.current = pts;

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
  }, [topologyKey ?? `${meshData.nNodes}:${meshData.nElements}:${meshData.boundaryFaces.length}`]);

  /* ── Render mode ────────────────────────────────────────────────── */
  useEffect(() => {
    const mesh = meshRef.current;
    const wire = wireRef.current;
    const pts = pointsRef.current;
    if (!mesh || !wire || !pts) return;

    const mat = mesh.material as THREE.MeshPhongMaterial;
    switch (renderMode) {
      case "surface":
        mesh.visible = true; wire.visible = false; pts.visible = false;
        mat.wireframe = false;
        break;
      case "surface+edges":
        mesh.visible = true; wire.visible = true; pts.visible = false;
        mat.wireframe = false;
        break;
      case "wireframe":
        mesh.visible = true; wire.visible = false; pts.visible = false;
        mat.wireframe = true;
        break;
      case "points":
        mesh.visible = false; wire.visible = false; pts.visible = true;
        break;
    }
  }, [renderMode]);

  /* ── Opacity ────────────────────────────────────────────────────── */
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshPhongMaterial;
    mat.opacity = opacity / 100;
    mat.transparent = opacity < 100;
    mat.depthWrite = opacity >= 100;
    mat.needsUpdate = true;
  }, [opacity]);

  /* ── Clipping plane ─────────────────────────────────────────────── */
  useEffect(() => {
    const renderer = rendererRef.current;
    const mesh = meshRef.current;
    if (!renderer || !mesh) return;

    if (!clipEnabled) {
      renderer.clippingPlanes = [];
      return;
    }

    const normal = new THREE.Vector3(
      clipAxis === "x" ? -1 : 0,
      clipAxis === "y" ? -1 : 0,
      clipAxis === "z" ? -1 : 0,
    );

    const maxDim = maxDimRef.current;
    const pos = ((clipPos / 100) - 0.5) * maxDim;
    const plane = new THREE.Plane(normal, pos);
    renderer.clippingPlanes = [plane];
  }, [clipEnabled, clipAxis, clipPos]);

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

    const pts = pointsRef.current;
    if (pts) {
      pts.geometry = geom;
    }
  }, [field, buildGeometry]);

  /* ── Arrow plot (COMSOL-style cone glyphs) ──────────────────────── */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old arrows
    if (arrowGroupRef.current) {
      scene.remove(arrowGroupRef.current);
      arrowGroupRef.current.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        if ((obj as THREE.Mesh).material) {
          const mat = (obj as THREE.Mesh).material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
      arrowGroupRef.current = null;
    }

    const fld = meshData.fieldData;
    if (!showArrows || !fld) return;

    const { nodes, boundaryFaces, nNodes } = meshData;
    const maxDim = maxDimRef.current;
    const center = centerRef.current;
    const arrowLen = maxDim * 0.04;
    const arrowRadius = arrowLen * 0.15;

    // Sample every Nth boundary node to keep cone count reasonable
    const uniqueNodeSet = new Set<number>();
    for (let i = 0; i < boundaryFaces.length; i++) uniqueNodeSet.add(boundaryFaces[i]);
    const allBoundaryNodes = Array.from(uniqueNodeSet);
    const maxArrows = 600;
    const step = Math.max(1, Math.floor(allBoundaryNodes.length / maxArrows));
    const sampledNodes = allBoundaryNodes.filter((_, i) => i % step === 0);

    const group = new THREE.Group();
    const coneGeom = new THREE.ConeGeometry(arrowRadius, arrowLen, 6);
    coneGeom.rotateX(Math.PI / 2); // align tip with +Z
    coneGeom.translate(0, 0, arrowLen / 2);

    const _dir = new THREE.Vector3();
    const _quat = new THREE.Quaternion();
    const _zAxis = new THREE.Vector3(0, 0, 1);
    const _color = new THREE.Color();

    for (const ni of sampledNodes) {
      const px = nodes[ni * 3] - center.x;
      const py = nodes[ni * 3 + 1] - center.y;
      const pz = nodes[ni * 3 + 2] - center.z;
      const vx = fld.x[ni] ?? 0;
      const vy = fld.y[ni] ?? 0;
      const vz = fld.z[ni] ?? 0;
      const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (len < 1e-6) continue;

      _dir.set(vx, vy, vz).normalize();
      _quat.setFromUnitVectors(_zAxis, _dir);

      divergingColor(vz / Math.max(len, 1e-12), _color);

      const mat = new THREE.MeshPhongMaterial({ color: _color.clone(), shininess: 60 });
      const cone = new THREE.Mesh(coneGeom.clone(), mat);
      cone.position.set(px, py, pz);
      cone.quaternion.copy(_quat);
      group.add(cone);
    }

    scene.add(group);
    arrowGroupRef.current = group;
  }, [showArrows, meshData.fieldData, meshData]);

  /* ── Camera presets ──────────────────────────────────────────────── */
  const setCameraPreset = useCallback((view: "reset" | "front" | "top" | "right") => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const d = maxDimRef.current * 2;
    switch (view) {
      case "reset":
        camera.position.set(d * 0.75, d * 0.6, d * 0.75);
        camera.up.set(0, 1, 0);
        break;
      case "front":
        camera.position.set(0, 0, d);
        camera.up.set(0, 1, 0);
        break;
      case "top":
        camera.position.set(0, d, 0);
        camera.up.set(0, 0, -1);
        break;
      case "right":
        camera.position.set(d, 0, 0);
        camera.up.set(0, 1, 0);
        break;
    }
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
  }, []);

  /* ── Screenshot ──────────────────────────────────────────────────── */
  const takeScreenshot = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const dataUrl = renderer.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `fem-mesh-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

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
      {/* ─── Toolbar ────────────────────────────────── */}
      <div className={s.toolbar}>
        {/* Render mode */}
        <div className={s.toolGroup}>
          <span className={s.toolLabel}>Render</span>
          {RENDER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={s.toolBtn}
              data-active={renderMode === opt.value}
              onClick={() => setRenderMode(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Color field */}
        <div className={s.toolGroup}>
          <span className={s.toolLabel}>Color</span>
          {COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={s.toolBtn}
              data-active={field === opt.value}
              onClick={() => setField(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Clip */}
        <div className={s.toolGroup} style={{ position: "relative" }}>
          <button
            className={s.toolBtn}
            data-active={clipEnabled}
            onClick={() => {
              setClipEnabled((v) => !v);
              if (!clipEnabled) setShowClipDrop(true);
            }}
          >
            ✂ Clip
          </button>
          {clipEnabled && (
            <button
              className={s.toolBtnIcon}
              onClick={() => setShowClipDrop((v) => !v)}
            >
              ▾
            </button>
          )}
          {showClipDrop && clipEnabled && (
            <div className={s.dropPanel}>
              <div className={s.dropRow}>
                <span className={s.dropLabel}>Axis</span>
                {(["x", "y", "z"] as ClipAxis[]).map((a) => (
                  <button
                    key={a}
                    className={s.toolBtn}
                    data-active={clipAxis === a}
                    onClick={() => setClipAxis(a)}
                    style={{ padding: "0.2rem 0.45rem" }}
                  >
                    {a.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className={s.dropRow}>
                <span className={s.dropLabel}>Pos</span>
                <input
                  type="range"
                  className={s.dropSlider}
                  min={0}
                  max={100}
                  value={clipPos}
                  onChange={(e) => setClipPos(Number(e.target.value))}
                />
                <span className={s.dropValue}>{clipPos}%</span>
              </div>
              <button
                className={s.toolBtn}
                onClick={() => setShowClipDrop(false)}
                style={{ fontSize: "0.64rem", opacity: 0.7 }}
              >
                Close
              </button>
            </div>
          )}
        </div>

        {/* Opacity */}
        <div className={s.toolGroup}>
          <span className={s.toolLabel}>Opacity</span>
          <input
            type="range"
            className={s.dropSlider}
            min={10}
            max={100}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            style={{ width: 60 }}
          />
          <span className={s.dropValue}>{opacity}%</span>
        </div>

        {/* Arrow plot */}
        <div className={s.toolGroup}>
          <button
            className={s.toolBtn}
            data-active={showArrows}
            onClick={() => setShowArrows((v) => !v)}
          >
            ↗ Arrows
          </button>
        </div>

        <div className={s.toolSep} />

        {/* Camera presets */}
        <div className={s.toolGroup}>
          {(["reset", "front", "top", "right"] as const).map((view) => (
            <button
              key={view}
              className={s.toolBtn}
              onClick={() => setCameraPreset(view)}
            >
              {view === "reset" ? "⟲" : view[0].toUpperCase()}
            </button>
          ))}
        </div>

        {/* Screenshot */}
        <div className={s.toolGroup}>
          <button className={s.toolBtnIcon} onClick={takeScreenshot} title="Screenshot">
            📷
          </button>
        </div>
      </div>

      {/* ─── Info bar ───────────────────────────────── */}
      <div className={s.info}>
        <span>{meshData.nNodes.toLocaleString()} nodes</span>
        <span className={s.infoSep} />
        <span>{meshData.nElements.toLocaleString()} tets</span>
        <span className={s.infoSep} />
        <span>{(meshData.boundaryFaces.length / 3).toLocaleString()} faces</span>
        {clipEnabled && (
          <>
            <span className={s.infoSep} />
            <span style={{ color: "hsl(35 90% 65%)" }}>clip {clipAxis.toUpperCase()} @ {clipPos}%</span>
          </>
        )}
      </div>

      {/* ─── ViewCube ───────────────────────────────── */}
      <div className={s.viewCubeWrapper}>
        <ViewCube onRotate={handleViewCubeRotate} />
      </div>
    </div>
  );
}
