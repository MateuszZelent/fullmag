"use client";

import { useMemo } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useMeshBuildCurrent,
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
import { useKernel } from "@/kernel/KernelContext";
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

function buildStatusLabel(value: unknown): string {
  const record = asRecord(value);
  const status = recordField(record, "status");
  if (typeof status === "string" && status.length > 0) return status;
  if (record && Object.keys(record).length > 0) return "available";
  return "idle";
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
  return checks
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      return {
        id: formatValue(record.id),
        status: formatValue(record.status),
        value: formatValue(record.value),
      };
    })
    .filter((entry): entry is { id: string; status: string; value: string } =>
      Boolean(entry),
    );
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

export function MeshDetailsPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const summary = useMeshSummaryResource();
  const capabilities = useMeshCapabilitiesResource();
  const semantics = useMeshSemanticsResource();
  const activeBuild = useMeshBuildCurrent();
  const latestBuild = useMeshBuildLatestSuccessful();
  const manifest = useMeshSharedDomainManifestResource();
  const sharedReport = useMeshSharedDomainReportResource();
  const sharedQuality = useMeshSharedDomainQualityResource();
  const qualityGates = useMeshSharedDomainQualityGatesResource();
  const realizedSizeFields = useMeshSharedDomainRealizedSizeFieldsResource();
  const universeReport = useMeshUniverseReportResource();
  const universeQuality = useMeshUniverseQualityResource();

  const meshSummary = asRecord(summary.data?.mesh_summary);
  const meshStatistics =
    nestedRecord(semantics.data?.mesh_build_diagnostics, "mesh_statistics") ??
    nestedRecord(sharedReport.data?.report, "mesh_statistics");
  const lastBuildSummary = firstRecord(
    activeBuild.data?.last_build_summary,
    latestBuild.data?.last_success,
  );
  const sceneRecord = asRecord(scene.data);
  const activeBuildRecord = asRecord(activeBuild.data?.active_build);
  const pipelineStatus = asRecord(activeBuild.data?.mesh_pipeline_status);
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
  const buildStatus = buildStatusLabel(activeBuildRecord ?? pipelineStatus);
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
    () => createCommandContext("ribbon", kernel),
    [kernel],
  );

  return (
    <div className="fm-inspector-panel">
      <InspectorSection title={title} badge={buildStatus}>
        {meshIsStale ? (
          <FeedbackBanner
            kind="warning"
            message="Solver mesh was built from an older scene revision. Rebuild the shared-domain mesh to synchronize inspector data with backend solver state."
          />
        ) : null}
        <MeshResourceFields
          fields={[
            { label: "Summary state", value: summary.status },
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
            { label: "Mesh revision", value: String(summary.data?.revision ?? "unknown") },
            {
              label: "Build revision",
              value: String(activeBuild.data?.revision ?? "unknown"),
            },
            {
              label: "Semantic layers",
              value: semantics.data?.render_only_controls_do_not_change_solver_domain
                ? "universe / object / shared-domain"
                : "unknown",
            },
            {
              label: "Object policies",
              value: objectConfigs.length.toLocaleString("en-US"),
            },
            {
              label: "Resolved object targets",
              value: targetCount.toLocaleString("en-US"),
            },
          ]}
        />
      </InspectorSection>

      <InspectorSection title="Solver Mesh Identity" badge={manifest.status}>
        <MeshResourceFields
          fields={[
            { label: "Mesh name", value: manifest.data?.mesh_name ?? "not built" },
            { label: "Mesh id", value: manifest.data?.mesh_id ?? "none" },
            {
              label: "Generation",
              value: manifest.data?.generation_id ?? "no generation",
            },
            {
              label: "Domain mode",
              value: manifest.data?.domain_mesh_mode ?? "not applicable",
            },
            {
              label: "Source scene",
              value: String(manifest.data?.source_scene_revision ?? "unknown"),
            },
            {
              label: "Geometry realization",
              value: String(
                manifest.data?.geometry_realization_revision ?? "unknown",
              ),
            },
            {
              label: "Mesh parts",
              value: String(manifest.data?.mesh_parts?.length ?? 0),
            },
            {
              label: "Object segments",
              value: String(manifest.data?.object_segments?.length ?? 0),
            },
            { label: "Regions", value: String(manifest.data?.regions?.length ?? 0) },
          ]}
        />
      </InspectorSection>

      <InspectorSection title="Counts And Extents" collapsible defaultCollapsed={false}>
        <MeshResourceFields
          fields={[
            {
              label: "Nodes",
              value: formatCount(
                recordField(meshSummary, "node_count") ??
                  recordField(meshStatistics, "node_count"),
              ),
            },
            {
              label: "Elements",
              value: formatCount(
                recordField(meshSummary, "element_count") ??
                  recordField(meshStatistics, "element_count"),
              ),
            },
            {
              label: "Boundary faces",
              value: formatCount(
                recordField(meshSummary, "boundary_face_count") ??
                  recordField(meshStatistics, "boundary_face_count"),
              ),
            },
            {
              label: "Min edge",
              value: formatLength(recordField(meshStatistics, "min_edge_length")),
            },
            {
              label: "Max edge",
              value: formatLength(recordField(meshStatistics, "max_edge_length")),
            },
            {
              label: "Mean edge",
              value: formatLength(recordField(meshStatistics, "mean_edge_length")),
            },
          ]}
        />
      </InspectorSection>

      <InspectorSection title="Build Pipeline" badge={activeBuild.status}>
        <MeshResourceFields
          fields={[
            { label: "Active build", value: buildStatus },
            {
              label: "Last success",
              value: latestBuild.data?.last_success ? "available" : "missing",
            },
            {
              label: "Last error",
              value: activeBuild.data?.last_build_error ?? latestBuild.data?.last_build_error ?? "none",
            },
            {
              label: "Build mode",
              value: activeBuild.data?.shared_domain_build_report?.build_mode ?? "unknown",
            },
            {
              label: "Fallbacks",
              value:
                activeBuild.data?.shared_domain_build_report?.fallbacks_triggered
                  ?.join(", ") ?? "none",
            },
            {
              label: "Size field kinds",
              value:
                activeBuild.data?.shared_domain_build_report?.used_size_field_kinds
                  ?.join(", ") ?? "none",
            },
          ]}
        />
        <div className="fm-inspector-toolbar">
          <Button
            size="sm"
            type="button"
            variant="primary"
            onClick={() =>
              void kernel.commands.execute("mesh.build-shared-domain", buildContext)
            }
          >
            Build Shared-Domain Mesh
          </Button>
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() =>
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
          >
            Open Build Details
          </Button>
        </div>
      </InspectorSection>

      <InspectorSection title="Quality Gates" badge={sharedQuality.status}>
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

      <InspectorSection title="Realized Size Fields" badge={`${sizeFields.length}`}>
        {sizeFields.length > 0 ? (
          <div className="fm-mesh-detail-list">
            {sizeFields.map((field, index) => (
              <div
                key={`${field.kind}:${index}`}
                className="fm-mesh-detail-list__item"
                data-status={field.status}
              >
                <strong>{field.kind}</strong>
                <span>{field.status}</span>
                <small>{field.reason ?? field.source ?? "applied"}</small>
              </div>
            ))}
          </div>
        ) : (
          <MeshResourceEmpty label="No realized size fields are available for the current build." />
        )}
      </InspectorSection>

      <InspectorSection title="Operation Statuses" badge={`${operationStatuses.length}`}>
        {operationStatuses.length > 0 ? (
          <div className="fm-mesh-detail-list">
            {operationStatuses.map((status, index) => (
              <div
                key={`${status.kind}:${status.scope}:${index}`}
                className="fm-mesh-detail-list__item"
                data-status={status.status}
              >
                <strong>{status.kind}</strong>
                <span>{status.status}</span>
                <small>{status.reason ?? status.scope}</small>
              </div>
            ))}
          </div>
        ) : (
          <MeshResourceEmpty label="No operation statuses are present in the active build report." />
        )}
      </InspectorSection>

      <InspectorSection title="Thin-Film Diagnostics" badge={`${thinFilmDiagnostics.length}`}>
        {thinFilmDiagnostics.length > 0 ? (
          <div className="fm-mesh-detail-list">
            {thinFilmDiagnostics.map((diagnostic, index) => (
              <div
                key={`${diagnostic.geometry_name}:${index}`}
                className="fm-mesh-detail-list__item"
                data-status={diagnostic.warnings?.length ? "warning" : "ready"}
              >
                <strong>{diagnostic.geometry_name}</strong>
                <span>{diagnostic.actual_method ?? diagnostic.requested_method ?? "auto"}</span>
                <small>
                  thickness {formatLength(diagnostic.thickness)} / lateral{" "}
                  {formatLength(diagnostic.lateral_size)}
                </small>
              </div>
            ))}
          </div>
        ) : (
          <MeshResourceEmpty label="No thin-film diagnostics are present in the active build report." />
        )}
      </InspectorSection>

      <JsonResourceSection
        badge={capabilities.status}
        title="Meshing Capabilities JSON"
        value={capabilities.data}
      />
      <JsonResourceSection title="Mesh Semantics JSON" value={semantics.data} />
      <JsonResourceSection title="Universe Report JSON" value={universeReport.data} />
      <JsonResourceSection title="Universe Quality JSON" value={universeQuality.data} />
      <JsonResourceSection title="Shared-Domain Report JSON" value={sharedReport.data} />
      <JsonResourceSection title="Shared-Domain Quality JSON" value={sharedQuality.data} />
      <JsonResourceSection title="Latest Build JSON" value={lastBuildSummary} />
    </div>
  );
}
