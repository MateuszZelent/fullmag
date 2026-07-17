"use client";

import {
  useMeshBuildCurrent,
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useMeshUniverseReportResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { shouldLoadRuntimeMeshBuild, shouldLoadRuntimeMeshManifest, shouldLoadRuntimeMeshSummary } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { findCanonicalAirboxPart } from "./airboxMeshInspectorModel";
import { useAirboxInspectorRuntimeStatus } from "./airboxInspectorRuntimeStatus";

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
    enabled: shouldLoadRuntimeMeshManifest(true, runtimeStatus),
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
  const resource = policy.data ?? { config: null, effective_config: null, revision: 0 };
  const carrier = findCanonicalAirboxPart(manifest.data?.mesh_parts);
  const stale =
    manifest.data != null && manifest.data.revision < resource.revision;

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-[var(--fm-inspector-group-gap)]">
      <InspectorGroup title="Airbox Mesh Overview" badge={stale ? "stale" : manifest.status}>
        <FieldRow label="Policy revision" value={String(resource.revision)} />
        <FieldRow label="Manifest revision" value={String(manifest.data?.revision ?? "unknown")} />
        <FieldRow
          label="Mesh evidence"
          value={stale ? "Manifest is older than the authored policy." : manifest.data ? "Manifest is available." : "Manifest is not available."}
        />
        <FieldRow label="Carrier" value={carrier?.id ?? "not available"} />
        <FieldRow label="Effective maximum element size" value={targetValue(current.data?.effective_airbox_target, ["hmax", "maximum_element_size"])} unit="m" />
        <FieldRow label="Effective minimum element size" value={targetValue(current.data?.effective_airbox_target, ["hmin", "minimum_element_size"])} unit="m" />
        <FieldRow label="Effective growth rate" value={targetValue(current.data?.effective_airbox_target, ["growth_rate"])} />
        <FieldRow label="Last build" value={current.data?.last_build_error ? `failed — ${current.data.last_build_error}` : current.data ? "available" : "not available"} />
        <FieldRow label="Last build summary" value={summaryStatus(current.data?.last_build_summary)} />
        <FieldRow label="Parameters status" value={policy.status} />
        <FieldRow label="Quality Gates status" value={quality.status} />
        <FieldRow label="Statistics status" value={`quality ${quality.status}; report ${report.status}`} />
        <FieldRow label="Topology status" value={manifest.status} />
        <FieldRow label="Build status" value={current.status} />
      </InspectorGroup>
    </div>
  );
}
