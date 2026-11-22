"use client";

import {
  Atom,
  Compass,
  Grid3x3,
  History,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, type ReactNode } from "react";

import { DATA_FIELDS_PATH } from "@/kernel/api/apiPaths";
import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";
import type { DecodedFdmRegionMembership } from "@/kernel/api/codecs/fdmRegionMembershipCodec";
import { useKernel } from "@/kernel/KernelContext";
import {
  fdmCellCenter,
  useFdmCellPhysicsResource,
} from "@/kernel/resources/fdmCellPhysicsResources";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import {
  SpecInspectorHost,
  type InspectorActionContext,
  type InspectorNotice,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";
import { resolveFdmCellState } from "@/shared/domain/mesh/domainPresentation";
import { Button } from "@/shared/ui/Button";

import {
  ENERGY_ORDER,
  formatCellScalar,
  formatEnergyRowValue,
  formatSampleSourceProvenance,
  isSupportedEnergyDensityUnit,
  MATERIAL_ORDER,
  quantityShortLabel,
  resolveFdmCellProvenance,
  resolveFdmSelectedCell,
  type FdmCellDraft,
} from "./fdmCellModel";
import {
  fmtCoord3,
  fmtTuple3,
  sanitizeDisplayReason,
  useDomainMetaResourceSafe,
  useFdmMultilayerLayoutResourceSafe,
  useFdmRegionMembershipBinaryResourceSafe,
  useFdmRegionMembershipResourceSafe,
  useModelRegionDiagnosticsResourceSafe,
  useModelRegionsResourceSafe,
  useSceneResourceSafe,
} from "./fdmShared";

export {
  resolveFdmSelectedCell,
  type FdmCellDraft,
  type ResolvedFdmSelectedCell,
} from "./fdmCellModel";

function SixNeighborStencil({
  binaryData,
  ctx,
  gridFingerprint,
  ijk,
  membership,
  membershipRevision,
  shape,
}: {
  binaryData: DecodedFdmRegionMembership | null;
  ctx: InspectorActionContext<FdmCellDraft>;
  gridFingerprint: string;
  ijk: readonly [number, number, number];
  membership: FdmRegionMembershipResource | null;
  membershipRevision: string;
  shape: readonly [number, number, number];
}): ReactNode {
  const [ix, iy, iz] = ijk;
  const [nx, ny, nz] = shape;
  const neighbors = [
    { delta: [-1, 0, 0] as const, id: "-x", label: "−X" },
    { delta: [1, 0, 0] as const, id: "+x", label: "+X" },
    { delta: [0, -1, 0] as const, id: "-y", label: "−Y" },
    { delta: [0, 1, 0] as const, id: "+y", label: "+Y" },
    { delta: [0, 0, -1] as const, id: "-z", label: "−Z" },
    { delta: [0, 0, 1] as const, id: "+z", label: "+Z" },
  ];

  return (
    <div className="fm-fdm-neighbor-grid" role="group" aria-label="6-neighbor voxel stencil">
      {neighbors.map((nb) => {
        const ni = ix + nb.delta[0];
        const nj = iy + nb.delta[1];
        const nk = iz + nb.delta[2];
        const inBounds = ni >= 0 && ni < nx && nj >= 0 && nj < ny && nk >= 0 && nk < nz;
        const nextOrdinal = ni + nj * nx + nk * nx * ny;
        return (
          <Button
            key={nb.id}
            className="fm-fdm-neighbor-grid__cell"
            disabled={!inBounds}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              if (!inBounds) return;
              const rawNeighborId =
                binaryData && nextOrdinal >= 0 && nextOrdinal < binaryData.cellCount
                  ? binaryData.regionIds[nextOrdinal]
                  : undefined;
              const neighborState =
                rawNeighborId !== undefined
                  ? resolveFdmCellState(rawNeighborId, membership)
                  : {
                      kind: "active-unassigned" as const,
                      numericRegionId: 0,
                      regionId: null,
                    };
              const cellRef: Extract<SelectionRef, { type: "fdm-cell" }> = {
                cellOrdinal: String(nextOrdinal),
                gridFingerprint,
                ijk: [ni, nj, nk],
                kind: "fdm.cell",
                maskState: neighborState.kind,
                membershipRevision,
                nodeId: "model:mesh:grid",
                numericRegionId: neighborState.numericRegionId,
                regionId: neighborState.regionId,
                type: "fdm-cell",
                visualizationTargetId: "fdm-domain",
              };
              ctx.selectNode({
                kind: "fdm.cell",
                label: `FDM Voxel (${ni}, ${nj}, ${nk})`,
                nodeId: `fdm:cell:${nextOrdinal}`,
                objectId: null,
                ref: cellRef,
              });
            }}
          >
            <span>{nb.label}</span>
            <span>{inBounds ? `(${ni}, ${nj}, ${nk})` : "Boundary"}</span>
          </Button>
        );
      })}
    </div>
  );
}

export function FdmCellInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const domainMeta = useDomainMetaResourceSafe();
  const multilayerRes = useFdmMultilayerLayoutResourceSafe();
  const membershipRes = useFdmRegionMembershipResourceSafe({ enabled: true });
  const sceneRes = useSceneResourceSafe();
  const regionsRes = useModelRegionsResourceSafe();
  const regionDiagnosticsRes = useModelRegionDiagnosticsResourceSafe();

  const isMultilayer = Boolean(multilayerRes.data?.available);
  const membership = membershipRes.data ?? null;
  const membershipRevisionToken =
    membership &&
    typeof membership.mesh_revision === "number" &&
    typeof membership.region_membership_revision === "number"
      ? `${membership.mesh_revision}:${membership.region_membership_revision}`
      : null;

  const binaryHookAvailable = Boolean(
    geometryLifecycleResources.useFdmRegionMembershipBinaryResource,
  );
  const binaryRes = useFdmRegionMembershipBinaryResourceSafe(null, {
    enabled: !isMultilayer,
    revision: membershipRevisionToken,
  });

  const shape: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.shape ?? [1, 1, 1];
    return [raw[0] ?? 1, raw[1] ?? 1, raw[2] ?? 1];
  }, [domainMeta.data?.grid?.shape]);

  const spacing: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.spacing ?? [2e-9, 2e-9, 2e-9];
    return [raw[0] ?? 2e-9, raw[1] ?? 2e-9, raw[2] ?? 2e-9];
  }, [domainMeta.data?.grid?.spacing]);

  const origin: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.origin ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.origin]);

  const resolvedCell = useMemo(
    () =>
      resolveFdmSelectedCell({
        binaryData: binaryRes.data,
        binaryHookAvailable,
        binaryStatus: binaryRes.status,
        generationId: domainMeta.data?.generation_id ?? "gen",
        isMultilayer,
        membership,
        multilayerReady:
          multilayerRes.status === "ready" ||
          multilayerRes.status === "error" ||
          !binaryHookAvailable,
        origin,
        selection,
        shape,
        spacing,
      }),
    [
      binaryHookAvailable,
      binaryRes.data,
      binaryRes.status,
      domainMeta.data?.generation_id,
      isMultilayer,
      membership,
      multilayerRes.status,
      origin,
      selection,
      shape,
      spacing,
    ],
  );

  const { ijk, target } = resolvedCell;

  const cellPhysics = useFdmCellPhysicsResource(target);
  const snapshot =
    target !== null && cellPhysics.status === "ready" ? cellPhysics.data : null;

  const rows = useMemo(() => snapshot?.rows ?? [], [snapshot?.rows]);
  const materialRows = useMemo(
    () =>
      rows
        .filter((r) => r.group === "material")
        .sort(
          (a, b) =>
            (MATERIAL_ORDER[a.id] ?? 100) - (MATERIAL_ORDER[b.id] ?? 100) ||
            a.id.localeCompare(b.id),
        ),
    [rows],
  );
  const magRow = useMemo(
    () => rows.find((r) => r.group === "magnetization") ?? null,
    [rows],
  );
  const energyRows = useMemo(
    () =>
      rows
        .filter((r) => r.group === "energy")
        .sort(
          (a, b) =>
            (ENERGY_ORDER[a.id] ?? 100) - (ENERGY_ORDER[b.id] ?? 100) ||
            a.id.localeCompare(b.id),
        ),
    [rows],
  );
  const sourcedRows = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.status !== "ready") return [];
        const provenance = formatSampleSourceProvenance(row);
        return provenance
          ? [{ id: row.id, label: `${quantityShortLabel(row)} source`, provenance }]
          : [];
      }),
    [rows],
  );

  const volumeM3 = snapshot?.volumeM3 ?? spacing[0] * spacing[1] * spacing[2];

  const handleRetryCellPhysics = useCallback(() => {
    kernel?.resources?.invalidate?.(DATA_FIELDS_PATH, Date.now());
    cellPhysics.refetch?.();
  }, [cellPhysics, kernel?.resources]);

  const cellProvenance = useMemo(
    () =>
      resolveFdmCellProvenance({
        binaryData: binaryRes.data,
        generationId: domainMeta.data?.generation_id,
        ijk,
        materialRows,
        membership,
        regionDiagnosticsData: regionDiagnosticsRes.data,
        regionsData: regionsRes.data,
        resolvedCell,
        sceneObjects: sceneRes.data?.objects,
        selection,
        shape,
      }),
    [
      binaryRes.data,
      domainMeta.data?.generation_id,
      ijk,
      materialRows,
      membership,
      regionDiagnosticsRes.data,
      regionsRes.data,
      resolvedCell,
      sceneRes.data?.objects,
      selection,
      shape,
    ],
  );

  const baseline = useMemo<FdmCellDraft>(
    () => ({ energyUnitMode: "density_jm3" }),
    [],
  );

  const spec = useMemo<InspectorSpec<FdmCellDraft>>(() => {
    const vec =
      magRow?.status === "ready" &&
      magRow.vector?.length === 3 &&
      magRow.vector.every(Number.isFinite)
        ? magRow.vector
        : null;
    const norm = vec ? Math.hypot(vec[0]!, vec[1]!, vec[2]!) : null;

    const maskStateDisplay =
      resolvedCell.verificationStatus === "stale"
        ? "Withheld (stale cell snapshot)"
        : resolvedCell.maskState === "region"
          ? "Active region (region)"
          : resolvedCell.maskState === "active-unassigned"
            ? "Active unassigned (active-unassigned)"
            : resolvedCell.maskState === "inactive"
              ? "Inactive outside support (inactive)"
              : "Pending membership mask";

    return {
      id: "fdm.cell",
      header: {
        breadcrumbs: [
          {
            id: "grid",
            label: "Structured Grid",
            selection: {
              kind: "mesh.grid",
              label: "Structured Grid",
              nodeId: "model:mesh:grid",
              objectId: null,
              ref: null,
            },
          },
          { id: "cell", label: `Voxel (${ijk.join(", ")})` },
        ],
        canFitView: true,
        extraMenuActions: target
          ? [
              {
                icon: RefreshCw,
                id: "refresh-cell-physics",
                label: "Refresh cell physics",
                onSelect: () => handleRetryCellPhysics(),
              },
            ]
          : undefined,
      },
      identity: {
        domain: "physics",
        entityId: `cell:${resolvedCell.cellOrdinal}`,
        icon: Compass,
        kindLabel: "Interactive FDM voxel readout",
        statePill: () =>
          resolvedCell.verificationStatus === "stale"
            ? { label: "Stale", tone: "stale" }
            : target && cellPhysics.status === "error"
              ? { label: "Read error", tone: "err" }
              : target && cellPhysics.status === "stale"
                ? { label: "Refreshing", tone: "stale" }
                : snapshot
                  ? { label: "Current", tone: "live" }
                  : { label: "Waiting", tone: "neutral" },
        title: () => `FDM Voxel (${ijk.join(", ")})`,
      },
      facts: () => [
        { id: "ijk", label: "Indices (i,j,k)", value: `(${ijk.join(", ")})` },
        {
          id: "ordinal",
          label: "Linear index",
          value: resolvedCell.ordinal.toLocaleString("en-US"),
        },
        {
          id: "norm",
          label: "|m|",
          value: norm !== null && Number.isFinite(norm) ? norm.toFixed(4) : null,
        },
        {
          id: "vol",
          label: "Cell volume",
          value: `${(volumeM3 * 1e27).toFixed(2)} nm³`,
        },
      ],
      modeTabs: [
        { id: "physics", label: "Physics" },
        { id: "neighbors", label: "Grid & 6-Neighbors" },
      ],
      notices: () => {
        const list: InspectorNotice<FdmCellDraft>[] = [];
        if (resolvedCell.notice) {
          list.push({
            id: "cell-selection-notice",
            text: resolvedCell.notice,
            title:
              resolvedCell.verificationStatus === "stale"
                ? "Stale cell selection"
                : "Cell physics notice",
            tone: resolvedCell.verificationStatus === "stale" ? "warn" : "info",
          });
        }
        if (target && cellPhysics.status === "error") {
          list.push({
            id: "cell-physics-read-error",
            quickFix: {
              label: "Retry cell physics read",
              onApply: () => handleRetryCellPhysics(),
            },
            text: sanitizeDisplayReason(
              cellPhysics.error?.message,
              "The current cell fields could not be read.",
            ),
            title: "Cell physics read error",
            tone: "err",
          });
        } else if (target && cellPhysics.status === "stale") {
          list.push({
            id: "cell-physics-refreshing",
            text: "Refreshing current fields. Previous values are hidden.",
            title: "Refreshing cell physics",
            tone: "info",
          });
        } else if (target && cellPhysics.status === "loading") {
          list.push({
            id: "cell-physics-loading",
            text: "Reading published fields for this cell.",
            title: "Loading cell physics",
            tone: "info",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "cell-membership",
          rows: [
            {
              format: () => maskStateDisplay,
              label: "Mask state",
              type: "readonly",
            },
            {
              format: () =>
                resolvedCell.numericRegionId != null
                  ? String(resolvedCell.numericRegionId)
                  : "None",
              label: "Numeric region",
              mono: true,
              type: "readonly",
            },
            {
              format: () => resolvedCell.regionId ?? "None",
              label: "Semantic region",
              mono: true,
              type: "readonly",
            },
            {
              format: () => resolvedCell.membershipRevision,
              label: "Membership revision",
              mono: true,
              type: "readonly",
            },
            {
              format: () => cellProvenance.regionSource,
              label: "Region source",
              type: "readonly",
            },
            {
              format: () => cellProvenance.dominantObjectRegion,
              label: "Dominant object/region",
              type: "readonly",
            },
            {
              format: () => cellProvenance.materialAssignment,
              label: "Material assignment",
              type: "readonly",
            },
            {
              format: () => cellProvenance.boundaryInterface,
              label: "Boundary/interface",
              type: "readonly",
            },
            {
              format: () => cellProvenance.competingRegions,
              label: "Competing regions",
              type: "readonly",
            },
            {
              format: () => cellProvenance.clippedReason,
              label: "Clipped reason",
              type: "readonly",
            },
            {
              copyText: () => cellProvenance.activeGridProvenance,
              format: () => cellProvenance.activeGridProvenance,
              label: "Active grid provenance",
              mono: true,
              type: "readonly",
            },
          ],
          title: "Cell membership & region provenance",
        },
        {
          defaultOpen: true,
          icon: Atom,
          id: "material-params",
          modeTabId: "physics",
          rows:
            snapshot && materialRows.length > 0
              ? materialRows.map((row) => {
                  const usable =
                    row.status === "ready" &&
                    row.scalar !== null &&
                    Number.isFinite(row.scalar);
                  const cleanUnit =
                    row.unit === "1" ||
                    row.unit.toLowerCase() === "dimensionless"
                      ? ""
                      : row.unit.trim();
                  return {
                    format: () =>
                      usable
                        ? `${formatCellScalar(row.scalar!)}${cleanUnit ? ` ${cleanUnit}` : ""}`
                        : "Not published",
                    hint: usable
                      ? undefined
                      : sanitizeDisplayReason(
                          row.reason,
                          "No current coefficient is published for this cell.",
                        ),
                    label: row.label,
                    symbol:
                      row.id === "mat_ms" ? (
                        <>
                          M<sub>s</sub>
                        </>
                      ) : row.id === "mat_aex" ? (
                        <>
                          A<sub>ex</sub>
                        </>
                      ) : row.id === "mat_alpha" ? (
                        <>&alpha;</>
                      ) : undefined,
                    type: "readonly" as const,
                  };
                })
              : [
                  {
                    format: () =>
                      snapshot
                        ? "No material coefficients published for this voxel"
                        : target
                          ? "Current values appear when the read completes"
                          : "Select an active single-grid FDM cell",
                    label: "Material coefficients",
                    type: "readonly",
                  },
                ],
          title: "Material coefficients",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "magnetization",
          modeTabId: "physics",
          rows: [
            {
              format: () =>
                vec
                  ? `(${vec[0]!.toFixed(4)}, ${vec[1]!.toFixed(4)}, ${vec[2]!.toFixed(4)})`
                  : "Not published",
              hint:
                snapshot && magRow && !vec
                  ? sanitizeDisplayReason(
                      magRow.reason,
                      "Three finite components are not published for this cell.",
                    )
                  : undefined,
              label: "Reduced magnetization",
              symbol: <>m</>,
              type: "readonly",
            },
            {
              format: () => (norm !== null ? norm.toFixed(6) : "Not published"),
              label: "Vector norm",
              symbol: <>|m|</>,
              type: "readonly",
            },
          ],
          title: "Magnetization vector",
        },
        {
          defaultOpen: true,
          icon: Zap,
          id: "energies",
          live: true,
          modeTabId: "physics",
          rows: [
            {
              key: "energyUnitMode",
              label: "Energy quantity",
              options: [
                { label: "Density [J/m³]", value: "density_jm3" },
                { label: "Voxel [eV]", value: "cell_ev" },
                { label: "Voxel [aJ]", value: "cell_aj" },
              ],
              type: "segmented",
            },
            ...(snapshot && energyRows.length > 0
              ? energyRows.map((row) => {
                  const supportedUnit = isSupportedEnergyDensityUnit(row.unit);
                  const usable =
                    row.status === "ready" &&
                    supportedUnit &&
                    row.scalar !== null &&
                    Number.isFinite(row.scalar);
                  const rowReason = !supportedUnit
                    ? `Cannot interpret ${row.unit || "an unspecified unit"} as energy density in J/m³.`
                    : sanitizeDisplayReason(
                        row.reason,
                        "This energy density is not currently published for this cell.",
                      );
                  return {
                    format: (d: FdmCellDraft) =>
                      formatEnergyRowValue(row, volumeM3, d.energyUnitMode),
                    hint: usable ? undefined : rowReason,
                    label: row.label,
                    type: "readonly" as const,
                  };
                })
              : [
                  {
                    format: () =>
                      snapshot
                        ? "No local energy fields published for this cell"
                        : target
                          ? "Current values appear when the read completes"
                          : "Select an active single-grid FDM cell",
                    label: "Local energy terms",
                    type: "readonly" as const,
                  },
                ]),
          ],
          title: "Cell energies",
        },
        {
          defaultOpen: true,
          icon: History,
          id: "field-sources",
          modeTabId: "physics",
          rows:
            snapshot && sourcedRows.length > 0
              ? sourcedRows.map((entry) => ({
                  format: () => entry.provenance,
                  label: entry.label,
                  mono: true,
                  type: "readonly" as const,
                }))
              : [
                  {
                    format: () =>
                      snapshot
                        ? "No current sample provenance"
                        : "Shown when current values are published",
                    label: "Field sources",
                    type: "readonly" as const,
                  },
                ],
          title: "Per-field sample provenance",
        },
        {
          defaultOpen: true,
          icon: Grid3x3,
          id: "stencil",
          modeTabId: "neighbors",
          rows: [
            {
              format: () =>
                fmtCoord3(
                  target?.centerM ?? fdmCellCenter(origin, spacing, ijk),
                  "nm",
                ),
              label: "Voxel center",
              symbol: (
                <>
                  r<sub>c</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => fmtTuple3(target?.cellSizeM ?? spacing, "nm"),
              label: "Voxel size",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              label: "6-neighbor stencil",
              render: (ctx) => (
                <SixNeighborStencil
                  binaryData={binaryRes.data}
                  ctx={ctx}
                  gridFingerprint={resolvedCell.gridFingerprint}
                  ijk={ijk}
                  membership={membership}
                  membershipRevision={resolvedCell.membershipRevision}
                  shape={shape}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Voxel coordinates & 6-neighbor stencil",
        },
      ],
      details: () => [
        { label: "Run ID", mono: true, value: snapshot?.runId ?? null },
        {
          label: "Grid fingerprint",
          mono: true,
          value: resolvedCell.gridFingerprint || null,
        },
        ...sourcedRows.map((entry) => ({
          label: entry.label,
          mono: true,
          value: entry.provenance,
        })),
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          "Live FDM voxel probe · Click a neighbor to step through the grid",
      },
    };
  }, [
    binaryRes.data,
    cellPhysics.error?.message,
    cellPhysics.status,
    cellProvenance,
    energyRows,
    handleRetryCellPhysics,
    ijk,
    magRow,
    materialRows,
    membership,
    origin,
    resolvedCell,
    shape,
    snapshot,
    sourcedRows,
    spacing,
    target,
    volumeM3,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
