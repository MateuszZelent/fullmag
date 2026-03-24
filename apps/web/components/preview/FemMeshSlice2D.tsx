"use client";

import { useEffect, useMemo, useRef } from "react";
import type { FemMeshData } from "./FemMeshView3D";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";

interface Props {
  meshData: FemMeshData;
  quantityLabel: string;
  quantityId?: string;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  sliceCount?: number;
}

type Point3 = [number, number, number];
type Point2 = [number, number];

interface Segment2D {
  a: Point2;
  b: Point2;
  va: number;
  vb: number;
}

const BG = "#0c121f";
const BORDER = "#273753";
const TEXT = "#a7bad3";
const TEXT_STRONG = "#edf3fb";
const GRID = "rgba(120, 150, 185, 0.08)";
const EMPTY = "rgba(255,255,255,0.08)";
const DIVERGING = ["#15315f", "#2f6caa", "#90b9df", "#f4f1ed", "#efb09d", "#cf6256", "#7d1d34"];
const POSITIVE = ["#0a1220", "#143d67", "#1c6d8f", "#24a0a4", "#8ed6ac", "#f1f7bb"];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPoint(a: Point3, b: Point3, t: number): Point3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function toPoints(nodes: number[]): Point3[] {
  const points: Point3[] = [];
  for (let index = 0; index < nodes.length; index += 3) {
    points.push([nodes[index], nodes[index + 1], nodes[index + 2]]);
  }
  return points;
}

function nodeScalar(meshData: FemMeshData, nodeIndex: number, component: VectorComponent): number {
  const fld = meshData.fieldData;
  if (!fld) {
    return 0;
  }
  const fx = fld.x[nodeIndex] ?? 0;
  const fy = fld.y[nodeIndex] ?? 0;
  const fz = fld.z[nodeIndex] ?? 0;
  switch (component) {
    case "x":
      return fx;
    case "y":
      return fy;
    case "z":
      return fz;
    case "magnitude":
      return Math.sqrt(fx * fx + fy * fy + fz * fz);
  }
}

function axisIndices(plane: SlicePlane): { normal: 0 | 1 | 2; u: 0 | 1 | 2; v: 0 | 1 | 2 } {
  switch (plane) {
    case "xy":
      return { normal: 2, u: 0, v: 1 };
    case "xz":
      return { normal: 1, u: 0, v: 2 };
    case "yz":
      return { normal: 0, u: 1, v: 2 };
  }
}

function project(point: Point3, plane: SlicePlane): Point2 {
  const { u, v } = axisIndices(plane);
  return [point[u], point[v]];
}

function axisLabel(index: 0 | 1 | 2): string {
  return index === 0 ? "x" : index === 1 ? "y" : "z";
}

function paletteColor(t: number, palette: string[]): string {
  const n = palette.length - 1;
  const scaled = clamp(t, 0, 1) * n;
  const index = Math.min(Math.floor(scaled), n - 1);
  const frac = scaled - index;
  const a = palette[index];
  const b = palette[index + 1];
  if (frac <= 1e-6) {
    return a;
  }
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const mix = (x: number, y: number) => Math.round(lerp(x, y, frac));
  return `rgb(${mix(ar, br)}, ${mix(ag, bg)}, ${mix(ab, bb)})`;
}

function colorForValue(value: number, min: number, max: number, quantityId: string | undefined): string {
  const isMagnetization = !quantityId || quantityId === "m";
  if (isMagnetization && min === 0 && max === 1) {
    return paletteColor(value, POSITIVE);
  }
  const palette = min < 0 && max > 0 ? DIVERGING : POSITIVE;
  const t = max > min ? (value - min) / (max - min) : 0.5;
  return paletteColor(t, palette);
}

function uniquePoints(points: { point: Point3; value: number }[], epsilon: number) {
  const out: { point: Point3; value: number }[] = [];
  for (const candidate of points) {
    const exists = out.some(
      (entry) =>
        Math.abs(entry.point[0] - candidate.point[0]) <= epsilon &&
        Math.abs(entry.point[1] - candidate.point[1]) <= epsilon &&
        Math.abs(entry.point[2] - candidate.point[2]) <= epsilon,
    );
    if (!exists) {
      out.push(candidate);
    }
  }
  return out;
}

function collectSegments(
  meshData: FemMeshData,
  plane: SlicePlane,
  component: VectorComponent,
  sliceIndex: number,
  sliceCount: number,
) {
  const flatNodes = meshData.nodes;
  const flatFaces = meshData.boundaryFaces;
  const numNodes = flatNodes.length / 3;
  const numFaces = flatFaces.length / 3;

  const { normal, u, v } = axisIndices(plane);

  let minN = Number.POSITIVE_INFINITY;
  let maxN = Number.NEGATIVE_INFINITY;
  let uMin = Number.POSITIVE_INFINITY;
  let uMax = Number.NEGATIVE_INFINITY;
  let vMin = Number.POSITIVE_INFINITY;
  let vMax = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < numNodes; i++) {
    const pn = flatNodes[i * 3 + normal];
    const pu = flatNodes[i * 3 + u];
    const pv = flatNodes[i * 3 + v];
    if (pn < minN) minN = pn;
    if (pn > maxN) maxN = pn;
    if (pu < uMin) uMin = pu;
    if (pu > uMax) uMax = pu;
    if (pv < vMin) vMin = pv;
    if (pv > vMax) vMax = pv;
  }

  const planeCoord =
    sliceCount <= 1 || Math.abs(maxN - minN) <= 1e-18
      ? minN
      : lerp(minN, maxN, clamp(sliceIndex, 0, sliceCount - 1) / (sliceCount - 1));
  const epsilon = Math.max(((maxN - minN) / Math.max(sliceCount - 1, 1)) * 0.25, 1e-15);

  const segments: Segment2D[] = [];
  let valueMin = Number.POSITIVE_INFINITY;
  let valueMax = Number.NEGATIVE_INFINITY;

  const addSegment = (pa: Point3, pb: Point3, va: number, vb: number) => {
    valueMin = Math.min(valueMin, va, vb);
    valueMax = Math.max(valueMax, va, vb);
    segments.push({
      a: project(pa, plane),
      b: project(pb, plane),
      va,
      vb,
    });
  };

  const edges = [
    [0, 1],
    [1, 2],
    [2, 0],
  ] as const;

  for (let f = 0; f < numFaces; f++) {
    const ia = flatFaces[f * 3];
    const ib = flatFaces[f * 3 + 1];
    const ic = flatFaces[f * 3 + 2];

    const p: [Point3, Point3, Point3] = [
      [flatNodes[ia * 3], flatNodes[ia * 3 + 1], flatNodes[ia * 3 + 2]],
      [flatNodes[ib * 3], flatNodes[ib * 3 + 1], flatNodes[ib * 3 + 2]],
      [flatNodes[ic * 3], flatNodes[ic * 3 + 1], flatNodes[ic * 3 + 2]],
    ];

    const values = [
      nodeScalar(meshData, ia, component),
      nodeScalar(meshData, ib, component),
      nodeScalar(meshData, ic, component),
    ] as const;

    const signed = [
      p[0][normal] - planeCoord,
      p[1][normal] - planeCoord,
      p[2][normal] - planeCoord,
    ] as const;

    const near = [
      Math.abs(signed[0]) <= epsilon,
      Math.abs(signed[1]) <= epsilon,
      Math.abs(signed[2]) <= epsilon,
    ] as const;

    if (near[0] && near[1] && near[2]) {
      addSegment(p[0], p[1], values[0], values[1]);
      addSegment(p[1], p[2], values[1], values[2]);
      addSegment(p[2], p[0], values[2], values[0]);
      continue;
    }

    const intersections: { point: Point3; value: number }[] = [];

    for (const [a, b] of edges) {
      const da = signed[a];
      const db = signed[b];
      const va = values[a];
      const vb = values[b];

      if (Math.abs(da) <= epsilon && Math.abs(db) <= epsilon) {
        continue;
      }
      if (Math.abs(da) <= epsilon) {
        intersections.push({ point: p[a], value: va });
        continue;
      }
      if (Math.abs(db) <= epsilon) {
        intersections.push({ point: p[b], value: vb });
        continue;
      }
      if (da * db < 0) {
        const t = da / (da - db);
        intersections.push({
          point: lerpPoint(p[a], p[b], t),
          value: lerp(va, vb, t),
        });
      }
    }

    const unique = uniquePoints(intersections, epsilon);
    if (unique.length === 2) {
      addSegment(unique[0].point, unique[1].point, unique[0].value, unique[1].value);
    } else if (unique.length === 3) {
      unique.sort((lhs, rhs) => lhs.point[u] - rhs.point[u] || lhs.point[v] - rhs.point[v]);
      addSegment(unique[0].point, unique[1].point, unique[0].value, unique[1].value);
      addSegment(unique[1].point, unique[2].point, unique[1].value, unique[2].value);
    }
  }

  if (!Number.isFinite(valueMin)) {
    valueMin = 0;
    valueMax = 0;
  }

  const hasFieldData = !!meshData.fieldData;
  const effectiveRange =
    component === "magnitude"
      ? { min: 0, max: Math.max(1, valueMax) }
      : valueMin < 0 && valueMax > 0
        ? {
            min: -Math.max(Math.abs(valueMin), Math.abs(valueMax)),
            max: Math.max(Math.abs(valueMin), Math.abs(valueMax)),
          }
        : { min: valueMin, max: valueMax };

  return {
    planeCoord,
    normalLabel: axisLabel(normal),
    uLabel: axisLabel(u),
    vLabel: axisLabel(v),
    bounds: { uMin, uMax, vMin, vMax },
    segments,
    valueRange: hasFieldData ? effectiveRange : effectiveRange,
  };
}

export default function FemMeshSlice2D({
  meshData,
  quantityLabel,
  quantityId,
  component,
  plane,
  sliceIndex,
  sliceCount = 25,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const slice = useMemo(
    () => collectSegments(meshData, plane, component, sliceIndex, sliceCount),
    [meshData, plane, component, sliceIndex, sliceCount],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const width = canvas.clientWidth || 900;
    const height = canvas.clientHeight || 520;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    const margin = { left: 64, right: 22, top: 28, bottom: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const { uMin, uMax, vMin, vMax } = slice.bounds;
    const du = Math.max(uMax - uMin, 1e-18);
    const dv = Math.max(vMax - vMin, 1e-18);
    const scale = Math.min(innerW / du, innerH / dv);
    const ox = margin.left + (innerW - du * scale) * 0.5;
    const oy = margin.top + (innerH - dv * scale) * 0.5;

    const map = ([u, v]: Point2): Point2 => [
      ox + (u - uMin) * scale,
      oy + innerH - (v - vMin) * scale,
    ];

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, innerW, innerH);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (let index = 1; index < 5; index += 1) {
      const x = margin.left + (innerW * index) / 5;
      const y = margin.top + (innerH * index) / 5;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + innerH);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + innerW, y);
      ctx.stroke();
    }

    if (slice.segments.length === 0) {
      ctx.fillStyle = EMPTY;
      ctx.font = "600 14px IBM Plex Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No mesh intersection for this plane", width / 2, height / 2 - 8);
      ctx.fillStyle = TEXT;
      ctx.font = "12px IBM Plex Sans, sans-serif";
      ctx.fillText(
        `${slice.normalLabel} = ${slice.planeCoord.toExponential(3)} m`,
        width / 2,
        height / 2 + 18,
      );
    } else {
      const { min, max } = slice.valueRange;
      for (const segment of slice.segments) {
        const [x1, y1] = map(segment.a);
        const [x2, y2] = map(segment.b);
        const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
        gradient.addColorStop(0, colorForValue(segment.va, min, max, quantityId));
        gradient.addColorStop(1, colorForValue(segment.vb, min, max, quantityId));
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 2.35;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }

    ctx.fillStyle = TEXT;
    ctx.font = "12px IBM Plex Sans, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`${slice.uLabel} axis`, margin.left, height - 18);
    ctx.save();
    ctx.translate(18, margin.top + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${slice.vLabel} axis`, 0, 0);
    ctx.restore();

    ctx.fillStyle = TEXT_STRONG;
    ctx.font = "600 12px IBM Plex Mono, monospace";
    ctx.textAlign = "right";
    ctx.fillText(
      `${quantityLabel}.${component} | ${slice.normalLabel}=${slice.planeCoord.toExponential(3)} m | ${slice.segments.length} segments`,
      width - 16,
      18,
    );
  }, [component, plane, quantityId, quantityLabel, slice, sliceCount]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "360px",
        borderRadius: "8px",
        overflow: "hidden",
        background: BG,
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}
