"use client";

import {
  Activity,
  AlertTriangle,
  Gauge,
  Layers,
  Ruler,
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
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { ScientificEChart, type ResolvedChartThemePalette } from "@/shared/charts/ScientificEChart";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import {
  normalizeMeshQualityStatistics,
  type MeshQualityMetric,
  type MeshSizeDistribution,
  type MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../template";
import { buildMeshSizeDistributionHoverBin } from "../../panels/meshHistogramHoverState";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import { emitMeshSizeHistogramHover } from "../../panels/meshSizeHistogramHover";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import {
  airboxSizeDistributionPresentation,
  buildAirboxMeshInspectorModel,
  currentAirboxQualityEvidence,
  currentAirboxReportEvidence,
} from "../../panels/airbox/airboxMeshInspectorModel";
import {
  asNumber,
  asRecord,
  buildFdmAirboxFactsSections,
  formatLengthSmart,
  resolveFdmRoleEvidence,
  sanitizeStatusText,
  useSafeFdmRegionMembershipResource,
  useSafeMeshSharedDomainQualityResource,
} from "../../panels/airbox/airboxSpecShared";

// ============================================================================
// 3.4 airbox.mesh.statistics — AirboxMeshStatisticsInspectorSpecPanel
// ============================================================================

type AirboxStatsChartKey =
  | "sicn"
  | "gamma"
  | "edge_length"
  | "tetra_size"
  | "volume";

export function AirboxMeshStatisticsInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const femEnabled = lane !== "fdm";

  const qualityRes = useMeshUniverseQualityResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const sharedQualityRes = useSafeMeshSharedDomainQualityResource({
    enabled: femEnabled && shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const reportRes = useMeshUniverseReportResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const manifestRes = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(femEnabled, runtimeStatus),
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
  const topologyIdentityMatches = matchesAirboxTopologyIdentity(
    runtimeStatus,
    manifestRes.data,
  );
  const topologyMatches =
    (manifestRes.status === "ready" && topologyIdentityMatches) ||
    (runtimeStatus === null &&
      (manifestRes.data != null || qualityRes.data != null));
  const currentMeshRevision =
    runtimeStatus?.resources.mesh_revision ??
    qualityRes.data?.revision ??
    manifestRes.data?.revision ??
    null;

  const qualityEvidence = currentAirboxQualityEvidence(
    qualityRes,
    topologyMatches,
    currentMeshRevision,
  );
  const reportEvidence = currentAirboxReportEvidence(
    reportRes,
    topologyMatches,
    currentMeshRevision,
  );

  const model = useMemo(
    () =>
      buildAirboxMeshInspectorModel({
        currentSceneRevision,
        manifest: topologyMatches ? (manifestRes.data ?? null) : null,
        policy: {
          config: null,
          effective_config: null,
          revision: qualityRes.data?.revision ?? 0,
        },
        quality: qualityEvidence,
        report: reportEvidence,
        summary: null,
      }),
    [
      currentSceneRevision,
      manifestRes.data,
      qualityEvidence,
      qualityRes.data?.revision,
      reportEvidence,
      topologyMatches,
    ],
  );

  const rawStatsSource =
    qualityEvidence?.quality ??
    (topologyMatches ? asRecord(sharedQualityRes.data)?.quality : null);
  const statistics = useMemo(
    () => normalizeMeshQualityStatistics(rawStatsSource),
    [rawStatsSource],
  );
  const refinementState = useMemo(
    () => resolveMeshQualityRefinementState(statistics),
    [statistics],
  );

  const selectQualityMetric = useCallback(
    (metric: MeshQualityMetric["id"]) => {
      const nodeId = `model:mesh:quality:${metric}`;
      kernel.selection?.set?.(
        {
          kind: "mesh.quality",
          label: `Mesh quality ${metric.toUpperCase()}`,
          nodeId,
          objectId: null,
          ref: {
            kind: "mesh.quality.metric",
            metric,
            nodeId,
            type: "mesh-quality-metric",
            visualizationTargetId: `mesh:quality:metric:${metric}`,
          },
        },
        "mesh",
      );
      kernel.layout?.setActiveTab?.("mesh");
    },
    [kernel],
  );

  const selectWorstElement = useCallback(
    (element: MeshWorstElement) => {
      const nodeId = `model:mesh:quality:element:${element.elementIndex}`;
      kernel.selection?.set?.(
        {
          kind: "mesh.quality",
          label: `Worst mesh element ${element.elementIndex}`,
          nodeId,
          objectId: null,
          ref: {
            artifactId: manifestRes.data?.mesh_id ?? null,
            centroid: element.centroid,
            elementIndex: element.elementIndex,
            generationId: manifestRes.data?.generation_id ?? null,
            kind: "mesh.quality.element",
            meshRevision: currentMeshRevision,
            metric: "gamma",
            nodeId,
            type: "mesh-quality-element",
            visualizationTargetId: `mesh:quality:element:${element.elementIndex}`,
          },
        },
        "mesh",
      );
      kernel.layout?.setActiveTab?.("mesh");
    },
    [
      currentMeshRevision,
      kernel,
      manifestRes.data?.generation_id,
      manifestRes.data?.mesh_id,
    ],
  );

  const refineWorstRegion = useCallback(async () => {
    if (!refinementState.plan) return;
    await kernel.commands.execute(
      "mesh.refine-worst-quality-element",
      createCommandContext("inspector", kernel, {
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "airbox.mesh.statistics",
      }),
      {
        elementIndex: refinementState.plan.elementIndex,
        meshOptions: refinementState.plan.meshOptions,
      },
    );
  }, [kernel, refinementState.plan, runtimeStatus, sessionScopeKey]);

  const hoverDistributionBin = useCallback(
    (dist: MeshSizeDistribution, binIndex: number | null) => {
      const bin =
        binIndex === null
          ? null
          : buildMeshSizeDistributionHoverBin(dist, binIndex);
      emitMeshSizeHistogramHover({
        airboxPartId: model.airboxPart?.id ?? null,
        bin,
        kernel,
        scope: { kind: "airbox" },
      });
    },
    [kernel, model.airboxPart?.id],
  );

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

  const baseline = useMemo(
    () => ({ metric: "sicn" as AirboxStatsChartKey }),
    [],
  );

  const spec = useMemo<InspectorSpec<{ metric: AirboxStatsChartKey }>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<{ metric: AirboxStatsChartKey }>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "statistics",
          })
        : [];

    const sicnMetric =
      statistics?.metrics.find((m) => m.id === "sicn") ?? null;
    const minSicn = sicnMetric?.min ?? null;
    const meanEdgeM = statistics?.edgeLength?.mean ?? null;
    const byType = model.statistics.volumeElementsByType;
    const typeScopeSuffix =
      model.statistics.volumeElementCountScope === "shared-domain"
        ? " (shared-domain)"
        : "";

    const buildChartForKey = (key: AirboxStatsChartKey) => {
      if (key === "sicn" || key === "gamma") {
        const m = statistics?.metrics.find((entry) => entry.id === key);
        if (!m || m.histogram.length === 0) return null;
        return {
          bins: m.histogram.map((b) => ({
            belowThreshold:
              m.threshold !== null && b.hi !== null && b.hi <= m.threshold,
            count: b.count,
            label: b.label,
          })),
          title: m.label,
        };
      }
      const dist = statistics?.sizeDistributions.find((d) => d.id === key);
      if (!dist || dist.histogram.length === 0) return null;
      return {
        bins: dist.histogram.map((b) => ({
          belowThreshold: false,
          count: b.count,
          label: b.label,
        })),
        title: airboxSizeDistributionPresentation(dist).label,
      };
    };

    const notices: InspectorNotice<{ metric: AirboxStatsChartKey }>[] = (
      statistics?.warnings ?? []
    ).map((warning, idx) => ({
      id: `mesh-stat-warn-${idx}`,
      text: sanitizeStatusText(warning, "Quality warning reported"),
      title: `Mesh quality warning ${idx + 1}`,
      tone: "warn",
    }));

    return {
      id: "airbox.mesh.statistics",
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
          { id: "stats", label: "Statistics" },
        ],
        ...(lane !== "fdm" && refinementState.plan
          ? {
              primaryHeaderAction: {
                icon: Wrench,
                label: "Refine worst region",
                onRun: refineWorstRegion,
              },
            }
          : {}),
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:statistics",
        icon: Gauge,
        kindLabel:
          lane === "fdm"
            ? "FDM Airbox cell counts"
            : "Exterior element counts & quality distributions",
        statePill: () =>
          lane === "fdm"
            ? {
                label: domainMeta.data ? "Materialized" : "Not materialized",
                tone: domainMeta.data ? "ok" : "neutral",
              }
            : statistics
              ? { label: "Analyzed", tone: "ok" }
              : { label: "Not published", tone: "neutral" },
        title: () => "Airbox Mesh Statistics",
      },
      facts: () => [
        {
          id: "nodes",
          label: "Unique nodes",
          value:
            lane !== "fdm" && model.statistics.nodeCount !== null
              ? model.statistics.nodeCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "elems",
          label: "Air elements",
          value:
            lane !== "fdm" && model.statistics.elementCount !== null
              ? model.statistics.elementCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "edge",
          label: "Mean edge",
          value: meanEdgeM !== null ? formatLengthSmart(meanEdgeM) : null,
        },
        {
          id: "sicn",
          label: "Min SICN",
          value: minSicn !== null ? minSicn.toFixed(3) : null,
        },
      ],
      notices: () => notices,
      sections: [
        ...fdmSections,
        {
          defaultOpen: true,
          icon: Layers,
          id: "carrier-topology-counts",
          rows: [
            {
              format: () =>
                model.statistics.nodeCount !== null
                  ? model.statistics.nodeCount.toLocaleString("en-US")
                  : "Not published",
              label: "Points / nodes (unique across carriers)",
              type: "readonly",
            },
            {
              format: () =>
                model.statistics.elementCount !== null
                  ? model.statistics.elementCount.toLocaleString("en-US")
                  : "Not published",
              label: "Volume elements (all carriers)",
              type: "readonly",
            },
            ...byType.map(({ count, family }) => ({
              format: () => count.toLocaleString("en-US"),
              label: `Volume elements (${family}${typeScopeSuffix})`,
              type: "readonly" as const,
            })),
            {
              format: () =>
                model.statistics.boundaryFaceCount !== null
                  ? model.statistics.boundaryFaceCount.toLocaleString("en-US")
                  : "Not published",
              label: "Boundary faces",
              type: "readonly",
            },
            {
              format: () =>
                model.statistics.surfaceFaceCount !== null
                  ? model.statistics.surfaceFaceCount.toLocaleString("en-US")
                  : "Not published",
              label: "Surface faces",
              type: "readonly",
            },
            {
              format: () =>
                model.topology.sharedInterfaceNodes.count !== null
                  ? model.topology.sharedInterfaceNodes.count.toLocaleString(
                      "en-US",
                    )
                  : "Not published in report",
              label: "Shared interface nodes",
              type: "readonly",
            },
            {
              format: () => "Shared interface, not exclusive Airbox memory",
              label: "Interface node ownership",
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Deduplicated carrier & interface counts",
        },
        {
          defaultOpen: true,
          footer: () => (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => selectQualityMetric("sicn")}
              >
                Show heatmap (SICN)
              </Button>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => selectQualityMetric("gamma")}
              >
                Show heatmap (Gamma)
              </Button>
              <Button
                disabled={!refinementState.plan}
                disabledReason={sanitizeStatusText(
                  refinementState.reason,
                  "Local refinement not required",
                )}
                size="sm"
                type="button"
                variant="primary"
                onClick={() => void refineWorstRegion()}
              >
                Refine worst region
              </Button>
            </div>
          ),
          icon: Gauge,
          id: "histogram",
          rows: [
            {
              key: "metric",
              label: "Distribution series",
              options: [
                { label: "SICN", value: "sicn" },
                { label: "Gamma (γ)", value: "gamma" },
                { label: "Edge length", value: "edge_length" },
                { label: "Eq. size", value: "tetra_size" },
                { label: "Volume", value: "volume" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => {
                const chartData = buildChartForKey(ctx.draft.metric);
                if (!chartData) {
                  return (
                    <div className="rounded-md border border-fm-border-subtle px-3 py-3 text-xs text-fm-muted">
                      No published histogram bins for {ctx.draft.metric} on the
                      current mesh artifact.
                    </div>
                  );
                }
                const fontPx = (palette: ResolvedChartThemePalette) =>
                  Math.max(12, palette.fontSize);
                const optionBuilder = (palette: ResolvedChartThemePalette) => ({
                  animation: false,
                  grid: { bottom: 28, left: 44, right: 12, top: 14 },
                  series: [
                    {
                      data: chartData.bins.map((b) => ({
                        itemStyle: {
                          color: b.belowThreshold
                            ? palette.warning
                            : palette.accent,
                        },
                        value: b.count,
                      })),
                      type: "bar" as const,
                    },
                  ],
                  xAxis: {
                    axisLabel: {
                      color: palette.textMuted,
                      fontSize: fontPx(palette),
                    },
                    data: chartData.bins.map((b) => b.label),
                    type: "category" as const,
                  },
                  yAxis: {
                    axisLabel: {
                      color: palette.textMuted,
                      fontSize: fontPx(palette),
                    },
                    splitLine: { lineStyle: { color: palette.borderSubtle } },
                    type: "value" as const,
                  },
                });
                return (
                  <ScientificEChart
                    ariaLabel={`Airbox exterior mesh histogram (${chartData.title})`}
                    height={180}
                    optionBuilder={optionBuilder}
                  />
                );
              },
              type: "custom",
              wide: true,
            },
            ...(statistics?.metrics ?? []).map((metric) => ({
              format: () => {
                const min = metric.min !== null ? metric.min.toPrecision(3) : "—";
                const p05 =
                  metric.p05 !== null ? ` / p05 ${metric.p05.toPrecision(3)}` : "";
                const mean =
                  metric.mean !== null ? ` / mean ${metric.mean.toPrecision(3)}` : "";
                return `min ${min}${p05}${mean}`;
              },
              label: metric.label,
              type: "readonly" as const,
            })),
          ],
          showWhen: () => lane !== "fdm",
          title: "Quality & size histograms",
        },
        ...(lane !== "fdm" && (statistics?.sizeDistributions.length ?? 0) > 0
          ? [
              {
                defaultOpen: true,
                icon: Ruler,
                id: "size-distributions-hover",
                rows: [
                  {
                    render: () => (
                      <div className="grid min-w-0 gap-3">
                        {(statistics?.sizeDistributions ?? []).map((dist) => {
                          const pres = airboxSizeDistributionPresentation(dist);
                          const fmtVal = (v: number | null) =>
                            v === null
                              ? "—"
                              : dist.id === "volume"
                                ? `${v.toExponential(2)} m³`
                                : formatLengthSmart(v);
                          return (
                            <div
                              key={dist.id}
                              className="grid min-w-0 gap-1.5 rounded-md border border-fm-border-subtle p-2.5 text-xs"
                              data-distribution={dist.id}
                              onMouseLeave={() => hoverDistributionBin(dist, null)}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-medium text-fm-fg">
                                  {pres.label}
                                </span>
                                <span className="font-mono text-fm-muted">
                                  min {fmtVal(dist.min)} · mean {fmtVal(dist.mean)} · max{" "}
                                  {fmtVal(dist.max)}
                                </span>
                              </div>
                              {dist.histogram.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {dist.histogram.map((bin, idx) => (
                                    <Button
                                      key={`${dist.id}-${idx}`}
                                      size="sm"
                                      type="button"
                                      variant="ghost"
                                      onBlur={() => hoverDistributionBin(dist, null)}
                                      onClick={() => hoverDistributionBin(dist, idx)}
                                      onFocus={() => hoverDistributionBin(dist, idx)}
                                      onMouseEnter={() =>
                                        hoverDistributionBin(dist, idx)
                                      }
                                    >
                                      {bin.label}: {bin.count.toLocaleString("en-US")}
                                    </Button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ),
                    type: "custom" as const,
                    wide: true,
                  },
                ],
                title: "Element size bins (hover to highlight in 3D)",
              },
            ]
          : []),
        ...(lane !== "fdm" && model.statistics.qualityByFamily.length > 0
          ? [
              {
                defaultOpen: true,
                icon: Activity,
                id: "quality-by-family",
                rows: [
                  {
                    columns: [
                      {
                        header: "Family",
                        id: "fam",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const f =
                            r as (typeof model.statistics.qualityByFamily)[number];
                          return f.cellCount !== null
                            ? `${f.family} (${f.cellCount.toLocaleString("en-US")})`
                            : f.family;
                        },
                      },
                      {
                        align: "right" as const,
                        header: "SICN / Gamma",
                        id: "sg",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const f =
                            r as (typeof model.statistics.qualityByFamily)[number];
                          const s =
                            f.sicn?.status === "available" &&
                            f.sicn.min !== null
                              ? `${f.sicn.min.toPrecision(3)}${f.sicn.max !== null ? `..${f.sicn.max.toPrecision(3)}` : ""}`
                              : "Omitted";
                          const g =
                            f.gamma?.status === "available" &&
                            f.gamma.min !== null
                              ? `${f.gamma.min.toPrecision(3)}${f.gamma.max !== null ? `..${f.gamma.max.toPrecision(3)}` : ""}`
                              : "Omitted";
                          return `${s} / ${g}`;
                        },
                      },
                      {
                        align: "right" as const,
                        header: "Scaled Jacobian",
                        id: "jac",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const f =
                            r as (typeof model.statistics.qualityByFamily)[number];
                          const mj = f.mixedTopologyScaledJacobian;
                          if (
                            mj?.status === "available" &&
                            mj.min !== null
                          ) {
                            const p05Text =
                              mj.p05 !== null
                                ? ` (p05 ${mj.p05.toPrecision(3)})`
                                : "";
                            return `min ${mj.min.toPrecision(3)}${p05Text}`;
                          }
                          return sanitizeStatusText(mj?.reason, "Not published");
                        },
                      },
                    ],
                    label: "Quality by element family",
                    rowKey: (r: unknown) =>
                      (r as (typeof model.statistics.qualityByFamily)[number])
                        .family,
                    rows: () => model.statistics.qualityByFamily,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Mixed-topology quality by element family",
              },
            ]
          : []),
        ...(lane !== "fdm" && (statistics?.worstElements.length ?? 0) > 0
          ? [
              {
                defaultOpen: false,
                icon: AlertTriangle,
                id: "worst-elements",
                rows: [
                  {
                    columns: [
                      {
                        header: "Element",
                        id: "el",
                        mono: true,
                        renderCell: (r: unknown) =>
                          `#${(r as MeshWorstElement).elementIndex}`,
                      },
                      {
                        header: "Scope",
                        id: "sc",
                        renderCell: (r: unknown) =>
                          sanitizeStatusText(
                            (r as MeshWorstElement).scopeLabel,
                            "Airbox",
                          ),
                      },
                      {
                        align: "right" as const,
                        header: "SICN / γ",
                        id: "q",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const el = r as MeshWorstElement;
                          const s =
                            el.sicn !== null ? el.sicn.toPrecision(3) : "—";
                          const g =
                            el.gamma !== null ? el.gamma.toPrecision(3) : "—";
                          return `${s} / ${g}`;
                        },
                      },
                    ],
                    label: "Worst elements",
                    onSelectRow: (r: unknown) =>
                      selectWorstElement(r as MeshWorstElement),
                    rowKey: (r: unknown) => {
                      const el = r as MeshWorstElement;
                      return `${el.elementIndex}:${el.scopeLabel}`;
                    },
                    rows: () => statistics?.worstElements ?? [],
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Worst elements (click to inspect in 3D)",
              },
            ]
          : []),
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          lane === "fdm"
            ? "Structured FDM Airbox cell statistics"
            : "Deduplicated Airbox carrier & quality statistics",
      },
    };
  }, [
    domainMeta,
    fdmMembership.data,
    hoverDistributionBin,
    lane,
    model,
    multilayerLayout.data,
    refineWorstRegion,
    refinementState.plan,
    refinementState.reason,
    roleEvidence,
    selectQualityMetric,
    selectWorstElement,
    statistics,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
