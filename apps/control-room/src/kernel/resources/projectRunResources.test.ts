import { describe, expect, it } from "vitest";

import type { ProjectRunListResource, ProjectRunResource } from "../api/apiTypes";
import { validateProjectRunEnvelope, validateProjectRunsEnvelope } from "./projectRunResources";

describe("saved project run ownership", () => {
  it("rejects a stalled or malformed run cursor", () => {
    const page: ProjectRunListResource = { project_id: "project-a", runs: [], next_cursor: "run-a" };
    expect(validateProjectRunsEnvelope(page, "project-a")).toBe(page);
    expect(() => validateProjectRunsEnvelope(page, "project-a", "run-a")).toThrow();
    expect(() => validateProjectRunsEnvelope({ ...page, next_cursor: "" }, "project-a")).toThrow();
  });
  it("rejects a foreign project page even when it is empty", () => {
    const page: ProjectRunListResource = { project_id: "project-a", runs: [] };
    expect(validateProjectRunsEnvelope(page, "project-a")).toBe(page);
    expect(() => validateProjectRunsEnvelope(page, "project-b")).toThrow();
  });

  it("fences both project and run on the selected resource", () => {
    const run: ProjectRunResource = {
      project_id: "project-a",
      run_id: "run-a",
      catalog_state: "materialized",
      payload_fingerprint: "a".repeat(64),
      requested_execution: { backend: "fdm", device: "cpu", mode: "relax", precision: "f64" },
      scheduling_priority: 0,
      tasks: [],
    };
    expect(validateProjectRunEnvelope(run, "project-a", "run-a")).toBe(run);
    expect(() => validateProjectRunEnvelope(run, "project-b", "run-a")).toThrow();
    expect(() => validateProjectRunEnvelope(run, "project-a", "run-b")).toThrow();
  });
});
