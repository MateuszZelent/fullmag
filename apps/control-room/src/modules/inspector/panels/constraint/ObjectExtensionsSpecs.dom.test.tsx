import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  findElement,
  findElements,
  mountWave4TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  Item: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={() => onSelect?.()}>
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
vi.mock("@radix-ui/react-select", () => ({
  Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Trigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  Icon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Separator: () => <hr />,
}));
vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel?: string }) => (
    <div aria-label={ariaLabel} data-slot="echart-mock" />
  ),
}));

const mocks = vi.hoisted(() => ({
  patchObject: vi.fn().mockResolvedValue({ revision: 6 }),
  sceneData: {
    revision: 5,
    materials: [{ id: "py", name: "Permalloy", properties: { alpha: 0.008 } }],
    objects: [
      {
        id: "strip-1",
        name: "Waveguide",
        role: "magnet",
        material_ref: "py",
        regions: [{ region_id: "edge", name: "Edge" }],
        absorbing_boundary: {
          layers: [
            {
              layer_id: "sal-plane",
              name: "Cut Plane Layer",
              enabled: true,
              region_id: "deleted-reg",
              total_width_m: 40e-9,
              ramp_width_m: 30e-9,
              max_damping: 0,
              profile: "smootherstep",
              frame: "object",
              geometry: {
                kind: "plane",
                origin: [0, 0, 0],
                normal: [1, 0, 0],
              },
            },
          ],
        },
      },
    ],
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({
    api: {
      model: {
        patchObject: mocks.patchObject,
      },
    },
    commands: {
      execute: vi.fn(),
      getSessionScopeKey: () => "session-1",
    },
    resources: {
      invalidate: vi.fn(),
      setOptimisticData: vi.fn(),
    },
    selection: {
      set: vi.fn(),
    },
  }),
}));

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({
    data: mocks.sceneData,
    sessionScopeKey: "session-1",
    status: "ready",
    error: null,
  }),
}));

import { ObjectAbsorbingBoundaryInspectorPanel } from "./ObjectExtensionsSpecs";

describe("ObjectAbsorbingBoundaryInspectorPanel parity", () => {
  let mounted: ReturnType<typeof mountWave4TestElement> | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    mocks.patchObject.mockClear();
  });

  it("preserves maxDamping = 0, exposes Add layer / Duplicate layer / Reverse normal, and surfaces Missing region fallback", () => {
    const selection: Selection = {
      kind: "object.absorbing-boundary",
      label: "Absorbing Boundary",
      moduleSource: "explorer",
      nodeId: "model:object:strip-1:absorbing-boundary",
      objectId: "strip-1",
      ref: {
        kind: "object.absorbing-boundary",
        nodeId: "model:object:strip-1:absorbing-boundary",
        objectId: "strip-1",
        type: "scene-object",
      },
    };

    mounted = mountWave4TestElement(
      <ObjectAbsorbingBoundaryInspectorPanel selection={selection} />,
    );

    // Peak alpha reflects maxDamping = 0 (0.008 + 0 = 0.008), not coerced to 0.5
    expect(mounted.host.textContent).toContain("0.008");
    expect(mounted.host.textContent).toContain("Missing region (deleted-reg)");

    const addBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Add layer")),
    );
    const dupBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Duplicate layer")),
    );
    const reverseBtn = findElement(
      mounted.host,
      (el) => el.tagName === "BUTTON" && Boolean(el.textContent?.includes("Reverse normal")),
    );
    expect(addBtn).not.toBeNull();
    expect(dupBtn).not.toBeNull();
    expect(reverseBtn).not.toBeNull();

    // Duplicate layer creates "Cut Plane Layer copy"
    act(() => {
      dupBtn?.dispatchEvent(new TestEvent("click", { bubbles: true }));
    });
    expect(mounted.host.textContent).toContain("Cut Plane Layer copy");

    // Inactive layer 1 still has deleted-reg -> cross-layer validation notice appears!
    expect(mounted.host.textContent).toContain("Cut Plane Layer validation error");

    expect(findElements(mounted.host, (el) => el.tagName === "SELECT")).toHaveLength(0);
    expect(mounted.host.textContent).not.toMatch(/\b(unknown|unavailable)\b/i);
  });
});
