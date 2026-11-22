"use client";

import {
  Activity,
  AlertTriangle,
  Box,
  Compass,
  Eye,
  Gauge,
  Grid3x3,
  History,
  Layers,
  RotateCcw,
  Ruler,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  useDomainMetaResource,
  useFdmMultilayerLayoutResource,
  useMeshSharedDomainManifestResource,
  useMeshSummaryResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";
import {
  SESSION_STATUS_RESOURCE_KEY,
  useSessionResourceIdentity,
} from "@/kernel/resources/useSessionStatus";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import {
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import {
  normalizeMeshBuildPhases,
  type NormalizedMeshBuildPhase,
} from "@/shared/domain/mesh/meshBuildPhases";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import {
  normalizeMeshQualityStatistics,
  type MeshQualityMetric,
  type MeshSizeDistribution,
  type MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import { buildMeshSizeDistributionHoverBin } from "../meshHistogramHoverState";
import { resolveMixedCertificateQualityPresentation } from "../mesh-details/MeshQualityGatesSection.model";
import { SpecInspectorHost } from "../mesh-details/SpecInspectorHost";
import { emitMeshSizeHistogramHover } from "../meshSizeHistogramHover";
import { airboxEffectiveLengthUnit } from "./airboxDisplay.model";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";
import {
  aggregateAirboxBounds,
  aggregateAirboxMeshParts,
  airboxSizeDistributionPresentation,
  buildAirboxMeshBuildModel,
  buildAirboxMeshInspectorModel,
  currentAirboxQualityEvidence,
  currentAirboxReportEvidence,
  findAirboxParts,
  findCanonicalAirboxPart,
} from "./airboxMeshInspectorModel";
import {
  AIRBOX_GRADING_MODES,
  draftFromEffectiveUniverseMeshPolicyResource,
  formatUniverseMeshPolicyConfig,
  type AirboxMeshPolicyLane,
} from "./airboxMeshPolicyDraft";
import {
  asNumber,
  asRecord,
  asString,
  asTuple3,
  buildFdmAirboxFactsSections,
  computeSceneObjectsEnvelope,
  formatLengthSmart,
  formatTupleSi,
  formatTupleSmart,
  isConflictApiError,
  LENGTH_UNITS,
  resolveFdmRoleEvidence,
  sanitizeStatusText,
  submitCanonicalUniversePolicy,
  useSafeAirboxTargetVisualization,
  useSafeFdmRegionMembershipResource,
  useSafeGeometryDiagnosticsResource,
  useSafeMeshBuildCurrent,
  useSafeMeshBuildLatestSuccessful,
  useSafeMeshSharedDomainQualityGatesResource,
  useSafeMeshSharedDomainQualityResource,
  type JsonRecord,
} from "./airboxSpecShared";

const EFFECTIVE_POLICY_KEYS = [
  "mode",
  "airbox_hmax",
  "airbox_hmin",
  "airbox_growth_rate",
  "airbox_grading",
  "airbox_curvature_factor",
  "airbox_narrow_region_resolution",
  "padding",
  "size",
  "center",
] as const;

const FDM_EFFECTIVE_POLICY_KEYS = ["mode", "padding", "size", "center"] as const;

const FEM_ONLY_POLICY_KEYS = [
  "airbox_grading",
  "airbox_growth_rate",
  "airbox_hmax",
  "airbox_hmin",
  "airbox_curvature_factor",
  "airbox_narrow_region_resolution",
  "curvature_factor",
  "narrow_region_resolution",
  "maximum_element_size",
  "minimum_element_size",
] as const;

function formatEffectiveValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return "Not set";
  if (Array.isArray(value)) {
    const tuple = asTuple3(value);
    if (tuple && airboxEffectiveLengthUnit(key) === "m") {
      return formatTupleSmart(tuple);
    }
    return `[${value.map((item) => String(item)).join(", ")}]`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return airboxEffectiveLengthUnit(key) === "m"
      ? formatLengthSmart(value)
      : Number(value.toPrecision(6)).toString();
  }
  if (typeof value === "string") return sanitizeStatusText(value, "Not set");
  return JSON.stringify(value);
}

function readTargetMetric(
  target: JsonRecord | null | undefined,
  ...keys: string[]
): number | null {
  if (!target) return null;
  for (const key of keys) {
    const num = asNumber(target[key]);
    if (num !== null) return num;
  }
  return null;
}

// ============================================================================
// 3.1 airbox.mesh — AirboxMeshInspectorSpecPanel
// ============================================================================

export function AirboxMeshInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const femEnabled = lane !== "fdm";

  const policy = useUniverseMeshPolicyResource();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(femEnabled, runtimeStatus),
  });
  const currentBuild = useSafeMeshBuildCurrent({
    enabled: femEnabled && shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const latestBuild = useSafeMeshBuildLatestSuccessful({
    enabled: femEnabled && shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const quality = useMeshUniverseQualityResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const report = useMeshUniverseReportResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const summary = useMeshSummaryResource({
    enabled: femEnabled && shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const scene = useSceneResource();

  // FDM lane resources
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
    manifest.data,
  );
  const topologyMatches =
    (manifest.status === "ready" && topologyIdentityMatches) ||
    (runtimeStatus === null && manifest.data != null);
  const currentMeshRevision =
    runtimeStatus?.resources.mesh_revision ?? summary.data?.revision ?? null;

  const qualityEvidence = currentAirboxQualityEvidence(
    quality,
    topologyMatches,
    currentMeshRevision,
  );
  const reportEvidence = currentAirboxReportEvidence(
    report,
    topologyMatches,
    currentMeshRevision,
  );

  const model = useMemo(
    () =>
      buildAirboxMeshInspectorModel({
        currentSceneRevision,
        manifest: topologyMatches ? (manifest.data ?? null) : null,
        policy: policy.data ?? {
          config: null,
          effective_config: null,
          revision: 0,
        },
        quality: qualityEvidence,
        report: reportEvidence,
        summary: topologyMatches ? (summary.data ?? null) : null,
      }),
    [
      currentSceneRevision,
      manifest.data,
      policy.data,
      qualityEvidence,
      reportEvidence,
      summary.data,
      topologyMatches,
    ],
  );

  const buildModel = useMemo(
    () =>
      buildAirboxMeshBuildModel({
        current: currentBuild.data ?? null,
        currentSceneRevision,
        latest: latestBuild.data ?? null,
        report: reportEvidence,
      }),
    [currentBuild.data, currentSceneRevision, latestBuild.data, reportEvidence],
  );

  const aggregate = useMemo(
    () => aggregateAirboxMeshParts(model.airboxParts),
    [model.airboxParts],
  );

  const effectiveTarget =
    buildModel.effectiveAirboxTarget ??
    model.parameters.resolvedTarget ??
    asRecord(summary.data?.effective_airbox_target);
  const targetHmax = readTargetMetric(
    effectiveTarget,
    "maximum_element_size",
    "hmax",
    "airbox_hmax",
  );
  const targetHmin = readTargetMetric(
    effectiveTarget,
    "minimum_element_size",
    "hmin",
    "airbox_hmin",
  );
  const targetGrowth = readTargetMetric(
    effectiveTarget,
    "growth_rate",
    "airbox_growth_rate",
  );

  const lastBuildError =
    asString(currentBuild.data?.last_build_error) ??
    asString(latestBuild.data?.last_build_error);

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

  const baseline = useMemo(() => ({ view: "summary" }), []);

  const spec = useMemo<InspectorSpec<{ view: string }>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<{ view: string }>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "overview",
          })
        : [];

    const statePill = (): { label: string; tone: InspectorTone } => {
      if (lane === "fdm") {
        return domainMeta.data
          ? { label: "FDM grid", tone: "ok" }
          : { label: "Not materialized", tone: "neutral" };
      }
      if (lastBuildError) return { label: "Build failed", tone: "err" };
      if (!topologyMatches && manifest.status === "ready") {
        return { label: "Stale identity", tone: "stale" };
      }
      if (model.lifecycle.status === "current") {
        return { label: "Current", tone: "ok" };
      }
      if (model.lifecycle.status === "stale") {
        return { label: "Stale", tone: "warn" };
      }
      return { label: "Not built", tone: "neutral" };
    };

    const notices: InspectorNotice<{ view: string }>[] = [];
    if (lastBuildError) {
      notices.push({
        id: "airbox-mesh-build-error",
        quickFix: {
          label: "Inspect Build Details",
          onApply: (ctx) =>
            ctx.selectNode({
              kind: "airbox.mesh.build",
              label: "Build",
              nodeId: "model:airbox:mesh:build",
              objectId: null,
              ref: {
                kind: "airbox.mesh.build",
                nodeId: "model:airbox:mesh:build",
                type: "airbox",
                visualizationTargetId: "airbox",
              },
            }),
        },
        text: lastBuildError,
        title: "Latest shared-domain mesh build reported an error",
        tone: "err",
      });
    }
    if (
      lane !== "fdm" &&
      manifest.status === "ready" &&
      !topologyIdentityMatches
    ) {
      notices.push({
        id: "airbox-mesh-stale-identity",
        text: "Published mesh manifest belongs to an earlier FEM generation or revision; rebuild shared-domain mesh to synchronize.",
        title: "Topology identity mismatch",
        tone: "warn",
      });
    }

    const configuredHmax = asNumber(
      model.parameters.authored?.airbox_hmax ??
        model.parameters.effective?.airbox_hmax,
    );
    const configuredHmin = asNumber(
      model.parameters.authored?.airbox_hmin ??
        model.parameters.effective?.airbox_hmin,
    );
    const configuredGrowth = asNumber(
      model.parameters.authored?.airbox_growth_rate ??
        model.parameters.effective?.airbox_growth_rate,
    );

    return {
      id: "airbox.mesh",
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          { id: "mesh", label: "Mesh" },
        ],
        canFitView: true,
        primaryHeaderAction: {
          icon: Grid3x3,
          label:
            lane === "fdm" ? "Build FDM Grid" : "Build Shared-Domain Mesh",
          onRun: async () => {
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
                sourceDetail: "airbox.mesh",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh",
        icon: Grid3x3,
        kindLabel:
          lane === "fdm"
            ? "FDM structured Airbox overview"
            : "FEM exterior air mesh overview",
        statePill,
        title: () => "Airbox Exterior Mesh",
      },
      facts: () => [
        {
          id: "elems",
          label: lane === "fdm" ? "Grid shape" : "Air elements",
          value:
            lane === "fdm"
              ? domainMeta.data?.grid?.shape?.join(" × ") ?? null
              : aggregate.elementCount !== null
                ? aggregate.elementCount.toLocaleString("en-US")
                : null,
        },
        {
          id: "nodes",
          label: "Air nodes",
          value:
            lane !== "fdm" && aggregate.nodeCount !== null
              ? aggregate.nodeCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "sync",
          label: "Freshness",
          value:
            lane === "fdm"
              ? domainMeta.data
                ? "Materialized"
                : "Not materialized"
              : model.lifecycle.status === "current"
                ? "Current"
                : model.lifecycle.status === "stale"
                  ? "Stale"
                  : "Not built",
        },
        {
          id: "rev",
          label: "Mesh rev",
          value:
            summary.data?.revision != null ? String(summary.data.revision) : null,
        },
      ],
      notices: () => notices,
      sections: [
        ...fdmSections,
        {
          defaultOpen: true,
          icon: Layers,
          id: "exterior-summary",
          rows: [
            {
              format: () =>
                !topologyIdentityMatches && manifest.status === "ready"
                  ? "Stale manifest (topology identity mismatch)"
                  : topologyMatches
                    ? "Matches current FEM generation"
                    : manifest.status === "loading"
                      ? "Checking backend manifest"
                      : "Not built yet",
              label: "Topology identity",
              type: "readonly",
            },
            {
              format: () => sanitizeStatusText(model.lifecycle.reason, "Not built yet"),
              label: "Realization freshness",
              type: "readonly",
            },
            {
              format: () => aggregate.carrierCount.toLocaleString("en-US"),
              label: "Airbox carriers",
              type: "readonly",
            },
            {
              format: () =>
                aggregate.nodeCount !== null
                  ? `${aggregate.nodeCount.toLocaleString("en-US")} (${aggregate.nodeCountExact ? "deduplicated" : "carrier range"})`
                  : "Not built yet",
              label: "Unique exterior nodes",
              type: "readonly",
            },
            {
              format: () =>
                aggregate.elementCount !== null
                  ? `${aggregate.elementCount.toLocaleString("en-US")} elements`
                  : "Not built yet",
              label: "Exterior element count",
              symbol: (
                <>
                  N<sub>air</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                aggregate.boundaryFaceCount !== null
                  ? aggregate.boundaryFaceCount.toLocaleString("en-US")
                  : "Not built yet",
              label: "Exterior boundary faces",
              type: "readonly",
            },
            {
              format: () =>
                model.qualityGates.status === "pass"
                  ? "Passed"
                  : model.qualityGates.status === "fail"
                    ? "Failed"
                    : "Pending build",
              label: "Quality gates",
              type: "readonly",
            },
            ...(lastBuildError
              ? [
                  {
                    format: () => lastBuildError,
                    label: "Last build error",
                    type: "readonly" as const,
                  },
                ]
              : []),
          ],
          showWhen: () => lane !== "fdm",
          title: "Exterior mesh & topology summary",
        },
        {
          defaultOpen: true,
          icon: Ruler,
          id: "effective-airbox-target",
          rows: [
            {
              format: () => formatLengthSmart(configuredHmax),
              label: "Configured max size",
              symbol: (
                <>
                  h<sub>max,cfg</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => formatLengthSmart(configuredHmin),
              label: "Configured min size",
              symbol: (
                <>
                  h<sub>min,cfg</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                configuredGrowth !== null ? String(configuredGrowth) : "—",
              label: "Configured growth rate",
              symbol: (
                <>
                  g<sub>cfg</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => formatLengthSmart(targetHmax),
              label: "Build target max size",
              symbol: (
                <>
                  h<sub>max,eff</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () => formatLengthSmart(targetHmin),
              label: "Build target min size",
              symbol: (
                <>
                  h<sub>min,eff</sub>
                </>
              ),
              type: "readonly",
            },
            {
              format: () =>
                targetGrowth !== null ? Number(targetGrowth.toPrecision(5)).toString() : "—",
              label: "Build target growth rate",
              symbol: (
                <>
                  g<sub>eff</sub>
                </>
              ),
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Effective Airbox target",
        },
        {
          defaultOpen: true,
          icon: Compass,
          id: "sub-inspectors-nav",
          rows: [
            {
              items: () => [
                {
                  id: "params",
                  jumpSelection: {
                    kind: "airbox.mesh.parameters",
                    label: "Parameters",
                    nodeId: "model:airbox:mesh:parameters",
                    objectId: null,
                    ref: {
                      kind: "airbox.mesh.parameters",
                      nodeId: "model:airbox:mesh:parameters",
                      type: "airbox",
                      visualizationTargetId: "airbox",
                    },
                  },
                  label: "Parameters",
                },
                {
                  id: "gates",
                  jumpSelection: {
                    kind: "airbox.mesh.quality-gates",
                    label: "Quality Gates",
                    nodeId: "model:airbox:mesh:quality-gates",
                    objectId: null,
                    ref: {
                      kind: "airbox.mesh.quality-gates",
                      nodeId: "model:airbox:mesh:quality-gates",
                      type: "airbox",
                      visualizationTargetId: "airbox",
                    },
                  },
                  label: "Quality Gates",
                },
                {
                  id: "stats",
                  jumpSelection: {
                    kind: "airbox.mesh.statistics",
                    label: "Statistics",
                    nodeId: "model:airbox:mesh:statistics",
                    objectId: null,
                    ref: {
                      kind: "airbox.mesh.statistics",
                      nodeId: "model:airbox:mesh:statistics",
                      type: "airbox",
                      visualizationTargetId: "airbox",
                    },
                  },
                  label: "Statistics",
                },
                {
                  id: "topology",
                  jumpSelection: {
                    kind: "airbox.mesh.topology",
                    label: "Topology",
                    nodeId: "model:airbox:mesh:topology",
                    objectId: null,
                    ref: {
                      kind: "airbox.mesh.topology",
                      nodeId: "model:airbox:mesh:topology",
                      type: "airbox",
                      visualizationTargetId: "airbox",
                    },
                  },
                  label: "Topology",
                },
                {
                  id: "build",
                  jumpSelection: {
                    kind: "airbox.mesh.build",
                    label: "Build",
                    nodeId: "model:airbox:mesh:build",
                    objectId: null,
                    ref: {
                      kind: "airbox.mesh.build",
                      nodeId: "model:airbox:mesh:build",
                      type: "airbox",
                      visualizationTargetId: "airbox",
                    },
                  },
                  label: "Build",
                },
              ],
              label: "Sub-inspectors",
              type: "chips",
            },
          ],
          title: "Airbox mesh navigation",
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          lane === "fdm"
            ? "Structured FDM Airbox overview"
            : "Edit sizing in Parameters or bounds in Airbox",
      },
    };
  }, [
    aggregate,
    domainMeta,
    fdmMembership.data,
    kernel,
    lane,
    lastBuildError,
    manifest.status,
    model,
    multilayerLayout.data,
    roleEvidence,
    runtimeStatus,
    sessionScopeKey,
    summary.data,
    targetGrowth,
    targetHmax,
    targetHmin,
    topologyIdentityMatches,
    topologyMatches,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

// ============================================================================
// 3.2 airbox.mesh.parameters — AirboxMeshParametersInspectorSpecPanel
// ============================================================================

export interface AirboxMeshParamsDraft {
  extentMode: "auto" | "manual";
  hasPadding: boolean;
  paddingM: readonly [number, number, number];
  manualSizeM: readonly [number, number, number];
  hasManualCenter: boolean;
  manualCenterM: readonly [number, number, number];
  hasAirboxHmax: boolean;
  airboxHmaxM: number;
  hasAirboxHmin: boolean;
  airboxHminM: number;
  gradingChoice: "default" | "auto" | "geometric" | "linear";
  hasGrowthRate: boolean;
  growthRate: number;
  hasCurvatureFactor: boolean;
  curvatureFactor: number;
  hasNarrowGapResolution: boolean;
  narrowGapResolution: number;
}

function paramsDraftFromConfig(
  config: JsonRecord | null | undefined,
  effective: JsonRecord | null | undefined,
): AirboxMeshParamsDraft {
  const cfg = config ?? {};
  const eff = effective ?? {};
  const rawMode = asString(cfg.mode) ?? asString(eff.mode) ?? "auto";
  const extentMode: "auto" | "manual" = rawMode === "manual" ? "manual" : "auto";

  const authoredPad = asTuple3(cfg.padding);
  const effPad = asTuple3(eff.padding) ?? [8e-8, 8e-8, 1.2e-7];
  const authoredSize = asTuple3(cfg.size);
  const effSize = asTuple3(eff.size) ?? [1.6e-6, 8e-7, 2.4e-7];
  const authoredCenter = asTuple3(cfg.center);
  const effCenter = asTuple3(eff.center) ?? [0, 0, 0];

  const authoredHmax =
    asNumber(cfg.airbox_hmax) ?? asNumber(cfg.maximum_element_size);
  const effHmax =
    asNumber(eff.airbox_hmax) ?? asNumber(eff.maximum_element_size) ?? 4e-8;

  const authoredHmin =
    asNumber(cfg.airbox_hmin) ?? asNumber(cfg.minimum_element_size);
  const effHmin =
    asNumber(eff.airbox_hmin) ?? asNumber(eff.minimum_element_size) ?? 5e-9;

  const hasGrading = Object.prototype.hasOwnProperty.call(cfg, "airbox_grading");
  const rawGrading = asString(cfg.airbox_grading);
  const gradingChoice: AirboxMeshParamsDraft["gradingChoice"] =
    hasGrading &&
    rawGrading &&
    (AIRBOX_GRADING_MODES as readonly string[]).includes(rawGrading)
      ? (rawGrading as "auto" | "geometric" | "linear")
      : "default";

  const authoredGrowth = asNumber(cfg.airbox_growth_rate);
  const effGrowth = asNumber(eff.airbox_growth_rate) ?? 1.3;

  const authoredCurvature =
    asNumber(cfg.airbox_curvature_factor) ?? asNumber(cfg.curvature_factor);
  const effCurvature =
    asNumber(eff.airbox_curvature_factor) ?? asNumber(eff.curvature_factor) ?? 0.3;

  const authoredNarrow =
    asNumber(cfg.airbox_narrow_region_resolution) ??
    asNumber(cfg.narrow_region_resolution);
  const effNarrow =
    asNumber(eff.airbox_narrow_region_resolution) ??
    asNumber(eff.narrow_region_resolution) ??
    2;

  return {
    airboxHmaxM: authoredHmax ?? effHmax,
    airboxHminM: authoredHmin ?? effHmin,
    curvatureFactor: authoredCurvature ?? effCurvature,
    extentMode,
    gradingChoice,
    growthRate: authoredGrowth ?? effGrowth,
    hasAirboxHmax: authoredHmax !== null,
    hasAirboxHmin: authoredHmin !== null,
    hasCurvatureFactor: authoredCurvature !== null,
    hasGrowthRate: authoredGrowth !== null,
    hasManualCenter: authoredCenter !== null,
    hasNarrowGapResolution: authoredNarrow !== null,
    hasPadding: authoredPad !== null,
    manualCenterM: authoredCenter ?? effCenter,
    manualSizeM: authoredSize ?? effSize,
    narrowGapResolution: authoredNarrow ?? effNarrow,
    paddingM: authoredPad ?? effPad,
  };
}

export function buildCanonicalPolicyConfigFromParamsDraft(
  draft: AirboxMeshParamsDraft,
  existingConfig: JsonRecord | null | undefined,
  lane: AirboxMeshPolicyLane,
): JsonObject {
  const next: Record<string, unknown> = {
    ...(existingConfig ?? {}),
    mode: draft.extentMode,
  };

  if (draft.hasPadding) {
    next.padding = [draft.paddingM[0], draft.paddingM[1], draft.paddingM[2]];
  } else {
    delete next.padding;
  }

  if (draft.extentMode === "manual") {
    next.size = [
      draft.manualSizeM[0],
      draft.manualSizeM[1],
      draft.manualSizeM[2],
    ];
    if (draft.hasManualCenter) {
      next.center = [
        draft.manualCenterM[0],
        draft.manualCenterM[1],
        draft.manualCenterM[2],
      ];
    } else {
      delete next.center;
    }
  } else {
    delete next.size;
    delete next.center;
  }

  if (lane === "fdm") {
    for (const key of FEM_ONLY_POLICY_KEYS) {
      delete next[key];
    }
    return next as JsonObject;
  }

  // Canonical FEM keys (clean up legacy aliases so wire state never contradicts)
  delete next.maximum_element_size;
  delete next.minimum_element_size;
  delete next.curvature_factor;
  delete next.narrow_region_resolution;

  if (draft.hasAirboxHmax) {
    next.airbox_hmax = draft.airboxHmaxM;
  } else {
    delete next.airbox_hmax;
  }

  if (draft.hasAirboxHmin) {
    next.airbox_hmin = draft.airboxHminM;
  } else {
    delete next.airbox_hmin;
  }

  if (draft.gradingChoice !== "default") {
    next.airbox_grading = draft.gradingChoice;
  } else {
    delete next.airbox_grading;
  }

  if (draft.hasGrowthRate) {
    next.airbox_growth_rate = draft.growthRate;
  } else {
    delete next.airbox_growth_rate;
  }

  if (draft.hasCurvatureFactor) {
    next.airbox_curvature_factor = draft.curvatureFactor;
  } else {
    delete next.airbox_curvature_factor;
  }

  if (draft.hasNarrowGapResolution) {
    next.airbox_narrow_region_resolution = draft.narrowGapResolution;
  } else {
    delete next.airbox_narrow_region_resolution;
  }

  return next as JsonObject;
}

export function AirboxMeshParametersInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(useSessionResourceIdentity()) ?? undefined;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const authoringLane = resolveAirboxInspectorAuthoringLane(
    selection,
    runtimeStatus,
  );
  const runtimeLane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const effectiveLane: AirboxMeshPolicyLane =
    authoringLane === "fdm" || runtimeLane === "fdm" ? "fdm" : "fem";

  const policyRes = useUniverseMeshPolicyResource();
  const scene = useSceneResource();
  const domainMeta = useDomainMetaResource({ enabled: effectiveLane === "fdm" });
  const geometryDiagnostics = useSafeGeometryDiagnosticsResource({
    enabled: true,
  });

  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [restoredBanner, setRestoredBanner] = useState<string | null>(null);
  const [seedOverrides, setSeedOverrides] = useState<
    Partial<AirboxMeshParamsDraft> | undefined
  >(undefined);
  const [seedGeneration, setSeedGeneration] = useState(0);

  const baseline = useMemo<AirboxMeshParamsDraft>(
    () =>
      paramsDraftFromConfig(
        asRecord(policyRes.data?.config),
        asRecord(policyRes.data?.effective_config),
      ),
    [policyRes.data?.config, policyRes.data?.effective_config],
  );

  const baseConfigText = useMemo(
    () => formatUniverseMeshPolicyConfig(policyRes.data?.config),
    [policyRes.data?.config],
  );
  const baseRevision = policyRes.data?.revision;
  const authoredPresent =
    policyRes.data?.config !== null && policyRes.data?.config !== undefined;

  // Listen for build-history draft restoration requests on kernel bus
  useEffect(() => {
    if (!kernel?.bus?.on) return undefined;
    return kernel.bus.on("mesh:build-history-restore-requested", (event) => {
      const target = String(event.meshTarget ?? "");
      if (
        !/^(study_domain|shared_domain|universe|airbox)$/.test(target) ||
        !event.snapshot ||
        !Object.prototype.hasOwnProperty.call(event.snapshot, "universe")
      ) {
        return;
      }
      const restoredCfg = asRecord(event.snapshot.universe);
      const nextDraft = paramsDraftFromConfig(
        restoredCfg,
        asRecord(policyRes.data?.effective_config),
      );
      setSeedOverrides(nextDraft);
      setSeedGeneration((g) => g + 1);
      setRestoredBanner(
        `Build ${event.buildId ?? event.entryId} restored into Airbox mesh draft. Click Apply to commit before rebuilding.`,
      );
    });
  }, [kernel.bus, policyRes.data?.effective_config]);

  useEffect(() => {
    if (policyRes.status === "ready") {
      kernel?.bus?.emit?.("mesh:build-history-editor-ready", {
        target: "universe",
      });
    }
  }, [kernel?.bus, policyRes.status]);

  const loadEffectiveDefaultsIntoDraft = useCallback(
    (patchDraft: (partial: Partial<AirboxMeshParamsDraft>) => void) => {
      const resource = policyRes.data ?? {
        config: null,
        effective_config: null,
        revision: 0,
      };
      const effectiveDraft =
        draftFromEffectiveUniverseMeshPolicyResource(resource);
      const parsedEffective = (() => {
        try {
          return asRecord(JSON.parse(effectiveDraft.configText));
        } catch {
          return asRecord(resource.effective_config);
        }
      })();
      const seeded = paramsDraftFromConfig(
        parsedEffective,
        asRecord(resource.effective_config),
      );
      patchDraft({
        ...seeded,
        gradingChoice:
          seeded.gradingChoice === "default" ? "geometric" : seeded.gradingChoice,
        hasAirboxHmax:
          seeded.hasAirboxHmax ||
          asNumber(parsedEffective?.airbox_hmax) !== null,
        hasGrowthRate: true,
        hasPadding: true,
      });
      setRestoredBanner(
        "Backend-effective defaults loaded into draft. Click Apply to save.",
      );
    },
    [policyRes.data],
  );

  const outsideUniverseDiagnostics = useMemo(
    () =>
      (geometryDiagnostics.data?.diagnostics ?? []).filter(
        (d) => d.code === "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
      ),
    [geometryDiagnostics.data?.diagnostics],
  );

  const expandDraftToFitObjects = useCallback(
    (
      draft: AirboxMeshParamsDraft,
      patchDraft: (partial: Partial<AirboxMeshParamsDraft>) => void,
    ) => {
      const envelope = computeSceneObjectsEnvelope(
        scene.data?.objects,
        domainMeta.data?.bounds ?? null,
      );
      if (!envelope) return;
      const marginFactor = 1.25;
      if (draft.extentMode === "manual") {
        patchDraft({
          hasManualCenter: true,
          manualCenterM: envelope.center,
          manualSizeM: [
            envelope.span[0] * marginFactor,
            envelope.span[1] * marginFactor,
            envelope.span[2] * marginFactor,
          ],
        });
      } else {
        patchDraft({
          hasPadding: true,
          paddingM: [
            Math.max(draft.paddingM[0], envelope.span[0] * 0.25),
            Math.max(draft.paddingM[1], envelope.span[1] * 0.25),
            Math.max(draft.paddingM[2], envelope.span[2] * 0.25),
          ],
        });
      }
    },
    [domainMeta.data?.bounds, scene.data?.objects],
  );

  const applyDraftPolicy = useCallback(
    async (draft: AirboxMeshParamsDraft): Promise<boolean> => {
      setConflictNotice(null);
      const nextConfig = buildCanonicalPolicyConfigFromParamsDraft(
        draft,
        asRecord(policyRes.data?.config),
        effectiveLane,
      );
      try {
        await submitCanonicalUniversePolicy({
          baseConfigText,
          baseRevision,
          config: nextConfig,
          kernel,
          label:
            effectiveLane === "fdm"
              ? "Update FDM Airbox universe policy"
              : "Update Airbox mesh parameters",
          lane: effectiveLane,
          latestPolicy: policyRes.data ?? null,
          runtimeLane:
            runtimeLane === "fdm" || runtimeLane === "fem" ? runtimeLane : null,
          runtimeStatus,
          sceneData: scene.data,
          sessionScopeKey,
        });
        setRestoredBanner(null);
        setSeedOverrides(undefined);
        return true;
      } catch (err) {
        if (isConflictApiError(err)) {
          policyRes.refetch?.();
          kernel.resources?.invalidate?.(
            MESH_UNIVERSE_POLICY_RESOURCE_KEY,
            `conflict:${Date.now()}`,
          );
          setConflictNotice(
            "Universe policy changed in another view (HTTP 409). Latest revision fetched — review and click Apply again.",
          );
        }
        throw err;
      }
    },
    [
      baseConfigText,
      baseRevision,
      effectiveLane,
      kernel,
      policyRes,
      runtimeLane,
      runtimeStatus,
      scene.data,
      sessionScopeKey,
    ],
  );

  const effectiveEntries = useMemo(() => {
    const eff = asRecord(policyRes.data?.effective_config) ?? {};
    const keys =
      effectiveLane === "fdm" ? FDM_EFFECTIVE_POLICY_KEYS : EFFECTIVE_POLICY_KEYS;
    return keys.map((key) => ({
      id: key,
      key,
      value: formatEffectiveValue(key, eff[key]),
    }));
  }, [effectiveLane, policyRes.data?.effective_config]);

  const spec = useMemo<InspectorSpec<AirboxMeshParamsDraft>>(
    () => ({
      id: `airbox.mesh.parameters${seedGeneration > 0 ? `:seed-${seedGeneration}` : ""}`,
      header: {
        breadcrumbs: [
          {
            id: "airbox",
            label: "Airbox",
            selection: {
              kind: "airbox.root",
              label: "Airbox",
              nodeId: "model:airbox",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "mesh",
            label: "Mesh",
            selection: {
              kind: "airbox.mesh",
              label: "Mesh",
              nodeId: "model:airbox:mesh",
              objectId: null,
              ref: null,
            },
          },
          { id: "params", label: "Parameters" },
        ],
        extraMenuActions: [
          {
            icon: Sparkles,
            id: "load-effective-defaults",
            label: "Load Effective Defaults",
            onSelect: (ctx) => loadEffectiveDefaultsIntoDraft(ctx.patchDraft),
          },
          {
            icon: History,
            id: "inspect-policy-json",
            label: "Inspect Policy JSON",
            onSelect: (ctx) => {
              const cfg = buildCanonicalPolicyConfigFromParamsDraft(
                ctx.draft,
                asRecord(policyRes.data?.config),
                effectiveLane,
              );
              ctx.openCodePreview(
                "Universe & Airbox mesh policy",
                "json",
                formatUniverseMeshPolicyConfig(cfg),
              );
            },
          },
          {
            icon: AlertTriangle,
            id: "open-diagnostics",
            label: "Open Diagnostics",
            onSelect: () => {
              kernel.layout?.openBottomPanel?.("diagnostics");
            },
          },
        ],
        primaryHeaderAction: {
          icon: Grid3x3,
          label:
            effectiveLane === "fdm"
              ? "Build FDM Grid"
              : "Build Shared-Domain Mesh",
          onRun: async (ctx) => {
            const draftChanged =
              JSON.stringify(ctx.draft) !== JSON.stringify(ctx.baseline);
            if (draftChanged) {
              await applyDraftPolicy(ctx.draft);
            }
            const cmd =
              effectiveLane === "fdm"
                ? "grid.build-fdm"
                : "mesh.build-shared-domain";
            await kernel.commands.execute(
              cmd,
              createCommandContext("inspector", kernel, {
                input: { origin: "airbox" },
                resourceData: {
                  [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
                },
                sessionScopeKey: sessionScopeKey ?? null,
                sourceDetail: "airbox.mesh.parameters",
              }),
            );
          },
        },
      },
      identity: {
        domain: "mesh",
        entityId: "model:airbox:mesh:parameters",
        icon: SlidersHorizontal,
        kindLabel:
          effectiveLane === "fdm"
            ? "FDM structured-grid universe policy"
            : "FEM exterior element sizing & grading",
        statePill: () =>
          authoredPresent
            ? { label: "Authored", tone: "ok" }
            : { label: "Inherited defaults", tone: "info" },
        title: () => "Airbox Mesh Parameters",
      },
      facts: (d) => [
        {
          id: "mode",
          label: "Extent",
          value: d.extentMode === "manual" ? "Manual box" : "Auto padding",
        },
        ...(effectiveLane === "fem"
          ? [
              {
                id: "hmax",
                label: "h_max,air",
                value: d.hasAirboxHmax
                  ? formatLengthSmart(d.airboxHmaxM)
                  : "Default",
              },
              {
                id: "hmin",
                label: "h_min,air",
                value: d.hasAirboxHmin
                  ? formatLengthSmart(d.airboxHminM)
                  : "Default",
              },
              {
                id: "growth",
                label: "Growth g_air",
                value: d.hasGrowthRate ? String(d.growthRate) : "Default (1.3)",
              },
            ]
          : [
              {
                id: "rev",
                label: "Policy rev",
                value: baseRevision != null ? String(baseRevision) : null,
              },
            ]),
      ],
      notices: (d) => {
        const list: InspectorNotice<AirboxMeshParamsDraft>[] = [];
        if (conflictNotice) {
          list.push({
            id: "policy-conflict",
            quickFix: {
              label: "Reload Latest Policy",
              onApply: () => {
                policyRes.refetch?.();
                setConflictNotice(null);
              },
            },
            text: conflictNotice,
            title: "Policy revision conflict",
            tone: "err",
          });
        }
        if (restoredBanner) {
          list.push({
            id: "restored-draft",
            text: restoredBanner,
            title: "Staged policy draft updated",
            tone: "info",
          });
        }
        if (!authoredPresent && policyRes.data?.effective_config) {
          list.push({
            id: "inherited-defaults-notice",
            quickFix: {
              label: "Load Effective Defaults",
              onApply: (ctx) => loadEffectiveDefaultsIntoDraft(ctx.patchDraft),
            },
            text: "Universe & Airbox policy currently inherits backend defaults. Load effective defaults or enable explicit controls below.",
            title: "Using backend-effective defaults",
            tone: "info",
          });
        }
        for (const diag of outsideUniverseDiagnostics) {
          list.push({
            id: `diag-${diag.id}`,
            quickFix:
              d.extentMode === "manual"
                ? {
                    label: "Switch Extent Mode to Auto Padding",
                    onApply: (ctx) => ctx.setField("extentMode", "auto"),
                  }
                : {
                    label: "Expand Padding to Fit Objects",
                    onApply: (ctx) =>
                      expandDraftToFitObjects(ctx.draft, ctx.patchDraft),
                  },
            text: `${diag.message}${diag.object_id ? ` (object: ${diag.object_id})` : ""}`,
            title: "Geometry extends outside Universe bounds",
            tone: diag.severity === "error" ? "err" : "warn",
          });
        }
        return list;
      },
      sections: [
        {
          defaultOpen: true,
          footer: (ctx) => (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => loadEffectiveDefaultsIntoDraft(ctx.patchDraft)}
              >
                Load Effective Defaults
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => {
                  ctx.patchDraft(ctx.baseline);
                  setRestoredBanner(null);
                }}
              >
                Reset Draft to Saved
              </Button>
            </div>
          ),
          icon: Ruler,
          id: "exterior-sizing",
          rows: [
            {
              key: "hasAirboxHmax",
              label: "Specify far-field max element size",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "airboxHmaxM",
              label: "Max exterior element size",
              min: 1e-12,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.hasAirboxHmax,
              symbol: (
                <>
                  h<sub>max,air</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
              validate: (val, d) =>
                d.hasAirboxHmin && val < d.airboxHminM
                  ? "Exterior h_max must be >= interface h_min."
                  : null,
            },
            {
              key: "hasAirboxHmin",
              label: "Specify interface min element size",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "airboxHminM",
              label: "Min interface element size",
              min: 1e-12,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.hasAirboxHmin,
              symbol: (
                <>
                  h<sub>min,air</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS,
            },
            {
              key: "gradingChoice",
              label: "Exterior element grading",
              options: [
                { label: "Default", value: "default" },
                { label: "Auto", value: "auto" },
                { label: "Geometric", value: "geometric" },
                { label: "Linear", value: "linear" },
              ],
              type: "segmented",
            },
            {
              key: "hasGrowthRate",
              label: "Specify exterior growth rate",
              structural: true,
              type: "switch",
            },
            {
              key: "growthRate",
              label: "Exterior growth rate",
              max: 10,
              min: 1.01,
              showWhen: (d) => d.hasGrowthRate,
              step: 0.05,
              symbol: (
                <>
                  g<sub>air</sub>
                </>
              ),
              type: "number",
            },
          ],
          showWhen: () => effectiveLane === "fem",
          title: "Exterior element sizing & grading",
        },
        {
          defaultOpen: true,
          icon: Activity,
          id: "curvature-narrow-gaps",
          rows: [
            {
              key: "hasCurvatureFactor",
              label: "Enable curved-surface air refinement",
              structural: true,
              type: "switch",
            },
            {
              key: "curvatureFactor",
              label: "Airbox curvature factor",
              max: 10,
              min: 0.01,
              showWhen: (d) => d.hasCurvatureFactor,
              step: 0.05,
              symbol: (
                <>
                  &kappa;<sub>air</sub>
                </>
              ),
              type: "number",
              validate: (_val, d) =>
                d.hasCurvatureFactor && !d.hasAirboxHmax
                  ? "Curvature factor requires specifying Max exterior element size (h_max,air)."
                  : null,
            },
            {
              key: "hasNarrowGapResolution",
              label: "Enable narrow-region air-gap refinement",
              structural: true,
              type: "switch",
            },
            {
              hint: "Target number of elements resolved across narrow air gaps between bodies.",
              key: "narrowGapResolution",
              label: "Elements across narrow air gaps",
              max: 32,
              min: 0.1,
              showWhen: (d) => d.hasNarrowGapResolution,
              step: 0.5,
              symbol: (
                <>
                  n<sub>gap</sub>
                </>
              ),
              type: "number",
              validate: (_val, d) =>
                d.hasNarrowGapResolution && !d.hasAirboxHmax
                  ? "Narrow-region resolution requires specifying Max exterior element size (h_max,air)."
                  : null,
            },
          ],
          showWhen: () => effectiveLane === "fem",
          title: "Curvature & narrow air-gap resolution",
        },
        {
          defaultOpen: effectiveLane === "fdm",
          icon: Box,
          id: "universe-geometry-policy",
          rows: [
            {
              key: "extentMode",
              label: "Domain extent mode",
              options: [
                { label: "Auto Padding", value: "auto" },
                { label: "Manual Box", value: "manual" },
              ],
              structural: true,
              type: "segmented",
            },
            {
              key: "hasPadding",
              label: "Author explicit padding vector",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "paddingM",
              label: "Padding (X, Y, Z)",
              showWhen: (d) => d.hasPadding,
              symbol: <>d</>,
              type: "vector3",
              units: LENGTH_UNITS,
              validate: (vec) =>
                vec.some((v) => !Number.isFinite(v) || v < 0)
                  ? "Padding components must be finite and >= 0."
                  : null,
            },
            {
              defaultDisplayUnit: "nm",
              key: "manualSizeM",
              label: "Manual box size (X, Y, Z)",
              showWhen: (d) => d.extentMode === "manual",
              symbol: <>L</>,
              type: "vector3",
              units: LENGTH_UNITS,
              validate: (vec, d) =>
                d.extentMode === "manual" &&
                vec.some((v) => !Number.isFinite(v) || v <= 0)
                  ? "Manual size components must be greater than 0."
                  : null,
            },
            {
              key: "hasManualCenter",
              label: "Specify manual box center",
              showWhen: (d) => d.extentMode === "manual",
              structural: true,
              type: "switch",
            },
            {
              defaultDisplayUnit: "nm",
              key: "manualCenterM",
              label: "Manual box center (X, Y, Z)",
              showWhen: (d) => d.extentMode === "manual" && d.hasManualCenter,
              symbol: (
                <>
                  r<sub>0</sub>
                </>
              ),
              type: "vector3",
              units: LENGTH_UNITS,
            },
          ],
          title:
            effectiveLane === "fdm"
              ? "Structured-grid universe geometry"
              : "Universe extent geometry",
        },
        {
          defaultOpen: true,
          icon: AlertTriangle,
          id: "outside-universe-recovery",
          rows: [
            {
              render: (ctx) => (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      expandDraftToFitObjects(ctx.draft, ctx.patchDraft)
                    }
                  >
                    Expand Padding to Fit Objects
                  </Button>
                  {ctx.draft.extentMode === "manual" ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => ctx.setField("extentMode", "auto")}
                    >
                      Switch Extent Mode to Auto Padding
                    </Button>
                  ) : null}
                  {ctx.draft.extentMode === "manual" ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() => ctx.focusField("manualSizeM")}
                    >
                      Adjust manual bounds
                    </Button>
                  ) : null}
                  {outsideUniverseDiagnostics
                    .filter((diag) => Boolean(diag.object_id))
                    .map((diag) => (
                      <Button
                        key={diag.id}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          ctx.selectNode({
                            kind: "object.root",
                            label: diag.object_id!,
                            nodeId: `model:object:${diag.object_id!}`,
                            objectId: diag.object_id!,
                            ref: {
                              kind: "object.root",
                              nodeId: `model:object:${diag.object_id!}`,
                              objectId: diag.object_id!,
                              type: "scene-object",
                              visualizationTargetId:
                                visualizationTargetIdForSceneObject(
                                  diag.object_id!,
                                  null,
                                ),
                            },
                          })
                        }
                      >
                        Select object to adjust placement
                      </Button>
                    ))}
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      kernel.layout?.openBottomPanel?.("diagnostics")
                    }
                  >
                    Open diagnostics
                  </Button>
                </div>
              ),
              type: "custom",
              wide: true,
            },
          ],
          showWhen: () => outsideUniverseDiagnostics.length > 0,
          title: "Bounds diagnostics & recovery",
        },
        {
          defaultOpen: false,
          icon: Layers,
          id: "backend-effective-values",
          rows: [
            {
              columns: [
                {
                  header: "Policy key",
                  id: "k",
                  mono: true,
                  renderCell: (r) =>
                    (r as (typeof effectiveEntries)[number]).key,
                },
                {
                  align: "right",
                  header: "Backend-effective value",
                  id: "v",
                  mono: true,
                  renderCell: (r) =>
                    (r as (typeof effectiveEntries)[number]).value,
                },
              ],
              label: "Backend-effective Values",
              rowKey: (r) => (r as (typeof effectiveEntries)[number]).id,
              rows: () => effectiveEntries,
              type: "table",
              wide: true,
            },
          ],
          title: "Backend-effective Values",
        },
      ],
      commitBar: {
        allowCleanApply: () =>
          restoredBanner !== null ||
          (!authoredPresent && Boolean(policyRes.data?.effective_config)),
        applyLabel: (_, dirty) =>
          dirty
            ? effectiveLane === "fdm"
              ? "Apply & Refresh Grid"
              : "Apply Policy"
            : "Commit Policy",
        cleanMessage: () =>
          effectiveLane === "fdm"
            ? "FDM universe policy matches committed scene"
            : "Exterior FEM sizing matches universe policy",
        mode: "staged",
        onApply: applyDraftPolicy,
        onRevert: () => {
          setRestoredBanner(null);
          setConflictNotice(null);
        },
      },
    }),
    [
      applyDraftPolicy,
      authoredPresent,
      baseRevision,
      conflictNotice,
      effectiveEntries,
      effectiveLane,
      expandDraftToFitObjects,
      kernel,
      loadEffectiveDefaultsIntoDraft,
      outsideUniverseDiagnostics,
      policyRes,
      restoredBanner,
      runtimeStatus,
      seedGeneration,
      sessionScopeKey,
    ],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      seedStagedOverrides={seedOverrides}
      selection={selection}
      spec={spec}
    />
  );
}

// ============================================================================
// 3.3 airbox.mesh.quality-gates — AirboxMeshQualityGatesInspectorSpecPanel
// ============================================================================

export function AirboxMeshQualityGatesInspectorSpecPanel({
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
  const manifestRes = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(femEnabled, runtimeStatus),
  });
  const sharedGatesRes = useSafeMeshSharedDomainQualityGatesResource({
    enabled: femEnabled && shouldLoadAirboxMeshManifest(true, runtimeStatus),
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
    (runtimeStatus === null && qualityRes.data != null);
  const currentMeshRevision =
    runtimeStatus?.resources.mesh_revision ?? qualityRes.data?.revision ?? null;

  const qualityEvidence = currentAirboxQualityEvidence(
    qualityRes,
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
        report: null,
        summary: null,
      }),
    [
      currentSceneRevision,
      manifestRes.data,
      qualityEvidence,
      qualityRes.data?.revision,
      topologyMatches,
    ],
  );

  const statistics = useMemo(
    () => normalizeMeshQualityStatistics(qualityEvidence?.quality),
    [qualityEvidence?.quality],
  );
  const refinementState = useMemo(
    () => resolveMeshQualityRefinementState(statistics),
    [statistics],
  );

  const mixedCertificate = useMemo(() => {
    const rawSidecar = asRecord(asRecord(sharedGatesRes.data)?.mixed_certificate);
    if (!rawSidecar) return null;
    return resolveMixedCertificateQualityPresentation(rawSidecar);
  }, [sharedGatesRes.data]);

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

  const refineWorstRegion = useCallback(async () => {
    if (!refinementState.plan) return;
    await kernel.commands.execute(
      "mesh.refine-worst-quality-element",
      createCommandContext("inspector", kernel, {
        resourceData: {
          [SESSION_STATUS_RESOURCE_KEY]: runtimeStatus,
        },
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "airbox.mesh.quality-gates",
      }),
      {
        elementIndex: refinementState.plan.elementIndex,
        meshOptions: refinementState.plan.meshOptions,
      },
    );
  }, [kernel, refinementState.plan, runtimeStatus, sessionScopeKey]);

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

  const baseline = useMemo(() => ({ scope: "airbox" }), []);

  const spec = useMemo<InspectorSpec<{ scope: string }>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<{ scope: string }>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "quality",
          })
        : [];

    const checks = model.qualityGates.checks;
    const statusLabel =
      model.qualityGates.status === "pass"
        ? "Passed"
        : model.qualityGates.status === "fail"
          ? "Failed"
          : "Unverified";
    const statusTone: InspectorTone =
      model.qualityGates.status === "pass"
        ? "ok"
        : model.qualityGates.status === "fail"
          ? "err"
          : "neutral";

    return {
      id: "airbox.mesh.quality-gates",
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
          { id: "gates", label: "Quality Gates" },
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
        entityId: "model:airbox:mesh:quality-gates",
        icon: ShieldCheck,
        kindLabel:
          lane === "fdm"
            ? "FDM Airbox structured-grid checks"
            : "Exterior FEM marker-0 quality gates",
        statePill: () =>
          lane === "fdm"
            ? {
                label: domainMeta.data ? "Structured" : "Not materialized",
                tone: domainMeta.data ? "ok" : "neutral",
              }
            : { label: statusLabel, tone: statusTone },
        title: () => "Airbox Quality Gates",
      },
      facts: () => [
        {
          id: "status",
          label: "Gate status",
          value: lane === "fdm" ? "FDM grid" : statusLabel,
        },
        {
          id: "checks",
          label: "Published checks",
          value: lane === "fdm" ? null : String(checks.length),
        },
        {
          id: "failed",
          label: "Failed checks",
          value:
            lane === "fdm"
              ? null
              : String(checks.filter((c) => c.status === "fail").length),
        },
        {
          id: "marker",
          label: "Marker",
          value:
            lane === "fdm" || model.qualityGates.marker === null
              ? null
              : String(model.qualityGates.marker),
        },
      ],
      sections: [
        ...fdmSections,
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
          icon: ShieldCheck,
          id: "gates-summary",
          rows: [
            {
              format: () => statusLabel,
              label: "Overall qualification",
              type: "readonly",
            },
            {
              format: () =>
                sanitizeStatusText(
                  model.qualityGates.reason,
                  "No Airbox quality-gate evidence published yet.",
                ),
              label: "Evidence summary",
              type: "readonly",
            },
            {
              format: () => model.qualityGates.scope ?? "Not published",
              label: "Evaluated scope",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                model.qualityGates.marker !== null
                  ? String(model.qualityGates.marker)
                  : "Not published",
              label: "Region marker",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                sanitizeStatusText(model.qualityGates.source, "Not published"),
              label: "Quality source",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                topologyMatches
                  ? "Matches current FEM generation"
                  : manifestRes.status === "loading"
                    ? "Checking backend manifest"
                    : "Not verified against current FEM generation",
              label: "Topology identity",
              type: "readonly",
            },
            ...(checks.length > 0
              ? [
                  {
                    columns: [
                      {
                        header: "Check",
                        id: "id",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof checks)[number]).id,
                      },
                      {
                        header: "Status",
                        id: "status",
                        renderCell: (r: unknown) => {
                          const st = (r as (typeof checks)[number]).status;
                          return st === "pass"
                            ? "Passed"
                            : st === "fail"
                              ? "Failed"
                              : "Unverified";
                        },
                      },
                      {
                        align: "right" as const,
                        header: "Measured / Threshold",
                        id: "val",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const item = r as (typeof checks)[number];
                          const unitSuffix = item.unit ? ` ${item.unit}` : "";
                          const measured =
                            item.value !== null
                              ? `${Number(item.value.toPrecision(4))}${unitSuffix}`
                              : "—";
                          if (item.threshold !== null) {
                            const cmp = item.comparison ? `${item.comparison} ` : "";
                            return `${measured} (${cmp}${Number(item.threshold.toPrecision(4))}${unitSuffix})`;
                          }
                          return measured;
                        },
                      },
                    ],
                    label: "Backend Airbox quality-gate checks",
                    rowKey: (r: unknown) => (r as (typeof checks)[number]).id,
                    rows: () => checks,
                    type: "table" as const,
                    wide: true,
                  },
                ]
              : [
                  {
                    format: () =>
                      "No per-gate Airbox check rows published yet — build shared-domain mesh to evaluate.",
                    label: "Published gate checks",
                    type: "readonly" as const,
                  },
                ]),
          ],
          showWhen: () => lane !== "fdm",
          title: "Airbox marker-0 quality gates",
        },
        ...(lane !== "fdm" &&
        mixedCertificate &&
        mixedCertificate.familyGates.length > 0
          ? [
              {
                defaultOpen: true,
                icon: Layers,
                id: "mixed-certificate-gates",
                rows: [
                  {
                    format: () =>
                      sanitizeStatusText(mixedCertificate.status, "Not published"),
                    label: "Certificate status",
                    type: "readonly" as const,
                  },
                  {
                    columns: [
                      {
                        header: "Family / metric",
                        id: "fam",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const g =
                            r as (typeof mixedCertificate.familyGates)[number];
                          return `${g.family} · ${g.metric}`;
                        },
                      },
                      {
                        align: "right" as const,
                        header: "p05 / threshold",
                        id: "p05",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const g =
                            r as (typeof mixedCertificate.familyGates)[number];
                          const p05 =
                            g.p05 !== null ? g.p05.toPrecision(3) : "—";
                          const thr =
                            g.threshold !== null
                              ? g.threshold.toPrecision(3)
                              : "—";
                          return `${p05} / ${thr} (${g.passed ? "Passed" : "Failed"})`;
                        },
                      },
                      {
                        align: "right" as const,
                        header: "Jacobian",
                        id: "jac",
                        mono: true,
                        renderCell: (r: unknown) => {
                          const g =
                            r as (typeof mixedCertificate.familyGates)[number];
                          return g.positiveJacobian ? "Positive" : "Non-positive";
                        },
                      },
                    ],
                    label: "Mixed-topology family gates",
                    rowKey: (r: unknown) => {
                      const g =
                        r as (typeof mixedCertificate.familyGates)[number];
                      return `${g.family}:${g.metric}`;
                    },
                    rows: () => mixedCertificate.familyGates,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Mixed-topology certificate gates",
              },
            ]
          : []),
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () =>
          lane === "fdm"
            ? "Structured FDM Airbox grid verification"
            : sanitizeStatusText(refinementState.reason, "Exterior transition & shell qualification"),
      },
    };
  }, [
    domainMeta,
    fdmMembership.data,
    lane,
    manifestRes.status,
    mixedCertificate,
    model.qualityGates,
    multilayerLayout.data,
    refineWorstRegion,
    refinementState.plan,
    refinementState.reason,
    roleEvidence,
    selectQualityMetric,
    topologyMatches,
  ]);

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

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

// ============================================================================
// 3.5 airbox.mesh.topology — AirboxMeshTopologyInspectorSpecPanel
// ============================================================================

interface AirboxTopologyLiveDraft {
  airboxVisible: boolean;
  wireframeVisible: boolean;
  boundsVisible: boolean;
}

export function AirboxMeshTopologyInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const lane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const femEnabled = lane !== "fdm";

  const manifestRes = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(femEnabled, runtimeStatus),
  });
  const scene = useSceneResource({ enabled: lane === "fdm" });
  const domainMeta = useDomainMetaResource({ enabled: lane === "fdm" });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: lane === "fdm",
  });
  const multilayerLayout = useFdmMultilayerLayoutResource({
    enabled: lane === "fdm",
  });

  const viz = useSafeAirboxTargetVisualization();

  const topologyIdentityMatches = matchesAirboxTopologyIdentity(
    runtimeStatus,
    manifestRes.data,
  );
  const topologyMatches =
    (manifestRes.status === "ready" && topologyIdentityMatches) ||
    (runtimeStatus === null && manifestRes.data != null);
  const currentManifest = topologyMatches ? (manifestRes.data ?? null) : null;

  const airboxParts = useMemo(
    () => findAirboxParts(currentManifest?.mesh_parts),
    [currentManifest?.mesh_parts],
  );
  const aggregate = useMemo(
    () => aggregateAirboxMeshParts(airboxParts),
    [airboxParts],
  );
  const bounds = useMemo(
    () => aggregateAirboxBounds(airboxParts),
    [airboxParts],
  );
  const canonicalCarrier = useMemo(
    () => findCanonicalAirboxPart(currentManifest?.mesh_parts),
    [currentManifest?.mesh_parts],
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

  const baseline = useMemo<AirboxTopologyLiveDraft>(
    () => ({
      airboxVisible: viz.settings.visible,
      boundsVisible: viz.settings.boundsVisible,
      wireframeVisible: viz.settings.wireframeVisible,
    }),
    [
      viz.settings.boundsVisible,
      viz.settings.visible,
      viz.settings.wireframeVisible,
    ],
  );

  const handleLiveFieldChange = useCallback(
    <K extends keyof AirboxTopologyLiveDraft & string>(
      key: K,
      value: AirboxTopologyLiveDraft[K],
    ) => {
      if (key === "airboxVisible") {
        viz.patchAirboxVisualization({ visible: Boolean(value) });
      } else if (key === "wireframeVisible") {
        viz.patchAirboxVisualization({
          visible: Boolean(value) ? true : viz.settings.visible,
          wireframeVisible: Boolean(value),
        });
      } else if (key === "boundsVisible") {
        viz.patchAirboxVisualization({ boundsVisible: Boolean(value) });
      }
    },
    [viz],
  );

  const spec = useMemo<InspectorSpec<AirboxTopologyLiveDraft>>(() => {
    const fdmSections =
      lane === "fdm"
        ? buildFdmAirboxFactsSections<AirboxTopologyLiveDraft>({
            domainRes: domainMeta,
            membership: fdmMembership.data,
            multilayerLayout: multilayerLayout.data,
            roleEvidence,
            view: "topology",
          })
        : [];

    const hasExplicitNodeIndices =
      airboxParts.length > 0 &&
      airboxParts.every((p) => Array.isArray(p.node_indices));
    const hasExplicitBoundaryIndices =
      airboxParts.length > 0 &&
      airboxParts.every((p) => Array.isArray(p.boundary_face_indices));

    return {
      id: "airbox.mesh.topology",
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
          { id: "topology", label: "Topology" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "mesh",
        entityId: selection.nodeId ?? "model:airbox:mesh:topology",
        icon: Layers,
        kindLabel:
          lane === "fdm"
            ? "FDM structured Airbox topology"
            : "Published shared-domain Airbox carrier topology",
        statePill: () =>
          lane === "fdm"
            ? {
                label: domainMeta.data ? "Structured" : "Not materialized",
                tone: domainMeta.data ? "ok" : "neutral",
              }
            : currentManifest
              ? {
                  label: `${aggregate.carrierCount} carrier${aggregate.carrierCount === 1 ? "" : "s"}`,
                  tone: "ok",
                }
              : manifestRes.status === "ready" && !topologyIdentityMatches
                ? { label: "Stale identity", tone: "stale" }
                : { label: "Not built", tone: "neutral" },
        title: () => "Airbox Mesh Topology",
      },
      facts: () => [
        {
          id: "carriers",
          label: "Carriers",
          value:
            lane !== "fdm" && currentManifest
              ? String(aggregate.carrierCount)
              : null,
        },
        {
          id: "nodes",
          label: "Unique nodes",
          value:
            lane !== "fdm" && aggregate.nodeCount !== null
              ? aggregate.nodeCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "elems",
          label: "Elements",
          value:
            lane !== "fdm" && aggregate.elementCount !== null
              ? aggregate.elementCount.toLocaleString("en-US")
              : null,
        },
        {
          id: "bfaces",
          label: "Boundary faces",
          value:
            lane !== "fdm" && aggregate.boundaryFaceCount !== null
              ? aggregate.boundaryFaceCount.toLocaleString("en-US")
              : null,
        },
      ],
      sections: [
        {
          defaultOpen: true,
          icon: Eye,
          id: "live-airbox-display",
          live: true,
          rows: [
            {
              key: "airboxVisible",
              label: "Show Airbox target in 3D",
              type: "switch",
            },
            {
              key: "wireframeVisible",
              label: "Highlight Airbox mesh edges & interfaces in 3D",
              type: "switch",
            },
            {
              key: "boundsVisible",
              label: "Show Airbox bounding box in 3D",
              type: "switch",
            },
          ],
          title: "3D Airbox & interface display",
        },
        ...fdmSections,
        {
          defaultOpen: true,
          icon: Layers,
          id: "manifest-carrier-provenance",
          rows: [
            {
              format: () => "airbox",
              label: "Canonical target",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                topologyMatches
                  ? "Matches current published FEM generation"
                  : manifestRes.status === "ready" && !topologyIdentityMatches
                    ? "Cached manifest does not match current FEM generation"
                    : manifestRes.status === "loading"
                      ? "Checking backend manifest"
                      : "No published FEM manifest",
              label: "Topology identity",
              type: "readonly",
            },
            {
              copyText: () => currentManifest?.mesh_id ?? null,
              format: () => currentManifest?.mesh_id ?? "Not published",
              label: "Mesh ID",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => currentManifest?.generation_id ?? null,
              format: () => currentManifest?.generation_id ?? "Not published",
              label: "Generation ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                currentManifest?.revision !== undefined
                  ? String(currentManifest.revision)
                  : "Not published",
              label: "Manifest revision",
              type: "readonly",
            },
            {
              format: () =>
                currentManifest?.geometry_realization_revision != null
                  ? String(currentManifest.geometry_realization_revision)
                  : "Not published",
              label: "Geometry realization revision",
              type: "readonly",
            },
            {
              format: () =>
                currentManifest?.source_scene_revision != null
                  ? String(currentManifest.source_scene_revision)
                  : "Not published",
              label: "Source scene revision",
              type: "readonly",
            },
            {
              copyText: () => currentManifest?.topology_fingerprint ?? null,
              format: () =>
                currentManifest?.topology_fingerprint ?? "Not published",
              label: "Topology fingerprint",
              mono: true,
              type: "readonly",
            },
            {
              copyText: () => canonicalCarrier?.id ?? null,
              format: () => canonicalCarrier?.id ?? "Not published",
              label: "Primary carrier ID",
              mono: true,
              type: "readonly",
            },
            {
              format: () => canonicalCarrier?.role ?? "Not published",
              label: "Primary carrier role",
              mono: true,
              type: "readonly",
            },
            {
              format: () =>
                bounds ? formatTupleSmart(bounds.min) : "Not published",
              label: "Bounds min (full Airbox extent)",
              type: "readonly",
            },
            {
              format: () =>
                bounds ? formatTupleSmart(bounds.max) : "Not published",
              label: "Bounds max (full Airbox extent)",
              type: "readonly",
            },
            {
              format: () =>
                hasExplicitNodeIndices
                  ? "Explicit node_indices (deduplicated carrier coverage)"
                  : aggregate.nodeCountExact
                    ? "Deduplicated published carrier coverage"
                    : "Published per-carrier counts",
              label: "Node-count source",
              type: "readonly",
            },
            {
              format: () =>
                hasExplicitBoundaryIndices
                  ? "Explicit boundary_face_indices"
                  : aggregate.boundaryFaceCount !== null
                    ? "Published per-carrier ranges"
                    : "Not published",
              label: "Boundary-face source",
              type: "readonly",
            },
            {
              format: () =>
                "Shared magnetic-to-air interface nodes remain conforming in the shared-domain mesh.",
              label: "Shared-interface conformity",
              type: "readonly",
            },
          ],
          showWhen: () => lane !== "fdm",
          title: "Manifest topology & carrier provenance",
        },
        ...(lane !== "fdm" && airboxParts.length > 0
          ? [
              {
                defaultOpen: true,
                icon: Box,
                id: "airbox-carriers-table",
                rows: [
                  {
                    columns: [
                      {
                        header: "Carrier ID",
                        id: "id",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof airboxParts)[number]).id,
                      },
                      {
                        header: "Role",
                        id: "role",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (r as (typeof airboxParts)[number]).role ?? "airbox",
                      },
                      {
                        align: "right" as const,
                        header: "Elements",
                        id: "elems",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (
                            r as (typeof airboxParts)[number]
                          ).element_count.toLocaleString("en-US"),
                      },
                      {
                        align: "right" as const,
                        header: "Boundary faces",
                        id: "bfaces",
                        mono: true,
                        renderCell: (r: unknown) =>
                          (
                            r as (typeof airboxParts)[number]
                          ).boundary_face_count.toLocaleString("en-US"),
                      },
                    ],
                    label: "Published Airbox mesh parts",
                    rowKey: (r: unknown) =>
                      (r as (typeof airboxParts)[number]).id,
                    rows: () => airboxParts,
                    type: "table" as const,
                    wide: true,
                  },
                ],
                title: "Published Airbox carriers",
              },
            ]
          : []),
      ],
      commitBar: {
        hasOverrides: () => viz.hasOverrides,
        mode: "liveViewport",
        onResetDisplay: () => {
          viz.resetAirboxVisualization();
        },
        statusMessage: "Live 3D Airbox & conforming carrier topology",
      },
    };
  }, [
    aggregate,
    airboxParts,
    bounds,
    canonicalCarrier,
    currentManifest,
    domainMeta,
    fdmMembership.data,
    lane,
    manifestRes.status,
    multilayerLayout.data,
    roleEvidence,
    selection.nodeId,
    topologyIdentityMatches,
    topologyMatches,
    viz,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleLiveFieldChange}
    />
  );
}

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

export { formatTupleSi };
