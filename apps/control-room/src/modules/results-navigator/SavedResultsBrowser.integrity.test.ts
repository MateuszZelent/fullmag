import type {
  MaterializedDatasetResource,
  SolutionSetArtifactResource,
} from "@/kernel/api/apiTypes";

import {
  isMaterializedDatasetArtifact,
  materializedDatasetMatchesArtifact,
} from "./SavedResultsBrowser";

const artifact = {
  artifact_id: "materialized-dataset-a",
  byte_length: "128",
  kind: "other",
  object_ref: "a".repeat(64),
  schema_id: "fullmag.materialized_dataset.v1",
} as SolutionSetArtifactResource;

const data = {
  artifact_id: artifact.artifact_id,
  manifest_byte_length: artifact.byte_length,
  manifest_object_ref: artifact.object_ref,
} as MaterializedDatasetResource;

describe("saved materialized dataset artifact binding", () => {
  it("accepts only the materialized schema with the durable other-artifact kind", () => {
    expect(isMaterializedDatasetArtifact(artifact)).toBe(true);
    expect(
      isMaterializedDatasetArtifact({
        ...artifact,
        kind: "modal",
      }),
    ).toBe(false);
    expect(
      isMaterializedDatasetArtifact({
        ...artifact,
        schema_id: "fullmag.other.v1",
      }),
    ).toBe(false);
  });

  it("requires the selected page object and byte identity before inspection", () => {
    expect(materializedDatasetMatchesArtifact(data, artifact)).toBe(true);
    expect(
      materializedDatasetMatchesArtifact(data, {
        ...artifact,
        object_ref: "b".repeat(64),
      }),
    ).toBe(false);
    expect(
      materializedDatasetMatchesArtifact(data, {
        ...artifact,
        byte_length: "129",
      }),
    ).toBe(false);
    expect(materializedDatasetMatchesArtifact(data, null)).toBe(false);
  });
});
