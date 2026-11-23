"use client";

import {
  Box,
  Compass,
  Eye,
  Grid3x3,
  History,
  Layers,
  Ruler,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { DATA_DOMAIN_META_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  SpecInspectorHost,
  type InspectorActionContext,
  type InspectorPanelProps,
  type InspectorSpec,
  type InspectorTone,
} from "@/modules/inspector/shared";
import { resolveFdmDisplaySampling } from "@/shared/domain/mesh/fdmDisplaySampling";

import type { FdmGridLegendEntry } from "../../../panels/fdm-grid/fdmGridInspectorModel";
import { FdmMeshWorkflowCard } from "../../../panels/mesh-details/FdmMeshWorkflowCard";
import { MeshRebuildConfirmDialog } from "../MeshRebuildConfirmDialog";
import {
  buildFdmGridBreadcrumbs,
  buildFdmGridNotices,
  buildFdmGridProvenanceRows,
  buildFdmMultilayerStackRows,
  buildSupportVisualizationRows,
  checkFdmMembershipCompatible,
  resolveGridSubScope,
  resolveGridVisualizationTarget,
  resolveValidatedMagneticSupport,
  type FdmGridDraft,
} from "./fdmGridModel";
import {
  FDM_VIZ_FIELD_KEYS,
  fmtCoord3,
  fmtTuple3,
  hasVizDraftChanges,
  sanitizeDisplayReason,
  useDomainMetaResourceSafe,
  useFdmMultilayerLayoutResourceSafe,
  useFdmRegionMembershipResourceSafe,
  useSafeFdmTargetVisualization,
  useSceneResourceSafe,
  useSessionScopeKeySafe,
  useSessionStatusDataSafe,
} from "./fdmShared";

export type { FdmGridDraft } from "./fdmGridModel";

export function FdmGridInspectorSpecPanel({ selection }: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const domainMeta = useDomainMetaResourceSafe();
  const sceneRes = useSceneResourceSafe();
  const sessionStatusData = useSessionStatusDataSafe();
  const sessionScopeKey = useSessionScopeKeySafe();
  const membershipRes = useFdmRegionMembershipResourceSafe({ enabled: true });
  const multilayerRes = useFdmMultilayerLayoutResourceSafe();
  const [buildFeedback, setBuildFeedback] = useState<{
    tone: "info" | "warn" | "err";
    text: string;
  } | null>(null);
  const [confirmRebuildOpen, setConfirmRebuildOpen] = useState(false);

  const { ownerObjectId, regionId, scope } = useMemo(
    () => resolveGridSubScope(selection),
    [selection],
  );

  const vizTarget = useMemo(
    () => resolveGridVisualizationTarget(selection, scope),
    [scope, selection],
  );

  const {
    applyVizPatch,
    hasPersistedOverride,
    hydratedVizFields,
    isAirboxTarget,
    resetVizTarget,
  } = useSafeFdmTargetVisualization(
    vizTarget,
    "wireframe",
    scope === "universe-outside-support" ? "H_demag" : "m",
  );

  const baseline = useMemo<FdmGridDraft>(
    () => ({
      ...hydratedVizFields,
      displayUnit: "nm",
    }),
    [hydratedVizFields],
  );

  const executeBuildFdmGrid = useCallback(async () => {
    if (!kernel?.commands?.execute) return;
    try {
      const statusKey =
        sessionStatusHooks.SESSION_STATUS_RESOURCE_KEY ?? "session:status";
      const resourceData: Record<string, unknown> = {};
      if (domainMeta.data) {
        resourceData[DATA_DOMAIN_META_PATH] = domainMeta.data;
      }
      if (sessionStatusData) {
        resourceData[statusKey] = sessionStatusData;
      }
      if (sceneRes.data) {
        resourceData[MODEL_SCENE_PATH] = sceneRes.data;
      }
      const result = await kernel.commands.execute(
        "grid.build-fdm",
        createCommandContext("inspector", kernel, {
          resourceData:
            Object.keys(resourceData).length > 0 ? resourceData : undefined,
          sessionScopeKey: sessionScopeKey ?? null,
          sourceDetail: "mesh.grid",
        }),
      );
      if (result && typeof result === "object" && "status" in result) {
        const status = String(result.status);
        const msg =
          typeof result.message === "string" && result.message.trim()
            ? sanitizeDisplayReason(result.message, "FDM grid build submitted.")
            : status === "completed"
              ? "FDM grid refresh completed."
              : status === "failed"
                ? "FDM grid refresh failed."
                : "FDM grid refresh submitted.";
        setBuildFeedback({
          text: msg,
          tone:
            status === "failed"
              ? "err"
              : status === "completed"
                ? "info"
                : "warn",
        });
      }
    } catch (error) {
      setBuildFeedback({
        text:
          error instanceof Error
            ? sanitizeDisplayReason(error.message, "FDM grid refresh failed.")
            : "FDM grid refresh failed.",
        tone: "err",
      });
    }
  }, [domainMeta.data, kernel, sceneRes.data, sessionScopeKey, sessionStatusData]);

  const shape: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.shape ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.shape]);

  const spacing: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.spacing ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.spacing]);

  const origin: [number, number, number] = useMemo(() => {
    const raw = domainMeta.data?.grid?.origin ?? [0, 0, 0];
    return [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
  }, [domainMeta.data?.grid?.origin]);

  const totalCells = shape[0] * shape[1] * shape[2];
  const voxelVolumeM3 = spacing[0] * spacing[1] * spacing[2];
  const displaySampling = useMemo(
    () => (totalCells > 0 ? resolveFdmDisplaySampling(totalCells) : null),
    [totalCells],
  );

  const membership = membershipRes.data ?? null;
  const isMembershipCompatible = useMemo(
    () =>
      checkFdmMembershipCompatible(
        domainMeta.data,
        membership,
        shape,
        origin,
        spacing,
        totalCells,
      ),
    [domainMeta.data, membership, origin, shape, spacing, totalCells],
  );

  const isGridMaterialized = totalCells > 0 && Boolean(membership) && isMembershipCompatible;
  const requestBuildFdmGrid = useCallback(() => {
    if (isGridMaterialized) {
      setConfirmRebuildOpen(true);
      return;
    }
    void executeBuildFdmGrid();
  }, [executeBuildFdmGrid, isGridMaterialized]);

  const validatedSupport = useMemo(
    () =>
      membership && isMembershipCompatible
        ? resolveValidatedMagneticSupport(membership)
        : null,
    [isMembershipCompatible, membership],
  );

  const legend = useMemo<readonly (FdmGridLegendEntry & { id: string })[]>(() => {
    const raw = membership?.region_legend;
    if (!Array.isArray(raw)) return [];
    return raw.map((entry, idx) => ({
      id: `${entry.object_id}:${entry.region_id}:${idx}`,
      numericId: entry.numeric_id,
      objectId: entry.object_id,
      priority: entry.priority,
      regionId: entry.region_id,
    }));
  }, [membership?.region_legend]);

  const selectedRegion = useMemo<FdmGridLegendEntry | null>(() => {
    if (!regionId) return null;
    const candidates = legend.filter((entry) => entry.regionId === regionId);
    if (ownerObjectId) {
      return candidates.find((entry) => entry.objectId === ownerObjectId) ?? null;
    }
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  }, [legend, ownerObjectId, regionId]);

  const isMultilayer = Boolean(multilayerRes.data?.available);
  const commonLayout = multilayerRes.data?.common_transform_layout ?? null;

  const mlLayers = useMemo(
    () =>
      multilayerRes.data?.available
        ? multilayerRes.data.layers.map((layer) => ({
            gridText: layer.native_grid.join(" × "),
            id: layer.layer_id,
            magnetName: layer.magnet_name,
            objectId: layer.object_id,
            transfer: layer.transfer_kind,
            zMinNm: Number(((layer.native_origin[2] ?? 0) * 1e9).toFixed(2)),
          }))
        : [],
    [multilayerRes.data],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof FdmGridDraft & string>(
      key: K,
      value: FdmGridDraft[K],
      helpers: { draft: FdmGridDraft },
    ) => {
      if (!FDM_VIZ_FIELD_KEYS.has(key)) return;
      const nextDraft: FdmGridDraft = { ...helpers.draft, [key]: value };
      applyVizPatch(nextDraft);
    },
    [applyVizPatch],
  );

  const spec = useMemo<InspectorSpec<FdmGridDraft>>(() => {
    const isStale =
      domainMeta.status === "stale" ||
      membershipRes.status === "stale" ||
      (Boolean(membership) && !isMembershipCompatible) ||
      (scope === "region" && Boolean(membership) && selectedRegion === null);

    const statePill = (): { label: string; tone: InspectorTone } => {
      if (domainMeta.status === "error" || membershipRes.status === "error") {
        return { label: "Error", tone: "err" };
      }
      if (isStale) {
        return { label: "Stale", tone: "stale" };
      }
      if (membership && isMembershipCompatible) {
        return { label: "Materialized", tone: "ok" };
      }
      if (isMultilayer) {
        return { label: "Multilayer", tone: "ok" };
      }
      return { label: "Authoring grid", tone: "neutral" };
    };

    const titleText =
      scope === "universe-outside-support"
        ? "FDM Airbox Outside-Support"
        : scope === "common"
          ? "Common Convolution FFT Grid"
          : scope === "region" && regionId
            ? `FDM Region · ${regionId}`
            : "Structured FDM Grid";

    const supportVisualizationRows = buildSupportVisualizationRows(
      vizTarget,
      isAirboxTarget,
    );

    return {
      id: "mesh.grid",
      header: {
        breadcrumbs: buildFdmGridBreadcrumbs(scope, regionId),
        canFitView: true,
        primaryHeaderAction:
          scope === "domain" || scope === "descriptor"
            ? {
                icon: Grid3x3,
                label: isGridMaterialized ? "Re-voxelize Grid" : "Build Structured Grid",
                onRun: requestBuildFdmGrid,
              }
            : undefined,
        extraMenuActions: [
          {
            icon: Ruler,
            id: "edit-cell-size",
            label: "Edit Cell Size…",
            onSelect: (ctx) => {
              ctx.selectNode({
                kind: "mesh.root",
                label: "Mesh",
                nodeId: "model:mesh",
                objectId: null,
                ref: null,
              });
            },
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId:
          scope === "universe-outside-support"
            ? "airbox"
            : scope === "region" && regionId
              ? `fdm:region:${regionId}`
              : "model:mesh:grid",
        icon: Grid3x3,
        kindLabel:
          scope === "universe-outside-support"
            ? "FDM outside-support Airbox carrier & 3D display"
            : scope === "common"
              ? "Diagnostic multilayer FFT convolution scratch grid"
              : isMultilayer
                ? "Multilayer Z-stack FDM discretization"
                : "Regular Cartesian voxel discretization",
        statePill,
        title: () => titleText,
      },
      facts: (d) => [
        {
          id: "shape",
          label: "Shape",
          value: totalCells > 0 ? shape.join(" × ") : null,
        },
        {
          id: "cell",
          label: "Cell size",
          value: totalCells > 0 ? fmtTuple3(spacing, d.displayUnit) : null,
        },
        {
          id: "fill",
          label: "Active fill",
          value:
            validatedSupport && totalCells > 0
              ? `${((validatedSupport.activeCellCount / totalCells) * 100).toFixed(1)}%`
              : null,
        },
        {
          id: "regions",
          label: "Regions",
          value: membership ? `${legend.length} numeric` : null,
        },
      ],
      notices: () =>
        buildFdmGridNotices({
          buildFeedback,
          domainErrorMessage: domainMeta.error?.message,
          domainStatus: domainMeta.status,
          executeBuildFdmGrid,
          isMembershipCompatible,
          isMultilayer,
          membership,
          membershipErrorMessage: membershipRes.error?.message,
          membershipStatus: membershipRes.status,
          scope,
          selectedRegion,
          validatedSupport,
        }),
      sections: [
        ...(scope === "domain" || scope === "descriptor"
          ? [
              {
                defaultOpen: true,
                icon: Compass,
                id: "fdm-workflow",
                rows: [
                  {
                    render: (ctx: InspectorActionContext<FdmGridDraft>) => (
                      <FdmMeshWorkflowCard
                        buildError={
                          buildFeedback?.tone === "err" ? buildFeedback.text : null
                        }
                        domainMeta={domainMeta.data}
                        gridMaterialized={totalCells > 0 && Boolean(membership)}
                        sceneData={sceneRes.data}
                        sessionScopeKey={sessionScopeKey}
                        onBuildGrid={() => executeBuildFdmGrid()}
                        onSelectNode={(next) => ctx.selectNode(next)}
                      />
                    ),
                    type: "custom" as const,
                    wide: true,
                  },
                ],
                summary: () =>
                  totalCells > 0 && membership
                    ? `${shape.join(" × ")} ready`
                    : "Follow steps 1 → 4",
                title: "Structured grid workflow",
              },
            ]
          : []),
        ...(scope === "region" || regionId !== null
          ? [
              {
                defaultOpen: true,
                icon: ShieldCheck,
                id: "selected-region",
                rows: [
                  {
                    format: () => selectedRegion?.regionId ?? regionId ?? "Not resolved",
                    label: "Selected region ID",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      selectedRegion
                        ? `#${selectedRegion.numericId}`
                        : "Not in current legend",
                    label: "Numeric region ID",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      selectedRegion?.objectId ?? ownerObjectId ?? "Not resolved",
                    label: "Owner object",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      selectedRegion ? String(selectedRegion.priority) : "—",
                    label: "Overlap priority",
                    mono: true,
                    type: "readonly" as const,
                  },
                ],
                title: "Selected FDM region",
              },
            ]
          : []),
        {
          defaultOpen: true,
          icon: Ruler,
          id: "dimensions",
          live: true,
          rows: [
            {
              key: "displayUnit",
              label: "Display length unit",
              options: [
                { label: "nm", value: "nm" },
                { label: "µm", value: "µm" },
                { label: "mm", value: "mm" },
                { label: "m", value: "m" },
              ],
              type: "segmented",
            },
            {
              format: () =>
                `${shape.join(" × ")} (${totalCells.toLocaleString("en-US")} voxels)`,
              label: "Grid shape",
              symbol: <>N</>,
              type: "readonly",
            },
            {
              format: (d) => fmtTuple3(spacing, d.displayUnit),
              label: "Cell spacing",
              symbol: <>&Delta;</>,
              type: "readonly",
            },
            {
              format: (d) => fmtCoord3(origin, d.displayUnit),
              label: "Grid origin",
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: (d) =>
                fmtTuple3(
                  [
                    shape[0] * spacing[0],
                    shape[1] * spacing[1],
                    shape[2] * spacing[2],
                  ],
                  d.displayUnit,
                ),
              label: "Physical span",
              symbol: <>L</>,
              type: "readonly",
            },
            {
              format: () => `${(voxelVolumeM3 * 1e27).toFixed(2)} nm³`,
              label: "Voxel volume",
              symbol: (
                <>
                  V<sub>cell</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                displaySampling
                  ? displaySampling.displaySamples.toLocaleString("en-US")
                  : "Pending grid",
              label: "Display samples",
              type: "readonly",
            },
            {
              format: () =>
                displaySampling
                  ? displaySampling.stride.toLocaleString("en-US")
                  : "Pending grid",
              label: "Display stride",
              type: "readonly",
            },
            {
              format: () =>
                displaySampling
                  ? displaySampling.budget.toLocaleString("en-US")
                  : "Pending grid",
              label: "Display budget",
              type: "readonly",
            },
          ],
          summary: () => shape.join(" × "),
          title: "Grid dimensions & cell size",
        },
        {
          defaultOpen: true,
          icon: vizTarget ? Eye : ShieldCheck,
          id: "support-mask",
          live: true,
          rows: [
            ...supportVisualizationRows,
            {
              format: (d) =>
                validatedSupport
                  ? fmtCoord3(validatedSupport.boundsMinM, d.displayUnit)
                  : membership
                    ? "Withheld (support summary not published)"
                    : "Not materialized",
              label: "Support bounds min",
              type: "readonly",
            },
            {
              format: (d) =>
                validatedSupport
                  ? fmtCoord3(validatedSupport.boundsMaxM, d.displayUnit)
                  : membership
                    ? "Withheld (support summary not published)"
                    : "Not materialized",
              label: "Support bounds max",
              type: "readonly",
            },
            {
              format: () =>
                membership?.encoding
                  ? String(membership.encoding)
                  : "Not materialized",
              label: "Mask encoding",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                !membership
                  ? "Not materialized"
                  : isMembershipCompatible
                    ? "Verified compatible with current grid"
                    : "Incompatible or stale vs current grid",
              label: "Grid-mask compatibility",
              type: "readonly",
            },
            {
              columns: [
                {
                  header: "ID",
                  id: "id",
                  mono: true,
                  renderCell: (r) => `#${(r as (typeof legend)[number]).numericId}`,
                },
                {
                  header: "Object / Region",
                  id: "owner",
                  renderCell: (r) => {
                    const row = r as (typeof legend)[number];
                    return `${row.objectId} / ${row.regionId}`;
                  },
                },
                {
                  align: "right",
                  header: "Priority",
                  id: "prio",
                  mono: true,
                  renderCell: (r) => String((r as (typeof legend)[number]).priority),
                },
              ],
              label: "Region membership legend",
              onSelectRow: (r, ctx) => {
                const row = r as (typeof legend)[number];
                ctx.selectNode({
                  kind: "object.region",
                  label: row.regionId,
                  nodeId: `model:object:${row.objectId}:region:${row.regionId}`,
                  objectId: row.objectId,
                  ref: null,
                });
              },
              rowKey: (r) => (r as (typeof legend)[number]).id,
              rows: () => legend,
              showWhen: () => legend.length > 0,
              type: "table",
              wide: true,
            },
          ],
          summary: () => `${legend.length} regions`,
          title:
            scope === "universe-outside-support"
              ? "Airbox outside-support visualization & mask"
              : "Magnetic support & 3D display",
        },
        {
          defaultOpen:
            scope === "magnetic-support" ||
            scope === "active-unassigned" ||
            scope === "universe-outside-support" ||
            Boolean(validatedSupport && validatedSupport.activeUnassignedCellCount > 0),
          icon: Box,
          id: "active-unassigned",
          rows: [
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.activeCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Active magnetic voxels",
              symbol: (
                <>
                  N<sub>act</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.activeAssignedCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Active assigned voxels",
              symbol: (
                <>
                  N<sub>reg</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.activeUnassignedCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Active unassigned voxels",
              symbol: (
                <>
                  N<sub>unass</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                validatedSupport
                  ? validatedSupport.inactiveCellCount.toLocaleString("en-US")
                  : membership
                    ? "Withheld"
                    : "Not materialized",
              label: "Inactive vacuum voxels",
              symbol: (
                <>
                  N<sub>vac</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          summary: () =>
            validatedSupport
              ? `${validatedSupport.activeUnassignedCellCount.toLocaleString("en-US")} unassigned`
              : "Not materialized",
          title: "Active / unassigned cells",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "multilayer-stack",
          rows: buildFdmMultilayerStackRows(
            commonLayout,
            mlLayers,
            <>
              N<sub>FFT</sub>
            </>,
          ),
          showWhen: () => isMultilayer || scope === "common",
          summary: () => `${mlLayers.length} Z-layers`,
          title: "Multilayer Z-stack overview",
        },
        {
          defaultOpen: scope === "provenance",
          icon: History,
          id: "provenance",
          rows: buildFdmGridProvenanceRows(domainMeta.data, membership),
          summary: () =>
            membership?.grid_fingerprint
              ? String(membership.grid_fingerprint)
              : "Recorded",
          title: "Provenance",
        },
      ],
      commitBar: vizTarget
        ? {
            hasOverrides: (d, b) =>
              hasPersistedOverride || hasVizDraftChanges(d, b),
            mode: "liveViewport",
            onResetDisplay: resetVizTarget,
            statusMessage:
              scope === "universe-outside-support"
                ? "Live Airbox outside-support 3D display"
                : "Live structured-grid 3D display · Edit cell size in Mesh",
          }
        : {
            mode: "readOnly",
            statusMessage: () =>
              "Diagnostic FFT scratch grid · Not a physical render carrier",
          },
    };
  }, [
    buildFeedback,
    commonLayout,
    displaySampling,
    domainMeta.data,
    domainMeta.error?.message,
    domainMeta.status,
    executeBuildFdmGrid,
    hasPersistedOverride,
    isAirboxTarget,
    isGridMaterialized,
    isMembershipCompatible,
    isMultilayer,
    legend,
    membership,
    membershipRes.error?.message,
    membershipRes.status,
    mlLayers,
    origin,
    ownerObjectId,
    regionId,
    requestBuildFdmGrid,
    resetVizTarget,
    sceneRes.data,
    scope,
    selectedRegion,
    sessionScopeKey,
    shape,
    spacing,
    totalCells,
    validatedSupport,
    vizTarget,
    voxelVolumeM3,
  ]);

  return (
    <>
      <SpecInspectorHost
        baseline={baseline}
        selection={selection}
        spec={spec}
        onAfterFieldChange={handleAfterFieldChange}
      />
      <MeshRebuildConfirmDialog
        actionLabel="Re-voxelize Grid"
        lane="fdm"
        open={confirmRebuildOpen}
        summary={
          totalCells > 0
            ? `${shape.join(" × ")} · ${totalCells.toLocaleString("en-US")} cells`
            : null
        }
        onConfirm={executeBuildFdmGrid}
        onOpenChange={setConfirmRebuildOpen}
      />
    </>
  );
}
