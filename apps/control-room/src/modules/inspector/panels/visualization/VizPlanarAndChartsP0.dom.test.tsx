import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { Selection } from "@/kernel/selection/selectionTypes";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({
    children,
    disabled,
    onSelect,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onSelect?: (event: Event) => void;
  }) => (
    <button
      disabled={disabled}
      role="menuitem"
      type="button"
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-alert-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div />,
  Content: ({ children }: { children?: ReactNode }) => <div role="alertdialog">{children}</div>,
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Action: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  Cancel: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{ value?: string; onValueChange?: (next: string) => void }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({ children }: { children?: ReactNode }) => <div role="tablist">{children}</div>,
    Trigger: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return (
        <button
          aria-selected={ctx.value === value}
          role="tab"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    Content: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return ctx.value === value ? <div role="tabpanel">{children}</div> : null;
    },
  };
});

vi.mock("@radix-ui/react-collapsible", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{ open?: boolean; onOpenChange?: (next: boolean) => void }>({});
  return {
    Root: ({
      children,
      open = true,
      onOpenChange,
      ...rest
    }: {
      children?: ReactNode;
      open?: boolean;
      onOpenChange?: (next: boolean) => void;
    }) => (
      <Ctx.Provider value={{ open, onOpenChange }}>
        <div data-open={String(open)} {...rest}>
          {children}
        </div>
      </Ctx.Provider>
    ),
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button type="button" onClick={() => ctx.onOpenChange?.(!ctx.open)} {...rest}>
          {children}
        </button>
      );
    },
    Content: ({ children }: { children?: ReactNode }) => {
      const ctx = React.useContext(Ctx);
      return ctx.open ? <div>{children}</div> : null;
    },
  };
});

vi.mock("@radix-ui/react-select", async () => {
  const React = await import("react");
  const Ctx = React.createContext<{ value?: string; onValueChange?: (next: string) => void }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <Ctx.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </Ctx.Provider>
    ),
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: ({ placeholder }: { placeholder?: string }) => {
      const ctx = React.useContext(Ctx);
      return <span>{ctx.value || placeholder || ""}</span>;
    },
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => (
      <button type="button" {...rest}>{children}</button>
    ),
    Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Item: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button role="option" aria-selected={false} type="button" onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
    ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Separator: () => <hr />,
    ScrollUpButton: () => null,
    ScrollDownButton: () => null,
  };
});

vi.mock("@radix-ui/react-switch", () => ({
  Root: ({
    checked,
    disabled,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
  }) => (
    <button
      aria-checked={Boolean(checked)}
      disabled={disabled}
      role="switch"
      type="button"
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
  Thumb: () => <span />,
}));

vi.mock("@radix-ui/react-slider", () => ({
  Root: ({
    value,
    onValueChange,
    ...rest
  }: {
    value?: number[];
    onValueChange?: (next: number[]) => void;
  }) => (
    <div
      data-slot="mock-slider"
      data-value={String(value?.[0] ?? 0)}
      onClick={() => onValueChange?.([50])}
      {...rest}
    />
  ),
  Track: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Range: () => <div />,
  Thumb: () => <div />,
}));

import {
  ObjectVisualizationTemplatePanel,
  toggleObjectSurfacePartVectors,
} from "./TargetVisualizationSpecs";
import { PlanarMonitorTemplatePanel } from "../../inspectors/definitions";
import { LiveChartPointTemplatePanel } from "../../inspectors/visualizations";
import { Viewport3DSettingsInspectorSpecView } from "@/modules/viewport-3d/components/Viewport3DSettingsAndExportSpecs";

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
});

type TestInputCompat = TestElement & {
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  _valueTracker?: { setValue: (value: string) => void };
  attachEvent?: (
    name: string,
    listener: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: (name: string) => void;
};

function focusAndSetInput(input: TestElement, nextValue: string): void {
  const compat = input as TestInputCompat;
  if (!compat.attachEvent) {
    compat.attachEvent = (_name, listener) => {
      compat._onPropertyChange = listener;
    };
    compat.detachEvent = () => {
      compat._onPropertyChange = undefined;
    };
  }
  input.focus();
  input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
  const previous = input.value;
  input.value = nextValue;
  compat._valueTracker?.setValue(previous);
  if (compat._onPropertyChange) {
    compat._onPropertyChange({
      propertyName: "value",
      target: input,
      srcElement: input,
    });
    return;
  }
  input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  input.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

function makeSelection(kind: string, ref: Selection["ref"] = null): Selection {
  return {
    kind,
    label: kind,
    moduleSource: "explorer",
    nodeId: `node:${kind}`,
    objectId: "disk_1",
    ref,
  };
}

describe("Task 25 — Visualization per-part P0, 3D View template, PlanarMonitor CommitBar P0, and LiveChart SI X/Y P0", () => {
  it("fixes ObjectVisualization P0: toggling arrows on part 'top_face' calls queuePartVectorVisibilityPatch for that exact part", async () => {
    const patchTargetPending = vi.fn();
    const queuePatch = vi.fn(() => ({ transactionId: "tx-top-face" }));

    const patchedTarget = toggleObjectSurfacePartVectors({
      controller: { patchTargetPending },
      meshParts: [
        { id: "top_face", label: "Top face" } as never,
        { id: "bottom_face", label: "Bottom face" } as never,
      ],
      partId: "top_face",
      sceneObjectIds: new Set(["disk_1"]),
      state: {
        overrides: [],
        revision: 7,
        targets: {
          objects: [],
          parts: [{ scope: "part", scope_id: "top_face" }],
          regions: [],
        },
      } as never,
      sync: { queuePatch },
      visible: true,
    });

    expect(patchedTarget).not.toBeNull();
    expect(patchedTarget?.id).toContain("top_face");
    expect(patchedTarget?.id).not.toContain("bottom_face");
    expect(queuePatch).toHaveBeenCalledTimes(1);
    expect(patchTargetPending).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.stringContaining("top_face") }),
      { vectorsVisible: true },
      7,
      "tx-top-face",
    );

    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const toggleSpy = vi.fn();
    await act(async () => {
      root.render(
        <ObjectVisualizationTemplatePanel
          selection={makeSelection("object.visualization")}
          testSurfaces={[
            { id: "top_face", label: "Top face", vectorsVisible: false },
            { id: "bottom_face", label: "Bottom face", vectorsVisible: true },
          ]}
          onToggleSurfaceVectors={toggleSpy}
        />,
      );
    });

    const topSwitch = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "switch" &&
        el.getAttribute("aria-label") === "Toggle vectors on Top face",
    );
    expect(topSwitch).not.toBeNull();
    await act(async () => {
      topSwitch!.click();
    });
    expect(toggleSpy).toHaveBeenCalledWith("top_face", true);

    await act(async () => {
      root.unmount();
    });
  });

  it("fixes PlanarMonitor P0: isolates Definition [staged] CommitBar from 2D Display [liveViewport]", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PlanarMonitorTemplatePanel
          selection={makeSelection("model.planar.monitor", {
            monitorId: "xy_midplane",
            nodeId: "model:planar:xy_midplane",
            type: "planar-monitor",
          })}
        />,
      );
    });

    // Definition tab starts in staged mode
    const commitBarDef = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
    );
    expect(commitBarDef?.getAttribute("data-mode")).toBe("staged");

    // Edit Plane offset -> CommitBar shows Revert + Apply and stays staged!
    const offsetLabel = findElement(
      container,
      (el) => el.tagName === "LABEL" && (el.textContent ?? "").includes("Plane offset"),
    );
    const offsetForId = offsetLabel?.getAttribute("for");
    const offsetInput = findElement(
      container,
      (el) => el.tagName === "INPUT" && el.getAttribute("id") === offsetForId,
    );
    expect(offsetInput).not.toBeNull();
    await act(async () => {
      focusAndSetInput(offsetInput!, "25");
      offsetInput!.dispatchEvent(new TestEvent("blur", { bubbles: true }));
    });

    expect(commitBarDef?.getAttribute("data-mode")).toBe("staged");
    expect(container.textContent).toContain("Apply");
    expect(container.textContent).toContain("Revert");

    // Switch to 2D Display tab -> commitModeOverride switches footer to liveViewport without destroying staged draft!
    const displayTab = findElement(
      container,
      (el) => el.getAttribute("role") === "tab" && (el.textContent ?? "").includes("2D Display"),
    );
    expect(displayTab).not.toBeNull();
    await act(async () => {
      displayTab!.click();
    });
    const commitBarDisplay = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
    );
    expect(commitBarDisplay?.getAttribute("data-mode")).toBe("liveViewport");

    await act(async () => {
      root.unmount();
    });
  });

  it("fixes LiveChart P0: renders physical X (7.41 ns) and Y (-0.1842) SI values + Copy Point + 3D View 8-slot template", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <LiveChartPointTemplatePanel
          selection={makeSelection("live.chart-point", {
            descriptorId: "magnetization",
            kind: "live.chart-point",
            nodeId: "live:chart:magnetization:pt:42",
            pointIndex: 42,
            revision: 9,
            seriesId: "m_y",
            type: "live-chart-point",
          })}
          testPointValues={{
            xSI: 7.41e-9,
            xUnit: "s",
            ySI: -0.1842,
            yUnit: "1",
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("7.41");
    expect(text).toContain("ns");
    expect(text).toMatch(/[-−]0\.1842/);
    expect(text).toContain("Copy Point");

    // Render standalone 3D View settings spec (without cross-module inspector import!)
    await act(async () => {
      root.render(<Viewport3DSettingsInspectorSpecView />);
    });
    expect(
      findElement(container, (el) => el.getAttribute("data-slot") === "inspector-root"),
    ).not.toBeNull();
    expect(findElements(container, (el) => el.tagName === "SELECT")).toEqual([]);
    expect((container.textContent ?? "").toLowerCase()).not.toContain("unknown");

    await act(async () => {
      root.unmount();
    });
  });
});
