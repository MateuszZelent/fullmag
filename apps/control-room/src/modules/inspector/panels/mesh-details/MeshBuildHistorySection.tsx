import type { normalizeMeshBuildHistory } from "@/shared/domain/mesh/meshBuildHistory";

import { InspectorSection } from "../../primitives/InspectorSection";
import { formatCount } from "../MeshResourceView";
import { MeshBuildHistoryView } from "../MeshBuildHistoryView";

export function MeshBuildHistorySection({
  entries,
}: {
  entries: ReturnType<typeof normalizeMeshBuildHistory>;
}) {
  return (
    <InspectorSection
      value="build-history"
      title="Build History Compare"
      badge={formatCount(entries.length)}
      collapsible
      defaultCollapsed={entries.length === 0}
    >
      <MeshBuildHistoryView entries={entries} />
    </InspectorSection>
  );
}
