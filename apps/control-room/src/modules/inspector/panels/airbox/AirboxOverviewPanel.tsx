"use client";

import {
  useMeshBuildCurrent,
  useMeshSharedDomainManifestResource,
  useUniverseMeshPolicyResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { shouldLoadRuntimeMeshBuild } from "@/kernel/resources/studyRuntimeResources";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import { buildUniverseDomainPolicyPresentation } from "@/shared/domain/mesh/domainPresentation";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { AirboxFieldRow as FieldRow } from "./airboxDisplay";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { aggregateAirboxMeshParts, findCanonicalAirboxPart, findAirboxParts } from "./airboxMeshInspectorModel";
import {
  matchesAirboxTopologyIdentity,
  resolveAirboxInspectorLane,
  shouldLoadAirboxMeshManifest,
  useAirboxInspectorRuntimeStatus,
} from "./airboxInspectorRuntimeStatus";
import { navigateToAirboxRoute } from "./airboxNavigation";

function formatLengthVector(
  value: readonly [number, number, number] | null,
  source: "authored" | "invalid" | "not-authored" | "not-applicable",
): string {
  if (source === "invalid") return "invalid authored value";
  if (source === "not-authored" || source === "not-applicable" || !value) return "not authored";
  return value.map((component) => String(component)).join(", ");
}

function realizationLabel(state: string): string {
  switch (state) {
    case "runtime-unresolved": return "waiting for runtime resolution";
    case "loading": return "loading backend provenance";
    case "building": return "build in progress";
    case "not-built": return "not built";
    case "current": return "current";
    case "stale": return "stale";
    case "error": return "backend status error";
    default: return "provenance unavailable";
  }
}

export function AirboxOverviewPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const runtimeStatus = useAirboxInspectorRuntimeStatus();
  const runtimeLane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const runtimeResolved = runtimeLane === "fdm" || runtimeLane === "fem";
  const policy = useUniverseMeshPolicyResource();
  const manifest = useMeshSharedDomainManifestResource({
    enabled: shouldLoadAirboxMeshManifest(true, runtimeStatus),
  });
  const build = useMeshBuildCurrent({ enabled: shouldLoadRuntimeMeshBuild(true, runtimeStatus) });
  const scene = useSceneResource();
  const visualization = useVisualizationStateResource();
  const topologyMatches = matchesAirboxTopologyIdentity(runtimeStatus, manifest.data);
  const currentManifest = topologyMatches ? manifest.data : null;
  const airboxParts = findAirboxParts(currentManifest?.mesh_parts);
  const aggregate = aggregateAirboxMeshParts(airboxParts);
  const carrier = findCanonicalAirboxPart(currentManifest?.mesh_parts);
  const domainPolicy = buildUniverseDomainPolicyPresentation({
    build: build.data,
    buildStatus: build.status,
    manifest: currentManifest,
    manifestStatus: manifest.status,
    policy: policy.data,
    runtimeResolved,
    sceneRevision: scene.status === "ready" && !scene.error
      ? scene.data?.scene_revision ?? scene.data?.revision ?? null
      : null,
  });
  const modeValue = domainPolicy.authored.mode.value;
  const modeLabel = modeValue === "invalid"
    ? "invalid authored value"
    : modeValue === "auto"
      ? domainPolicy.authored.mode.source === "canonical-default"
        ? "Auto (canonical default)"
        : "Auto"
      : "Manual";
  const authoredSize = modeValue === "auto"
    ? "determined after geometry"
    : modeValue === "manual"
      ? formatLengthVector(domainPolicy.authored.size, domainPolicy.authored.sizeSource)
      : "unavailable until mode is corrected";
  const authoredCenter = modeValue === "auto"
    ? "determined after geometry"
    : modeValue === "manual"
      ? domainPolicy.authored.centerSource === "canonical-origin"
        ? "canonical origin (center omitted)"
        : domainPolicy.authored.centerSource === "invalid"
          ? "invalid authored value"
          : formatLengthVector(domainPolicy.authored.center, domainPolicy.authored.centerSource)
      : "unavailable until mode is corrected";
  const override = visualization.data?.overrides?.find(
    (candidate) =>
      candidate.scope === "airbox" || candidate.scope_id === "airbox",
  );

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group">
      <InspectorGroup title="Domain policy" badge={policy.status}>
        <FieldRow label="Canonical target" value="airbox" />
        <FieldRow label="Authored domain mode" value={modeLabel} />
        <FieldRow label="Authored size" value={authoredSize} unit={modeValue === "manual" ? "m" : undefined} />
        <FieldRow label="Authored padding" value={formatLengthVector(domainPolicy.authored.padding, domainPolicy.authored.paddingSource)} unit={domainPolicy.authored.padding ? "m" : undefined} />
        <FieldRow label="Authored center" value={authoredCenter} unit={modeValue === "manual" && domainPolicy.authored.center ? "m" : undefined} />
        <FieldRow label="Policy revision" value={String(policy.data?.revision ?? "unknown")} />
        <FieldRow label="Mesh realization" value={realizationLabel(domainPolicy.realization.state)} />
        <FieldRow label="Realization evidence" value={domainPolicy.realization.detail} />
        <FieldRow label="Realized policy revision" value={String(domainPolicy.realization.requestedPolicyRevision ?? "not published")} />
        <FieldRow label="Realized scene revision" value={String(domainPolicy.realization.sourceSceneRevision ?? "not published")} />
        <FieldRow label="Realized mesh revision" value={String(domainPolicy.realization.buildRevision ?? "not published")} />
        <FieldRow label="Mesh carrier" value={carrier?.id ?? "not available"} />
        <FieldRow label="Airbox carriers" value={aggregate.carrierCount.toLocaleString("en-US")} />
        <FieldRow label="Nodes (unique across carriers)" value={aggregate.nodeCount?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Elements (all carriers)" value={aggregate.elementCount?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Boundary faces (all carriers)" value={aggregate.boundaryFaceCount?.toLocaleString("en-US") ?? "not available"} />
        <FieldRow label="Node-count source" value={aggregate.nodeCountExact ? "deduplicated published carrier coverage" : "not fully published"} />
        <FieldRow label="Active quantity" value={visualization.data?.active_quantity_id ?? "not available"} />
        <FieldRow label="Manifest state" value={manifest.status === "ready" && !topologyMatches ? "stale identity" : manifest.status} />
        <FieldRow label="Visualization state" value={visualization.status} />
        <FieldRow
          label="Visible override"
          value={
            (override?.display?.visible ?? override?.visible) == null
              ? "inherited"
              : (override?.display?.visible ?? override?.visible)
                ? "visible"
                : "hidden"
          }
        />
        <div className="fm-inspector-toolbar" aria-label="Airbox navigation">
          <Button size="sm" type="button" variant="secondary" onClick={() => navigateToAirboxRoute(kernel.selection, "meshParameters")}>
            Mesh Parameters
          </Button>
          <Button size="sm" type="button" variant="secondary" onClick={() => navigateToAirboxRoute(kernel.selection, "meshBuild")}>
            Mesh Build
          </Button>
          <Button size="sm" type="button" variant="secondary" onClick={() => navigateToAirboxRoute(kernel.selection, "visualization")}>
            Visualization
          </Button>
        </div>
      </InspectorGroup>
    </div>
  );
}
