import type {
  FdmRegionMembershipResource,
  RegionDiagnosticsResource,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import {
  fdmCellCenter,
  type FdmCellPhysicsTarget,
  type FdmCellQuantitySample,
} from "@/kernel/resources/fdmCellPhysicsResources";
import type { FdmCellMaskState } from "@/kernel/selection/selectionTypes";
import type { InspectorPanelProps } from "@/modules/inspector/shared";
import {
  FMRM_INACTIVE_REGION_ID,
  resolveFdmCellState,
} from "@/shared/domain/mesh/domainPresentation";

import {
  ELEMENTARY_CHARGE_J,
  sanitizeDisplayReason,
  tuple3OrNull,
} from "./fdmShared";

export interface FdmCellDraft {
  energyUnitMode: "density_jm3" | "cell_ev" | "cell_aj";
}

type SelectionPanelSelection = InspectorPanelProps["selection"];

export const MATERIAL_ORDER: Readonly<Record<string, number>> = {
  mat_aex: 1,
  mat_alpha: 2,
  mat_ms: 0,
};

const MATERIAL_SHORT_LABELS: Readonly<Record<string, string>> = {
  mat_aex: "Aex",
  mat_alpha: "α",
  mat_ms: "Ms",
};

export const ENERGY_ORDER: Readonly<Record<string, number>> = {
  eden_ani: 2,
  eden_demag: 1,
  eden_dmi: 3,
  eden_ex: 0,
  eden_ext: 4,
  eden_total: 5,
};

const ENERGY_SHORT_LABELS: Readonly<Record<string, string>> = {
  eden_ani: "Anisotropy",
  eden_demag: "Demagnetizing",
  eden_dmi: "DMI",
  eden_ex: "Exchange",
  eden_ext: "Zeeman",
  eden_total: "Total",
};

const cellNumberFormatter = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
});

export function formatCellScalar(value: number): string {
  if (!Number.isFinite(value)) return "Not published";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(3);
  return cellNumberFormatter.format(value);
}

export function isSupportedEnergyDensityUnit(unit: string): boolean {
  const clean = unit.trim();
  return clean === "J/m³" || clean === "J/m^3";
}

export function formatSampleSourceProvenance(
  row: FdmCellQuantitySample,
): string | null {
  const parts: string[] = [];
  if (row.sourceStep !== null && Number.isFinite(row.sourceStep)) {
    parts.push(`step ${row.sourceStep.toLocaleString("en-US")}`);
  }
  if (row.sourceTimeSeconds !== null && Number.isFinite(row.sourceTimeSeconds)) {
    parts.push(`t = ${formatCellScalar(row.sourceTimeSeconds)} s`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function quantityShortLabel(row: FdmCellQuantitySample): string {
  if (row.group === "material") {
    return MATERIAL_SHORT_LABELS[row.id] ?? row.label;
  }
  if (row.group === "energy") {
    return ENERGY_SHORT_LABELS[row.id] ?? row.label;
  }
  return "m";
}

function parseNonNegativeSafeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

export interface ResolvedFdmSelectedCell {
  ordinal: number;
  cellOrdinal: string;
  ijk: [number, number, number];
  maskState: FdmCellMaskState | null;
  numericRegionId: number | null;
  regionId: string | null;
  membershipRevision: string;
  gridFingerprint: string;
  verificationStatus: "verified" | "stale" | "pending";
  notice: string | null;
  target: FdmCellPhysicsTarget | null;
}

/**
 * Resolves a picked 3D FDM voxel (`ref.cellOrdinal: string`) or unit-test cell
 * (`ref.ordinal: number`), validates it against the decoded binary FMRM mask
 * and multilayer/vacuum guards, and constructs `FdmCellPhysicsTarget` when valid.
 */
export function resolveFdmSelectedCell({
  selection,
  shape,
  origin,
  spacing,
  generationId,
  membership,
  binaryData,
  binaryStatus,
  binaryHookAvailable,
  isMultilayer,
  multilayerReady,
}: {
  selection: SelectionPanelSelection;
  shape: readonly [number, number, number];
  origin: readonly [number, number, number];
  spacing: readonly [number, number, number];
  generationId: string;
  membership: FdmRegionMembershipResource | null;
  binaryData: DecodedFdmRegionMembership | null;
  binaryStatus: string;
  binaryHookAvailable: boolean;
  isMultilayer: boolean;
  multilayerReady: boolean;
}): ResolvedFdmSelectedCell {
  const ref = selection.ref as Record<string, unknown> | null;
  const nx = Math.max(1, shape[0] || 1);
  const ny = Math.max(1, shape[1] || 1);

  const nodeOrdinal = selection.nodeId?.startsWith("fdm:cell:")
    ? parseNonNegativeSafeInt(selection.nodeId.slice("fdm:cell:".length))
    : null;
  const parsedOrdinal =
    parseNonNegativeSafeInt(ref?.cellOrdinal) ??
    parseNonNegativeSafeInt(ref?.ordinal) ??
    nodeOrdinal ??
    0;

  const expectedIjkFromOrdinal: [number, number, number] = [
    parsedOrdinal % nx,
    Math.floor(parsedOrdinal / nx) % ny,
    Math.floor(parsedOrdinal / (nx * ny)),
  ];

  const rawIjk = tuple3OrNull(
    Array.isArray(ref?.ijk) ? (ref.ijk as readonly number[]) : null,
  );
  const ijk: [number, number, number] = rawIjk
    ? [Math.trunc(rawIjk[0]), Math.trunc(rawIjk[1]), Math.trunc(rawIjk[2])]
    : expectedIjkFromOrdinal;

  const expectedMembershipRevision =
    membership &&
    typeof membership.mesh_revision === "number" &&
    typeof membership.region_membership_revision === "number"
      ? `${membership.mesh_revision}:${membership.region_membership_revision}`
      : String(ref?.membershipRevision ?? "1:1");

  const gridFingerprint = String(
    membership?.grid_fingerprint ?? ref?.gridFingerprint ?? "",
  );
  const refGridFingerprint =
    typeof ref?.gridFingerprint === "string" ? ref.gridFingerprint : "";
  const refMembershipRevision =
    typeof ref?.membershipRevision === "string" ? ref.membershipRevision : "";
  const refMaskState =
    ref?.maskState === "inactive" ||
    ref?.maskState === "active-unassigned" ||
    ref?.maskState === "region"
      ? ref.maskState
      : null;
  const refNumericRegionId =
    typeof ref?.numericRegionId === "number" ? ref.numericRegionId : null;
  const refRegionId =
    typeof ref?.regionId === "string" ? ref.regionId : null;

  if (!ref) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: null,
      membershipRevision: expectedMembershipRevision,
      notice: "Select a current FDM cell to inspect its published physics.",
      numericRegionId: null,
      ordinal: parsedOrdinal,
      regionId: null,
      target: null,
      verificationStatus: "pending",
    };
  }

  // Multilayer guard: common convolution grid is FFT scratch, not a physical cell carrier
  if (isMultilayer) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint: refGridFingerprint || gridFingerprint,
      ijk,
      maskState: refMaskState,
      membershipRevision: refMembershipRevision || expectedMembershipRevision,
      notice:
        "Cell physics requires a physical single-grid FDM cell; the common multilayer grid is not a material carrier.",
      numericRegionId: refNumericRegionId,
      ordinal: parsedOrdinal,
      regionId: refRegionId,
      target: null,
      verificationStatus: "pending",
    };
  }

  let resolvedMaskState: FdmCellMaskState | null = refMaskState;
  let resolvedNumericId: number | null = refNumericRegionId;
  let resolvedRegionId: string | null = refRegionId;
  let verificationStatus: ResolvedFdmSelectedCell["verificationStatus"] = "pending";

  // Binary FMRM decoding & canonical identity verification
  if (binaryStatus === "ready" && binaryData && membership) {
    if (
      binaryData.semanticStatus !== "canonical" ||
      (membership.grid_fingerprint &&
        binaryData.gridFingerprint !== membership.grid_fingerprint) ||
      (refGridFingerprint &&
        membership.grid_fingerprint &&
        refGridFingerprint !== membership.grid_fingerprint) ||
      (refMembershipRevision &&
        typeof membership.mesh_revision === "number" &&
        refMembershipRevision !== expectedMembershipRevision) ||
      parsedOrdinal < 0 ||
      parsedOrdinal >= binaryData.cellCount
    ) {
      return {
        cellOrdinal: String(parsedOrdinal),
        gridFingerprint: refGridFingerprint || gridFingerprint,
        ijk,
        maskState: refMaskState,
        membershipRevision: refMembershipRevision || expectedMembershipRevision,
        notice:
          "The selected FDM cell identity does not match the current grid or membership resource.",
        numericRegionId: refNumericRegionId,
        ordinal: parsedOrdinal,
        regionId: refRegionId,
        target: null,
        verificationStatus: "stale",
      };
    }

    const decodedNumeric = binaryData.regionIds[parsedOrdinal];
    if (decodedNumeric === undefined) {
      return {
        cellOrdinal: String(parsedOrdinal),
        gridFingerprint,
        ijk,
        maskState: refMaskState,
        membershipRevision: expectedMembershipRevision,
        notice: "The selected FDM cell is absent from the current mask.",
        numericRegionId: null,
        ordinal: parsedOrdinal,
        regionId: null,
        target: null,
        verificationStatus: "stale",
      };
    }

    const state = resolveFdmCellState(decodedNumeric, membership);
    const binNx = Math.max(1, binaryData.counts[0] || nx);
    const binNy = Math.max(1, binaryData.counts[1] || ny);
    const expectedBinIjk: [number, number, number] = [
      parsedOrdinal % binNx,
      Math.floor(parsedOrdinal / binNx) % binNy,
      Math.floor(parsedOrdinal / (binNx * binNy)),
    ];

    if (
      (rawIjk && expectedBinIjk.some((val, idx) => val !== ijk[idx])) ||
      (refMaskState !== null && refMaskState !== state.kind) ||
      (ref?.numericRegionId !== undefined &&
        refNumericRegionId !== state.numericRegionId) ||
      (ref?.regionId !== undefined && refRegionId !== state.regionId)
    ) {
      return {
        cellOrdinal: String(parsedOrdinal),
        gridFingerprint: refGridFingerprint || gridFingerprint,
        ijk,
        maskState: refMaskState,
        membershipRevision: refMembershipRevision || expectedMembershipRevision,
        notice:
          "The selected FDM cell details do not match the current membership mask.",
        numericRegionId: refNumericRegionId,
        ordinal: parsedOrdinal,
        regionId: refRegionId,
        target: null,
        verificationStatus: "stale",
      };
    }

    resolvedMaskState = state.kind;
    resolvedNumericId = state.numericRegionId;
    resolvedRegionId = state.regionId;
    verificationStatus = "verified";
  } else if (
    membership &&
    ((refGridFingerprint &&
      membership.grid_fingerprint &&
      refGridFingerprint !== membership.grid_fingerprint) ||
      (refMembershipRevision &&
        typeof membership.mesh_revision === "number" &&
        refMembershipRevision !== expectedMembershipRevision))
  ) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint: refGridFingerprint || gridFingerprint,
      ijk,
      maskState: refMaskState,
      membershipRevision: refMembershipRevision || expectedMembershipRevision,
      notice:
        "The selected FDM cell identity does not match the current grid or membership resource.",
      numericRegionId: refNumericRegionId,
      ordinal: parsedOrdinal,
      regionId: refRegionId,
      target: null,
      verificationStatus: "stale",
    };
  } else if (binaryHookAvailable && binaryStatus === "loading") {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: resolvedMaskState,
      membershipRevision: expectedMembershipRevision,
      notice:
        "Waiting for current FDM grid classification before reading cell physics.",
      numericRegionId: resolvedNumericId,
      ordinal: parsedOrdinal,
      regionId: resolvedRegionId,
      target: null,
      verificationStatus: "pending",
    };
  } else if (binaryHookAvailable && binaryStatus === "error") {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: resolvedMaskState,
      membershipRevision: expectedMembershipRevision,
      notice: "FDM binary region membership could not be verified for this cell.",
      numericRegionId: resolvedNumericId,
      ordinal: parsedOrdinal,
      regionId: resolvedRegionId,
      target: null,
      verificationStatus: "stale",
    };
  } else if (!multilayerReady && binaryHookAvailable) {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: resolvedMaskState,
      membershipRevision: expectedMembershipRevision,
      notice:
        "Waiting for current FDM grid classification before reading cell physics.",
      numericRegionId: resolvedNumericId,
      ordinal: parsedOrdinal,
      regionId: resolvedRegionId,
      target: null,
      verificationStatus: "pending",
    };
  }

  // Vacuum / outside-support guard: inactive voxels have no magnetic state
  if (resolvedMaskState === "inactive") {
    return {
      cellOrdinal: String(parsedOrdinal),
      gridFingerprint,
      ijk,
      maskState: "inactive",
      membershipRevision: expectedMembershipRevision,
      notice: "This cell is outside the magnetic support.",
      numericRegionId: null,
      ordinal: parsedOrdinal,
      regionId: null,
      target: null,
      verificationStatus,
    };
  }

  const refCellSize = tuple3OrNull(
    Array.isArray(ref.cellSizeM) ? (ref.cellSizeM as readonly number[]) : null,
  );
  const cellSizeM: [number, number, number] = refCellSize ?? [
    spacing[0] || 2e-9,
    spacing[1] || 2e-9,
    spacing[2] || 2e-9,
  ];
  const refCenter = tuple3OrNull(
    Array.isArray(ref.centerM) ? (ref.centerM as readonly number[]) : null,
  );
  const centerM: [number, number, number] =
    refCenter ?? fdmCellCenter(origin, cellSizeM, ijk);

  const meshRevision =
    typeof membership?.mesh_revision === "number"
      ? membership.mesh_revision
      : (parseNonNegativeSafeInt(ref.meshRevision) ?? 1);

  return {
    cellOrdinal: String(parsedOrdinal),
    gridFingerprint,
    ijk,
    maskState: resolvedMaskState,
    membershipRevision: expectedMembershipRevision,
    notice: null,
    numericRegionId: resolvedNumericId,
    ordinal: parsedOrdinal,
    regionId: resolvedRegionId,
    target: {
      cellSizeM,
      centerM,
      generationId: String(ref.generationId ?? generationId),
      gridFingerprint,
      membershipRevision: expectedMembershipRevision,
      meshRevision,
      ordinal: parsedOrdinal,
    },
    verificationStatus,
  };
}

export function resolveBoundaryInterfaceClassification(
  ijk: readonly [number, number, number],
  shape: readonly [number, number, number],
  ordinal: number,
  binaryData: DecodedFdmRegionMembership | null,
  membership: FdmRegionMembershipResource | null,
): string {
  const [ix, iy, iz] = ijk;
  const [nx, ny, nz] = shape;
  const boundaryFaces: string[] = [];
  if (ix <= 0) boundaryFaces.push("−X");
  if (ix >= nx - 1) boundaryFaces.push("+X");
  if (iy <= 0) boundaryFaces.push("−Y");
  if (iy >= ny - 1) boundaryFaces.push("+Y");
  if (iz <= 0) boundaryFaces.push("−Z");
  if (iz >= nz - 1) boundaryFaces.push("+Z");

  if (!binaryData || ordinal < 0 || ordinal >= binaryData.cellCount) {
    return boundaryFaces.length > 0
      ? `Outer grid boundary (${boundaryFaces.join(", ")})`
      : "Interior lattice coordinate";
  }

  const centerId = binaryData.regionIds[ordinal];
  const deltas: readonly (readonly [number, number, number])[] = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
  ];

  let touchesVacuum = false;
  const adjacentRegions = new Set<string>();

  for (const [dx, dy, dz] of deltas) {
    const ni = ix + dx;
    const nj = iy + dy;
    const nk = iz + dz;
    if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) {
      continue;
    }
    const nOrd = ni + nj * nx + nk * nx * ny;
    const neighborId = binaryData.regionIds[nOrd];
    if (neighborId === undefined || neighborId === centerId) continue;
    if (
      neighborId === FMRM_INACTIVE_REGION_ID ||
      centerId === FMRM_INACTIVE_REGION_ID
    ) {
      touchesVacuum = true;
    } else {
      const nbState = resolveFdmCellState(neighborId, membership);
      adjacentRegions.add(
        nbState.kind === "active-unassigned"
          ? "unassigned support"
          : (nbState.regionId ?? `numeric #${nbState.numericRegionId ?? neighborId}`),
      );
    }
  }

  const tags: string[] = [];
  if (adjacentRegions.size > 0) {
    tags.push(`Region interface (${[...adjacentRegions].join(", ")})`);
  }
  if (touchesVacuum) {
    tags.push("Support–vacuum boundary");
  }
  if (boundaryFaces.length > 0) {
    tags.push(`Outer grid boundary (${boundaryFaces.join(", ")})`);
  }
  return tags.length > 0 ? tags.join(" · ") : "Interior voxel (homogeneous 6-stencil)";
}

export function formatEnergyRowValue(
  row: FdmCellQuantitySample,
  volumeM3: number,
  mode: FdmCellDraft["energyUnitMode"],
): string {
  if (
    row.status !== "ready" ||
    !isSupportedEnergyDensityUnit(row.unit) ||
    row.scalar === null ||
    !Number.isFinite(row.scalar)
  ) {
    return "Not published";
  }
  if (mode === "density_jm3") {
    const cellJoules = row.scalar * volumeM3;
    const cellPart = Number.isFinite(cellJoules)
      ? ` (${formatCellScalar(cellJoules)} J)`
      : "";
    return `${formatCellScalar(row.scalar)} J/m³${cellPart}`;
  }
  const joules = row.scalar * volumeM3;
  if (!Number.isFinite(joules)) return "Not published";
  if (mode === "cell_ev") {
    return `${(joules / ELEMENTARY_CHARGE_J).toFixed(4)} eV`;
  }
  return `${(joules * 1e18).toFixed(4)} aJ`;
}

export function resolveFdmCellProvenance(input: {
  binaryData: DecodedFdmRegionMembership | null;
  generationId: string | null | undefined;
  ijk: readonly [number, number, number];
  materialRows: readonly FdmCellQuantitySample[];
  membership: FdmRegionMembershipResource | null;
  regionDiagnosticsData: RegionDiagnosticsResource | null;
  regionsData: RegionListResource | null;
  resolvedCell: ResolvedFdmSelectedCell;
  sceneObjects: SceneResource["objects"] | undefined;
  selection: SelectionPanelSelection;
  shape: readonly [number, number, number];
}) {
  const {
    binaryData,
    generationId,
    ijk,
    materialRows,
    membership,
    regionDiagnosticsData,
    regionsData,
    resolvedCell,
    sceneObjects,
    selection,
    shape,
  } = input;

  const rawRef = (selection.ref ?? {}) as Record<string, unknown>;
  const legendList = membership?.region_legend ?? [];
  const matchedLegend =
    resolvedCell.numericRegionId != null
      ? (legendList.find(
          (entry) => entry.numeric_id === resolvedCell.numericRegionId,
        ) ?? null)
      : resolvedCell.regionId
        ? (legendList.find(
            (entry) => entry.region_id === resolvedCell.regionId,
          ) ?? null)
        : null;

  const ownerId =
    matchedLegend?.object_id ??
    (membership?.object_ids?.length === 1 ? membership.object_ids[0] : null) ??
    selection.objectId ??
    null;
  const ownerObject = ownerId
    ? (sceneObjects?.find((obj) => obj.id === ownerId) ?? null)
    : null;

  const authoredRegion =
    resolvedCell.regionId && regionsData?.regions
      ? (regionsData.regions.find(
          (reg) =>
            reg.region_id === resolvedCell.regionId &&
            (!ownerId || !reg.owner_object_id || reg.owner_object_id === ownerId),
        ) ?? null)
      : null;

  const regionSource =
    typeof rawRef.regionSource === "string" && rawRef.regionSource.trim()
      ? rawRef.regionSource.trim()
      : authoredRegion?.source
        ? authoredRegion.source
        : resolvedCell.maskState === "region"
          ? "Explicit sub-object region mask (FMRM v2)"
          : resolvedCell.maskState === "active-unassigned"
            ? "Object magnetic support (unassigned)"
            : resolvedCell.maskState === "inactive"
              ? "Outside magnetic support (Airbox)"
              : "Pending canonical FMRM verification";

  const dominantObjectRegion =
    typeof rawRef.dominantObjectRegion === "string" &&
    rawRef.dominantObjectRegion.trim()
      ? rawRef.dominantObjectRegion.trim()
      : matchedLegend
        ? `${ownerObject?.name ? `${ownerObject.name} (${matchedLegend.object_id})` : matchedLegend.object_id} / ${matchedLegend.region_id} (priority ${matchedLegend.priority})`
        : resolvedCell.maskState === "inactive"
          ? "None (outside magnetic support)"
          : ownerObject
            ? `${ownerObject.name || ownerObject.id} (unassigned support)`
            : membership?.object_ids?.length
              ? membership.object_ids.join(", ")
              : "Active magnetic support";

  const materialAssignment =
    typeof rawRef.materialAssignment === "string" &&
    rawRef.materialAssignment.trim()
      ? rawRef.materialAssignment.trim()
      : resolvedCell.maskState === "inactive"
        ? "Vacuum (μ₀)"
        : authoredRegion?.material_ref
          ? `${authoredRegion.material_ref}${authoredRegion.material_overrides?.length ? ` (${authoredRegion.material_overrides.length} override(s))` : ""}`
          : ownerObject?.material_ref
            ? `${ownerObject.material_ref} (inherited from ${ownerObject.name || ownerObject.id})`
            : materialRows.some((r) => r.status === "ready")
              ? "Published cell coefficients"
              : "Default object material";

  const boundaryInterface =
    typeof rawRef.boundaryInterface === "string" &&
    rawRef.boundaryInterface.trim()
      ? rawRef.boundaryInterface.trim()
      : resolveBoundaryInterfaceClassification(
          ijk,
          shape,
          resolvedCell.ordinal,
          binaryData,
          membership,
        );

  const siblingLegendEntries = matchedLegend
    ? legendList.filter(
        (entry) =>
          entry.object_id === matchedLegend.object_id &&
          entry.numeric_id !== matchedLegend.numeric_id,
      )
    : [];
  const competingRegions =
    typeof rawRef.competingRegions === "string" &&
    rawRef.competingRegions.trim()
      ? rawRef.competingRegions.trim()
      : Array.isArray(rawRef.competingRegions) && rawRef.competingRegions.length > 0
        ? rawRef.competingRegions.map(String).join(", ")
        : siblingLegendEntries.length > 0
          ? `${siblingLegendEntries
              .map((s) => `${s.region_id} (priority ${s.priority})`)
              .join(", ")} — resolved by priority ${matchedLegend?.priority ?? 0}`
          : "None";

  const matchedClipDiag =
    resolvedCell.regionId && regionDiagnosticsData?.diagnostics
      ? (regionDiagnosticsData.diagnostics.find(
          (diag) =>
            diag.region_id === resolvedCell.regionId &&
            (!ownerId || diag.owner_object_id === ownerId) &&
            /clip|bound|outside|truncat/i.test(`${diag.code} ${diag.message}`),
        ) ?? null)
      : null;
  const clippedReason =
    typeof rawRef.clippedReason === "string" && rawRef.clippedReason.trim()
      ? rawRef.clippedReason.trim()
      : matchedClipDiag
        ? sanitizeDisplayReason(matchedClipDiag.message, matchedClipDiag.code)
        : resolvedCell.maskState === "region"
          ? "Bounded to parent magnetic support mask"
          : resolvedCell.maskState === "inactive"
            ? "Excluded outside magnetic support"
            : "None (unclipped voxel)";

  const genLabel = generationId ?? "pending";
  const fpLabel = resolvedCell.gridFingerprint || "pending";
  const activeGridProvenance = `${genLabel} · ${fpLabel} · rev ${resolvedCell.membershipRevision}`;

  return {
    activeGridProvenance,
    boundaryInterface,
    clippedReason,
    competingRegions,
    dominantObjectRegion,
    materialAssignment,
    regionSource,
  };
}
