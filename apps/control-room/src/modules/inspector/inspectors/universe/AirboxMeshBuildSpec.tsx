"use client";

import {
  Activity,
  Gauge,
  Grid3x3,
  History,
  Layers,
  RotateCcw,
  ShieldCheck,
  Square,
  Wrench,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshUniverseReportResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { shouldLoadRuntimeMeshBuild, shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { normalizeMeshBuildPhases, type NormalizedMeshBuildPhase } from "@/shared/domain/mesh/meshBuildPhases";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import { resolveAirboxInspectorLane, useAirboxInspectorRuntimeStatus } from "../../panels/airbox/airboxInspectorRuntimeStatus";
import { buildAirboxMeshBuildModel } from "../../panels/airbox/airboxMeshInspectorModel";
import {
  asNumber,
  asRecord,
  asString,
  buildFdmAirboxFactsSections,
  formatLengthSmart,
  resolveFdmRoleEvidence,
  sanitizeStatusText,
  useSafeFdmRegionMembershipResource,
  useSafeMeshBuildCurrent,
  useSafeMeshBuildLatestSuccessful,
} from "../../panels/airbox/airboxSpecShared";
import { formatEffectiveValue, readTargetMetric } from "./universeShared";

// ============================================================================
// 3.6 airbox.mesh.build — AirboxMeshBuildInspectorSpecPanel
// ============================================================================

function isPhaseActive(phase: NormalizedMeshBuildPhase): boolean {
  const st = phase.status.trim().toLowerCase();
  return (
    st === "running" ||
    st === "active" ||
    st === "building" ||
    st === "queued" ||
    st === "pending" ||
    st === "generating"
  );
}

export function AirboxMeshBuildInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const femEnabled = lane !== "fdm";
  const buildEnabled =
    femEnabled && shouldLoadRuntimeMeshBuild(true, runtimeStatus);

  const currentRes = useSafeMeshBuildCurrent({ enabled: buildEnabled });
  const latestRes = useSafeMeshBuildLatestSuccessful({ enabled: buildEnabled });
  const reportRes = useMeshUniverseReportResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const scene = useSceneResource();

  const domainMeta = useDomainMetaResource({ enabled: lane === "fdm" });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: lane === "fdm",
  });
  const multilayerLayout = useFdmMultilayerLayoutResource({
    enabled: lane === "fdm",
  });

  const currentSceneRevision =
    asNumber(asRecord(scene.data)?.scene_revision) ??
    asNumber(asRecord(scene.data)?.revision);
  const currentMeshRevision =
    runtimeStatus?.resources.mesh_revision ??
    currentRes.data?.revision ??
    reportRes.data?.revision ??
    null;

  const reportEvidence = useMemo(() => {
    if (!reportRes.data) return null;
    if (
      currentMeshRevision !== null &&
      reportRes.data.revision !== currentMeshRevision
    ) {
      return null;
    }
    return reportRes.data;
  }, [currentMeshRevision, reportRes.data]);

  const lifecycle = useMemo(
    () =>
      buildAirboxMeshBuildModel({
        current: currentRes.data ?? null,
        currentSceneRevision,
        latest: latestRes.data ?? null,
        report: reportEvidence,
      }),
    [currentRes.data, currentSceneRevision, latestRes.data, reportEvidence],
  );

  const normalizedPhases = useMemo(
    () => normalizeMeshBuildPhases(currentRes.data?.mesh_pipeline_status),
    [currentRes.data?.mesh_pipeline_status],
  );

  const activeBuildRecord = asRecord(currentRes.data?.active_build);
  const isBuilding =
    activeBuildRecord !== null || normalizedPhases.some(isPhaseActive);

  const progressPercent = useMemo(() => {
    const directPct = asNumber(activeBuildRecord?.progress_percent);
    if (directPct !== null) return Math.max(0, Math.min(100, Math.round(directPct)));
    const activePhase = normalizedPhases.find(isPhaseActive);
    if (activePhase?.progressPercent != null) return activePhase.progressPercent;
    if (normalizedPhases.length > 0) {
      const done = normalizedPhases.filter((p) =>
        /^(complete|completed|done|ready|success)$/i.test(p.status.trim()),
      ).length;
      return Math.round((done / normalizedPhases.length) * 100);
    }
    return isBuilding ? 15 : 100;
  }, [activeBuildRecord?.progress_percent, isBuilding, normalizedPhases]);

  const progressLabel = useMemo(() => {
    const activePhase = normalizedPhases.find(isPhaseActive);
    return (
      asString(activeBuildRecord?.progress_label) ??
      activePhase?.progressLabel ??
      activePhase?.label ??
      (isBuilding ? "Shared-domain mesh build in progress" : "Idle")
    );
  }, [activeBuildRecord?.progress_label, isBuilding, normalizedPhases]);

  const resolvedRows = useMemo(() => {
    const resolvedRoot =
      lifecycle.resolvedPolicy ??
      asRecord(asRecord(reportRes.data)?.resolved_policy) ??
      asRecord(asRecord(asRecord(reportRes.data)?.report)?.resolved_policy);
    if (!resolvedRoot) return [];
    const universeSub = asRecord(resolvedRoot.universe);
    const sourceObj = universeSub ?? resolvedRoot;
    return Object.entries(sourceObj).map(([key, val]) => ({
      id: key,
      key,
      value: formatEffectiveValue(key, val),
    }));
  }, [lifecycle.resolvedPolicy, reportRes.data]);

  const cancelActiveBuild = useCallback(async () => {
    const ctx = createCommandContext("inspector", kernel, {
      resourceData: {
        [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
      },
      sessionScopeKey: sessionScopeKey ?? null,
      sourceDetail: "airbox.mesh.build",
    });
    if (kernel.commands.isEnabled?.("study.cancel-build-and-run", ctx)) {
      await kernel.commands.execute("study.cancel-build-and-run", ctx);
      return;
    }
    await kernel.commands.execute("study.stop", ctx);
  }, [kernel, runtimeStatus, sessionScopeKey]);

  const runMeshOrGridBuild = useCallback(async () => {
    const cmd =
      lane === "fdm" ? "grid.build-fdm" : "mesh.build-shared-domain";
    await kernel.commands.execute(
      cmd,
      createCommandContext("inspector", kernel, {
        input: { origin: "airbox" },
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "airbox.mesh.build",
      }),
    );
  }, [kernel, lane, runtimeStatus, sessionScopeKey]);

  const roleEvidence = useMemo(
    () =>
      lane === "fdm"
        ? resolveFdmRoleEvidence(
            domainMeta.data,
            fdmMembership.data,
            fdmMembership.error ? "error" : fdmMembership.status,
            scene.data?.objects,
          )
        : null,
    [
      domainMeta.data,
      fdmMembership.data,
      fdmMembership.error,
      fdmMembership.status,
      lane,
      scene.data?.objects,
    ],
  );

  const baseline = useMemo(() => ({ open: true }), []);

  const spec = useMemo<InspectorSpec<{ open: boolean }>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<{ open: boolean }>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "build",
          })
        : [];

    const notices: InspectorNotice<{ open: boolean }>[] = [];
    const buildError =
      asString(currentRes.data?.last_build_error) ??
      lifecycle.latestSuccess.lastBuildError;
    if (buildError) {
      notices.push({
        id: "build-error",
        text: buildError,
        title: "Mesh build error",
        tone: "err",
      });
    }
    if (lifecycle.fallbacks.length > 0) {
      notices.push({
        id: "build-fallbacks",
        text: `Mesher fallbacks triggered: ${lifecycle.fallbacks.join(", ")}`,
        title: "Build fallback warning",
        tone: "warn",
      });
    }

    const latestTargetHmax = readTargetMetric(
      lifecycle.latestSuccess.effectiveAirboxTarget ??
        lifecycle.effectiveAirboxTarget,
      "maximum_element_size",
      "hmax",
      "airbox_hmax",
    );
    const latestTargetHmin = readTargetMetric(
      lifecycle.latestSuccess.effectiveAirboxTarget ??
        lifecycle.effectiveAirboxTarget,
      "minimum_element_size",
      "hmin",
      "airbox_hmin",
    );
    const latestTargetGrowth = readTargetMetric(
      lifecycle.latestSuccess.effectiveAirboxTarget ??
        lifecycle.effectiveAirboxTarget,
      "growth_rate",
      "airbox_growth_rate",
    );

    const statePill = (): { label: string; tone: InspectorTone } => {
      if (lane === "fdm") {
        return domainMeta.data
          ? { label: "FDM grid", tone: "ok" }
          : { label: "Not materialized", tone: "neutral" };
      }
      if (isBuilding) return { label: "Building", tone: "live" };
      if (lifecycle.status === "degraded") return { label: "Degraded", tone: "err" };
      if (lifecycle.status === "current") {
        return lifecycle.freshness === "stale"
          ? { label: "Stale", tone: "warn" }
          : { label: "Recorded", tone: "ok" };
      }
      return { label: "Not built", tone: "neutral" };
    };

    return {
      id: "airbox.mesh.build",
      header: {
        breadcrumbs: [
          {
            id: "airbox-mesh",
            label: "Airbox Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "build", label: "Build & Provenance" },
        ],
        extraMenuActions: [
          {
            icon: History,
            id: "raw-json",
            label: "Inspect Build JSON",
            onSelect: (ctx) =>
              ctx.openCodePreview(
                "Airbox mesh build provenance",
                "json",
                lifecycle.rawDetails.serialized,
              ),
          },
        ],
        primaryHeaderAction: isBuilding
          ? {
              icon: Square,
              label: "Cancel",
              onRun: cancelActiveBuild,
              variant: "destructive",
            }
          : {
              icon: Grid3x3,
              label:
                lane === "fdm" ? "Build FDM Grid" : "Build Shared-Domain Mesh",
              onRun: runMeshOrGridBuild,
            },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:build",
        icon: History,
        kindLabel:
          lane === "fdm"
            ? "FDM Airbox structured-grid provenance"
            : "Exterior mesh build lifecycle, timings & provenance",
        statePill,
        title: () => "Airbox Build & Provenance",
      },
      facts: () => [
        {
          id: "rev",
          label: "Build rev",
          value:
            lifecycle.revision !== null ? String(lifecycle.revision) : null,
        },
        {
          id: "freshness",
          label: "Freshness",
          value:
            lane === "fdm"
              ? null
              : lifecycle.freshness === "current"
                ? "Current"
                : lifecycle.freshness === "stale"
                  ? "Stale"
                  : null,
        },
        {
          id: "duration",
          label: "Duration",
          value:
            lifecycle.provenance.durationMs !== null
              ? `${lifecycle.provenance.durationMs.toLocaleString("en-US")} ms`
              : null,
        },
        {
          id: "params",
          label: "Resolved keys",
          value: resolvedRows.length > 0 ? String(resolvedRows.length) : null,
        },
      ],
      notices: () => notices,
      sections: [
        ...fdmSections,
        {
          defaultOpen: true,
          footer: () => (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="primary"
                onClick={() => void runMeshOrGridBuild()}
              >
                Build Shared-Domain Mesh
              </Button>
              {isBuilding ? (
                <Button
                  size="sm"
                  type="button"
                  variant="danger"
                  onClick={() => void cancelActiveBuild()}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          ),
          icon: Activity,
          id: "build-lifecycle",
          rows: [
            ...(isBuilding || normalizedPhases.length > 0
              ? [
                  {
                    render: () => (
                      <div className="grid min-w-0 gap-1.5 rounded-md border border-fm-border-subtle p-2.5">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-fm-fg">
                            {sanitizeStatusText(progressLabel, "Idle")}
                          </span>
                          <Badge variant={isBuilding ? "default" : "secondary"}>
                            {progressPercent}%
                          </Badge>
                        </div>
                        <div
                          aria-label="Mesh build progress"
                          aria-valuemax={100}
                          aria-valuemin={0}
                          aria-valuenow={progressPercent}
                          className="h-2 w-full overflow-hidden rounded-full bg-fm-surface-muted"
                          role="progressbar"
                        >
                          <div
                            className="h-full bg-fm-accent transition-all"
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      </div>
                    ),
                    type: "custom" as const,
                    wide: true,
                  },
                ]
              : []),
            {
              format: () =>
                lifecycle.status === "current"
                  ? "Healthy / recorded"
                  : lifecycle.status === "degraded"
                    ? "Degraded"
                    : "Not built yet",
              label: "Lifecycle status",
              type: "readonly",
            },
            {
              format: () =>
                sanitizeStatusText(lifecycle.reason, "No build recorded yet"),
              label: "Summary",
              type: "readonly",
            },
            {
              format: () => lifecycle.buildMode ?? "Not published",
              label: "Build mode",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.freshness === "current"
                  ? "Current (matches scene)"
                  : lifecycle.freshness === "stale"
                    ? "Stale (scene changed since build)"
                    : "Pending scene/build comparison",
              label: "Mesh freshness",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.fallbacksPublished
                  ? lifecycle.fallbacks.length > 0
                    ? lifecycle.fallbacks.join(", ")
                    : "None (strict)"
                  : "Not published",
              label: "Mesher fallbacks",
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Mesh build lifecycle & progress",
        },
        {
          defaultOpen: true,
          icon: History,
          id: "build-provenance",
          rows: [
            {
              copyText: () => lifecycle.provenance.buildId,
              format: () => lifecycle.provenance.buildId ?? "Not published",
              label: "Build ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => lifecycle.provenance.commandId,
              format: () => lifecycle.provenance.commandId ?? "Not published",
              label: "Command ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.provenance.completedAtUnixMs !== null
                  ? new Date(
                      lifecycle.provenance.completedAtUnixMs,
                    ).toISOString()
                  : "Not published",
              label: "Completed at",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.provenance.durationMs !== null
                  ? `${lifecycle.provenance.durationMs.toLocaleString("en-US")} ms`
                  : "Not published",
              label: "Total build duration",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.provenance.requestedPolicyRevision !== null
                  ? String(lifecycle.provenance.requestedPolicyRevision)
                  : "Not published",
              label: "Requested policy revision",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.provenance.geometryRealizationRevision !== null
                  ? String(lifecycle.provenance.geometryRealizationRevision)
                  : "Not published",
              label: "Geometry realization revision",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.provenance.meshRevision !== null
                  ? String(lifecycle.provenance.meshRevision)
                  : "Not published",
              label: "Provenance mesh revision",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.provenance.sourceSceneRevision !== null
                  ? String(lifecycle.provenance.sourceSceneRevision)
                  : "Not published",
              label: "Source scene revision",
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Build provenance",
        },
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "latest-successful-build",
          rows: [
            {
              format: () =>
                lifecycle.latestSuccess.artifactPublished
                  ? "Published"
                  : "Not published",
              label: "Latest successful artifact",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.latestSuccess.resourceRevision !== null
                  ? String(lifecycle.latestSuccess.resourceRevision)
                  : "Not published",
              label: "Latest success revision",
              type: "readonly",
            },
            {
              format: () =>
                lifecycle.latestSuccess.sourceSceneRevision !== null
                  ? String(lifecycle.latestSuccess.sourceSceneRevision)
                  : "Not published",
              label: "Latest success scene revision",
              type: "readonly",
            },
            {
              format: () => formatLengthSmart(latestTargetHmax),
              label: "Effective Airbox h_max",
              type: "readonly",
            },
            {
              format: () => formatLengthSmart(latestTargetHmin),
              label: "Effective Airbox h_min",
              type: "readonly",
            },
            {
              format: () =>
                latestTargetGrowth !== null
                  ? Number(latestTargetGrowth.toPrecision(5)).toString()
                  : "—",
              label: "Effective Airbox growth rate",
              type: "readonly",
            },
            {
              format: () => lifecycle.latestSuccess.lastBuildError ?? "None",
              label: "Recorded build error",
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Latest successful build",
        },
        ...(lane !== "fdm" && normalizedPhases.length > 0
          ? [
              {
                defaultOpen: true,
                icon: Gauge,
                id: "pipeline-stage-timings",
                rows: [
                  {
                    columns: [
                      {
                        header: "Pipeline stage",
                        id: "stage",
                        renderCell: (r: unknown) =>
                          (r as NormalizedMeshBuildPhase).label,
                      },
                      {
                        header: "Status",
                        id: "st",
                        renderCell: (r: unknown) =>
                          sanitizeStatusText(
                            (r as NormalizedMeshBuildPhase).status,
                            "Pending",
                          ),
                      },
                      {
                        align: "right" as const,
                        header: "Timing",
                        id: "ms",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const p = r as NormalizedMeshBuildPhase;
                          return p.durationMs !== null
                            ? `${p.durationMs.toLocaleString("en-US")} ms`
                            : "—";
                        },
                      },
                    ],
                    label: "Pipeline stages & timings",
                    rowKey: (r: unknown) => (r as NormalizedMeshBuildPhase).id,
                    rows: () => normalizedPhases,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Pipeline stage timings",
              },
            ]
          : []),
        ...(lane !== "fdm" && lifecycle.operationStatuses.length > 0
          ? [
              {
                defaultOpen: false,
                icon: Wrench,
                id: "operation-statuses",
                rows: [
                  {
                    columns: [
                      {
                        header: "Scope / Kind",
                        id: "sk",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const op =
                            r as (typeof lifecycle.operationStatuses)[number];
                          return `${op.scope} · ${op.kind}`;
                        },
                      },
                      {
                        header: "Status",
                        id: "st",
                        renderCell: (r: unknown) =>
                          sanitizeStatusText(
                            (r as (typeof lifecycle.operationStatuses)[number])
                              .status,
                            "Recorded",
                          ),
                      },
                      {
                        header: "Detail",
                        id: "rsn",
                        renderCell: (r: unknown) =>
                          sanitizeStatusText(
                            (r as (typeof lifecycle.operationStatuses)[number])
                              .reason,
                            "—",
                          ),
                      },
                    ],
                    label: "Meshing operation statuses",
                    rowKey: (r: unknown) => {
                      const op =
                        r as (typeof lifecycle.operationStatuses)[number];
                      return `${op.scope}:${op.kind}`;
                    },
                    rows: () => lifecycle.operationStatuses,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Operation statuses",
              },
            ]
          : []),
        ...(lane !== "fdm" && lifecycle.publishedResources
          ? [
              {
                defaultOpen: false,
                icon: Layers,
                id: "published-resources",
                rows: [
                  {
                    copyText: () =>
                      lifecycle.publishedResources?.manifest ?? null,
                    format: () =>
                      lifecycle.publishedResources?.manifest || "Not published",
                    label: "Manifest endpoint",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    copyText: () =>
                      lifecycle.publishedResources?.quality ?? null,
                    format: () =>
                      lifecycle.publishedResources?.quality || "Not published",
                    label: "Quality endpoint",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    copyText: () =>
                      lifecycle.publishedResources?.realized_size_fields ??
                      null,
                    format: () =>
                      lifecycle.publishedResources?.realized_size_fields ||
                      "Not published",
                    label: "Realized size fields",
                    mono: true,
                    type: "readonly" as const,
                  },
                  {
                    format: () =>
                      lifecycle.publishedResources?.mesh_revision != null
                        ? String(lifecycle.publishedResources.mesh_revision)
                        : "Not published",
                    label: "Published mesh revision",
                    type: "readonly" as const,
                  },
                ],
                title: "Published build resources",
              },
            ]
          : []),
        {
          defaultOpen: true,
          icon: RotateCcw,
          id: "resolved-gmsh",
          rows:
            resolvedRows.length > 0
              ? [
                  {
                    columns: [
                      {
                        header: "Parameter",
                        id: "k",
                        mono: true,
                        renderCell: (r) =>
                          (r as (typeof resolvedRows)[number]).key,
                      },
                      {
                        align: "right",
                        header: "Resolved value",
                        id: "v",
                        mono: true,
                        renderCell: (r) =>
                          (r as (typeof resolvedRows)[number]).value,
                      },
                    ],
                    label: "Resolved Gmsh & universe parameters",
                    rowKey: (r) => (r as (typeof resolvedRows)[number]).id,
                    rows: () => resolvedRows,
                    type: "table",
                    wide: true,
                  },
                ]
              : [
                  {
                    format: () =>
                      "Build shared-domain mesh to record resolved parameters",
                    label: "Resolved policy",
                    type: "readonly",
                  },
                ],
          showWhen: () => lane !== "fdm",
          title: "Resolved build policy",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          lane === "fdm"
            ? "Structured FDM Airbox provenance"
            : isBuilding
              ? "Shared-domain mesh build running"
              : "Exterior mesh artifact provenance",
      },
    };
  }, [
    cancelActiveBuild,
    currentRes.data,
    domainMeta,
    fdmMembership.data,
    isBuilding,
    lane,
    lifecycle,
    multilayerLayout.data,
    normalizedPhases,
    progressLabel,
    progressPercent,
    resolvedRows,
    roleEvidence,
    runMeshOrGridBuild,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
