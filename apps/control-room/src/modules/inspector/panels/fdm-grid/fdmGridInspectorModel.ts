import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

export type FdmGridInspectorStatus =
  | "loading"
  | "ready"
  | "stale"
  | "error"
  | "not-materialized"
  | "not-applicable";

export type FdmCellClassification = "unknown" | "not-applicable";

type ResourceSnapshot<T> = Pick<
  ResourceResult<T>,
  "data" | "error" | "revision" | "status"
>;

export interface FdmGridInspectorResources {
  domain: ResourceSnapshot<DomainMetaResource>;
  membership: ResourceSnapshot<FdmRegionMembershipResource>;
}

export interface FdmGridMembershipSummary {
  encoding: string;
  freshness: string;
  gridFingerprint: string;
  legend: readonly FdmGridLegendEntry[];
  meshRevision: number;
  regionMembershipRevision: number;
}

export interface FdmGridLegendEntry {
  numericId: number;
  objectId: string;
  priority: number;
  regionId: string;
}

export interface FdmGridInspectorModel {
  cellClassification: FdmCellClassification;
  domainId: string | null;
  generationId: string | null;
  membership: FdmGridMembershipSummary | null;
  notice: string | null;
  origin: readonly [number, number, number] | null;
  shape: readonly [number, number, number] | null;
  spacing: readonly [number, number, number] | null;
  status: FdmGridInspectorStatus;
  statusLabel: string;
  totalCells: number | null;
  units: Readonly<Record<string, string>>;
}

const STATUS_LABELS: Record<FdmGridInspectorStatus, string> = {
  error: "Error",
  loading: "Loading",
  "not-applicable": "Not applicable",
  "not-materialized": "Not materialized",
  ready: "Realized",
  stale: "Stale",
};

function tuple3(
  values: readonly number[] | null | undefined,
): [number, number, number] | null {
  if (!values || values.length < 3) return null;
  const tuple = [values[0], values[1], values[2]];
  return tuple.every((value) => typeof value === "number" && Number.isFinite(value))
    ? (tuple as [number, number, number])
    : null;
}

function totalCells(shape: readonly [number, number, number] | null): number | null {
  if (!shape || shape.some((value) => !Number.isInteger(value) || value < 0)) {
    return null;
  }
  const result = shape[0] * shape[1] * shape[2];
  return Number.isSafeInteger(result) ? result : null;
}

function sameTuple(
  left: readonly number[] | null | undefined,
  right: readonly [number, number, number],
): boolean {
  const tuple = tuple3(left);
  return tuple != null && tuple.every((value, index) => value === right[index]);
}

function membershipCompatible(
  grid: {
    shape: readonly [number, number, number];
    origin: readonly [number, number, number];
    spacing: readonly [number, number, number];
    totalCells: number;
  },
  membership: FdmRegionMembershipResource,
): boolean {
  return (
    membership.counts.length >= 3 &&
    membership.counts[0] === grid.shape[0] &&
    membership.counts[1] === grid.shape[1] &&
    membership.counts[2] === grid.shape[2] &&
    membership.cell_count === grid.totalCells &&
    sameTuple(membership.origin_m, grid.origin) &&
    sameTuple(membership.cell_m, grid.spacing)
  );
}

function statusModel(
  status: FdmGridInspectorStatus,
  fields: Omit<FdmGridInspectorModel, "status" | "statusLabel">,
): FdmGridInspectorModel {
  return { ...fields, status, statusLabel: STATUS_LABELS[status] };
}

function errorNotice(
  domainError: Error | null,
  membershipError: Error | null,
): string {
  const message = membershipError?.message ?? domainError?.message;
  return message
    ? `FDM grid resource error: ${message}`
    : "FDM grid resources could not be loaded.";
}

export function resolveFdmGridInspectorModel(
  resources: FdmGridInspectorResources,
): FdmGridInspectorModel {
  const domain = resources.domain.data;
  const base: Omit<FdmGridInspectorModel, "status" | "statusLabel"> = {
    cellClassification: "unknown",
    domainId: domain?.domain_id ?? null,
    generationId: domain?.generation_id ?? null,
    membership: null,
    notice: null,
    origin: null,
    shape: null,
    spacing: null,
    totalCells: null,
    units: domain?.units ?? {},
  };

  if (resources.domain.status === "error" || resources.domain.error) {
    return statusModel("error", {
      ...base,
      notice: errorNotice(resources.domain.error, null),
    });
  }
  if (!domain) {
    if (resources.domain.status === "loading") {
      return statusModel("loading", {
        ...base,
        notice: "FDM grid resources are loading.",
      });
    }
    return statusModel("not-materialized", {
      ...base,
      notice: "FDM DomainMeta is not materialized.",
    });
  }

  if (domain.discretization.toLowerCase() !== "fdm") {
    return statusModel("not-applicable", {
      ...base,
      cellClassification: "not-applicable",
      notice: "This inspector is only applicable to an explicit FDM domain.",
    });
  }

  const origin = tuple3(domain.grid?.origin);
  const shape = tuple3(domain.grid?.shape);
  const spacing = tuple3(domain.grid?.spacing);
  const cells = totalCells(shape);
  const grid =
    origin && shape && spacing && cells !== null
      ? { origin, shape, spacing, totalCells: cells }
      : null;
  const membership = resources.membership.data;
  const membershipSummary = membership
    ? {
        encoding: membership.encoding,
        freshness: membership.freshness,
        gridFingerprint: membership.grid_fingerprint,
        legend: membership.region_legend.map((entry) => ({
          numericId: entry.numeric_id,
          objectId: entry.object_id,
          priority: entry.priority,
          regionId: entry.region_id,
        })),
        meshRevision: membership.mesh_revision,
        regionMembershipRevision: membership.region_membership_revision,
      }
    : null;
  const gridFields = {
    ...base,
    origin,
    shape,
    spacing,
    totalCells: cells,
    membership: membershipSummary,
  };

  if (!grid) {
    return statusModel("error", {
      ...gridFields,
      notice: "FDM DomainMeta is missing a valid structured-grid descriptor.",
    });
  }
  if (resources.membership.status === "error" || resources.membership.error) {
    return statusModel("error", {
      ...gridFields,
      notice: errorNotice(null, resources.membership.error),
    });
  }
  if (resources.domain.status === "stale") {
    return statusModel("stale", {
      ...gridFields,
      notice: "FDM DomainMeta is stale; grid facts may no longer match the current session.",
    });
  }
  if (resources.domain.status === "loading" || resources.membership.status === "loading") {
    return statusModel("loading", {
      ...gridFields,
      notice: "FDM grid resources are loading.",
    });
  }
  if (!membership) {
    return statusModel("not-materialized", {
      ...gridFields,
      notice: "FDM region membership is not materialized; cell classification remains unknown.",
    });
  }
  if (
    resources.membership.status === "stale" ||
    membership.freshness.toLowerCase() !== "current" ||
    !membershipCompatible(grid, membership)
  ) {
    return statusModel("stale", {
      ...gridFields,
      notice: "FDM region membership is stale or no longer matches the structured grid.",
    });
  }
  return statusModel("ready", gridFields);
}
