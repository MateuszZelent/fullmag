import type { ResourceRevision } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

export interface Viewport3DResourceFrameState {
  error?: string | null;
  id: string;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export function buildViewport3DResourceFrameKey(
  resources: readonly Viewport3DResourceFrameState[],
): string {
  return resources
    .map((resource) =>
      [
        resource.id,
        resource.status,
        resource.revision ?? "none",
        resource.error ?? "",
      ].join(":"),
    )
    .join("|");
}
