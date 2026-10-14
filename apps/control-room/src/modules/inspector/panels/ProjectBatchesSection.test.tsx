import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectBatchCasesQuery } from "@/kernel/api/apiTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ProjectBatchesSection } from "./ProjectBatchesSection";

const fakes = vi.hoisted(() => ({
  projectSnapshot: vi.fn(),
  listBatches: vi.fn(),
  listBatchCases: vi.fn(),
  runDetails: vi.fn(),
  runResults: vi.fn(),
}));

vi.mock("@/kernel/persistence/ProjectDocumentStatus", () => ({
  useProjectDocumentSnapshot: fakes.projectSnapshot,
}));

vi.mock("@/kernel/resources/projectBatchResources", () => ({
  useProjectBatchesResource: fakes.listBatches,
  useProjectBatchCasesResource: fakes.listBatchCases,
}));

vi.mock("@/kernel/resources/projectRunResources", () => ({
  useProjectRunResource: fakes.runDetails,
}));

vi.mock("@/kernel/resources/solutionSetResources", () => ({
  useSolutionSetDiscoveryResource: fakes.runResults,
}));

describe("ProjectBatchesSection", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let roots: Array<ReturnType<typeof createRoot>>;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    roots = [];
    vi.clearAllMocks();
    fakes.projectSnapshot.mockReturnValue({
      state: "ready",
      resource: { project_id: "project-a" },
    });
    fakes.listBatches.mockReturnValue({
      data: {
        project_id: "project-a",
        batches: [{
          accepted_at: "2026-10-07T12:00:00Z",
          batch_id: "batch-a",
          case_count: 5,
          expansion_state: "expanding",
          failure_policy: "continue_independent",
          manifest_sha256: "a".repeat(64),
          max_parallel_cases: 2,
          published_case_count: 2,
        }],
        next_cursor: null,
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
    fakes.listBatchCases.mockImplementation((
      _projectId: string,
      batchId: string | null,
      _query: ProjectBatchCasesQuery,
    ) =>
      batchId === "batch-a"
        ? {
            data: {
              batch_id: "batch-a",
              axes: [{ name: "B_ext", canonical_unit: "T" }],
              cases: [{
                case_id: "case-a",
                parameter_tuple: { B_ext: 0.01 },
                planned_run_id: "run-a",
                state: "pending_expansion",
                published_run: null,
              }, {
                case_id: "case-b",
                parameter_tuple: { B_ext: 0.02 },
                planned_run_id: "run-b",
                state: "materialized",
                published_run: {
                  run_id: "run-b",
                  catalog_state: "materialized",
                  catalog_revision: 7,
                  tasks: [{ task_id: "task-b", lifecycle: "running" }],
                },
              }],
              next_cursor: "case-b",
            },
            error: null,
            refetch: vi.fn(),
            status: "ready",
          }
        : {
            data: null,
            error: null,
            refetch: vi.fn(),
            status: "idle",
          },
    );
    fakes.runDetails.mockReturnValue({
      data: {
        catalog_revision: 7,
        catalog_state: "materialized",
        project_id: "project-a",
        run_id: "run-b",
        tasks: [{
          lifecycle: "running",
          readiness: { state: "ready" },
          task_id: "task-b",
        }],
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
    fakes.runResults.mockReturnValue({
      data: {
        items: [{
          manifest_digest: `sha256:${"b".repeat(64)}`,
          revision: "4",
          solution_set_id: "solution-a",
        }],
        project_id: "project-a",
        run_id: "run-b",
        schema_version: "fullmag.analysis.solution_set_discovery.v1",
        next_cursor: null,
      },
      error: null,
      refetch: vi.fn(),
      status: "ready",
    });
  });

  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    dom.restore();
  });

  it("shows published progress and opens a paged case list", async () => {
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(<ProjectBatchesSection />));

    expect(container.textContent).toContain("Saved project batches");
    expect(container.textContent).toContain(
      "Expanding · 2 / 5 cases published · max parallel 2 · on failure: continue independent cases",
    );
    expect(fakes.listBatchCases).toHaveBeenCalledWith("project-a", null, {
      cursor: null,
      limit: 20,
    });

    const toggle = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "batch-a",
      "batch disclosure",
    );
    await act(async () => toggle.click());

    expect(container.textContent).toContain("B_ext=0.01 T");
    expect(container.textContent).toContain("B_ext=0.02 T");
    expect(container.textContent).toContain("Planned run: run-a");
    expect(container.textContent).toContain("Child run has not been published.");
    expect(container.textContent).toContain("Published child run: run-b");
    expect(container.textContent).toContain("Task catalog revision 7 · 1 task(s)");
    expect(container.textContent).toContain("running · task-b");
    expect(Array.from(container.querySelectorAll("button")).filter((button) =>
      button.textContent?.trim() === "View run details",
    )).toHaveLength(1);
    const viewRun = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "View run details",
      "view run details button",
    );
    await act(async () => viewRun.click());
    expect(container.textContent).toContain("Task catalog revision 7");
    expect(container.textContent).toContain("running · ready");
    expect(container.textContent).toContain("task-b");
    expect(container.textContent).toContain("Available results");
    expect(container.textContent).toContain("solution-a · revision 4");
    expect(fakes.listBatchCases).toHaveBeenLastCalledWith("project-a", "batch-a", {
      cursor: null,
      limit: 20,
    });

    const nextCases = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Next cases",
      "next cases button",
    );
    await act(async () => nextCases.click());
    expect(fakes.listBatchCases).toHaveBeenLastCalledWith("project-a", "batch-a", {
      cursor: "case-b",
      limit: 20,
    });
  });
});
