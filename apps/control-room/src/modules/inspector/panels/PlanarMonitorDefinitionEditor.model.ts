import type { PlanarMonitor, PlanarMonitorOperator, PlanarMonitorTarget } from "@/kernel/workspace/crossSectionWorkspace";

export type TargetKind = PlanarMonitorTarget["kind"];

export type OperatorKind = PlanarMonitorOperator["kind"];

type SurfaceBoundaryKind = "object_boundary" | "region_boundary" | "named_surface";

export type Availability = { available: boolean; reason: string };

export interface PlanarMonitorDefinitionAvailability {
  objectIds?: readonly string[];
  operators?: Partial<Record<OperatorKind, Availability>>;
  regionRefs?: readonly { objectId: string; regionId: string }[];
  surfaceBoundaries?: Partial<Record<SurfaceBoundaryKind, Availability>>;
  targets?: Partial<Record<TargetKind, Availability>>;
}

export function planarMonitorDefinitionAvailabilityErrors(
  monitor: PlanarMonitor,
  availability: PlanarMonitorDefinitionAvailability,
): string[] {
  const target = availability.targets?.[monitor.target.kind];
  const operator = availability.operators?.[monitor.operator.kind];
  const surfaceBoundary = monitor.operator.kind === "surface_projection"
    ? availability.surfaceBoundaries?.[monitor.operator.boundary.kind]
    : undefined;
  const monitorTarget = monitor.target;
  let concreteTargetErrors: string[] = [];
  if (
    monitorTarget.kind === "object" &&
    availability.objectIds &&
    !availability.objectIds.includes(monitorTarget.object_id)
  ) {
    concreteTargetErrors = [
      `Object target "${monitorTarget.object_id}" is not executable in the current session.`,
    ];
  } else if (
    monitorTarget.kind === "region" &&
    availability.regionRefs &&
    !availability.regionRefs.some((entry) =>
      entry.objectId === monitorTarget.object_id && entry.regionId === monitorTarget.region_id)
  ) {
    concreteTargetErrors = [
      `Region target "${monitorTarget.object_id}/${monitorTarget.region_id}" is not executable in the current session.`,
    ];
  }
  return [
    ...(target?.available === false ? [target.reason] : []),
    ...concreteTargetErrors,
    ...(operator?.available === false ? [operator.reason] : []),
    ...(surfaceBoundary?.available === false ? [surfaceBoundary.reason] : []),
  ];
}

export function resolvePlanarMonitorDefinitionAvailability({
  discretization,
  fdmObjectIds,
  fdmRegionRefs,
  femTopologyReady,
  modelRegionRefs,
  sceneObjectIds,
}: {
  discretization: string | null;
  fdmObjectIds: readonly string[] | null;
  fdmRegionRefs: readonly { objectId: string; regionId: string }[] | null;
  femTopologyReady: boolean;
  modelRegionRefs: readonly { objectId: string; regionId: string }[] | null;
  sceneObjectIds: readonly string[] | null;
}): PlanarMonitorDefinitionAvailability {
  if (discretization === "fdm") {
    const reason = "FDM boundary surface topology is not published.";
    const objectIds = intersectIds(sceneObjectIds, fdmObjectIds);
    const regionRefs = intersectRegionRefs(modelRegionRefs, fdmRegionRefs);
    return {
      objectIds: objectIds ?? undefined,
      operators: { surface_projection: { available: false, reason } },
      regionRefs: regionRefs ?? undefined,
      surfaceBoundaries: unavailableSurfaceBoundaries(reason),
      targets: {
        object: catalogAvailability(
          objectIds,
          "Current-session FDM object membership is not materialized.",
          "No executable FDM object targets are published for the active session.",
        ),
        region: catalogAvailability(
          regionRefs,
          "Current-session FDM region membership is not materialized.",
          "No executable FDM region targets are published for the active session.",
        ),
      },
    };
  }
  if (discretization === "fem") {
    const objectIds = femTopologyReady ? sceneObjectIds : null;
    const regionRefs = femTopologyReady ? modelRegionRefs : null;
    return {
      objectIds: objectIds ?? undefined,
      operators: {
        surface_projection: { available: true, reason: "Surface projection is authorable for FEM." },
      },
      regionRefs: regionRefs ?? undefined,
      surfaceBoundaries: {
        object_boundary: {
          available: false,
          reason: femTopologyReady
            ? "Current-session FEM P1 field and object-boundary readiness is not published."
            : "Current-session FEM topology is not materialized.",
        },
        region_boundary: { available: false, reason: "FEM region-boundary topology is not published." },
        named_surface: { available: false, reason: "FEM named-surface topology is not published." },
      },
      targets: {
        object: catalogAvailability(
          objectIds,
          "Current-session FEM topology and object catalog are not materialized.",
          "No executable FEM object targets are published for the active session.",
        ),
        region: catalogAvailability(
          regionRefs,
          "Current-session FEM topology and region catalog are not materialized.",
          "No executable FEM region targets are published for the active session.",
        ),
      },
    };
  }
  const reason = "Active-session discretization capability is unavailable.";
  return {
    operators: Object.fromEntries(OPERATORS.map((kind) => [kind, { available: false, reason }])),
    targets: Object.fromEntries(TARGETS.map((kind) => [kind, { available: false, reason }])),
    surfaceBoundaries: unavailableSurfaceBoundaries(reason),
  };
}

function catalogAvailability<T>(
  entries: readonly T[] | null,
  unavailableReason: string,
  emptyReason: string,
): Availability {
  if (entries === null) return { available: false, reason: unavailableReason };
  return entries.length > 0
    ? { available: true, reason: "Published by the current-session resource catalogs." }
    : { available: false, reason: emptyReason };
}

function intersectIds(
  authored: readonly string[] | null,
  realized: readonly string[] | null,
): readonly string[] | null {
  if (authored === null || realized === null) return null;
  const realizedSet = new Set(realized);
  return authored.filter((id) => realizedSet.has(id));
}

function intersectRegionRefs(
  authored: readonly { objectId: string; regionId: string }[] | null,
  realized: readonly { objectId: string; regionId: string }[] | null,
): readonly { objectId: string; regionId: string }[] | null {
  if (authored === null || realized === null) return null;
  const realizedSet = new Set(realized.map((entry) => `${entry.objectId}\u0000${entry.regionId}`));
  return authored.filter((entry) => realizedSet.has(`${entry.objectId}\u0000${entry.regionId}`));
}

export const TARGETS: readonly TargetKind[] = [
  "domain",
  "magnetic_domain",
  "object",
  "region",
];

export const OPERATORS: readonly OperatorKind[] = [
  "plane_sample",
  "slab_average",
  "depth_projection",
  "surface_projection",
];

function unavailableSurfaceBoundaries(reason: string): Record<SurfaceBoundaryKind, Availability> {
  return {
    object_boundary: { available: false, reason },
    region_boundary: { available: false, reason },
    named_surface: { available: false, reason },
  };
}
