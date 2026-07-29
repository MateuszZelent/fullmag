"use client";

import {
  useMeshBuildCurrent,
  useMeshBuildLatestSuccessful,
  useMeshUniverseReportResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshBuild } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";
import { buildAirboxMeshBuildModel } from "./airboxMeshInspectorModel";

export function AirboxMeshBuildPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const buildEnabled = shouldLoadRuntimeMeshBuild(true, runtimeStatus);
  const report = useMeshUniverseReportResource({ enabled: buildEnabled });
  const current = useMeshBuildCurrent({ enabled: buildEnabled });
  const latest = useMeshBuildLatestSuccessful({ enabled: buildEnabled });
  const lifecycle = buildAirboxMeshBuildModel({
    current: current.data ?? null,
    latest: latest.data ?? null,
    report: report.data ?? null,
  });

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Airbox Mesh Build" badge={lifecycle.status}>
        <FieldRow label="Lifecycle" value={lifecycle.status} />
        <FieldRow label="Reason" value={lifecycle.reason} />
        <FieldRow label="Build mode" value={lifecycle.buildMode ?? "not published"} />
        <FieldRow label="Current build revision" value={String(current.data?.revision ?? "unknown")} />
        <FieldRow label="Source scene revision" value={String(lifecycle.sourceSceneRevision ?? "unknown")} />
        <FieldRow label="Latest successful revision" value={String(lifecycle.latestSuccess.revision ?? "unknown")} />
        <FieldRow label="Universe report revision" value={String(report.data?.revision ?? "unknown")} />
        <FieldRow
          label="Fallbacks"
          value={
            !lifecycle.fallbacksPublished
              ? "not published"
              : lifecycle.fallbacks.length
                ? lifecycle.fallbacks.join(", ")
                : "none (strict)"
          }
        />
      </InspectorGroup>
      <InspectorGroup title="Build Provenance" badge={lifecycle.provenance.buildId ?? "not published"}>
        <FieldRow label="Build id" value={lifecycle.provenance.buildId ?? "not published"} />
        <FieldRow label="Command id" value={lifecycle.provenance.commandId ?? "not published"} />
        <FieldRow label="Completed at (Unix ms)" value={String(lifecycle.provenance.completedAtUnixMs ?? "not published")} />
        <FieldRow label="Duration" value={String(lifecycle.provenance.durationMs ?? "not published")} unit={lifecycle.provenance.durationMs == null ? undefined : "ms"} />
        <FieldRow label="Requested policy revision" value={String(lifecycle.provenance.requestedPolicyRevision ?? "not published")} />
        <FieldRow label="Geometry realization revision" value={String(lifecycle.provenance.geometryRealizationRevision ?? "not published")} />
        <FieldRow label="Provenance mesh revision" value={String(lifecycle.provenance.meshRevision ?? "not published")} />
        <FieldRow label="Provenance source scene revision" value={String(lifecycle.provenance.sourceSceneRevision ?? "not published")} />
      </InspectorGroup>
      <InspectorGroup title="Latest Successful Build" badge={String(lifecycle.latestSuccess.revision ?? "missing")}>
        <FieldRow label="Latest geometry realization revision" value={String(lifecycle.latestSuccess.geometryRealizationRevision ?? "not published")} />
        <FieldRow label="Latest source scene revision" value={String(lifecycle.latestSuccess.sourceSceneRevision ?? "not published")} />
        <FieldRow label="Latest build error" value={lifecycle.latestSuccess.lastBuildError ?? "none published"} />
      </InspectorGroup>
      <InspectorGroup title="Build Pipeline" badge={String(lifecycle.phases.length)}>
        {lifecycle.phases.length ? lifecycle.phases.map((phase, index) => (
          <FieldRow
            key={phase.id ?? index}
            label={phase.label ?? phase.id ?? `Phase ${index + 1}`}
            value={`${phase.status ?? "unknown"}${phase.detail ? ` — ${phase.detail}` : ""}`}
          />
        )) : <FieldRow label="Pipeline" value="not published" />}
      </InspectorGroup>
      <InspectorGroup title="Operation Statuses" badge={String(lifecycle.operationStatuses.length)}>
        {lifecycle.operationStatuses.length ? lifecycle.operationStatuses.map((operation, index) => (
          <FieldRow
            key={`${operation.scope}:${operation.kind}:${index}`}
            label={`${operation.scope} / ${operation.kind}`}
            value={`${operation.status}${operation.reason ? ` — ${operation.reason}` : ""}`}
          />
        )) : <FieldRow label="Operations" value="not published" />}
      </InspectorGroup>
      <InspectorGroup title="Published Build Resources" badge={lifecycle.publishedResources ? "published" : "missing"}>
        <FieldRow label="Manifest" value={lifecycle.publishedResources?.manifest ?? "not published"} />
        <FieldRow label="Quality" value={lifecycle.publishedResources?.quality ?? "not published"} />
        <FieldRow label="Realized size fields" value={lifecycle.publishedResources?.realized_size_fields ?? "not published"} />
        <FieldRow label="Mesh build revision" value={String(lifecycle.publishedResources?.mesh_build_revision ?? "not published")} />
        <FieldRow label="Mesh revision" value={String(lifecycle.publishedResources?.mesh_revision ?? "not published")} />
      </InspectorGroup>
      <InspectorGroup title="Bounded Build Details" badge={lifecycle.rawDetails.truncated ? "truncated" : "bounded"} collapsible defaultOpen={false}>
        <pre className="fm-mesh-json-preview">{lifecycle.rawDetails.serialized}</pre>
      </InspectorGroup>
    </div>
  );
}
