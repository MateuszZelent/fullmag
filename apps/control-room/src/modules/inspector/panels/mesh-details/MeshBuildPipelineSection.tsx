import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { formatValue, MeshResourceFields } from "../MeshResourceView";
import type { RetainedMeshArtifactPresentation } from "./useMeshDetailsModel";

function retainedArtifactLabel(
  artifact: RetainedMeshArtifactPresentation,
): string {
  return (
    artifact.meshName ??
    artifact.meshId ??
    artifact.generationId ??
    "published mesh"
  );
}

export function MeshBuildPipelineSection({
  activeBuildStatus,
  buildMode,
  buildStatus,
  fallbacks,
  lastBuildError,
  latestSuccessAvailable,
  retainedArtifact,
  sharedDomainBuildDisabledReason,
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
  retainedArtifact: RetainedMeshArtifactPresentation | null;
  sharedDomainBuildDisabledReason: string | null;
  onBuildSharedDomain: () => void;
  onOpenBuildDetails: () => void;
  sizeFieldKinds: readonly string[] | null | undefined;
}) {
  return (
    <InspectorGroup
      title="Build Pipeline"
      badge={activeBuildStatus}
      collapsible
      defaultOpen
    >
      {retainedArtifact?.state === "retained" ? (
        <FeedbackBanner
          kind="warning"
          message={`The latest mesh build failed. The candidate was not promoted; the workspace continues to use ${retainedArtifactLabel(retainedArtifact)} at mesh revision ${retainedArtifact.meshRevision ?? "unknown"}, sourced from scene revision ${retainedArtifact.sourceSceneRevision ?? "unknown"}.`}
        />
      ) : retainedArtifact?.state === "identity-unavailable" ? (
        <FeedbackBanner
          kind="warning"
          message="The latest mesh build failed and a previous success is recorded, but the published mesh identity is incomplete. Refresh mesh resources before relying on rollback state."
        />
      ) : null}
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
            label: "Retained after failure",
            value:
              retainedArtifact?.state === "retained"
                ? "yes — published artifact unchanged"
                : retainedArtifact?.state === "identity-unavailable"
                  ? "identity unavailable"
                  : "not applicable",
          },
          {
            label: "Retained mesh identity",
            value: retainedArtifact
              ? retainedArtifactLabel(retainedArtifact)
              : "none",
          },
          {
            label: "Retained build id",
            value: retainedArtifact?.buildId ?? "unknown",
          },
          {
            label: "Retained generation",
            value: retainedArtifact?.generationId ?? "unknown",
          },
          {
            label: "Build mode",
            value: formatValue(buildMode ?? "unknown"),
          },
          {
            label: "Fallbacks",
            value:
              fallbacks == null
                ? "not published"
                : fallbacks.length
                  ? fallbacks.join(", ")
                  : "none (strict)",
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
          disabled={sharedDomainBuildDisabledReason !== null}
          aria-label={
            sharedDomainBuildDisabledReason === null
              ? "Build Shared-Domain Mesh"
              : `Build Shared-Domain Mesh: ${sharedDomainBuildDisabledReason}`
          }
          title={sharedDomainBuildDisabledReason ?? "Build Shared-Domain Mesh"}
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
    </InspectorGroup>
  );
}
