import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleProps } from "@/kernel/types";
import { findElement, installSimulationPreparationTestDom, type TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SavedResultsBrowser } from "./SavedResultsBrowser";

const fakes = vi.hoisted(() => ({
  project: vi.fn(), runs: vi.fn(), run: vi.fn(), discovery: vi.fn(),
  refreshRuns: vi.fn(), refreshRun: vi.fn(), refreshResults: vi.fn(),
}));
vi.mock("@/kernel/persistence/ProjectDocumentStatus", () => ({
  useProjectDocumentSnapshot: fakes.project,
}));
vi.mock("@/kernel/resources/projectRunResources", () => ({
  useProjectRunsResource: fakes.runs,
  useProjectRunResource: fakes.run,
}));
vi.mock("@/kernel/resources/solutionSetResources", () => ({
  useSolutionSetDiscoveryResource: fakes.discovery,
  useSolutionSetResource: () => ({ status: "idle", data: null }),
  useSolutionSetMembersResource: vi.fn(),
  useSolutionSetArtifactsResource: vi.fn(),
  useMaterializedDatasetResource: vi.fn(),
  useSolutionScalarResource: vi.fn(),
  isSolutionScalarArtifact: vi.fn(),
}));

describe("saved run execution observation", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let root: ReturnType<typeof createRoot>;
  let container: TestElement;
  const props = { kernel: {} as ModuleProps["kernel"], moduleId: "results-navigator" };

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    container = dom.document.createElement("div") as unknown as TestElement;
    root = createRoot(container as unknown as Element);
    vi.clearAllMocks();
    fakes.project.mockReturnValue({ state: "ready", resource: { project_id: "project-a" } });
    fakes.runs.mockReturnValue({
      status: "ready", error: null, refetch: fakes.refreshRuns,
      data: { runs: [{ run_id: "run-a", catalog_state: "materialized" }], next_cursor: null },
    });
    fakes.run.mockReturnValue({
      status: "ready", error: null, refreshError: null, refetch: fakes.refreshRun,
      data: { tasks: [{ task_id: "task-a", lifecycle: "running", readiness: { state: "ready" } }] },
    });
    fakes.discovery.mockReturnValue({
      status: "ready", error: null, refetch: fakes.refreshResults,
      data: { items: [], next_cursor: null },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });
  const button = (label: string) => findElement(container,
    element => element.tagName === "BUTTON" && element.getAttribute("aria-label") === label, label);
  async function selectRun() {
    await act(async () => root.render(<SavedResultsBrowser {...props} />));
    const run = findElement(container,
      element => element.tagName === "BUTTON" && element.getAttribute("title") === "run-a", "saved run");
    await act(async () => run.click());
  }

  it("refreshes run discovery and observes the explicitly selected durable task", async () => {
    await selectRun();
    await act(async () => button("Refresh saved runs").click());
    expect(fakes.refreshRuns).toHaveBeenCalledTimes(1);
    expect(fakes.run).toHaveBeenLastCalledWith("project-a", "run-a");
    expect(container.textContent).toContain("Task execution: running");
    expect(container.textContent).toContain("independent of the live session");
    expect(container.textContent).toContain("No SolutionSets on this page.");
    await act(async () => button("Refresh selected run and saved results").click());
    expect(fakes.refreshRun).toHaveBeenCalledTimes(1);
    expect(fakes.refreshResults).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected panel while refreshing and never treats success as an available field", async () => {
    await selectRun();
    const panel = findElement(container,
      element => element.getAttribute("aria-label") === "Selected saved run execution", "execution panel");
    fakes.runs.mockReturnValue({
      ...fakes.runs.mock.results.at(-1)!.value, refreshError: new Error("Run discovery unavailable"),
    });
    fakes.discovery.mockReturnValue({
      ...fakes.discovery.mock.results.at(-1)!.value, refreshError: new Error("Solution discovery unavailable"),
    });
    fakes.run.mockReturnValue({
      ...fakes.run.mock.results.at(-1)!.value, status: "loading",
      refreshError: new Error("Connection unavailable"),
    });
    await act(async () => root.render(<SavedResultsBrowser {...props} />));
    expect(findElement(container,
      element => element.getAttribute("aria-label") === "Selected saved run execution", "execution panel")).toBe(panel);
    expect(container.textContent).toContain("Task execution: running");
    expect(container.textContent).toContain("Connection unavailable");
    expect(container.textContent).toContain("Run discovery unavailable");
    expect(container.textContent).toContain("Previously loaded runs are still shown.");
    expect(container.textContent).toContain("Solution discovery unavailable");
    expect(container.textContent).toContain("Previously loaded results are still shown.");
    fakes.run.mockReturnValue({
      status: "ready", error: null, refreshError: null, refetch: fakes.refreshRun,
      data: { tasks: [{ task_id: "task-a", lifecycle: "succeeded", readiness: { state: "ready" } }] },
    });
    await act(async () => root.render(<SavedResultsBrowser {...props} />));
    expect(container.textContent).toContain("Task execution: succeeded");
    expect(container.textContent).toContain("No SolutionSets on this page.");
    expect(container.textContent).not.toContain("Inspect pinned dataset");
    expect(fakes.run).toHaveBeenLastCalledWith("project-a", "run-a");
  });
});
