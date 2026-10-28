import type {
  MaterializedDatasetResource,
  SolutionSetArtifactResource,
} from "@/kernel/api/apiTypes";

export function materializedDatasetMatchesArtifact(
  data: MaterializedDatasetResource | null,
  artifact: SolutionSetArtifactResource | null,
): boolean {
  return Boolean(
    data &&
      artifact &&
      data.artifact_id === artifact.artifact_id &&
      data.manifest_object_ref === artifact.object_ref &&
      data.manifest_byte_length === artifact.byte_length,
  );
}

export function materializedDatasetMatchesPath(
  data: MaterializedDatasetResource | null,
  projectId: string,
  runId: string,
  solutionSetId: string,
  revision: string,
  memberId: string,
  artifactId: string | null,
): boolean {
  return Boolean(
    data &&
      artifactId &&
      data.project_id === projectId &&
      data.run_id === runId &&
      data.solution_set_id === solutionSetId &&
      data.containing_solution_revision === revision &&
      data.member_id === memberId &&
      data.artifact_id === artifactId,
  );
}
