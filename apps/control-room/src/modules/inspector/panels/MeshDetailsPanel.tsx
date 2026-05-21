"use client";

import { useCallback, useMemo } from "react";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
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
  type MeshQualityMetric,
  normalizeMeshQualityStatistics,
  type MeshWorstElement,
} from "@/shared/domain/mesh/qualityStatistics";
import { resolveMeshQualityRefinementState } from "@/shared/domain/mesh/meshQualityRefinement";
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  asRecord,
  firstRecord,
  formatCount,
  formatLength,
  formatValue,
  JsonResourceSection,
  MeshResourceEmpty,
  MeshResourceFields,
  nestedRecord,
  recordField,
} from "./MeshResourceView";
import { MeshBuildHistoryView } from "./MeshBuildHistoryView";
import { MeshQualityStatisticsView } from "./MeshQualityStatisticsView";

type MeshDetailsRuntimeStatus = {
  capabilities: Pick<LiveStatusResource["capabilities"], "explicit_topology">;
  domain: Pick<LiveStatusResource["domain"], "discretization">;
  resources: Pick<
    LiveStatusResource["resources"],
    "mesh_build_revision" | "mesh_revision"
  >;
};

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

function meshDetailKey(
  prefix: string,
  fields: Array<unknown>,
): string {
  return fields.map((field) => formatValue(field)).join(":") || prefix;
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

function MeshOverviewSection({
  activeBuildRevision,
  buildStatus,
  meshFreshness,
  meshIsStale,
  meshRevision,
  meshSourceSceneRevision,
  objectPolicyCount,
  sceneRevision,
  semanticLayers,
  summaryStatus,
  targetCount,
  title,
}: {
  activeBuildRevision: unknown;
  buildStatus: string;
  meshFreshness: string;
  meshIsStale: boolean;
  meshRevision: unknown;
  meshSourceSceneRevision: number | null;
  objectPolicyCount: number;
  sceneRevision: number | null;
  semanticLayers: string;
  summaryStatus: string;
  targetCount: number;
  title: string;
}) {
  return (
    <InspectorSection value="overview" title={title} badge={buildStatus} collapsible defaultCollapsed={false}>
      {meshIsStale ? (
        <FeedbackBanner
          kind="warning"
          message="Solver mesh was built from an older scene revision. Rebuild the shared-domain mesh to synchronize inspector data with backend solver state."
        />
      ) : null}
      <MeshResourceFields
        fields={[
          { label: "Summary state", value: summaryStatus },
          {
            label: "Scene revision",
            value: String(sceneRevision ?? "unknown"),
          },
          {
            label: "Source scene revision",
            value: String(meshSourceSceneRevision ?? "unknown"),
          },
          {
            label: "Mesh freshness",
            value: meshFreshness,
          },
          { label: "Mesh revision", value: String(meshRevision ?? "unknown") },
          {
            label: "Build revision",
            value: String(activeBuildRevision ?? "unknown"),
          },
          {
            label: "Semantic layers",
            value: semanticLayers,
          },
          {
            label: "Object policies",
            value: objectPolicyCount.toLocaleString("en-US"),
          },
          {
            label: "Resolved object targets",
            value: targetCount.toLocaleString("en-US"),
          },
        ]}
      />
    </InspectorSection>
  );
}

function SolverMeshIdentitySection({
  badge,
  manifest,
}: {
  badge: string;
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
}) {
  return (
    <InspectorSection value="identity" title="Solver Mesh Identity" badge={badge} collapsible defaultCollapsed={false}>
      <MeshResourceFields
        fields={[
          { label: "Mesh name", value: manifest?.mesh_name ?? "not built" },
          { label: "Mesh id", value: manifest?.mesh_id ?? "none" },
          {
            label: "Generation",
            value: manifest?.generation_id ?? "no generation",
          },
          {
            label: "Domain mode",
            value: manifest?.domain_mesh_mode ?? "not applicable",
          },
          {
            label: "Source scene",
            value: String(manifest?.source_scene_revision ?? "unknown"),
          },
          {
            label: "Geometry realization",
            value: String(manifest?.geometry_realization_revision ?? "unknown"),
          },
          {
            label: "Mesh parts",
            value: String(manifest?.mesh_parts?.length ?? 0),
          },
          {
            label: "Object segments",
            value: String(manifest?.object_segments?.length ?? 0),
          },
          { label: "Regions", value: String(manifest?.regions?.length ?? 0) },
        ]}
      />
    </InspectorSection>
  );
}

function MeshCountsExtentsSection({
  edgeLength,
  meshStatistics,
  meshSummary,
}: {
  edgeLength: {
    max: number | null;
    mean: number | null;
    min: number | null;
    std: number | null;
  } | null;
  meshStatistics: unknown;
  meshSummary: unknown;
}) {
  return (
    <InspectorSection value="counts" title="Counts And Extents" collapsible defaultCollapsed={false}>
      <MeshResourceFields
        fields={[
          {
            label: "Nodes",
            value: formatCount(
              recordField(asRecord(meshSummary), "node_count") ??
                recordField(asRecord(meshStatistics), "node_count"),
            ),
          },
          {
            label: "Elements",
            value: formatCount(
              recordField(asRecord(meshSummary), "element_count") ??
                recordField(asRecord(meshStatistics), "element_count"),
            ),
          },
          {
            label: "Boundary faces",
            value: formatCount(
              recordField(asRecord(meshSummary), "boundary_face_count") ??
                recordField(asRecord(meshStatistics), "boundary_face_count"),
            ),
          },
          {
            label: "Min edge",
            value: formatLength(
              edgeLength?.min ?? recordField(asRecord(meshStatistics), "min_edge_length"),
            ),
          },
          {
            label: "Max edge",
            value: formatLength(
              edgeLength?.max ?? recordField(asRecord(meshStatistics), "max_edge_length"),
            ),
          },
          {
            label: "Mean edge",
            value: formatLength(
              edgeLength?.mean ?? recordField(asRecord(meshStatistics), "mean_edge_length"),
            ),
          },
        ]}
      />
    </InspectorSection>
  );
}

function MeshBuildPipelineSection({
  activeBuildStatus,
  buildMode,
  buildStatus,
  fallbacks,
  lastBuildError,
  latestSuccessAvailable,
  onBuildSharedDomain,
  onOpenBuildDetails,
  sizeFieldKinds,
}: {
  activeBuildStatus: string;
  buildMode: unknown;
  buildStatus: string;
  fallbacks: readonly string[] | null | undefined;
  lastBuildError: unknown;
  latestSuccessAvailable: boolean;
  onBuildSharedDomain: () => void;
  onOpenBuildDetails: () => void;
  sizeFieldKinds: readonly string[] | null | undefined;
}) {
  return (
    <InspectorSection value="pipeline" title="Build Pipeline" badge={activeBuildStatus} collapsible defaultCollapsed={false}>
      <MeshResourceFields
        fields={[
          { label: "Active build", value: buildStatus },
          {
            label: "Last success",
            value: latestSuccessAvailable ? "available" : "missing",
          },
          {
            label: "Last error",
            value: formatValue(lastBuildError ?? "none"),
          },
          {
            label: "Build mode",
            value: formatValue(buildMode ?? "unknown"),
          },
          {
            label: "Fallbacks",
            value: fallbacks?.join(", ") ?? "none",
          },
          {
            label: "Size field kinds",
            value: sizeFieldKinds?.join(", ") ?? "none",
          },
        ]}
      />
      <div className="fm-inspector-toolbar">
        <Button
          size="sm"
          type="button"
          variant="primary"
          onClick={onBuildSharedDomain}
        >
          Build Shared-Domain Mesh
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={onOpenBuildDetails}
        >
          Open Build Details
        </Button>
      </div>
    </InspectorSection>
  );
}

function MeshBuildHistorySection({
  entries,
}: {
  entries: ReturnType<typeof normalizeMeshBuildHistory>;
}) {
  return (
    <InspectorSection
      value="build-history"
      title="Build History Compare"
      badge={formatCount(entries.length)}
      collapsible
      defaultCollapsed={entries.length === 0}
    >
      <MeshBuildHistoryView entries={entries} />
    </InspectorSection>
  );
}

function MeshQualityGatesSection({
  badge,
  gateRows,
}: {
  badge: string;
  gateRows: ReturnType<typeof qualityGateRows>;
}) {
  return (
    <InspectorSection value="quality-gates" title="Quality Gates" badge={badge} collapsible defaultCollapsed={false}>
      {gateRows.length > 0 ? (
        <div className="fm-mesh-detail-table" role="table">
          <div className="fm-mesh-detail-table__row" role="row">
            <span>Check</span>
            <span>Status</span>
            <span>Value</span>
          </div>
          {gateRows.map((row) => (
            <div
              key={row.id}
              className="fm-mesh-detail-table__row"
              data-status={row.status}
              role="row"
            >
              <span>{row.id}</span>
              <span>{row.status}</span>
              <span>{row.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <MeshResourceEmpty label="No quality-gate checks published yet." />
      )}
    </InspectorSection>
  );
}

function MeshQualityStatisticsSection({
  onRefineWorstElement,
  onSelectMetric,
  onSelectWorstElement,
  refinementState,
  statistics,
}: {
  onRefineWorstElement: () => void;
  onSelectMetric: (metric: MeshQualityMetric["id"]) => void;
  onSelectWorstElement: (element: MeshWorstElement) => void;
  refinementState: ReturnType<typeof resolveMeshQualityRefinementState>;
  statistics: ReturnType<typeof normalizeMeshQualityStatistics>;
}) {
  return (
    <InspectorSection
      value="quality-statistics"
      title="Quality Distributions"
      badge={statistics ? formatCount(statistics.elementCount) : "missing"}
      collapsible
      defaultCollapsed={false}
    >
      <MeshQualityStatisticsView
        statistics={statistics}
        refinementState={refinementState}
        onRefineWorstElement={onRefineWorstElement}
        onSelectMetric={onSelectMetric}
        onSelectWorstElement={onSelectWorstElement}
      />
    </InspectorSection>
  );
}

function formatSizeFieldParam(key: string, value: unknown): string {
  const normalizedKey = key.toLowerCase();
  const likelyLength =
    normalizedKey.includes("size") ||
    normalizedKey.includes("target") ||
    normalizedKey.includes("hmin") ||
    normalizedKey.includes("hmax") ||
    normalizedKey === "lc" ||
    normalizedKey.endsWith("_lc") ||
    normalizedKey.includes("radius") ||
    normalizedKey.includes("distance") ||
    normalizedKey.includes("thickness");
  return `${key} ${likelyLength ? formatLength(value) : formatValue(value)}`;
}

function sizeFieldParamSummary(params: unknown): string | null {
  const record = asRecord(params);
  if (!record) return null;
  const preferredKeys = [
    "hmin",
    "hmax",
    "target_size",
    "size",
    "lc",
    "min_size",
    "max_size",
    "thickness",
    "distance",
    "growth_rate",
  ];
  const entries = preferredKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => formatSizeFieldParam(key, record[key]));
  if (entries.length > 0) return entries.slice(0, 4).join(" / ");
  return Object.entries(record)
    .slice(0, 4)
    .map(([key, value]) => formatSizeFieldParam(key, value))
    .join(" / ");
}

function RealizedSizeFieldsSection({ sizeFields }: { sizeFields: readonly unknown[] }) {
  return (
    <InspectorSection value="size-fields" title="Realized Size Fields" badge={`${sizeFields.length}`} collapsible defaultCollapsed={false}>
      {sizeFields.length > 0 ? (
        <div className="fm-mesh-detail-list">
          {sizeFields.map((field) => {
            const record = asRecord(field);
            const kind = recordField(record, "kind");
            const reason = recordField(record, "reason");
            const source = recordField(record, "source");
            const status = recordField(record, "status");
            const paramSummary = sizeFieldParamSummary(
              recordField(record, "params"),
            );
            return (
              <div
                key={meshDetailKey("size-field", [kind, status, reason, source])}
                className="fm-mesh-detail-list__item"
                data-status={formatValue(status)}
              >
                <strong>{formatValue(kind)}</strong>
                <span>{formatValue(status)}</span>
                <small>
                  {paramSummary ?? formatValue(reason ?? source ?? "applied")}
                </small>
              </div>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No realized size fields are available for the current build." />
      )}
    </InspectorSection>
  );
}

function OperationStatusesSection({
  operationStatuses,
}: {
  operationStatuses: readonly unknown[];
}) {
  return (
    <InspectorSection value="operation-statuses" title="Operation Statuses" badge={`${operationStatuses.length}`} collapsible defaultCollapsed={true}>
      {operationStatuses.length > 0 ? (
        <div className="fm-mesh-detail-list">
          {operationStatuses.map((statusEntry) => {
            const record = asRecord(statusEntry);
            const kind = recordField(record, "kind");
            const reason = recordField(record, "reason");
            const scope = recordField(record, "scope");
            const status = recordField(record, "status");
            return (
              <div
                key={meshDetailKey("operation-status", [kind, scope, status, reason])}
                className="fm-mesh-detail-list__item"
                data-status={formatValue(status)}
              >
                <strong>{formatValue(kind)}</strong>
                <span>{formatValue(status)}</span>
                <small>{formatValue(reason ?? scope)}</small>
              </div>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No operation statuses are present in the active build report." />
      )}
    </InspectorSection>
  );
}

function ThinFilmDiagnosticsSection({
  thinFilmDiagnostics,
}: {
  thinFilmDiagnostics: readonly unknown[];
}) {
  return (
    <InspectorSection value="thin-film" title="Thin-Film Diagnostics" badge={`${thinFilmDiagnostics.length}`} collapsible defaultCollapsed={true}>
      {thinFilmDiagnostics.length > 0 ? (
        <div className="fm-mesh-detail-list">
          {thinFilmDiagnostics.map((diagnosticEntry) => {
            const record = asRecord(diagnosticEntry);
            const actualMethod = recordField(record, "actual_method");
            const geometryName = recordField(record, "geometry_name");
            const lateralSize = recordField(record, "lateral_size");
            const requestedMethod = recordField(record, "requested_method");
            const thickness = recordField(record, "thickness");
            const warnings = recordField(record, "warnings");
            return (
              <div
                key={meshDetailKey("thin-film-diagnostic", [
                  geometryName,
                  actualMethod,
                  requestedMethod,
                  thickness,
                  lateralSize,
                ])}
                className="fm-mesh-detail-list__item"
                data-status={Array.isArray(warnings) && warnings.length ? "warning" : "ready"}
              >
                <strong>{formatValue(geometryName)}</strong>
                <span>{formatValue(actualMethod ?? requestedMethod ?? "auto")}</span>
                <small>
                  thickness {formatLength(thickness)} / lateral {formatLength(lateralSize)}
                </small>
              </div>
            );
          })}
        </div>
      ) : (
        <MeshResourceEmpty label="No thin-film diagnostics are present in the active build report." />
      )}
    </InspectorSection>
  );
}

export function MeshDetailsPanel({ selection }: InspectorPanelProps) {
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
  const gateRows = qualityGateRows(gates);
  const sizeFields = realizedSizeFields.data?.realized_size_fields?.fields ?? [];
  const objectConfigs = semantics.data?.object_configs ?? [];
  const operationStatuses =
    activeBuild.data?.shared_domain_build_report?.operation_statuses ?? [];
  const thinFilmDiagnostics =
    activeBuild.data?.shared_domain_build_report?.thin_film_diagnostics ?? [];
  const title = selectedSectionTitle(selection.kind);
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

  return (
    <Accordion
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={[
        "overview",
        "identity",
        "counts",
        "pipeline",
        "build-history",
        "quality-gates",
        "quality-statistics",
        "size-fields",
      ]}
    >
      <MeshOverviewSection
        activeBuildRevision={activeBuild.data?.revision}
        buildStatus={buildStatus}
        meshFreshness={meshFreshness}
        meshIsStale={meshIsStale}
        meshRevision={summary.data?.revision}
        meshSourceSceneRevision={meshSourceSceneRevision}
        objectPolicyCount={objectConfigs.length}
        sceneRevision={sceneRevision}
        semanticLayers={
          semantics.data?.render_only_controls_do_not_change_solver_domain
            ? "universe / object / shared-domain"
            : "unknown"
        }
        summaryStatus={summary.status}
        targetCount={targetCount}
        title={title}
      />
      <SolverMeshIdentitySection badge={manifest.status} manifest={manifest.data} />
      <MeshCountsExtentsSection
        edgeLength={qualityStatistics?.edgeLength ?? null}
        meshStatistics={meshStatistics}
        meshSummary={meshSummary}
      />
      <MeshBuildPipelineSection
        activeBuildStatus={activeBuild.status}
        buildMode={activeBuild.data?.shared_domain_build_report?.build_mode}
        buildStatus={buildStatus}
        fallbacks={activeBuild.data?.shared_domain_build_report?.fallbacks_triggered}
        lastBuildError={
          activeBuild.data?.last_build_error ?? latestBuild.data?.last_build_error
        }
        latestSuccessAvailable={Boolean(latestBuild.data?.last_success)}
        onBuildSharedDomain={() =>
          void kernel.commands.execute("mesh.build-shared-domain", buildContext)
        }
        onOpenBuildDetails={() =>
          kernel.selection.set(
            {
              kind: "mesh.builds",
              label: "Mesh Build Pipeline",
              nodeId: "model:mesh:builds",
              objectId: null,
              ref: null,
            },
            "mesh",
          )
        }
        sizeFieldKinds={
          activeBuild.data?.shared_domain_build_report?.used_size_field_kinds
        }
      />
      <MeshBuildHistorySection entries={buildHistoryEntries} />
      <MeshQualityGatesSection badge={sharedQuality.status} gateRows={gateRows} />
      <MeshQualityStatisticsSection
        statistics={qualityStatistics}
        refinementState={qualityRefinementState}
        onRefineWorstElement={refineWorstQualityElement}
        onSelectMetric={selectQualityMetric}
        onSelectWorstElement={selectWorstElement}
      />
      <RealizedSizeFieldsSection sizeFields={sizeFields} />
      <OperationStatusesSection operationStatuses={operationStatuses} />
      <ThinFilmDiagnosticsSection thinFilmDiagnostics={thinFilmDiagnostics} />

      <JsonResourceSection
        sectionValue="json-capabilities"
        badge={capabilities.status}
        title="Meshing Capabilities JSON"
        value={capabilities.data}
      />
      <JsonResourceSection sectionValue="json-semantics" title="Mesh Semantics JSON" value={semantics.data} />
      <JsonResourceSection sectionValue="json-universe-report" title="Universe Report JSON" value={universeReport.data} />
      <JsonResourceSection sectionValue="json-universe-quality" title="Universe Quality JSON" value={universeQuality.data} />
      <JsonResourceSection sectionValue="json-shared-report" title="Shared-Domain Report JSON" value={sharedReport.data} />
      <JsonResourceSection sectionValue="json-shared-quality" title="Shared-Domain Quality JSON" value={sharedQuality.data} />
      <JsonResourceSection sectionValue="json-last-build" title="Latest Build JSON" value={lastBuildSummary} />
    </Accordion>
  );
}
