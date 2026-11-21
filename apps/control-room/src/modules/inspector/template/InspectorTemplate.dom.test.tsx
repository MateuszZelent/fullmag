import { Atom, Layers, SlidersHorizontal, Sparkles } from "lucide-react";
import { act, useState, type ReactNode } from "react";
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

vi.mock("@radix-ui/react-context-menu", () => ({
  Root: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Group: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Sub: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Item: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CheckboxItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  RadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ItemIndicator: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Label: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Separator: () => <hr />,
}));

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div data-slot="mock-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div data-slot="mock-dialog-overlay" />,
  Content: ({
    children,
    role,
  }: {
    children?: ReactNode;
    role?: string;
  }) => (
    <div data-slot="mock-dialog-content" role={role ?? "dialog"}>
      {children}
    </div>
  ),
  Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  Close: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      className,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      className?: string;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div className={className}>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({
      children,
      className,
      ...props
    }: {
      children?: ReactNode;
      className?: string;
    }) => (
      <div className={className} role="tablist" {...props}>
        {children}
      </div>
    ),
    Trigger: ({
      children,
      className,
      value,
      onClick,
    }: {
      children?: ReactNode;
      className?: string;
      value: string;
      onClick?: () => void;
    }) => {
      const ctx = React.useContext(TabsCtx);
      const active = ctx.value === value;
      return (
        <button
          aria-selected={active}
          className={className}
          data-state={active ? "active" : "inactive"}
          data-value={value}
          role="tab"
          type="button"
          onClick={() => {
            onClick?.();
            ctx.onValueChange?.(value);
          }}
        >
          {children}
        </button>
      );
    },
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  };
});

import {
  InspectorTemplate,
  sanitizeInspectorFacts,
} from "./InspectorTemplate";
import type { InspectorFact, InspectorSpec } from "./types";

interface SampleDraft {
  name: string;
  ms: number;
  alpha: number;
  dmi: number;
  showVectors: boolean;
}

const BASE_DRAFT: SampleDraft = {
  name: "Permalloy film",
  ms: 8e5,
  alpha: 0.008,
  dmi: 0.0012,
  showVectors: true,
};

const BASE_SELECTION: Selection = {
  kind: "object.magnetic-parameters",
  label: "Permalloy film",
  moduleSource: "explorer",
  nodeId: "model:objects:film:material",
  objectId: "film",
  ref: { type: "object", objectId: "film" },
};

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

function attachReactInputShim(input: TestElement): TestInputCompat {
  const compat = input as TestInputCompat;
  if (!compat.attachEvent) {
    compat.attachEvent = (_name, listener) => {
      compat._onPropertyChange = listener;
    };
    compat.detachEvent = () => {
      compat._onPropertyChange = undefined;
    };
  }
  return compat;
}

function setInputValue(input: TestElement, nextValue: string): void {
  const compat = attachReactInputShim(input);
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
}

function createKeydownEvent(
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {},
): TestEvent {
  return Object.assign(new TestEvent("keydown", { bubbles: true, key }), modifiers);
}

function createSampleSpec(
  overrides: Partial<InspectorSpec<SampleDraft>> = {},
): InspectorSpec<SampleDraft> {
  return {
    id: "object.magnetic-parameters",
    header: {
      breadcrumbs: [
        { id: "model", label: "Model" },
        { id: "film", label: "film" },
        { id: "material", label: "Material" },
      ],
      canFitView: true,
      searchable: true,
    },
    identity: {
      domain: "material",
      icon: Atom,
      title: (draft) => draft.name,
      renameFieldKey: "name",
      kindLabel: "Material",
      entityId: "mat:py_film",
      statePill: () => ({ tone: "ok", label: "Committed" }),
    },
    facts: (draft) => [
      { id: "ms", label: "Ms", value: `${draft.ms / 1e3} kA/m` },
      { id: "alpha", label: "alpha", value: String(draft.alpha) },
    ],
    modeTabs: [
      { id: "core", label: "Core parameters" },
      { id: "anisotropy", label: "Anisotropy & DMI" },
    ],
    notices: () => [
      {
        id: "shared-warn",
        tone: "warn",
        title: "Shared material",
        text: "Editing updates two objects.",
      },
      {
        id: "range-err",
        tone: "err",
        title: "Out of bounds",
        text: "Damping must be positive.",
        focusFieldKey: "alpha",
      },
    ],
    sections: [
      {
        id: "core-sec",
        title: "Magnetization and damping",
        icon: SlidersHorizontal,
        modeTabId: "core",
        defaultOpen: true,
        summary: (draft) => `Ms ${draft.ms / 1e3} kA/m, alpha ${draft.alpha}`,
        rows: [
          {
            type: "quantity",
            key: "ms",
            label: "Saturation magnetization",
            symbol: "Ms",
            units: [{ unit: "kA/m", toSiFactor: 1e3 }],
          },
          {
            type: "number",
            key: "alpha",
            label: "Gilbert damping",
            symbol: "α",
          },
        ],
      },
      {
        id: "dmi-sec",
        title: "Interfacial DMI",
        icon: Sparkles,
        modeTabId: "anisotropy",
        defaultOpen: false,
        summary: (draft) => `D ${draft.dmi * 1e3} mJ/m²`,
        rows: [
          {
            type: "quantity",
            key: "dmi",
            label: "Interfacial DMI constant",
            symbol: "D",
            units: [{ unit: "mJ/m²", toSiFactor: 1e-3 }],
          },
        ],
      },
      {
        id: "live-sec",
        title: "Viewport overlays",
        icon: Layers,
        modeTabId: "core",
        defaultOpen: false,
        live: true,
        summary: (draft) => (draft.showVectors ? "Vectors on" : "Vectors off"),
        rows: [
          {
            type: "switch",
            key: "showVectors",
            label: "Show magnetization vectors",
          },
        ],
      },
    ],
    details: () => [
      { label: "Material ID", value: "mat:py_film", mono: true },
      { label: "Revision", value: "rev 4", mono: true },
    ],
    commitBar: {
      mode: "staged",
      cleanMessage: () => "Up to date · Scene rev 4",
      confirmApply: () => ({
        title: "Rebuild mesh after material update?",
        description: "Changing material properties invalidates cached results.",
        confirmLabel: "Apply changes",
      }),
      onApply: async () => true,
    },
    ...overrides,
  };
}

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
});

describe("InspectorTemplate", () => {
  it("sanitizes_forbidden_unknown_literals_and_caps_facts_at_four", () => {
    const rawFacts: InspectorFact[] = [
      { id: "f1", label: "Ms", value: "800 kA/m" },
      { id: "f2", label: "Broken 1", value: "unknown" },
      { id: "f3", label: "Broken 2", value: "Unavailable" },
      { id: "f4", label: "Broken 3", value: "n/a" },
      { id: "f5", label: "Broken 4", value: null },
      { id: "f6", label: "Aex", value: "13 pJ/m" },
      { id: "f7", label: "alpha", value: "0.008" },
      { id: "f8", label: "lex", value: "5.69 nm" },
      { id: "f9", label: "Extra", value: "999 nm" },
    ];

    const sanitized = sanitizeInspectorFacts(rawFacts);
    expect(sanitized.map((fact) => fact.id)).toEqual(["f1", "f6", "f7", "f8"]);

    const env = installSimulationPreparationTestDom();
    (
      env.document.defaultView as unknown as {
        getSelection?: () => {
          anchorNode: null;
          anchorOffset: number;
          focusNode: null;
          focusOffset: number;
          rangeCount: number;
        };
      }
    ).getSelection = () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      rangeCount: 0,
    });
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({ facts: () => rawFacts })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const factsList = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-facts",
      "inspector facts list",
    );
    expect(factsList.tagName).toBe("DL");
    const renderedFactsText = factsList.textContent;
    expect(renderedFactsText).toContain("800 kA/m");
    expect(renderedFactsText).toContain("13 pJ/m");
    expect(renderedFactsText).toContain("0.008");
    expect(renderedFactsText).toContain("5.69 nm");
    expect(renderedFactsText).not.toContain("unknown");
    expect(renderedFactsText).not.toContain("Unavailable");
    expect(renderedFactsText).not.toContain("n/a");
    expect(renderedFactsText).not.toContain("999 nm");

    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            facts: () => [
              { id: "u1", label: "A", value: "unknown" },
              { id: "u2", label: "B", value: "not available" },
              { id: "u3", label: "C", value: "unresolved" },
              { id: "u4", label: "D", value: "unavailable S/m" },
              { id: "u5", label: "E", value: "" },
              { id: "u6", label: "F", value: undefined },
            ],
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    expect(
      findElements(container, (el) => el.getAttribute("data-slot") === "inspector-facts"),
    ).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });

  it("collapses_facts_with_scroll_hysteresis_40px_4px", () => {
    const env = installSimulationPreparationTestDom();
    (
      env.document.defaultView as unknown as {
        getSelection?: () => {
          anchorNode: null;
          anchorOffset: number;
          focusNode: null;
          focusOffset: number;
          rangeCount: number;
        };
      }
    ).getSelection = () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      rangeCount: 0,
    });
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec()}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const header = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-header",
      "inspector header",
    );
    const factsWrap = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-facts-wrap",
      "facts wrapper",
    );
    const scrollArea = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-scroll",
      "scroll body",
    );

    expect(header.getAttribute("data-scrolled")).toBe("false");
    expect(factsWrap.getAttribute("data-collapsed")).toBe("false");

    act(() => {
      (scrollArea as unknown as { scrollTop: number }).scrollTop = 45;
      scrollArea.dispatchEvent(new TestEvent("scroll"));
    });
    expect(header.getAttribute("data-scrolled")).toBe("true");
    expect(factsWrap.getAttribute("data-collapsed")).toBe("true");

    // Hysteresis zone (4..40 px): stays collapsed to prevent layout oscillation.
    act(() => {
      (scrollArea as unknown as { scrollTop: number }).scrollTop = 20;
      scrollArea.dispatchEvent(new TestEvent("scroll"));
    });
    expect(header.getAttribute("data-scrolled")).toBe("true");
    expect(factsWrap.getAttribute("data-collapsed")).toBe("true");

    // Returning below 4 px expands Slot 3 facts again.
    act(() => {
      (scrollArea as unknown as { scrollTop: number }).scrollTop = 2;
      scrollArea.dispatchEvent(new TestEvent("scroll"));
    });
    expect(header.getAttribute("data-scrolled")).toBe("false");
    expect(factsWrap.getAttribute("data-collapsed")).toBe("false");

    act(() => {
      root.unmount();
    });
  });

  it("hides_section_summary_when_open_and_searches_across_mode_tabs", () => {
    const env = installSimulationPreparationTestDom();
    (
      env.document.defaultView as unknown as {
        getSelection?: () => {
          anchorNode: null;
          anchorOffset: number;
          focusNode: null;
          focusOffset: number;
          rangeCount: number;
        };
      }
    ).getSelection = () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      rangeCount: 0,
    });
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    function Harness() {
      const [activeTab, setActiveTab] = useState("core");
      return (
        <InspectorTemplate
          activeModeTabId={activeTab}
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec()}
          touchedFields={new Set()}
          onActiveModeTabChange={setActiveTab}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />
      );
    }

    act(() => {
      root.render(<Harness />);
    });

    const coreSection = findElement(
      container,
      (el) => el.getAttribute("data-section-id") === "core-sec",
      "core section",
    );
    expect(coreSection.getAttribute("data-state")).toBe("open");
    const coreSummary = findElement(
      coreSection,
      (el) => el.getAttribute("data-slot") === "inspector-section-summary",
      "core section summary",
    );
    expect(coreSummary.getAttribute("data-visible")).toBe("false");

    const liveSection = findElement(
      container,
      (el) => el.getAttribute("data-section-id") === "live-sec",
      "live section",
    );
    expect(liveSection.getAttribute("data-state")).toBe("closed");
    const liveSummary = findElement(
      liveSection,
      (el) => el.getAttribute("data-slot") === "inspector-section-summary",
      "live section summary",
    );
    expect(liveSummary.getAttribute("data-visible")).toBe("true");
    expect(liveSummary.textContent).toContain("Vectors on");

    // DMI section belongs to the "anisotropy" mode tab and is hidden prior to searching.
    expect(
      findElements(container, (el) => el.getAttribute("data-section-id") === "dmi-sec"),
    ).toHaveLength(0);

    // Open property search via Ctrl+F inside Inspector.
    const aside = findElement(container, (el) => el.tagName === "ASIDE", "inspector aside");
    act(() => {
      aside.dispatchEvent(createKeydownEvent("f", { ctrlKey: true }));
    });

    const searchInput = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-search-input",
      "property search input",
    );

    act(() => {
      attachReactInputShim(searchInput);
      searchInput.focus();
      searchInput.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
    });
    act(() => {
      setInputValue(searchInput, "DMI");
    });

    // Searching expands and reveals matching rows across ALL modeTabs.
    const matchedDmiSection = findElement(
      container,
      (el) => el.getAttribute("data-section-id") === "dmi-sec",
      "matched DMI section",
    );
    expect(matchedDmiSection.getAttribute("data-state")).toBe("open");
    expect(matchedDmiSection.textContent).toContain("Interfacial DMI constant");
    const searchCount = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-search-count",
      "search match counter",
    );
    expect(searchCount.textContent).toContain("1 match");

    // Pressing Escape closes search and restores prior tab & collapsed state.
    act(() => {
      searchInput.dispatchEvent(createKeydownEvent("Escape"));
    });

    expect(
      findElements(container, (el) => el.getAttribute("data-section-id") === "dmi-sec"),
    ).toHaveLength(0);
    const restoredLiveSection = findElement(
      container,
      (el) => el.getAttribute("data-section-id") === "live-sec",
      "restored live section",
    );
    expect(restoredLiveSection.getAttribute("data-state")).toBe("closed");

    act(() => {
      root.unmount();
    });
  });

  it("renders_commit_bar_modes_exclusively_and_confirms_costly_apply", async () => {
    const env = installSimulationPreparationTestDom();
    (
      env.document.defaultView as unknown as {
        getSelection?: () => {
          anchorNode: null;
          anchorOffset: number;
          focusNode: null;
          focusOffset: number;
          rangeCount: number;
        };
      }
    ).getSelection = () => ({
      anchorNode: null,
      anchorOffset: 0,
      focusNode: null,
      focusOffset: 0,
      rangeCount: 0,
    });
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const onApply = vi.fn(async () => true);
    const onFocusField = vi.fn();

    // 1. Clean staged mode: Revert/Apply hidden; warn notice uses role="status", err uses role="alert".
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            commitBar: {
              mode: "staged",
              cleanMessage: () => "Up to date · Scene rev 4",
              confirmApply: () => ({
                title: "Confirm costly apply",
                description: "Rebuilds simulation state.",
                confirmLabel: "Proceed with apply",
              }),
              onApply,
            },
          })}
          touchedFields={new Set()}
          onApply={onApply}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onFocusField={onFocusField}
          onRevertField={() => undefined}
        />,
      );
    });

    const warnNotice = findElement(
      container,
      (el) => el.getAttribute("data-notice-id") === "shared-warn",
      "warn notice",
    );
    expect(warnNotice.getAttribute("role")).toBe("status");
    const errNotice = findElement(
      container,
      (el) => el.getAttribute("data-notice-id") === "range-err",
      "err notice",
    );
    expect(errNotice.getAttribute("role")).toBe("alert");

    const stagedActionsClean = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "commit-bar-staged-actions",
      "staged actions clean",
    );
    expect(stagedActionsClean.getAttribute("data-visible")).toBe("false");

    // 2. Dirty valid staged mode: Ctrl+Enter opens confirmApply AlertDialog; confirming invokes onApply.
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set(["ms"])}
          draft={{ ...BASE_DRAFT, ms: 8.2e5 }}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            commitBar: {
              mode: "staged",
              confirmApply: () => ({
                title: "Confirm costly apply",
                description: "Rebuilds simulation state.",
                confirmLabel: "Proceed with apply",
              }),
              onApply,
            },
          })}
          touchedFields={new Set(["ms"])}
          onApply={onApply}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onFocusField={onFocusField}
          onRevertField={() => undefined}
        />,
      );
    });

    const stagedActionsDirty = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "commit-bar-staged-actions",
      "staged actions dirty",
    );
    expect(stagedActionsDirty.getAttribute("data-visible")).toBe("true");

    const aside = findElement(container, (el) => el.tagName === "ASIDE", "inspector aside");
    act(() => {
      aside.dispatchEvent(createKeydownEvent("Enter", { ctrlKey: true }));
    });

    const alertDialog = findElement(
      container,
      (el) => el.getAttribute("role") === "alertdialog",
      "costly apply AlertDialog",
    );
    expect(alertDialog.textContent).toContain("Confirm costly apply");
    expect(onApply).not.toHaveBeenCalled();

    const confirmBtn = findElement(
      alertDialog,
      (el) => el.tagName === "BUTTON" && el.textContent.includes("Proceed with apply"),
      "confirm apply button",
    );
    await act(async () => {
      confirmBtn.click();
    });
    expect(onApply).toHaveBeenCalledTimes(1);

    // 3. Staged dirty invalid: clicking "Fix 1 field to apply" calls focusField on first invalid key.
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set(["alpha"])}
          draft={{ ...BASE_DRAFT, alpha: -0.1 }}
          invalidFields={new Map([["alpha", "Damping must be positive."]])}
          selection={BASE_SELECTION}
          spec={createSampleSpec()}
          touchedFields={new Set(["alpha"])}
          onApply={onApply}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onFocusField={onFocusField}
          onRevertField={() => undefined}
        />,
      );
    });

    const fixLink = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.textContent.includes("Fix 1 field to apply"),
      "fix invalid fields link",
    );
    act(() => {
      fixLink.click();
    });
    expect(onFocusField).toHaveBeenCalledWith("alpha");

    // 4. liveViewport mode: Reset display only when hasOverrides === true, never Apply.
    const onResetDisplay = vi.fn();
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            commitBar: {
              mode: "liveViewport",
              hasOverrides: () => true,
              onResetDisplay,
            },
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onResetDisplay={onResetDisplay}
          onRevertField={() => undefined}
        />,
      );
    });

    const commitBarLive = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
      "live commit bar",
    );
    expect(commitBarLive.textContent).toContain("Reset display");
    expect(commitBarLive.textContent).not.toContain("Apply");

    // 5. readOnly mode: zero mutation buttons.
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            commitBar: {
              mode: "readOnly",
              statusMessage: () => "Read-only · Run #14 completed",
            },
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const commitBarReadOnly = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-commit-bar",
      "readOnly commit bar",
    );
    expect(commitBarReadOnly.textContent).toContain("Read-only · Run #14 completed");
    expect(findElements(commitBarReadOnly, (el) => el.tagName === "BUTTON")).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });
});
