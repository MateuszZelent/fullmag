import { Button } from "@/shared/ui/Button";

import { InspectorSection } from "../../primitives/InspectorSection";
import { formatValue, MeshResourceFields } from "../MeshResourceView";

export function MeshBuildPipelineSection({
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
