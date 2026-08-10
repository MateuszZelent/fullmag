import type {
  MeshSharedDomainManifestResource,
  MeshSummaryResource,
  MeshUniverseConfigResource,
  ResourceRevision,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { ResourceState } from "@/kernel/resources/resourceState";
import { isVisualizationAirboxIdentity } from "@/kernel/selection/selectionTypes";

export interface FemAirboxEvidenceResources {
  currentMeshRevision: ResourceRevision | null;
  manifest: Pick<ResourceState<MeshSharedDomainManifestResource>, "data" | "status">;
  policy: Pick<ResourceState<MeshUniverseConfigResource>, "data" | "status">;
  scene: Pick<ResourceState<SceneResource>, "data" | "status">;
  summary: Pick<ResourceState<MeshSummaryResource>, "data" | "status">;
}

export interface FemAirboxEvidence {
  authoredPolicy: boolean;
  realizedCarrier: boolean;
  resolvedTarget: boolean;
}

export function resolveCurrentFemAirboxEvidence(
  resources: FemAirboxEvidenceResources,
): FemAirboxEvidence {
  const sceneRevision =
    resources.scene.data?.revision ?? resources.scene.data?.scene_revision ?? null;
  const sceneIsCurrent =
    resources.scene.status === "ready" && sceneRevision !== null;
  const matchesCurrentMesh = (revision: ResourceRevision | null | undefined) =>
    resources.currentMeshRevision !== null &&
    revision !== null &&
    revision !== undefined &&
    String(revision) === String(resources.currentMeshRevision);
  const policyIsCurrent =
    sceneIsCurrent &&
    resources.policy.status === "ready" &&
    matchesCurrentMesh(resources.policy.data?.revision);
  const summaryIsCurrent =
    sceneIsCurrent &&
    resources.summary.status === "ready" &&
    matchesCurrentMesh(resources.summary.data?.revision);
  const manifestIsCurrent =
    sceneIsCurrent &&
    resources.manifest.status === "ready" &&
    matchesCurrentMesh(resources.manifest.data?.revision) &&
    resources.manifest.data?.source_scene_revision !== null &&
    resources.manifest.data?.source_scene_revision !== undefined &&
    String(resources.manifest.data.source_scene_revision) === String(sceneRevision);

  return {
    authoredPolicy: policyIsCurrent && resources.policy.data?.config != null,
    realizedCarrier:
      manifestIsCurrent &&
      Boolean(
        resources.manifest.data?.mesh_parts?.some((part) =>
          isVisualizationAirboxIdentity(part),
        ),
      ),
    resolvedTarget:
      summaryIsCurrent && resources.summary.data?.effective_airbox_target != null,
  };
}
