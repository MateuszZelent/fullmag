import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
  MeshSharedDomainManifestResource,
  ResourceRevision,
} from "@/kernel/api/apiTypes";
import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedTopology,
} from "@/kernel/api/codecs";

export { FMRM_INACTIVE_REGION_ID };

export type StructuredGridDescriptor = NonNullable<DomainMetaResource["grid"]>;
export type DomainBounds3 = {
  max: readonly [number, number, number];
  min: readonly [number, number, number];
};

export type DomainResourceStatus =
  | "authoring-grid"
  | "realized"
  | "loading"
  | "stale"
  | "missing"
  | "incompatible"
  | "error";

export type DomainResourceState =
  | "idle"
  | "loading"
  | "ready"
  | "stale"
  | "error";

export interface FdmUniverseOutsideMagneticSupport {
  bounds: DomainBounds3;
  kind: "universe-outside-magnetic-support";
  /** Authored support envelope used only for a bounds preview before FMRM. */
  magneticSupportBounds?: DomainBounds3;
  reason: string;
}

export interface FdmMagneticSupportPresentation {
  activeCellCount: number;
  activeUnassignedCellCount: number;
  bounds: DomainBounds3;
  inactiveCellCount: number;
  kind: "magnetic-support";
}

export interface FdmGridPresentation {
  declaredCellCount: number | null;
  descriptor: StructuredGridDescriptor;
  descriptorCellCountCompatible: boolean;
  gridFingerprint: string | null;
  membership: FdmRegionMembershipResource | null;
  membershipStatus: DomainResourceStatus;
  origin: readonly [number, number, number];
  shape: readonly [number, number, number];
  spacing: readonly [number, number, number];
  totalCells: number;
}

export interface FemTopologyPresentation {
  manifest: MeshSharedDomainManifestResource | null;
  topology: DecodedTopology | null;
  topologyFingerprint: string | null;
}

export interface SharedDomainAirboxPresentation {
  kind: "shared-domain-airbox";
  parts: readonly NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>[number][];
}

interface DomainPresentationBase {
  bounds: DomainMetaResource["bounds"];
  domainId: string;
  generationId: string;
  units: DomainMetaResource["units"];
  resourceStatus: DomainResourceStatus;
  revision: ResourceRevision | null;
  fingerprint: string | null;
}

export interface FdmDomainPresentation extends DomainPresentationBase {
  discretization: "fdm";
  /** FDM universe support is not a FEM shared-domain Airbox mesh. */
  airbox: null;
  fdmGrid: FdmGridPresentation;
  femTopology: null;
  magneticSupport: FdmMagneticSupportPresentation | null;
  universeOutsideMagneticSupport: FdmUniverseOutsideMagneticSupport | null;
}

export interface FemDomainPresentation extends DomainPresentationBase {
  discretization: "fem";
  airbox: SharedDomainAirboxPresentation | null;
  fdmGrid: null;
  femTopology: FemTopologyPresentation;
  magneticSupport: null;
  universeOutsideMagneticSupport: null;
}

export type DomainPresentation =
  | FdmDomainPresentation
  | FemDomainPresentation;

export interface DomainPresentationInput {
  domainMeta?: DomainMetaResource | null;
  domain?: DomainMetaResource | null;
  expectedFdmGridFingerprint?: string | null;
  fdmMembership?: FdmRegionMembershipResource | null;
  fdmMembershipStatus?: DomainResourceState;
  femManifest?: MeshSharedDomainManifestResource | null;
  femTopology?: DecodedTopology | null;
  femTopologyStatus?: DomainResourceState;
  universeOutsideMagneticSupport?: Omit<
    FdmUniverseOutsideMagneticSupport,
    "kind"
  > | null;
}

export type FdmCellState =
  | { kind: "inactive"; numericRegionId: null; regionId: null }
  | {
      kind: "active-unassigned";
      numericRegionId: number;
      regionId: null;
    }
  | { kind: "region"; numericRegionId: number; regionId: string };

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function tuple3(
  values: readonly number[] | null | undefined,
  fallback: readonly [number, number, number],
): [number, number, number] {
  return [
    asFiniteNumber(values?.[0], fallback[0]),
    asFiniteNumber(values?.[1], fallback[1]),
    asFiniteNumber(values?.[2], fallback[2]),
  ];
}

function sameNumber(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 32 * scale;
}

function sameTuple(
  left: readonly number[] | null | undefined,
  right: readonly number[],
): boolean {
  return (
    left != null &&
    left.length >= 3 &&
    right.length >= 3 &&
    sameNumber(left[0] ?? NaN, right[0] ?? NaN) &&
    sameNumber(left[1] ?? NaN, right[1] ?? NaN) &&
    sameNumber(left[2] ?? NaN, right[2] ?? NaN)
  );
}

function gridCellCount(shape: readonly number[]): number {
  const count = shape.slice(0, 3).reduce((product, value) => product * value, 1);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function membershipCompatible(
  descriptor: StructuredGridDescriptor,
  membership: FdmRegionMembershipResource,
  expectedFingerprint: string | null | undefined,
): boolean {
  const shape = tuple3(descriptor.shape, [0, 0, 0]);
  const spacing = tuple3(descriptor.spacing, [0, 0, 0]);
  const origin = tuple3(descriptor.origin, [0, 0, 0]);
  const expectedCellCount = gridCellCount(shape);
  return (
    membership.counts.length >= 3 &&
    membership.counts[0] === shape[0] &&
    membership.counts[1] === shape[1] &&
    membership.counts[2] === shape[2] &&
    membership.cell_count === expectedCellCount &&
    sameTuple(membership.origin_m, origin) &&
    sameTuple(membership.cell_m, spacing) &&
    (expectedFingerprint == null ||
      membership.grid_fingerprint === expectedFingerprint)
  );
}

function stateStatus(
  state: DomainResourceState | undefined,
  dataPresent: boolean,
): DomainResourceStatus {
  if (state === "error") return "error";
  if (state === "loading") return "loading";
  if (state === "stale") return "stale";
  if (!dataPresent && (state === "ready" || state === "idle")) {
    return "authoring-grid";
  }
  return dataPresent ? "realized" : "missing";
}

function femAirbox(
  manifest: MeshSharedDomainManifestResource | null,
): SharedDomainAirboxPresentation | null {
  const parts = manifest?.mesh_parts?.filter((part) => {
    const role = part.role?.toLowerCase();
    return role === "air" || role === "airbox";
  });
  return parts && parts.length > 0
    ? { kind: "shared-domain-airbox", parts }
    : null;
}

function finiteTuple3(values: readonly number[] | null | undefined): [number, number, number] | null {
  return values?.length === 3 && values.every(Number.isFinite)
    ? [values[0]!, values[1]!, values[2]!]
    : null;
}

function fdmMagneticSupport(
  meta: DomainMetaResource,
  membership: FdmRegionMembershipResource | null,
  resourceStatus: DomainResourceStatus,
): FdmMagneticSupportPresentation | null {
  const summary = membership?.magnetic_support;
  const min = finiteTuple3(summary?.bounds_min_m);
  const max = finiteTuple3(summary?.bounds_max_m);
  const domainMin = finiteTuple3(meta.bounds.min);
  const domainMax = finiteTuple3(meta.bounds.max);
  if (
    resourceStatus !== "realized" ||
    !summary ||
    summary.semantic_role !== "magnetic-support" ||
    summary.grid_fingerprint !== membership.grid_fingerprint ||
    !min ||
    !max ||
    !domainMin ||
    !domainMax ||
    min.some((value, axis) => value > max[axis]!) ||
    min.some((value, axis) => value < domainMin[axis]!) ||
    max.some((value, axis) => value > domainMax[axis]!) ||
    ![
      summary.active_cell_count,
      summary.active_unassigned_cell_count,
      summary.inactive_cell_count,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    summary.active_cell_count + summary.inactive_cell_count !== membership.cell_count ||
    summary.active_unassigned_cell_count > summary.active_cell_count
  ) {
    return null;
  }
  return {
    activeCellCount: summary.active_cell_count,
    activeUnassignedCellCount: summary.active_unassigned_cell_count,
    bounds: { max, min },
    inactiveCellCount: summary.inactive_cell_count,
    kind: "magnetic-support",
  };
}

function domainBounds3(
  bounds: DomainMetaResource["bounds"],
): DomainBounds3 | null {
  const min = finiteTuple3(bounds.min);
  const max = finiteTuple3(bounds.max);
  return min && max ? { max, min } : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteTuple3Unknown(value: unknown): [number, number, number] | null {
  return Array.isArray(value) ? finiteTuple3(value) : null;
}

function authoredObjectBounds(value: unknown): DomainBounds3 | null {
  const object = recordValue(value);
  if (!object) return null;
  const geometry = recordValue(object.geometry);
  const geometryMin = finiteTuple3Unknown(geometry?.bounds_min);
  const geometryMax = finiteTuple3Unknown(geometry?.bounds_max);
  if (geometryMin && geometryMax) {
    return { min: geometryMin, max: geometryMax };
  }

  const params = recordValue(geometry?.geometry_params);
  const size = finiteTuple3Unknown(params?.size ?? params?.dimensions);
  if (!size || size.some((component) => component <= 0)) return null;
  const translation =
    finiteTuple3Unknown(recordValue(object.transform)?.translation) ?? [0, 0, 0];
  const half = size.map((component) => component / 2) as [number, number, number];
  return {
    min: translation.map((component, axis) => component - half[axis]) as [
      number,
      number,
      number,
    ],
    max: translation.map((component, axis) => component + half[axis]) as [
      number,
      number,
      number,
    ],
  };
}

function authoredObjectIsMagnetic(value: unknown): boolean {
  const object = recordValue(value);
  if (!object) return false;
  const role = typeof object.role === "string" ? object.role.toLowerCase() : "magnet";
  const hint = recordValue(object.visualization_hint);
  const hintRole = typeof hint?.role === "string" ? hint.role.toLowerCase() : "";
  return role !== "antenna" && role !== "auxiliary" && hintRole !== "antenna";
}

function boxVolume(bounds: DomainBounds3): number {
  return Math.max(
    bounds.max[0] - bounds.min[0],
    0,
  ) * Math.max(bounds.max[1] - bounds.min[1], 0) * Math.max(bounds.max[2] - bounds.min[2], 0);
}

/**
 * Supplies a conservative Airbox role from authored geometry while the FDM
 * membership artifact is still unavailable. The result is only an extent
 * envelope; exact cell ownership remains deferred to FMRM membership.
 */
export function deriveAuthoredFdmUniverseOutsideMagneticSupport({
  domainBounds,
  objects,
}: {
  domainBounds: DomainMetaResource["bounds"];
  objects: readonly unknown[] | null | undefined;
}): Omit<FdmUniverseOutsideMagneticSupport, "kind"> | null {
  const domain = domainBounds3(domainBounds);
  if (!domain || !objects?.length) return null;
  const magneticBounds = objects
    .filter(authoredObjectIsMagnetic)
    .map(authoredObjectBounds)
    .filter((bounds): bounds is DomainBounds3 => bounds !== null)
    .map((bounds) => ({
      min: bounds.min.map((value, axis) => Math.max(value, domain.min[axis])) as [
        number,
        number,
        number,
      ],
      max: bounds.max.map((value, axis) => Math.min(value, domain.max[axis])) as [
        number,
        number,
        number,
      ],
    }))
    .filter((bounds) => bounds.min.every((value, axis) => value <= bounds.max[axis]));
  if (magneticBounds.length === 0) return null;

  const support = magneticBounds.reduce<DomainBounds3>(
    (accumulator, bounds) => ({
      min: accumulator.min.map((value, axis) => Math.min(value, bounds.min[axis])) as [
        number,
        number,
        number,
      ],
      max: accumulator.max.map((value, axis) => Math.max(value, bounds.max[axis])) as [
        number,
        number,
        number,
      ],
    }),
    magneticBounds[0],
  );
  const scale = Math.max(...domain.min.map(Math.abs), ...domain.max.map(Math.abs), 1);
  const tolerance = Number.EPSILON * 256 * scale;
  const universeExceedsEnvelope =
    domain.min.some((value, axis) => support.min[axis] > value + tolerance) ||
    domain.max.some((value, axis) => support.max[axis] < value - tolerance);
  const unionVolume = boxVolume(support);
  const summedVolume = magneticBounds.reduce((sum, bounds) => sum + boxVolume(bounds), 0);
  const disjointMagneticObjects =
    magneticBounds.length > 1 && summedVolume + unionVolume * 1e-12 < unionVolume;
  if (!universeExceedsEnvelope && !disjointMagneticObjects) return null;

  return {
    bounds: domain,
    magneticSupportBounds: support,
    reason: "authored-universe-exceeds-magnetic-support",
  };
}

export function buildDomainPresentation(
  input: DomainPresentationInput,
): DomainPresentation {
  const meta = input.domainMeta ?? input.domain;
  if (!meta) {
    throw new Error("Cannot build a domain presentation without DomainMeta.");
  }

  if (meta.discretization.toLowerCase() === "fdm") {
    if (!meta.grid) {
      throw new Error("FDM DomainMeta is missing its structured grid descriptor.");
    }
    const membership = input.fdmMembership ?? null;
    const shape = tuple3(meta.grid.shape, [0, 0, 0]);
    const totalCells = gridCellCount(shape);
    const declaredCellCount = meta.counts.cells ?? null;
    const descriptorCellCountCompatible =
      declaredCellCount === null || declaredCellCount === totalCells;
    const state = stateStatus(input.fdmMembershipStatus, membership !== null);
    const fresh = membership?.freshness?.toLowerCase() === "current";
    const compatible =
      membership === null ||
      membershipCompatible(
        meta.grid,
        membership,
        input.expectedFdmGridFingerprint,
      );
    const resourceStatus =
      !descriptorCellCountCompatible
        ? "incompatible"
        : state === "loading" || state === "stale" || state === "error"
        ? state
        : membership === null
          ? state
          : !fresh
            ? "stale"
            : !compatible
              ? "incompatible"
              : "realized";
    const origin = tuple3(meta.grid.origin, [0, 0, 0]);
    const spacing = tuple3(meta.grid.spacing, [0, 0, 0]);
    const magneticSupport = fdmMagneticSupport(meta, membership, resourceStatus);
    const realizedDomainBounds = domainBounds3(meta.bounds);
    const explicitRole = input.universeOutsideMagneticSupport
      ? {
          bounds: input.universeOutsideMagneticSupport.bounds,
          kind: "universe-outside-magnetic-support" as const,
          ...(input.universeOutsideMagneticSupport.magneticSupportBounds
            ? {
                magneticSupportBounds:
                  input.universeOutsideMagneticSupport.magneticSupportBounds,
              }
            : {}),
          reason: input.universeOutsideMagneticSupport.reason,
        }
      : null;
    const membershipRole =
      magneticSupport &&
      magneticSupport.inactiveCellCount > 0 &&
      realizedDomainBounds
        ? {
            bounds: realizedDomainBounds,
            kind: "universe-outside-magnetic-support" as const,
            // The AABB is only an extent envelope. Exact inactive cells stay
            // in the canonical FMRM membership mask, which is required for
            // disjoint multi-ferromagnet/region layouts.
            reason: "validated-magnetic-support-with-inactive-cells",
          }
        : null;
    // Keep the authored envelope available when a realized descriptor does
    // not carry a validated magnetic-support summary.  It remains bounds-only
    // and never authorizes FDM cell or field rendering; the exact FMRM mask is
    // still required by the cuboid builder.
    const role = membershipRole ?? explicitRole;
    const fingerprint = membership?.grid_fingerprint ?? input.expectedFdmGridFingerprint ?? null;
    const revision = membership
      ? `${meta.generation_id}:${membership.mesh_revision}:${membership.region_membership_revision}`
      : meta.generation_id;
    return {
      airbox: null,
      bounds: meta.bounds,
      discretization: "fdm",
      domainId: meta.domain_id,
      fdmGrid: {
        declaredCellCount,
        descriptor: meta.grid,
        descriptorCellCountCompatible,
        gridFingerprint: fingerprint,
        membership,
        membershipStatus: resourceStatus,
        origin,
        shape,
        spacing,
        totalCells,
      },
      femTopology: null,
      fingerprint,
      generationId: meta.generation_id,
      magneticSupport,
      resourceStatus,
      revision,
      units: meta.units,
      universeOutsideMagneticSupport: role,
    };
  }

  const manifest = input.femManifest ?? null;
  const topology = input.femTopology ?? null;
  const topologyState = stateStatus(input.femTopologyStatus, topology !== null);
  const resourceStatus =
    topologyState === "loading" ||
    topologyState === "stale" ||
    topologyState === "error"
      ? topologyState
      : topologyState === "realized" && manifest !== null
        ? "realized"
        : topology === null
          ? "missing"
          : "incompatible";
  const fingerprint = manifest?.topology_fingerprint ?? null;
  const revision = manifest
    ? `${manifest.revision}:${manifest.source_scene_revision ?? "unknown"}:${manifest.geometry_realization_revision ?? "unknown"}`
    : null;
  return {
    airbox: femAirbox(manifest),
    bounds: meta.bounds,
    discretization: "fem",
    domainId: meta.domain_id,
    fdmGrid: null,
    femTopology: {
      manifest,
      topology,
      topologyFingerprint: fingerprint,
    },
    fingerprint,
    generationId: meta.generation_id,
    magneticSupport: null,
    resourceStatus,
    revision,
    units: meta.units,
    universeOutsideMagneticSupport: null,
  };
}

export function isFdmDomain(
  presentation: DomainPresentation | null | undefined,
): presentation is FdmDomainPresentation {
  return presentation?.discretization === "fdm";
}

export function isFemDomain(
  presentation: DomainPresentation | null | undefined,
): presentation is FemDomainPresentation {
  return presentation?.discretization === "fem";
}

export function resolveFdmCellState(
  numericRegionId: number | bigint,
  membership: FdmRegionMembershipResource | null | undefined,
): FdmCellState {
  const id = typeof numericRegionId === "bigint" ? Number(numericRegionId) : numericRegionId;
  if (id === FMRM_INACTIVE_REGION_ID) {
    return { kind: "inactive", numericRegionId: null, regionId: null };
  }
  const legendEntry = membership?.region_legend.find(
    (entry) => entry.numeric_id === id,
  );
  if (legendEntry?.region_id) {
    return { kind: "region", numericRegionId: id, regionId: legendEntry.region_id };
  }
  return { kind: "active-unassigned", numericRegionId: id, regionId: null };
}

export function domainPresentationKey(
  presentation: DomainPresentation | null | undefined,
): string | null {
  if (!presentation) return null;
  const revision =
    presentation.discretization === "fdm" &&
    typeof presentation.revision === "string" &&
    presentation.revision.startsWith(`${presentation.generationId}:`)
      ? presentation.revision.slice(presentation.generationId.length + 1)
      : presentation.revision;
  return [
    presentation.discretization,
    presentation.domainId,
    presentation.generationId,
    presentation.fingerprint ?? "unknown",
    revision ?? "unknown",
  ].join(":");
}
