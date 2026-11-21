import { act, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { JsonValue, SceneResource } from "@/kernel/api/apiTypes";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

vi.mock("@radix-ui/react-tooltip", () => ({
  Provider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <span data-slot="mock-tooltip-content">{children}</span>
  ),
}));

vi.mock("@radix-ui/react-hover-card", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-hover-card">{children}</div>
  ),
}));

vi.mock("@radix-ui/react-dropdown-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => (
    <div data-slot="mock-dropdown-menu-content">{children}</div>
  ),
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
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
      onClick={() => onSelect?.(new TestEvent("select") as unknown as Event)}
    >
      {children}
    </button>
  ),
}));

vi.mock("@radix-ui/react-select", () => ({
  Root: ({
    children,
    onValueChange,
    value,
  }: {
    children?: ReactNode;
    onValueChange?: (val: string) => void;
    value?: string;
  }) => (
    <div
      data-mock-select-value={value}
      onClick={(e) => {
        const target = e.target as unknown as { getAttribute?: (k: string) => string | null };
        const itemVal = target?.getAttribute?.("data-mock-item-value");
        if (itemVal && onValueChange) onValueChange(itemVal);
      }}
    >
      {children}
    </div>
  ),
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder ?? ""}</span>,
  Trigger: ({ children, ...props }: { children?: ReactNode; "aria-label"?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollUpButton: () => null,
  ScrollDownButton: () => null,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => null,
  Item: ({ children, value }: { children?: ReactNode; value: string }) => (
    <button data-mock-item-value={value} type="button">
      {children}
    </button>
  ),
  ItemText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { StageTextureAssignmentsEditor } from "./StageTextureAssignmentsEditor";

describe("stage texture assignment editor", () => {
  it("adds the chosen region to the draft, preserves explicit repeats, and uses zero raw <select> controls", async () => {
    const scene = {
      revision: 12,
      objects: [
        {
          id: "film",
          name: "Film",
          role: "magnet",
          regions: [
            {
              region_id: "core",
              name: "Core",
              shape: { kind: "box", size: [100e-9, 100e-9, 5e-9] },
            },
          ],
        },
      ],
    } as SceneResource;
    const changes: (JsonValue | undefined)[] = [];

    function Editor() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState<JsonValue | undefined>();
      return (
        <StageTextureAssignmentsEditor
          disabledReason={null}
          open={open}
          scene={scene}
          value={value}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onOpenChange={setOpen}
        />
      );
    }

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const button = (label: string) =>
      findElement(
        container,
        (element) => element.tagName === "BUTTON" && element.textContent.includes(label),
        label,
      );

    try {
      await act(async () => root.render(<Editor />));
      await act(async () => button("Add texture change").click());

      expect(findElements(container, (el) => el.tagName === "SELECT")).toHaveLength(0);

      const coreItem = findElement(
        container,
        (el) => el.getAttribute("data-mock-item-value") === "core",
        "Core region option",
      );
      await act(async () => coreItem.click());

      for (let index = 0; index < 2; index += 1) {
        await act(async () => button("Use object texture").click());
        await act(async () => button("Add to stage").click());
        if (index === 0) await act(async () => button("Add texture change").click());
      }

      const assignment = { object_id: "film", region_id: "core", initializer: null };
      expect(changes).toEqual([
        { schema_version: "fullmag.magnetization-assignments.v1", assignments: [assignment] },
        {
          schema_version: "fullmag.magnetization-assignments.v1",
          assignments: [assignment, assignment],
        },
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("renders Preset parameters & Placement & transform controls and supports editing an existing stage assignment in-place", async () => {
    const scene = {
      revision: 12,
      objects: [
        {
          id: "disk",
          name: "Nanodisk",
          role: "magnet",
          geometry: {
            geometry_kind: "Cylinder",
            geometry_params: { radius: 50e-9, height: 5e-9 },
          },
        },
      ],
    } as SceneResource;

    let latestValue: JsonValue | undefined;

    function Editor() {
      const [open, setOpen] = useState(false);
      const [value, setValue] = useState<JsonValue | undefined>();
      latestValue = value;
      return (
        <StageTextureAssignmentsEditor
          disabledReason={null}
          open={open}
          scene={scene}
          value={value}
          onChange={(next) => {
            latestValue = next;
            setValue(next);
          }}
          onOpenChange={setOpen}
        />
      );
    }

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => root.render(<Editor />));

      const addBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Add texture change"),
        "Add texture change",
      );
      await act(async () => addBtn.click());

      // Verify shared Preset parameters & Placement & transform sections are mounted
      expect(
        findElement(
          container,
          (el) => el.getAttribute("data-section-id") === "preset-parameters",
          "Preset parameters section",
        ),
      ).toBeDefined();
      expect(
        findElement(
          container,
          (el) => el.getAttribute("data-section-id") === "placement-transform",
          "Placement & transform section",
        ),
      ).toBeDefined();

      // Edit Uniform direction to +Z via the Vector3 axis preset button inside Preset parameters
      const directionRow = findElement(
        container,
        (el) => el.getAttribute("data-row") === "direction",
        "Uniform direction row",
      );
      const plusZBtn = findElement(
        directionRow,
        (el) => el.tagName === "BUTTON" && el.textContent.trim() === "+Z",
        "+Z axis preset button",
      );
      await act(async () => plusZBtn.click());

      const addToStageBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Add to stage"),
        "Add to stage",
      );
      await act(async () => addToStageBtn.click());

      expect(latestValue).toMatchObject({
        schema_version: "fullmag.magnetization-assignments.v1",
        assignments: [
          {
            object_id: "disk",
            region_id: null,
            initializer: {
              kind: "preset_texture",
              preset_kind: "uniform",
              preset_version: 2,
              preset_params: { direction: [0, 0, 1] },
            },
          },
        ],
      });

      // Now click Edit on the committed assignment card and switch it to Bloch skyrmion with core_polarity +1
      const editBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Edit"),
        "Edit existing assignment button",
      );
      await act(async () => editBtn.click());

      const skyrmionTile = findElement(
        container,
        (el) => el.getAttribute("data-preset-tile") === "bloch_skyrmion",
        "bloch_skyrmion tile",
      );
      await act(async () => skyrmionTile.click());

      const corePolarityRow = findElement(
        container,
        (el) => el.getAttribute("data-row") === "corePolarity",
        "Core polarity row",
      );
      const upCoreBtn = findElement(
        corePolarityRow,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Up (+1)"),
        "Up (+1) core polarity button",
      );
      await act(async () => upCoreBtn.click());

      const saveBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && el.textContent.includes("Save texture change"),
        "Save texture change button",
      );
      await act(async () => saveBtn.click());

      expect(latestValue).toMatchObject({
        schema_version: "fullmag.magnetization-assignments.v1",
        assignments: [
          {
            object_id: "disk",
            region_id: null,
            initializer: {
              kind: "preset_texture",
              preset_kind: "bloch_skyrmion",
              preset_version: 2,
              preset_params: {
                core_polarity: 1,
                radius: 25e-9,
                wall_width: 5e-9,
              },
            },
          },
        ],
      });
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
