import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { EMPTY_SELECTION } from "@/kernel/selection/selectionTypes";

vi.mock("@radix-ui/react-dropdown-menu", async () => {
  const React = await import("react");
  const MenuContext = React.createContext<{
    open: boolean;
    setOpen: (next: boolean) => void;
  }>({ open: false, setOpen: () => undefined });
  const RadioContext = React.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  }>({});
  return {
    Root: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <MenuContext.Provider value={{ open, setOpen }}>
          {children}
        </MenuContext.Provider>
      );
    },
    Trigger: ({ children, asChild: _asChild, ...props }: { children: ReactNode; asChild?: boolean }) => {
      const { open, setOpen } = React.useContext(MenuContext);
      if (React.isValidElement(children)) {
        const child = children as React.ReactElement<{ onClick?: () => void }>;
        return React.cloneElement(child, {
          ...props,
          onClick: () => {
            child.props.onClick?.();
            setOpen(!open);
          },
        });
      }
      return (
        <button type="button" onClick={() => setOpen(!open)} {...props}>
          {children}
        </button>
      );
    },
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({
      children,
      align: _align,
      collisionPadding: _collisionPadding,
      sideOffset: _sideOffset,
      ...props
    }: {
      children: ReactNode;
      align?: string;
      collisionPadding?: number;
      sideOffset?: number;
    }) => {
      const { open } = React.useContext(MenuContext);
      return open ? (
        <div role="menu" {...props}>
          {children}
        </div>
      ) : null;
    },
    Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Separator: () => <hr />,
    Item: ({ children, onSelect, disabled }: { children: ReactNode; onSelect?: () => void; disabled?: boolean }) => {
      const { setOpen } = React.useContext(MenuContext);
      return (
        <button
          disabled={disabled}
          role="menuitem"
          type="button"
          onClick={() => {
            if (!disabled) {
              onSelect?.();
              setOpen(false);
            }
          }}
        >
          {children}
        </button>
      );
    },
    CheckboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    RadioGroup: ({
      children,
      value,
      onValueChange,
    }: {
      children: ReactNode;
      value?: string;
      onValueChange?: (value: string) => void;
    }) => (
      <RadioContext.Provider value={{ value, onValueChange }}>
        <div role="group">{children}</div>
      </RadioContext.Provider>
    ),
    RadioItem: ({ children, value }: { children: ReactNode; value: string }) => {
      const radio = React.useContext(RadioContext);
      const menu = React.useContext(MenuContext);
      return (
        <button
          aria-checked={radio.value === value}
          data-unit-option={value}
          role="menuitemradio"
          type="button"
          onClick={() => {
            radio.onValueChange?.(value);
            menu.setOpen(false);
          }}
        >
          {children}
        </button>
      );
    },
    ItemIndicator: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Sub: ({ children }: { children: ReactNode }) => <>{children}</>,
    SubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@radix-ui/react-context-menu", async () => {
  const React = await import("react");
  const ContextMenuState = React.createContext<{
    open: boolean;
    setOpen: (next: boolean) => void;
  }>({ open: false, setOpen: () => undefined });
  return {
    Root: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <ContextMenuState.Provider value={{ open, setOpen }}>
          {children}
        </ContextMenuState.Provider>
      );
    },
    Trigger: ({ children }: { children: ReactNode }) => {
      const { setOpen } = React.useContext(ContextMenuState);
      return (
        <div
          data-slot="context-menu-trigger-mock"
          onContextMenu={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {children}
        </div>
      );
    },
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => {
      const { open } = React.useContext(ContextMenuState);
      return open ? <div role="menu">{children}</div> : null;
    },
    Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Separator: () => <hr />,
    Item: ({
      children,
      disabled,
      onSelect,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onSelect?: () => void;
    }) => {
      const { setOpen } = React.useContext(ContextMenuState);
      return (
        <button
          disabled={disabled}
          role="menuitem"
          type="button"
          onClick={() => {
            if (!disabled) {
              onSelect?.();
              setOpen(false);
            }
          }}
        >
          {children}
        </button>
      );
    },
    CheckboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    RadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    RadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ItemIndicator: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    Sub: ({ children }: { children: ReactNode }) => <>{children}</>,
    SubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    SubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@radix-ui/react-popover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-popover")>();
  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

vi.mock("@radix-ui/react-tooltip", async () => {
  return {
    Provider: ({ children }: { children: ReactNode }) => <>{children}</>,
    Root: ({ children }: { children: ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: ReactNode }) => (
      <span data-slot="tooltip-content">{children}</span>
    ),
  };
});

import { PropertyRow } from "./PropertyRow";
import { resetFieldErrorAnnouncer } from "./fieldErrorAnnouncer";
import type { InspectorActionContext, InspectorRowSpec } from "./types";
import { computeDragScrubValueSI } from "./unitConversion";

interface MaterialDraft {
  ms: number;
  alpha: number;
  rows: Array<{ _rowId: string; name: string; value: string }>;
}

const MU0_TO_SI = 1 / (4e-7 * Math.PI);

function createMockActionContext(
  draft: MaterialDraft,
  baseline: MaterialDraft,
  setField: InspectorActionContext<MaterialDraft>["setField"],
  revertField: InspectorActionContext<MaterialDraft>["revertField"],
): InspectorActionContext<MaterialDraft> {
  return {
    specId: "object.material",
    selection: EMPTY_SELECTION,
    draft,
    baseline,
    setField,
    patchDraft: () => undefined,
    revertField,
    focusField: () => undefined,
    selectNode: () => undefined,
    openCodePreview: () => undefined,
    notify: () => undefined,
  };
}

type TestInputCompat = TestElement & {
  _valueTracker?: { setValue: (next: string) => void };
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  attachEvent?: (
    name: string,
    fn: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
  detachEvent?: (
    name: string,
    fn: (event: {
      propertyName: string;
      target: TestElement;
      srcElement: TestElement;
    }) => void,
  ) => void;
};

function setInputValue(input: TestElement, value: string): void {
  const compat = input as TestInputCompat;
  const previous = input.value;
  input.value = value;
  compat._valueTracker?.setValue(previous);
  if (compat._onPropertyChange) {
    compat._onPropertyChange({
      propertyName: "value",
      target: input,
      srcElement: input,
    });
  } else {
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  }
}

function focusInput(input: TestElement): void {
  const compat = input as TestInputCompat;
  compat.attachEvent ??= (_name, fn) => {
    compat._onPropertyChange = fn;
  };
  compat.detachEvent ??= () => {
    compat._onPropertyChange = undefined;
  };
  input.focus();
  input.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
}

function blurInput(input: TestElement): void {
  const compat = input as TestInputCompat;
  compat.attachEvent ??= (_name, fn) => {
    compat._onPropertyChange = fn;
  };
  compat.detachEvent ??= () => {
    compat._onPropertyChange = undefined;
  };
  input.dispatchEvent(new TestEvent("focusout", { bubbles: true }));
}

afterEach(() => {
  resetFieldErrorAnnouncer();
  vi.useRealTimers();
});

describe("PropertyRow scientific quantity, scrub, table, and accessibility contracts", () => {
  it("preserves_partial_scientific_input_and_switches_units_without_dirtying_draft", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const baseline: MaterialDraft = {
      ms: 8e5,
      alpha: 0.01,
      rows: [],
    };
    const setFieldSpy = vi.fn();

    const msRow: InspectorRowSpec<MaterialDraft> = {
      key: "ms",
      label: "Saturation magnetization",
      symbol: (
        <>
          M<sub>s</sub>
        </>
      ),
      type: "quantity",
      defaultDisplayUnit: "kA/m",
      units: [
        { unit: "A/m", toSiFactor: 1 },
        { unit: "kA/m", toSiFactor: 1e3 },
        { unit: "MA/m", toSiFactor: 1e6 },
        { unit: "T", toSiFactor: MU0_TO_SI },
      ],
      scrub: "log",
      step: 1,
      min: 0,
    };

    function Harness() {
      const [draft, setDraft] = useState<MaterialDraft>(baseline);
      const [unit, setUnit] = useState<string>("kA/m");
      const [touched, setTouched] = useState(false);

      const handleSetField: InspectorActionContext<MaterialDraft>["setField"] = (
        key,
        value,
      ) => {
        setFieldSpy(key, value);
        setDraft((prev) => ({ ...prev, [key]: value }));
      };
      const handleRevertField: InspectorActionContext<MaterialDraft>["revertField"] = (
        key,
      ) => {
        setDraft((prev) => ({ ...prev, [key]: baseline[key] }));
      };

      return (
        <PropertyRow
          ctx={createMockActionContext(
            draft,
            baseline,
            handleSetField,
            handleRevertField,
          )}
          displayUnit={unit}
          liveRow={false}
          row={msRow}
          touched={touched}
          onDisplayUnitChange={setUnit}
          onTouchField={() => setTouched(true)}
        />
      );
    }

    try {
      await act(async () => {
        root.render(<Harness />);
      });

      const input = findElement(
        container,
        (el) => el.tagName === "INPUT" && el.getAttribute("data-slot") === "input-group-control",
        "quantity input",
      );
      expect(input.value).toBe("800");

      // 1. Switch display unit from kA/m -> MA/m on a clean row: no setField, stays clean.
      const unitButton = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "input-group-button",
        "unit menu button",
      );
      await act(async () => {
        unitButton.click();
      });
      const megaOption = findElement(
        container,
        (el) => el.getAttribute("data-unit-option") === "MA/m",
        "MA/m unit option",
      );
      await act(async () => {
        megaOption.click();
      });
      expect(input.value).toBe("0.8");
      expect(setFieldSpy).not.toHaveBeenCalled();
      expect(
        findElements(
          container,
          (el) => el.getAttribute("aria-label") === "Revert Saturation magnetization",
        ),
      ).toHaveLength(0);

      // 2. Switch to T (mu0 * Ms) and back to kA/m without dirtying draft.
      await act(async () => {
        unitButton.click();
      });
      const teslaOption = findElement(
        container,
        (el) => el.getAttribute("data-unit-option") === "T",
        "T unit option",
      );
      await act(async () => {
        teslaOption.click();
      });
      expect(input.value).toMatch(/^1\.0053/);
      expect(setFieldSpy).not.toHaveBeenCalled();

      await act(async () => {
        unitButton.click();
      });
      const kiloOption = findElement(
        container,
        (el) => el.getAttribute("data-unit-option") === "kA/m",
        "kA/m unit option",
      );
      await act(async () => {
        kiloOption.click();
      });
      expect(input.value).toBe("800");
      expect(setFieldSpy).not.toHaveBeenCalled();

      // 3. Focus and type intermediate scientific & decimal strings without clobbering or NaN.
      await act(async () => {
        focusInput(input);
      });
      for (const intermediate of ["-", "0.00", "2,5", "1.5e-"]) {
        await act(async () => {
          setInputValue(input, intermediate);
        });
        expect(input.value).toBe(intermediate);
        expect(input.value).not.toContain("NaN");
      }

      // 4. Complete "1.5e-1" (kA/m) and blur -> setField("ms", 150)
      await act(async () => {
        setInputValue(input, "1.5e-1");
      });
      expect(input.value).toBe("1.5e-1");
      await act(async () => {
        blurInput(input);
      });
      expect(setFieldSpy).toHaveBeenLastCalledWith("ms", 150);
      expect(input.value).toBe("0.15");

      // 5. Blurring an incomplete scientific string keeps the parse error visible across re-render.
      await act(async () => {
        focusInput(input);
        setInputValue(input, "1.5e-");
      });
      await act(async () => {
        blurInput(input);
      });
      expect(input.value).toBe("1.5e-");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(
        findElement(
          container,
          (el) => el.getAttribute("data-slot") === "field-error",
          "parse error message after invalid blur",
        ).textContent,
      ).toContain("Enter a valid number");

      // 6. Clicking Revert restores baseline display ("800") and clears the parse error.
      const revertBtn = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Revert Saturation magnetization",
        "revert field button",
      );
      await act(async () => {
        revertBtn.click();
      });
      expect(input.value).toBe("800");
      expect(input.getAttribute("aria-invalid")).toBe("false");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("computes_linear_and_logarithmic_drag_scrub_with_shift_and_alt_modifiers", () => {
    expect(
      computeDragScrubValueSI({
        startValueSI: 1e-11,
        deltaPx: 120,
        stepDisplay: 0.1,
        toSiFactor: 1e-12,
        mode: "log",
        shiftKey: false,
        altKey: false,
      }),
    ).toBeCloseTo(1e-10, 15);

    expect(
      computeDragScrubValueSI({
        startValueSI: 1e-11,
        deltaPx: 12,
        stepDisplay: 0.1,
        toSiFactor: 1e-12,
        mode: "log",
        shiftKey: true,
        altKey: false,
      }),
    ).toBeCloseTo(1e-10, 15);

    const altResult = computeDragScrubValueSI({
      startValueSI: 1e-11,
      deltaPx: 120,
      stepDisplay: 0.1,
      toSiFactor: 1e-12,
      mode: "log",
      shiftKey: false,
      altKey: true,
    });
    const expectedAlt = 10 ** 0.1 * 1e-11;
    expect(Math.abs(altResult - expectedAlt) / expectedAlt).toBeLessThan(1e-3);

    expect(
      computeDragScrubValueSI({
        startValueSI: 0.01,
        deltaPx: 5,
        stepDisplay: 0.001,
        toSiFactor: 1,
        mode: "lin",
        shiftKey: false,
        altKey: false,
      }),
    ).toBeCloseTo(0.015, 10);
  });

  it("enforces_stable_rowKey_on_table_and_announces_errors_only_after_touch", async () => {
    vi.useFakeTimers();
    const dom = installSimulationPreparationTestDom({
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const baseline: MaterialDraft = {
      ms: 8e5,
      alpha: -0.02,
      rows: [
        { _rowId: "row-stable-1", name: "Core", value: "800 kA/m" },
        { _rowId: "row-stable-2", name: "Edge", value: "640 kA/m" },
      ],
    };

    const alphaRow: InspectorRowSpec<MaterialDraft> = {
      key: "alpha",
      label: "Gilbert damping",
      symbol: "α",
      type: "number",
      validate: (value) =>
        typeof value === "number" && value < 0 ? "Damping must be non-negative." : null,
      toPythonSnippet: (value) => `mat.alpha = ${String(value)}`,
    };

    const tableRow: InspectorRowSpec<MaterialDraft> = {
      label: "Region overrides",
      type: "table",
      rowKey: (entry: MaterialDraft["rows"][number]) => entry._rowId,
      rows: (d) => d.rows,
      columns: [
        { id: "name", header: "Region", renderCell: (r: MaterialDraft["rows"][number]) => r.name },
        { id: "value", header: "Ms", align: "right", renderCell: (r: MaterialDraft["rows"][number]) => r.value },
      ],
    };

    const revertSpy = vi.fn();

    function Harness() {
      const [draft, setDraft] = useState<MaterialDraft>(baseline);
      const [touched, setTouched] = useState(false);

      const handleSetField: InspectorActionContext<MaterialDraft>["setField"] = (
        key,
        value,
      ) => {
        setDraft((prev) => ({ ...prev, [key]: value }));
      };
      const handleRevertField: InspectorActionContext<MaterialDraft>["revertField"] = (
        key,
      ) => {
        revertSpy(key);
        setDraft((prev) => ({ ...prev, [key]: baseline[key] }));
      };
      const ctx = createMockActionContext(
        draft,
        baseline,
        handleSetField,
        handleRevertField,
      );

      return (
        <div>
          <PropertyRow
            ctx={ctx}
            liveRow={false}
            row={alphaRow}
            touched={touched}
            onTouchField={() => setTouched(true)}
          />
          <PropertyRow
            ctx={ctx}
            liveRow={false}
            row={tableRow}
          />
        </div>
      );
    }

    try {
      await act(async () => {
        root.render(<Harness />);
      });

      const input = findElement(
        container,
        (el) => el.tagName === "INPUT" && el.getAttribute("data-slot") === "input-group-control",
        "alpha number input",
      );

      // Before interaction: explicit aria-invalid="false" and no live announcement.
      expect(input.getAttribute("aria-invalid")).toBe("false");
      expect(
        findElements(container, (el) => el.getAttribute("data-slot") === "field-error"),
      ).toHaveLength(0);

      // Table renders stable data-row-key attributes from rowKey().
      const renderedRows = findElements(
        container,
        (el) => el.getAttribute("data-row-key") !== null,
      );
      expect(renderedRows.map((el) => el.getAttribute("data-row-key"))).toEqual([
        "row-stable-1",
        "row-stable-2",
      ]);

      // Blur triggers touch -> aria-invalid="true" + polite live announcement after 120ms.
      await act(async () => {
        focusInput(input);
        blurInput(input);
      });
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const errorEl = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "field-error",
        "field error element",
      );
      expect(errorEl.textContent).toBe("Damping must be non-negative.");

      await act(async () => {
        vi.advanceTimersByTime(130);
      });
      const announcer = findElement(
        dom.document.body,
        (el) => el.getAttribute("data-slot") === "inspector-field-error-announcer",
        "shared polite field error announcer",
      );
      expect(announcer.getAttribute("aria-live")).toBe("polite");
      expect(announcer.textContent).toContain("Damping must be non-negative.");

      // Right-click opens ContextMenu with Copy value, Copy as Python, Revert field.
      const trigger = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "context-menu-trigger-mock",
        "context menu trigger",
      );
      await act(async () => {
        trigger.dispatchEvent(new TestEvent("contextmenu", { bubbles: true }));
      });
      const menuItems = findElements(
        container,
        (el) => el.getAttribute("role") === "menuitem",
      ).map((el) => el.textContent.trim());
      expect(menuItems).toEqual(
        expect.arrayContaining(["Copy value", "Copy as Python", "Revert field"]),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("renders_vector3_error_below_axis_grid_and_supports_per_field_revert", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    interface VectorDraft {
      axis: readonly [number, number, number];
    }

    const baseline: VectorDraft = { axis: [0, 0, 1] };
    const vectorRow: InspectorRowSpec<VectorDraft> = {
      key: "axis",
      label: "Easy axis",
      symbol: "u",
      type: "vector3",
      axisPresets: true,
      normalizeAction: true,
      validate: (vec) =>
        Math.hypot(vec[0], vec[1], vec[2]) === 0 ? "Axis vector must be non-zero." : null,
    };

    function VectorHarness() {
      const [draft, setDraft] = useState<VectorDraft>({ axis: [0, 0, 0] });
      const ctx: InspectorActionContext<VectorDraft> = {
        specId: "object.material",
        selection: EMPTY_SELECTION,
        draft,
        baseline,
        setField: (key, val) => setDraft((prev) => ({ ...prev, [key]: val })),
        patchDraft: (partial) => setDraft((prev) => ({ ...prev, ...partial })),
        revertField: (key) => setDraft((prev) => ({ ...prev, [key]: baseline[key] })),
        focusField: () => undefined,
        selectNode: () => undefined,
        openCodePreview: () => undefined,
        notify: () => undefined,
      };
      return <PropertyRow ctx={ctx} forceShowErrors liveRow={false} row={vectorRow} />;
    }

    try {
      await act(async () => {
        root.render(<VectorHarness />);
      });

      const grid = findElement(
        container,
        (el) => el.className.includes("fm-inspector-vector3__grid"),
        "vector3 axis grid",
      );
      const errorEl = findElement(
        container,
        (el) => el.getAttribute("data-slot") === "field-error",
        "vector3 field error",
      );
      // Error renders below the 3-column axis grid, never inside it.
      expect(grid.contains(errorEl)).toBe(false);
      expect(errorEl.textContent).toBe("Axis vector must be non-zero.");

      const revertBtn = findElement(
        container,
        (el) => el.getAttribute("aria-label") === "Revert Easy axis",
        "per-field revert button",
      );
      await act(async () => {
        revertBtn.click();
      });

      expect(
        findElements(container, (el) => el.getAttribute("data-slot") === "field-error"),
      ).toHaveLength(0);
      expect(
        findElements(container, (el) => el.getAttribute("aria-label") === "Revert Easy axis"),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
