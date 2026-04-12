"use client";

import { useDeferredValue, useEffect, useRef, useState, useCallback, useMemo, memo, type Dispatch, type SetStateAction } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { TrackballControls, PivotControls } from "@react-three/drei";
import { cn } from "@/lib/utils";
import ViewCube from "./ViewCube";
import HslSphere from "./HslSphere";
import FdmInstances from "./r3f/FdmInstances";
import { rotateCameraAroundTarget, focusCameraOnBounds } from "./camera/cameraHelpers";
import FdmLighting from "./r3f/FdmLighting";
import SceneAxes3D from "./r3f/SceneAxes3D";
import { useCanvasHost } from "./shared/useCanvasHost";
import TextureTransformGizmo, {
  type TextureGizmoMode,
  type TexturePreviewProxy,
} from "./TextureTransformGizmo";
import type { TextureTransform3D } from "@/lib/textureTransform";
import type { VisualizationPresetFdmState } from "@/lib/session/types";
import type {
  AntennaOverlay,
  BuilderObjectOverlay,
  FocusObjectRequest,
  ObjectViewMode,
} from "../runs/control-room/shared";
import {
  Box,
  Palette,
  Eye,
  ArrowUpRight,
  Video,
  Camera,
  Mountain,
  Move,
  RotateCw,
  Maximize2,
  MousePointer2,
} from "lucide-react";
import { ViewportToolbar3D } from "./ViewportToolbar3D";
import { ViewportToolGroup, ViewportToolSeparator } from "./ViewportToolGroup";
import { ViewportIconAction } from "./ViewportIconAction";
import { ViewportPopoverPanel, ViewportPopoverRow, ViewportPopoverTrigger } from "./ViewportPopoverPanel";
import { ViewportOverlayLayout } from "./ViewportOverlayLayout";
import { ViewportStatusChip } from "./ViewportStatusChips";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

// ─── Types ──────────────────────────────────────────────────────────
interface Props {
  grid: [number, number, number];
  vectors: Float64Array | null;
  fieldLabel?: string;
  geometryMode?: boolean;
  activeMask?: boolean[] | null;
  /** Physical extent [x, y, z] in metres — enables in-scene axis labels */
  worldExtent?: [number, number, number] | null;
  objectOverlays?: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  antennaOverlays?: AntennaOverlay[];
  selectedAntennaId?: string | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  universeCenter?: [number, number, number] | null;
  focusObjectRequest?: FocusObjectRequest | null;
  objectViewMode?: ObjectViewMode;
  onRequestObjectSelect?: (id: string) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
  /** Active texture transform for the selected object (physical coords, metres) */
  activeTextureTransform?: TextureTransform3D | null;
  textureGizmoMode?: TextureGizmoMode;
  activeTexturePreviewProxy?: TexturePreviewProxy;
  onTextureTransformChange?: (next: TextureTransform3D) => void;
  onTextureTransformCommit?: (next: TextureTransform3D) => void;
  activeTransformScope?: "object" | "texture" | null;
  onTransformScopeChange?: (scope: "object" | "texture" | null) => void;
  settings?: VisualizationPresetFdmState;
  onSettingsChange?: Dispatch<SetStateAction<VisualizationPresetFdmState>>;
  viewportVisible?: boolean;
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

function settingsFromPreset(state: VisualizationPresetFdmState): Settings {
  return {
    quality: state.quality,
    renderMode: state.render_mode,
    voxelColorMode: state.voxel_color_mode,
    sampling: state.sampling,
    brightness: state.brightness,
    voxelOpacity: state.voxel_opacity,
    voxelGap: state.voxel_gap,
    voxelThreshold: state.voxel_threshold,
    topoEnabled: state.topo_enabled,
    topoComponent: state.topo_component,
    topoMultiplier: state.topo_multiplier,
  };
}

function settingsToPreset(state: Settings): VisualizationPresetFdmState {
  return {
    quality: state.quality,
    render_mode: state.renderMode,
    voxel_color_mode: state.voxelColorMode,
    sampling: state.sampling,
    brightness: state.brightness,
    voxel_opacity: state.voxelOpacity,
    voxel_gap: state.voxelGap,
    voxel_threshold: state.voxelThreshold,
    topo_enabled: state.topoEnabled,
    topo_component: state.topoComponent,
    topo_multiplier: state.topoMultiplier,
  };
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
  cameraEnabled = true,
}: {
  controlsRefObject: React.MutableRefObject<any>;
  viewCubeBridgeRef: React.MutableRefObject<any>;
  grid: [number, number, number];
  cameraEnabled?: boolean;
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
      enabled={cameraEnabled}
    />
  );
}

// ─── R3F scene background ───────────────────────────────────────────

const BG_COLOR = 0x1e1e2e; // Catppuccin Mocha Base

function SceneConfig({ toneMapping }: { toneMapping: boolean }) {
  const { gl } = useThree();
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  useEffect(() => {
    rendererRef.current = gl;
  }, [gl]);
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    if (toneMapping) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      return;
    }
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
  }, [toneMapping]);
  return null;
}

function antennaOverlayColors(role: AntennaOverlay["conductors"][number]["role"], selected: boolean) {
  if (role === "ground") {
    return selected
      ? { fill: "#67e8f9", wire: "#a5f3fc" }
      : { fill: "#0ea5e9", wire: "#67e8f9" };
  }
  return selected
    ? { fill: "#fb923c", wire: "#fdba74" }
    : { fill: "#f97316", wire: "#fb923c" };
}

function objectOverlayColors(selected: boolean, dimmed: boolean) {
  if (selected) {
    return { fill: "#facc15", wire: "#fff7ae", fillOpacity: 0.24, wireOpacity: 1 };
  }
  if (dimmed) {
    return { fill: "#64748b", wire: "#94a3b8", fillOpacity: 0.04, wireOpacity: 0.3 };
  }
  return { fill: "#60a5fa", wire: "#bfdbfe", fillOpacity: 0.08, wireOpacity: 0.56 };
}

function expandOverlayBounds(
  overlay: BuilderObjectOverlay,
  selected: boolean,
): BuilderObjectOverlay {
  if (!selected) {
    return overlay;
  }
  const extent = [
    overlay.boundsMax[0] - overlay.boundsMin[0],
    overlay.boundsMax[1] - overlay.boundsMin[1],
    overlay.boundsMax[2] - overlay.boundsMin[2],
  ] as const;
  const pad = Math.max(Math.max(...extent) * 0.05, 1e-12);
  return {
    ...overlay,
    boundsMin: [
      overlay.boundsMin[0] - pad,
      overlay.boundsMin[1] - pad,
      overlay.boundsMin[2] - pad,
    ],
    boundsMax: [
      overlay.boundsMax[0] + pad,
      overlay.boundsMax[1] + pad,
      overlay.boundsMax[2] + pad,
    ],
  };
}

function mapOverlayToFdmSceneBox(
  overlay: BuilderObjectOverlay,
  grid: [number, number, number],
  worldExtent: [number, number, number],
  universeCenter?: [number, number, number] | null,
): { sceneMin: [number, number, number]; sceneMax: [number, number, number] } | null {
  const [nx, ny, nz] = grid;
  const domainCenter = universeCenter ?? [0, 0, 0];
  const domainMin = [
    domainCenter[0] - worldExtent[0] * 0.5,
    domainCenter[1] - worldExtent[1] * 0.5,
    domainCenter[2] - worldExtent[2] * 0.5,
  ] as const;
  const cell = [
    worldExtent[0] / Math.max(nx, 1),
    worldExtent[1] / Math.max(ny, 1),
    worldExtent[2] / Math.max(nz, 1),
  ] as const;
  const toSceneX = (value: number) => (value - domainMin[0]) / cell[0] - 0.5;
  const toSceneY = (value: number) => (value - domainMin[2]) / cell[2] - 0.5;
  const toSceneZ = (value: number) => (value - domainMin[1]) / cell[1] - 0.5;
  const sceneMin: [number, number, number] = [
    toSceneX(overlay.boundsMin[0]),
    toSceneY(overlay.boundsMin[2]),
    toSceneZ(overlay.boundsMin[1]),
  ];
  const sceneMax: [number, number, number] = [
    toSceneX(overlay.boundsMax[0]),
    toSceneY(overlay.boundsMax[2]),
    toSceneZ(overlay.boundsMax[1]),
  ];
  if (
    [...sceneMin, ...sceneMax].some((value) => !Number.isFinite(value)) ||
    sceneMax[0] <= sceneMin[0] ||
    sceneMax[1] <= sceneMin[1] ||
    sceneMax[2] <= sceneMin[2]
  ) {
    return null;
  }
  return { sceneMin, sceneMax };
}

function FdmObjectOverlayMeshes({
  overlays,
  selectedObjectId,
  objectViewMode,
  grid,
  worldExtent,
  universeCenter,
  onRequestObjectSelect,
  onGeometryTranslate,
}: {
  overlays: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  objectViewMode: ObjectViewMode;
  grid: [number, number, number];
  worldExtent: [number, number, number];
  universeCenter?: [number, number, number] | null;
  onRequestObjectSelect?: (id: string) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}) {
  const hasSelected = Boolean(selectedObjectId);
  const groupRef = useRef<THREE.Group>(null);
  
  const cellX = worldExtent[0] / Math.max(grid[0], 1);
  const cellY = worldExtent[1] / Math.max(grid[1], 1);
  const cellZ = worldExtent[2] / Math.max(grid[2], 1);

  return (
    <group>
      {overlays.map((overlay) => {
        const selected = selectedObjectId === overlay.id;
        const dimmed = hasSelected && !selected;
        if (objectViewMode === "isolate" && hasSelected && !selected) {
          return null;
        }
        const displayOverlay = expandOverlayBounds(overlay, selected);
        const mapped = mapOverlayToFdmSceneBox(displayOverlay, grid, worldExtent, universeCenter);
        if (!mapped) {
          return null;
        }
        const { sceneMin, sceneMax } = mapped;
        const size = [
          Math.max(sceneMax[0] - sceneMin[0], 0),
          Math.max(sceneMax[1] - sceneMin[1], 0),
          Math.max(sceneMax[2] - sceneMin[2], 0),
        ] as const;
        if (size.some((value) => !Number.isFinite(value) || value <= 0)) {
          return null;
        }
        const center = [
          0.5 * (sceneMin[0] + sceneMax[0]),
          0.5 * (sceneMin[1] + sceneMax[1]),
          0.5 * (sceneMin[2] + sceneMax[2]),
        ] as const;
        const colors = objectOverlayColors(selected, dimmed);
        const meshes = (
          <group>
            <mesh
              position={center}
              renderOrder={4}
              onClick={(e) => {
                e.stopPropagation();
                onRequestObjectSelect?.(overlay.id);
              }}
            >
              <boxGeometry args={size} />
              <meshStandardMaterial
                color={colors.fill}
                emissive={colors.fill}
                emissiveIntensity={selected ? 0.24 : 0.08}
                transparent
                opacity={colors.fillOpacity}
                depthWrite={false}
              />
            </mesh>
            <mesh position={center} renderOrder={5}>
              <boxGeometry args={size} />
              <meshBasicMaterial
                color={colors.wire}
                wireframe
                transparent
                opacity={colors.wireOpacity}
                depthWrite={false}
              />
            </mesh>
          </group>
        );

        if (selected && onGeometryTranslate) {
          return (
            <PivotControls
              key={overlay.id}
              depthTest={false}
              lineWidth={2}
              axisColors={["#f87171", "#4ade80", "#60a5fa"]}
              scale={100}
              fixed={true}
              onDragEnd={() => {
                if (groupRef.current) {
                  const p = groupRef.current.position;
                  const physicalDx = p.x * cellX;
                  const physicalDz = p.y * cellZ;
                  const physicalDy = p.z * cellY;
                  onGeometryTranslate(overlay.id, physicalDx, physicalDy, physicalDz);
                  groupRef.current.position.set(0, 0, 0);
                }
              }}
            >
              <group ref={groupRef}>{meshes}</group>
            </PivotControls>
          );
        }

        return <group key={overlay.id}>{meshes}</group>;
      })}
    </group>
  );
}

function FdmAntennaOverlayMeshes({
  overlays,
  selectedAntennaId,
  grid,
  worldExtent,
  universeCenter,
  onAntennaTranslate,
}: {
  overlays: AntennaOverlay[];
  selectedAntennaId?: string | null;
  grid: [number, number, number];
  worldExtent: [number, number, number];
  universeCenter?: [number, number, number] | null;
  onAntennaTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const cellX = worldExtent[0] / Math.max(grid[0], 1);
  const cellY = worldExtent[1] / Math.max(grid[1], 1);
  const cellZ = worldExtent[2] / Math.max(grid[2], 1);

  return (
    <group>
      {overlays.map((overlay) => {
        const selected = selectedAntennaId === overlay.id;
        const conductors = overlay.conductors.map((conductor) => {
          const mapped = mapOverlayToFdmSceneBox(conductor as any, grid, worldExtent, universeCenter);
          if (!mapped) return null;
          const { sceneMin, sceneMax } = mapped;
          const size = [
            Math.max(sceneMax[0] - sceneMin[0], 0),
            Math.max(sceneMax[1] - sceneMin[1], 0),
            Math.max(sceneMax[2] - sceneMin[2], 0),
          ] as const;
          if (size.some((v) => !Number.isFinite(v) || v <= 0)) return null;
          const center = [
            0.5 * (sceneMin[0] + sceneMax[0]),
            0.5 * (sceneMin[1] + sceneMax[1]),
            0.5 * (sceneMin[2] + sceneMax[2]),
          ] as const;
          const colors = antennaOverlayColors(conductor.role, selected);
          return (
            <group key={conductor.id}>
              <mesh position={center} renderOrder={4}>
                <boxGeometry args={size} />
                <meshStandardMaterial
                  color={colors.fill}
                  emissive={colors.fill}
                  emissiveIntensity={selected ? 0.35 : 0.18}
                  transparent
                  opacity={selected ? 0.28 : 0.12}
                  depthWrite={false}
                />
              </mesh>
              <mesh position={center} renderOrder={5}>
                <boxGeometry args={size} />
                <meshBasicMaterial
                  color={colors.wire}
                  wireframe
                  transparent
                  opacity={selected ? 0.95 : 0.65}
                  depthWrite={false}
                />
              </mesh>
            </group>
          );
        });

        if (selected && onAntennaTranslate) {
          return (
            <PivotControls
              key={overlay.id}
              depthTest={false}
              lineWidth={2}
              axisColors={["#f87171", "#4ade80", "#60a5fa"]}
              scale={100}
              fixed={true}
              onDragEnd={() => {
                if (groupRef.current) {
                  const p = groupRef.current.position;
                  const physicalDx = p.x * cellX;
                  const physicalDz = p.y * cellZ;
                  const physicalDy = p.z * cellY;
                  onAntennaTranslate(overlay.id, physicalDx, physicalDy, physicalDz);
                  groupRef.current.position.set(0, 0, 0);
                }
              }}
            >
              <group ref={groupRef}>{conductors}</group>
            </PivotControls>
          );
        }
        return <group key={overlay.id}>{conductors}</group>;
      })}
    </group>
  );
}

// ═══════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════
function VectorFieldView3DInner({
  grid,
  vectors,
  fieldLabel = "Vector Field",
  geometryMode = false,
  activeMask = null,
  worldExtent = null,
  objectOverlays = [],
  selectedObjectId = null,
  antennaOverlays = [],
  selectedAntennaId = null,
  onAntennaTranslate,
  universeCenter = null,
  focusObjectRequest = null,
  objectViewMode = "context",
  onRequestObjectSelect,
  onGeometryTranslate,
  activeTextureTransform = null,
  textureGizmoMode = "translate",
  activeTexturePreviewProxy = "box",
  onTextureTransformChange,
  onTextureTransformCommit,
  activeTransformScope,
  onTransformScopeChange,
  settings: externalSettings,
  onSettingsChange,
  viewportVisible = true,
}: Props) {
  const { hostRef, hostNode } = useCanvasHost<HTMLDivElement>();
  const [internalSettings, setInternalSettings] = useState<Settings>(loadSettings);
  const settings = useMemo(
    () => (externalSettings ? settingsFromPreset(externalSettings) : internalSettings),
    [externalSettings, internalSettings],
  );
  const [openPopover, setOpenPopover] = useState<"color" | "display" | "topo" | "camera" | null>(null);

  // ── 3dsmax-style interaction mode (camera / move / rotate / scale) ──
  type InteractionMode = "camera" | "move" | "rotate" | "scale";
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("camera");
  const cameraActive = interactionMode === "camera";

  // Switch back to camera when activeTextureTransform disappears
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!activeTextureTransform) setInteractionMode("camera");
  }, [activeTextureTransform]);

  useEffect(() => {
    if (!activeTextureTransform) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInteractionMode(
      textureGizmoMode === "rotate"
        ? "rotate"
        : textureGizmoMode === "scale"
          ? "scale"
          : "move",
    );
  }, [activeTextureTransform, textureGizmoMode]);

  // Keyboard shortcuts: Q=camera, W=move, E=rotate, R=scale (only when gizmo available)
  useEffect(() => {
    if (!activeTextureTransform) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "q" || e.key === "Q" || e.key === "Escape") setInteractionMode("camera");
      else if (e.key === "w" || e.key === "W") setInteractionMode("move");
      else if (e.key === "e" || e.key === "E") setInteractionMode("rotate");
      else if (e.key === "r" || e.key === "R") setInteractionMode("scale");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTextureTransform]);

  // Derive gizmo mode from interaction mode
  const derivedGizmoMode: TextureGizmoMode =
    interactionMode === "rotate" ? "rotate" :
    interactionMode === "scale"  ? "scale"  : "translate";
  const deferredVectors = useDeferredValue(vectors);
  const deferredSettings = useDeferredValue(settings);

  const controlsRef = useRef<any>(null);
  const viewCubeSceneRef = useRef<any>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<THREE.WebGLRenderer | null>(null);
  const r3fSceneRef = useRef<THREE.Scene | null>(null);
  const r3fCameraRef = useRef<THREE.Camera | null>(null);

  const [nx, ny, nz] = grid;
  const { cx, cy, cz, orbitDist } = useMemo(() => ({
    cx: nx / 2, cy: nz / 2, cz: ny / 2,
    orbitDist: Math.max(nx, ny, nz) * 1.5,
  }), [nx, ny, nz]);

  // Persist settings changes
  const update = useCallback((patch: Partial<Settings>) => {
    const writeSettings = (previous: Settings) => {
      const next = { ...previous, ...patch };
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
    };

    if (externalSettings && onSettingsChange) {
      onSettingsChange((prev) => settingsToPreset(writeSettings(settingsFromPreset(prev))));
      return;
    }

    setInternalSettings((prev) => writeSettings(prev));
  }, [externalSettings, onSettingsChange]);

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

  const handleViewCubeRotate = useCallback((quat: THREE.Quaternion) => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera || !bridge?.controls) return;
    rotateCameraAroundTarget(bridge.camera, bridge.controls, quat);
  }, []);

  const focusObject = useCallback((objectId: string) => {
    if (!worldExtent) {
      return;
    }
    const overlay = objectOverlays.find((candidate) => candidate.id === objectId);
    const bridge = viewCubeSceneRef.current;
    if (!overlay || !bridge?.camera || !bridge?.controls) {
      return;
    }
    const mapped = mapOverlayToFdmSceneBox(overlay, grid, worldExtent, universeCenter);
    if (!mapped) {
      return;
    }
    focusCameraOnBounds(
      bridge.camera,
      bridge.controls,
      { min: mapped.sceneMin, max: mapped.sceneMax },
      { fallbackMinRadius: 1.5 },
    );
  }, [grid, objectOverlays, universeCenter, worldExtent]);

  useEffect(() => {
    if (!focusObjectRequest) {
      return;
    }
    focusObject(focusObjectRequest.objectId);
  }, [focusObject, focusObjectRequest]);

  // Capture viewport as PNG — render a fresh frame and read immediately so
  // that preserveDrawingBuffer can stay disabled during normal interaction.
  const captureSnapshot = useCallback(() => {
    const gl = glRef.current;
    const scene = r3fSceneRef.current;
    const camera = r3fCameraRef.current;
    if (!gl || !scene || !camera) return;
    gl.render(scene, camera);
    const link = document.createElement("a");
    link.download = `fullmag_3d_${Date.now()}.png`;
    link.href = gl.domElement.toDataURL("image/png");
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
  // In isolate mode, keep voxels at full opacity to avoid transparent instanced mesh
  // sorting artifacts. The overlay boxes already hide non-selected objects visually.
  const sceneOpacityMultiplier = 1;

  // P0 FDM isolate: compute grid-space bounds so FdmInstances hides voxels outside
  // the selected object when in isolate mode.
  const isolateGridBounds = useMemo(() => {
    if (objectViewMode !== "isolate" || !selectedObjectId || !worldExtent) return null;
    const overlay = objectOverlays.find((o) => o.id === selectedObjectId);
    if (!overlay) return null;
    const domainCenter = universeCenter ?? [0, 0, 0];
    const domainMin = [
      domainCenter[0] - worldExtent[0] * 0.5,
      domainCenter[1] - worldExtent[1] * 0.5,
      domainCenter[2] - worldExtent[2] * 0.5,
    ] as const;
    const cellX = worldExtent[0] / Math.max(nx, 1);
    const cellY = worldExtent[1] / Math.max(ny, 1);
    const cellZ = worldExtent[2] / Math.max(nz, 1);
    const toIx = (wx: number) => (wx - domainMin[0]) / cellX - 0.5;
    const toIy = (wy: number) => (wy - domainMin[1]) / cellY - 0.5;
    const toIz = (wz: number) => (wz - domainMin[2]) / cellZ - 0.5;
    return {
      minIx: Math.floor(toIx(overlay.boundsMin[0])),
      maxIx: Math.ceil(toIx(overlay.boundsMax[0])),
      minIy: Math.floor(toIy(overlay.boundsMin[1])),
      maxIy: Math.ceil(toIy(overlay.boundsMax[1])),
      minIz: Math.floor(toIz(overlay.boundsMin[2])),
      maxIz: Math.ceil(toIz(overlay.boundsMax[2])),
    };
  }, [objectViewMode, selectedObjectId, objectOverlays, worldExtent, universeCenter, nx, ny, nz]);

  const toolbarOptionClassName =
    "appearance-none border border-transparent bg-transparent text-muted-foreground text-[0.65rem] font-semibold uppercase px-2 py-1 rounded cursor-pointer transition-colors hover:bg-muted/40 hover:text-foreground data-[active=true]:border-primary/45 data-[active=true]:bg-primary/18 data-[active=true]:text-primary";
  const fdmViewportFlags = FRONTEND_DIAGNOSTIC_FLAGS.fdmViewport;

  return (
    <div className="relative flex flex-col h-full">
      {/* ── Overlay Layout ────────────────────────────────────── */}
      <ViewportOverlayLayout>
        <ViewportOverlayLayout.TopLeft>
          {fdmViewportFlags.showToolbar || fdmViewportFlags.showStatusChip ? (
          <ViewportToolbar3D>
            {/* Render mode */}
            {fdmViewportFlags.showToolbar && !geometryMode && (
              <ViewportToolGroup label="Render">
                <ViewportIconAction
                  icon={<ArrowUpRight size={14} />}
                  active={settings.renderMode === "glyph"}
                  onClick={() => update({ renderMode: "glyph" })}
                  title="Arrows"
                />
                <ViewportIconAction
                  icon={<Box size={14} />}
                  active={settings.renderMode === "voxel"}
                  onClick={() => update({ renderMode: "voxel" })}
                  title="Voxel"
                />
              </ViewportToolGroup>
            )}

            {fdmViewportFlags.showToolbar ? <ViewportToolSeparator /> : null}

            {/* Color field (only voxel) */}
            {fdmViewportFlags.showToolbar && settings.renderMode === "voxel" && (
              <ViewportToolGroup label="Color">
                <ViewportPopoverTrigger preferredHorizontal="left">
                  <ViewportIconAction
                    icon={<Palette size={14} />}
                    label={settings.voxelColorMode === "orientation" ? "ORI" : settings.voxelColorMode.toUpperCase()}
                    active={openPopover === "color"}
                    showCaret
                    onClick={() => setOpenPopover(prev => prev === "color" ? null : "color")}
                    title="Color Field"
                  />
                  {openPopover === "color" && (
                    <ViewportPopoverPanel anchorRef={{ current: null }} title="Color Mode">
                       <ViewportPopoverRow label="Field">
                        {(["orientation", "x", "y", "z"] as VoxelColorMode[]).map(v => (
                           <button key={v} className={toolbarOptionClassName} data-active={settings.voxelColorMode === v} onClick={() => { update({ voxelColorMode: v }); setOpenPopover(null); }}>
                             {v === "orientation" ? "ORI" : v.toUpperCase()}
                           </button>
                        ))}
                      </ViewportPopoverRow>
                    </ViewportPopoverPanel>
                  )}
                </ViewportPopoverTrigger>
              </ViewportToolGroup>
            )}

            {fdmViewportFlags.showToolbar && settings.renderMode === "voxel" ? <ViewportToolSeparator /> : null}

            {fdmViewportFlags.showStatusChip ? (
              <ViewportStatusChip color="info">{fieldLabel ?? "M"}</ViewportStatusChip>
            ) : null}

            {fdmViewportFlags.showToolbar && fdmViewportFlags.showStatusChip ? <ViewportToolSeparator /> : null}

            {fdmViewportFlags.showToolbar ? <ViewportToolGroup>
              {/* Display settings Popover */}
              <ViewportPopoverTrigger preferredHorizontal="left">
                <ViewportIconAction
                  icon={<Eye size={14} />}
                  showCaret
                  active={openPopover === "display"}
                  onClick={() => setOpenPopover(prev => prev === "display" ? null : "display")}
                  title="Display Options"
                />
                {openPopover === "display" && (
                  <ViewportPopoverPanel anchorRef={{ current: null }} title="Display & Quality">
                    <ViewportPopoverRow label="Quality">
                       {(["low", "high", "ultra"] as QualityLevel[]).map(v => (
                           <button key={v} className={toolbarOptionClassName} data-active={settings.quality === v} onClick={() => update({ quality: v })}>
                             {v}
                           </button>
                        ))}
                    </ViewportPopoverRow>
                    <ViewportPopoverRow label="Brightness">
                       <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.3} max={3.0} step={0.1} value={settings.brightness} onChange={(e) => update({ brightness: parseFloat(e.target.value) })} />
                    </ViewportPopoverRow>
                    {settings.renderMode === "voxel" && (
                      <>
                        <div className="h-px bg-border/20 my-1"/>
                        <ViewportPopoverRow label="Opacity">
                           <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.15} max={0.95} step={0.01} value={settings.voxelOpacity} onChange={(e) => update({ voxelOpacity: parseFloat(e.target.value) })} />
                        </ViewportPopoverRow>
                        <ViewportPopoverRow label="Spacing">
                           <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.02} max={0.42} step={0.01} value={settings.voxelGap} onChange={(e) => update({ voxelGap: parseFloat(e.target.value) })} />
                        </ViewportPopoverRow>
                        <ViewportPopoverRow label="Min Str">
                           <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0} max={0.95} step={0.01} value={settings.voxelThreshold} onChange={(e) => update({ voxelThreshold: parseFloat(e.target.value) })} />
                        </ViewportPopoverRow>
                        <ViewportPopoverRow label="Sampling">
                           {(["1", "2", "4"]).map(v => (
                             <button key={v} className={toolbarOptionClassName} data-active={String(settings.sampling) === v} onClick={() => update({ sampling: parseInt(v, 10) as VoxelSampling })}>
                               {v}X
                             </button>
                           ))}
                        </ViewportPopoverRow>
                      </>
                    )}
                  </ViewportPopoverPanel>
                )}
              </ViewportPopoverTrigger>

              {/* Topography */}
              {!geometryMode && (
                <ViewportPopoverTrigger preferredHorizontal="left">
                  <ViewportIconAction
                    icon={<Mountain size={14} />}
                    showCaret
                    active={openPopover === "topo"}
                    onClick={() => setOpenPopover(prev => prev === "topo" ? null : "topo")}
                    title="Topography"
                  />
                  {openPopover === "topo" && (
                    <ViewportPopoverPanel anchorRef={{ current: null }} title="Topography">
                       <ViewportPopoverRow label="Enable">
                          <button className={toolbarOptionClassName} data-active={settings.topoEnabled} onClick={() => update({ topoEnabled: !settings.topoEnabled })}>
                            {settings.topoEnabled ? "ON" : "OFF"}
                          </button>
                       </ViewportPopoverRow>
                       {settings.topoEnabled && (
                         <>
                            <ViewportPopoverRow label="Display">
                              {(["x", "y", "z"] as TopoComponent[]).map(v => (
                                <button key={v} className={toolbarOptionClassName} data-active={settings.topoComponent === v} onClick={() => update({ topoComponent: v })}>
                                  m{v.toUpperCase()}
                                </button>
                              ))}
                            </ViewportPopoverRow>
                            <ViewportPopoverRow label="Amplitude">
                               <input type="range" className="flex-1 h-[3px] accent-primary max-w-[120px]" min={0.5} max={50} step={0.5} value={settings.topoMultiplier} onChange={(e) => update({ topoMultiplier: parseFloat(e.target.value) })} />
                            </ViewportPopoverRow>
                         </>
                       )}
                    </ViewportPopoverPanel>
                  )}
                </ViewportPopoverTrigger>
              )}

              {/* Camera Info */}
              <ViewportPopoverTrigger preferredHorizontal="left">
                <ViewportIconAction
                  icon={<Video size={14} />}
                  showCaret
                  active={openPopover === "camera"}
                  onClick={() => setOpenPopover(prev => prev === "camera" ? null : "camera")}
                  title="Camera"
                />
                {openPopover === "camera" && (
                  <ViewportPopoverPanel anchorRef={{ current: null }} title="Camera Presets">
                    <div className="grid grid-cols-2 gap-1 px-1">
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([0, 1, 0], [0, 0, -1]); setOpenPopover(null); }}>Top</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([0, 0, 1]); setOpenPopover(null); }}>Front</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([1, 0, 0]); setOpenPopover(null); }}>Right</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { snapCamera([1, 1, 1]); setOpenPopover(null); }}>Iso</button>
                      <button className="text-[0.65rem] font-semibold uppercase tracking-widest px-2 py-1.5 hover:bg-muted/50 rounded transition-colors text-muted-foreground hover:text-foreground text-left" onClick={() => { resetCamera(); setOpenPopover(null); }}>Reset</button>
                    </div>
                  </ViewportPopoverPanel>
                )}
              </ViewportPopoverTrigger>

              <ViewportToolSeparator />

              {/* Capture */}
              <ViewportIconAction
                icon={<Camera size={14} />}
                onClick={captureSnapshot}
                title="Snapshot"
              />
            </ViewportToolGroup> : null}
          </ViewportToolbar3D>
          ) : null}
        </ViewportOverlayLayout.TopLeft>

        <ViewportOverlayLayout.TopRight>
          {fdmViewportFlags.showViewCube && viewportVisible && (
            <ViewCube
              sceneRef={viewCubeSceneRef}
              onRotate={handleViewCubeRotate}
              onReset={resetCamera}
            />
          )}
        </ViewportOverlayLayout.TopRight>

        <ViewportOverlayLayout.BottomLeft>
          {fdmViewportFlags.showOrientationSphere && viewportVisible && !geometryMode ? (
            <HslSphere sceneRef={viewCubeSceneRef} axisConvention="identity" />
          ) : null}
        </ViewportOverlayLayout.BottomLeft>

        {/* ── 3dsmax-style interaction mode toolbar (only when texture gizmo available) ── */}
        {fdmViewportFlags.showTextureModeToolbar && (activeTextureTransform || activeTransformScope === "texture") && (
          <ViewportOverlayLayout.BottomCenter>
            <div className="pointer-events-auto flex items-center gap-px rounded-lg border border-border/40 bg-background/80 backdrop-blur-md shadow-md px-1 py-1">
              {/* Scope Toggle */}
              {onTransformScopeChange && (
                <>
                  <button
                    type="button"
                    title="Close texture gizmo"
                    onClick={() => onTransformScopeChange(null)}
                    className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-rose-500/20 hover:text-rose-400 transition-colors"
                  >
                    <Box size={13} />
                  </button>
                  <div className="w-px h-4 bg-border/50 mx-1" />
                </>
              )}

              {/* Orbit / Camera */}
              <button
                type="button"
                title="Orbit camera (Q)"
                onClick={() => setInteractionMode("camera")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  cameraActive
                    ? "bg-primary/20 text-primary border border-primary/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <MousePointer2 size={13} />
                <span>Orbit</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">Q</span>
              </button>

              <div className="w-px h-4 bg-border/50 mx-0.5" />

              {/* Move */}
              <button
                type="button"
                title="Move texture (W)"
                onClick={() => setInteractionMode("move")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  interactionMode === "move"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <Move size={13} />
                <span>Move</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">W</span>
              </button>

              {/* Rotate */}
              <button
                type="button"
                title="Rotate texture (E)"
                onClick={() => setInteractionMode("rotate")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  interactionMode === "rotate"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <RotateCw size={13} />
                <span>Rotate</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">E</span>
              </button>

              {/* Scale */}
              <button
                type="button"
                title="Scale texture (R)"
                onClick={() => setInteractionMode("scale")}
                className={cn(
                  "flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[0.65rem] font-bold uppercase tracking-wider transition-colors",
                  interactionMode === "scale"
                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/35"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground border border-transparent",
                )}
              >
                <Maximize2 size={13} />
                <span>Scale</span>
                <span className="text-[0.55rem] opacity-50 font-normal normal-case tracking-normal">R</span>
              </button>
            </div>
          </ViewportOverlayLayout.BottomCenter>
        )}
      </ViewportOverlayLayout>

      {/* ── R3F Canvas ────────────────────────────────────── */}
      <div ref={hostRef} className="absolute inset-0 pointer-events-none z-0">
        {hostNode ? (
          <Canvas
            eventSource={hostNode}
            frameloop={viewportVisible ? "demand" : "never"}
            className="w-full h-full pointer-events-auto"
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
            }}
            onCreated={({ gl, scene, camera }) => {
              canvasRef.current = gl.domElement;
              glRef.current = gl;
              r3fSceneRef.current = scene;
              r3fCameraRef.current = camera;
            }}
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
              sceneOpacityMultiplier={sceneOpacityMultiplier}
              isolateGridBounds={isolateGridBounds}
            />

            {worldExtent && objectOverlays.length > 0 ? (
              <FdmObjectOverlayMeshes
                overlays={objectOverlays}
                selectedObjectId={selectedObjectId}
                objectViewMode={objectViewMode}
                grid={grid}
                worldExtent={worldExtent}
                universeCenter={universeCenter}
                onRequestObjectSelect={onRequestObjectSelect}
                onGeometryTranslate={onGeometryTranslate}
              />
            ) : null}

            {worldExtent && antennaOverlays.length > 0 && objectViewMode !== "isolate" ? (
              <FdmAntennaOverlayMeshes
                overlays={antennaOverlays}
                selectedAntennaId={selectedAntennaId}
                grid={grid}
                worldExtent={worldExtent}
                universeCenter={universeCenter}
                onAntennaTranslate={onAntennaTranslate}
              />
            ) : null}

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
              cameraEnabled={cameraActive && viewportVisible}
            />

            {activeTextureTransform && !cameraActive && (
              <TextureTransformGizmo
                transform={activeTextureTransform}
                mode={derivedGizmoMode}
                previewProxy={activeTexturePreviewProxy}
                showPreviewProxy
                syncPivotWithTranslation
                swapYZ
                onLiveChange={onTextureTransformChange}
                visible
                onCommit={onTextureTransformCommit}
              />
            )}
          </Canvas>
        ) : null}
      </div>
    </div>
  );
}



export default memo(VectorFieldView3DInner);
