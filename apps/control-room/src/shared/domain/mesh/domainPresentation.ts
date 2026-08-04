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
  reason: string;
}

export interface FdmGridPresentation {
  descriptor: StructuredGridDescriptor;
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
  universeOutsideMagneticSupport: FdmUniverseOutsideMagneticSupport | null;
}

export interface FemDomainPresentation extends DomainPresentationBase {
  discretization: "fem";
  airbox: SharedDomainAirboxPresentation | null;
  fdmGrid: null;
  femTopology: FemTopologyPresentation;
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
      state === "loading" || state === "stale" || state === "error"
        ? state
        : membership === null
          ? state
          : !fresh
            ? "stale"
            : !compatible
              ? "incompatible"
              : "realized";
    const shape = tuple3(meta.grid.shape, [0, 0, 0]);
    const origin = tuple3(meta.grid.origin, [0, 0, 0]);
    const spacing = tuple3(meta.grid.spacing, [0, 0, 0]);
    const role = input.universeOutsideMagneticSupport
      ? {
          bounds: input.universeOutsideMagneticSupport.bounds,
          kind: "universe-outside-magnetic-support" as const,
          reason: input.universeOutsideMagneticSupport.reason,
        }
      : null;
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
        descriptor: meta.grid,
        gridFingerprint: fingerprint,
        membership,
        membershipStatus: resourceStatus,
        origin,
        shape,
        spacing,
        totalCells: gridCellCount(shape),
      },
      femTopology: null,
      fingerprint,
      generationId: meta.generation_id,
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
