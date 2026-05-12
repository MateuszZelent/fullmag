/**
 * Color / tint helpers for FEM mesh part display.
 * Extracted from FemMeshView3D.tsx.
 */

import * as THREE from "three";
import type { FemMeshPart } from "../../../lib/session/types";

const OBJECT_MESH_PALETTE = [
  "#e76f51",
  "#f4a261",
  "#e9c46a",
  "#90be6d",
  "#43aa8b",
  "#4d908e",
  "#577590",
  "#277da1",
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function colorToHex(color: THREE.Color): string {
  return `#${color.getHexString()}`;
}

export function partRoleTint(role: FemMeshPart["role"]): string {
  switch (role) {
    case "air":
      return "#67e8f9";
    case "interface":
      return "#f59e0b";
    case "outer_boundary":
      return "#c084fc";
    case "magnetic_object":
    default:
      return "#60a5fa";
  }
}

function objectTint(objectId: string): string {
  const hash = hashString(objectId);
  const color = new THREE.Color(OBJECT_MESH_PALETTE[hash % OBJECT_MESH_PALETTE.length]);
  const variant = Math.floor(hash / OBJECT_MESH_PALETTE.length) % 3;
  if (variant === 1) color.offsetHSL(0.018, 0.04, 0.045);
  else if (variant === 2) color.offsetHSL(-0.02, 0.02, -0.035);
  return colorToHex(color);
}

export function partMeshTint(part: FemMeshPart): string {
  if (part.role === "air") {
    return partRoleTint(part.role);
  }
  const color = new THREE.Color(
    part.object_id ? objectTint(part.object_id) : partRoleTint(part.role),
  );
  if (part.role === "interface") {
    color.lerp(new THREE.Color("#f59e0b"), 0.3);
  } else if (part.role === "outer_boundary") {
    color.lerp(new THREE.Color("#f8fafc"), 0.38);
  }
  return colorToHex(color);
}

export function partEdgeTint(
  part: FemMeshPart,
  isSelected: boolean,
  isDimmed: boolean,
): string {
  const color = new THREE.Color(partMeshTint(part));
  if (part.role === "air") {
    color.lerp(new THREE.Color("#e0f2fe"), 0.35);
  } else {
    color.lerp(new THREE.Color("#0f172a"), isDimmed ? 0.22 : 0.1);
  }
  if (isSelected) {
    color.lerp(new THREE.Color("#ffffff"), 0.55);
  }
  return colorToHex(color);
}

export function colorLegendGradient(field: string): string {
  switch (field) {
    case "x":
    case "y":
    case "z":
      return "linear-gradient(to right, #3b82f6, #f8fafc, #ef4444)";
    case "magnitude":
      return "linear-gradient(to right, #0f172a, #2563eb, #7dd3fc, #f8fafc)";
    case "quality":
    case "sicn":
      return "linear-gradient(to right, #f97316, #facc15, #22c55e)";
    case "orientation":
      return "linear-gradient(to right, #ef4444, #f59e0b, #22c55e, #06b6d4, #8b5cf6)";
    case "none":
    default:
      return "linear-gradient(to right, #334155, #64748b)";
  }
}

export function colorLegendLabel(field: string, fieldLabel?: string): string {
  switch (field) {
    case "orientation":
      return fieldLabel ? `${fieldLabel} orientation` : "orientation";
    case "x":
      return `${fieldLabel ?? "field"} x-component`;
    case "y":
      return `${fieldLabel ?? "field"} y-component`;
    case "z":
      return `${fieldLabel ?? "field"} z-component`;
    case "magnitude":
      return `${fieldLabel ?? "field"} magnitude`;
    case "quality":
      return "face aspect ratio";
    case "sicn":
      return "surface inverse condition number";
    case "none":
    default:
      return "object / part tint";
  }
}
