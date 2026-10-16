import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { ModuleRegistry } from "../module/ModuleRegistry";
import type { KernelApi, ModuleManifest, ModuleProps } from "../types";

import { LayoutController } from "./LayoutController";
import { ViewportTabHost } from "./ViewportTabHost";
import {
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
} from "./simulationPreparationTestDom.test-support";

const moduleLifecycle = vi.hoisted(() => ({
  loaderCalls: new Map<string, number>(),
  instanceCreations: new Map<string, number>(),
  mounts: new Map<string, number>(),
  unmounts: new Map<string, number>(),
}));

type MockProps = {
  children?: ReactNode;
  className?: string;
  [key: string]: unknown;
};

vi.mock("lucide-react", () => ({ X: () => null }));

vi.mock("@/shared/ui/Button", async () => {
  const React = await import("react");
  return {
    Button: (props: MockProps) => React.createElement(
      "button",
      { className: props.className as string, type: props.type as string },
      props.children,
    ),
  };
});

vi.mock("@/shared/ui/Resizable", async () => {
  const React = await import("react");
  return {
    ResizablePanelGroup: (props: MockProps) => React.createElement(
      "div",
      {
        "data-resizable-group": "true",
        "data-auto-save-id": props.autoSaveId as string,
        "data-direction": props.direction as string,
        "data-panel-count": String(props.panelCount),
      },
      props.children,
    ),
    ResizablePanel: (props: MockProps) => React.createElement(
      "section",
      {
        "data-resizable-panel": "true",
        "data-panel-id": props.id as string,
        "data-default-size": String(props.defaultSize),
        "data-min-size": String(props.minSize),
      },
      props.children,
    ),
    ResizableHandle: (props: MockProps) => React.createElement("div", {
      "data-resizable-handle": "true",
      className: props.className as string,
    }),
  };
});

vi.mock("@/shared/ui/Tabs", async () => {
  const React = await import("react");
  return {
    Tabs: (props: MockProps) => React.createElement(
      "div",
      { "data-tabs-value": props.value as string },
      props.children,
    ),
    TabsList: (props: MockProps) => React.createElement(
      "div",
      { "aria-label": props["aria-label"] as string },
      props.children,
    ),
    TabsTrigger: (props: MockProps) => React.createElement(
      "button",
      {
        className: props.className as string,
        "data-tab-id": props.value as string,
        "data-companion": props["data-companion"] as boolean | undefined,
      },
      props.children,
    ),
  };
});

function increment(counter: Map<string, number>, key: string): number {
  const next = (counter.get(key) ?? 0) + 1;
  counter.set(key, next);
  return next;
}

function ViewportProbe({ moduleId }: ModuleProps) {
  const [instanceId] = useState(
    () => moduleId + "#" + increment(moduleLifecycle.instanceCreations, moduleId),
  );

  useEffect(() => {
    increment(moduleLifecycle.mounts, moduleId);
    return () => {
      increment(moduleLifecycle.unmounts, moduleId);
    };
  }, [moduleId]);

  return (
    <div
      data-module-id={moduleId}
      data-instance-id={instanceId}
    />
  );
}

function makeManifest(id: string, title: string): ModuleManifest {
  return {
    id,
    title,
    version: "1.0.0",
    slots: ["viewport-main"],
    component: async () => {
      increment(moduleLifecycle.loaderCalls, id);
      return { default: ViewportProbe };
    },
  };
}

function findByAttribute(
  root: TestElement,
  name: string,
  value: string,
): TestElement | null {
  return findElements(root, (element) => element.getAttribute(name) === value)[0] ?? null;
}

function panelIds(root: TestElement): string[] {
  return findElements(root, (element) => element.hasAttribute("data-resizable-panel"))
    .map((element) => element.getAttribute("data-panel-id") ?? "");
}

function panelSizes(root: TestElement): string[] {
  return findElements(root, (element) => element.hasAttribute("data-resizable-panel"))
    .map((element) => element.getAttribute("data-default-size") ?? "");
}

async function flushLazyModules(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ViewportTabHost visible module lifecycle", () => {
  it("keeps visible modules mounted across companion and role changes, and unmounts on close", async () => {
    const plotsId = "analysis-plots-host-test";
    const viewportId = "viewport-3d-host-test";
    const unopenedId = "field-map-unopened-test";
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    layout.setActiveViewportMainModule(plotsId);

    const modules = new ModuleRegistry();
    modules.register(makeManifest(plotsId, "Analysis"));
    modules.register(makeManifest(viewportId, "3D"));
    modules.register(makeManifest(unopenedId, "Unopened"));

    const kernel = { layout, modules } as unknown as KernelApi;
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <ViewportTabHost />
          </KernelContext.Provider>,
        );
        await Promise.resolve();
      });
      await flushLazyModules();

      const plotsBeforeSplit = findByAttribute(container, "data-module-id", plotsId);
      expect(plotsBeforeSplit).not.toBeNull();
      expect(moduleLifecycle.mounts.get(plotsId)).toBe(1);
      expect(moduleLifecycle.loaderCalls.get(viewportId) ?? 0).toBe(0);
      expect(moduleLifecycle.loaderCalls.get(unopenedId) ?? 0).toBe(0);

      const singleGroup = findByAttribute(container, "data-resizable-group", "true");
      expect(singleGroup?.getAttribute("data-panel-count")).toBe("1");
      expect(singleGroup?.getAttribute("data-auto-save-id"))
        .toContain("fullmag.viewport-main.v2.single.primary-analysis-plots-host-test");
      expect(panelIds(container)).toEqual([
        "viewport-main:" + plotsId + ":primary",
      ]);
      expect(panelSizes(container)).toEqual(["100"]);
      expect(findElements(container, (element) =>
        element.hasAttribute("data-resizable-handle")).length).toBe(0);

      await act(async () => {
        layout.setViewportCompanion({ moduleId: viewportId, placement: "beside" });
        await Promise.resolve();
      });
      await flushLazyModules();

      expect(findByAttribute(container, "data-module-id", plotsId)).toBe(plotsBeforeSplit);
      expect(moduleLifecycle.mounts.get(plotsId)).toBe(1);
      expect(moduleLifecycle.unmounts.get(plotsId) ?? 0).toBe(0);
      expect(moduleLifecycle.mounts.get(viewportId)).toBe(1);
      expect(moduleLifecycle.loaderCalls.get(unopenedId) ?? 0).toBe(0);
      const besideGroup = findByAttribute(container, "data-resizable-group", "true");
      expect(besideGroup).toBe(singleGroup);
      expect(besideGroup?.getAttribute("data-direction")).toBe("horizontal");
      expect(besideGroup?.getAttribute("data-panel-count")).toBe("2");
      expect(besideGroup?.getAttribute("data-auto-save-id"))
        .toContain("fullmag.viewport-main.v2.beside.primary-analysis-plots-host-test.companion-viewport-3d-host-test");
      expect(panelIds(container)).toEqual([
        "viewport-main:" + plotsId + ":primary",
        "viewport-main:" + viewportId + ":companion",
      ]);
      expect(panelSizes(container)).toEqual(["50", "50"]);
      expect(findElements(container, (element) =>
        element.hasAttribute("data-resizable-handle")).length).toBe(1);

      const viewportBeforeSwap = findByAttribute(container, "data-module-id", viewportId);
      const plotsInstanceBeforeSwap = plotsBeforeSplit?.getAttribute("data-instance-id");
      await act(async () => {
        layout.replace({
          ...layout.get(),
          activeViewportMainModuleId: viewportId,
          viewportCompanion: { moduleId: plotsId, placement: "below" },
        });
        await Promise.resolve();
      });
      await flushLazyModules();

      expect(findByAttribute(container, "data-module-id", viewportId)).toBe(viewportBeforeSwap);
      expect(findByAttribute(container, "data-module-id", plotsId)).toBe(plotsBeforeSplit);
      expect(plotsBeforeSplit?.getAttribute("data-instance-id")).toBe(plotsInstanceBeforeSwap);
      expect(moduleLifecycle.mounts.get(plotsId)).toBe(1);
      expect(moduleLifecycle.mounts.get(viewportId)).toBe(1);
      expect(moduleLifecycle.unmounts.get(plotsId) ?? 0).toBe(0);
      expect(moduleLifecycle.unmounts.get(viewportId) ?? 0).toBe(0);
      const belowGroup = findByAttribute(container, "data-resizable-group", "true");
      expect(belowGroup).toBe(besideGroup);
      expect(belowGroup?.getAttribute("data-direction")).toBe("vertical");
      expect(belowGroup?.getAttribute("data-auto-save-id"))
        .toContain("fullmag.viewport-main.v2.below.primary-viewport-3d-host-test.companion-analysis-plots-host-test");
      expect(panelIds(container)).toEqual([
        "viewport-main:" + viewportId + ":primary",
        "viewport-main:" + plotsId + ":companion",
      ]);
      expect(panelSizes(container)).toEqual(["50", "50"]);

      await act(async () => {
        layout.setViewportCompanion({ moduleId: plotsId, placement: "beside" });
        await Promise.resolve();
      });
      await flushLazyModules();

      const placedGroup = findByAttribute(container, "data-resizable-group", "true");
      expect(placedGroup).toBe(belowGroup);
      expect(placedGroup?.getAttribute("data-direction")).toBe("horizontal");
      expect(placedGroup?.getAttribute("data-auto-save-id"))
        .toContain("fullmag.viewport-main.v2.beside.primary-viewport-3d-host-test.companion-analysis-plots-host-test");
      expect(findByAttribute(container, "data-module-id", viewportId)).toBe(viewportBeforeSwap);
      expect(findByAttribute(container, "data-module-id", plotsId)).toBe(plotsBeforeSplit);
      expect(findByAttribute(container, "data-resizable-group", "true")).toBe(placedGroup);
      expect(moduleLifecycle.unmounts.get(plotsId) ?? 0).toBe(0);
      expect(moduleLifecycle.unmounts.get(viewportId) ?? 0).toBe(0);

      await act(async () => {
        layout.setViewportCompanion(null);
        await Promise.resolve();
      });
      await flushLazyModules();

      expect(findByAttribute(container, "data-module-id", viewportId)).toBe(viewportBeforeSwap);
      expect(findByAttribute(container, "data-resizable-group", "true")).toBe(placedGroup);
      expect(findByAttribute(container, "data-module-id", plotsId)).toBeNull();
      expect(moduleLifecycle.mounts.get(viewportId)).toBe(1);
      expect(moduleLifecycle.unmounts.get(viewportId) ?? 0).toBe(0);
      expect(moduleLifecycle.unmounts.get(plotsId)).toBe(1);
      expect(moduleLifecycle.loaderCalls.get(unopenedId) ?? 0).toBe(0);
      expect(panelIds(container)).toEqual([
        "viewport-main:" + viewportId + ":primary",
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
