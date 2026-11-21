import type { SolutionSetArtifactResource } from "@/kernel/api/apiTypes";

const MATERIALIZED_DATASET_SCHEMA = "fullmag.materialized_dataset.v1";

export function isMaterializedDatasetArtifact(
  artifact: SolutionSetArtifactResource,
): boolean {
  return artifact.schema_id === MATERIALIZED_DATASET_SCHEMA && artifact.kind === "other";
}
