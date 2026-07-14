"use client";

import { useCallback, useMemo } from "react";

import type { JsonObject, LiveStatusResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useMeshBuildCurrent,
  useMeshBuildHistoryResource,
  useMeshBuildLatestSuccessful,
  useMeshCapabilitiesResource,
  useMeshSemanticsResource,
  useMeshSharedDomainManifestResource,
  useMeshSharedDomainQualityGatesResource,
  useMeshSharedDomainQualityResource,
  useMeshSharedDomainRealizedSizeFieldsResource,
  useMeshSharedDomainReportResource,
  useMeshSummaryResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshBuild,
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";
import { useKernel } from "@/kernel/KernelContext";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import {
  normalizeMeshPipelineStatus,
  resolveMeshBuildStatusLabel,
} from "@/shared/domain/mesh/buildPipeline";
import { normalizeMeshBuildHistory } from "@/shared/domain/mesh/meshBuildHistory";
import {
  type MeshPolicyDiffRow,
  diffMeshPolicies,
} from "@/shared/domain/mesh/meshPolicyDiff";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import {
  type MeshQualityMetric,
  normalizeMeshQualityStatistics,
  type MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  asRecord,
  firstRecord,
  formatValue,
  nestedRecord,
  recordField,
} from "../MeshResourceView";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { emitMeshSizeHistogramHover } from "../meshSizeHistogramHover";

type MeshDetailsRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision"
  >;
};

export interface MeshDetailsModel {
  activeBuildRevision: unknown;
  activeBuildStatus: string;
  buildHistoryEntries: ReturnType<typeof normalizeMeshBuildHistory>;
  buildMode: unknown;
  buildStatus: string;
  capabilitiesData: unknown;
  capabilitiesStatus: string;
  fallbacks: readonly string[] | null | undefined;
  gateRows: Array<{ id: string; status: string; value: string }>;
  latestBuildJson: unknown;
  meshBuildReport: unknown;
  latestSuccessAvailable: boolean;
  lastBuildError: unknown;
  manifest: {
    domain_mesh_mode?: string | null;
    generation_id?: string | null;
    geometry_realization_revision?: number | null;
    mesh_id?: string | null;
    mesh_name?: string | null;
    mesh_parts?: readonly unknown[] | null;
    object_segments?: readonly unknown[] | null;
    regions?: readonly unknown[] | null;
    source_scene_revision?: number | null;
  } | null | undefined;
  manifestStatus: string;
  meshFreshness: string;
  meshIsStale: boolean;
  meshRevision: unknown;
  meshSourceSceneRevision: number | null;
  meshStatistics: unknown;
  meshSummary: Record<string, unknown> | null;
  objectPolicyCount: number;
  operationStatuses: readonly unknown[];
  policyDiffRows: MeshPolicyDiffRow[];
  qualityRefinementState: ReturnType<typeof resolveMeshQualityRefinementState>;
  qualityStatistics: ReturnType<typeof normalizeMeshQualityStatistics>;
  sceneRevision: number | null;
  semanticLayers: string;
  semanticsData: unknown;
  sharedQualityData: unknown;
  sharedQualityStatus: string;
  sharedReportData: unknown;
  sizeFieldKinds: readonly string[] | null | undefined;
  sizeFields: readonly unknown[];
  summaryStatus: string;
  targetCount: number;
  thinFilmDiagnostics: readonly unknown[];
  title: string;
  universeQualityData: unknown;
  universeReportData: unknown;
  onBuildSharedDomain: () => void;
  onHoverSizeDistributionBin: (bin: MeshSizeDistributionHoverBin | null) => void;
  onOpenBuildDetails: () => void;
  onRefineWorstElement: () => void;
  onSelectMetric: (metric: MeshQualityMetric["id"]) => void;
  onSelectWorstElement: (element: MeshWorstElement) => void;
}

function selectMeshDetailsRuntimeStatus(status: {
  data: LiveStatusResource | null;
}): MeshDetailsRuntimeStatus | null {
  if (!status.data) return null;
  return {
    capabilities: {
      explicit_topology: status.data.capabilities.explicit_topology,
    },
    domain: {
      discretization: status.data.domain.discretization,
    },
    resources: {
      mesh_build_revision: status.data.resources.mesh_build_revision,
      mesh_revision: status.data.resources.mesh_revision,
    },
  };
}

function meshDetailsRuntimeStatusEquals(
  previous: MeshDetailsRuntimeStatus | null,
  next: MeshDetailsRuntimeStatus | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return previous === next;
  return (
    previous.capabilities.explicit_topology ===
      next.capabilities.explicit_topology &&
    previous.domain.discretization === next.domain.discretization &&
    previous.resources.mesh_build_revision ===
      next.resources.mesh_build_revision &&
    previous.resources.mesh_revision === next.resources.mesh_revision
  );
}

function selectedSectionTitle(kind: string | null): string {
  if (kind === "mesh.shared-domain") return "Shared-Domain Mesh";
  if (kind === "mesh.builds") return "Mesh Build Pipeline";
  if (kind === "mesh.quality") return "Mesh Quality";
  if (kind === "mesh.size-fields") return "Realized Size Fields";
  if (kind === "mesh.regions") return "Regions And Parts";
  return "Mesh Overview";
}

function qualityGateRows(gates: unknown): Array<{ id: string; status: string; value: string }> {
  const checks = asRecord(gates)?.checks;
  if (!Array.isArray(checks)) return [];
  const rows: Array<{ id: string; status: string; value: string }> = [];
  for (const entry of checks) {
    const record = asRecord(entry);
    if (!record) continue;
    rows.push({
      id: formatValue(record.id),
      status: formatValue(record.status),
      value: formatValue(record.value),
    });
  }
  return rows;
}

function numericRevision(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstNumericRevision(...values: unknown[]): number | null {
  for (const value of values) {
    const revision = numericRevision(value);
    if (revision !== null) return revision;
  }
  return null;
}

function jsonObject(value: unknown): JsonObject | null {
  const record = asRecord(value);
  return record ? (record as JsonObject) : null;
}

function firstPolicyObject(...values: unknown[]): JsonObject | null {
  for (const value of values) {
    const record = jsonObject(value);
    if (record) return record;
  }
  return null;
}

export function buildSharedDomainPolicyDiffRows({
  activeBuild,
  latestBuild,
  semantics,
}: {
  activeBuild: unknown;
  latestBuild: unknown;
  semantics: unknown;
}): MeshPolicyDiffRow[] {
  const active = asRecord(activeBuild);
  const latest = asRecord(latestBuild);
  const semanticRecord = asRecord(semantics);
  const current = firstPolicyObject(
    semanticRecord?.shared_domain_policy,
    semanticRecord?.shared_domain,
    semanticRecord?.mesh_policy,
  );
  const draft = firstPolicyObject(
    active?.requested_policy,
    active?.draft_policy,
    active?.mesh_policy,
    current,
  );
  const realized = firstPolicyObject(
    active?.realized_policy,
    active?.effective_policy,
    active?.resolved_policy,
    latest?.realized_policy,
    latest?.effective_policy,
    latest?.resolved_policy,
  );

  if (!current && !draft && !realized) return [];
  return diffMeshPolicies({
    current,
    draft,
    realized,
    scope: "shared-domain",
  });
}

export function useMeshDetailsModel(
  selection: InspectorPanelProps["selection"],
): MeshDetailsModel {
  const kernel = useKernel();
  const runtimeStatus = useSessionStatusSelector(
    selectMeshDetailsRuntimeStatus,
    { isEqual: meshDetailsRuntimeStatusEquals },
  );
  const scene = useSceneResource();
  const summary = useMeshSummaryResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const capabilities = useMeshCapabilitiesResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const semantics = useMeshSemanticsResource();
  const activeBuild = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const buildHistory = useMeshBuildHistoryResource({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const latestBuild = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const sharedReport = useMeshSharedDomainReportResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const sharedQuality = useMeshSharedDomainQualityResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const qualityGates = useMeshSharedDomainQualityGatesResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const realizedSizeFields = useMeshSharedDomainRealizedSizeFieldsResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const universeReport = useMeshUniverseReportResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const universeQuality = useMeshUniverseQualityResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });

  const meshSummary = asRecord(summary.data?.mesh_summary);
  const meshStatistics =
    nestedRecord(semantics.data?.mesh_build_diagnostics, "mesh_statistics") ??
    nestedRecord(sharedReport.data?.report, "mesh_statistics");
  const qualityStatistics = normalizeMeshQualityStatistics(meshStatistics);
  const qualityRefinementState = useMemo(
    () => resolveMeshQualityRefinementState(qualityStatistics),
    [qualityStatistics],
  );
  const lastBuildSummary = firstRecord(
    activeBuild.data?.last_build_summary,
    latestBuild.data?.last_success,
  );
  const sceneRecord = asRecord(scene.data);
  const activeBuildRecord = asRecord(activeBuild.data?.active_build);
  const pipelinePhases = normalizeMeshPipelineStatus(activeBuild.data?.mesh_pipeline_status);
  const buildHistoryEntries = useMemo(
    () => normalizeMeshBuildHistory(buildHistory.data?.history),
    [buildHistory.data?.history],
  );
  const lastBuildGeometryRealization = nestedRecord(
    lastBuildSummary,
    "geometry_realization",
  );
  const gates = asRecord(qualityGates.data?.gates);
  const sizeFields = realizedSizeFields.data?.realized_size_fields?.fields ?? [];
  const objectConfigs = semantics.data?.object_configs ?? [];
  const operationStatuses =
    activeBuild.data?.shared_domain_build_report?.operation_statuses ?? [];
  const thinFilmDiagnostics =
    activeBuild.data?.shared_domain_build_report?.thin_film_diagnostics ?? [];
  const buildStatus = resolveMeshBuildStatusLabel(activeBuildRecord, pipelinePhases);
  const sceneRevision = firstNumericRevision(
    recordField(sceneRecord, "revision"),
    recordField(sceneRecord, "scene_revision"),
  );
  const meshSourceSceneRevision = firstNumericRevision(
    manifest.data?.source_scene_revision,
    recordField(lastBuildSummary, "source_scene_revision"),
    recordField(lastBuildGeometryRealization, "source_scene_revision"),
    recordField(activeBuildRecord, "source_scene_revision"),
  );
  const meshIsStale =
    sceneRevision !== null &&
    meshSourceSceneRevision !== null &&
    meshSourceSceneRevision < sceneRevision;
  const meshFreshness = meshIsStale
    ? "stale"
    : sceneRevision !== null && meshSourceSceneRevision !== null
      ? "current"
      : "unknown";
  const targetCount = Object.keys(
    asRecord(activeBuild.data?.effective_per_object_targets) ?? {},
  ).length;
  const buildContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sourceDetail: "mesh-details",
      }),
    [kernel],
  );
  const selectWorstElement = useCallback(
    (element: MeshWorstElement) => {
      const nodeId = `model:mesh:quality:element:${element.elementIndex}`;
      kernel.selection.set(
        {
          kind: "mesh.quality",
          label: `Worst mesh element ${element.elementIndex}`,
          nodeId,
          objectId: null,
          ref: {
            centroid: element.centroid,
            elementIndex: element.elementIndex,
            kind: "mesh.quality.element",
            metric: "gamma",
            nodeId,
            type: "mesh-quality-element",
            visualizationTargetId: `mesh:quality:element:${element.elementIndex}`,
          },
        },
        "mesh",
      );
      kernel.layout.setActiveTab("mesh");
    },
    [kernel],
  );
  const selectQualityMetric = useCallback(
    (metric: MeshQualityMetric["id"]) => {
      const nodeId = `model:mesh:quality:${metric}`;
      kernel.selection.set(
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
      kernel.layout.setActiveTab("mesh");
    },
    [kernel],
  );
  const refineWorstQualityElement = useCallback(() => {
    if (!qualityRefinementState.plan) return;
    void kernel.commands.execute(
      "mesh.refine-worst-quality-element",
      buildContext,
      {
        elementIndex: qualityRefinementState.plan.elementIndex,
        meshOptions: qualityRefinementState.plan.meshOptions,
      },
    );
  }, [buildContext, kernel.commands, qualityRefinementState.plan]);
  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: { kind: "all" },
      });
    },
    [kernel],
  );

  return {
    activeBuildRevision: activeBuild.data?.revision,
    activeBuildStatus: activeBuild.status,
    buildHistoryEntries,
    buildMode: activeBuild.data?.shared_domain_build_report?.build_mode,
    buildStatus,
    capabilitiesData: capabilities.data,
    capabilitiesStatus: capabilities.status,
    fallbacks: activeBuild.data?.shared_domain_build_report?.fallbacks_triggered,
    gateRows: qualityGateRows(gates),
    latestBuildJson: lastBuildSummary,
    meshBuildReport: semantics.data?.solver_mesh?.build_report,
    latestSuccessAvailable: Boolean(latestBuild.data?.last_success),
    lastBuildError:
      activeBuild.data?.last_build_error ?? latestBuild.data?.last_build_error,
    manifest: manifest.data,
    manifestStatus: manifest.status,
    meshFreshness,
    meshIsStale,
    meshRevision: summary.data?.revision,
    meshSourceSceneRevision,
    meshStatistics,
    meshSummary,
    objectPolicyCount: objectConfigs.length,
    operationStatuses,
    policyDiffRows: buildSharedDomainPolicyDiffRows({
      activeBuild: activeBuild.data?.active_build,
      latestBuild: latestBuild.data?.last_success,
      semantics: semantics.data,
    }),
    qualityRefinementState,
    qualityStatistics,
    sceneRevision,
    semanticLayers: semantics.data?.render_only_controls_do_not_change_solver_domain
      ? "universe / object / shared-domain"
      : "unknown",
    semanticsData: semantics.data,
    sharedQualityData: sharedQuality.data,
    sharedQualityStatus: sharedQuality.status,
    sharedReportData: sharedReport.data,
    sizeFieldKinds:
      activeBuild.data?.shared_domain_build_report?.used_size_field_kinds,
    sizeFields,
    summaryStatus: summary.status,
    targetCount,
    thinFilmDiagnostics,
    title: selectedSectionTitle(selection.kind),
    universeQualityData: universeQuality.data,
    universeReportData: universeReport.data,
    onBuildSharedDomain: () =>
      void kernel.commands.execute("mesh.build-shared-domain", buildContext),
    onHoverSizeDistributionBin: hoverSizeDistributionBin,
    onOpenBuildDetails: () =>
      kernel.selection.set(
        {
          kind: "mesh.builds",
          label: "Mesh Build Pipeline",
          nodeId: "model:mesh:builds",
          objectId: null,
          ref: null,
        },
        "mesh",
      ),
    onRefineWorstElement: refineWorstQualityElement,
    onSelectMetric: selectQualityMetric,
    onSelectWorstElement: selectWorstElement,
  };
}
