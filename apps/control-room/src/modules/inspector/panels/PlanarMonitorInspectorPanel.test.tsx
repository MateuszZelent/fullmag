import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { planarMonitorFramePreviewStore } from "@/kernel/workspace/planarMonitorFramePreview";

import { PlanarMonitorInspectorPanel } from "./PlanarMonitorInspectorPanel";

const mocks = vi.hoisted(() => ({
  collection: { monitors: [] as unknown[], scene_revision: 7 },
  duplicate: vi.fn(),
  execute: vi.fn(),
  invalidate: vi.fn(),
  patch: vi.fn(),
  refetch: vi.fn(),
}));

const monitorFixture = {
  frame: {
    extent: { kind: "target_bounds", padding_m: 0 },
    normal: [0, 0, 1],
    normalization_version: "planar_frame_v1",
    origin_m: [0, 0, 0],
    preset: "xy",
    u_axis: [1, 0, 0],
    v_axis: [0, 1, 0],
  },
  id: "plane-1",
  name: "Mid-plane",
  operator: { kind: "plane_sample" },
  target: { kind: "magnetic_domain" },
} as const;

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: { model: { planarMonitors: { duplicate: mocks.duplicate, patch: mocks.patch } } },
    commands: { execute: mocks.execute },
    resources: { invalidate: mocks.invalidate },
  }),
}));

vi.mock("@/kernel/resources/planarMonitorResources", () => ({
  usePlanarMonitorsResource: () => ({ data: mocks.collection }),
  usePlanarMonitorResource: () => ({
    data: {
      monitor: {
        ...monitorFixture,
      },
      scene_revision: 7,
    },
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/kernel/visualization/useVisualizationStateResource", () => ({
  useVisualizationStateResource: () => ({
    data: { planar: { active_monitor_id: "plane-1" } },
  }),
}));

vi.mock("./usePlanarMonitorDefinitionAvailability", () => ({
  usePlanarMonitorDefinitionAvailability: () => ({}),
}));

vi.mock("../visualization/VisualizationContextSwitch", () => ({
  VisualizationContextSwitch: () => <div>3D / 2D</div>,
}));

vi.mock("../visualization/PlanarVisualizationSection", () => ({
  PlanarVisualizationSection: () => <div>Planar controls</div>,
}));

describe("PlanarMonitorInspectorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    planarMonitorFramePreviewStore.clearDraft();
    mocks.collection.monitors = [monitorFixture];
    mocks.patch.mockResolvedValue({
      monitor: { ...monitorFixture, name: "Edited" },
      scene_revision: 8,
    });
    mocks.execute.mockResolvedValue({ status: "completed" });
    mocks.duplicate.mockResolvedValue({
      monitor: { id: "plane-1_copy", name: "Mid-plane copy" },
      scene_revision: 8,
    });
  });

  it("server-renders canonical identity, editable rename and monitor actions", () => {
    const html = renderToStaticMarkup(
      <PlanarMonitorInspectorPanel
        selection={{
          kind: "model.planar.monitor",
          label: "Mid-plane",
          moduleSource: "inspector",
          nodeId: "model:definitions:planar-monitors:plane-1",
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: "plane-1",
            nodeId: "model:definitions:planar-monitors:plane-1",
            type: "planar-monitor",
            visualizationTargetId: "planar-monitor:plane-1",
          },
        }}
      />,
    );

    expect(html).toContain('value="Mid-plane"');
    expect(html).toContain("Apply");
    expect(html).toContain("Discard");
    expect(html).toContain("Create preset");
    expect(html).toContain("Show frame in 3D");
    expect(html).toContain("Open in 2D");
    expect(html).toContain("SceneDocument / ProblemIR");
  });

  it("hydrates the Inspector create action without a client-only mismatch", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    (container as unknown as { innerHTML: string }).innerHTML = renderToStaticMarkup(
      <PlanarMonitorInspectorPanel selection={selection()} />,
    );
    const recoverableErrors: Error[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    try {
      await act(async () => {
        root = hydrateRoot(container as unknown as Element, <PlanarMonitorInspectorPanel selection={selection()} />, {
          onRecoverableError: (error) => recoverableErrors.push(
            error instanceof Error ? error : new Error(String(error)),
          ),
        });
        await Promise.resolve();
      });
      expect(recoverableErrors).toEqual([]);
      expect(findButton(container, "Create preset")).toBeDefined();
    } finally {
      await act(async () => root!.unmount());
      dom.restore();
    }
  });

  it("keeps edits local until Apply and Discard restores the resource", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorInspectorPanel selection={selection()} />));
      await act(async () => change(findControl(container, "Target kind"), "domain"));
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(planarMonitorFramePreviewStore.getDraftSnapshot()).toMatchObject({
        monitor: { id: "plane-1", target: { kind: "domain" } },
      });

      await act(async () => findButton(container, "Discard").click());
      expect(findButton(container, "Apply").disabled).toBe(true);
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(planarMonitorFramePreviewStore.getDraftSnapshot()).toBeNull();

      await act(async () => change(findControl(container, "Target kind"), "domain"));
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith("plane-1", {
        expected_scene_revision: 7,
        monitor: uiRoundtripFixture().patch,
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("routes the Inspector preset action through the canonical create command", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorInspectorPanel selection={selection()} />));
      await act(async () => findButton(container, "Create preset").click());
      expect(mocks.execute).toHaveBeenCalledWith(
        "planar-monitor.create",
        expect.anything(),
        { intent: { source: "inspector" }, monitorId: "plane-1" },
      );
    } finally {
      await act(async () => root.unmount());
      expect(planarMonitorFramePreviewStore.getDraftSnapshot()).toBeNull();
      dom.restore();
    }
  });

  it("keeps the edited draft on 409 and delegates duplicate selection to the command owner", async () => {
    mocks.collection.monitors = [
      monitorFixture,
      { ...monitorFixture, id: "plane-1_copy", name: "Mid-plane copy" },
      { ...monitorFixture, id: "plane-1_copy_2", name: "Mid-plane copy 2" },
    ];
    mocks.patch.mockRejectedValueOnce({ status: 409, code: "scene_revision_conflict" });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<PlanarMonitorInspectorPanel selection={selection()} />));
      await act(async () => change(findControl(container, "Target kind"), "domain"));
      await act(async () => findButton(container, "Apply").click());
      expect(controlValue(findControl(container, "Target kind"))).toBe("domain");
      expect(container.textContent).toContain("scene changed");

      await act(async () => findButton(container, "Duplicate").click());
      expect(mocks.execute).toHaveBeenCalledWith(
        "planar-monitor.duplicate",
        expect.anything(),
        { monitorId: "plane-1" },
      );
      expect(mocks.duplicate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function selection(): Parameters<typeof PlanarMonitorInspectorPanel>[0]["selection"] {
  return {
    kind: "model.planar.monitor",
    label: "Mid-plane",
    moduleSource: "inspector",
    nodeId: "model:definitions:planar-monitors:plane-1",
    objectId: null,
    ref: {
      kind: "model.planar.monitor",
      monitorId: "plane-1",
      nodeId: "model:definitions:planar-monitors:plane-1",
      type: "planar-monitor",
      visualizationTargetId: "planar-monitor:plane-1",
    },
  };
}

function findControl(root: TestNode, label: string): TestElement {
  const control = findElements(root, (element) => element.getAttribute("aria-label") === label)[0];
  if (!control) throw new Error(`Missing control ${label}`);
  return control;
}

function controlValue(control: TestElement): string {
  return (control as TestElement & { value: string }).value;
}

function change(element: TestElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent === text)[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findElements(root: TestNode, predicate: (element: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function uiRoundtripFixture(): { create: unknown; patch: unknown } {
  return JSON.parse(readFileSync(
    new URL("../../../../../../packages/fullmag-py/tests/fixtures/planar_monitor_ui_roundtrip.json", import.meta.url),
    "utf8",
  ));
}
