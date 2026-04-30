"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { PivotControls, TrackballControls } from "@react-three/drei";

import ViewCube from "./ViewCube";
import { fitCameraToBounds, focusCameraOnBounds, rotateCameraAroundTarget } from "./camera/cameraHelpers";
import SceneAxes3D from "./r3f/SceneAxes3D";
import { useCanvasHost } from "./shared/useCanvasHost";
import ViewportTelemetryProbe from "./shared/ViewportTelemetryProbe";
import {
  CAMERA_CONTROL_PROFILES,
  type CameraControlProfileId,
  createCameraStepLockState,
  applyCameraStepLock,
} from "./camera/cameraProfiles";
import { useViewportTelemetryEntry } from "@/lib/debug/viewportTelemetry";
import type {
  BuilderObjectOverlay,
  FocusObjectRequest,
} from "../runs/control-room/shared";

interface BoundsPreview3DProps {
  objectOverlays?: BuilderObjectOverlay[];
  selectedObjectId?: string | null;
  focusObjectRequest?: FocusObjectRequest | null;
  worldExtent?: [number, number, number] | null;
  worldCenter?: [number, number, number] | null;
  enableObjectInteractions?: boolean;
  onRequestObjectSelect?: (id: string) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}

function combineOverlayBounds(
  overlays: readonly BuilderObjectOverlay[],
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (overlays.length === 0) {
    return null;
  }
  let min: [number, number, number] | null = null;
  let max: [number, number, number] | null = null;
  for (const overlay of overlays) {
    if (!min || !max) {
      min = [...overlay.boundsMin] as [number, number, number];
      max = [...overlay.boundsMax] as [number, number, number];
      continue;
    }
    min = min.map((value, axis) => Math.min(value, overlay.boundsMin[axis])) as [
      number,
      number,
      number,
    ];
    max = max.map((value, axis) => Math.max(value, overlay.boundsMax[axis])) as [
      number,
      number,
      number,
    ];
  }
  return min && max ? { min, max } : null;
}

function objectOverlayColors(selected: boolean, dimmed: boolean) {
  if (selected) {
    return { fill: "#facc15", wire: "#fff7ae", fillOpacity: 0.26, wireOpacity: 1 };
  }
  if (dimmed) {
    return { fill: "#64748b", wire: "#94a3b8", fillOpacity: 0.04, wireOpacity: 0.28 };
  }
  return { fill: "#60a5fa", wire: "#bfdbfe", fillOpacity: 0.1, wireOpacity: 0.58 };
}

function expandedOverlay(
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

function SyncedControls({
  controlsRefObject,
  viewCubeBridgeRef,
  target,
}: {
  controlsRefObject: React.MutableRefObject<any>;
  viewCubeBridgeRef: React.MutableRefObject<any>;
  target: [number, number, number];
}) {
  const { camera } = useThree();
  const stepLockState = useRef(createCameraStepLockState());
  const controlProfile: CameraControlProfileId = "fdm";
  const profile = CAMERA_CONTROL_PROFILES[controlProfile];
  const handleChange = useCallback(() => {
    const controls = controlsRefObject.current;
    const snapped = applyCameraStepLock({
      camera,
      controls,
      profile,
      state: stepLockState.current,
    });
    if (snapped) {
      controls?.update();
    }
  }, [camera, controlsRefObject, profile]);

  useEffect(() => {
    let raf = 0;
    let disposed = false;

    const syncBridge = () => {
      if (disposed) {
        return;
      }
      const controls = controlsRefObject.current ?? null;
      viewCubeBridgeRef.current = { camera, controls };
      if (!controls) {
        raf = window.requestAnimationFrame(syncBridge);
      }
    };

    syncBridge();

    return () => {
      disposed = true;
      if (raf) {
        window.cancelAnimationFrame(raf);
      }
      viewCubeBridgeRef.current = null;
    };
  }, [camera, controlsRefObject, viewCubeBridgeRef]);

  return (
    <TrackballControls
      ref={controlsRefObject}
      rotateSpeed={profile.rotateSpeed}
      zoomSpeed={profile.zoomSpeed}
      panSpeed={profile.panSpeed}
      dynamicDampingFactor={profile.dampingFactor}
      target={target}
      onChange={handleChange}
    />
  );
}

function CameraAutoFit({
  maxDim,
  center,
}: {
  maxDim: number;
  center: THREE.Vector3;
}) {
  const { camera, invalidate } = useThree();
  // C6: only fire once per unique scene extent — prevents camera reset on every
  // re-render that recomputes maxDim/center without changing the actual geometry.
  const lastFittedRef = useRef<string>("");

  useEffect(() => {
    if (maxDim <= 0) {
      return;
    }
    const sig = `${maxDim.toFixed(6)}:${center.x.toFixed(6)}:${center.y.toFixed(6)}:${center.z.toFixed(6)}`;
    if (lastFittedRef.current === sig) {
      return;
    }
    lastFittedRef.current = sig;
    fitCameraToBounds(camera, maxDim, center);
    invalidate();
  }, [camera, center, invalidate, maxDim]);

  return null;
}

function DomainFrameBox({
  worldExtent,
  worldCenter,
  geomCenter,
}: {
  worldExtent: [number, number, number];
  worldCenter: [number, number, number];
  geomCenter: THREE.Vector3;
}) {
  const position: [number, number, number] = [
    worldCenter[0] - geomCenter.x,
    worldCenter[1] - geomCenter.y,
    worldCenter[2] - geomCenter.z,
  ];

  return (
    <group>
      <mesh position={position} renderOrder={1}>
        <boxGeometry args={worldExtent} />
        <meshBasicMaterial color="#67e8f9" wireframe transparent opacity={0.22} depthWrite={false} />
      </mesh>
      <lineSegments position={position} renderOrder={2}>
        <edgesGeometry args={[new THREE.BoxGeometry(...worldExtent)]} />
        <lineBasicMaterial color="#a5f3fc" transparent opacity={0.42} />
      </lineSegments>
    </group>
  );
}

function OverlayBoxes({
  overlays,
  geomCenter,
  selectedObjectId,
  enableObjectInteractions,
  onRequestObjectSelect,
  onGeometryTranslate,
}: {
  overlays: BuilderObjectOverlay[];
  geomCenter: THREE.Vector3;
  selectedObjectId?: string | null;
  enableObjectInteractions: boolean;
  onRequestObjectSelect?: (id: string) => void;
  onGeometryTranslate?: (id: string, dx: number, dy: number, dz: number) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);

  return (
    <group>
      {overlays.map((overlay) => {
        const selected = selectedObjectId === overlay.id;
        const dimmed = Boolean(selectedObjectId) && selectedObjectId !== overlay.id;
        const displayOverlay = expandedOverlay(overlay, selected);
        const size = [
          displayOverlay.boundsMax[0] - displayOverlay.boundsMin[0],
          displayOverlay.boundsMax[1] - displayOverlay.boundsMin[1],
          displayOverlay.boundsMax[2] - displayOverlay.boundsMin[2],
        ] as const;
        if (size.some((value) => value <= 0)) {
          return null;
        }
        const center: [number, number, number] = [
          0.5 * (displayOverlay.boundsMin[0] + displayOverlay.boundsMax[0]) - geomCenter.x,
          0.5 * (displayOverlay.boundsMin[1] + displayOverlay.boundsMax[1]) - geomCenter.y,
          0.5 * (displayOverlay.boundsMin[2] + displayOverlay.boundsMax[2]) - geomCenter.z,
        ];
        const colors = objectOverlayColors(selected, dimmed);

        const meshes = (
          <group>
            <mesh
              position={center}
              renderOrder={4}
              onClick={
                enableObjectInteractions && onRequestObjectSelect
                  ? (event) => {
                      event.stopPropagation();
                      onRequestObjectSelect(overlay.id);
                    }
                  : undefined
              }
            >
              <boxGeometry args={size} />
              <meshStandardMaterial
                color={colors.fill}
                emissive={colors.fill}
                emissiveIntensity={selected ? 0.24 : 0.1}
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

        if (selected && enableObjectInteractions && onGeometryTranslate) {
          return (
            <PivotControls
              key={overlay.id}
              depthTest={false}
              lineWidth={2}
              axisColors={["#f87171", "#4ade80", "#60a5fa"]}
              scale={75}
              fixed={true}
              onDragEnd={() => {
                if (!groupRef.current) {
                  return;
                }
                const position = groupRef.current.position;
                onGeometryTranslate(overlay.id, position.x, position.y, position.z);
                groupRef.current.position.set(0, 0, 0);
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

export default function BoundsPreview3D({
  objectOverlays = [],
  selectedObjectId = null,
  focusObjectRequest = null,
  worldExtent = null,
  worldCenter = null,
  enableObjectInteractions = true,
  onRequestObjectSelect,
  onGeometryTranslate,
}: BoundsPreview3DProps) {
  const telemetry = useViewportTelemetryEntry({
    label: "bounds-preview",
    renderer: "webgl",
    frameloop: "demand",
    hidden: false,
  });
  const { hostRef, hostNode } = useCanvasHost<HTMLDivElement>();
  const bounds = useMemo(() => combineOverlayBounds(objectOverlays), [objectOverlays]);
  const frameCenter = worldCenter
    ? new THREE.Vector3(worldCenter[0], worldCenter[1], worldCenter[2])
    : bounds
      ? new THREE.Vector3(
          0.5 * (bounds.min[0] + bounds.max[0]),
          0.5 * (bounds.min[1] + bounds.max[1]),
          0.5 * (bounds.min[2] + bounds.max[2]),
        )
      : new THREE.Vector3(0, 0, 0);
  const extent = worldExtent
    ? Math.max(worldExtent[0], worldExtent[1], worldExtent[2])
    : bounds
      ? Math.max(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        )
      : 1;
  const sceneMaxDim = Math.max(extent, 1e-9);
  const controlsRef = useRef<any>(null);
  const viewCubeSceneRef = useRef<any>(null);

  const focusObject = useCallback((objectId: string) => {
    const overlay = objectOverlays.find((candidate) => candidate.id === objectId);
    const bridge = viewCubeSceneRef.current;
    if (!overlay || !bridge?.camera || !bridge?.controls) {
      return;
    }
    focusCameraOnBounds(
      bridge.camera,
      bridge.controls,
      {
        min: [
          overlay.boundsMin[0] - frameCenter.x,
          overlay.boundsMin[1] - frameCenter.y,
          overlay.boundsMin[2] - frameCenter.z,
        ],
        max: [
          overlay.boundsMax[0] - frameCenter.x,
          overlay.boundsMax[1] - frameCenter.y,
          overlay.boundsMax[2] - frameCenter.z,
        ],
      },
      { fallbackMinRadius: sceneMaxDim * 0.05 },
    );
  }, [frameCenter.x, frameCenter.y, frameCenter.z, objectOverlays, sceneMaxDim]);

  useEffect(() => {
    if (!focusObjectRequest) {
      return;
    }
    focusObject(focusObjectRequest.objectId);
  }, [focusObject, focusObjectRequest]);

  const resetCamera = useCallback(() => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera || !bridge?.controls) {
      return;
    }
    fitCameraToBounds(bridge.camera, sceneMaxDim, new THREE.Vector3(0, 0, 0));
    bridge.controls.target.set(0, 0, 0);
    bridge.controls.update();
  }, [sceneMaxDim]);

  const handleViewCubeRotate = useCallback((quat: THREE.Quaternion) => {
    const bridge = viewCubeSceneRef.current;
    if (!bridge?.camera || !bridge?.controls) {
      return;
    }
    rotateCameraAroundTarget(bridge.camera, bridge.controls, quat);
  }, []);

  const axesCenter: [number, number, number] = worldCenter
    ? [
        worldCenter[0] - frameCenter.x,
        worldCenter[1] - frameCenter.y,
        worldCenter[2] - frameCenter.z,
      ]
    : [0, 0, 0];

  return (
    <div ref={hostRef} className="relative flex flex-1 h-full w-full min-h-0 min-w-0 overflow-hidden rounded-md bg-background">
      {hostNode ? (
        <Canvas
          eventSource={hostNode}
          frameloop="demand"
          camera={{ position: [3, 2.4, 3], fov: 45, near: 0.0001, far: 10000 }}
        >
          <ViewportTelemetryProbe
            label="bounds-preview"
            dpr={1}
            hidden={false}
            onStats={telemetry.update}
          />
          <color attach="background" args={[0x1e1e2e]} />
          <ambientLight intensity={0.45} />
          <directionalLight position={[1, 2, 3]} intensity={0.8} />
          <directionalLight position={[-1, -1, -2]} intensity={0.25} color={0x6688cc} />

          <CameraAutoFit maxDim={sceneMaxDim} center={new THREE.Vector3(0, 0, 0)} />

          {worldExtent ? (
            <DomainFrameBox
              worldExtent={worldExtent}
              worldCenter={worldCenter ?? [0, 0, 0]}
              geomCenter={frameCenter}
            />
          ) : null}

          <OverlayBoxes
            overlays={objectOverlays}
            geomCenter={frameCenter}
            selectedObjectId={selectedObjectId}
            enableObjectInteractions={enableObjectInteractions}
            onRequestObjectSelect={onRequestObjectSelect}
            onGeometryTranslate={onGeometryTranslate}
          />

          {worldExtent ? (
            <SceneAxes3D worldExtent={worldExtent} center={axesCenter} sceneScale={[1, 1, 1]} />
          ) : null}

          <SyncedControls
            controlsRefObject={controlsRef}
            viewCubeBridgeRef={viewCubeSceneRef}
            target={[0, 0, 0]}
          />
        </Canvas>
      ) : null}

      <ViewCube
        sceneRef={viewCubeSceneRef}
        onRotate={handleViewCubeRotate}
        onReset={resetCamera}
      />

      <div className="pointer-events-none absolute left-3 bottom-3 rounded-full border border-cyan-400/25 bg-background/70 px-3 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-cyan-200 shadow-md backdrop-blur-md">
        Bounds Preview
      </div>
    </div>
  );
}
