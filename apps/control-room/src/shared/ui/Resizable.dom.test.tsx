import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { ResizablePanelGroup } from "./Resizable";

const panelGroupHarness = vi.hoisted(() => ({
  defaultLayout: { left: 50, right: 50 } as Record<string, number>,
  emitLayout: null as ((layout: Record<string, number>) => void) | null,
  appliedLayouts: [] as Array<Record<string, number>>,
}));

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");

  function MockGroup(props: Record<string, unknown>) {
    const onLayoutChanged = props.onLayoutChanged as
      | ((layout: Record<string, number>) => void)
      | undefined;
    const groupRef = props.groupRef as {
      current: {
        setLayout: (layout: Record<string, number>) => void;
      } | null;
    };
    const latestLayoutHandler = React.useRef(onLayoutChanged);
    latestLayoutHandler.current = onLayoutChanged;

    React.useLayoutEffect(() => {
      panelGroupHarness.emitLayout = onLayoutChanged ?? null;
      onLayoutChanged?.({ ...panelGroupHarness.defaultLayout });
    }, [onLayoutChanged]);

    React.useLayoutEffect(() => {
      groupRef.current = {
        setLayout(layout) {
          panelGroupHarness.appliedLayouts.push({ ...layout });
          latestLayoutHandler.current?.({ ...layout });
        },
      };
    }, [groupRef]);

    return React.createElement(
      "div",
      { "data-mock-resizable-group": "true" },
      props.children as ReactNode,
    );
  }

  function MockPanel(props: { children?: ReactNode }) {
    return React.createElement("div", null, props.children);
  }

  function MockSeparator() {
    return React.createElement("div");
  }

  return {
    Group: MockGroup,
    Panel: MockPanel,
    Separator: MockSeparator,
  };
});

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return values;
}

function emitLayout(layout: Record<string, number>): void {
  const callback = panelGroupHarness.emitLayout;
  if (!callback) throw new Error("Resizable group did not register its layout callback.");
  callback(layout);
}

function renderGroup(
  autoSaveId: string | undefined,
  panelCount: number,
  onLayoutChanged: (layout: Record<string, number>) => void,
) {
  return createElement(
    ResizablePanelGroup,
    {
      autoSaveId,
      direction: "horizontal",
      onLayoutChanged,
      panelCount,
    },
    createElement("div", null, "resize group"),
  );
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ResizablePanelGroup storage readiness", () => {
  beforeEach(() => {
    panelGroupHarness.defaultLayout = { left: 50, right: 50 };
    panelGroupHarness.emitLayout = null;
    panelGroupHarness.appliedLayouts.length = 0;
  });

  it("reads a new storage identity before default or reentrant layouts can overwrite it", async () => {
    const dom = installSimulationPreparationTestDom();
    const storage = installStorage();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const onLayoutChanged = vi.fn();
    const savedA = { left: 40, right: 60 };
    const savedB = { left: 32, right: 68 };
    storage.set("viewport-layout-a", JSON.stringify(savedA));

    try {
      await act(async () => {
        root.render(renderGroup("viewport-layout-a", 2, onLayoutChanged));
        await Promise.resolve();
      });
      await flushEffects();

      expect(storage.get("viewport-layout-a")).toBe(JSON.stringify(savedA));
      expect(panelGroupHarness.appliedLayouts).toEqual([savedA]);
      await act(async () => {
        emitLayout({ left: 45, right: 55 });
      });
      expect(storage.get("viewport-layout-a")).toBe(
        JSON.stringify({ left: 45, right: 55 }),
      );

      storage.set("viewport-layout-b", JSON.stringify(savedB));
      await act(async () => {
        root.render(renderGroup("viewport-layout-b", 2, onLayoutChanged));
        await Promise.resolve();
      });
      await flushEffects();

      expect(storage.get("viewport-layout-b")).toBe(JSON.stringify(savedB));
      expect(panelGroupHarness.appliedLayouts).toEqual([savedA, savedB]);
      expect(onLayoutChanged).toHaveBeenCalledTimes(5);

      await act(async () => {
        emitLayout({ left: 41, right: 59 });
      });
      expect(storage.get("viewport-layout-b")).toBe(
        JSON.stringify({ left: 41, right: 59 }),
      );
      expect(storage.get("viewport-layout-a")).toBe(
        JSON.stringify({ left: 45, right: 55 }),
      );
      expect(onLayoutChanged).toHaveBeenCalledTimes(6);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("forwards initial and resized layouts when persistence is disabled", async () => {
    const dom = installSimulationPreparationTestDom();
    const storage = installStorage();
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const onLayoutChanged = vi.fn();

    try {
      await act(async () => {
        root.render(renderGroup(undefined, 2, onLayoutChanged));
        await Promise.resolve();
      });
      await flushEffects();

      expect(onLayoutChanged).toHaveBeenCalledWith({ left: 50, right: 50 });
      expect(storage.size).toBe(0);
      expect(setItem).not.toHaveBeenCalled();

      await act(async () => {
        emitLayout({ left: 42, right: 58 });
      });

      expect(onLayoutChanged).toHaveBeenLastCalledWith({ left: 42, right: 58 });
      expect(storage.size).toBe(0);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("fences a panel-count change even when the storage key stays the same", async () => {
    const dom = installSimulationPreparationTestDom();
    const storage = installStorage();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const onLayoutChanged = vi.fn();
    const key = "workspace-columns";
    const savedTwoPanels = { left: 45, right: 55 };
    const savedThreePanels = { left: 40, middle: 35, right: 25 };
    storage.set(key, JSON.stringify(savedTwoPanels));

    try {
      await act(async () => {
        root.render(renderGroup(key, 2, onLayoutChanged));
        await Promise.resolve();
      });
      await flushEffects();
      expect(panelGroupHarness.appliedLayouts).toEqual([savedTwoPanels]);

      storage.set(key, JSON.stringify(savedThreePanels));
      panelGroupHarness.defaultLayout = { left: 50, middle: 25, right: 25 };
      await act(async () => {
        root.render(renderGroup(key, 3, onLayoutChanged));
        await Promise.resolve();
      });
      await flushEffects();

      expect(storage.get(key)).toBe(JSON.stringify(savedThreePanels));
      expect(panelGroupHarness.appliedLayouts).toEqual([
        savedTwoPanels,
        savedThreePanels,
      ]);

      await act(async () => {
        emitLayout({ left: 33, middle: 42, right: 25 });
      });
      expect(storage.get(key)).toBe(
        JSON.stringify({ left: 33, middle: 42, right: 25 }),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
