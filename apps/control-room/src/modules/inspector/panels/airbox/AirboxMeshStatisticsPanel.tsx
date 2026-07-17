"use client";

import {
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshManifest,
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow, boundedItems } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { formatCount } from "../MeshResourceView";
import { buildAirboxMeshInspectorModel } from "./airboxMeshInspectorModel";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";

export function AirboxMeshStatisticsPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const summaryEnabled = shouldLoadRuntimeMeshSummary(true, runtimeStatus);
  const quality = useMeshUniverseQualityResource({ enabled: summaryEnabled });
  const report = useMeshUniverseReportResource({ enabled: summaryEnabled });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
  });
  const model = buildAirboxMeshInspectorModel({
    manifest: manifest.data ?? null,
    policy: { config: null, effective_config: null, revision: quality.data?.revision ?? 0 },
    quality: quality.data ?? null,
    report: report.data ?? null,
    summary: null,
  });
  const statistics = normalizeMeshQualityStatistics(quality.data?.quality);

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-[var(--fm-inspector-group-gap)]">
      <InspectorGroup title="Airbox Mesh Statistics" badge={manifest.status}>
        <FieldRow label="Points / nodes" value={formatCount(model.statistics.nodeCount)} />
        <FieldRow label="Tetrahedra" value={formatCount(model.statistics.elementCount)} />
        <FieldRow label="Boundary faces" value={formatCount(model.statistics.boundaryFaceCount)} />
        <FieldRow label="Surface faces" value={formatCount(model.statistics.surfaceFaceCount)} />
        <FieldRow label="Shared interface nodes" value={formatCount(model.topology.sharedInterfaceNodes.count)} />
        <FieldRow label="Ownership" value="shared, not exclusive Airbox memory" />
      </InspectorGroup>
      <InspectorGroup title="Shared-domain Quality Distributions" badge={statistics ? String(statistics.elementCount) : "missing"}>
        <FieldRow label="Scope" value="Shared-domain cross-reference, not Airbox-scoped" />
        <FieldRow label="Quality source" value={statistics?.qualitySource ?? "not published"} />
        <FieldRow label="Cross-reference elements" value={formatCount(statistics?.elementCount ?? null)} />
        {boundedItems(statistics?.metrics ?? []).map((metric) => (
          <FieldRow
            key={metric.id}
            label={metric.label}
            value={`min ${metric.min ?? "unknown"}; mean ${metric.mean ?? "unknown"}; Below target ${metric.belowThresholdCount ?? "unknown"}`}
          />
        ))}
        <FieldRow label="Element size distributions" value={statistics?.sizeDistributions.length ? "published summaries" : "not published"} />
        {boundedItems(statistics?.sizeDistributions ?? []).map((distribution) => (
          <FieldRow key={distribution.id} label={distribution.label} value={`min ${distribution.min ?? "unknown"}; mean ${distribution.mean ?? "unknown"}; max ${distribution.max ?? "unknown"}`} />
        ))}
        {boundedItems(statistics?.warnings ?? []).map((warning, index) => (
          <FieldRow key={index} label={`Warning ${index + 1}`} value={warning} />
        ))}
      </InspectorGroup>
    </div>
  );
}
