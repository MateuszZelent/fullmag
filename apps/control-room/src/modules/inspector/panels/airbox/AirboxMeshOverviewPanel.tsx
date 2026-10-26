"use client";

import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshBuild, shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  buildAirboxMeshBuildModel,
  currentAirboxQualityEvidence,
  currentAirboxReportEvidence,
  findCanonicalAirboxPart,
  matchesCurrentAirboxMeshRevision,
} from "./airboxMeshInspectorModel";
import {
  matchesAirboxTopologyIdentity,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

const targetValue = (target: unknown, keys: readonly string[]) => {
  if (!target || typeof target !== "object" || Array.isArray(target)) return "not published";
  const record = target as Record<string, unknown>;
  const value = keys.map((key) => record[key]).find((candidate) => candidate != null);
  return value == null ? "not published" : String(value);
};

const summaryStatus = (summary: unknown) => {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return "not published";
  const record = summary as Record<string, unknown>;
  const value = record.status ?? record.state ?? record.phase;
  return typeof value === "string" || typeof value === "number" ? String(value) : "published";
};

export function AirboxMeshOverviewPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const policy = useUniverseMeshPolicyResource();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const current = useMeshBuildCurrent({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const quality = useMeshUniverseQualityResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const report = useMeshUniverseReportResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const latest = useMeshBuildLatestSuccessful({
    enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus),
  });
  const scene = useSceneResource({ enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus) });
  const resource = policy.data ?? { config: null, effective_config: null, revision: 0 };
  const topologyMatches = matchesAirboxTopologyIdentity(runtimeStatus, manifest.data);
  const currentTopology = manifest.status === "ready" && topologyMatches;
  const currentMeshRevision = runtimeStatus?.resources.mesh_revision ?? null;
  const qualityEvidence = currentAirboxQualityEvidence(
    quality,
    currentTopology,
    currentMeshRevision,
  );
  const reportEvidence = currentAirboxReportEvidence(
    report,
    currentTopology,
    currentMeshRevision,
  );
  const qualityRevisionMatches = matchesCurrentAirboxMeshRevision(
    quality.data?.revision,
    currentMeshRevision,
  );
  const reportRevisionMatches = matchesCurrentAirboxMeshRevision(
    report.data?.revision,
    currentMeshRevision,
  );
  const qualityStatus = qualityEvidence
    ? quality.status
    : !currentTopology
      ? `topology ${manifest.status}`
      : quality.refreshError || quality.error
        ? "refresh error"
        : quality.status === "ready" && !qualityRevisionMatches
          ? "mesh revision mismatch"
          : quality.status;
  const reportStatus = reportEvidence
    ? report.status
    : !currentTopology
      ? `topology ${manifest.status}`
      : report.refreshError || report.error
        ? "refresh error"
        : report.status === "ready" && !reportRevisionMatches
          ? "mesh revision mismatch"
          : report.status;
  const currentManifest = topologyMatches ? manifest.data : null;
  const carrier = findCanonicalAirboxPart(currentManifest?.mesh_parts);
  const buildModel = buildAirboxMeshBuildModel({
    current: current.data ?? null,
    currentSceneRevision: scene.status === "ready" && !scene.error
      ? scene.data?.scene_revision ?? scene.data?.revision ?? null
      : null,
    latest: latest.data ?? null,
    report: reportEvidence,
  });
  const stale = buildModel.freshness === "stale";
  const target = buildModel.effectiveAirboxTarget;
  const configuredHmax = resource.effective_config?.airbox_hmax;
  const configuredHmin = resource.effective_config?.airbox_hmin;

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Airbox Mesh Overview" badge={stale ? "stale" : manifest.status}>
        <FieldRow label="Policy revision" value={String(resource.revision)} />
        <FieldRow label="Manifest revision" value={String(currentManifest?.revision ?? "unknown")} />
        <FieldRow
          label="Mesh evidence"
          value={
            stale
              ? "Build source scene differs from the current scene."
              : !topologyMatches
                ? manifest.status === "loading"
                  ? "Checking published topology identity."
                  : "Published topology identity is unavailable or mismatched."
                : manifest.status === "ready"
                  ? "Published topology identity matches current FEM generation."
                  : `Cached topology identity matches; manifest resource is ${manifest.status}.`
          }
        />
        <FieldRow label="Carrier" value={carrier?.id ?? "not available"} />
        <FieldRow label="Configured maximum element size" value={configuredHmax == null ? "not published" : String(configuredHmax)} unit="m" />
        <FieldRow label="Configured minimum element size" value={configuredHmin == null ? "not published" : String(configuredHmin)} unit="m" />
        <FieldRow label="Build target maximum element size" value={targetValue(target, ["hmax", "maximum_element_size"])} unit="m" />
        <FieldRow label="Build target minimum element size" value={targetValue(target, ["hmin", "minimum_element_size"])} unit="m" />
        <FieldRow label="Build target growth rate" value={targetValue(target, ["growth_rate"])} />
        <FieldRow label="Last build" value={current.data?.last_build_error ? `failed — ${current.data.last_build_error}` : current.data ? "available" : "not available"} />
        <FieldRow label="Last build summary" value={summaryStatus(current.data?.last_build_summary)} />
        <FieldRow label="Parameters status" value={policy.status} />
        <FieldRow label="Quality Gates status" value={qualityStatus} />
        <FieldRow label="Statistics status" value={`quality ${qualityStatus}; report ${reportStatus}`} />
        <FieldRow label="Topology status" value={manifest.status} />
        <FieldRow label="Build status" value={current.status} />
      </InspectorGroup>
    </div>
  );
}
