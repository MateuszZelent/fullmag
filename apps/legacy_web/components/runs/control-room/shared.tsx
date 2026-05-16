"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { FemLiveMesh, FemMeshPart } from "@/lib/session/types";
import {
  resolveSelectedObjectIdFromModelBuilderGraph,
} from "../../../lib/session/modelBuilderGraph";
import type {
  ModelBuilderGraphV2,
  SceneDocument,
  ScriptBuilderGeometryEntry,
  StageExecutionState,
} from "../../../lib/session/types";
import type { TreeNodeData } from "../../panels/ModelTree";

export type ViewportMode = "3D" | "2D" | "Mesh" | "Analyze";
export type VectorComponent = "x" | "y" | "z" | "magnitude";
export type PreviewComponent = "3D" | "x" | "y" | "z";
export type SlicePlane = "xy" | "xz" | "yz";
export type FemDockTab = "mesh" | "mesher" | "view" | "quality" | "pipeline";

export interface AntennaOverlayConductor {
  id: string;
  label: string;
  role: "signal" | "ground" | "strip";
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  currentA: number;
}

export interface AntennaOverlay {
  id: string;
  name: string;
  antennaKind: string;
  solver: string;
  conductors: AntennaOverlayConductor[];
}

export interface BuilderObjectOverlay {
  id: string;
  label: string;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  fidelity: "mesh-backed" | "bounds-backed";
  source: "mesh_parts" | "object_segments" | "geometry_bounds";
}

export interface FocusObjectRequest {
  objectId: string;
  revision: number;
}

export type ObjectViewMode = "context" | "isolate";
export type ViewportScope = "universe" | `object:${string}`;

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
  bodyMainDefault: "72%",
  bodyMainMin: "20%",
  viewportDefault: "84%",
  viewportMin: "30%",
  consoleDefault: "12%",
  consoleMin: "4%",
  consoleMax: "32%",
  rightInspectorDefault: "24%",
  rightInspectorMin: "14%",
  rightInspectorMax: "46%",
  femDockDefault: "24%",
  femDockMin: "16%",
  femDockMax: "50%",
  femViewportDefault: "76%",
  femViewportMin: "26%",
  sidebarDefault: "24%",
  sidebarMin: "14%",
  sidebarMax: "38%",
} as const;

export const PREVIEW_EVERY_N_DEFAULT = 50;
export const PREVIEW_EVERY_N_PRESETS = [10, 25, 50, 100, 200, 500] as const;
export const PREVIEW_MAX_POINTS_DEFAULT = 16_384;
export const PREVIEW_MAX_POINTS_PRESETS = [4_096, 16_384, 65_536, 262_144, 1_048_576, 0] as const;

export {
  fmtSI,
  fmtExp,
  fmtStepValue,
  fmtSIOrDash,
  fmtExpOrDash,
  fmtDuration,
  fmtPreviewMaxPoints,
  fmtPreviewEveryN,
} from "../../../lib/format";

export function materializationProgressFromMessage(message: string | null): number {
  if (!message) return 6;
  const lower = message.toLowerCase();
  const gmshPercent = message.match(/\[\s*(\d{1,3})%\]/);
  if (gmshPercent) {
    const localPercent = Math.max(0, Math.min(100, Number(gmshPercent[1])));
    if (lower.includes("meshing curve") || lower.includes("meshing 1d")) {
      return 45 + localPercent * 0.08;
    }
    if (lower.includes("meshing surface") || lower.includes("meshing 2d")) {
      return 55 + localPercent * 0.12;
    }
    if (lower.includes("meshing volume") || lower.includes("meshing 3d")) {
      return 70 + localPercent * 0.2;
    }
  }
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
  if (lower.includes("tetrahedrizing")) return 92;
  if (lower.includes("reconstructing mesh")) return 93;
  if (lower.includes("refinement terminated")) return 94;
  if (lower.includes("optimizing mesh")) return 95;
  if (lower.includes("mesh ready") || lower.includes("fem mesh ready")) return 96;
  if (lower.includes("script materialized")) return 100;
  return 12;
}

export function parseStageExecutionMessage(
  message: string | null,
): { current: number; total: number; kind: string } | null {
  if (!message) return null;
  const matchOld = message.match(/executing stage (\d+)\/(\d+) \(([^)]+)\)/i);
  if (matchOld) {
    return {
      current: Number(matchOld[1]),
      total: Number(matchOld[2]),
      kind: matchOld[3],
    };
  }
  const matchNew = message.match(/solving\s+([^\s]+)\s*(?:—|-|–)\s*stage\s+(\d+)\/(\d+)/i);
  if (matchNew) {
    return {
      current: Number(matchNew[2]),
      total: Number(matchNew[3]),
      kind: matchNew[1],
    };
  }
  return null;
}

export function resolveStudyStageExecutionState(args: {
  stageExecution: StageExecutionState | null | undefined;
  totalStages: number;
  workspaceStatus: string;
  activityLabel?: string | null;
}) {
  const { stageExecution, totalStages, workspaceStatus, activityLabel = null } = args;
  const declaredTotal = Math.max(
    0,
    stageExecution?.total_stages && stageExecution.total_stages > 0
      ? stageExecution.total_stages
      : totalStages,
  );

  if (stageExecution && declaredTotal > 0) {
    const completed = Array.from(
      new Set(
        stageExecution.completed_stage_indexes.filter(
          (value) => Number.isFinite(value) && value >= 0 && value < declaredTotal,
        ),
      ),
    ).sort((lhs, rhs) => lhs - rhs);
    const activeStageIndex =
      stageExecution.active_stage_index != null &&
      stageExecution.active_stage_index >= 0 &&
      stageExecution.active_stage_index < declaredTotal
        ? stageExecution.active_stage_index
        : null;
    return {
      declaredTotal,
      activeStageIndex,
      completedStageIndexes: completed,
      stageStatuses: Array.from({ length: declaredTotal }, (_, index) => {
        const declared =
          stageExecution.stages[index]?.status ?? stageExecution.stage_statuses[index];
        if (typeof declared === "string" && declared.length > 0) return declared;
        if (activeStageIndex === index) return "running";
        return completed.includes(index) ? "completed" : "pending";
      }),
      stageRecords: Array.from({ length: declaredTotal }, (_, index) => {
        const record = stageExecution.stages[index];
        return record ?? null;
      }),
      activeStageKind: stageExecution.active_stage_kind,
      runtimeState: stageExecution.runtime_state,
      source: "contract" as const,
    };
  }

  const parsed = parseStageExecutionMessage(activityLabel);
  const completed = new Set<number>();
  let activeStageIndex: number | null = null;
  if (parsed && Number.isFinite(parsed.current) && parsed.current > 0) {
    activeStageIndex = Math.max(0, parsed.current - 1);
    for (let index = 0; index < activeStageIndex; index += 1) {
      completed.add(index);
    }
    if (
      (workspaceStatus === "completed" || workspaceStatus === "awaiting_command") &&
      activeStageIndex < declaredTotal
    ) {
      completed.add(activeStageIndex);
      activeStageIndex = null;
    }
  } else if (
    declaredTotal > 0 &&
    (workspaceStatus === "completed" || workspaceStatus === "awaiting_command")
  ) {
    for (let index = 0; index < declaredTotal; index += 1) {
      completed.add(index);
    }
  }
  return {
    declaredTotal,
    activeStageIndex,
    completedStageIndexes: Array.from(completed).sort((lhs, rhs) => lhs - rhs),
    stageStatuses: Array.from({ length: declaredTotal }, (_, index) => {
      if (activeStageIndex === index) return "running";
      return completed.has(index) ? "completed" : "pending";
    }),
    stageRecords: Array.from({ length: declaredTotal }, () => null),
    activeStageKind: parsed?.kind ?? null,
    runtimeState: workspaceStatus,
    source: "fallback" as const,
  };
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
  if (id.startsWith("res-qty-")) {
    try {
      const quantityId = decodeURIComponent(id.slice("res-qty-".length));
      return quantityId.length > 0 ? quantityId : null;
    } catch {
      return null;
    }
  }
  if (id === "antennas" || id.startsWith("ant-")) {
    return "H_ant";
  }
  if (id.startsWith("physics-module-")) {
    const moduleId = id.replace("physics-module-", "");
    if (moduleId.startsWith("demag")) return "H_demag";
    if (moduleId.startsWith("exchange")) return "H_ex";
    if (moduleId.startsWith("zeeman")) return "H_ext";
    if (moduleId.startsWith("interfacial_dmi") || moduleId.startsWith("bulk_dmi")) return "H_dmi";
    return null;
  }
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
    case "physics-solver":
      return "m";
    default:
      return null;
  }
}

export function resolveAntennaNodeName(
  nodeId: string | null | undefined,
  antennaNames: readonly string[],
): string | null {
  if (!nodeId || !nodeId.startsWith("ant-")) {
    return null;
  }
  const orderedNames = [...antennaNames].sort((left, right) => right.length - left.length);
  for (const name of orderedNames) {
    const prefix = `ant-${name}`;
    if (nodeId === prefix || nodeId.startsWith(`${prefix}-`)) {
      return name;
    }
  }
  return null;
}

function isFiniteVec3(value: [number, number, number] | null | undefined): value is [number, number, number] {
  return Boolean(
    value &&
      value.length === 3 &&
      value.every((component) => typeof component === "number" && Number.isFinite(component)),
  );
}

function normalizeBounds(
  boundsMin: [number, number, number] | null,
  boundsMax: [number, number, number] | null,
): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } | null {
  if (!isFiniteVec3(boundsMin) || !isFiniteVec3(boundsMax)) {
    return null;
  }
  const normalizedMin = boundsMin.map((component, index) =>
    Math.min(component, boundsMax[index]),
  ) as [number, number, number];
  const normalizedMax = boundsMin.map((component, index) =>
    Math.max(component, boundsMax[index]),
  ) as [number, number, number];
  if (normalizedMax.some((component, index) => component - normalizedMin[index] <= 0)) {
    return null;
  }
  return { boundsMin: normalizedMin, boundsMax: normalizedMax };
}

export function combineBounds(
  entries: readonly {
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
  }[],
): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } | null {
  if (entries.length === 0) {
    return null;
  }
  const first = normalizeBounds(entries[0]?.boundsMin ?? null, entries[0]?.boundsMax ?? null);
  if (!first) {
    return null;
  }
  let nextMin = [...first.boundsMin] as [number, number, number];
  let nextMax = [...first.boundsMax] as [number, number, number];
  for (const entry of entries.slice(1)) {
    const normalized = normalizeBounds(entry.boundsMin, entry.boundsMax);
    if (!normalized) {
      continue;
    }
    nextMin = nextMin.map((component, index) =>
      Math.min(component, normalized.boundsMin[index]),
    ) as [number, number, number];
    nextMax = nextMax.map((component, index) =>
      Math.max(component, normalized.boundsMax[index]),
    ) as [number, number, number];
  }
  return { boundsMin: nextMin, boundsMax: nextMax };
}

export function boundsExtent(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
): [number, number, number] {
  return boundsMin.map((component, index) => boundsMax[index] - component) as [
    number,
    number,
    number,
  ];
}

export function boundsCenter(
  boundsMin: [number, number, number],
  boundsMax: [number, number, number],
): [number, number, number] {
  return boundsMin.map((component, index) => 0.5 * (component + boundsMax[index])) as [
    number,
    number,
    number,
  ];
}

export function extractGeometryBoundsFromParams(
  geometry: ScriptBuilderGeometryEntry,
): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } | null {
  const params = geometry.geometry_params ?? {};
  const translateRaw = Array.isArray(params.translate)
    ? params.translate
    : Array.isArray(params.translation)
      ? params.translation
      : null;
  const translation = translateRaw && translateRaw.length === 3
    ? (translateRaw.map((value) => Number(value)) as [number, number, number])
    : null;
  let boundsMin: [number, number, number] | null = null;
  let boundsMax: [number, number, number] | null = null;
  if (geometry.geometry_kind === "Box" && Array.isArray(params.size) && params.size.length === 3) {
    const [sx, sy, sz] = params.size.map((value) => Number(value)) as [number, number, number];
    if ([sx, sy, sz].every((value) => Number.isFinite(value) && value > 0)) {
      boundsMin = [-0.5 * sx, -0.5 * sy, -0.5 * sz];
      boundsMax = [0.5 * sx, 0.5 * sy, 0.5 * sz];
    }
  } else if (geometry.geometry_kind === "Cylinder") {
    const radius = Number(params.radius);
    const height = Number(params.height);
    if (Number.isFinite(radius) && radius > 0 && Number.isFinite(height) && height > 0) {
      boundsMin = [-radius, -radius, -0.5 * height];
      boundsMax = [radius, radius, 0.5 * height];
    }
  } else if (geometry.geometry_kind === "ArchWaveguide") {
    const length = Number(params.length);
    const width = Number(params.width);
    const height = Number(params.height);
    const archHeight = Number(params.arch_height);
    const z0 = params.z0 == null ? 0 : Number(params.z0);
    if (
      [length, width, height].every((value) => Number.isFinite(value) && value > 0) &&
      Number.isFinite(archHeight) &&
      Number.isFinite(z0)
    ) {
      const halfLength = 0.5 * length;
      const halfWidth = 0.5 * width;
      const halfHeight = 0.5 * height;
      boundsMin = [-halfLength, -halfWidth, Math.min(z0, z0 + archHeight) - halfHeight];
      boundsMax = [halfLength, halfWidth, Math.max(z0, z0 + archHeight) + halfHeight];
    }
  } else if (geometry.geometry_kind === "Ellipsoid") {
    const rx = Number(params.rx);
    const ry = Number(params.ry);
    const rz = Number(params.rz);
    if ([rx, ry, rz].every((value) => Number.isFinite(value) && value > 0)) {
      boundsMin = [-rx, -ry, -rz];
      boundsMax = [rx, ry, rz];
    }
  } else if (geometry.geometry_kind === "Ellipse") {
    const rx = Number(params.rx);
    const ry = Number(params.ry);
    const height = Number(params.height);
    if ([rx, ry, height].every((value) => Number.isFinite(value) && value > 0)) {
      boundsMin = [-rx, -ry, -0.5 * height];
      boundsMax = [rx, ry, 0.5 * height];
    }
  }

  if (!boundsMin || !boundsMax) {
    const declaredMin = geometry.bounds_min ?? null;
    const declaredMax = geometry.bounds_max ?? null;
    const normalizedDeclared = normalizeBounds(declaredMin, declaredMax);
    if (!normalizedDeclared) {
      return null;
    }
    boundsMin = normalizedDeclared.boundsMin;
    boundsMax = normalizedDeclared.boundsMax;
  }

  if (translation && translation.every((value) => Number.isFinite(value))) {
    boundsMin = boundsMin.map((component, index) => component + translation[index]) as [number, number, number];
    boundsMax = boundsMax.map((component, index) => component + translation[index]) as [number, number, number];
  }

  return { boundsMin, boundsMax };
}

export function buildObjectOverlays(
  geometries: readonly ScriptBuilderGeometryEntry[],
  femMesh?: FemLiveMesh | null,
): BuilderObjectOverlay[] {
  const meshPartBoundsByObjectId = new Map<
    string,
    { boundsMin: [number, number, number]; boundsMax: [number, number, number] }
  >();
  const mergeBounds = (
    existing:
      | { boundsMin: [number, number, number]; boundsMax: [number, number, number] }
      | undefined,
    next: { boundsMin: [number, number, number]; boundsMax: [number, number, number] },
  ): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } => {
    if (!existing) {
      return next;
    }
    return {
      boundsMin: existing.boundsMin.map((component, axis) => Math.min(component, next.boundsMin[axis])) as [
        number,
        number,
        number,
      ],
      boundsMax: existing.boundsMax.map((component, axis) => Math.max(component, next.boundsMax[axis])) as [
        number,
        number,
        number,
      ],
    };
  };
  for (const part of femMesh?.mesh_parts ?? []) {
    if (part.role !== "magnetic_object" || !part.object_id) {
      continue;
    }
    const normalized = normalizeMeshPartBounds(part);
    if (!normalized) {
      continue;
    }
    meshPartBoundsByObjectId.set(
      part.object_id,
      mergeBounds(meshPartBoundsByObjectId.get(part.object_id), normalized),
    );
  }
  const segmentBoundsByObjectId = new Map<
    string,
    { boundsMin: [number, number, number]; boundsMax: [number, number, number] }
  >();
  for (const segment of femMesh?.object_segments ?? []) {
    if (segment.node_count <= 0) {
      continue;
    }
    let boundsMin: [number, number, number] | null = null;
    let boundsMax: [number, number, number] | null = null;
    for (let index = segment.node_start; index < segment.node_start + segment.node_count; index += 1) {
      const node = femMesh?.nodes[index];
      if (!node || node.length !== 3 || node.some((component) => !Number.isFinite(component))) {
        continue;
      }
      if (!boundsMin || !boundsMax) {
        boundsMin = [...node] as [number, number, number];
        boundsMax = [...node] as [number, number, number];
        continue;
      }
      boundsMin = boundsMin.map((component, axis) => Math.min(component, node[axis])) as [
        number,
        number,
        number,
      ];
      boundsMax = boundsMax.map((component, axis) => Math.max(component, node[axis])) as [
        number,
        number,
        number,
      ];
    }
    const normalized = normalizeBounds(boundsMin, boundsMax);
    if (!normalized) {
      continue;
    }
    segmentBoundsByObjectId.set(segment.object_id, normalized);
  }

  const overlays: BuilderObjectOverlay[] = [];
  for (const geometry of geometries) {
    const meshPartBounds = meshPartBoundsByObjectId.get(geometry.name);
    if (meshPartBounds) {
      overlays.push({
        id: geometry.name,
        label: geometry.name,
        boundsMin: meshPartBounds.boundsMin,
        boundsMax: meshPartBounds.boundsMax,
        fidelity: "mesh-backed",
        source: "mesh_parts",
      });
      continue;
    }
    const segmentBounds = segmentBoundsByObjectId.get(geometry.name);
    if (segmentBounds) {
      overlays.push({
        id: geometry.name,
        label: geometry.name,
        boundsMin: segmentBounds.boundsMin,
        boundsMax: segmentBounds.boundsMax,
        fidelity: "mesh-backed",
        source: "object_segments",
      });
      continue;
    }
    const bounds = extractGeometryBoundsFromParams(geometry);
    if (!bounds) {
      continue;
    }
    overlays.push({
      id: geometry.name,
      label: geometry.name,
      boundsMin: bounds.boundsMin,
      boundsMax: bounds.boundsMax,
      fidelity: "bounds-backed",
      source: "geometry_bounds",
    });
  }
  return overlays;
}

function normalizeMeshPartBounds(
  part: Pick<FemMeshPart, "bounds_min" | "bounds_max">,
): { boundsMin: [number, number, number]; boundsMax: [number, number, number] } | null {
  return normalizeBounds(part.bounds_min ?? null, part.bounds_max ?? null);
}

export function resolveSelectedObjectId(
  nodeId: string | null | undefined,
  source:
    | ModelBuilderGraphV2
    | SceneDocument
    | readonly ScriptBuilderGeometryEntry[]
    | null
    | undefined,
): string | null {
  if (!nodeId) {
    return null;
  }
  const sceneDocument =
    source &&
    !Array.isArray(source) &&
    "version" in source &&
    (source as SceneDocument).version === "scene.v1"
      ? (source as SceneDocument)
      : null;
  if (sceneDocument) {
    const ordered = [...sceneDocument.objects]
      .map((object) => object.name || object.id)
      .sort((left, right) => right.length - left.length);
    for (const name of ordered) {
      const objectPrefix = `obj-${name}`;
      const geoPrefix = `geo-${name}`;
      const regionPrefix = `reg-${name}`;
      const matPrefix = `mat-${name}`;
      const physPrefix = `physobj-${name}`;
      const magPrefix = `mag-${name}`;
      const meshPrefix = `${geoPrefix}-mesh`;
      if (
        nodeId === objectPrefix ||
        nodeId.startsWith(`${objectPrefix}-`) ||
        nodeId === geoPrefix ||
        nodeId.startsWith(`${geoPrefix}-`) ||
        nodeId === regionPrefix ||
        nodeId.startsWith(`${regionPrefix}-`) ||
        nodeId === matPrefix ||
        nodeId.startsWith(`${matPrefix}-`) ||
        nodeId === physPrefix ||
        nodeId.startsWith(`${physPrefix}-`) ||
        nodeId === magPrefix ||
        nodeId.startsWith(`${magPrefix}-`) ||
        nodeId === meshPrefix ||
        nodeId.startsWith(`${meshPrefix}-`)
      ) {
        return name;
      }
    }
    if ((nodeId === "geometry" || nodeId === "objects") && sceneDocument.objects.length === 1) {
      return sceneDocument.objects[0]?.name ?? sceneDocument.objects[0]?.id ?? null;
    }
    return null;
  }
  const modelBuilderGraph =
    source && !Array.isArray(source) ? (source as ModelBuilderGraphV2) : null;
  if (modelBuilderGraph) {
    return resolveSelectedObjectIdFromModelBuilderGraph(modelBuilderGraph, nodeId);
  }
  const geometries = Array.isArray(source) ? source : [];
  const ordered = [...geometries]
    .map((geometry) => geometry.name)
    .sort((left, right) => right.length - left.length);
  for (const name of ordered) {
    const objectPrefix = `obj-${name}`;
    const geoPrefix = `geo-${name}`;
    const regionPrefix = `reg-${name}`;
    const matPrefix = `mat-${name}`;
    const physPrefix = `physobj-${name}`;
    const magPrefix = `mag-${name}`;
    const meshPrefix = `${geoPrefix}-mesh`;
    if (
      nodeId === objectPrefix ||
      nodeId.startsWith(`${objectPrefix}-`) ||
      nodeId === geoPrefix ||
      nodeId.startsWith(`${geoPrefix}-`) ||
      nodeId === regionPrefix ||
      nodeId.startsWith(`${regionPrefix}-`) ||
      nodeId === matPrefix ||
      nodeId.startsWith(`${matPrefix}-`) ||
      nodeId === physPrefix ||
      nodeId.startsWith(`${physPrefix}-`) ||
      nodeId === magPrefix ||
      nodeId.startsWith(`${magPrefix}-`) ||
      nodeId === meshPrefix ||
      nodeId.startsWith(`${meshPrefix}-`)
    ) {
      return name;
    }
  }
  if ((nodeId === "geometry" || nodeId === "objects") && geometries.length === 1) {
    return geometries[0]?.name ?? null;
  }
  return null;
}

export function resolveViewportScope(
  nodeId: string | null | undefined,
  source:
    | ModelBuilderGraphV2
    | SceneDocument
    | readonly ScriptBuilderGeometryEntry[]
    | null
    | undefined,
): ViewportScope | null {
  if (!nodeId) {
    return null;
  }
  if (nodeId === "universe" || nodeId.startsWith("universe-")) {
    return "universe";
  }
  const objectId = resolveSelectedObjectId(nodeId, source);
  if (objectId) {
    return `object:${objectId}`;
  }
  return null;
}

export const EMPTY_SCALAR_ROWS: any[] = [];
export const EMPTY_ENGINE_LOG: any[] = [];

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
    <div className="border-b border-border/20 last:border-0">
      <div className="flex items-center gap-2 py-2 px-3 cursor-pointer select-none hover:bg-muted/30 transition-colors" onClick={() => setOpen((v) => !v)}>
        <span className="text-[0.6rem] text-muted-foreground transition-transform data-[open=true]:rotate-90" data-open={open}>▸</span>
        <span className="text-[0.6rem] font-medium uppercase tracking-wider text-foreground mr-auto">{title}</span>
        {badge && <span className="text-[0.6rem] font-mono text-muted-foreground/70 bg-muted/40 px-1.5 py-0.5 rounded">{badge}</span>}
      </div>
      {open && <div className="px-3 pb-3 grid gap-2">{children}</div>}
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
      className="appearance-none border border-border/30 bg-card/20 text-muted-foreground text-[0.6rem] font-medium uppercase tracking-wider rounded-md py-1.5 px-2 cursor-pointer transition-all hover:bg-muted/30 data-[active=true]:bg-primary/15 data-[active=true]:border-primary/40 data-[active=true]:text-primary"
      data-active={active}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}
