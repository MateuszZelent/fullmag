"use client";

import {
  Compass,
  Grid3x3,
  Layers,
  Ruler,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
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
import { shouldLoadRuntimeMeshBuild, shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";
import { SESSION_STATUS_RESOURCE_KEY, useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorNotice,
  InspectorSpec,
  InspectorTone,
} from "../../template";
import { SpecInspectorHost } from "../../panels/mesh-details/SpecInspectorHost";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import {
  aggregateAirboxMeshParts,
  buildAirboxMeshBuildModel,
  buildAirboxMeshInspectorModel,
  currentAirboxQualityEvidence,
  currentAirboxReportEvidence,
} from "../../panels/airbox/airboxMeshInspectorModel";
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
import { readTargetMetric } from "./universeShared";

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
