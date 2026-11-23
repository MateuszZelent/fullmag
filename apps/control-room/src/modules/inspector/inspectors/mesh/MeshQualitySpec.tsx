"use client";

import { Gauge, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  SpecInspectorHost,
  type InspectorPanelProps,
  type InspectorSpec,
} from "@/modules/inspector/shared";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import {
  normalizeMeshQualityStatistics,
  type MeshQualityMetric,
  type MeshQualityStatistics,
  type MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";

import {
  MeshQualityStatisticsSpecView,
  QualityGatesSpecView,
  sanitizeMeshDisplayText,
} from "../../panels/mesh-details/MeshQualityAndHistorySpecViews";
import { resolveMixedCertificateQualityPresentation } from "../../panels/mesh-details/MeshQualityGatesSection.model";
import { resolveCurrentMixedCertificateQualityPresentation } from "../../panels/mesh-details/useMeshDetailsModel";
import type { MeshSizeDistributionHoverBin } from "../../panels/MeshQualityChart";
import { emitMeshSizeHistogramHover } from "../../panels/meshSizeHistogramHover";
import {
  asNumber,
  asRecord,
  asString,
  formatLengthSmart,
  useSafeMeshSharedDomainQualityResource,
  type JsonRecord,
} from "./meshShared";

export interface MeshQualityDraft {
  metric: "all" | "sicn" | "gamma" | "skewness" | "aspect_ratio";
}

function adaptQualityGatesStatisticsFallback(
  statsRec: JsonRecord | null,
): MeshQualityStatistics | null {
  if (!statsRec) return null;
  const normalized = normalizeMeshQualityStatistics(statsRec);
  if (normalized && normalized.metrics.length > 0) {
    return normalized;
  }
  const histograms = asRecord(statsRec.histograms);
  if (!histograms) return normalized;

  const metrics: MeshQualityMetric[] = [];
  for (const [id, label] of [
    ["sicn", "SICN"],
    ["gamma", "Gamma (γ)"],
    ["skewness", "Skewness"],
    ["aspect_ratio", "Aspect ratio"],
  ] as const) {
    const histRec = asRecord(histograms[id]);
    const rawBins = Array.isArray(histRec?.bins) ? histRec.bins : null;
    if (!rawBins || rawBins.length === 0) continue;
    const total = rawBins.reduce(
      (acc, b) => acc + (asNumber(asRecord(b)?.count) ?? 0),
      0,
    );
    const threshold = asNumber(histRec?.threshold);
    metrics.push({
      belowThresholdCount: null,
      belowThresholdFraction: null,
      histogram: rawBins.map((b) => {
        const br = asRecord(b) ?? {};
        const lo = asNumber(br.min) ?? asNumber(br.lo);
        const hi = asNumber(br.max) ?? asNumber(br.hi);
        const count = asNumber(br.count) ?? 0;
        return {
          count,
          fraction: total > 0 ? count / total : 0,
          hi,
          label:
            lo !== null && hi !== null
              ? `${lo.toFixed(2)}–${hi.toFixed(2)}`
              : asString(br.label) ?? "bin",
          lo,
        };
      }),
      id: id as MeshQualityMetric["id"],
      label,
      max: asNumber(histRec?.max) ?? null,
      mean: asNumber(histRec?.mean) ?? null,
      min: asNumber(histRec?.min) ?? asNumber(statsRec.min_quality),
      p05: asNumber(histRec?.p05) ?? asNumber(statsRec.p05_quality),
      threshold,
    });
  }

  if (metrics.length === 0) return normalized;
  const meanEdge = asNumber(statsRec.mean_edge_length_m);
  return {
    edgeLength:
      meanEdge !== null
        ? { max: null, mean: meanEdge, min: null, std: null }
        : null,
    elementCount: asNumber(statsRec.element_count),
    meshName: null,
    metrics,
    qualitySource: "quality-gates",
    sizeDistributions: normalized?.sizeDistributions ?? [],
    volumeRatio: null,
    warnings: normalized?.warnings ?? [],
    worstElements: normalized?.worstElements ?? [],
    worstElementsByMetric: normalized?.worstElementsByMetric ?? {
      gamma: [],
      sicn: [],
    },
  };
}

export function MeshQualityInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const currentMeshRevision = sessionStatusHooks.useSessionStatusSelector(
    (s) => s.data?.resources?.mesh_revision ?? null,
  );

  const qualityGatesRes =
    geometryLifecycleResources.useMeshSharedDomainQualityGatesResource();
  const semanticsRes = geometryLifecycleResources.useMeshSemanticsResource();
  const sharedReportRes = geometryLifecycleResources.useMeshSharedDomainReportResource();
  const sharedQualityRes = useSafeMeshSharedDomainQualityResource();
  const manifestRes = geometryLifecycleResources.useMeshSharedDomainManifestResource();
  const summaryRes = geometryLifecycleResources.useMeshSummaryResource();

  const baseline = useMemo<MeshQualityDraft>(() => ({ metric: "all" }), []);

  const rawData = asRecord(qualityGatesRes.data);
  const mixedCertificate = useMemo(() => {
    if (rawData && Object.hasOwn(rawData, "revision")) {
      return resolveCurrentMixedCertificateQualityPresentation({
        currentMeshRevision,
        data: qualityGatesRes.data,
        resourceStatus: qualityGatesRes.status,
      });
    }
    return resolveMixedCertificateQualityPresentation(
      rawData?.mixed_certificate ?? rawData,
    );
  }, [currentMeshRevision, qualityGatesRes.data, qualityGatesRes.status, rawData]);

  const checks = useMemo(() => {
    const gatesObj = asRecord(rawData?.gates);
    const rawChecks = Array.isArray(gatesObj?.checks) ? gatesObj.checks : [];
    return rawChecks.map((entry, index) => {
      const c = asRecord(entry) ?? {};
      const rawStatus = (asString(c.status) ?? "pass").toLowerCase();
      const status: "pass" | "warn" | "failed" =
        rawStatus.includes("fail") || rawStatus.includes("reject")
          ? "failed"
          : rawStatus.includes("warn")
            ? "warn"
            : "pass";
      return {
        id: asString(c.id) ?? `check_${index}`,
        status,
        value: sanitizeMeshDisplayText(c.value, "—"),
      };
    });
  }, [rawData?.gates]);

  const qualityStatistics = useMemo<MeshQualityStatistics | null>(() => {
    const primarySource =
      asRecord(asRecord(semanticsRes.data)?.mesh_build_diagnostics)?.mesh_statistics ??
      asRecord(asRecord(sharedReportRes.data)?.report)?.mesh_statistics ??
      asRecord(sharedQualityRes.data)?.quality ??
      null;
    const normalizedPrimary = normalizeMeshQualityStatistics(primarySource);
    if (normalizedPrimary && normalizedPrimary.metrics.length > 0) {
      return normalizedPrimary;
    }
    return (
      adaptQualityGatesStatisticsFallback(asRecord(rawData?.statistics)) ??
      normalizedPrimary
    );
  }, [rawData?.statistics, semanticsRes.data, sharedQualityRes.data, sharedReportRes.data]);

  const refinementState = useMemo(
    () => resolveMeshQualityRefinementState(qualityStatistics),
    [qualityStatistics],
  );

  useEffect(() => {
    const currentGenerationId = manifestRes.data?.generation_id;
    const currentSelection = kernel.selection?.get?.();
    if (
      currentSelection?.ref?.type === "mesh-quality-element" &&
      currentSelection.ref.generationId &&
      currentGenerationId &&
      currentSelection.ref.generationId !== currentGenerationId
    ) {
      kernel.selection.clear?.("mesh");
    }
  }, [kernel.selection, manifestRes.data?.generation_id]);

  const handleSelectMetric = useCallback(
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
    [kernel.layout, kernel.selection],
  );

  const handleSelectWorstElement = useCallback(
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
            meshRevision: asNumber(summaryRes.data?.revision),
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
      kernel.layout,
      kernel.selection,
      manifestRes.data?.generation_id,
      manifestRes.data?.mesh_id,
      summaryRes.data?.revision,
    ],
  );

  const handleRefineWorstElement = useCallback(() => {
    if (!refinementState.plan) return;
    void kernel.commands.execute(
      "mesh.refine-worst-quality-element",
      createCommandContext("inspector", kernel, {
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "mesh.quality",
      }),
      {
        elementIndex: refinementState.plan.elementIndex,
        meshOptions: refinementState.plan.meshOptions,
      },
    );
  }, [kernel, refinementState.plan, sessionScopeKey]);

  const handleHoverSizeBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: { kind: "all" },
      });
    },
    [kernel],
  );

  const statsRec = asRecord(rawData?.statistics);
  const minQuality =
    qualityStatistics?.metrics[0]?.min ?? asNumber(statsRec?.min_quality);
  const p05Quality =
    qualityStatistics?.metrics[0]?.p05 ?? asNumber(statsRec?.p05_quality);
  const meanEdgeM =
    qualityStatistics?.edgeLength?.mean ?? asNumber(statsRec?.mean_edge_length_m);
  const elementCount =
    qualityStatistics?.elementCount ?? asNumber(statsRec?.element_count);

  const hasFailure =
    mixedCertificate.status === "rejected" ||
    mixedCertificate.familyGates.some((g) => g.status === "failed") ||
    checks.some((c) => c.status === "failed");

  const spec = useMemo<InspectorSpec<MeshQualityDraft>>(
    () => ({
      id: "mesh.quality",
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
          { id: "quality", label: "Quality Gates" },
        ],
        canFitView: true,
        primaryHeaderAction: refinementState.plan
          ? {
              icon: Gauge,
              label: "Refine worst region",
              onRun: async () => {
                handleRefineWorstElement();
              },
            }
          : undefined,
      },
      identity: {
        domain: "mesh",
        entityId: "model:mesh:quality",
        icon: Gauge,
        kindLabel: "FEM quality certificate & distributions",
        statePill: () =>
          hasFailure
            ? { label: "Rejected", tone: "err" }
            : mixedCertificate.status === "valid"
              ? { label: "Qualified", tone: "ok" }
              : { label: "Pending", tone: "neutral" },
        title: () => "Mesh Quality & Qualification",
      },
      facts: () => [
        {
          id: "min-q",
          label: "Min quality",
          tone: minQuality !== null && minQuality <= 0 ? "err" : undefined,
          value: minQuality !== null ? minQuality.toFixed(3) : null,
        },
        {
          id: "p05-q",
          label: "P05 quality",
          value: p05Quality !== null ? p05Quality.toFixed(3) : null,
        },
        {
          id: "elements",
          label: "Elements",
          value: elementCount !== null ? elementCount.toLocaleString("en-US") : null,
        },
        {
          id: "mean-edge",
          label: "Mean edge",
          value: formatLengthSmart(meanEdgeM),
        },
      ],
      notices: () =>
        hasFailure
          ? [
              {
                id: "mixed-cert-rejected",
                text: `Mixed-topology quality gate failed: ${sanitizeMeshDisplayText(mixedCertificate.reason)}`,
                title: "Certificate rejected",
                tone: "err",
              },
            ]
          : [],
      sections: [
        {
          defaultOpen: true,
          icon: ShieldCheck,
          id: "quality-gates",
          rows: [
            {
              render: () => (
                <QualityGatesSpecView
                  checks={checks}
                  gates={mixedCertificate.familyGates}
                  mixedCertificate={mixedCertificate}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          summary: () =>
            hasFailure
              ? `${mixedCertificate.familyGates.filter((g) => g.status === "failed").length} failed`
              : "All gates passed",
          title: "Quality gates & Mixed-P1 certificate",
        },
        {
          defaultOpen: true,
          icon: Gauge,
          id: "quality-distribution",
          rows: [
            {
              key: "metric",
              label: "Quality metric filter",
              options: [
                { label: "All", value: "all" },
                { label: "SICN", value: "sicn" },
                { label: "Gamma (γ)", value: "gamma" },
                { label: "Skewness", value: "skewness" },
                { label: "Aspect", value: "aspect_ratio" },
              ],
              type: "segmented",
            },
            {
              render: (ctx) => (
                <MeshQualityStatisticsSpecView
                  activeMetricFilter={ctx.draft.metric}
                  refinementState={refinementState}
                  statistics={qualityStatistics}
                  onHoverSizeDistributionBin={handleHoverSizeBin}
                  onRefineWorstElement={handleRefineWorstElement}
                  onSelectMetric={handleSelectMetric}
                  onSelectWorstElement={handleSelectWorstElement}
                />
              ),
              type: "custom",
              wide: true,
            },
          ],
          title: "Quality distributions, size bins & worst elements",
        },
      ],
      details: () => [
        {
          label: "Certificate schema",
          mono: true,
          value:
            mixedCertificate.certificateSchemaVersion !== "not published"
              ? mixedCertificate.certificateSchemaVersion
              : null,
        },
        {
          label: "Topology fingerprint",
          mono: true,
          value:
            mixedCertificate.topologyFingerprint !== "not published"
              ? mixedCertificate.topologyFingerprint
              : null,
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Interactive FEM quality qualification & heatmap inspection",
      },
    }),
    [
      checks,
      elementCount,
      handleHoverSizeBin,
      handleRefineWorstElement,
      handleSelectMetric,
      handleSelectWorstElement,
      hasFailure,
      meanEdgeM,
      minQuality,
      mixedCertificate,
      p05Quality,
      qualityStatistics,
      refinementState,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}
