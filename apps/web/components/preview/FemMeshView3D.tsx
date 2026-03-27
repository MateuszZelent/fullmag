// @ts-nocheck
"use client";

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import * as THREE from "three";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import HslSphere from "./HslSphere";
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

export interface MeshSelectionSnapshot {
  selectedFaceIndices: number[];
  primaryFaceIndex: number | null;
}

export type FemColorField = "orientation" | "x" | "y" | "z" | "magnitude" | "quality" | "sicn" | "none";
export type RenderMode = "surface" | "surface+edges" | "wireframe" | "points";
export type ClipAxis = "x" | "y" | "z";

interface Props {
  meshData: FemMeshData;
  colorField?: FemColorField;
  fieldLabel?: string;
  showWireframe?: boolean;
  topologyKey?: string;
  toolbarMode?: "visible" | "hidden";
  renderMode?: RenderMode;
  opacity?: number;
  clipEnabled?: boolean;
  clipAxis?: ClipAxis;
  clipPos?: number;
  showArrows?: boolean;
  showOrientationLegend?: boolean;
  qualityPerFace?: number[] | null;
  onRenderModeChange?: (value: RenderMode) => void;
  onOpacityChange?: (value: number) => void;
  onClipEnabledChange?: (value: boolean) => void;
  onClipAxisChange?: (value: ClipAxis) => void;
  onClipPosChange?: (value: number) => void;
  onShowArrowsChange?: (value: boolean) => void;
  onSelectionChange?: (selection: MeshSelectionSnapshot) => void;
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
  { value: "orientation", label: "Ori" },
  { value: "z",          label: "Fz" },
  { value: "x",          label: "Fx" },
  { value: "y",          label: "Fy" },
  { value: "magnitude",  label: "|F|" },
  { value: "quality",    label: "AR" },
  { value: "sicn",       label: "SICN" },
  { value: "none",       label: "—" },
];

/* ── Color helpers ─────────────────────────────────────────────────── */

function divergingColor(value: number, color: THREE.Color): void {
  const v = THREE.MathUtils.clamp(value, -1, 1);
  if (v < 0) color.copy(COMP_NEUTRAL).lerp(COMP_NEGATIVE, Math.abs(v));
  else       color.copy(COMP_NEUTRAL).lerp(COMP_POSITIVE, v);
}

function magnetizationHSL(vx: number, vy: number, vz: number, color: THREE.Color): void {
  const hue = Math.atan2(vy, vx) / (Math.PI * 2);
  const saturation = Math.min(1, Math.sqrt(vx * vx + vy * vy + vz * vz));
  const lightness = THREE.MathUtils.clamp(vz * 0.5 + 0.5, 0.18, 0.84);
  color.setHSL((hue + 1) % 1, saturation, lightness);
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

function sicnQualityColor(sicn: number, color: THREE.Color): void {
  // SICN: 1 = perfect, 0 = degenerate, <0 = inverted
  const t = THREE.MathUtils.clamp(sicn, -1, 1);
  if (t < 0) {
    // Inverted: red
    color.copy(QUALITY_BAD);
  } else if (t < 0.3) {
    // Poor: red → yellow
    color.copy(QUALITY_BAD).lerp(QUALITY_MID, t / 0.3);
  } else {
    // Good: yellow → green
    color.copy(QUALITY_MID).lerp(QUALITY_GOOD, (t - 0.3) / 0.7);
  }
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
  toolbarMode = "visible",
  renderMode: controlledRenderMode,
  opacity: controlledOpacity,
  clipEnabled: controlledClipEnabled,
  clipAxis: controlledClipAxis,
  clipPos: controlledClipPos,
  showArrows: controlledShowArrows,
  showOrientationLegend = false,
  qualityPerFace,
  onRenderModeChange,
  onOpacityChange,
  onClipEnabledChange,
  onClipAxisChange,
  onClipPosChange,
  onShowArrowsChange,
  onSelectionChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<TrackballControls | null>(null);
  const viewCubeSceneRef = useRef<{
    camera: THREE.PerspectiveCamera;
    controls: TrackballControls;
  } | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const wireRef = useRef<THREE.LineSegments | null>(null);
  const pointsRef = useRef<THREE.Points | null>(null);
  const arrowGroupRef = useRef<THREE.Group | null>(null);
  const animIdRef = useRef<number>(0);
  const maxDimRef = useRef<number>(1);
  const centerRef = useRef<THREE.Vector3>(new THREE.Vector3());

  /* ── State ─────────────────────────────────────────────────────── */
  const [internalRenderMode, setInternalRenderMode] = useState<RenderMode>("surface");
  const [field, setField] = useState<FemColorField>(colorField);
  const [internalOpacity, setInternalOpacity] = useState(100);
  const [internalClipEnabled, setInternalClipEnabled] = useState(false);
  const [internalClipAxis, setInternalClipAxis] = useState<ClipAxis>("x");
  const [internalClipPos, setInternalClipPos] = useState(50); // percentage 0-100
  const [showClipDrop, setShowClipDrop] = useState(false);
  const [internalShowArrows, setInternalShowArrows] = useState(false);
  const [hoveredFace, setHoveredFace] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; faceIdx: number } | null>(null);
  const [selectedFaces, setSelectedFaces] = useState<number[]>([]);
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const highlightRef = useRef<THREE.Mesh | null>(null);
  const topologySignature = topologyKey ?? `${meshData.nNodes}:${meshData.nElements}:${meshData.boundaryFaces.length}`;

  const renderMode = controlledRenderMode ?? internalRenderMode;
  const opacity = controlledOpacity ?? internalOpacity;
  const clipEnabled = controlledClipEnabled ?? internalClipEnabled;
  const clipAxis = controlledClipAxis ?? internalClipAxis;
  const clipPos = controlledClipPos ?? internalClipPos;
  const showArrows = controlledShowArrows ?? internalShowArrows;

  const updateRenderMode = useCallback((value: RenderMode) => {
    if (onRenderModeChange) onRenderModeChange(value);
    else setInternalRenderMode(value);
  }, [onRenderModeChange]);

  const updateOpacity = useCallback((value: number) => {
    if (onOpacityChange) onOpacityChange(value);
    else setInternalOpacity(value);
  }, [onOpacityChange]);

  const updateClipEnabled = useCallback((value: boolean) => {
    if (onClipEnabledChange) onClipEnabledChange(value);
    else setInternalClipEnabled(value);
  }, [onClipEnabledChange]);

  const updateClipAxis = useCallback((value: ClipAxis) => {
    if (onClipAxisChange) onClipAxisChange(value);
    else setInternalClipAxis(value);
  }, [onClipAxisChange]);

  const updateClipPos = useCallback((value: number) => {
    if (onClipPosChange) onClipPosChange(value);
    else setInternalClipPos(value);
  }, [onClipPosChange]);

  const updateShowArrows = useCallback((value: boolean) => {
    if (onShowArrowsChange) onShowArrowsChange(value);
    else setInternalShowArrows(value);
  }, [onShowArrowsChange]);

  useEffect(() => { setField(colorField); }, [colorField]);

  useEffect(() => {
    setSelectedFaces([]);
    setHoveredFace(null);
    setCtxMenu(null);
  }, [topologySignature]);

  useEffect(() => {
    onSelectionChange?.({
      selectedFaceIndices: selectedFaces,
      primaryFaceIndex: selectedFaces.length > 0 ? selectedFaces[selectedFaces.length - 1] : null,
    });
  }, [onSelectionChange, selectedFaces]);

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
    } else if (field === "sicn") {
      // Use backend SICN data per face if available, else fall back to AR
      const perFace = qualityPerFace;
      if (perFace && perFace.length === nFaces) {
        const vertexSICN = new Float32Array(nNodes);
        const vertexCount = new Uint16Array(nNodes);
        for (let f = 0; f < nFaces; f++) {
          const val = perFace[f];
          for (let v = 0; v < 3; v++) {
            const vi = boundaryFaces[f * 3 + v];
            vertexSICN[vi] += val;
            vertexCount[vi]++;
          }
        }
        for (let i = 0; i < nNodes; i++) {
          const avg = vertexCount[i] > 0 ? vertexSICN[i] / vertexCount[i] : 0;
          sicnQualityColor(avg, _c);
          colors[i * 3] = _c.r;
          colors[i * 3 + 1] = _c.g;
          colors[i * 3 + 2] = _c.b;
        }
      } else {
        // Fallback: use AR-based quality
        if (!faceARs.current) {
          faceARs.current = computeFaceAspectRatios(nodes, boundaryFaces);
        }
        const ars = faceARs.current;
        const vertexAR = new Float32Array(nNodes);
        const vertexCount = new Uint16Array(nNodes);
        for (let f = 0; f < nFaces; f++) {
          for (let v = 0; v < 3; v++) {
            const vi = boundaryFaces[f * 3 + v];
            vertexAR[vi] += ars[f];
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
            case "orientation": magnetizationHSL(fx, fy, fz, _c); break;
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
    renderer.domElement.className = s.canvas;
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
    viewCubeSceneRef.current = { camera, controls };

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
    const edges = new THREE.WireframeGeometry(geom);
    const wire = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x9bb7d4, opacity: 0.5, transparent: true })
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
      if (w <= 0 || h <= 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(container);
    const rafId = requestAnimationFrame(onResize);

    return () => {
      cancelAnimationFrame(animIdRef.current);
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.dispose();
      viewCubeSceneRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [topologySignature]);

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

    const maxDim = maxDimRef.current;
    const pos = ((clipPos / 100) - 0.5) * maxDim;
    const normal = new THREE.Vector3(
      clipAxis === "x" ? -1 : 0,
      clipAxis === "y" ? -1 : 0,
      clipAxis === "z" ? -1 : 0,
    );
    const plane = new THREE.Plane(normal, pos);
    renderer.clippingPlanes = [plane];
  }, [clipEnabled, clipAxis, clipPos]);

  /* ── Face highlight (multi-selection glow) ──────────────────────── */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old highlight
    if (highlightRef.current) {
      scene.remove(highlightRef.current);
      highlightRef.current.geometry.dispose();
      (highlightRef.current.material as THREE.Material).dispose();
      highlightRef.current = null;
    }

    if (selectedFaces.length === 0) return;

    const { nodes, boundaryFaces } = meshData;
    const indices: number[] = [];
    selectedFaces.forEach((fIdx) => {
      const base = fIdx * 3;
      if (base + 2 < boundaryFaces.length) {
        indices.push(boundaryFaces[base], boundaryFaces[base + 1], boundaryFaces[base + 2]);
      }
    });

    if (indices.length === 0) return;

    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(meshData.nNodes * 3);
    for (let i = 0; i < meshData.nNodes * 3; i++) positions[i] = nodes[i];
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geom.translate(-centerRef.current.x, -centerRef.current.y, -centerRef.current.z);

    const mat = new THREE.MeshPhongMaterial({
      color: 0x63b3ed,
      emissive: 0x3182ce,
      emissiveIntensity: 0.5,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    const highlight = new THREE.Mesh(geom, mat);
    scene.add(highlight);
    highlightRef.current = highlight;
  }, [selectedFaces, meshData]);

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
      const edges = new THREE.WireframeGeometry(geom);
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

      switch (field) {
        case "orientation":
          magnetizationHSL(vx, vy, vz, _color);
          break;
        case "x":
          divergingColor(vx / Math.max(maxDim, 1e-12), _color);
          break;
        case "y":
          divergingColor(vy / Math.max(maxDim, 1e-12), _color);
          break;
        case "z":
          divergingColor(vz / Math.max(maxDim, 1e-12), _color);
          break;
        case "magnitude":
          magnitudeColor(len / Math.max(len, 1e-12), _color);
          break;
        default:
          divergingColor(vz / Math.max(len, 1e-12), _color);
          break;
      }

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

  /* ── Raycaster: face hover ──────────────────────────────────────── */
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    const camera = cameraRef.current;
    const mesh = meshRef.current;
    if (!container || !camera || !mesh) return;

    const rect = container.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const hits = raycasterRef.current.intersectObject(mesh, false);
    if (hits.length > 0 && hits[0].faceIndex != null) {
      setHoveredFace({ idx: hits[0].faceIndex, x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      setHoveredFace(null);
    }
  }, []);

  /* ── Right-click: context menu ──────────────────────────────────── */
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    const camera = cameraRef.current;
    const mesh = meshRef.current;
    if (!container || !camera || !mesh) return;

    const rect = container.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const hits = raycasterRef.current.intersectObject(mesh, false);
    if (hits.length > 0 && hits[0].faceIndex != null) {
      setCtxMenu({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        faceIdx: hits[0].faceIndex,
      });
    } else {
      setCtxMenu(null);
    }
  }, []);

  const dismissCtxMenu = useCallback(() => setCtxMenu(null), []);

  /* Click to toggle face selection */
  const onFaceClick = useCallback((e: React.MouseEvent) => {
    // Only on left-click, not during drag
    if (e.button !== 0) return;
    const container = containerRef.current;
    const camera = cameraRef.current;
    const mesh = meshRef.current;
    if (!container || !camera || !mesh) return;

    const rect = container.getBoundingClientRect();
    mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycasterRef.current.setFromCamera(mouseRef.current, camera);
    const hits = raycasterRef.current.intersectObject(mesh, false);
    if (hits.length > 0 && hits[0].faceIndex != null) {
      const fIdx = hits[0].faceIndex;
      setSelectedFaces((prev) => {
        if (e.shiftKey || e.ctrlKey) {
          return prev.includes(fIdx)
            ? prev.filter((idx) => idx !== fIdx)
            : [...prev, fIdx];
        }
        if (prev.length === 1 && prev[0] === fIdx) {
          return [];
        }
        return [fIdx];
      });
    }
  }, []);

  /* Dismiss context menu on click anywhere */
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = () => setCtxMenu(null);
    window.addEventListener("click", dismiss, { once: true });
    return () => window.removeEventListener("click", dismiss);
  }, [ctxMenu]);

  /* Face quality info for tooltip */
  const hoveredFaceInfo = useMemo(() => {
    if (!hoveredFace) return null;
    const idx = hoveredFace.idx;
    const { nodes, boundaryFaces } = meshData;
    const nFaces = boundaryFaces.length / 3;
    if (idx < 0 || idx >= nFaces) return null;

    // Get AR
    if (!faceARs.current) {
      faceARs.current = computeFaceAspectRatios(nodes, boundaryFaces);
    }
    const ar = faceARs.current[idx];
    const sicn = qualityPerFace?.[idx];
    return { faceIdx: idx, ar, sicn };
  }, [hoveredFace, meshData, qualityPerFace]);

  return (
      <div
        className={s.container}
        ref={containerRef}
        onPointerMove={onPointerMove}
        onContextMenu={onContextMenu}
        onClick={(e) => { dismissCtxMenu(); onFaceClick(e); }}
      >
      {/* ─── Toolbar ────────────────────────────────── */}
      {toolbarMode !== "hidden" && (
      <div className={s.toolbar}>
        {/* Render mode */}
        <div className={s.toolGroup}>
          <span className={s.toolLabel}>Render</span>
          {RENDER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={s.toolBtn}
              data-active={renderMode === opt.value}
              onClick={() => updateRenderMode(opt.value)}
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
              updateClipEnabled(!clipEnabled);
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
                    onClick={() => updateClipAxis(a)}
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
                  onChange={(e) => updateClipPos(Number(e.target.value))}
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
            onChange={(e) => updateOpacity(Number(e.target.value))}
            style={{ width: 60 }}
          />
          <span className={s.dropValue}>{opacity}%</span>
        </div>

        {/* Arrow plot */}
        <div className={s.toolGroup}>
          <button
            className={s.toolBtn}
            data-active={showArrows}
            onClick={() => updateShowArrows(!showArrows)}
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
      )}

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
        {selectedFaces.length > 0 && (
          <>
            <span className={s.infoSep} />
            <span style={{ color: "hsl(210 80% 70%)" }}>{selectedFaces.length} selected</span>
          </>
        )}
      </div>

      {/* ─── ViewCube ───────────────────────────────── */}
      <ViewCube sceneRef={viewCubeSceneRef} onRotate={handleViewCubeRotate} />

      {/* ─── HSL orientation legend ─────────────────── */}
      {showOrientationLegend && <HslSphere sceneRef={viewCubeSceneRef} />}

      {/* ─── Face hover tooltip ────────────────────── */}
      {hoveredFaceInfo && hoveredFace && (
        <div
          className={s.faceTooltip}
          style={{ left: hoveredFace.x + 14, top: hoveredFace.y - 8 }}
        >
          face #{hoveredFaceInfo.faceIdx}
          {" · AR "}{hoveredFaceInfo.ar.toFixed(2)}
          {hoveredFaceInfo.sicn != null && ` · SICN ${hoveredFaceInfo.sicn.toFixed(3)}`}
        </div>
      )}

      {/* ─── Right-click context menu ──────────────── */}
      {ctxMenu && (
        <div
          className={s.contextMenu}
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className={s.ctxItem}
            onClick={() => {
              setSelectedFaces([ctxMenu.faceIdx]);
              setCtxMenu(null);
            }}
          >
            <span className={s.ctxIcon}>🔍</span>
            Inspect face #{ctxMenu.faceIdx}
          </button>
          <button
            className={s.ctxItem}
            onClick={() => {
              setField("quality");
              setCtxMenu(null);
            }}
          >
            <span className={s.ctxIcon}>📊</span>
            Show quality (AR)
          </button>
          <button
            className={s.ctxItem}
            onClick={() => {
              setField("sicn");
              setCtxMenu(null);
            }}
          >
            <span className={s.ctxIcon}>📈</span>
            Show quality (SICN)
          </button>
          <div className={s.ctxSep} />
          <button
            className={s.ctxItem}
            onClick={() => {
              updateRenderMode("surface+edges");
              setCtxMenu(null);
            }}
          >
            <span className={s.ctxIcon}>◫</span>
            Surface + edges
          </button>
          <button
            className={s.ctxItem}
            onClick={() => {
              updateClipEnabled(!clipEnabled);
              setCtxMenu(null);
            }}
          >
            <span className={s.ctxIcon}>✂️</span>
            {clipEnabled ? "Disable clip" : "Enable clip plane"}
          </button>
          <div className={s.ctxSep} />
          <button className={s.ctxItem} onClick={takeScreenshot}>
            <span className={s.ctxIcon}>📷</span>
            Screenshot
          </button>
          {selectedFaces.length > 0 && (
            <>
              <div className={s.ctxSep} />
              <button
                className={s.ctxItem}
                onClick={() => {
                  setSelectedFaces([]);
                  setCtxMenu(null);
                }}
              >
                <span className={s.ctxIcon}>✕</span>
                Clear selection ({selectedFaces.length})
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
