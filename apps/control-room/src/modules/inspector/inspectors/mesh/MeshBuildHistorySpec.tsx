"use client";

import { Activity, Grid3x3, History, Layers, Ruler, Settings2 } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { restoreMeshHistoryToDraft } from "@/kernel/authoring/meshBuildHistoryRestore";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  SpecInspectorHost,
  type InspectorNotice,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";
import { resolveMeshBuildFreshness } from "@/shared/domain/mesh/meshBuildFreshness";
import {
  normalizeMeshBuildHistory,
  type MeshBuildHistoryEntry,
} from "@/shared/domain/mesh/meshBuildHistory";
import { Button } from "@/shared/ui/Button";

import {
  MeshBuildHistorySpecView,
  MixedTopologyProvenanceSpecView,
  OperationStatusesSpecView,
  sanitizeMeshDisplayText,
  ThinFilmDiagnosticsSpecView,
} from "../../panels/mesh-details/MeshQualityAndHistorySpecViews";
import { resolveMixedTopologyPresentation } from "../../panels/mesh-details/MixedTopologyProvenanceSection.model";
import { resolveRetainedMeshArtifact } from "../../panels/mesh-details/useMeshDetailsModel";
import { MeshRebuildConfirmDialog } from "./MeshRebuildConfirmDialog";
import {
  asNumber,
  asRecord,
  asString,
  formatLengthSmart,
  SESSION_STATUS_KEY,
  useActiveLane,
  useSafeMeshBuildLatestSuccessful,
} from "./meshShared";

export interface MeshBuildsDraft {
  compareA: string;
  compareB: string;
}

export function MeshBuildsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const sessionStatusData = sessionStatusHooks.useSessionStatusSelector((s) => s.data);
  const activeLane = useActiveLane();
  const femMode = activeLane === "fem";

  const activeBuildRes = geometryLifecycleResources.useMeshBuildCurrent({
    enabled: femMode,
  });
  const latestBuildRes = useSafeMeshBuildLatestSuccessful({ enabled: femMode });
  const historyRes = geometryLifecycleResources.useMeshBuildHistoryResource({
    enabled: femMode,
  });
  const reportRes = geometryLifecycleResources.useMeshSharedDomainReportResource({
    enabled: femMode,
  });
  const manifestRes = geometryLifecycleResources.useMeshSharedDomainManifestResource({
    enabled: femMode,
  });
  const summaryRes = geometryLifecycleResources.useMeshSummaryResource({
    enabled: femMode,
  });
  const semanticsRes = geometryLifecycleResources.useMeshSemanticsResource({
    enabled: femMode,
  });
  const sceneRes = geometryLifecycleResources.useSceneResource({
    enabled: activeLane !== "unresolved",
  });
  const domainMeta = geometryLifecycleResources.useDomainMetaResource({
    enabled: activeLane === "fdm",
  });

  const historyEntries = useMemo(() => {
    const rec = asRecord(historyRes.data);
    return normalizeMeshBuildHistory(
      rec?.history ?? rec?.entries ?? rec?.builds ?? historyRes.data,
    );
  }, [historyRes.data]);

  const baseline = useMemo<MeshBuildsDraft>(
    () => ({
      compareA: historyEntries[0]?.id ?? "latest",
      compareB: historyEntries.at(-1)?.id ?? historyEntries[0]?.id ?? "latest",
    }),
    [historyEntries],
  );

  const lastBuildError =
    activeBuildRes.data?.last_build_error ?? latestBuildRes.data?.last_build_error;
  const retainedArtifact = useMemo(
    () =>
      resolveRetainedMeshArtifact({
        lastBuildError,
        latestSuccess: latestBuildRes.data?.last_success,
        manifest: manifestRes.data,
        meshRevision: summaryRes.data?.revision,
      }),
    [
      lastBuildError,
      latestBuildRes.data?.last_success,
      manifestRes.data,
      summaryRes.data?.revision,
    ],
  );

  const mixedTopology = useMemo(
    () =>
      resolveMixedTopologyPresentation({
        buildReport:
          activeBuildRes.data?.shared_domain_build_report ??
          asRecord(asRecord(semanticsRes.data)?.solver_mesh)?.build_report ??
          asRecord(reportRes.data)?.report,
        manifest: manifestRes.data,
        rejectionEvidence: activeBuildRes.data?.mixed_layer_topology_rejection,
      }),
    [activeBuildRes.data, manifestRes.data, reportRes.data, semanticsRes.data],
  );

  const operationStatuses = useMemo(
    () =>
      activeBuildRes.data?.shared_domain_build_report?.operation_statuses ?? [],
    [activeBuildRes.data],
  );
  const thinFilmDiagnostics = useMemo(
    () =>
      activeBuildRes.data?.shared_domain_build_report?.thin_film_diagnostics ?? [],
    [activeBuildRes.data],
  );

  const freshness = useMemo(() => {
    if (!femMode) return null;
    const sceneRec = asRecord(sceneRes.data);
    const sceneRev =
      asNumber(sceneRec?.revision) ?? asNumber(sceneRec?.scene_revision);
    return resolveMeshBuildFreshness({
      activeBuild: asRecord(activeBuildRes.data?.active_build),
      latestBuild: asRecord(
        activeBuildRes.data?.last_build_summary ?? latestBuildRes.data?.last_success,
      ),
      manifest: manifestRes.data as Record<string, unknown> | null | undefined,
      sceneRevision: sceneRev,
      statusMeshRevision: summaryRes.data?.revision,
    });
  }, [
    activeBuildRes.data?.active_build,
    activeBuildRes.data?.last_build_summary,
    femMode,
    latestBuildRes.data?.last_success,
    manifestRes.data,
    sceneRes.data,
    summaryRes.data?.revision,
  ]);

  const stageRows = useMemo(() => {
    if (activeLane === "fdm") {
      const grid = domainMeta.data?.grid;
      return [
        {
          detail: grid?.shape ? grid.shape.join(" × ") : "Pending",
          id: "fdm-grid",
          stage: "Structured grid realization",
          status: grid ? "Materialized" : "Not materialized",
        },
        {
          detail: grid?.spacing
            ? grid.spacing.map((v) => formatLengthSmart(v) ?? String(v)).join(" × ")
            : "Pending",
          id: "fdm-spacing",
          stage: "Voxel cell spacing",
          status: grid ? "Resolved" : "Pending",
        },
        {
          detail: domainMeta.data?.generation_id ?? "Pending",
          id: "fdm-gen",
          stage: "Domain generation",
          status: domainMeta.data?.generation_id ? "Published" : "Pending",
        },
      ];
    }
    const rep =
      asRecord(activeBuildRes.data?.shared_domain_build_report) ??
      asRecord(asRecord(reportRes.data)?.report) ??
      asRecord(reportRes.data);
    const rawStages = Array.isArray(rep?.stages)
      ? rep.stages
      : Array.isArray(activeBuildRes.data?.mesh_pipeline_status)
        ? (activeBuildRes.data?.mesh_pipeline_status as unknown[])
        : [];
    return rawStages.map((s, i) => {
      const sr = asRecord(s) ?? {};
      const ms = asNumber(sr.duration_ms);
      const sec = asNumber(sr.duration_s) ?? asNumber(sr.duration_seconds);
      return {
        detail:
          ms !== null
            ? `${ms.toFixed(0)} ms`
            : sec !== null
              ? `${sec.toPrecision(3)} s`
              : sanitizeMeshDisplayText(sr.detail ?? sr.message, "—"),
        id: asString(sr.id) ?? asString(sr.phase) ?? `stage-${i}`,
        stage:
          asString(sr.name) ??
          asString(sr.label) ??
          asString(sr.phase) ??
          `Stage ${i + 1}`,
        status: sanitizeMeshDisplayText(sr.status ?? sr.state, "Recorded"),
      };
    });
  }, [activeBuildRes.data, activeLane, domainMeta.data, reportRes.data]);

  const entryOptions = useMemo(
    () =>
      historyEntries.length > 0
        ? historyEntries.map((e) => ({
            label: `#${e.index + 1} ${e.meshName ?? "mesh"} · ${e.id}`,
            value: e.id,
          }))
        : [{ label: "Current session revision", value: "latest" }],
    [historyEntries],
  );

  const [confirmRebuildOpen, setConfirmRebuildOpen] = useState(false);

  const isAlreadyMaterialized =
    activeLane === "fdm"
      ? Boolean(
          domainMeta.data?.grid?.shape &&
            domainMeta.data.grid.shape.length >= 3 &&
            domainMeta.data.grid.shape.every((n) => typeof n === "number" && n > 0),
        )
      : Boolean(manifestRes.data);

  const handleBuildSharedDomain = useCallback(async () => {
    const cmd = activeLane === "fdm" ? "grid.build-fdm" : "mesh.build-shared-domain";
    await kernel.commands.execute(
      cmd,
      createCommandContext("inspector", kernel, {
        resourceData: {
          ...(sessionStatusData ? { [SESSION_STATUS_KEY]: sessionStatusData } : {}),
          ...(sceneRes.data
            ? { [geometryLifecycleResources.SCENE_RESOURCE_KEY]: sceneRes.data }
            : {}),
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "mesh.builds",
      }),
    );
  }, [activeLane, kernel, sceneRes.data, sessionScopeKey, sessionStatusData]);

  const requestBuildSharedDomain = useCallback(() => {
    if (isAlreadyMaterialized) {
      setConfirmRebuildOpen(true);
      return;
    }
    void handleBuildSharedDomain();
  }, [handleBuildSharedDomain, isAlreadyMaterialized]);

  const handleRestoreEntry = useCallback(
    (entry: MeshBuildHistoryEntry) => {
      restoreMeshHistoryToDraft(kernel, entry);
    },
    [kernel],
  );

  const spec = useMemo<InspectorSpec<MeshBuildsDraft>>(
    () => ({
      id: "mesh.builds",
      header: {
        breadcrumbs: [
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "mesh.root",
              label: "Mesh",
              nodeId: "model:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "builds", label: "Build History" },
        ],
        primaryHeaderAction: {
          icon: Grid3x3,
          label:
            activeLane === "fdm"
              ? isAlreadyMaterialized
                ? "Re-voxelize Grid"
                : "Build Structured Grid"
              : isAlreadyMaterialized
                ? "Rebuild Shared-Domain Mesh"
                : "Build Shared-Domain Mesh",
          onRun: requestBuildSharedDomain,
        },
        extraMenuActions: [
          {
            icon: History,
            id: "inspect-raw-json",
            label: "Inspect raw build JSON",
            onSelect: (ctx) => {
              ctx.openCodePreview(
                "Mesh build report JSON",
                "json",
                JSON.stringify(
                  reportRes.data ?? activeBuildRes.data ?? historyRes.data ?? {},
                  null,
                  2,
                ),
              );
            },
          },
        ],
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:builds",
        icon: History,
        kindLabel:
          activeLane === "fdm" ? "FDM voxelization provenance" : "FEM Gmsh build pipeline",
        statePill: () => {
          if (retainedArtifact) return { label: "Retained after failure", tone: "warn" };
          if (freshness?.state === "stale") return { label: "Stale", tone: "warn" };
          return { label: "Recorded", tone: "ok" };
        },
        title: () => "Mesh Build Pipeline & History",
      },
      facts: () => [
        {
          id: "engine",
          label: "Engine",
          value: activeLane === "fdm" ? "FDM Voxelizer" : "Gmsh OCC",
        },
        {
          id: "retained",
          label: "Recorded builds",
          value: String(historyEntries.length),
        },
        {
          id: "freshness",
          label: "Freshness",
          value: freshness ? sanitizeMeshDisplayText(freshness.state, "current") : null,
        },
      ],
      notices: () => {
        const list: InspectorNotice<MeshBuildsDraft>[] = [];
        if (retainedArtifact?.state === "retained") {
          list.push({
            id: "retained-after-failure",
            text: `Latest mesh build failed (${sanitizeMeshDisplayText(lastBuildError, "build error")}). Workspace retains ${retainedArtifact.meshName ?? retainedArtifact.meshId ?? "published mesh"} at revision ${retainedArtifact.meshRevision ?? "current"}.`,
            title: "Retained published mesh after failed build",
            tone: "warn",
          });
        } else if (lastBuildError) {
          list.push({
            id: "last-build-error",
            text: sanitizeMeshDisplayText(lastBuildError),
            title: "Last mesh build error",
            tone: "err",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={requestBuildSharedDomain}
            >
              {activeLane === "fdm"
                ? isAlreadyMaterialized
                  ? "Re-voxelize Grid"
                  : "Build Structured Grid"
                : isAlreadyMaterialized
                  ? "Rebuild Shared-Domain Mesh"
                  : "Build Shared-Domain Mesh"}
            </Button>
          ),
          icon: Activity,
          id: "active-pipeline",
          rows: [
            {
              format: () =>
                lastBuildError ? sanitizeMeshDisplayText(lastBuildError) : "None",
              label: "Last build error",
              type: "readonly",
            },
            {
              format: () =>
                retainedArtifact?.state === "retained"
                  ? `Yes — ${retainedArtifact.meshName ?? retainedArtifact.meshId ?? "published artifact"}`
                  : "Not applicable",
              label: "Retained after failure",
              type: "readonly",
            },
            {
              columns: [
                {
                  header: "Stage",
                  id: "stage",
                  renderCell: (r) => (r as (typeof stageRows)[number]).stage,
                },
                {
                  header: "Status",
                  id: "status",
                  renderCell: (r) => (r as (typeof stageRows)[number]).status,
                },
                {
                  align: "right",
                  header: "Detail",
                  id: "detail",
                  mono: true,
                  renderCell: (r) => (r as (typeof stageRows)[number]).detail,
                },
              ],
              label: "Pipeline stages",
              rowKey: (r) => (r as (typeof stageRows)[number]).id,
              rows: () => stageRows,
              showWhen: () => stageRows.length > 0,
              type: "table",
              wide: true,
            },
          ],
          title: "Build pipeline & rollback state",
        },
        {
          defaultOpen: true,
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() =>
                ctx.openCodePreview(
                  "Mesh build report JSON",
                  "json",
                  JSON.stringify(
                    reportRes.data ?? activeBuildRes.data ?? historyRes.data ?? {},
                    null,
                    2,
                  ),
                )
              }
            >
              Inspect raw build JSON
            </Button>
          ),
          icon: History,
          id: "history-compare",
          rows: [
            {
              key: "compareA",
              label: "Base build (Before)",
              options: entryOptions,
              showWhen: () => historyEntries.length >= 2,
              type: "select",
            },
            {
              key: "compareB",
              label: "Target build (After)",
              options: entryOptions,
              showWhen: () => historyEntries.length >= 2,
              type: "select",
            },
            {
              render: (ctx) => (
                <MeshBuildHistorySpecView
                  afterId={ctx.draft.compareB}
                  beforeId={ctx.draft.compareA}
                  entries={historyEntries}
                  onRestore={handleRestoreEntry}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode,
          title: "Build history, revision comparison & policy restore",
        },
        {
          defaultOpen: true,
          icon: Layers,
          id: "builds-mixed-topology",
          rows: [
            {
              render: () => <MixedTopologyProvenanceSpecView model={mixedTopology} />,
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode && mixedTopology.visible,
          title: "Mixed-topology provenance",
        },
        {
          defaultOpen: false,
          icon: Settings2,
          id: "builds-operation-statuses",
          rows: [
            {
              render: () => (
                <OperationStatusesSpecView operationStatuses={operationStatuses} />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode,
          title: "Operation statuses",
        },
        {
          defaultOpen: false,
          icon: Ruler,
          id: "builds-thin-film",
          rows: [
            {
              render: () => (
                <ThinFilmDiagnosticsSpecView diagnostics={thinFilmDiagnostics} />
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => femMode,
          title: "Thin-film diagnostics",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Build provenance, comparison & draft policy restoration",
      },
    }),
    [
      activeBuildRes.data,
      activeLane,
      entryOptions,
      femMode,
      freshness,
      handleRestoreEntry,
      historyEntries,
      historyRes.data,
      isAlreadyMaterialized,
      lastBuildError,
      mixedTopology,
      operationStatuses,
      reportRes.data,
      requestBuildSharedDomain,
      retainedArtifact,
      stageRows,
      thinFilmDiagnostics,
    ],
  );

  return (
    <>
      <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />
      <MeshRebuildConfirmDialog
        actionLabel={
          activeLane === "fdm" ? "Re-voxelize Grid" : "Rebuild Shared-Domain Mesh"
        }
        lane={activeLane === "fdm" ? "fdm" : "fem"}
        open={confirmRebuildOpen}
        summary={
          activeLane === "fdm" && domainMeta.data?.grid?.shape
            ? domainMeta.data.grid.shape.join(" × ")
            : null
        }
        onConfirm={handleBuildSharedDomain}
        onOpenChange={setConfirmRebuildOpen}
      />
    </>
  );
}
