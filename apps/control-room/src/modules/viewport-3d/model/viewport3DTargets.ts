import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import {
  visualizationTargetIdForSceneObject,
  type Selection,
} from "@/kernel/selection/selectionTypes";
import { resolveVisualizationTargetForMeshPart } from "@/kernel/selection/visualizationTargetResolver";
import {
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  resolveMeshPartBounds,
  type FdmGridRenderDomain,
  type FemManifestRenderDomain,
  type Viewport3DMeshPart,
} from "../viewport3dDomainAdapter";
import type { Viewport3DBounds } from "../viewport3dRenderModel";

export const FULL_FIELD_QUERY: FieldVectorQuery = {
  component: "full",
  scope_kind: "full",
};

export interface HysteresisStepViewportTarget {
  targetId: string;
  stageId: string;
  pointId: number;
  snapshotId: string;
  resourceRef: string | null;
  quantityId: string;
  meshIdentity: string | null;
  fieldOrientation: string | null;
  measurementAxis: string | null;
  fieldRevision: string | number | null;
}

type HysteresisReplayMeshCompatibilityStatus =
  | "compatible"
  | "mismatch"
  | "unknown";

export interface HysteresisReplayMeshCompatibility {
  actualMeshIdentity: string | null;
  reason: string | null;
  requiredMeshIdentity: string | null;
  status: HysteresisReplayMeshCompatibilityStatus;
}

export interface HysteresisReplayGlyphAxis {
  label: string;
  source: string;
  vector: [number, number, number];
}

export interface HysteresisReplayGlyphModel {
  fieldDirection: HysteresisReplayGlyphAxis | null;
  measurementAxis: HysteresisReplayGlyphAxis | null;
  pointId: number;
  sampleNormal: HysteresisReplayGlyphAxis | null;
  stageId: string;
  targetId: string;
}

export function targetForFdmDomain(
  domainId: string | null | undefined,
): VisualizationTargetRef | null {
  if (!domainId) return null;
  return {
    id: "fdm-domain",
    kind: "fdm-domain",
    label: domainId,
  };
}

/**
 * FDM grid metadata used by selection focus.  The optional fingerprint is
 * supplied only when the current membership resource proves the grid
 * identity; a cell selection must fail closed when it is unavailable.
 */
export interface FdmSelectionGrid extends FdmGridRenderDomain {
  gridFingerprint?: string | null;
}

export function targetForMeshPart(
  part: Viewport3DMeshPart,
  sceneObjectIds: ReadonlySet<string> = new Set(),
): VisualizationTargetRef {
  return resolveVisualizationTargetForMeshPart({
    part,
    sceneObjectIds,
    targetRegistry: null,
  });
}

export function resolveHysteresisStepViewportTarget(
  selection: Selection,
): HysteresisStepViewportTarget | null {
  const ref = selection.ref;
  if (ref?.type === "hysteresis-snapshot") {
    return {
      targetId: ref.targetId,
      stageId: ref.stageId,
      pointId: ref.pointId,
      snapshotId: ref.snapshotId,
      resourceRef: ref.resourceRef ?? null,
      quantityId: ref.quantityId,
      meshIdentity: ref.meshIdentity ?? null,
      fieldOrientation: ref.fieldOrientation ?? null,
      measurementAxis: ref.measurementAxis ?? null,
      fieldRevision: ref.fieldRevision ?? null,
    };
  }
  if (
    ref?.type !== "analysis-chart-point" ||
    ref.targetKind !== "hysteresis-step" ||
    !ref.targetId ||
    !ref.stageId ||
    ref.pointId == null ||
    !ref.snapshotId
  ) {
    return null;
  }

  return {
    targetId: ref.targetId,
    stageId: ref.stageId,
    pointId: ref.pointId,
    snapshotId: ref.snapshotId,
    resourceRef: ref.resourceRef ?? null,
    quantityId: ref.quantityId ?? ref.quantity,
    meshIdentity: ref.meshIdentity ?? null,
    fieldOrientation: ref.fieldOrientation ?? null,
    measurementAxis: ref.measurementAxis ?? null,
    fieldRevision: ref.fieldRevision ?? null,
  };
}

export function resolveHysteresisReplayMeshCompatibility(
  target: HysteresisStepViewportTarget | null,
  currentTopology: {
    meshGenerationId?: string | null;
    meshRevision?: number | string | null;
  } | null | undefined,
): HysteresisReplayMeshCompatibility {
  const requiredMeshIdentity = normalizeMeshIdentity(target?.meshIdentity);
  const actualMeshIdentity = normalizeMeshIdentity(
    currentTopology?.meshGenerationId ?? currentTopology?.meshRevision ?? null,
  );

  if (!target) {
    return {
      actualMeshIdentity,
      reason: "No hysteresis replay target is selected.",
      requiredMeshIdentity,
      status: "unknown",
    };
  }
  if (!requiredMeshIdentity) {
    return {
      actualMeshIdentity,
      reason: "Snapshot mesh identity is unavailable.",
      requiredMeshIdentity,
      status: "unknown",
    };
  }
  if (!actualMeshIdentity) {
    return {
      actualMeshIdentity,
      reason: "Current 3D topology mesh identity is unavailable.",
      requiredMeshIdentity,
      status: "unknown",
    };
  }
  if (requiredMeshIdentity !== actualMeshIdentity) {
    return {
      actualMeshIdentity,
      reason: `Snapshot was computed on mesh ${requiredMeshIdentity}, but the current 3D topology is ${actualMeshIdentity}.`,
      requiredMeshIdentity,
      status: "mismatch",
    };
  }
  return {
    actualMeshIdentity,
    reason: null,
    requiredMeshIdentity,
    status: "compatible",
  };
}

export function buildHysteresisReplayGlyphModel(
  target: HysteresisStepViewportTarget | null,
): HysteresisReplayGlyphModel | null {
  if (!target) return null;
  return {
    fieldDirection: parseHysteresisReplayGlyphAxis(
      target.fieldOrientation,
      "H field",
    ),
    measurementAxis: parseHysteresisReplayGlyphAxis(
      target.measurementAxis,
      "Measurement axis",
    ),
    pointId: target.pointId,
    sampleNormal: {
      label: "Sample normal",
      source: "derived_oop",
      vector: [0, 0, 1],
    },
    stageId: target.stageId,
    targetId: target.targetId,
  };
}

function parseHysteresisReplayGlyphAxis(
  encoded: string | null,
  label: string,
): HysteresisReplayGlyphAxis | null {
  if (!encoded) return null;
  const parsed = parseJsonRecord(encoded);
  const preset = typeof parsed?.preset_name === "string"
    ? parsed.preset_name
    : typeof parsed?.preset === "string"
      ? parsed.preset
      : typeof parsed?.kind === "string" && parsed.kind !== "custom"
        ? parsed.kind
        : null;
  const presetVector = vectorForHysteresisPreset(preset);
  if (presetVector) {
    return {
      label,
      source: preset ?? "preset",
      vector: presetVector,
    };
  }
  const vector = normalizeVector3(parsed?.vector);
  if (!vector) return null;
  return {
    label,
    source: "custom",
    vector,
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function vectorForHysteresisPreset(
  preset: string | null,
): [number, number, number] | null {
  switch (preset) {
    case "oop":
    case "out_of_plane":
    case "out_of_plane_z":
      return [0, 0, 1];
    case "in_plane_x":
    case "ip_x":
      return [1, 0, 0];
    case "in_plane_y":
    case "ip_y":
      return [0, 1, 0];
    default:
      return null;
  }
}

function normalizeVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const vector = value.map((component) =>
    typeof component === "number" ? component : Number.NaN,
  );
  if (!vector.every(Number.isFinite)) return null;
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length <= 0) return null;
  return [
    vector[0] / length,
    vector[1] / length,
    vector[2] / length,
  ];
}

function normalizeMeshIdentity(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function resolveViewport3DSelectionBounds(
  selection: Selection,
  domain: FemManifestRenderDomain,
  fallbackBounds: Viewport3DBounds | null,
  fdmGrid: FdmSelectionGrid | null = null,
): Viewport3DBounds | null {
  if (!selection.kind) return null;

  if (isFdmSelection(selection, fdmGrid)) {
    return resolveFdmSelectionBounds(selection, fdmGrid);
  }

  return (
    resolveMeshQualityElementBounds(selection, fallbackBounds) ??
    resolveMeshPartBounds(
      selection.nodeId ? domain.partsById.get(selection.nodeId) : null,
    ) ??
    resolveObjectBounds(domain, selection.objectId) ??
    (selection.kind === "airbox.visualization" ||
    selection.kind === "mesh-part-airbox"
      ? resolveAirboxBounds(domain)
      : fallbackBounds)
  );
}

const FDM_GRID_SELECTION_KINDS = new Set([
  "mesh.grid",
  "mesh.grid.descriptor",
  "mesh.grid.magnetic-support",
  "mesh.grid.active-unassigned",
  "mesh.grid.mask",
  "mesh.grid.provenance",
  "mesh.grid.region",
  "mesh.grid.universe-outside-support",
]);

function isFdmSelection(
  selection: Selection,
  fdmGrid: FdmSelectionGrid | null,
): boolean {
  return Boolean(
      selection.ref?.type === "fdm-domain" ||
      selection.ref?.type === "fdm-cell" ||
      selection.kind === "fdm.cell" ||
      (selection.kind !== null &&
        FDM_GRID_SELECTION_KINDS.has(selection.kind)) ||
      (selection.kind === "universe.root" && fdmGrid),
  );
}

function resolveFdmSelectionBounds(
  selection: Selection,
  fdmGrid: FdmSelectionGrid | null,
): Viewport3DBounds | null {
  if (!fdmGrid) return null;
  if (selection.ref?.type === "fdm-cell") {
    return resolveFdmCellBounds(selection.ref, fdmGrid);
  }

  // A grid node, including the optional universe-outside-support summary,
  // focuses the canonical structured extent. It never consults FEM parts.
  return resolveFdmGridBounds(fdmGrid);
}

export function resolveFdmGridBounds(
  grid: Pick<FdmSelectionGrid, "bounds" | "origin" | "shape" | "spacing">,
): Viewport3DBounds | null {
  if (grid.bounds) return grid.bounds;
  const origin = finiteTuple3(grid.origin);
  const shape = positiveIntegerTuple3(grid.shape);
  const spacing = positiveTuple3(grid.spacing);
  if (!origin || !shape || !spacing) return null;
  const size: [number, number, number] = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ];
  return boundsFromCenterAndSize(
    [
      origin[0] + size[0] / 2,
      origin[1] + size[1] / 2,
      origin[2] + size[2] / 2,
    ],
    size,
  );
}

export function resolveFdmCellBounds(
  ref: Extract<NonNullable<Selection["ref"]>, { type: "fdm-cell" }>,
  grid: FdmSelectionGrid,
): Viewport3DBounds | null {
  const currentFingerprint = grid.gridFingerprint?.trim() ?? "";
  if (!currentFingerprint || ref.gridFingerprint !== currentFingerprint) {
    return null;
  }
  const origin = finiteTuple3(grid.origin);
  const shape = positiveIntegerTuple3(grid.shape);
  const spacing = positiveTuple3(grid.spacing);
  if (!origin || !shape || !spacing) return null;

  const [ix, iy, iz] = ref.ijk;
  if (
    !Number.isInteger(ix) ||
    !Number.isInteger(iy) ||
    !Number.isInteger(iz) ||
    ix < 0 ||
    iy < 0 ||
    iz < 0 ||
    ix >= shape[0] ||
    iy >= shape[1] ||
    iz >= shape[2]
  ) {
    return null;
  }
  const ordinal = Number(ref.cellOrdinal);
  const expectedOrdinal = ix + shape[0] * (iy + shape[1] * iz);
  if (!Number.isSafeInteger(ordinal) || ordinal !== expectedOrdinal) {
    return null;
  }

  const size: [number, number, number] = [spacing[0], spacing[1], spacing[2]];
  return boundsFromCenterAndSize(
    [
      origin[0] + (ix + 0.5) * spacing[0],
      origin[1] + (iy + 0.5) * spacing[1],
      origin[2] + (iz + 0.5) * spacing[2],
    ],
    size,
  );
}

function finiteTuple3(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!value || value.length < 3) return null;
  const tuple: [number, number, number] = [value[0]!, value[1]!, value[2]!];
  return tuple.every(Number.isFinite) ? tuple : null;
}

function positiveTuple3(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  const tuple = finiteTuple3(value);
  return tuple && tuple.every((component) => component > 0) ? tuple : null;
}

function positiveIntegerTuple3(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  const tuple = finiteTuple3(value);
  return tuple && tuple.every(
    (component) => Number.isSafeInteger(component) && component > 0,
  )
    ? tuple
    : null;
}

function boundsFromCenterAndSize(
  center: [number, number, number],
  size: [number, number, number],
): Viewport3DBounds {
  return {
    center,
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}

function resolveMeshQualityElementBounds(
  selection: Selection,
  fallbackBounds: Viewport3DBounds | null,
): Viewport3DBounds | null {
  if (selection.ref?.type !== "mesh-quality-element" || !selection.ref.centroid) {
    return null;
  }
  const radius = Math.max((fallbackBounds?.radius ?? 1e-9) * 0.03, 1e-12);
  const size = radius * 2;
  return {
    center: selection.ref.centroid,
    radius,
    size: [size, size, size],
  };
}

function resolveAirboxBounds(
  domain: FemManifestRenderDomain,
): Viewport3DBounds | null {
  return combineBounds(domain.airboxParts.map(resolveMeshPartBounds));
}

function resolveObjectBounds(
  domain: FemManifestRenderDomain,
  objectId: string | null,
): Viewport3DBounds | null {
  if (!objectId) return null;
  let partIds = domain.objectPartIds.get(objectId);
  if (!partIds) {
    partIds = domain.objectPartIds.get(`${objectId}_geom`);
  }
  if (!partIds && objectId.endsWith("_geom")) {
    partIds = domain.objectPartIds.get(objectId.slice(0, -5));
  }
  const ids = partIds ?? [];
  return combineBounds(
    ids.map((partId) => resolveMeshPartBounds(domain.partsById.get(partId))),
  );
}

function combineBounds(
  boundsList: Array<Viewport3DBounds | null>,
): Viewport3DBounds | null {
  const validBounds = boundsList.filter(
    (entry): entry is Viewport3DBounds => Boolean(entry),
  );
  if (!validBounds.length) return null;

  const min = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.min(current[0], bounds.center[0] - bounds.size[0] / 2),
      Math.min(current[1], bounds.center[1] - bounds.size[1] / 2),
      Math.min(current[2], bounds.center[2] - bounds.size[2] / 2),
    ],
    [Infinity, Infinity, Infinity],
  );
  const max = validBounds.reduce<[number, number, number]>(
    (current, bounds) => [
      Math.max(current[0], bounds.center[0] + bounds.size[0] / 2),
      Math.max(current[1], bounds.center[1] + bounds.size[1] / 2),
      Math.max(current[2], bounds.center[2] + bounds.size[2] / 2),
    ],
    [-Infinity, -Infinity, -Infinity],
  );
  const size: [number, number, number] = [
    Math.max(max[0] - min[0], 0),
    Math.max(max[1] - min[1], 0),
    Math.max(max[2] - min[2], 0),
  ];

  return {
    center: [
      min[0] + size[0] / 2,
      min[1] + size[1] / 2,
      min[2] + size[2] / 2,
    ],
    radius: Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-12),
    size,
  };
}
