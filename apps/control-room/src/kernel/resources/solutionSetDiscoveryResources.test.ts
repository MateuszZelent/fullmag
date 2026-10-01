import { describe, expect, it } from "vitest";

import type { SolutionSetDiscoveryPageResource } from "../api/apiTypes";
import {
  solutionSetDiscoveryResourceKey,
  validateSolutionSetDiscoveryEnvelope,
} from "./solutionSetResources";

function page(): SolutionSetDiscoveryPageResource {
  return {
    schema_version: "fullmag.analysis.solution_set_discovery.v1",
    project_id: "project-a",
    run_id: "run-a",
    items: [{
      solution_set_id: "solution/żółć",
      revision: "9007199254740993",
      manifest_digest: `sha256:${"a".repeat(64)}`,
    }],
    next_cursor: "opaque_next_page",
  };
}

describe("project-owned SolutionSet discovery", () => {
  it("keeps an empty scan page navigable and preserves exact u64 references", () => {
    const data = page();
    expect(validateSolutionSetDiscoveryEnvelope(data, "project-a", "run-a")).toBe(data);
    data.items = [];
    expect(validateSolutionSetDiscoveryEnvelope(data, "project-a", "run-a").next_cursor)
      .toBe("opaque_next_page");
  });

  it("rejects scope, duplicate identity, malformed revision and stalled cursor", () => {
    expect(() => validateSolutionSetDiscoveryEnvelope(page(), "project-b", "run-a")).toThrow();
    expect(() => validateSolutionSetDiscoveryEnvelope(page(), "project-a", "run-b")).toThrow();
    const duplicate = page();
    duplicate.items.push({ ...duplicate.items[0]! });
    expect(() => validateSolutionSetDiscoveryEnvelope(duplicate, "project-a", "run-a")).toThrow();
    const malformed = page();
    malformed.items[0]!.revision = "01";
    expect(() => validateSolutionSetDiscoveryEnvelope(malformed, "project-a", "run-a")).toThrow();
    expect(() => validateSolutionSetDiscoveryEnvelope(page(), "project-a", "run-a", {
      cursor: "opaque_next_page",
    })).toThrow();
  });

  it("separates project, run, cursor and page size in cache identity", () => {
    const key = solutionSetDiscoveryResourceKey("project-a", "run-a");
    expect(solutionSetDiscoveryResourceKey("project-b", "run-a")).not.toBe(key);
    expect(solutionSetDiscoveryResourceKey("project-a", "run-b")).not.toBe(key);
    expect(solutionSetDiscoveryResourceKey("project-a", "run-a", { cursor: "next" })).not.toBe(key);
    expect(solutionSetDiscoveryResourceKey("project-a", "run-a", { limit: 50 })).not.toBe(key);
  });
});
