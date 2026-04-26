"use client";

/**
 * ViewCube — compact viewport navigation gizmo synchronized with the live camera.
 *
 * The cube and the orientation sphere now read the same camera orientation source
 * (`camera.quaternion`) and use the same camera adapter for snap/orbit actions.
 * This keeps camera, ViewCube, and HSL reference in a single orientation model.
 */

import { useCallback, useMemo, useRef, useState, type MutableRefObject, type PointerEvent } from "react";
import * as THREE from "three";
import type { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";

import { cn } from "@/lib/utils";

import {
  cameraOrientationCssTransform,
  cameraOrientationSignature,
  captureOrientationDebugSnapshot,
  orbitCameraAroundTarget,
  quaternionFromViewDirection,
  snapCameraToDirection,
  type OrientationDebugSnapshot,
  type SceneCameraHandle,
} from "./camera/cameraOrientation";
import { setCameraPresetAroundTarget } from "./camera/cameraHelpers";
import { useSceneCameraChange } from "./camera/useSceneCameraChange";
import {
  buildViewCubeFaces,
  buildViewCubeTargetMap,
  type ViewTarget,
  type ViewTargetKind,
} from "./viewcube/viewCubeModel";
import {
  sceneAxisDescriptor,
  type AxisConvention,
} from "./transform/axisConvention";

type SceneHandle = SceneCameraHandle & {
  controls:
    | TrackballControls
    | {
        target: THREE.Vector3;
        update(): void;
        addEventListener?: (t: string, l: () => void) => void;
        removeEventListener?: (t: string, l: () => void) => void;
      };
};

export interface ViewCubeProps {
  sceneRef?: MutableRefObject<SceneHandle | null>;
  onRotate?: (q: THREE.Quaternion) => void;
  onReset?: () => void;
  axisConvention?: AxisConvention;
  size?: number;
  className?: string;
  cubeClassName?: string;
  axisClassName?: string;
  embedded?: boolean;
  onOrientationSnapshot?: (snapshot: OrientationDebugSnapshot) => void;
}

type DragSession = {
  active: boolean;
  moved: boolean;
  startX: number;
  startY: number;
  pointerId: number;
  targetId: string | null;
};

const CUBE = 62;
const RING_W = 11;
const RING_PAD = 12;
const WIDGET = CUBE + (RING_PAD + RING_W) * 2 + 4;

const EDGE_WIDTH = 9;
const CORNER_WIDTH = 9;
const FACE_INNER = CUBE - EDGE_WIDTH * 2;

const SVG_SIZE = WIDGET;
const R_OUT = SVG_SIZE / 2 - 2;
const R_IN = R_OUT - RING_W;
const CX = SVG_SIZE / 2;
const CY = SVG_SIZE / 2;

const COLORS = {
  faceBg: "linear-gradient(150deg,rgba(50,62,82,0.90) 0%,rgba(32,42,58,0.94) 45%,rgba(20,28,42,0.97) 100%)",
  faceEdge: "rgba(120,140,165,0.30)",
  faceGlow: "inset 0 1px 0 rgba(255,255,255,0.10),inset 0 -1px 0 rgba(0,0,0,0.24)",
  cellBorder: "rgba(145,161,186,0.18)",
  cellInset: "inset 0 0 0 1px rgba(255,255,255,0.02)",

  hFace: "linear-gradient(180deg,rgba(94,184,255,0.94) 0%,rgba(43,134,240,0.98) 100%)",
  hFaceBorder: "rgba(174,221,255,0.96)",
  hFaceGlow: "0 0 0 1px rgba(173,220,255,0.58),0 0 16px rgba(44,143,255,0.42),inset 0 1px 0 rgba(255,255,255,0.34)",
  hEdge: "linear-gradient(180deg,rgba(94,184,255,0.92) 0%,rgba(43,134,240,0.96) 100%)",
  hEdgeBorder: "rgba(174,221,255,0.92)",
  hEdgeGlow: "0 0 0 1px rgba(173,220,255,0.50),0 0 14px rgba(44,143,255,0.36),inset 0 1px 0 rgba(255,255,255,0.28)",
  hCorner: "linear-gradient(180deg,rgba(110,194,255,0.96) 0%,rgba(47,142,245,0.98) 100%)",
  hCornerBorder: "rgba(207,236,255,0.98)",
  hCornerGlow: "0 0 0 1px rgba(173,220,255,0.56),0 0 16px rgba(44,143,255,0.40),inset 0 1px 0 rgba(255,255,255,0.32)",

  ringTrack: "rgba(55,70,95,0.45)",
  ringHover: "rgba(56,189,248,0.18)",
  ringBorder: "rgba(90,108,134,0.45)",
  ringArrow: "rgba(148,163,184,0.55)",
  ringArrowHov: "rgba(186,230,253,0.92)",
} as const;

const ARC_ZONES = [
  { id: "top", startAngle: 325, endAngle: 35, deltaTheta: 0, deltaPhi: -1 },
  { id: "right", startAngle: 55, endAngle: 125, deltaTheta: 1, deltaPhi: 0 },
  { id: "bottom", startAngle: 145, endAngle: 215, deltaTheta: 0, deltaPhi: 1 },
  { id: "left", startAngle: 235, endAngle: 305, deltaTheta: -1, deltaPhi: 0 },
] as const;

function targetHighlight(kind: ViewTargetKind, hovered: boolean): {
  background: string;
  border: string;
  radius: number;
  shadow: string;
} {
  if (!hovered) {
    return {
      background: "transparent",
      border: COLORS.cellBorder,
      radius: kind === "corner" ? 2 : kind === "edge" ? 1 : 3,
      shadow: COLORS.cellInset,
    };
  }
  if (kind === "face") {
    return {
      background: COLORS.hFace,
      border: COLORS.hFaceBorder,
      radius: 3,
      shadow: COLORS.hFaceGlow,
    };
  }
  if (kind === "edge") {
    return {
      background: COLORS.hEdge,
      border: COLORS.hEdgeBorder,
      radius: 1,
      shadow: COLORS.hEdgeGlow,
    };
  }
  return {
    background: COLORS.hCorner,
    border: COLORS.hCornerBorder,
    radius: 2,
    shadow: COLORS.hCornerGlow,
  };
}

function donutArc(startAngle: number, endAngle: number): string {
  const angleStart = (startAngle - 90) * Math.PI / 180;
  const angleEnd = (endAngle - 90) * Math.PI / 180;
  const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
  const x0Outer = CX + R_OUT * Math.cos(angleStart);
  const y0Outer = CY + R_OUT * Math.sin(angleStart);
  const x1Outer = CX + R_OUT * Math.cos(angleEnd);
  const y1Outer = CY + R_OUT * Math.sin(angleEnd);
  const x1Inner = CX + R_IN * Math.cos(angleEnd);
  const y1Inner = CY + R_IN * Math.sin(angleEnd);
  const x0Inner = CX + R_IN * Math.cos(angleStart);
  const y0Inner = CY + R_IN * Math.sin(angleStart);
  return `M${x0Outer},${y0Outer} A${R_OUT},${R_OUT},0,${largeArc},1,${x1Outer},${y1Outer} L${x1Inner},${y1Inner} A${R_IN},${R_IN},0,${largeArc},0,${x0Inner},${y0Inner} Z`;
}

function arrowTriangle(midAngle: number, size = 4.5): string {
  const radius = (R_IN + R_OUT) / 2;
  const mainAngle = (midAngle - 90) * Math.PI / 180;
  const centerX = CX + radius * Math.cos(mainAngle);
  const centerY = CY + radius * Math.sin(mainAngle);
  const perpendicular = mainAngle + Math.PI / 2;
  const tipX = centerX + size * Math.cos(mainAngle);
  const tipY = centerY + size * Math.sin(mainAngle);
  const leftX = centerX - size * 0.55 * Math.cos(mainAngle) + size * 0.6 * Math.cos(perpendicular);
  const leftY = centerY - size * 0.55 * Math.sin(mainAngle) + size * 0.6 * Math.sin(perpendicular);
  const rightX = centerX - size * 0.55 * Math.cos(mainAngle) - size * 0.6 * Math.cos(perpendicular);
  const rightY = centerY - size * 0.55 * Math.sin(mainAngle) - size * 0.6 * Math.sin(perpendicular);
  return `M${tipX},${tipY} L${leftX},${leftY} L${rightX},${rightY} Z`;
}

function resolveTargetIdFromElement(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  return target.closest<HTMLElement>("[data-view-target-id]")?.dataset.viewTargetId ?? null;
}

function CubeFace({
  transform,
  targets,
  hoveredTargetId,
  onPreviewTarget,
  onCommitTarget,
}: {
  transform: string;
  targets: readonly ViewTarget[];
  hoveredTargetId: string | null;
  onPreviewTarget: (targetId: string | null) => void;
  onCommitTarget: (target: ViewTarget) => void;
}) {
  return (
    <div
      className="absolute"
      style={{
        width: CUBE,
        height: CUBE,
        transform,
        transformStyle: "preserve-3d",
        backfaceVisibility: "hidden",
      }}
      onPointerLeave={() => onPreviewTarget(null)}
    >
      <div
        className="absolute inset-0 rounded-[4px]"
        style={{
          background: COLORS.faceBg,
          border: `1px solid ${COLORS.faceEdge}`,
          boxShadow: COLORS.faceGlow,
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          display: "grid",
          gridTemplateColumns: `${CORNER_WIDTH}px ${FACE_INNER}px ${CORNER_WIDTH}px`,
          gridTemplateRows: `${CORNER_WIDTH}px ${FACE_INNER}px ${CORNER_WIDTH}px`,
        }}
      >
        {targets.map((target) => {
          const hovered = hoveredTargetId === target.id;
          const highlight = targetHighlight(target.kind, hovered);
          return (
            <button
              key={target.id}
              data-view-target-id={target.id}
              type="button"
              aria-label={target.ariaLabel}
              title={target.previewLabel}
              onPointerEnter={() => onPreviewTarget(target.id)}
              onPointerMove={() => onPreviewTarget(target.id)}
              onPointerLeave={() => onPreviewTarget(null)}
              onFocus={() => onPreviewTarget(target.id)}
              onBlur={() => onPreviewTarget(null)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onCommitTarget(target);
                }
              }}
              style={{
                background: highlight.background,
                border: `1px solid ${highlight.border}`,
                borderRadius: highlight.radius,
                boxShadow: highlight.shadow,
                padding: 0,
                margin: 0,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                outline: "none",
                transition: "background 70ms, border-color 70ms, color 70ms, box-shadow 70ms",
              }}
            >
              {target.kind === "face" && target.label ? (
                <span
                  style={{
                    pointerEvents: "none",
                    userSelect: "none",
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: "0.05em",
                    color: hovered ? "rgba(255,255,255,0.98)" : "rgba(203,213,225,0.82)",
                    textShadow: hovered
                      ? "0 1px 2px rgba(15,23,42,0.52)"
                      : "0 1px 3px rgba(0,0,0,0.85)",
                  }}
                >
                  {target.label}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TripodArm({
  color,
  label,
  rotation,
  fontSize = 9,
}: {
  color: string;
  label: string;
  rotation: string;
  fontSize?: number;
}) {
  const length = 17;
  return (
    <>
      <div
        style={{
          position: "absolute",
          width: 2,
          height: length,
          left: "50%",
          top: "50%",
          marginLeft: -1,
          transformOrigin: "top center",
          transform: `${rotation} translateY(-${length / 2}px)`,
          transformStyle: "preserve-3d",
          background: color,
          borderRadius: 1,
          boxShadow: `0 0 4px ${color}80`,
        }}
      />
      <div
        style={{
          position: "absolute",
          fontSize,
          fontWeight: 800,
          left: "50%",
          top: "50%",
          marginLeft: -5,
          marginTop: -6,
          transformOrigin: "center",
          transform: `${rotation} translateY(-${length + 7}px)`,
          transformStyle: "preserve-3d",
          color,
          textShadow: "0 1px 3px rgba(0,0,0,0.7)",
          pointerEvents: "none",
        }}
      >
        {label}
      </div>
    </>
  );
}

function OrbitRing({
  hoveredArcId,
  setHoveredArcId,
  onArcClick,
  onHome,
  scale = 1,
}: {
  hoveredArcId: string | null;
  setHoveredArcId: (id: string | null) => void;
  onArcClick: (deltaTheta: number, deltaPhi: number) => void;
  onHome: () => void;
  scale?: number;
}) {
  const homeAngle = (45 - 90) * Math.PI / 180;
  const homeRadius = R_OUT - RING_W / 2;
  const homeCenterX = CX + homeRadius * Math.cos(homeAngle);
  const homeCenterY = CY + homeRadius * Math.sin(homeAngle);

  return (
    <svg
      width={SVG_SIZE * scale}
      height={SVG_SIZE * scale}
      viewBox={`0 0 ${SVG_SIZE} ${SVG_SIZE}`}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      aria-hidden
    >
      <circle
        cx={CX}
        cy={CY}
        r={(R_IN + R_OUT) / 2}
        fill="none"
        strokeWidth={RING_W}
        stroke={COLORS.ringTrack}
      />

      {ARC_ZONES.map((zone) => (
        <g
          key={zone.id}
          style={{ pointerEvents: "auto", cursor: "pointer" }}
          onMouseEnter={() => setHoveredArcId(zone.id)}
          onMouseLeave={() => setHoveredArcId(null)}
          onClick={() => onArcClick(zone.deltaTheta, zone.deltaPhi)}
        >
          <path
            d={donutArc(zone.startAngle, zone.endAngle)}
            fill={hoveredArcId === zone.id ? COLORS.ringHover : "transparent"}
            stroke={hoveredArcId === zone.id ? COLORS.hEdgeBorder : "transparent"}
            strokeWidth={0.5}
            style={{ transition: "fill 70ms" }}
          />
          <path
            d={arrowTriangle((zone.startAngle + zone.endAngle) / 2)}
            fill={hoveredArcId === zone.id ? COLORS.ringArrowHov : COLORS.ringArrow}
            style={{ transition: "fill 70ms", pointerEvents: "none" }}
          />
        </g>
      ))}

      <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke={COLORS.ringBorder} strokeWidth={0.8} />
      <circle cx={CX} cy={CY} r={R_IN} fill="none" stroke={COLORS.ringBorder} strokeWidth={0.8} />

      <g style={{ pointerEvents: "auto", cursor: "pointer" }} onClick={onHome}>
        <circle
          cx={homeCenterX}
          cy={homeCenterY}
          r={8}
          fill="rgba(25,35,52,0.92)"
          stroke="rgba(100,116,139,0.50)"
          strokeWidth={0.8}
        />
        <path
          transform={`translate(${homeCenterX},${homeCenterY})`}
          d="M0,-4 L4,0 L3,0 L3,3.5 L1,3.5 L1,1.5 L-1,1.5 L-1,3.5 L-3,3.5 L-3,0 L-4,0 Z"
          fill="rgba(186,230,253,0.80)"
        />
      </g>
    </svg>
  );
}

export default function ViewCube({
  sceneRef,
  onRotate,
  onReset,
  axisConvention = "identity",
  size = 1,
  className,
  cubeClassName,
  axisClassName,
  onOrientationSnapshot,
}: ViewCubeProps) {
  const axisX = sceneAxisDescriptor(0, axisConvention);
  const axisY = sceneAxisDescriptor(1, axisConvention);
  const axisZ = sceneAxisDescriptor(2, axisConvention);
  const scale = Number.isFinite(size) && size > 0 ? size : 1;

  const faces = useMemo(() => buildViewCubeFaces(axisConvention), [axisConvention]);
  const targetsById = useMemo(() => buildViewCubeTargetMap(faces), [faces]);

  const cubeRef = useRef<HTMLDivElement>(null);
  const tripodRef = useRef<HTMLDivElement>(null);
  const lastOrientationRef = useRef<string>("");
  const dragRef = useRef<DragSession>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    pointerId: -1,
    targetId: null,
  });

  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const [hoveredArcId, setHoveredArcId] = useState<string | null>(null);

  const syncOrientation = useCallback(() => {
    const handle = sceneRef?.current;
    if (!handle) {
      return;
    }

    const signature = cameraOrientationSignature(handle.camera);
    if (signature === lastOrientationRef.current) {
      return;
    }

    lastOrientationRef.current = signature;
    const cssTransform = cameraOrientationCssTransform(handle.camera);
    if (cubeRef.current) {
      cubeRef.current.style.transform = cssTransform;
    }
    if (tripodRef.current) {
      tripodRef.current.style.transform = cssTransform;
    }
    onOrientationSnapshot?.({
      ...captureOrientationDebugSnapshot(handle.camera),
      cssTransform,
    });
  }, [onOrientationSnapshot, sceneRef]);

  useSceneCameraChange(sceneRef, syncOrientation);

  const commitSnap = useCallback((target: ViewTarget) => {
    const handle = sceneRef?.current;
    if (handle?.camera && handle.controls) {
      snapCameraToDirection(handle.camera, handle.controls, target.direction);
      syncOrientation();
      return;
    }

    const quaternion = quaternionFromViewDirection(target.direction);
    onRotate?.(quaternion);
  }, [onRotate, sceneRef, syncOrientation]);

  const resetView = useCallback(() => {
    if (onReset) {
      onReset();
      syncOrientation();
      return;
    }

    const handle = sceneRef?.current;
    if (handle?.camera && handle.controls) {
      const distance = handle.camera.position.clone().sub(handle.controls.target).length() || 1;
      setCameraPresetAroundTarget(handle.camera, handle.controls, "reset", distance);
      syncOrientation();
      return;
    }

    onRotate?.(new THREE.Quaternion());
  }, [onReset, onRotate, sceneRef, syncOrientation]);

  const orbitByArc = useCallback((deltaTheta: number, deltaPhi: number) => {
    const handle = sceneRef?.current;
    if (!handle?.camera || !handle.controls) {
      return;
    }

    orbitCameraAroundTarget(
      handle.camera,
      handle.controls,
      deltaTheta * Math.PI * 0.25,
      deltaPhi * Math.PI * 0.15,
      { minPhi: 0.05, maxPhi: Math.PI - 0.05 },
    );
    syncOrientation();
  }, [sceneRef, syncOrientation]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const targetId = resolveTargetIdFromElement(event.target);
    dragRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      targetId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag.active) {
      return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;

    if (!drag.moved && Math.abs(deltaX) < 3 && Math.abs(deltaY) < 3) {
      return;
    }

    drag.moved = true;
    const handle = sceneRef?.current;
    if (handle?.camera && handle.controls) {
      orbitCameraAroundTarget(
        handle.camera,
        handle.controls,
        -deltaX * 0.009,
        -deltaY * 0.009,
      );
      syncOrientation();
    }

    drag.startX = event.clientX;
    drag.startY = event.clientY;
  }, [sceneRef, syncOrientation]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag.pointerId >= 0 && cubeRef.current?.hasPointerCapture(drag.pointerId)) {
      cubeRef.current.releasePointerCapture(drag.pointerId);
    }

    if (!drag.moved && drag.targetId) {
      const target = targetsById.get(drag.targetId);
      if (target) {
        commitSnap(target);
      }
    }

    dragRef.current = {
      active: false,
      moved: false,
      startX: 0,
      startY: 0,
      pointerId: -1,
      targetId: null,
    };
  }, [commitSnap, targetsById]);

  const cancelDrag = useCallback(() => {
    const drag = dragRef.current;
    if (drag.pointerId >= 0 && cubeRef.current?.hasPointerCapture(drag.pointerId)) {
      cubeRef.current.releasePointerCapture(drag.pointerId);
    }
    dragRef.current = {
      active: false,
      moved: false,
      startX: 0,
      startY: 0,
      pointerId: -1,
      targetId: null,
    };
  }, []);

  const handlePointerOver = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current.active) {
      return;
    }
    setHoveredTargetId(resolveTargetIdFromElement(event.target));
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!dragRef.current.active) {
      setHoveredTargetId(null);
    }
  }, []);

  return (
    <div className={cn("pointer-events-auto flex flex-col items-center select-none", className)} style={{ gap: 8 * scale }}>
      <div
        className={cn("pointer-events-auto relative", cubeClassName)}
        style={{ width: WIDGET * scale, height: WIDGET * scale }}
      >
        <OrbitRing
          hoveredArcId={hoveredArcId}
          setHoveredArcId={setHoveredArcId}
          onArcClick={orbitByArc}
          onHome={resetView}
          scale={scale}
        />

        <div
          style={{
            perspective: 320 * scale,
            width: CUBE * scale,
            height: CUBE * scale,
            position: "absolute",
            left: ((WIDGET - CUBE) / 2) * scale,
            top: ((WIDGET - CUBE) / 2) * scale,
          }}
        >
          <div
            style={{
              width: CUBE,
              height: CUBE,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <div
              ref={cubeRef}
              className="cursor-grab active:cursor-grabbing touch-none"
              style={{
                width: CUBE,
                height: CUBE,
                transformStyle: "preserve-3d",
                willChange: "transform",
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
              onPointerOver={handlePointerOver}
              onPointerLeave={handlePointerLeave}
            >
              {faces.map((face) => (
                <CubeFace
                  key={face.id}
                  transform={face.transform}
                  targets={face.targets}
                  hoveredTargetId={hoveredTargetId}
                  onPreviewTarget={setHoveredTargetId}
                  onCommitTarget={commitSnap}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div
        className={cn("relative pointer-events-none", axisClassName)}
        style={{ width: 58 * scale, height: 58 * scale, perspective: 180 * scale }}
      >
        <div
          ref={tripodRef}
          style={{
            width: 52,
            height: 52,
            transform: `scale(${scale})`,
            transformOrigin: "center",
            transformStyle: "preserve-3d",
            willChange: "transform",
          }}
        >
          <TripodArm color={axisX.color} label={axisX.text} rotation="rotateZ(-90deg)" fontSize={12} />
          <TripodArm color={axisY.color} label={axisY.text} rotation="rotateX(0deg)" fontSize={12} />
          <TripodArm color={axisZ.color} label={axisZ.text} rotation="rotateX(90deg)" fontSize={12} />
        </div>
      </div>
    </div>
  );
}
