import { describe, expect, it, vi } from "vitest";

import type {
  ProjectBatchCasesResource,
  ProjectBatchListResource,
} from "../api/apiTypes";
import {
  loadAllProjectBatchCases,
  projectBatchCasesResourceKey,
  projectBatchCasesResourcePrefix,
  projectBatchesResourceKey,
  validateProjectBatchCasesEnvelope,
  validateProjectBatchesEnvelope,
} from "./projectBatchResources";

function batchPage(): ProjectBatchListResource {
  return {
    project_id: "project-a",
    batches: [{
      accepted_at: "2026-10-07T12:00:00Z",
      batch_id: "batch-a",
      case_count: 4,
      command_revision: 0,
      expansion_state: "expanding",
      failure_policy: "continue_independent",
      manifest_sha256: "a".repeat(64),
      max_parallel_cases: 2,
      published_case_count: 1,
    }],
    next_cursor: "batch-a",
  };
}

function casePage(): ProjectBatchCasesResource {
  return {
    batch_id: "batch-a",
    axes: [{ name: "field_z", canonical_unit: "T" }],
    cases: [{
      case_id: "case-a",
      parameter_tuple: { field_z: 0.01 },
      planned_run_id: "run-a",
      state: "pending_expansion",
    }],
    next_cursor: "case-a",
  };
}

describe("saved project batch resources", () => {
  it("validates batch page ownership, expansion prefix, and cursor progress", () => {
    const data = batchPage();
    expect(validateProjectBatchesEnvelope(data, "project-a", { limit: 1 })).toBe(data);
    expect(() => validateProjectBatchesEnvelope(data, "project-b")).toThrow();
    expect(() => validateProjectBatchesEnvelope(data, "project-a", {
      cursor: "batch-a",
    })).toThrow();

    const stalled = batchPage();
    stalled.next_cursor = "other-batch";
    expect(() => validateProjectBatchesEnvelope(stalled, "project-a")).toThrow();

    const malformed = batchPage();
    malformed.batches[0]!.published_case_count = 5;
    expect(() => validateProjectBatchesEnvelope(malformed, "project-a")).toThrow();

    const incomplete = batchPage();
    incomplete.batches[0]!.expansion_state = "complete";
    expect(() => validateProjectBatchesEnvelope(incomplete, "project-a")).toThrow();

    const invalidCommandRevision = batchPage();
    invalidCommandRevision.batches[0]!.command_revision = -1;
    expect(() => validateProjectBatchesEnvelope(invalidCommandRevision, "project-a")).toThrow();

    const stopped = batchPage();
    stopped.batches[0]!.failure_policy = "stop_admission";
    stopped.batches[0]!.expansion_state = "stopped";
    expect(validateProjectBatchesEnvelope(stopped, "project-a")).toBe(stopped);

    const inconsistentStop = batchPage();
    inconsistentStop.batches[0]!.expansion_state = "stopped";
    expect(() => validateProjectBatchesEnvelope(inconsistentStop, "project-a")).toThrow();
  });

  it("rejects oversized, duplicate, and malformed batch summaries", () => {
    const tooMany = batchPage();
    tooMany.batches.push({ ...tooMany.batches[0]! });
    expect(() => validateProjectBatchesEnvelope(tooMany, "project-a", { limit: 1 })).toThrow();

    const duplicate = batchPage();
    duplicate.batches.push({ ...duplicate.batches[0]! });
    expect(() => validateProjectBatchesEnvelope(duplicate, "project-a")).toThrow();

    const badDigest = batchPage();
    badDigest.batches[0]!.manifest_sha256 = "not-a-digest";
    expect(() => validateProjectBatchesEnvelope(badDigest, "project-a")).toThrow();

    expect(() => validateProjectBatchesEnvelope(batchPage(), "project-a", {
      limit: 101,
    })).toThrow();
  });

  it("validates case pages against their batch and rejects duplicate or stalled identities", () => {
    const data = casePage();
    expect(validateProjectBatchCasesEnvelope(data, "batch-a", { limit: 1 })).toBe(data);
    expect(() => validateProjectBatchCasesEnvelope(data, "batch-b")).toThrow();

    const duplicate = casePage();
    duplicate.cases.push({ ...duplicate.cases[0]! });
    expect(() => validateProjectBatchCasesEnvelope(duplicate, "batch-a")).toThrow();

    const stalled = casePage();
    expect(() => validateProjectBatchCasesEnvelope(stalled, "batch-a", {
      cursor: "case-a",
    })).toThrow();
    stalled.next_cursor = "other-case";
    expect(() => validateProjectBatchCasesEnvelope(stalled, "batch-a")).toThrow();

    const malformed = casePage();
    malformed.cases[0]!.parameter_tuple = [] as unknown as Record<string, unknown>;
    expect(() => validateProjectBatchCasesEnvelope(malformed, "batch-a")).toThrow();

    const missingAxis = casePage();
    missingAxis.axes = [];
    expect(() => validateProjectBatchCasesEnvelope(missingAxis, "batch-a")).toThrow();

    const duplicateAxes = casePage();
    duplicateAxes.axes.push({ ...duplicateAxes.axes[0]! });
    expect(() => validateProjectBatchCasesEnvelope(duplicateAxes, "batch-a")).toThrow();

    const emptyUnit = casePage();
    emptyUnit.axes[0]!.canonical_unit = " ";
    expect(() => validateProjectBatchCasesEnvelope(emptyUnit, "batch-a")).toThrow();

    const mismatchedTuple = casePage();
    mismatchedTuple.cases[0]!.parameter_tuple = { other: 0.01 };
    expect(() => validateProjectBatchCasesEnvelope(mismatchedTuple, "batch-a")).toThrow();

    const materialized = casePage();
    materialized.cases[0] = {
      ...materialized.cases[0]!,
      state: "materialized",
      published_run: {
        run_id: "run-a",
        catalog_state: "materialized",
        catalog_revision: 3,
        tasks: [{ task_id: "task-a", lifecycle: "queued", cancellation_requested: false }],
      },
    };
    expect(validateProjectBatchCasesEnvelope(materialized, "batch-a")).toBe(materialized);

    const pendingMaterialization = casePage();
    pendingMaterialization.cases[0] = {
      ...pendingMaterialization.cases[0]!,
      state: "pending_materialization",
      published_run: {
        run_id: "run-a",
        catalog_state: "pending_materialization",
        catalog_revision: null,
        tasks: [],
      },
    };
    expect(validateProjectBatchCasesEnvelope(pendingMaterialization, "batch-a"))
      .toBe(pendingMaterialization);

    const unconfirmedChild = casePage();
    unconfirmedChild.cases[0] = {
      ...unconfirmedChild.cases[0]!,
      state: "materialized",
      published_run: null,
    };
    expect(() => validateProjectBatchCasesEnvelope(unconfirmedChild, "batch-a")).toThrow();

    const mismatchedPublishedRun = structuredClone(materialized);
    mismatchedPublishedRun.cases[0]!.published_run!.run_id = "different-run";
    expect(() => validateProjectBatchCasesEnvelope(mismatchedPublishedRun, "batch-a")).toThrow();

    const duplicateTasks = structuredClone(materialized);
    duplicateTasks.cases[0]!.published_run!.tasks.push({
      task_id: "task-a",
      lifecycle: "running",
      cancellation_requested: false,
    });
    expect(() => validateProjectBatchCasesEnvelope(duplicateTasks, "batch-a")).toThrow();

    const missingCancellationState = structuredClone(materialized);
    delete (missingCancellationState.cases[0]!.published_run!.tasks[0] as { cancellation_requested?: boolean }).cancellation_requested;
    expect(() => validateProjectBatchCasesEnvelope(missingCancellationState, "batch-a")).toThrow();
  });

  it("loads every batch case page and rejects duplicate cases or cursor loops", async () => {
    const firstPage = casePage();
    const secondPage = casePage();
    secondPage.cases[0] = {
      ...secondPage.cases[0]!,
      case_id: "case-b",
      planned_run_id: "run-b",
    };
    secondPage.next_cursor = null;
    const loadPage = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    const cases = await loadAllProjectBatchCases("batch-a", loadPage);

    expect(cases.map((item) => item.case_id)).toEqual(["case-a", "case-b"]);
    expect(loadPage).toHaveBeenNthCalledWith(1, { cursor: null, limit: 100 });
    expect(loadPage).toHaveBeenNthCalledWith(2, { cursor: "case-a", limit: 100 });

    const duplicateFirstPage = casePage();
    const duplicateSecondPage = casePage();
    duplicateSecondPage.next_cursor = null;
    const duplicatePages = vi.fn()
      .mockResolvedValueOnce(duplicateFirstPage)
      .mockResolvedValueOnce(duplicateSecondPage);
    await expect(loadAllProjectBatchCases("batch-a", duplicatePages))
      .rejects.toThrow("duplicate case");

    const loopPage = casePage();
    loopPage.next_cursor = "case-a";
    await expect(loadAllProjectBatchCases("batch-a", async () => loopPage))
      .rejects.toThrow("did not advance");
  });

  it("keeps project, batch, cursor, and page size separate in resource keys", () => {
    const batchKey = projectBatchesResourceKey("project-a");
    expect(projectBatchesResourceKey("project-b")).not.toBe(batchKey);
    expect(projectBatchesResourceKey("project-a", { cursor: "batch-next" })).not.toBe(batchKey);
    expect(projectBatchesResourceKey("project-a", { limit: 20 })).not.toBe(batchKey);

    const casesKey = projectBatchCasesResourceKey("project-a", "batch-a");
    expect(projectBatchCasesResourceKey("project-b", "batch-a")).not.toBe(casesKey);
    expect(projectBatchCasesResourceKey("project-a", "batch-b")).not.toBe(casesKey);
    expect(projectBatchCasesResourceKey("project-a", "batch-a", { cursor: "case-next" }))
      .not.toBe(casesKey);
    expect(projectBatchCasesResourceKey("project-a", "batch-a", { limit: 20 }))
      .not.toBe(casesKey);
    expect(projectBatchCasesResourcePrefix("project-a", "batch-a"))
      .toBe("project-batch-cases:project-a:batch-a:");
  });
});
