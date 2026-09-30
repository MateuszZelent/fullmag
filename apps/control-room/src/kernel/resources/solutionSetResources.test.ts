import { describe, expect, it } from "vitest";

import {
  assertSolutionSetLogicalId,
  assertSolutionSetMemberId,
  assertSolutionSetProjectId,
  assertSolutionSetRevision,
  assertSolutionSetRunId,
} from "../api/ControlRoomApi";
import type {
  SolutionSetArtifactPageResource,
  SolutionSetResource,
} from "../api/apiTypes";

import {
  SOLUTION_SET_SCHEMA_VERSION,
  solutionSetArtifactsResourceKey,
  solutionSetMembersResourceKey,
  solutionSetResourceKey,
  validateSolutionSetEnvelope,
} from "./solutionSetResources";

describe("durable SolutionSet resource identity", () => {
  it("keeps the exact decimal revision in every project-scoped cache key", () => {
    const revision = "9007199254740993";

    const rootKey = solutionSetResourceKey("project-a", "run-a", "set/a", revision);
    expect(rootKey).toBe(
      "solution-set:project-a:run-a:set%2Fa:9007199254740993",
    );
    expect(solutionSetResourceKey("project-b", "run-a", "set/a", revision)).not.toBe(
      rootKey,
    );
    expect(solutionSetResourceKey("project-a", "run-b", "set/a", revision)).not.toBe(
      rootKey,
    );
    expect(solutionSetResourceKey("project-a", "run-a", "set/b", revision)).not.toBe(
      rootKey,
    );
    expect(solutionSetResourceKey("project-a", "run-a", "set/a", "1")).not.toBe(
      rootKey,
    );
    expect(
      solutionSetResourceKey("projekt-a", "run-a", "solution/żółć", revision),
    ).toContain("solution%2F%C5%BC%C3%B3%C5%82%C4%87");
    const memberKey =
      solutionSetMembersResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        { after_member_id: "member/a", limit: 100 },
      );
    expect(memberKey).toContain(":members:limit=100&after=member%2Fa");
    expect(
      solutionSetMembersResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        { after_member_id: "member/a", limit: 50 },
      ),
    ).not.toBe(memberKey);
    const artifactKey =
      solutionSetArtifactsResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        "member/a",
        { after_artifact_id: "artifact/a", limit: 50 },
      );
    expect(artifactKey).toContain(":member:member%2Fa:artifacts:limit=50&after=artifact%2Fa");
    expect(
      solutionSetArtifactsResourceKey(
        "project-a",
        "run-a",
        "set/a",
        revision,
        "member/b",
        { after_artifact_id: "artifact/a", limit: 50 },
      ),
    ).not.toBe(artifactKey);
  });

  it("rejects revision precision loss and unsafe path identifiers locally", () => {
    expect(assertSolutionSetRevision("1")).toBe("1");
    expect(assertSolutionSetRevision("18446744073709551615")).toBe(
      "18446744073709551615",
    );
    expect(() => assertSolutionSetRevision("0")).toThrow();
    expect(() => assertSolutionSetRevision("01")).toThrow();
    expect(() => assertSolutionSetRevision("18446744073709551616")).toThrow();
    expect(assertSolutionSetLogicalId("solution/żółć")).toBe("solution/żółć");
    expect(assertSolutionSetMemberId("member id", "member/żółć")).toBe(
      "member/żółć",
    );
    expect(() => assertSolutionSetLogicalId(`solution${"ż".repeat(600)}`)).toThrow();
    expect(() => assertSolutionSetMemberId("member id", "member\u0001")).toThrow();
    expect(() => assertSolutionSetProjectId("project/a")).toThrow();
    expect(() => assertSolutionSetRunId("run/a")).toThrow();
  });

  it("fails closed on schema, digest, and pinned owner mismatches", () => {
    const identity = {
      projectId: "project",
      revision: "9007199254740993",
      runId: "run",
      solutionSetId: "set",
    };
    const base = {
      artifact_count: 0,
      coverage_count: 0,
      execution_status: "succeeded",
      manifest_digest: `sha256:${"a".repeat(64)}`,
      manifest_state: "closed",
      member_count: 0,
      project_id: identity.projectId,
      provenance: {
        acquisition_digest: "sha256:acquisition",
        discretization_digest: "sha256:discretization",
        model_digest: "sha256:model",
        physics_digest: "sha256:physics",
        resolved_plan_digest: "sha256:plan",
        run_spec_digest: "sha256:run-spec",
        seed_digest: null,
      },
      revision: identity.revision,
      run_id: identity.runId,
      schema_version: SOLUTION_SET_SCHEMA_VERSION,
      scientific_assessment: {
        evidence_artifact_count: 0,
        reason: null,
        status: "unassessed",
      },
      solution_set_id: identity.solutionSetId,
    } as SolutionSetResource;

    expect(validateSolutionSetEnvelope(base, identity)).toBe(base);
    expect(() =>
      validateSolutionSetEnvelope(
        { ...base, schema_version: "wrong.schema" },
        identity,
      ),
    ).toThrow();
    expect(() =>
      validateSolutionSetEnvelope(
        { ...base, manifest_digest: "sha256:short" },
        identity,
      ),
    ).toThrow();

    const page = {
      ...base,
      items: [],
      member_id: "member",
      next_after_artifact_id: null,
    } as SolutionSetArtifactPageResource;
    expect(
      validateSolutionSetEnvelope(page, { ...identity, memberId: "member" }),
    ).toBe(page);
    expect(() =>
      validateSolutionSetEnvelope(page, { ...identity, memberId: "other" }),
    ).toThrow();
  });
});
