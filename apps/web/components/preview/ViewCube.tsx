"use client";

/**
 * ViewCube — professional 3ds Max-style 3D navigation widget.
 *
 * Layout:
 *   1. Cube widget: 3D cube surrounded by a draggable SVG orbit ring
 *      - 6 faces with labels (click → orthographic snap)
 *      - 12 edge strips (click → edge-aligned view)
 *      - 8 corner tabs (click → isometric view)
 *      - All zones highlight on hover with distinct colors
 *      - Orbit ring: 4 arc arrow buttons for constrained rotation
 *      - Home button in ring (top-right)
 *   2. Axis tripod gizmo (below cube widget, synchronized, never overlaps)
 */

import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import * as THREE from "three";
import type { TrackballControls } from "three/examples/jsm/controls/TrackballControls.js";
import { cn } from "@/lib/utils";
import { setCameraPresetAroundTarget } from "./camera/cameraHelpers";
import {
  sceneAxisDescriptor,
  type AxisConvention,
} from "./transform/axisConvention";

/* ────────────────────────── types ────────────────────────────────── */

type SceneHandle = {
  camera: THREE.Camera;
  controls: TrackballControls | {
    target: THREE.Vector3;
    update(): void;
    addEventListener?: (t: string, l: () => void) => void;
    removeEventListener?: (t: string, l: () => void) => void;
  };
};
type ChangeListenable = {
  addEventListener?: (t: string, l: () => void) => void;
  removeEventListener?: (t: string, l: () => void) => void;
};

export interface ViewCubeProps {
  sceneRef?: React.MutableRefObject<SceneHandle | null>;
  onRotate?: (q: THREE.Quaternion) => void;
  onReset?: () => void;
  axisConvention?: AxisConvention;
  className?: string;
  cubeClassName?: string;
  axisClassName?: string;
  embedded?: boolean;
}

type Dir3 = [number, number, number];
type ZoneKind = "face" | "edge" | "corner";
type Zone = { dir: Dir3; kind: ZoneKind; label?: string };

/* ────────────────────────── constants ─────────────────────────────── */

const CUBE = 62;
const HALF = CUBE / 2;
const RING_W = 11;
const RING_PAD = 12;
const WIDGET = CUBE + (RING_PAD + RING_W) * 2 + 4;

const EW = 9;
const CW = 9;
const FI = CUBE - EW * 2;

const FACE_T: Record<string, string> = {
  top:    `rotateX(90deg)  translateZ(${HALF}px)`,
  bottom: `rotateX(-90deg) translateZ(${HALF}px)`,
  right:  `rotateY(90deg)  translateZ(${HALF}px)`,
  left:   `rotateY(-90deg) translateZ(${HALF}px)`,
  front:  `translateZ(${HALF}px)`,
  back:   `rotateY(180deg) translateZ(${HALF}px)`,
};

const _m4  = new THREE.Matrix4();
const _sph = new THREE.Spherical();
const _va  = new THREE.Vector3();
const _vb  = new THREE.Vector3();

/* ────────────────────────── helpers ───────────────────────────────── */

const ds = (d: Dir3) => `${d[0]},${d[1]},${d[2]}`;

function pd(s: string | null | undefined): Dir3 | null {
  if (!s) return null;
  const p = s.split(",").map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? (p as Dir3) : null;
}

function add3(a: Dir3, b: Dir3, c?: Dir3): Dir3 {
  return [a[0]+b[0]+(c?.[0]??0), a[1]+b[1]+(c?.[1]??0), a[2]+b[2]+(c?.[2]??0)];
}
function neg3(a: Dir3): Dir3 { return [-a[0],-a[1],-a[2]]; }

function buildZones(n: Dir3, u: Dir3, r: Dir3, label: string): Zone[] {
  return [
    { dir: add3(n, u, neg3(r)), kind: "corner" },
    { dir: add3(n, u),          kind: "edge"   },
    { dir: add3(n, u, r),       kind: "corner" },
    { dir: add3(n, neg3(r)),    kind: "edge"   },
    { dir: n,                   kind: "face", label },
    { dir: add3(n, r),          kind: "edge"   },
    { dir: add3(n, neg3(u), neg3(r)), kind: "corner" },
    { dir: add3(n, neg3(u)),    kind: "edge"   },
    { dir: add3(n, neg3(u), r), kind: "corner" },
  ];
}

/* ────────────────────────── colors ────────────────────────────────── */

const C = {
  faceBg:        "linear-gradient(150deg,rgba(50,62,82,0.90) 0%,rgba(32,42,58,0.94) 45%,rgba(20,28,42,0.97) 100%)",
  faceEdge:      "rgba(120,140,165,0.30)",
  faceGlow:      "inset 0 1px 0 rgba(255,255,255,0.10),inset 0 -1px 0 rgba(0,0,0,0.24)",

  hFace:         "rgba(56,189,248,0.28)",
  hFaceBorder:   "rgba(56,189,248,0.60)",
  hEdge:         "rgba(34,211,238,0.32)",
  hEdgeBorder:   "rgba(34,211,238,0.65)",
  hCorner:       "rgba(251,191,36,0.30)",
  hCornerBorder: "rgba(251,191,36,0.65)",

  ringTrack:     "rgba(55,70,95,0.45)",
  ringHover:     "rgba(56,189,248,0.18)",
  ringBorder:    "rgba(90,108,134,0.45)",
  ringArrow:     "rgba(148,163,184,0.55)",
  ringArrowHov:  "rgba(186,230,253,0.92)",
};

/* ────────────────────────── CubeFace ──────────────────────────────── */

function CubeFace({
  transform, zones, hovDir, onLeave,
}: {
  transform: string;
  zones: Zone[];
  hovDir: string | null;
  onLeave: () => void;
}) {
  return (
    <div
      className="absolute"
      style={{
        width: CUBE, height: CUBE,
        transform,
        transformStyle: "preserve-3d",
        backfaceVisibility: "hidden",
      }}
      onPointerLeave={onLeave}
    >
      <div className="absolute inset-0 rounded-[4px]" style={{
        background: C.faceBg,
        border: `1px solid ${C.faceEdge}`,
        boxShadow: C.faceGlow,
      }} />
      <div className="absolute inset-0" style={{
        display: "grid",
        gridTemplateColumns: `${CW}px ${FI}px ${CW}px`,
        gridTemplateRows:    `${CW}px ${FI}px ${CW}px`,
      }}>
        {zones.map((z, i) => {
          const key = ds(z.dir);
          const hot = hovDir === key;
          const bg  = hot
            ? z.kind==="face"   ? C.hFace
            : z.kind==="edge"   ? C.hEdge
            : C.hCorner
            : "transparent";
          const bdr = hot
            ? z.kind==="face"   ? C.hFaceBorder
            : z.kind==="edge"   ? C.hEdgeBorder
            : C.hCornerBorder
            : "transparent";
          const br  = z.kind==="corner" ? 2 : z.kind==="edge" ? 1 : 3;
          return (
            <button
              key={i}
              data-vc={key}
              type="button"
              style={{
                background: bg, border: `1px solid ${bdr}`, borderRadius: br,
                padding: 0, margin: 0, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                outline: "none",
                transition: "background 70ms, border-color 70ms",
              }}
              title={z.label ?? ""}
            >
              {z.kind === "face" && z.label && (
                <span style={{
                  pointerEvents: "none", userSelect: "none",
                  fontSize: 9, fontWeight: 800, letterSpacing: "0.05em",
                  color: hot ? "#fff" : "rgba(203,213,225,0.82)",
                  textShadow: "0 1px 3px rgba(0,0,0,0.85)",
                  transition: "color 70ms",
                }}>
                  {z.label}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────── TripodArm ─────────────────────────────── */

function TripodArm({ color, label, rot }: { color: string; label: string; rot: string }) {
  const L = 17;
  return (
    <>
      <div style={{
        position: "absolute", width: 2, height: L,
        left: "50%", top: "50%", marginLeft: -1,
        transformOrigin: "top center",
        transform: `${rot} translateY(-${L/2}px)`,
        transformStyle: "preserve-3d",
        background: color, borderRadius: 1,
        boxShadow: `0 0 4px ${color}80`,
      }} />
      <div style={{
        position: "absolute", fontSize: 9, fontWeight: 800,
        left: "50%", top: "50%", marginLeft: -5, marginTop: -6,
        transformOrigin: "center",
        transform: `${rot} translateY(-${L+7}px)`,
        transformStyle: "preserve-3d",
        color, textShadow: "0 1px 3px rgba(0,0,0,0.7)",
        pointerEvents: "none",
      }}>
        {label}
      </div>
    </>
  );
}

/* ────────────────────────── OrbitRing (SVG) ───────────────────────── */

const SVG_S = WIDGET;
const R_OUT = SVG_S / 2 - 2;
const R_IN  = R_OUT - RING_W;
const CX = SVG_S / 2;
const CY = SVG_S / 2;

function donutArc(aStart: number, aEnd: number): string {
  const a0 = (aStart - 90) * Math.PI / 180;
  const a1 = (aEnd   - 90) * Math.PI / 180;
  const lg = (aEnd - aStart) > 180 ? 1 : 0;
  const x0o = CX + R_OUT*Math.cos(a0), y0o = CY + R_OUT*Math.sin(a0);
  const x1o = CX + R_OUT*Math.cos(a1), y1o = CY + R_OUT*Math.sin(a1);
  const x1i = CX + R_IN *Math.cos(a1), y1i = CY + R_IN *Math.sin(a1);
  const x0i = CX + R_IN *Math.cos(a0), y0i = CY + R_IN *Math.sin(a0);
  return `M${x0o},${y0o} A${R_OUT},${R_OUT},0,${lg},1,${x1o},${y1o} L${x1i},${y1i} A${R_IN},${R_IN},0,${lg},0,${x0i},${y0i} Z`;
}

function arrowTri(midAngle: number, sz = 4.5): string {
  const rm = (R_IN + R_OUT) / 2;
  const ma = (midAngle - 90) * Math.PI / 180;
  const cx = CX + rm * Math.cos(ma);
  const cy = CY + rm * Math.sin(ma);
  const pp = ma + Math.PI / 2;
  const ax = cx + sz * Math.cos(ma), ay = cy + sz * Math.sin(ma);
  const bx = cx - sz*0.55*Math.cos(ma) + sz*0.6*Math.cos(pp);
  const by = cy - sz*0.55*Math.sin(ma) + sz*0.6*Math.sin(pp);
  const dx = cx - sz*0.55*Math.cos(ma) - sz*0.6*Math.cos(pp);
  const dy = cy - sz*0.55*Math.sin(ma) - sz*0.6*Math.sin(pp);
  return `M${ax},${ay} L${bx},${by} L${dx},${dy} Z`;
}

const ARC_ZONES = [
  { id: "top",    aS: 325, aE:  35, dTheta:  0, dPhi: -1 },
  { id: "right",  aS:  55, aE: 125, dTheta:  1, dPhi:  0 },
  { id: "bottom", aS: 145, aE: 215, dTheta:  0, dPhi:  1 },
  { id: "left",   aS: 235, aE: 305, dTheta: -1, dPhi:  0 },
];

function OrbitRing({ hovArc, setHovArc, onArcClick, onHome }: {
  hovArc: string | null;
  setHovArc: (id: string | null) => void;
  onArcClick: (dt: number, dp: number) => void;
  onHome: () => void;
}) {
  const ha = (45 - 90) * Math.PI / 180;
  const hR = R_OUT - RING_W / 2;
  const hcx = CX + hR * Math.cos(ha);
  const hcy = CY + hR * Math.sin(ha);

  return (
    <svg width={SVG_S} height={SVG_S}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
      aria-hidden
    >
      {/* ring background track */}
      <circle cx={CX} cy={CY} r={(R_IN + R_OUT)/2}
        fill="none" strokeWidth={RING_W} stroke={C.ringTrack} />

      {/* arc zones */}
      {ARC_ZONES.map(z => (
        <g key={z.id}
          style={{ pointerEvents: "auto", cursor: "pointer" }}
          onMouseEnter={() => setHovArc(z.id)}
          onMouseLeave={() => setHovArc(null)}
          onClick={() => onArcClick(z.dTheta, z.dPhi)}
        >
          <path d={donutArc(z.aS, z.aE)}
            fill={hovArc===z.id ? C.ringHover : "transparent"}
            stroke={hovArc===z.id ? C.hEdgeBorder : "transparent"}
            strokeWidth={0.5}
            style={{ transition: "fill 70ms" }}
          />
          <path d={arrowTri((z.aS + z.aE) / 2)}
            fill={hovArc===z.id ? C.ringArrowHov : C.ringArrow}
            style={{ transition: "fill 70ms", pointerEvents: "none" }}
          />
        </g>
      ))}

      {/* ring borders */}
      <circle cx={CX} cy={CY} r={R_OUT} fill="none" stroke={C.ringBorder} strokeWidth={0.8} />
      <circle cx={CX} cy={CY} r={R_IN}  fill="none" stroke={C.ringBorder} strokeWidth={0.8} />

      {/* home button embedded in ring */}
      <g style={{ pointerEvents: "auto", cursor: "pointer" }} onClick={onHome}>
        <circle cx={hcx} cy={hcy} r={8}
          fill="rgba(25,35,52,0.92)"
          stroke="rgba(100,116,139,0.50)"
          strokeWidth={0.8}
        />
        <path
          transform={`translate(${hcx},${hcy})`}
          d="M0,-4 L4,0 L3,0 L3,3.5 L1,3.5 L1,1.5 L-1,1.5 L-1,3.5 L-3,3.5 L-3,0 L-4,0 Z"
          fill="rgba(186,230,253,0.80)"
        />
      </g>
    </svg>
  );
}

/* ────────────────────────── main component ─────────────────────────── */

export default function ViewCube({
  sceneRef,
  onRotate,
  onReset,
  axisConvention = "identity",
  className,
  cubeClassName,
  axisClassName,
}: ViewCubeProps & { className?: string }) {

  const ax = sceneAxisDescriptor(0, axisConvention);
  const ay = sceneAxisDescriptor(1, axisConvention);
  const az = sceneAxisDescriptor(2, axisConvention);

  const faces = useMemo(() => [
    { id: "top",    t: FACE_T.top,    zones: buildZones([0,1,0],  [0,0,1],  [1,0,0],  ay.text) },
    { id: "bottom", t: FACE_T.bottom, zones: buildZones([0,-1,0], [0,0,1],  [-1,0,0], `-${ay.text}`) },
    { id: "right",  t: FACE_T.right,  zones: buildZones([1,0,0],  [0,1,0],  [0,0,-1], ax.text) },
    { id: "left",   t: FACE_T.left,   zones: buildZones([-1,0,0], [0,1,0],  [0,0,1],  `-${ax.text}`) },
    { id: "front",  t: FACE_T.front,  zones: buildZones([0,0,1],  [0,1,0],  [1,0,0],  az.text) },
    { id: "back",   t: FACE_T.back,   zones: buildZones([0,0,-1], [0,1,0],  [-1,0,0], `-${az.text}`) },
  ], [ax.text, ay.text, az.text]);

  const cubeRef   = useRef<HTMLDivElement>(null);
  const tripodRef = useRef<HTMLDivElement>(null);
  const attached  = useRef<ChangeListenable | null>(null);
  const lastCss   = useRef("");
  const [hovDir, setHovDir] = useState<string | null>(null);
  const [hovArc, setHovArc] = useState<string | null>(null);

  const drag = useRef({ on: false, moved: false, sx: 0, sy: 0, pid: -1, zone: null as Dir3 | null });

  /* camera CSS */
  const cameraCSS = useCallback((): string => {
    const h = sceneRef?.current;
    if (!h) return "none";
    h.camera.updateMatrixWorld(true);
    _m4.copy(h.camera.matrixWorldInverse);
    _m4.elements[12] = _m4.elements[13] = _m4.elements[14] = 0;
    const e = _m4.elements;
    return `matrix3d(${e[0]},${e[1]},${e[2]},0,${e[4]},${e[5]},${e[6]},0,${e[8]},${e[9]},${e[10]},0,0,0,0,1)`;
  }, [sceneRef]);

  const sync = useCallback(() => {
    const css = cameraCSS();
    if (css === lastCss.current) return;
    lastCss.current = css;
    if (cubeRef.current)   cubeRef.current.style.transform   = css;
    if (tripodRef.current) tripodRef.current.style.transform = css;
  }, [cameraCSS]);

  useEffect(() => {
    let raf = 0;
    let dead = false;
    const ch = () => sync();
    const attachWhenReady = () => {
      if (dead) return;
      const controls = sceneRef?.current?.controls as ChangeListenable | undefined;
      if (controls && controls !== attached.current) {
        attached.current?.removeEventListener?.("change", ch);
        attached.current = controls;
        controls.addEventListener?.("change", ch);
      }
      sync();
      if (!controls) {
        raf = requestAnimationFrame(attachWhenReady);
      }
    };
    attachWhenReady();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      attached.current?.removeEventListener?.("change", ch);
      attached.current = null;
    };
  }, [sceneRef, sync]);

  const snapTo = useCallback((dir: Dir3) => {
    if (!onRotate) return;
    _va.set(dir[0], dir[1], dir[2]).normalize();
    onRotate(new THREE.Quaternion().setFromUnitVectors(_vb.set(0,0,1), _va));
  }, [onRotate]);

  const home = useCallback(() => {
    if (onReset) { onReset(); return; }
    const h = sceneRef?.current;
    if (h) {
      const dist = h.camera.position.clone().sub(h.controls.target).length() || 1;
      setCameraPresetAroundTarget(h.camera, h.controls, "reset", dist);
      sync();
      return;
    }
    onRotate?.(new THREE.Quaternion());
  }, [onRotate, onReset, sceneRef, sync]);

  const arcClick = useCallback((dt: number, dp: number) => {
    const h = sceneRef?.current;
    if (!h) return;
    _va.copy(h.camera.position).sub(h.controls.target);
    _sph.setFromVector3(_va);
    _sph.theta += dt * Math.PI * 0.25;
    _sph.phi   += dp * Math.PI * 0.15;
    _sph.phi = Math.max(0.05, Math.min(Math.PI - 0.05, _sph.phi));
    _va.setFromSpherical(_sph);
    h.camera.position.copy(h.controls.target).add(_va);
    h.camera.lookAt(h.controls.target);
    h.controls.update();
  }, [sceneRef]);

  const onDown = useCallback((e: React.PointerEvent) => {
    const el = (e.target as HTMLElement).closest("[data-vc]");
    drag.current = { on: true, moved: false, sx: e.clientX, sy: e.clientY, pid: e.pointerId, zone: pd(el?.getAttribute("data-vc")) };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    const h = sceneRef?.current;
    if (h) {
      _va.copy(h.camera.position).sub(h.controls.target);
      _sph.setFromVector3(_va);
      _sph.theta -= dx * 0.009;
      _sph.phi   -= dy * 0.009;
      _sph.phi = Math.max(0.02, Math.min(Math.PI - 0.02, _sph.phi));
      _va.setFromSpherical(_sph);
      h.camera.position.copy(h.controls.target).add(_va);
      h.camera.lookAt(h.controls.target);
      h.controls.update();
    }
    d.sx = e.clientX; d.sy = e.clientY;
  }, [sceneRef]);

  const onUp = useCallback(() => {
    const d = drag.current;
    if (d.pid >= 0 && cubeRef.current?.hasPointerCapture(d.pid))
      cubeRef.current.releasePointerCapture(d.pid);
    if (!d.moved && d.zone) snapTo(d.zone);
    d.on = false; d.pid = -1; d.zone = null;
  }, [snapTo]);

  const onOver = useCallback((e: React.PointerEvent) => {
    if (drag.current.on) return;
    const el = (e.target as HTMLElement).closest("[data-vc]");
    setHovDir(el?.getAttribute("data-vc") ?? null);
  }, []);

  const onLeave = useCallback(() => setHovDir(null), []);

  return (
    <div
      className={cn("flex flex-col items-center select-none", className)}
      style={{ gap: 5 }}
    >
      {/* ── cube + ring ── */}
      <div
        className={cn("relative", cubeClassName)}
        style={{ width: WIDGET, height: WIDGET }}
      >
        <OrbitRing
          hovArc={hovArc}
          setHovArc={setHovArc}
          onArcClick={arcClick}
          onHome={home}
        />

        {/* perspective wrapper */}
        <div style={{
          perspective: 320,
          width: CUBE, height: CUBE,
          position: "absolute",
          left: (WIDGET - CUBE) / 2,
          top:  (WIDGET - CUBE) / 2,
        }}>
          <div
            ref={cubeRef}
            className="cursor-grab active:cursor-grabbing touch-none"
            style={{
              width: CUBE, height: CUBE,
              transformStyle: "preserve-3d",
              willChange: "transform",
            }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
            onPointerOver={onOver}
          >
            {faces.map(f => (
              <CubeFace
                key={f.id}
                transform={f.t}
                zones={f.zones}
                hovDir={hovDir}
                onLeave={onLeave}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ── axis tripod (below cube widget, separate) ── */}
      <div
        className={cn("relative pointer-events-none", axisClassName)}
        style={{ width: 52, height: 52, perspective: 180 }}
      >
        <div
          ref={tripodRef}
          style={{
            width: 52, height: 52,
            transformStyle: "preserve-3d",
            willChange: "transform",
          }}
        >
          <TripodArm color={ax.color} label={ax.text} rot="rotateZ(-90deg)" />
          <TripodArm color={ay.color} label={ay.text} rot="rotateX(0deg)"   />
          <TripodArm color={az.color} label={az.text} rot="rotateX(90deg)"  />
        </div>
      </div>
    </div>
  );
}
