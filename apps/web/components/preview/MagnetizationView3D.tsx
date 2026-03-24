// @ts-nocheck
"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

// ─── Types (mirroring amumax preview3D.ts) ──────────────────────────
interface Props {
  grid: [number, number, number];
  magnetization: Float64Array | null;
}

export type QualityLevel = "low" | "high" | "ultra";
export type RenderMode = "glyph" | "voxel";
export type VoxelColorMode = "orientation" | "x" | "y" | "z";
export type VoxelSampling = 1 | 2 | 4;
export type TopoComponent = "x" | "y" | "z";

interface QualityConfig {
  segments: number;
  useLighting: boolean;
  useHemisphere: boolean;
  antialias: boolean;
  pixelRatio: number;
}

const QUALITY_CONFIGS: Record<QualityLevel, QualityConfig> = {
  low: { segments: 6, useLighting: false, useHemisphere: false, antialias: false, pixelRatio: 1 },
  high: { segments: 12, useLighting: true, useHemisphere: true, antialias: true, pixelRatio: 1 },
  ultra: {
    segments: 16, useLighting: true, useHemisphere: true, antialias: true,
    pixelRatio: typeof window !== "undefined" ? Math.min(window.devicePixelRatio, 2) : 1,
  },
};

// ─── Constants (from amumax) ────────────────────────────────────────
const COMP_NEGATIVE = new THREE.Color("#2f6caa");
const COMP_NEUTRAL = new THREE.Color("#f4f1ed");
const COMP_POSITIVE = new THREE.Color("#cf6256");
const BG_COLOR = 0x0c121f;

const _dummy = new THREE.Object3D();
const _defaultUp = new THREE.Vector3(0, 1, 0);
const _tempVec = new THREE.Vector3();
const _color = new THREE.Color();

// ─── Coloring (1:1 from amumax) ────────────────────────────────────
function magnetizationHSL(vx: number, vy: number, vz: number, color: THREE.Color) {
  const hue = Math.atan2(vy, vx) / (Math.PI * 2);
  const saturation = Math.min(1, Math.sqrt(vx * vx + vy * vy));
  const lightness = THREE.MathUtils.clamp((vz + 1) / 2, 0.18, 0.84);
  color.setHSL((hue + 1) % 1, saturation, lightness);
}

function applyComponentColor(value: number, color: THREE.Color) {
  const normalized = THREE.MathUtils.clamp(value, -1, 1);
  if (normalized < 0) {
    color.copy(COMP_NEUTRAL).lerp(COMP_NEGATIVE, Math.abs(normalized));
  } else {
    color.copy(COMP_NEUTRAL).lerp(COMP_POSITIVE, normalized);
  }
}

function componentValue(mx: number, my: number, mz: number, mode: "x" | "y" | "z"): number {
  switch (mode) {
    case "x": return mx;
    case "y": return my;
    case "z": return mz;
  }
}

function applyVoxelColor(mx: number, my: number, mz: number, mode: VoxelColorMode, color: THREE.Color) {
  if (mode === "orientation") {
    magnetizationHSL(mx, my, mz, color);
  } else {
    applyComponentColor(componentValue(mx, my, mz, mode), color);
  }
}

// ─── Topography (1:1 from amumax voxelTopography.ts) ────────────────
const TOPO_EPSILON = 1e-6;

function resolveVoxelTopography(baseZ: number, baseDepth: number, signedDisplacement: number) {
  if (!Number.isFinite(signedDisplacement) || Math.abs(signedDisplacement) < TOPO_EPSILON) {
    return { centerZ: baseZ, depthScale: baseDepth };
  }
  return {
    centerZ: baseZ + signedDisplacement / 2,
    depthScale: baseDepth + Math.abs(signedDisplacement),
  };
}

// ─── Geometry (1:1 from amumax) ─────────────────────────────────────
function createArrowGeometry(segments: number): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.05, 0.05, 0.55, segments);
  shaft.translate(0, -0.06, 0);
  const head = new THREE.ConeGeometry(0.2, 0.4, segments);
  head.translate(0, 0.4, 0);
  const merged = mergeGeometries([shaft, head]);
  if (!merged) throw new Error("failed to merge arrow geometry");
  merged.computeVertexNormals();
  return merged;
}

function createVoxelGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1);
}

// ─── Material (1:1 from amumax) ─────────────────────────────────────
function createMaterial(mode: RenderMode, cfg: QualityConfig, opacity: number): THREE.Material {
  if (mode === "voxel") {
    return cfg.useLighting
      ? new THREE.MeshPhongMaterial({
          transparent: true, opacity, depthWrite: false,
          shininess: 24, specular: new THREE.Color(0x24334c),
        })
      : new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false });
  }
  return cfg.useLighting
    ? new THREE.MeshPhongMaterial({ shininess: 60, specular: new THREE.Color(0x444444) })
    : new THREE.MeshBasicMaterial();
}

// ─── localStorage persistence (1:1 from amumax) ────────────────────
const STORAGE_KEYS = {
  brightness: "preview3d_brightness",
  quality: "preview3d_quality",
  renderMode: "preview3d_render_mode",
  voxelOpacity: "preview3d_voxel_opacity",
  voxelGap: "preview3d_voxel_gap",
  voxelThreshold: "preview3d_voxel_threshold",
  voxelColorMode: "preview3d_voxel_color_mode",
  voxelSampling: "preview3d_voxel_sampling",
  topoEnabled: "preview3d_topo_enabled",
  topoComponent: "preview3d_topo_component",
  topoMultiplier: "preview3d_topo_multiplier",
} as const;

function loadClamped(key: string, fb: number, min: number, max: number): number {
  if (typeof window === "undefined") return fb;
  const raw = parseFloat(localStorage.getItem(key) || "");
  if (!Number.isFinite(raw)) return fb;
  return Math.max(min, Math.min(max, raw));
}

function loadEnum<T extends string>(key: string, allowed: T[], fb: T): T {
  if (typeof window === "undefined") return fb;
  const v = localStorage.getItem(key) as T;
  return allowed.includes(v) ? v : fb;
}

function persist(key: string, value: string | number) {
  if (typeof window !== "undefined") localStorage.setItem(key, String(value));
}

function loadSettings(): Settings {
  return {
    quality: loadEnum(STORAGE_KEYS.quality, ["low", "high", "ultra"], "high"),
    renderMode: loadEnum(STORAGE_KEYS.renderMode, ["glyph", "voxel"], "glyph"),
    voxelColorMode: loadEnum(STORAGE_KEYS.voxelColorMode, ["orientation", "x", "y", "z"], "orientation"),
    sampling: loadEnum(STORAGE_KEYS.voxelSampling, ["1", "2", "4"], "1") as unknown as VoxelSampling,
    brightness: loadClamped(STORAGE_KEYS.brightness, 1.5, 0.3, 3.0),
    voxelOpacity: loadClamped(STORAGE_KEYS.voxelOpacity, 0.5, 0.15, 0.95),
    voxelGap: loadClamped(STORAGE_KEYS.voxelGap, 0.14, 0.02, 0.42),
    voxelThreshold: loadClamped(STORAGE_KEYS.voxelThreshold, 0.08, 0, 0.95),
    topoEnabled: typeof window !== "undefined" && localStorage.getItem(STORAGE_KEYS.topoEnabled) === "true",
    topoComponent: loadEnum(STORAGE_KEYS.topoComponent, ["x", "y", "z"], "z"),
    topoMultiplier: loadClamped(STORAGE_KEYS.topoMultiplier, 5, 0.5, 50),
  };
}

interface Settings {
  quality: QualityLevel;
  renderMode: RenderMode;
  voxelColorMode: VoxelColorMode;
  sampling: VoxelSampling;
  brightness: number;
  voxelOpacity: number;
  voxelGap: number;
  voxelThreshold: number;
  topoEnabled: boolean;
  topoComponent: TopoComponent;
  topoMultiplier: number;
}

// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function MagnetizationView3D({ grid, magnetization }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);

  const sceneRef = useRef<{
    mesh: THREE.InstancedMesh;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: TrackballControls;
    frameId: number;
    currentMode: RenderMode;
  } | null>(null);

  // Persist settings changes
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // persist each changed key
      if (patch.quality !== undefined) persist(STORAGE_KEYS.quality, next.quality);
      if (patch.renderMode !== undefined) persist(STORAGE_KEYS.renderMode, next.renderMode);
      if (patch.voxelColorMode !== undefined) persist(STORAGE_KEYS.voxelColorMode, next.voxelColorMode);
      if (patch.sampling !== undefined) persist(STORAGE_KEYS.voxelSampling, next.sampling);
      if (patch.brightness !== undefined) persist(STORAGE_KEYS.brightness, next.brightness);
      if (patch.voxelOpacity !== undefined) persist(STORAGE_KEYS.voxelOpacity, next.voxelOpacity);
      if (patch.voxelGap !== undefined) persist(STORAGE_KEYS.voxelGap, next.voxelGap);
      if (patch.voxelThreshold !== undefined) persist(STORAGE_KEYS.voxelThreshold, next.voxelThreshold);
      if (patch.topoEnabled !== undefined) persist(STORAGE_KEYS.topoEnabled, String(next.topoEnabled));
      if (patch.topoComponent !== undefined) persist(STORAGE_KEYS.topoComponent, next.topoComponent);
      if (patch.topoMultiplier !== undefined) persist(STORAGE_KEYS.topoMultiplier, next.topoMultiplier);
      return next;
    });
  };

  // ─── Scene setup (1:1 from amumax init()) ─────────────────────────
  const initScene = useCallback(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight || 500;
    const cfg = QUALITY_CONFIGS[settings.quality];
    const mode = settings.renderMode;

    // Renderer (amumax createRenderer)
    const renderer = new THREE.WebGLRenderer({ antialias: cfg.antialias, alpha: false });
    renderer.setPixelRatio(cfg.pixelRatio);
    renderer.setClearColor(BG_COLOR, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // Scene (amumax createScene)
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);

    if (cfg.useLighting) {
      const b = settings.brightness;
      const dir = new THREE.DirectionalLight(0xffffff, 1.8 * b);
      dir.position.set(1, 2, 3);
      dir.userData.baseIntensity = 1.8;
      scene.add(dir);
      const fill = new THREE.DirectionalLight(0xccccff, 0.8 * b);
      fill.position.set(-2, 0, 1);
      fill.userData.baseIntensity = 0.8;
      scene.add(fill);
      const back = new THREE.DirectionalLight(0xffffff, 0.5 * b);
      back.position.set(0, -1, -2);
      back.userData.baseIntensity = 0.5;
      scene.add(back);
      const ambient = new THREE.AmbientLight(0x8888aa, 1.0 * b);
      ambient.userData.baseIntensity = 1.0;
      scene.add(ambient);
      if (cfg.useHemisphere) {
        const hemi = new THREE.HemisphereLight(0x8898bf, 0x293245, 0.6 * b);
        hemi.userData.baseIntensity = 0.6;
        scene.add(hemi);
      }
    }

    // Camera (amumax createCamera + getWorldExtents)
    const [nx, ny, nz] = grid;
    const centerX = nx / 2;
    const centerY = nz / 2;
    const centerZ = ny / 2;
    const orbitDistance = Math.max(nx, ny, nz) * 1.5;
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(centerX, centerY, centerZ + orbitDistance);

    // Controls (amumax createControls)
    const controls = new TrackballControls(camera, renderer.domElement);
    controls.dynamicDampingFactor = 1;
    controls.panSpeed = 0.8;
    controls.rotateSpeed = 1;
    controls.target.set(centerX, centerY, centerZ);
    controls.update();

    // Mesh (amumax createMesh)
    const count = nx * ny * nz;
    const geometry = mode === "voxel" ? createVoxelGeometry() : createArrowGeometry(cfg.segments);
    const material = createMaterial(mode, cfg, settings.voxelOpacity);
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.frustumCulled = false;
    mesh.renderOrder = mode === "voxel" ? 2 : 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(Math.max(count, 1) * 3), 3,
    );
    scene.add(mesh);

    // Animation (amumax animate)
    const animate = () => {
      const id = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
      if (sceneRef.current) sceneRef.current.frameId = id;
    };
    const frameId = requestAnimationFrame(animate);

    // Resize observer
    const observer = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight || 500;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    observer.observe(container);

    sceneRef.current = { mesh, scene, camera, renderer, controls, frameId, currentMode: mode };

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
      controls.dispose();
      renderer.dispose();
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else if (child.material) {
            child.material.dispose();
          }
        }
      });
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, [grid, settings.quality, settings.renderMode, settings.brightness, settings.voxelOpacity]);

  useEffect(() => {
    const cleanup = initScene();
    return cleanup;
  }, [initScene]);

  // ─── Update mesh (1:1 from amumax updateGlyphMesh + updateVoxelMesh) ──
  useEffect(() => {
    if (!sceneRef.current || !magnetization) return;
    const { mesh, currentMode } = sceneRef.current;
    const [nx, ny, nz] = grid;
    const { sampling, voxelColorMode, voxelGap, voxelThreshold, topoEnabled, topoComponent, topoMultiplier } = settings;
    const isVoxel = currentMode === "voxel";

    const step = sampling;
    const baseScale = isVoxel ? Math.max(0.12, step * (1 - voxelGap)) : 1;
    const depthScale = nz > 1 ? baseScale : Math.max(0.22, baseScale * 0.42);
    const instanceColor = mesh.instanceColor;
    if (!instanceColor) return;
    const colors = instanceColor.array as Float32Array;

    let visible = 0;
    let idx = 0;

    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          const base = idx * 3;
          const mx = magnetization[base];
          const my = magnetization[base + 1];
          const mz = magnetization[base + 2];

          // Sampling check (amumax isSampledPosition)
          const sampled =
            step === 1 ||
            (ix % step === 0 && iy % step === 0 && (nz <= 1 || iz % step === 0));

          const mag = Math.sqrt(mx * mx + my * my + mz * mz);

          if (isVoxel) {
            // ─── Voxel mode (amumax updateVoxelMesh) ────────
            const metric = voxelColorMode === "orientation"
              ? mag
              : Math.abs(componentValue(mx, my, mz, voxelColorMode as "x" | "y" | "z"));
            const isVisible = sampled && metric >= voxelThreshold;

            // Position: sim-Y → world-Z, sim-Z → world-Y (amumax convention)
            let worldY = iz;
            let vH = depthScale;

            if (topoEnabled && isVisible) {
              const compVal = componentValue(mx, my, mz, topoComponent);
              const displacement = compVal * topoMultiplier;
              const topo = resolveVoxelTopography(iz, depthScale, displacement);
              worldY = topo.centerZ;
              vH = topo.depthScale;
            }

            _dummy.position.set(ix, worldY, iy);
            _dummy.quaternion.identity();

            if (!isVisible) {
              _dummy.scale.set(0, 0, 0);
            } else {
              visible++;
              _dummy.scale.set(baseScale, vH, baseScale);
            }

            applyVoxelColor(mx, my, mz, voxelColorMode, _color);
          } else {
            // ─── Glyph mode (amumax updateGlyphMesh) ────────
            const isVisible = (mx !== 0 || my !== 0 || mz !== 0) && sampled;

            // Position: sim-Y → world-Z, sim-Z → world-Y
            _dummy.position.set(ix, iz, iy);

            if (!isVisible) {
              _dummy.scale.set(0, 0, 0);
              _dummy.quaternion.identity();
            } else {
              visible++;
              _dummy.scale.set(1, 1, 1);
              // Direction: sim-Y → world-Z, sim-Z → world-Y (amumax setWorldDirectionFromSimulation)
              _tempVec.set(mx, mz, my).normalize();
              _dummy.quaternion.setFromUnitVectors(_defaultUp, _tempVec);
            }

            magnetizationHSL(mx, my, mz, _color);
          }

          colors[idx * 3 + 0] = _color.r;
          colors[idx * 3 + 1] = _color.g;
          colors[idx * 3 + 2] = _color.b;

          _dummy.updateMatrix();
          mesh.setMatrixAt(idx, _dummy.matrix);
          idx++;
        }
      }
    }

    setVisibleCount(visible);
    mesh.instanceMatrix.needsUpdate = true;
    instanceColor.needsUpdate = true;

    // Update voxel material opacity
    if (isVoxel && !Array.isArray(mesh.material)) {
      (mesh.material as THREE.MeshPhongMaterial | THREE.MeshBasicMaterial).opacity = settings.voxelOpacity;
      mesh.material.needsUpdate = true;
    }
  }, [magnetization, grid, settings]);

  // ─── Reset camera (amumax resetCamera) ────────────────────────────
  const resetCamera = () => {
    if (!sceneRef.current) return;
    const [nx, ny, nz] = grid;
    const cx = nx / 2, cy = nz / 2, cz = ny / 2;
    const dist = Math.max(nx, ny, nz) * 1.5;
    const { camera, controls } = sceneRef.current;
    camera.position.set(cx, cy, cz + dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(cx, cy, cz);
    controls.target.set(cx, cy, cz);
    controls.update();
  };

  return (
    <div style={{ position: "relative" }}>
      {/* ─── Floating Toolbar (1:1 from amumax Toolbar3D.svelte) ──── */}
      <div style={{
        position: "absolute", left: 8, top: 8, zIndex: 10,
        display: "flex", flexDirection: "column",
      }}>
        <button
          onClick={() => setExpanded(!expanded)}
          title="3D Controls"
          style={{
            width: 32, height: 32, display: "flex", alignItems: "center",
            justifyContent: "center", borderRadius: 8,
            background: "rgba(12,18,31,0.7)", border: "1px solid rgba(255,255,255,0.1)",
            color: "#8899bb", fontSize: 16, cursor: "pointer",
            backdropFilter: "blur(8px)",
          }}
        >
          ⚙
        </button>

        {expanded && (
          <div style={{
            marginTop: 4,
            background: "linear-gradient(180deg, rgba(12,18,31,0.92), rgba(8,12,22,0.92))",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12, padding: 10,
            minWidth: 200, maxWidth: 220, maxHeight: 360,
            overflowY: "auto", display: "flex", flexDirection: "column", gap: 10,
            backdropFilter: "blur(14px)",
            boxShadow: "0 20px 50px rgba(0,0,0,0.28)",
            scrollbarWidth: "thin" as const,
            scrollbarColor: "rgba(107,167,255,0.3) transparent",
          }}>
            {/* Render mode */}
            <ControlGroup label="Render mode">
              <SegmentedGroup
                options={[["glyph", "ARROWS"], ["voxel", "VOXEL"]]}
                value={settings.renderMode}
                onChange={(v) => update({ renderMode: v as RenderMode })}
                columns={2}
              />
            </ControlGroup>

            {/* Brightness */}
            <ControlGroup label="Brightness" value={settings.brightness.toFixed(1)}>
              <Slider min={0.3} max={3.0} step={0.1} value={settings.brightness}
                onChange={(v) => update({ brightness: v })} />
            </ControlGroup>

            {/* Quality */}
            <ControlGroup label="Quality">
              <SegmentedGroup
                options={[["low", "LOW"], ["high", "HIGH"], ["ultra", "ULTRA"]]}
                value={settings.quality}
                onChange={(v) => update({ quality: v as QualityLevel })}
                columns={3}
              />
            </ControlGroup>

            {/* Voxel-only controls */}
            {settings.renderMode === "voxel" && (
              <>
                <ControlGroup label="Color by">
                  <SegmentedGroup
                    options={[["orientation", "ORI"], ["x", "X"], ["y", "Y"], ["z", "Z"]]}
                    value={settings.voxelColorMode}
                    onChange={(v) => update({ voxelColorMode: v as VoxelColorMode })}
                    columns={4}
                  />
                </ControlGroup>

                <ControlGroup label="Opacity" value={settings.voxelOpacity.toFixed(2)}>
                  <Slider min={0.15} max={0.95} step={0.01} value={settings.voxelOpacity}
                    onChange={(v) => update({ voxelOpacity: v })} />
                </ControlGroup>

                <ControlGroup label="Spacing" value={`${Math.round(settings.voxelGap * 100)}%`}>
                  <Slider min={0.02} max={0.42} step={0.01} value={settings.voxelGap}
                    onChange={(v) => update({ voxelGap: v })} />
                </ControlGroup>

                <ControlGroup label="Min strength" value={settings.voxelThreshold.toFixed(2)}>
                  <Slider min={0} max={0.95} step={0.01} value={settings.voxelThreshold}
                    onChange={(v) => update({ voxelThreshold: v })} />
                </ControlGroup>

                <ControlGroup label="Sampling">
                  <SegmentedGroup
                    options={[["1", "1X"], ["2", "2X"], ["4", "4X"]]}
                    value={String(settings.sampling)}
                    onChange={(v) => update({ sampling: parseInt(v) as VoxelSampling })}
                    columns={3}
                  />
                </ControlGroup>
              </>
            )}

            {/* Divider */}
            <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 0" }} />

            {/* Topography */}
            <ControlGroup label="Topography">
              <button
                onClick={() => update({ topoEnabled: !settings.topoEnabled })}
                style={{
                  padding: "0.48rem 0", fontSize: 11, fontWeight: 700,
                  letterSpacing: "0.04em", cursor: "pointer", width: "100%",
                  borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)",
                  ...(settings.topoEnabled
                    ? {
                        background: "linear-gradient(135deg, rgba(52,211,153,0.85), rgba(16,185,129,0.85))",
                        color: "#08101d",
                        borderColor: "rgba(52,211,153,0.5)",
                      }
                    : {
                        background: "rgba(255,255,255,0.035)",
                        color: "#8899bb",
                      }),
                }}
              >
                {settings.topoEnabled ? "⛰ ON" : "OFF"}
              </button>
            </ControlGroup>

            {settings.topoEnabled && (
              <>
                <ControlGroup label="Displace by">
                  <SegmentedGroup
                    options={[["x", "mX"], ["y", "mY"], ["z", "mZ"]]}
                    value={settings.topoComponent}
                    onChange={(v) => update({ topoComponent: v as TopoComponent })}
                    columns={3}
                  />
                </ControlGroup>

                <ControlGroup label="Amplitude" value={`${settings.topoMultiplier.toFixed(1)}×`}>
                  <Slider min={0.5} max={50} step={0.5} value={settings.topoMultiplier}
                    onChange={(v) => update({ topoMultiplier: v })} />
                </ControlGroup>
              </>
            )}

            {/* Reset camera */}
            <button
              onClick={resetCamera}
              style={{
                padding: "0.48rem 0", fontSize: 11, fontWeight: 700,
                letterSpacing: "0.04em", color: "#8899bb",
                background: "rgba(255,255,255,0.035)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8, cursor: "pointer", width: "100%",
              }}
            >
              Reset Camera
            </button>
          </div>
        )}
      </div>

      {/* ─── Visible count badge ──── */}
      {visibleCount > 0 && (
        <div style={{
          position: "absolute", right: 8, top: 8, zIndex: 10,
          fontSize: 10, color: "#667799", fontFamily: "monospace",
          background: "rgba(12,18,31,0.7)", padding: "4px 8px",
          borderRadius: 6, backdropFilter: "blur(8px)",
        }}>
          {visibleCount.toLocaleString()} cells
        </div>
      )}

      {/* ─── Canvas ──── */}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "500px",
          background: `#${BG_COLOR.toString(16).padStart(6, "0")}`,
        }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Toolbar sub-components (matching amumax Toolbar3D.svelte CSS)
// ═══════════════════════════════════════════════════════════════════
function ControlGroup({ label, value, children }: {
  label: string; value?: string; children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{
        fontSize: 11, color: "#8899bb", display: "flex",
        justifyContent: "space-between", alignItems: "center",
        textTransform: "uppercase" as const, letterSpacing: "0.05em",
      }}>
        {label}
        {value && <span style={{ color: "#ccd6e6", fontWeight: 600, fontFamily: "monospace" }}>{value}</span>}
      </div>
      {children}
    </div>
  );
}

function SegmentedGroup({ options, value, onChange, columns }: {
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
  columns: number;
}) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
      borderRadius: 8, overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(255,255,255,0.03)",
    }}>
      {options.map(([k, label], i) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          style={{
            padding: "0.42rem 0", fontSize: 11, fontWeight: 700,
            letterSpacing: "0.04em", border: "none", cursor: "pointer",
            borderRight: i < options.length - 1 ? "1px solid rgba(255,255,255,0.08)" : "none",
            ...(value === k
              ? {
                  background: "linear-gradient(135deg, rgba(87,200,182,0.92), rgba(56,178,162,0.92))",
                  color: "#08101d",
                }
              : {
                  background: "transparent",
                  color: "#667799",
                }),
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Slider({ min, max, step, value, onChange }: {
  min: number; max: number; step: number; value: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="range"
      min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      style={{
        width: "100%", height: 4, appearance: "none" as const,
        background: "linear-gradient(90deg, rgba(87,200,182,0.2), rgba(107,167,255,0.24))",
        borderRadius: 999, outline: "none", cursor: "pointer", border: "none",
      }}
    />
  );
}
