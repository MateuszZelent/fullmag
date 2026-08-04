import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import {
  FMRM_INACTIVE_REGION_ID,
  type DecodedFdmRegionMembership,
} from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

export type MeshInspectorLane = "fdm" | "fem" | "unknown";

export function resolveMeshInspectorLane(
  discretization: string | null | undefined,
): MeshInspectorLane {
  const normalized = discretization?.trim().toLowerCase();
  if (normalized === "fdm") return "fdm";
  if (normalized === "fem") return "fem";
  return "unknown";
}

export type FdmObjectMeshInspectorStatus =
  | "loading"
  | "ready"
  | "stale"
  | "error"
  | "not-materialized"
  | "not-applicable";

export interface FdmObjectMeshInspectorResources {
  domain: Pick<ResourceResult<DomainMetaResource>, "data" | "error" | "status">;
  membership: Pick<
    ResourceResult<FdmRegionMembershipResource>,
    "data" | "error" | "status"
  >;
  binary?: Pick<
    ResourceResult<DecodedFdmRegionMembership | null>,
    "data" | "error" | "status"
  >;
}

export interface FdmObjectRegionMetadata {
  numericId: number;
  objectId: string;
  priority: number;
  regionId: string;
}

export interface FdmObjectMeshInspectorModel {
  activeCellCount: number | null;
  gridFingerprint: string | null;
  inactiveCellCount: number | null;
  metadata: readonly FdmObjectRegionMetadata[];
  notice: string | null;
  origin: readonly [number, number, number] | null;
  participation:
    | "canonical-mask"
    | "descriptor-only"
    | "legacy-ambiguous"
    | "not-materialized";
  shape: readonly [number, number, number] | null;
  spacing: readonly [number, number, number] | null;
  status: FdmObjectMeshInspectorStatus;
  totalCells: number | null;
  readonly: true;
}

const NOT_APPLICABLE_REASON =
  "FDM uses a structured grid; FEM element order, topology, Gmsh size fields, quality, and shared-domain builds are not applicable.";

export function fdmMeshNotApplicableReason(): string {
  return NOT_APPLICABLE_REASON;
}

function tuple3(
  value: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!value || value.length < 3) return null;
  const tuple = [value[0], value[1], value[2]];
  return tuple.every((entry) => Number.isFinite(entry))
    ? (tuple as [number, number, number])
    : null;
}

function product3(value: readonly [number, number, number] | null): number | null {
  if (!value || value.some((entry) => !Number.isInteger(entry) || entry < 0)) {
    return null;
  }
  const product = value[0] * value[1] * value[2];
  return Number.isSafeInteger(product) ? product : null;
}

function sameGridTuple(
  left: readonly number[] | null | undefined,
  right: readonly number[] | null | undefined,
): boolean {
  if (!left || !right || left.length < 3 || right.length < 3) return false;
  return [0, 1, 2].every((index) => {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return false;
    const tolerance = 1e-12 * Math.max(1, Math.abs(leftValue), Math.abs(rightValue));
    return Math.abs(leftValue - rightValue) <= tolerance;
  });
}

function statusModel(
  status: FdmObjectMeshInspectorStatus,
  fields: Omit<FdmObjectMeshInspectorModel, "status">,
): FdmObjectMeshInspectorModel {
  return { ...fields, status, readonly: true };
}

export function resolveFdmObjectMeshInspectorModel({
  objectId,
  regionId,
  resources,
  lane,
}: {
  lane: MeshInspectorLane;
  objectId: string | null | undefined;
  regionId?: string | null | undefined;
  resources: FdmObjectMeshInspectorResources;
}): FdmObjectMeshInspectorModel {
  const base: Omit<FdmObjectMeshInspectorModel, "status"> = {
    activeCellCount: null,
    gridFingerprint: resources.membership.data?.grid_fingerprint ?? null,
    inactiveCellCount: null,
    metadata: [],
    notice: null,
    origin: null,
    participation: "not-materialized",
    shape: null,
    spacing: null,
    totalCells: null,
    readonly: true,
  };

  if (lane !== "fdm") {
    return statusModel("not-applicable", {
      ...base,
      notice: NOT_APPLICABLE_REASON,
      participation: "not-materialized",
    });
  }

  const domain = resources.domain.data;
  if (resources.domain.status === "error" || resources.domain.error) {
    return statusModel("error", {
      ...base,
      notice:
        resources.domain.error?.message ?? "FDM DomainMeta could not be loaded.",
    });
  }
  if (!domain) {
    return statusModel(
      resources.domain.status === "loading" ? "loading" : "not-materialized",
      {
        ...base,
        notice:
          resources.domain.status === "loading"
            ? "FDM structured-grid metadata is loading."
            : "FDM DomainMeta is not materialized.",
      },
    );
  }
  if (resolveMeshInspectorLane(domain.discretization) !== "fdm") {
    return statusModel("not-applicable", {
      ...base,
      notice: NOT_APPLICABLE_REASON,
    });
  }

  const origin = tuple3(domain.grid?.origin);
  const shape = tuple3(domain.grid?.shape);
  const spacing = tuple3(domain.grid?.spacing);
  const totalCells = product3(shape);
  const membership = resources.membership.data;
  const normalizedRegionId = regionId?.trim() || null;
  const selectedRegionEntry = normalizedRegionId
    ? membership?.region_legend.find(
        (entry) =>
          entry.region_id === normalizedRegionId &&
        (!objectId || entry.object_id === objectId),
      ) ?? null
    : null;
  const metadata = (membership?.region_legend ?? [])
    .filter((entry) =>
      normalizedRegionId
        ? Boolean(selectedRegionEntry) && entry.region_id === selectedRegionEntry?.region_id
        : !objectId || entry.object_id === objectId,
    )
    .map((entry) => ({
      numericId: entry.numeric_id,
      objectId: entry.object_id,
      priority: entry.priority,
      regionId: entry.region_id,
    }));
  const membershipCompatible =
    membership !== null &&
    membership !== undefined &&
    membership.cell_count === totalCells &&
    sameGridTuple(membership.counts, shape) &&
    sameGridTuple(membership.origin_m, domain.grid?.origin) &&
    sameGridTuple(membership.cell_m, domain.grid?.spacing);
  const binary = resources.binary?.data ?? null;
  const binaryIdentityValid =
    binary?.semanticStatus === "canonical" &&
    membership !== null &&
    membership !== undefined &&
    binary.gridFingerprint === membership.grid_fingerprint &&
    binary.cellCount === membership.cell_count &&
    sameGridTuple(binary.counts, membership.counts) &&
    sameGridTuple(binary.counts, shape);
  const binaryReady = resources.binary?.status === "ready";
  const canonicalMaskReady = Boolean(
    binaryReady &&
      binaryIdentityValid &&
      (!normalizedRegionId || Boolean(selectedRegionEntry)) &&
      membership?.freshness.trim().toLowerCase() === "current" &&
      resources.membership.status === "ready" &&
      resources.domain.status === "ready",
  );
  const regionIds = new Set(metadata.map((entry) => entry.numericId));
  const activeCellCount = canonicalMaskReady
    ? binary!.regionIds.reduce(
        (count, regionId) => count + (regionIds.has(regionId) ? 1 : 0),
        0,
      )
    : null;
  const inactiveCellCount = canonicalMaskReady
    ? binary!.regionIds.reduce(
        (count, regionId) =>
          count + (regionId === FMRM_INACTIVE_REGION_ID ? 1 : 0),
        0,
      )
    : null;
  const participation =
    normalizedRegionId && !selectedRegionEntry
      ? "not-materialized"
      : canonicalMaskReady
      ? "canonical-mask"
      : binary?.semanticStatus === "legacy-ambiguous"
        ? "legacy-ambiguous"
        : membershipCompatible
          ? "descriptor-only"
          : "not-materialized";

  const fields = {
    ...base,
    activeCellCount,
    gridFingerprint: membership?.grid_fingerprint ?? null,
    inactiveCellCount,
    metadata,
    origin,
    participation,
    shape,
    spacing,
    totalCells,
  } satisfies Omit<FdmObjectMeshInspectorModel, "status">;

  if (!origin || !shape || !spacing || totalCells === null) {
    return statusModel("error", {
      ...fields,
      notice: "FDM DomainMeta is missing a valid structured-grid descriptor.",
    });
  }
  if (resources.membership.status === "error" || resources.membership.error) {
    return statusModel("error", {
      ...fields,
      notice:
        resources.membership.error?.message ??
        "FDM region membership could not be loaded.",
    });
  }
  if (!membership) {
    return statusModel(resources.membership.status === "loading" ? "loading" : "not-materialized", {
      ...fields,
      notice:
        resources.membership.status === "loading"
          ? "FDM region membership is loading."
          : "FDM region membership is not materialized.",
    });
  }
  if (normalizedRegionId && !selectedRegionEntry) {
    return statusModel("not-materialized", {
      ...fields,
      notice:
        `Selected FDM region ${normalizedRegionId} is not published for the selected object; classification is withheld.`,
    });
  }
  if (resources.domain.status === "stale" || resources.membership.status === "stale") {
    return statusModel("stale", {
      ...fields,
      notice: "FDM structured-grid metadata is stale.",
    });
  }
  if (membership.freshness.trim().toLowerCase() !== "current") {
    return statusModel("stale", {
      ...fields,
      notice: `FDM region membership freshness is ${membership.freshness || "unknown"}.`,
    });
  }
  if (!membershipCompatible) {
    return statusModel("not-materialized", {
      ...fields,
      notice: "FDM region membership does not match the current grid.",
    });
  }
  if (resources.binary?.status === "error" || resources.binary?.error) {
    return statusModel("error", {
      ...fields,
      notice:
        resources.binary.error?.message ??
        "FDM binary region membership could not be loaded.",
    });
  }
  if (!binary) {
    return statusModel(resources.binary?.status === "loading" ? "loading" : "not-materialized", {
      ...fields,
      notice:
        resources.binary?.status === "loading"
          ? "FDM binary region membership is loading."
          : "FDM binary region membership is not materialized.",
    });
  }
  if (binary.semanticStatus === "legacy-ambiguous") {
    return statusModel("not-materialized", {
      ...fields,
      notice: "Legacy FDM membership encoding is ambiguous; cell classification is withheld.",
    });
  }
  if (!binaryIdentityValid) {
    return statusModel("not-materialized", {
      ...fields,
      notice: "FDM binary region membership does not match the current grid identity.",
    });
  }
  if (resources.binary?.status === "stale") {
    return statusModel("stale", {
      ...fields,
      notice: "FDM binary region membership is stale.",
    });
  }
  if (!canonicalMaskReady) {
    return statusModel("not-materialized", {
      ...fields,
      notice: "FDM canonical region membership is not ready for classification.",
    });
  }
  return statusModel("ready", {
    ...fields,
    notice: null,
  });
}
