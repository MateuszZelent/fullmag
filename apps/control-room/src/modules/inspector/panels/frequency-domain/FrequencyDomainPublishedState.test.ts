import { describe, expect, it } from "vitest";

import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";

import { frequencyDomainPublishedState } from "./FrequencyDomainPublishedState";

function artifact(
  overrides: Partial<FrequencyDomainJsonArtifactResource> = {},
): FrequencyDomainJsonArtifactResource {
  return {
    artifact_path: "fmr/peaks.v1.json",
    payload: null,
    resource_key: "analysis/frequency-domain/fmr/peaks",
    schema_version: "fmr/peaks.v1",
    status: "ready",
    ...overrides,
  };
}

describe("frequencyDomainPublishedState", () => {
  it("separates resource, artifact, qualification, and binding state", () => {
    expect(
      frequencyDomainPublishedState({
        data: artifact({ status: "partial" }),
        publishedRevision: "peaks:2",
        resourceStatus: "stale",
        selectedResourceKey: "analysis/frequency-domain/fmr/peaks",
        selectedRevision: "peaks:2",
        runId: "run-7",
        stageId: "stage-3",
      }),
    ).toEqual({
      artifact: "partial",
      binding: "compatible",
      qualification: "unknown",
      resource: "stale",
      retainedLastValid: false,
      source: {
        artifactPath: "fmr/peaks.v1.json",
        backend: null,
        contentDigest: null,
        device: null,
        precision: null,
        provenance: null,
        resourceKey: "analysis/frequency-domain/fmr/peaks",
        runId: "run-7",
        schemaVersion: "fmr/peaks.v1",
        stageId: "stage-3",
      },
    });
  });

  it("keeps last-valid data visible when refresh ends in an error", () => {
    expect(
      frequencyDomainPublishedState({
        data: artifact(),
        publishedRevision: "peaks:2",
        resourceStatus: "error",
        runId: "run-7",
        stageId: "stage-3",
      }).retainedLastValid,
    ).toBe(true);
  });

  it("marks a resource or revision mismatch incompatible", () => {
    expect(
      frequencyDomainPublishedState({
        data: artifact(),
        publishedRevision: "peaks:2",
        resourceStatus: "ready",
        selectedResourceKey: "analysis/frequency-domain/fmr/peaks",
        selectedRevision: "peaks:1",
      }).binding,
    ).toBe("incompatible");
  });

  it.each([
    {
      label: "missing loaded data",
      input: {
        data: null,
        publishedRevision: null,
        resourceStatus: "ready" as const,
        selectedResourceKey: "analysis/frequency-domain/fmr/peaks",
      },
      expected: "unbound",
    },
    {
      label: "missing published revision",
      input: {
        data: artifact(),
        publishedRevision: null,
        resourceStatus: "ready" as const,
        selectedRevision: "peaks:2",
      },
      expected: "incompatible",
    },
    {
      label: "missing published revision for a selected resource",
      input: {
        data: artifact(),
        publishedRevision: null,
        resourceStatus: "ready" as const,
        selectedResourceKey: "analysis/frequency-domain/fmr/peaks",
      },
      expected: "incompatible",
    },
    {
      label: "wrong resource key",
      input: {
        data: artifact(),
        publishedRevision: "peaks:2",
        resourceStatus: "ready" as const,
        selectedResourceKey: "analysis/frequency-domain/fmr/other",
      },
      expected: "incompatible",
    },
  ])("fails closed for $label", ({ expected, input }) => {
    expect(frequencyDomainPublishedState(input).binding).toBe(expected);
  });

  it("does not classify an unknown top-level artifact status as complete", () => {
    expect(
      frequencyDomainPublishedState({
        data: artifact({ status: "mystery" }),
        publishedRevision: "peaks:2",
        resourceStatus: "ready",
      }).artifact,
    ).toBe("unknown");
  });

  it.each(["partial", "corrupt", "missing", "interrupted", "mystery"])(
    "does not retain an unverified %s artifact during refresh errors",
    (status) => {
      expect(
        frequencyDomainPublishedState({
          data: artifact({ status }),
          publishedRevision: "peaks:2",
          resourceStatus: "error",
        }).retainedLastValid,
      ).toBe(false);
    },
  );

  it("preserves all typed source identity fields and leaves unavailable execution provenance unknown", () => {
    expect(
      frequencyDomainPublishedState({
        data: artifact({ content_digest: "sha256:abc" }),
        publishedRevision: "peaks:2",
        resourceStatus: "ready",
        runId: "run-7",
        stageId: "stage-3",
      }).source,
    ).toEqual({
      artifactPath: "fmr/peaks.v1.json",
      backend: null,
      contentDigest: "sha256:abc",
      device: null,
      precision: null,
      provenance: null,
      resourceKey: "analysis/frequency-domain/fmr/peaks",
      runId: "run-7",
      schemaVersion: "fmr/peaks.v1",
      stageId: "stage-3",
    });
  });
});
