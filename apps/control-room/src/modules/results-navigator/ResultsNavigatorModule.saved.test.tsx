import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { findElement, installSimulationPreparationTestDom, type TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { ModuleProps } from "@/kernel/types";

import ResultsNavigatorModule from "./ResultsNavigatorModule";

const fakes = vi.hoisted(() => ({ currentReads: 0 }));
vi.mock("./SavedResultsBrowser", () => ({
  SavedResultsBrowser: () => <section aria-label="Saved result browser">Saved datasets</section>,
}));
vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    name.startsWith("use") ? () => {
      fakes.currentReads += 1;
      return { status: "idle", data: null, error: null };
    } : value,
  ]));
});
vi.mock("@/kernel/resources/analysisResultResources", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name,
    name.startsWith("use") ? () => ({ status: "idle", data: null, error: null }) : value,
  ]));
});

describe("Results navigator source routing", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let root: ReturnType<typeof createRoot>;
  let container: TestElement;
  let kernel: ModuleProps["kernel"];
  let commits: number;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    container = dom.document.createElement("div") as unknown as TestElement;
    root = createRoot(container as unknown as Element);
    const bus = new EventBus<KernelEventMap>();
    kernel = {
      layout: new LayoutController(bus), selection: new SelectionController(bus),
      commands: { execute: vi.fn() },
    } as unknown as ModuleProps["kernel"];
    commits = 0;
    fakes.currentReads = 0;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    dom.restore();
  });
  const view = () => (
    <KernelContext value={kernel}>
      <Profiler id="results-routing" onRender={() => { commits += 1; }}>
        <ResultsNavigatorModule kernel={kernel} moduleId="results-navigator" config={{}} setConfig={() => {}} />
      </Profiler>
    </KernelContext>
  );
  const activeTab = () => findElement(container, element =>
    element.getAttribute("role") === "tab" && element.getAttribute("data-state") === "active", "active Results source");

  it("honors Saved opened before mounting, matches SSR, and does not mount Current resources", async () => {
    kernel.layout.openSavedResults();
    const server = renderToStaticMarkup(view());
    expect(server).toContain("Saved datasets");
    expect(server).toMatch(/data-state="active"[^>]*>Saved</);
    expect(fakes.currentReads).toBe(0);
    await act(async () => root.render(view()));
    expect(activeTab().textContent).toBe("Saved");
    expect(container.textContent).toContain("Saved datasets");
    expect(fakes.currentReads).toBe(0);
    const settled = commits;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(commits).toBe(settled);
    expect(commits).toBeLessThanOrEqual(3);
    await act(async () => root.render(null));
    await act(async () => root.render(view()));
    expect(activeTab().textContent).toBe("Saved");
    expect(fakes.currentReads).toBe(0);
  });

  it("switches Current and Saved through the canonical layout source without duplicate panels", async () => {
    kernel.layout.openSavedResults();
    await act(async () => root.render(view()));
    await act(async () => kernel.layout.setResultsSource("current"));
    expect(activeTab().textContent).toBe("Current");
    expect(container.textContent).not.toContain("Saved datasets");
    expect(fakes.currentReads).toBeGreaterThan(0);
    await act(async () => kernel.layout.setResultsSource("saved"));
    expect(activeTab().textContent).toBe("Saved");
    expect(container.textContent.match(/Saved datasets/g)).toHaveLength(1);
    const settled = commits;
    await act(async () => { kernel.layout.setResultsSource("saved"); });
    expect(commits).toBe(settled);
    expect(commits).toBeLessThanOrEqual(6);
  });
});
