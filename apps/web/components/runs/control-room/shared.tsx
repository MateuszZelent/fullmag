"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { FemLiveMesh } from "../../../lib/useSessionStream";
import type { TreeNodeData } from "../../panels/ModelTree";
import s from "../RunControlRoom.module.css";

export type ViewportMode = "3D" | "2D" | "Mesh";
export type VectorComponent = "x" | "y" | "z" | "magnitude";
export type PreviewComponent = "3D" | "x" | "y" | "z";
export type SlicePlane = "xy" | "xz" | "yz";
export type FemDockTab = "mesh" | "mesher" | "view" | "quality";

export interface MeshFaceDetail {
  faceIndex: number;
  nodeIndices: [number, number, number];
  centroid: [number, number, number];
  normal: [number, number, number];
  edgeLengths: [number, number, number];
  perimeter: number;
  area: number;
  aspectRatio: number;
}

export const FEM_SLICE_COUNT = 25;
export const PANEL_SIZES = {
  bodyMainDefault: "78%",
  bodyMainMin: "34%",
  viewportDefault: "72%",
  viewportMin: "24%",
  consoleDefault: "28%",
  consoleMin: "10%",
  consoleMax: "72%",
  femDockDefault: "24%",
  femDockMin: "16%",
  femDockMax: "50%",
  femViewportDefault: "76%",
  femViewportMin: "26%",
  sidebarDefault: "22%",
  sidebarMin: "14%",
  sidebarMax: "50%",
} as const;

export const SCALAR_FIELDS: Record<string, string> = {
  E_ex: "e_ex",
  E_demag: "e_demag",
  E_ext: "e_ext",
  E_total: "e_total",
};

export const PREVIEW_EVERY_N_DEFAULT = 10;
export const PREVIEW_EVERY_N_PRESETS = [1, 2, 5, 10, 25, 50, 100] as const;
export const PREVIEW_MAX_POINTS_DEFAULT = 16_384;
export const PREVIEW_MAX_POINTS_PRESETS = [4_096, 16_384, 65_536, 262_144, 1_048_576, 0] as const;

export function fmtSI(v: number, unit: string): string {
  if (!Number.isFinite(v) || v === 0) return `0 ${unit}`;
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toPrecision(3)} T${unit}`;
  if (abs >= 1e9) return `${(v / 1e9).toPrecision(3)} G${unit}`;
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(3)} M${unit}`;
  if (abs >= 1e3) return `${(v / 1e3).toPrecision(3)} k${unit}`;
  if (abs >= 1) return `${v.toPrecision(3)} ${unit}`;
  if (abs >= 1e-3) return `${(v * 1e3).toPrecision(3)} m${unit}`;
  if (abs >= 1e-6) return `${(v * 1e6).toPrecision(3)} µ${unit}`;
  if (abs >= 1e-9) return `${(v * 1e9).toPrecision(3)} n${unit}`;
  if (abs >= 1e-12) return `${(v * 1e12).toPrecision(3)} p${unit}`;
  return `${v.toExponential(2)} ${unit}`;
}

export function fmtExp(v: number): string {
  if (!Number.isFinite(v) || v === 0) return "0";
  return v.toExponential(3);
}

export function fmtStepValue(v: number, enabled: boolean): string {
  return enabled ? v.toLocaleString() : "—";
}

export function fmtSIOrDash(v: number, unit: string, enabled: boolean): string {
  return enabled ? fmtSI(v, unit) : "—";
}

export function fmtExpOrDash(v: number, enabled: boolean): string {
  return enabled ? fmtExp(v) : "—";
}

export function fmtPreviewMaxPoints(value: number): string {
  if (value <= 0) return "Full";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return value.toLocaleString();
}

export function materializationProgressFromMessage(message: string | null): number {
  if (!message) return 6;
  const lower = message.toLowerCase();
  if (lower.includes("control room bootstrap verified")) return 8;
  if (lower.includes("loading python script")) return 14;
  if (lower.includes("building problemir")) return 22;
  if (lower.includes("preparing fem mesh asset")) return 32;
  if (lower.includes("generating fem mesh from geometry")) return 44;
  if (lower.includes("meshing stl surface")) return 52;
  if (lower.includes("importing stl surface")) return 60;
  if (lower.includes("classifying stl surfaces")) return 70;
  if (lower.includes("creating geometry from classified surfaces")) return 80;
  if (lower.includes("generating 3d tetrahedral mesh")) return 90;
  if (lower.includes("mesh ready") || lower.includes("fem mesh ready")) return 96;
  if (lower.includes("script materialized")) return 100;
  return 12;
}

export function parseStageExecutionMessage(
  message: string | null,
): { current: number; total: number; kind: string } | null {
  if (!message) return null;
  const match = message.match(/executing stage (\d+)\/(\d+) \(([^)]+)\)/i);
  if (!match) return null;
  return {
    current: Number(match[1]),
    total: Number(match[2]),
    kind: match[3],
  };
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)} min`;
  return `${(ms / 3600000).toFixed(2)} h`;
}

export function fmtPreviewEveryN(n: number): string {
  return n <= 1 ? "Every step" : `Every ${n} steps`;
}

export function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function asVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if ([x, y, z].some((component) => typeof component !== "number")) return null;
  return [x as number, y as number, z as number];
}

export function computeMeshFaceDetail(
  mesh: FemLiveMesh | null,
  faceIndex: number | null,
): MeshFaceDetail | null {
  if (!mesh || faceIndex == null || faceIndex < 0 || faceIndex >= mesh.boundary_faces.length) {
    return null;
  }

  const face = mesh.boundary_faces[faceIndex];
  if (!face) return null;
  const [ia, ib, ic] = face;
  const a = mesh.nodes[ia];
  const b = mesh.nodes[ib];
  const c = mesh.nodes[ic];
  if (!a || !b || !c) return null;

  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const bcx = c[0] - b[0];
  const bcy = c[1] - b[1];
  const bcz = c[2] - b[2];
  const cax = a[0] - c[0];
  const cay = a[1] - c[1];
  const caz = a[2] - c[2];

  const ab = Math.hypot(abx, aby, abz);
  const bc = Math.hypot(bcx, bcy, bcz);
  const ca = Math.hypot(cax, cay, caz);
  const perimeter = ab + bc + ca;
  const halfPerimeter = perimeter / 2;

  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  const acz = c[2] - a[2];
  const crossX = aby * acz - abz * acy;
  const crossY = abz * acx - abx * acz;
  const crossZ = abx * acy - aby * acx;
  const crossNorm = Math.hypot(crossX, crossY, crossZ);
  const area = 0.5 * crossNorm;
  const normal: [number, number, number] =
    crossNorm > 1e-30
      ? [crossX / crossNorm, crossY / crossNorm, crossZ / crossNorm]
      : [0, 0, 0];

  const maxEdge = Math.max(ab, bc, ca);
  const inradius = halfPerimeter > 0 ? area / halfPerimeter : 0;
  const aspectRatio = inradius > 1e-18 ? maxEdge / (2 * inradius) : 1;

  return {
    faceIndex,
    nodeIndices: [ia, ib, ic],
    centroid: [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ],
    normal,
    edgeLengths: [ab, bc, ca],
    perimeter,
    area,
    aspectRatio,
  };
}

export function findTreeNodeById(nodes: TreeNodeData[], id: string | null): TreeNodeData | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findTreeNodeById(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}

export function previewQuantityForTreeNode(id: string): string | null {
  switch (id) {
    case "phys-llg":
      return "m";
    case "phys-exchange":
      return "H_ex";
    case "phys-demag":
    case "phys-demag-method":
    case "phys-demag-open-bc":
      return "H_demag";
    case "phys-zeeman":
      return "H_ext";
    default:
      return null;
  }
}

export function Section({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={s.section}>
      <div className={s.sectionHeader} onClick={() => setOpen((v) => !v)}>
        <span className={s.sectionChevron} data-open={open}>▸</span>
        <span className={s.sectionTitle}>{title}</span>
        {badge && <span className={s.sectionBadge}>{badge}</span>}
      </div>
      {open && <div className={s.sectionBody}>{children}</div>}
    </div>
  );
}

export function DockTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={s.meshDockTab}
      data-active={active}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
