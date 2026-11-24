import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleProps } from "@/kernel/types";
import { KernelContext } from "@/kernel/KernelContext";
import { SavedRunController } from "@/kernel/saved-results/SavedRunController";
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
  let savedRun: SavedRunController;
  let props: Pick<ModuleProps, "kernel" | "moduleId">;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    container = dom.document.createElement("div") as unknown as TestElement;
    root = createRoot(container as unknown as Element);
    vi.clearAllMocks();
    savedRun = new SavedRunController();
    props = {
      kernel: { api: { resourceCacheScope: "saved-results-test" }, savedRun } as unknown as ModuleProps["kernel"],
      moduleId: "results-navigator",
    };
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
  const render = () => act(async () => root.render(
    <KernelContext.Provider value={props.kernel}>
      <SavedResultsBrowser {...props} />
    </KernelContext.Provider>,
  ));
  async function selectRun() {
    await render();
    const run = findElement(container,
      element => element.tagName === "BUTTON" && element.getAttribute("title") === "run-a", "saved run");
    await act(async () => run.click());
  }

  it("observes an explicitly opened saved run without requiring an active project", async () => {
    fakes.project.mockReturnValue({ state: "empty" });
    savedRun.openVerified({
      apiScope: "saved-results-test", projectId: "saved-project", runId: "saved-run",
    }, savedRun.beginOpen());
    await render();
    expect(fakes.runs).not.toHaveBeenCalled();
    expect(fakes.run).toHaveBeenLastCalledWith("saved-project", "saved-run");
    expect(container.textContent).toContain("Task execution: running");
    expect(container.textContent).toContain("No SolutionSets on this page.");
  });

  it("ignores a saved run from a different API scope and retains project discovery", async () => {
    savedRun.openVerified({
      apiScope: "foreign-api", projectId: "foreign-project", runId: "foreign-run",
    }, savedRun.beginOpen());
    await selectRun();
    expect(fakes.runs).toHaveBeenLastCalledWith("project-a", null);
    expect(fakes.run).toHaveBeenLastCalledWith("project-a", "run-a");
    expect(container.textContent).toContain("Task execution: running");
  });

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
    await render();
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
    await render();
    expect(container.textContent).toContain("Task execution: succeeded");
    expect(container.textContent).toContain("No SolutionSets on this page.");
    expect(container.textContent).not.toContain("Inspect pinned dataset");
    expect(fakes.run).toHaveBeenLastCalledWith("project-a", "run-a");
  });
});
