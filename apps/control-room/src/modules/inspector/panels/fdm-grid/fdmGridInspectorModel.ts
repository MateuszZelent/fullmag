import type {
  DomainMetaResource,
  FdmRegionMembershipResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { resolveFdmCellState } from "@/shared/domain/mesh/domainPresentation";

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

export type FdmGridSelectionScope =
  | "domain"
  | "descriptor"
  | "magnetic-support"
  | "active-unassigned"
  | "mask"
  | "provenance"
  | "region"
  | "universe-outside-support"
  | "cell";

export interface FdmGridSelectionCell {
  cellOrdinal: string;
  gridFingerprint: string;
  ijk: readonly [number, number, number];
  maskState: "inactive" | "active-unassigned" | "region";
  membershipRevision: string;
  numericRegionId: number | null;
  regionId: string | null;
}

export interface FdmMagneticSupportSummary {
  activeCellCount: number;
  activeUnassignedCellCount: number;
  boundsMax: readonly [number, number, number];
  boundsMin: readonly [number, number, number];
  inactiveCellCount: number;
}

export interface FdmGridSelectionInspectorModel {
  cell: FdmGridSelectionCell | null;
  notice: string | null;
  region: FdmGridLegendEntry | null;
  scope: FdmGridSelectionScope;
  snapshotCell: FdmGridSelectionCell | null;
  status: "current" | "degraded" | "stale";
  support: FdmMagneticSupportSummary | null;
  title: string;
}

type BinarySnapshot = Pick<
  ResourceResult<DecodedFdmRegionMembership | null>,
  "data" | "error" | "status"
>;

const SCOPE_TITLES: Record<FdmGridSelectionScope, string> = {
  "active-unassigned": "Active / Unassigned Cells",
  cell: "FDM Cell",
  descriptor: "Structured Grid Descriptor",
  domain: "FDM Domain",
  "magnetic-support": "Magnetic Support",
  mask: "Cell Mask",
  provenance: "Grid Provenance",
  region: "FDM Region",
  "universe-outside-support": "Airbox Visualization",
};

function supportSummary(
  grid: Pick<FdmGridInspectorModel, "origin" | "shape" | "spacing">,
  membership: FdmRegionMembershipResource | null,
): FdmMagneticSupportSummary | null {
  const support = membership?.magnetic_support;
  const boundsMin = tuple3(support?.bounds_min_m);
  const boundsMax = tuple3(support?.bounds_max_m);
  const origin = grid.origin;
  const shape = grid.shape;
  const spacing = grid.spacing;
  const cellEdgeIndex = (value: number, axis: number): number | null => {
    const offset = (value - origin![axis]) / spacing![axis];
    const rounded = Math.round(offset);
    const tolerance = 1e-9 * Math.max(1, Math.abs(offset));
    if (Math.abs(offset - rounded) > tolerance) return null;
    return rounded >= 0 && rounded <= shape![axis] ? rounded : null;
  };
  if (
    !support ||
    !origin ||
    !shape ||
    !spacing ||
    spacing.some((value) => !Number.isFinite(value) || value <= 0) ||
    support.semantic_role !== "magnetic-support" ||
    support.grid_fingerprint !== membership.grid_fingerprint ||
    !boundsMin ||
    !boundsMax ||
    boundsMin.some((value, index) => value > boundsMax[index]) ||
    boundsMin.some(
      (value, index) => cellEdgeIndex(value, index) === null,
    ) ||
    boundsMax.some(
      (value, index) => cellEdgeIndex(value, index) === null,
    ) ||
    ![
      support.active_cell_count,
      support.active_unassigned_cell_count,
      support.inactive_cell_count,
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    support.active_cell_count + support.inactive_cell_count !== membership.cell_count ||
    support.active_unassigned_cell_count > support.active_cell_count ||
    (support.active_cell_count > 0 &&
      boundsMin.some((value, index) => value >= boundsMax[index]))
  ) {
    return null;
  }
  return {
    activeCellCount: support.active_cell_count,
    activeUnassignedCellCount: support.active_unassigned_cell_count,
    boundsMax,
    boundsMin,
    inactiveCellCount: support.inactive_cell_count,
  };
}

function snapshotCell(
  selection: Selection,
): FdmGridSelectionCell | null {
  const ref = selection.ref?.type === "fdm-cell" ? selection.ref : null;
  return ref
    ? {
        cellOrdinal: ref.cellOrdinal,
        gridFingerprint: ref.gridFingerprint,
        ijk: ref.ijk,
        maskState: ref.maskState,
        membershipRevision: ref.membershipRevision,
        numericRegionId: ref.numericRegionId,
        regionId: ref.regionId,
      }
    : null;
}

function selectionScope(selection: Selection): FdmGridSelectionScope {
  if (selection.ref?.type === "fdm-cell") return "cell";
  if (selection.ref?.type !== "fdm-domain") return "domain";
  const scope = selection.ref.scope;
  return scope === "common" ||
    scope === "layers" ||
    scope === "layer" ||
    scope === "layer-native-grid" ||
    scope === "layer-mask" ||
    scope === "layer-transfer" ||
    scope === "layer-provenance"
    ? "domain"
    : scope;
}

function staleSelection(
  scope: FdmGridSelectionScope,
  snapshot: FdmGridSelectionCell | null,
  notice: string,
): FdmGridSelectionInspectorModel {
  return {
    cell: null,
    notice,
    region: null,
    scope,
    snapshotCell: snapshot,
    status: "stale",
    support: null,
    title: SCOPE_TITLES[scope],
  };
}

export function resolveFdmGridSelectionInspectorModel({
  base,
  binary,
  membership,
  selection,
}: {
  base: FdmGridInspectorModel;
  binary: BinarySnapshot;
  membership: ResourceSnapshot<FdmRegionMembershipResource>;
  selection: Selection;
}): FdmGridSelectionInspectorModel {
  const scope = selectionScope(selection);
  const snapshot = snapshotCell(selection);
  const descriptor = membership.data;
  const common = {
    cell: null,
    notice: null,
    region: null,
    scope,
    snapshotCell: snapshot,
    status: "current" as const,
    support: null,
    title: SCOPE_TITLES[scope],
  };

  if (base.status !== "ready" || !descriptor) {
    return {
      ...common,
      notice: base.notice ?? "Current FDM grid resources are unavailable.",
      status: base.status === "stale" ? "stale" : "degraded",
    };
  }

  if (
    scope === "magnetic-support" ||
    scope === "active-unassigned" ||
    scope === "universe-outside-support"
  ) {
    const support = supportSummary(base, descriptor);
    return support
      ? { ...common, support }
      : {
          ...common,
          notice:
            "The canonical magnetic-support summary is not published or does not match the current grid; support facts are withheld.",
          status: "degraded",
          support: null,
        };
  }

  if (scope === "region") {
    const regionRef = selection.ref?.type === "fdm-domain"
      ? selection.ref
      : null;
    const regionId = regionRef?.regionId?.trim() || null;
    const ownerId = regionRef?.objectId?.trim() || null;
    const candidates = regionId
      ? (base.membership?.legend.filter((candidate) => candidate.regionId === regionId) ?? [])
      : [];
    // Region ids are object-scoped. Legacy selections may omit objectId, but
    // must not silently resolve an ambiguous duplicate to the first owner.
    const entry = ownerId
      ? candidates.find((candidate) => candidate.objectId === ownerId) ?? null
      : candidates.length === 1
        ? candidates[0]
        : null;
    return entry
      ? { ...common, region: entry }
      : {
          ...common,
          notice: "The selected FDM region is not present in the current membership legend.",
          status: "stale",
        };
  }

  if (scope !== "cell" || !snapshot) return common;

  const decoded = binary.data;
  const expectedRevision = `${descriptor.mesh_revision}:${descriptor.region_membership_revision}`;
  const ordinal = Number(snapshot.cellOrdinal);
  if (
    binary.status !== "ready" ||
    binary.error ||
    !decoded ||
    decoded.semanticStatus !== "canonical" ||
    decoded.gridFingerprint !== descriptor.grid_fingerprint ||
    decoded.cellCount !== descriptor.cell_count ||
    decoded.counts.some((value, index) => value !== descriptor.counts[index]) ||
    snapshot.gridFingerprint !== descriptor.grid_fingerprint ||
    snapshot.membershipRevision !== expectedRevision ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= decoded.cellCount
  ) {
    return staleSelection(
      scope,
      snapshot,
      "The selected FDM cell identity does not match the current grid or membership resource.",
    );
  }

  const nx = descriptor.counts[0];
  const ny = descriptor.counts[1];
  const expectedIJK: [number, number, number] = [
    ordinal % nx,
    Math.floor(ordinal / nx) % ny,
    Math.floor(ordinal / (nx * ny)),
  ];
  const numericRegionId = decoded.regionIds[ordinal];
  if (numericRegionId === undefined) {
    return staleSelection(scope, snapshot, "The selected FDM cell is absent from the current mask.");
  }
  const state = resolveFdmCellState(numericRegionId, descriptor);
  if (
    snapshot.ijk.some((value, index) => value !== expectedIJK[index]) ||
    snapshot.maskState !== state.kind ||
    snapshot.numericRegionId !== state.numericRegionId ||
    snapshot.regionId !== state.regionId
  ) {
    return staleSelection(
      scope,
      snapshot,
      "The selected FDM cell details do not match the current membership mask.",
    );
  }

  return { ...common, cell: snapshot };
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
