"use client";

import {
  useMeshSharedDomainManifestResource,
  useMeshUniverseQualityResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import {
  shouldLoadRuntimeMeshSummary,
} from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  buildAirboxMeshInspectorModel,
  currentAirboxQualityEvidence,
  matchesCurrentAirboxMeshRevision,
} from "./airboxMeshInspectorModel";
import {
  matchesAirboxTopologyIdentity,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";

export function AirboxMeshQualityGatesPanel({ selection }: InspectorPanelProps) {
  void selection;
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const quality = useMeshUniverseQualityResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const scene = useSceneResource({
    enabled: shouldLoadRuntimeMeshSummary(true, runtimeStatus),
  });
  const topologyIdentityMatches = matchesAirboxTopologyIdentity(runtimeStatus, manifest.data);
  const topologyMatches = manifest.status === "ready" && topologyIdentityMatches;
  const currentMeshRevision = runtimeStatus?.resources.mesh_revision ?? null;
  const qualityRevisionMatches = matchesCurrentAirboxMeshRevision(
    quality.data?.revision,
    currentMeshRevision,
  );
  const qualityEvidence = currentAirboxQualityEvidence(
    quality,
    topologyMatches,
    currentMeshRevision,
  );
  const model = buildAirboxMeshInspectorModel({
    currentSceneRevision: scene.status === "ready" && !scene.error
      ? scene.data?.scene_revision ?? scene.data?.revision ?? null
      : null,
    manifest: topologyMatches ? manifest.data : null,
    policy: { config: null, effective_config: null, revision: quality.data?.revision ?? 0 },
    quality: qualityEvidence,
    report: null,
    summary: null,
  });
  const qualityReason = !topologyIdentityMatches
    ? manifest.status === "loading"
      ? "Checking published Airbox topology identity."
      : "Quality gates require a matching published Airbox topology identity."
    : manifest.status !== "ready"
      ? `Cached Airbox topology resource is ${manifest.status}; gate status is unknown until refreshed.`
    : quality.status === "error" || quality.error || quality.refreshError
      ? "Airbox quality resource failed to load; gate status is unknown."
    : quality.status === "loading"
      ? "Airbox quality resource is loading; gate status is pending."
      : quality.status === "stale"
        ? "Cached Airbox quality resource is stale; gate status is unknown until refreshed."
        : quality.status === "ready" && !qualityRevisionMatches
            ? "Airbox quality revision does not match the current mesh revision; gate status is unknown."
          : model.qualityGates.reason;

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Airbox Quality Gates" badge={model.qualityGates.status}>
        <FieldRow label="Airbox-scoped result" value={model.qualityGates.status} />
        <FieldRow label="Reason" value={qualityEvidence ? model.qualityGates.reason : qualityReason} />
        <FieldRow label="Evidence" value={model.qualityGates.evidence} />
        <FieldRow label="Scope" value={model.qualityGates.scope ?? "not published"} />
        <FieldRow label="Marker" value={String(model.qualityGates.marker ?? "not published")} />
        <FieldRow label="Source" value={model.qualityGates.source ?? "not published"} />
        <FieldRow label="Quality resource" value={quality.refreshError ? "refresh error" : quality.error ? "error" : qualityEvidence ? quality.status : quality.status === "ready" && !qualityRevisionMatches ? "mesh revision mismatch" : quality.status} />
        {model.qualityGates.checks.map((check) => (
          <FieldRow
            key={check.id}
            label={check.id}
            value={`${check.status}; value ${check.value ?? "unknown"}${check.unit ? ` ${check.unit}` : ""}; ${check.comparison ?? "comparison not published"} ${check.threshold ?? "unknown"}${check.unit ? ` ${check.unit}` : ""}`}
          />
        ))}
        {!model.qualityGates.checks.length ? (
          <FieldRow label="Checks" value="No individual backend checks are published." />
        ) : null}
        <FieldRow label="Topology identity" value={topologyIdentityMatches ? manifest.status === "ready" ? "matches current FEM generation" : `cached identity; resource ${manifest.status}` : manifest.status === "loading" ? "checking published topology identity" : "not verified"} />
      </InspectorGroup>
      <InspectorGroup title="Structural Checks" badge="ui-derived">
        <FieldRow label="Evidence" value="ui-derived" />
        <FieldRow label="Scope" value="Structural availability only; not an Airbox quality pass/fail." />
      </InspectorGroup>
    </div>
  );
}
