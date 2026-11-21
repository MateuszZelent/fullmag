import type { ReactNode } from "react";

import {
  canonicalPresetKind,
  type MagnetizationTexturePresetId,
} from "@/shared/domain/magnetization-texture/texturePresets";

function arrowPath(x0: number, y0: number, halfLen: number, angleDegPhys: number, head = 2.1): string {
  const rad = (-angleDegPhys * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const sx = x0 - dx * halfLen;
  const sy = y0 - dy * halfLen;
  const ex = x0 + dx * halfLen;
  const ey = y0 + dy * halfLen;
  const leftAng = rad + (145 * Math.PI) / 180;
  const rightAng = rad - (145 * Math.PI) / 180;
  const lx = ex + Math.cos(leftAng) * head;
  const ly = ey + Math.sin(leftAng) * head;
  const rx = ex + Math.cos(rightAng) * head;
  const ry = ey + Math.sin(rightAng) * head;
  const f = (n: number) => n.toFixed(2);
  return `M ${f(sx)} ${f(sy)} L ${f(ex)} ${f(ey)} M ${f(lx)} ${f(ly)} L ${f(ex)} ${f(ey)} L ${f(rx)} ${f(ry)}`;
}

function spinHueStroke(angleDegPhys: number): string {
  const hue = ((angleDegPhys % 360) + 360) % 360;
  return `hsl(${hue.toFixed(0)} 78% 48%)`;
}

function OutDot({ cx, cy, r = 3.2 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        fill="var(--fm-bg-panel-raised, currentColor)"
        fillOpacity={0.9}
        r={r}
        stroke="currentColor"
        strokeWidth={1.2}
      />
      <circle cx={cx} cy={cy} fill="currentColor" r={Math.max(0.9, r * 0.34)} />
    </g>
  );
}

function InCross({ cx, cy, r = 3.6 }: { cx: number; cy: number; r?: number }) {
  const d = r * 0.52;
  return (
    <g>
      <circle
        cx={cx}
        cy={cy}
        fill="currentColor"
        fillOpacity={0.18}
        r={r}
        stroke="currentColor"
        strokeWidth={1.25}
      />
      <path
        d={`M ${(cx - d).toFixed(2)} ${(cy - d).toFixed(2)} L ${(cx + d).toFixed(2)} ${(cy + d).toFixed(2)} M ${(cx - d).toFixed(2)} ${(cy + d).toFixed(2)} L ${(cx + d).toFixed(2)} ${(cy - d).toFixed(2)}`}
        stroke="currentColor"
        strokeWidth={1.25}
      />
    </g>
  );
}

const RANDOM_GRID: readonly { x: number; y: number; deg: number }[] = [
  { x: 8, y: 8, deg: 25 },
  { x: 18, y: 8, deg: 140 },
  { x: 28, y: 8, deg: -75 },
  { x: 8, y: 18, deg: -155 },
  { x: 18, y: 18, deg: 65 },
  { x: 28, y: 18, deg: -20 },
  { x: 8, y: 28, deg: 110 },
  { x: 18, y: 28, deg: -115 },
  { x: 28, y: 28, deg: 35 },
];

const RING_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export function PresetTileIcon({
  presetKind,
  size = 36,
}: {
  presetKind: MagnetizationTexturePresetId;
  size?: number;
}): ReactNode {
  const kind = canonicalPresetKind(presetKind);

  let body: ReactNode;
  switch (kind) {
    case "uniform":
      body = (
        <>
          <rect
            height={24}
            rx={4}
            stroke="currentColor"
            strokeDasharray="2.5 2"
            strokeOpacity={0.35}
            strokeWidth={1.1}
            width={30}
            x={3}
            y={6}
          />
          {[9, 18, 27].flatMap((x) =>
            [12, 24].map((y) => (
              <path
                key={`${x}-${y}`}
                d={arrowPath(x, y, 3.3, 0, 2.1)}
                stroke={spinHueStroke(0)}
                strokeWidth={1.65}
              />
            )),
          )}
        </>
      );
      break;

    case "random":
      body = (
        <>
          {RANDOM_GRID.map((item, idx) => (
            <path
              key={idx}
              d={arrowPath(item.x, item.y, 3.1, item.deg, 1.9)}
              stroke={spinHueStroke(item.deg)}
              strokeWidth={1.6}
            />
          ))}
        </>
      );
      break;

    case "vortex":
      body = (
        <>
          <circle cx={18} cy={18} r={11.5} stroke="currentColor" strokeOpacity={0.2} strokeWidth={1.1} />
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 11 * Math.cos(rad);
            const cy = 18 - 11 * Math.sin(rad);
            const psi = phi + 90;
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.7, psi, 1.8)}
                stroke={spinHueStroke(psi)}
                strokeWidth={1.55}
              />
            );
          })}
          <OutDot cx={18} cy={18} r={3.6} />
        </>
      );
      break;

    case "antivortex":
      body = (
        <>
          <path
            d="M 6 14 Q 18 18 14 6 M 30 22 Q 18 18 22 30"
            stroke="currentColor"
            strokeOpacity={0.26}
            strokeWidth={1.1}
          />
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 11 * Math.cos(rad);
            const cy = 18 - 11 * Math.sin(rad);
            const psi = -phi + 90;
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.7, psi, 1.8)}
                stroke={spinHueStroke(psi)}
                strokeWidth={1.55}
              />
            );
          })}
          <OutDot cx={18} cy={18} r={3.4} />
        </>
      );
      break;

    case "bloch_skyrmion":
      body = (
        <>
          <circle cx={18} cy={18} r={9.5} stroke="currentColor" strokeOpacity={0.22} strokeWidth={2.8} />
          {[
            [5.5, 5.5],
            [30.5, 5.5],
            [5.5, 30.5],
            [30.5, 30.5],
          ].map(([x, y], idx) => (
            <circle key={idx} cx={x} cy={y} fill="currentColor" fillOpacity={0.55} r={1.1} />
          ))}
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 9.8 * Math.cos(rad);
            const cy = 18 - 9.8 * Math.sin(rad);
            const psi = phi + 90;
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.5, psi, 1.7)}
                stroke={spinHueStroke(psi)}
                strokeWidth={1.55}
              />
            );
          })}
          <InCross cx={18} cy={18} r={4.0} />
        </>
      );
      break;

    case "neel_skyrmion":
      body = (
        <>
          <circle cx={18} cy={18} r={9.5} stroke="currentColor" strokeOpacity={0.2} strokeWidth={2.6} />
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 9.8 * Math.cos(rad);
            const cy = 18 - 9.8 * Math.sin(rad);
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.6, phi, 1.75)}
                stroke={spinHueStroke(phi)}
                strokeWidth={1.55}
              />
            );
          })}
          <InCross cx={18} cy={18} r={4.0} />
        </>
      );
      break;

    case "antiskyrmion":
      body = (
        <>
          <circle cx={18} cy={18} r={9.8} stroke="currentColor" strokeOpacity={0.18} strokeWidth={2.2} />
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 10 * Math.cos(rad);
            const cy = 18 - 10 * Math.sin(rad);
            const psi = -phi;
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.5, psi, 1.7)}
                stroke={spinHueStroke(psi)}
                strokeWidth={1.55}
              />
            );
          })}
          <InCross cx={18} cy={18} r={3.9} />
        </>
      );
      break;

    case "skyrmionium":
      body = (
        <>
          <circle cx={18} cy={18} r={7.2} stroke="currentColor" strokeOpacity={0.32} strokeWidth={3.0} />
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 11.4 * Math.cos(rad);
            const cy = 18 - 11.4 * Math.sin(rad);
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.1, phi, 1.5)}
                stroke={spinHueStroke(phi)}
                strokeWidth={1.45}
              />
            );
          })}
          <OutDot cx={18} cy={18} r={2.8} />
        </>
      );
      break;

    case "bimeron":
      body = (
        <>
          <path d={arrowPath(10, 7, 3.2, 0, 1.8)} stroke={spinHueStroke(0)} strokeWidth={1.5} />
          <path d={arrowPath(26, 7, 3.2, 0, 1.8)} stroke={spinHueStroke(0)} strokeWidth={1.5} />
          <path d={arrowPath(10, 29, 3.2, 0, 1.8)} stroke={spinHueStroke(0)} strokeWidth={1.5} />
          <path d={arrowPath(26, 29, 3.2, 0, 1.8)} stroke={spinHueStroke(0)} strokeWidth={1.5} />
          <OutDot cx={11.5} cy={18} r={3.6} />
          <path d={arrowPath(18, 18, 2.4, 180, 1.6)} stroke={spinHueStroke(180)} strokeWidth={1.6} />
          <InCross cx={24.5} cy={18} r={3.6} />
        </>
      );
      break;

    case "skyrmion_lattice":
      body = (
        <>
          {[0, 60, 120, 180, 240, 300].map((deg) => {
            const rad = (deg * Math.PI) / 180;
            const cx = 18 + 10.2 * Math.cos(rad);
            const cy = 18 - 10.2 * Math.sin(rad);
            return (
              <g key={deg}>
                <line
                  stroke="currentColor"
                  strokeOpacity={0.18}
                  strokeWidth={0.9}
                  x1={18}
                  x2={cx}
                  y1={18}
                  y2={cy}
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={3.2}
                  stroke="var(--fm-hue-material, currentColor)"
                  strokeWidth={1.5}
                />
                <circle cx={cx} cy={cy} fill="currentColor" r={1.2} />
              </g>
            );
          })}
          <circle
            cx={18}
            cy={18}
            r={3.5}
            stroke="var(--fm-hue-material, currentColor)"
            strokeWidth={1.6}
          />
          <circle cx={18} cy={18} fill="currentColor" r={1.3} />
        </>
      );
      break;

    case "domain_wall":
      body = (
        <>
          <rect
            fill="currentColor"
            fillOpacity={0.1}
            height={26}
            rx={2}
            width={10}
            x={13}
            y={5}
          />
          <path d={arrowPath(7, 12, 3.6, 90, 2.0)} stroke={spinHueStroke(90)} strokeWidth={1.65} />
          <path d={arrowPath(7, 24, 3.6, 90, 2.0)} stroke={spinHueStroke(90)} strokeWidth={1.65} />
          <path d={arrowPath(14, 18, 3.2, 45, 1.8)} stroke={spinHueStroke(45)} strokeWidth={1.55} />
          <path d={arrowPath(18, 18, 3.2, 0, 1.8)} stroke={spinHueStroke(0)} strokeWidth={1.65} />
          <path d={arrowPath(22, 18, 3.2, -45, 1.8)} stroke={spinHueStroke(315)} strokeWidth={1.55} />
          <path d={arrowPath(29, 12, 3.6, 270, 2.0)} stroke={spinHueStroke(270)} strokeWidth={1.65} />
          <path d={arrowPath(29, 24, 3.6, 270, 2.0)} stroke={spinHueStroke(270)} strokeWidth={1.65} />
        </>
      );
      break;

    case "two_domain":
      body = (
        <>
          <line
            stroke="currentColor"
            strokeDasharray="2.5 2"
            strokeOpacity={0.55}
            strokeWidth={1.3}
            x1={18}
            x2={18}
            y1={5}
            y2={31}
          />
          <path d={arrowPath(9.5, 12, 3.8, 0, 2.1)} stroke={spinHueStroke(0)} strokeWidth={1.7} />
          <path d={arrowPath(9.5, 24, 3.8, 0, 2.1)} stroke={spinHueStroke(0)} strokeWidth={1.7} />
          <path d={arrowPath(18, 18, 3.2, 90, 1.9)} stroke={spinHueStroke(90)} strokeWidth={1.55} />
          <path d={arrowPath(26.5, 12, 3.8, 180, 2.1)} stroke={spinHueStroke(180)} strokeWidth={1.7} />
          <path d={arrowPath(26.5, 24, 3.8, 180, 2.1)} stroke={spinHueStroke(180)} strokeWidth={1.7} />
        </>
      );
      break;

    case "vortex_wall":
      body = (
        <>
          <rect
            height={18}
            rx={3}
            stroke="currentColor"
            strokeOpacity={0.35}
            strokeWidth={1.15}
            width={30}
            x={3}
            y={9}
          />
          <path d={arrowPath(7.5, 18, 2.9, 0, 1.8)} stroke={spinHueStroke(0)} strokeWidth={1.6} />
          <path d={arrowPath(28.5, 18, 2.9, 180, 1.8)} stroke={spinHueStroke(180)} strokeWidth={1.6} />
          {[0, 90, 180, 270].map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 5.8 * Math.cos(rad);
            const cy = 18 - 5.8 * Math.sin(rad);
            const psi = phi - 90;
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.1, psi, 1.5)}
                stroke={spinHueStroke(psi)}
                strokeWidth={1.45}
              />
            );
          })}
          <OutDot cx={18} cy={18} r={2.3} />
        </>
      );
      break;

    case "artificial_spin_ice":
      body = (
        <>
          <rect height={6} rx={3} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.0} width={11} x={3} y={15} />
          <rect height={6} rx={3} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.0} width={11} x={22} y={15} />
          <rect height={11} rx={3} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.0} width={6} x={15} y={3} />
          <rect height={11} rx={3} stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.0} width={6} x={15} y={22} />
          <path d={arrowPath(8.5, 18, 3.2, 0, 1.9)} stroke={spinHueStroke(0)} strokeWidth={1.65} />
          <path d={arrowPath(27.5, 18, 3.2, 0, 1.9)} stroke={spinHueStroke(0)} strokeWidth={1.65} />
          <path d={arrowPath(18, 27.5, 3.2, 90, 1.9)} stroke={spinHueStroke(90)} strokeWidth={1.65} />
          <path d={arrowPath(18, 8.5, 3.2, 90, 1.9)} stroke={spinHueStroke(90)} strokeWidth={1.65} />
        </>
      );
      break;

    case "helical":
      body = (
        <>
          <path
            d={arrowPath(18, 29, 13, 0, 2.1)}
            stroke="currentColor"
            strokeOpacity={0.38}
            strokeWidth={1.15}
          />
          {[0, 1, 2, 3, 4, 5, 6].map((j) => {
            const x = 5 + j * 4.33;
            const phi = j * 60;
            return (
              <path
                key={j}
                d={arrowPath(x, 16, 4.2, phi, 1.8)}
                stroke={spinHueStroke(phi)}
                strokeWidth={1.55}
              />
            );
          })}
        </>
      );
      break;

    case "conical":
      body = (
        <>
          <line
            stroke="currentColor"
            strokeDasharray="2.5 2"
            strokeOpacity={0.38}
            strokeWidth={1.15}
            x1={4}
            x2={32}
            y1={18}
            y2={18}
          />
          {[
            { x: 9, phase: 60 },
            { x: 18, phase: 180 },
            { x: 27, phase: 300 },
          ].map(({ x, phase }) => (
            <g key={x}>
              <ellipse
                cx={x + 2}
                cy={18}
                rx={2.4}
                ry={7.0}
                stroke="currentColor"
                strokeOpacity={0.28}
                strokeWidth={1.1}
              />
              <path
                d={arrowPath(x, 18 - 3.2 * Math.sin((phase * Math.PI) / 180), 3.6, 35 * Math.sin((phase * Math.PI) / 180), 1.9)}
                stroke={spinHueStroke(phase)}
                strokeWidth={1.65}
              />
            </g>
          ))}
        </>
      );
      break;

    case "spiral":
      body = (
        <>
          <path
            d="M 18 18 C 20 16, 23 18, 22 21 C 21 25, 15 26, 12 22 C 8 17, 11 9, 18 8 C 26 7, 30 15, 28 24"
            stroke="currentColor"
            strokeOpacity={0.32}
            strokeWidth={1.3}
          />
          {[0, 72, 144, 216, 288].map((ang, idx) => {
            const r = 4.5 + idx * 1.9;
            const rad = (ang * Math.PI) / 180;
            const cx = 18 + r * Math.cos(rad);
            const cy = 18 - r * Math.sin(rad);
            return (
              <path
                key={ang}
                d={arrowPath(cx, cy, 2.5, ang + 70, 1.7)}
                stroke={spinHueStroke(ang)}
                strokeWidth={1.55}
              />
            );
          })}
        </>
      );
      break;

    case "hopfion":
      body = (
        <>
          <ellipse
            cx={18}
            cy={18}
            rx={12.5}
            ry={8.2}
            stroke="var(--fm-hue-material, currentColor)"
            strokeOpacity={0.55}
            strokeWidth={2.2}
          />
          <ellipse
            cx={18}
            cy={18}
            rx={5.5}
            ry={10.5}
            stroke={spinHueStroke(190)}
            strokeWidth={1.6}
            transform="rotate(32 18 18)"
          />
          <ellipse
            cx={18}
            cy={18}
            rx={5.5}
            ry={10.5}
            stroke={spinHueStroke(320)}
            strokeWidth={1.6}
            transform="rotate(-32 18 18)"
          />
        </>
      );
      break;

    case "hopfion_compact_support":
      body = (
        <>
          <ellipse
            cx={18}
            cy={18}
            rx={12.5}
            ry={8.0}
            stroke="currentColor"
            strokeDasharray="2.5 1.8"
            strokeOpacity={0.6}
            strokeWidth={1.3}
          />
          <ellipse
            cx={18}
            cy={18}
            rx={8.6}
            ry={4.8}
            stroke="var(--fm-hue-material, currentColor)"
            strokeWidth={2.4}
          />
          {[
            [5, 6],
            [31, 6],
            [5, 30],
            [31, 30],
          ].map(([x, y], idx) => (
            <circle key={idx} cx={x} cy={y} fill="currentColor" fillOpacity={0.65} r={1.15} />
          ))}
        </>
      );
      break;

    case "bloch_point":
      body = (
        <>
          <circle cx={18} cy={18} r={11} stroke="currentColor" strokeOpacity={0.2} strokeWidth={1.1} />
          <ellipse cx={18} cy={18} rx={11} ry={4} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.0} />
          {RING_ANGLES.map((phi) => {
            const rad = (phi * Math.PI) / 180;
            const cx = 18 + 8.5 * Math.cos(rad);
            const cy = 18 - 8.5 * Math.sin(rad);
            return (
              <path
                key={phi}
                d={arrowPath(cx, cy, 2.7, phi, 1.75)}
                stroke={spinHueStroke(phi)}
                strokeWidth={1.55}
              />
            );
          })}
          <circle cx={18} cy={18} fill="var(--fm-hue-material, currentColor)" r={2.3} />
        </>
      );
      break;
  }

  return (
    <svg
      aria-hidden="true"
      className="shrink-0 text-fm-primary"
      fill="none"
      height={size}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 36 36"
      width={size}
    >
      {body}
    </svg>
  );
}
