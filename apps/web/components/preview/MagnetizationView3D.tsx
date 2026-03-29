"use client";

import { useDeferredValue, useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { TrackballControls } from "@react-three/drei";
import { cn } from "@/lib/utils";
import ViewCube from "./ViewCube";
import HslSphere from "./HslSphere";
import FdmInstances from "./r3f/FdmInstances";
import FdmLighting from "./r3f/FdmLighting";
import SceneAxes3D from "./r3f/SceneAxes3D";

// ─── Types ──────────────────────────────────────────────────────────
interface Props {
  grid: [number, number, number];
  vectors: Float64Array | null;
  fieldLabel?: string;
  geometryMode?: boolean;
  activeMask?: boolean[] | null;
  /** Physical extent [x, y, z] in metres — enables in-scene axis labels */
  worldExtent?: [number, number, number] | null;
}

export type QualityLevel = "low" | "high" | "ultra";
export type RenderMode = "glyph" | "voxel";
export type VoxelColorMode = "orientation" | "x" | "y" | "z";
export type VoxelSampling = 1 | 2 | 4;
export type TopoComponent = "x" | "y" | "z";

const DEFAULT_CAMERA_DIRECTION: [number, number, number] = [0, 1, 0];
const DEFAULT_CAMERA_UP: [number, number, number] = [0, 0, -1];

// ─── localStorage persistence ───────────────────────────────────────
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

// ─── R3F camera ↔ ViewCube bridge ───────────────────────────────────

function SyncedControls({
  controlsRefObject,
  viewCubeBridgeRef,
  grid,
}: {
  controlsRefObject: React.MutableRefObject<any>;
  viewCubeBridgeRef: React.MutableRefObject<any>;
  grid: [number, number, number];
}) {
  const { camera } = useThree();
  const [nx, ny, nz] = grid;
  const cx = nx / 2, cy = nz / 2, cz = ny / 2;

  useEffect(() => {
    viewCubeBridgeRef.current = { camera, controls: controlsRefObject.current };
  }, [camera, controlsRefObject, viewCubeBridgeRef]);

  return (
    <TrackballControls
      ref={controlsRefObject}
      rotateSpeed={1}
      zoomSpeed={1.2}
      panSpeed={0.8}
      target={[cx, cy, cz]}
      dynamicDampingFactor={1}
    />
  );
}

// ─── R3F scene background ───────────────────────────────────────────

const BG_COLOR = 0x0c121f;

function SceneConfig({ toneMapping }: { toneMapping: boolean }) {
  const { gl } = useThree();
  useEffect(() => {
    if (toneMapping) {
      gl.toneMapping = THREE.ACESFilmicToneMapping;
      gl.toneMappingExposure = 1.05;
    }
  }, [gl, toneMapping]);
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════
export default function MagnetizationView3D({
  grid,
  vectors,
  fieldLabel = "Vector Field",
  geometryMode = false,
  activeMask = null,
  worldExtent = null,
}: Props) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [expanded, setExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const deferredVectors = useDeferredValue(vectors);
  const deferredSettings = useDeferredValue(settings);

  const controlsRef = useRef<any>(null);
  const viewCubeSceneRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [nx, ny, nz] = grid;
  const cx = nx / 2, cy = nz / 2, cz = ny / 2;
  const orbitDist = Math.max(nx, ny, nz) * 1.5;

  // Persist settings changes
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
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

  // Snap camera to a direction
  const snapCamera = useCallback((dir: [number, number, number], up: [number, number, number] = [0, 1, 0]) => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera || !bridge?.controls) return;
    const { camera, controls } = bridge;
    const len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    const n = len > 0 ? [dir[0] / len, dir[1] / len, dir[2] / len] : [0, 0, 1];
    camera.position.set(
      cx + n[0] * orbitDist,
      cy + n[1] * orbitDist,
      cz + n[2] * orbitDist,
    );
    camera.up.set(up[0], up[1], up[2]);
    camera.lookAt(cx, cy, cz);
    controls.target.set(cx, cy, cz);
    controls.update();
  }, [cx, cy, cz, orbitDist]);

  const resetCamera = useCallback(
    () => snapCamera(DEFAULT_CAMERA_DIRECTION, DEFAULT_CAMERA_UP),
    [snapCamera],
  );

  const cameraPresets = useMemo(() => [
    { label: "Top",   fn: () => snapCamera([0, 1, 0], [0, 0, -1]) },
    { label: "Front", fn: () => snapCamera([0, 0, 1]) },
    { label: "Right", fn: () => snapCamera([1, 0, 0]) },
    { label: "Iso",   fn: () => snapCamera([1, 1, 1]) },
  ], [snapCamera]);

  // Capture viewport as PNG
  const captureSnapshot = useCallback(() => {
    const bridge = viewCubeSceneRef.current;
    const canvas = canvasRef.current;
    if (!bridge || !canvas) return;
    const link = document.createElement("a");
    link.download = `fullmag_3d_${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, []);

  // SceneAxes3D props — FDM coordinate mapping: scene-X=sim-X, scene-Y=sim-Z, scene-Z=sim-Y
  const axesWorldExtent = worldExtent
    ? [worldExtent[0], worldExtent[2], worldExtent[1]] as [number, number, number]
    : null;
  const axesSceneScale: [number, number, number] = axesWorldExtent
    ? [
        axesWorldExtent[0] > 0 ? nx / axesWorldExtent[0] : 1,
        axesWorldExtent[1] > 0 ? nz / axesWorldExtent[1] : 1,
        axesWorldExtent[2] > 0 ? ny / axesWorldExtent[2] : 1,
      ]
    : [1, 1, 1];

  return (
    <div className="relative flex flex-col h-full">
      {/* ── Settings toolbar overlay ──────────────────────── */}
      <div className="absolute left-3 top-3 z-10 flex flex-col">
        <button
          className="w-8 h-8 flex items-center justify-center rounded-md bg-card/40 border border-border/50 text-muted-foreground text-base cursor-pointer backdrop-blur-md transition-all hover:bg-muted/50 hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
          title="3D Controls"
        >
          ⚙
        </button>

        {expanded ? (
          <div className="mt-2 p-3 min-w-[200px] max-w-[220px] max-h-[360px] overflow-y-auto flex flex-col gap-3 rounded-lg bg-gradient-to-b from-card to-background border border-border/50 backdrop-blur-md shadow-lg scrollbar-thin scrollbar-thumb-muted-foreground/30">
            {!geometryMode ? (
              <ControlGroup label="Render mode">
                <SegmentedGroup
                  options={[["glyph", "ARROWS"], ["voxel", "VOXEL"]]}
                  value={settings.renderMode}
                  onChange={(v) => update({ renderMode: v as RenderMode })}
                  columns={2}
                />
              </ControlGroup>
            ) : null}

            <ControlGroup label="Brightness" value={settings.brightness.toFixed(1)}>
              <Slider
                min={0.3}
                max={3.0}
                step={0.1}
                value={settings.brightness}
                onChange={(v) => update({ brightness: v })}
              />
            </ControlGroup>

            <ControlGroup label="Quality">
              <SegmentedGroup
                options={[["low", "LOW"], ["high", "HIGH"], ["ultra", "ULTRA"]]}
                value={settings.quality}
                onChange={(v) => update({ quality: v as QualityLevel })}
                columns={3}
              />
            </ControlGroup>

            {settings.renderMode === "voxel" ? (
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
                  <Slider
                    min={0.15}
                    max={0.95}
                    step={0.01}
                    value={settings.voxelOpacity}
                    onChange={(v) => update({ voxelOpacity: v })}
                  />
                </ControlGroup>

                <ControlGroup label="Spacing" value={`${Math.round(settings.voxelGap * 100)}%`}>
                  <Slider
                    min={0.02}
                    max={0.42}
                    step={0.01}
                    value={settings.voxelGap}
                    onChange={(v) => update({ voxelGap: v })}
                  />
                </ControlGroup>

                <ControlGroup label="Min strength" value={settings.voxelThreshold.toFixed(2)}>
                  <Slider
                    min={0}
                    max={0.95}
                    step={0.01}
                    value={settings.voxelThreshold}
                    onChange={(v) => update({ voxelThreshold: v })}
                  />
                </ControlGroup>

                <ControlGroup label="Sampling">
                  <SegmentedGroup
                    options={[["1", "1X"], ["2", "2X"], ["4", "4X"]]}
                    value={String(settings.sampling)}
                    onChange={(v) => update({ sampling: parseInt(v, 10) as VoxelSampling })}
                    columns={3}
                  />
                </ControlGroup>
              </>
            ) : null}

            {!geometryMode ? (
              <>
                <div className="h-px bg-border/50 my-0.5" />

                <ControlGroup label="Topography">
                  <button
                    className={cn("w-full py-2 text-[0.65rem] font-bold tracking-wider text-muted-foreground bg-white/5 border border-border/50 rounded-md cursor-pointer transition-all hover:bg-primary/10 hover:border-primary/50 hover:text-foreground", settings.topoEnabled && "bg-gradient-to-br from-emerald-500/85 to-emerald-700/85 text-white border-emerald-500/50 hover:text-white")}
                    onClick={() => update({ topoEnabled: !settings.topoEnabled })}
                  >
                    {settings.topoEnabled ? "⛰ ON" : "OFF"}
                  </button>
                </ControlGroup>

                {settings.topoEnabled ? (
                  <>
                    <ControlGroup label="Displace by">
                      <SegmentedGroup
                        options={[["x", "mX"], ["y", "mY"], ["z", "mZ"]]}
                        value={settings.topoComponent}
                        onChange={(v) => update({ topoComponent: v as TopoComponent })}
                        columns={3}
                      />
                    </ControlGroup>

                    <ControlGroup
                      label="Amplitude"
                      value={`${settings.topoMultiplier.toFixed(1)}×`}
                    >
                      <Slider
                        min={0.5}
                        max={50}
                        step={0.5}
                        value={settings.topoMultiplier}
                        onChange={(v) => update({ topoMultiplier: v })}
                      />
                    </ControlGroup>
                  </>
                ) : null}
              </>
            ) : null}

            <ControlGroup label="Camera">
              <div className="grid grid-cols-4 rounded-md overflow-hidden border border-border/50 bg-white/5">
                {cameraPresets.map((p) => (
                  <button
                    key={p.label}
                    className="py-1.5 text-[0.65rem] font-bold tracking-wider text-muted-foreground bg-transparent border-none cursor-pointer transition-colors border-r border-border/50 last:border-r-0 hover:bg-primary/10 hover:text-foreground"
                    onClick={p.fn}
                  >
                    {p.label.toUpperCase()}
                  </button>
                ))}
              </div>
            </ControlGroup>

            <button className="w-full py-2 text-[0.65rem] font-bold tracking-wider text-muted-foreground bg-white/5 border border-border/50 rounded-md cursor-pointer transition-all hover:bg-primary/10 hover:border-primary/50 hover:text-foreground" onClick={resetCamera}>
              Reset Camera
            </button>

            <button className="w-full py-2 text-[0.65rem] font-bold tracking-wider text-emerald-400/80 bg-emerald-500/10 border border-emerald-500/30 rounded-md cursor-pointer transition-all hover:bg-emerald-500/20 hover:border-emerald-500/50 hover:text-emerald-300" onClick={captureSnapshot}>
              📷 Snapshot
            </button>
          </div>
        ) : null}
      </div>

      {/* ── R3F Canvas ────────────────────────────────────── */}
      <Canvas
        className="w-full flex-1 min-h-0"
        camera={{
          fov: 50,
          near: 0.1,
          far: 1000,
          position: [
            cx + DEFAULT_CAMERA_DIRECTION[0] * orbitDist,
            cy + DEFAULT_CAMERA_DIRECTION[1] * orbitDist,
            cz + DEFAULT_CAMERA_DIRECTION[2] * orbitDist,
          ],
          up: DEFAULT_CAMERA_UP,
        }}
        gl={{
          antialias: settings.quality !== "low",
          preserveDrawingBuffer: true,
        }}
        onCreated={({ gl }) => { canvasRef.current = gl.domElement; }}
        dpr={settings.quality === "ultra"
          ? Math.min(typeof window !== "undefined" ? window.devicePixelRatio : 1, 2)
          : 1
        }
        style={{ background: `#${BG_COLOR.toString(16).padStart(6, "0")}` }}
      >
        <color attach="background" args={[BG_COLOR]} />
        <SceneConfig toneMapping={settings.quality !== "low"} />

        <FdmLighting brightness={settings.brightness} quality={settings.quality} />

        <FdmInstances
          grid={grid}
          vectors={deferredVectors}
          geometryMode={geometryMode}
          activeMask={activeMask}
          settings={deferredSettings}
          onVisibleCount={setVisibleCount}
        />

        {axesWorldExtent && axesWorldExtent[0] > 0 && axesWorldExtent[1] > 0 && axesWorldExtent[2] > 0 && (
          <SceneAxes3D
            worldExtent={axesWorldExtent}
            center={[cx, cy, cz]}
            sceneScale={axesSceneScale}
            axisLabels={["x", "z", "y"]}
          />
        )}

        <SyncedControls
          controlsRefObject={controlsRef}
          viewCubeBridgeRef={viewCubeSceneRef}
          grid={grid}
        />
      </Canvas>

      <ViewCube
        sceneRef={viewCubeSceneRef}
        grid={grid}
        defaultDirection={DEFAULT_CAMERA_DIRECTION}
        defaultUp={DEFAULT_CAMERA_UP}
      />
      {!geometryMode ? <HslSphere sceneRef={viewCubeSceneRef} /> : null}
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
    <div className="flex flex-col gap-[3px]">
      <div className="flex justify-between items-center text-[0.65rem] uppercase tracking-widest text-muted-foreground">
        {label}
        {value && <span className="font-semibold font-mono text-foreground">{value}</span>}
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
    <div className={cn("grid rounded-md overflow-hidden border border-border/50 bg-white/5", columns === 2 ? "grid-cols-2" : columns === 3 ? "grid-cols-3" : "grid-cols-4")}>
      {options.map(([k, label]) => (
        <button
          key={k}
          className={cn("py-1.5 text-[0.65rem] font-bold tracking-wider text-muted-foreground bg-transparent border-none cursor-pointer transition-colors border-r border-border/50 last:border-r-0 hover:bg-primary/10 hover:text-foreground", value === k && "bg-gradient-to-br from-primary to-blue-600 text-white")}
          onClick={() => onChange(k)}
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
      className="w-full h-1 appearance-none bg-gradient-to-r from-teal-500/20 to-blue-500/20 rounded-full outline-none cursor-pointer border-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer"
      min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
    />
  );
}
