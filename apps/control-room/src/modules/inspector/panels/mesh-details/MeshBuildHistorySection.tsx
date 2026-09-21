import type {
  MeshBuildHistoryEntry,
  normalizeMeshBuildHistory,
} from "@/shared/domain/mesh/meshBuildHistory";

import { InspectorGroup } from "../../primitives/InspectorGroup";
import { formatCount } from "../MeshResourceView";
import { MeshBuildHistoryView } from "../MeshBuildHistoryView";

export function MeshBuildHistorySection({
  entries,
  onRestore,
}: {
  entries: ReturnType<typeof normalizeMeshBuildHistory>;
  onRestore?: (entry: MeshBuildHistoryEntry) => void;
}) {
  return (
    <InspectorGroup
      title="Build History Compare"
      badge={formatCount(entries.length)}
      collapsible
      defaultOpen={entries.length > 0}
    >
      <MeshBuildHistoryView entries={entries} onRestore={onRestore} />
    </InspectorGroup>
  );
}
