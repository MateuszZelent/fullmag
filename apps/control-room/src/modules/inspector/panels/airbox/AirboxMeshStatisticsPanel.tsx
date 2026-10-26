"use client";

import {
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow, boundedItems } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { formatCount } from "../MeshResourceView";
import {
  airboxSizeDistributionPresentation,
  buildAirboxMeshInspectorModel,
  currentAirboxQualityEvidence,
  currentAirboxReportEvidence,
  matchesCurrentAirboxMeshRevision,
} from "./airboxMeshInspectorModel";
import {
  matchesAirboxTopologyIdentity,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

function qualityNumber(value: number | null): string {
  return value === null
    ? "unknown"
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(value);
}

function familyMetric(metric: {
    max: number | null;
    mean: number | null;
    min: number | null;
    p05: number | null;
    reason: string | null;
    status: "available" | "unavailable" | "unknown";
    threshold: number | null;
  } | null,
): string {
  if (!metric) return "not published";
  if (metric.status === "unavailable") {
    return `unavailable${metric.reason ? ` — ${metric.reason}` : ""}`;
  }
  if (metric.status !== "available") return "unknown";
  return [
    `min ${qualityNumber(metric.min)}`,
    `p05 ${qualityNumber(metric.p05)}`,
    ...(metric.mean === null ? [] : [`mean ${qualityNumber(metric.mean)}`]),
    ...(metric.max === null ? [] : [`max ${qualityNumber(metric.max)}`]),
    ...(metric.threshold === null ? [] : [`threshold ${qualityNumber(metric.threshold)}`]),
  ].join("; ");
}

export function AirboxMeshStatisticsPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const summaryEnabled = shouldLoadRuntimeMeshSummary(true, runtimeStatus);
  const quality = useMeshUniverseQualityResource({ enabled: summaryEnabled });
  const report = useMeshUniverseReportResource({ enabled: summaryEnabled });
  const scene = useSceneResource({ enabled: summaryEnabled });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const topologyIdentityMatches = matchesAirboxTopologyIdentity(runtimeStatus, manifest.data);
  const topologyMatches = manifest.status === "ready" && topologyIdentityMatches;
  const currentMeshRevision = runtimeStatus?.resources.mesh_revision ?? null;
  const qualityRevisionMatches = matchesCurrentAirboxMeshRevision(
    quality.data?.revision,
    currentMeshRevision,
  );
  const reportRevisionMatches = matchesCurrentAirboxMeshRevision(
    report.data?.revision,
    currentMeshRevision,
  );
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
  const qualityStatusLabel = manifest.status !== "ready"
    ? `topology ${manifest.status}`
    : !topologyIdentityMatches
      ? "topology identity mismatch"
      : quality.refreshError || quality.error
        ? "refresh error"
        : quality.status === "ready" && !qualityRevisionMatches
          ? "mesh revision mismatch"
          : quality.status;
  const reportStatusLabel = manifest.status !== "ready"
    ? `topology ${manifest.status}`
    : !topologyIdentityMatches
      ? "topology identity mismatch"
      : report.refreshError || report.error
        ? "refresh error"
        : report.status === "ready" && !reportRevisionMatches
          ? "mesh revision mismatch"
          : report.status;
  let perFamilyQualityReason = "not published";
  if (manifest.status !== "ready") {
    perFamilyQualityReason = `topology resource ${manifest.status}; quality is withheld`;
  } else if (!topologyIdentityMatches) {
    perFamilyQualityReason = "waiting for matching Airbox topology identity";
  } else if (quality.refreshError || quality.error) {
    perFamilyQualityReason = "refresh error; cached statistics are withheld";
  } else if (quality.status === "ready" && !qualityRevisionMatches) {
    perFamilyQualityReason = "quality revision does not match the current mesh; statistics are withheld";
  } else if (quality.status !== "ready") {
    perFamilyQualityReason = quality.status === "stale"
      ? "stale cached statistics are withheld"
      : quality.status === "error"
        ? "quality resource error"
        : quality.status;
  }
  const model = buildAirboxMeshInspectorModel({
    manifest: topologyIdentityMatches ? manifest.data : null,
    currentSceneRevision: scene.status === "ready" && !scene.error
      ? scene.data?.scene_revision ?? scene.data?.revision ?? null
      : null,
    policy: { config: null, effective_config: null, revision: quality.data?.revision ?? 0 },
    quality: qualityEvidence,
    report: reportEvidence,
    summary: null,
  });
  const statistics = normalizeMeshQualityStatistics(
    qualityEvidence?.quality,
  );
  const warnings = boundedItems(statistics?.warnings ?? []);
  const familyQuality = boundedItems(model.statistics.qualityByFamily);
  const scopeLabel = model.statistics.qualityScope.label ?? "Airbox endpoint scope";
  const warningOccurrences = new Map<string, number>();

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Airbox Mesh Statistics" badge={manifest.status === "ready" && !topologyMatches ? "stale" : manifest.status}>
        <FieldRow label="Points / nodes (unique across carriers)" value={formatCount(model.statistics.nodeCount)} />
        <FieldRow label="Volume elements (all carriers)" value={formatCount(model.statistics.elementCount)} />
        {model.statistics.volumeElementsByType.map(({ count, family }) => (
          <FieldRow
            key={family}
            label={
              model.statistics.volumeElementCountScope === "shared-domain"
                ? `${family} (shared-domain)`
                : family
            }
            value={formatCount(count)}
          />
        ))}
        <FieldRow label="Boundary faces" value={formatCount(model.statistics.boundaryFaceCount)} />
        <FieldRow label="Surface faces" value={formatCount(model.statistics.surfaceFaceCount)} />
        <FieldRow label="Mesh report resource" value={reportStatusLabel} />
        <FieldRow label="Shared interface nodes" value={formatCount(model.topology.sharedInterfaceNodes.count)} />
        <FieldRow label="Ownership" value="shared, not exclusive Airbox memory" />
      </InspectorGroup>
      <InspectorGroup title="Airbox Quality Distributions" badge={qualityEvidence ? String(statistics?.elementCount ?? "ready") : qualityStatusLabel}>
        <FieldRow label="Scope" value={scopeLabel} />
        <FieldRow label="Marker" value={String(model.statistics.qualityScope.marker ?? "not published")} />
        <FieldRow label="Quality resource" value={qualityStatusLabel} />
        <FieldRow
          label="Mesh freshness"
          value={
            model.lifecycle.status === "current"
              ? "current source scene"
              : model.lifecycle.status === "stale"
                ? "stale source scene"
                : "source scene provenance unknown"
          }
        />
        <FieldRow label="Quality source" value={statistics?.qualitySource ?? "not published"} />
        <FieldRow label="Elements in quality statistics" value={formatCount(statistics?.elementCount ?? null)} />
        {boundedItems(statistics?.metrics ?? []).map((metric) => (
          <FieldRow
            key={metric.id}
            label={metric.label}
            value={`min ${metric.min ?? "unknown"}; mean ${metric.mean ?? "unknown"}; Below target ${metric.belowThresholdCount ?? "unknown"}`}
          />
        ))}
        {boundedItems(statistics?.sizeDistributions ?? []).map((distribution) => {
          const presentation = airboxSizeDistributionPresentation(distribution);
          return (
            <FieldRow
              key={distribution.id}
              label={presentation.label}
              value={`min ${distribution.min ?? "unknown"}; mean ${distribution.mean ?? "unknown"}; max ${distribution.max ?? "unknown"}`}
              unit={presentation.unit}
            />
          );
        })}
        {familyQuality.map((family) => (
          <InspectorGroup key={family.family} title={`${family.family} quality`} badge={formatCount(family.cellCount)}>
            <FieldRow label="Cell count" value={formatCount(family.cellCount)} />
            <FieldRow label="SICN" value={familyMetric(family.sicn)} />
            <FieldRow label="Gamma" value={familyMetric(family.gamma)} />
            <FieldRow label="Mixed-topology scaled Jacobian" value={familyMetric(family.mixedTopologyScaledJacobian)} />
            <FieldRow label="Quality source" value={family.source ?? "not published"} />
            {family.mixedTopologyScaledJacobian ? (
              <FieldRow label="Mixed certificate source" value={family.mixedTopologyScaledJacobian.source ?? "not published"} />
            ) : null}
            {family.mixedTopologyScaledJacobian?.certificateFingerprint ? (
              <FieldRow label="Mixed certificate fingerprint" value={family.mixedTopologyScaledJacobian.certificateFingerprint} mono />
            ) : null}
          </InspectorGroup>
        ))}
        {!familyQuality.length ? (
          <FieldRow label="Per-family quality" value={perFamilyQualityReason} />
        ) : null}
        {warnings.map((warning) => {
          const occurrence = warningOccurrences.get(warning) ?? 0;
          warningOccurrences.set(warning, occurrence + 1);
          return (
            <FieldRow key={`${warning}:${occurrence}`} label={`Warning ${occurrence + 1}`} value={warning} />
          );
        })}
      </InspectorGroup>
    </div>
  );
}
