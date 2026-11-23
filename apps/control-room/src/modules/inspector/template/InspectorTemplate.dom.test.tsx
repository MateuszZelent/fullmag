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
import { publishSelectionPath } from "@/kernel/selection/selectionPath";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { PanelFrame } from "@/shared/ui/PanelFrame";

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

import { InspectorHostProvider } from "./InspectorHostContext";
import {
  InspectorTemplate,
  sanitizeInspectorFacts,
} from "./InspectorTemplate";
import type { InspectorFact, InspectorSpec } from "./types";
import {
  resetPersistedInspectorModeTabs,
  useInspectorSpecController,
  type InspectorSpecController,
} from "./useInspectorSpecController";

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
  ref: {
    kind: "object.magnetic-parameters",
    nodeId: "model:objects:film:material",
    objectId: "film",
    type: "scene-object",
    visualizationTargetId: "object:film",
  },
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
  resetPersistedInspectorModeTabs();
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
      env.document as unknown as {
        querySelector?: () => null;
      }
    ).querySelector = () => null;
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
      env.document as unknown as {
        querySelector?: () => null;
      }
    ).querySelector = () => null;
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
      env.document as unknown as {
        querySelector?: () => null;
      }
    ).querySelector = () => null;
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
      env.document as unknown as {
        querySelector?: () => null;
      }
    ).querySelector = () => null;
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

  it("unifies_slot_1_panel_chrome_with_single_breadcrumbs_single_overflow_menu_and_hidden_metadata", () => {
    const env = installSimulationPreparationTestDom();
    (
      env.document as unknown as {
        querySelector?: () => null;
      }
    ).querySelector = () => null;
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
    restoreDom = () => {
      publishSelectionPath(null);
      env.restore();
    };
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const onFocus = vi.fn();
    const onSelectBreadcrumb = vi.fn();
    const onToggleVisibility = vi.fn();

    publishSelectionPath({
      nodeId: "model:airbox:visualization",
      crumbs: [
        {
          id: "session",
          label: "Session Model",
          selection: {
            kind: "session.root",
            label: "Session Model",
            nodeId: "model:session",
            objectId: null,
            ref: null,
          },
        },
        {
          id: "airbox",
          label: "Airbox",
          selection: {
            kind: "airbox.root",
            label: "Airbox",
            nodeId: "model:airbox",
            objectId: null,
            ref: null,
          },
        },
        {
          id: "viz",
          label: "Visualization",
        },
      ],
    });

    act(() => {
      root.render(
        <PanelFrame
          dockHandle={<button aria-label="Move Inspector panel" type="button" />}
          id="panel-right"
          mode="docked"
          title="Inspector"
          visible
          onHide={onToggleVisibility}
          onModeChange={() => undefined}
        >
          <InspectorHostProvider
            value={{
              descriptor: {
                breadcrumbs: [],
                domain: "visualization",
                icon: "airbox",
                metadata: [
                  { label: "Kind", value: "airbox.visualization" },
                  { label: "Node", value: "model:airbox:visualization" },
                ],
                ownerId: "airbox-visualization",
                status: null,
                tabs: [],
                title: "Airbox Visualization",
                typeLabel: "Airbox display",
              },
              focusDisabled: false,
              onFocus,
              onSelectBreadcrumb,
              onToggleVisibility,
            }}
          >
            <InspectorTemplate
              baseline={BASE_DRAFT}
              dirtyFields={new Set()}
              draft={BASE_DRAFT}
              invalidFields={new Map()}
              selection={{
                kind: "airbox.visualization",
                label: "Visualization",
                moduleSource: "explorer",
                nodeId: "model:airbox:visualization",
                objectId: null,
                ref: null,
              }}
              spec={createSampleSpec({
                header: {
                  breadcrumbs: [{ id: "short", label: "Short path" }],
                  canFitView: false,
                  searchable: true,
                },
              })}
              touchedFields={new Set()}
              onFieldChange={() => undefined}
              onFieldTouch={() => undefined}
              onRevertField={() => undefined}
            />
          </InspectorHostProvider>
        </PanelFrame>,
      );
    });

    // Exactly ONE inspector root, ONE breadcrumb nav, ONE overflow menu trigger, ONE Hide Inspector button.
    expect(
      findElements(container, (el) => el.getAttribute("data-slot") === "inspector-root"),
    ).toHaveLength(1);
    const inspectorAside = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-root",
      "inspector root",
    );
    expect(inspectorAside.getAttribute("data-inspector-owner")).toBe("airbox-visualization");

    expect(
      findElements(container, (el) => el.tagName === "NAV"),
    ).toHaveLength(1);
    const airboxCrumbBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Airbox",
      "Airbox breadcrumb button",
    );
    act(() => {
      airboxCrumbBtn.click();
    });
    expect(onSelectBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "airbox.root", nodeId: "model:airbox" }),
    );

    // Fit view in Slot 1 calls host.onFocus when focusDisabled is false.
    const fitBtn = findElement(
      container,
      (el) => el.getAttribute("aria-label") === "Fit view to selection",
      "Fit view button",
    );
    act(() => {
      fitBtn.click();
    });
    expect(onFocus).toHaveBeenCalledTimes(1);

    // Exactly ONE overflow menu trigger ("Inspector panel menu", zero duplicate "More actions").
    expect(
      findElements(
        container,
        (el) => el.getAttribute("aria-label") === "Inspector panel menu",
      ),
    ).toHaveLength(1);
    expect(
      findElements(
        container,
        (el) => el.getAttribute("aria-label") === "More actions",
      ),
    ).toHaveLength(0);

    // Merged menu includes Inspector node actions and PanelFrame actions, omitting "Show as Python" without a handler.
    const menuItems = findElements(
      container,
      (el) => el.getAttribute("role") === "menuitem",
    ).map((item) => item.textContent.trim());
    expect(menuItems).toContain("Copy node ID");
    expect(menuItems).not.toContain("Show as Python");
    expect(menuItems).toContain("Expand all sections");
    expect(menuItems).toContain("Hide panel");

    // Hide Inspector button routes through chrome.hideWith(host.onToggleVisibility).
    const hideBtn = findElement(
      container,
      (el) => el.getAttribute("data-panel-toggle") === "inspector",
      "Hide Inspector button",
    );
    act(() => {
      hideBtn.click();
    });
    expect(onToggleVisibility).toHaveBeenCalledTimes(1);

    // Hidden metadata list stays attached for browser smoke audits.
    const metadataDl = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "inspector-metadata",
      "hidden inspector metadata",
    );
    expect(metadataDl.hasAttribute("hidden")).toBe(true);
    expect(metadataDl.textContent).toContain("model:airbox:visualization");

    // Re-render with a 4-option segmented row and a switch row to verify wide stacking & switch modifier.
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            modeTabs: undefined,
            sections: [
              {
                id: "viz-sec",
                title: "Display",
                icon: Layers,
                defaultOpen: true,
                rows: [
                  {
                    type: "segmented",
                    key: "name",
                    label: "Surface mode",
                    options: [
                      { value: "shaded", label: "Shaded" },
                      { value: "edges", label: "Edges" },
                      { value: "wireframe", label: "Wireframe" },
                      { value: "points", label: "Points" },
                    ],
                  },
                  {
                    type: "switch",
                    key: "showVectors",
                    label: "Show magnetization vectors",
                  },
                ],
              },
            ],
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const segmentedRow = findElement(
      container,
      (el) => el.getAttribute("data-row") === "name",
      "4-option segmented row",
    );
    expect(segmentedRow.className).toContain("fm-inspector-row--wide");

    const switchRow = findElement(
      container,
      (el) => el.getAttribute("data-row") === "showVectors",
      "switch row",
    );
    expect(switchRow.className).toContain("fm-inspector-row--switch");

    act(() => {
      root.unmount();
    });
  });

  it("shows and enables Apply without Revert when allowCleanApply is true on a clean staged draft", async () => {
    const env = installSimulationPreparationTestDom();
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const onApply = vi.fn(async () => true);

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
              allowCleanApply: true,
              applyLabel: (_draft, dirty) => (dirty ? "Apply Texture" : "Reapply Texture"),
              cleanMessage: () => "Up to date with scene revision 4",
              onApply,
            },
          })}
          touchedFields={new Set()}
          onApply={onApply}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const stagedActions = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "commit-bar-staged-actions",
      "staged actions with allowCleanApply",
    );
    expect(stagedActions.getAttribute("data-visible")).toBe("true");

    const actionButtons = findElements(stagedActions, (el) => el.tagName === "BUTTON");
    expect(actionButtons).toHaveLength(1);
    expect(actionButtons[0]?.textContent).toContain("Reapply Texture");
    expect(stagedActions.textContent).not.toContain("Revert");

    await act(async () => {
      actionButtons[0]?.click();
    });
    expect(onApply).toHaveBeenCalledTimes(1);

    // Ctrl+Enter also triggers clean apply.
    const aside = findElement(container, (el) => el.tagName === "ASIDE", "inspector aside");
    await act(async () => {
      aside.dispatchEvent(createKeydownEvent("Enter", { ctrlKey: true }));
    });
    expect(onApply).toHaveBeenCalledTimes(2);

    // Once dirty, both Revert and Apply Texture appear.
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set(["ms"])}
          draft={{ ...BASE_DRAFT, ms: 8.5e5 }}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            commitBar: {
              mode: "staged",
              allowCleanApply: true,
              applyLabel: (_draft, dirty) => (dirty ? "Apply Texture" : "Reapply Texture"),
              onApply,
            },
          })}
          touchedFields={new Set(["ms"])}
          onApply={onApply}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const dirtyButtons = findElements(stagedActions, (el) => el.tagName === "BUTTON");
    expect(dirtyButtons).toHaveLength(2);
    expect(stagedActions.textContent).toContain("Revert");
    expect(stagedActions.textContent).toContain("Apply Texture");

    act(() => {
      root.unmount();
    });
  });

  it("executes_confirmPendingApply_and_commits_draft_when_confirming_costly_apply_with_useInspectorSpecController", async () => {
    const env = installSimulationPreparationTestDom();
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const committedPayloads: SampleDraft[] = [];
    const onApply = vi.fn(async (draft: SampleDraft): Promise<void> => {
      committedPayloads.push(draft);
    });

    const spec = createSampleSpec({
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Up to date · Scene rev 4",
        confirmApply: (draft) => ({
          title: `Rebuild mesh for alpha=${draft.alpha}?`,
          description: "Discretization changes invalidate cached results.",
          confirmLabel: "Confirm & Rebuild",
        }),
        onApply,
      },
    });

    let latestController!: InspectorSpecController<SampleDraft>;

    function ControllerBackedHarness() {
      const controller = useInspectorSpecController(spec, BASE_SELECTION, BASE_DRAFT);
      latestController = controller;
      return (
        <InspectorTemplate
          activeModeTabId={controller.activeModeTabId}
          animationKey={controller.animationKey}
          appliedFlash={controller.appliedFlash}
          applyError={controller.applyError}
          applying={controller.applying}
          baseline={controller.baseline}
          dirtyFields={controller.dirtyFields}
          displayUnits={controller.displayUnits}
          draft={controller.draft}
          forceShowErrors={controller.forceShowErrors}
          invalidFields={controller.invalidFields}
          selection={BASE_SELECTION}
          spec={spec}
          touchedFields={controller.touchedFields}
          onActiveModeTabChange={controller.setActiveModeTabId}
          onApply={controller.requestApply}
          onDisplayUnitChange={controller.setDisplayUnit}
          onFieldChange={controller.setField}
          onFieldTouch={controller.touchField}
          onFocusField={controller.focusField}
          onParseErrorChange={controller.setParseError}
          onPatchDraft={controller.patchDraft}
          onResetDisplay={controller.resetDisplay}
          onRevertAll={controller.revertAll}
          onRevertField={controller.revertField}
        />
      );
    }

    act(() => {
      root.render(<ControllerBackedHarness />);
    });

    expect(latestController.phase).toBe("stagedClean");

    // Stage an edit via controller.
    act(() => {
      latestController.setField("alpha", 0.025);
    });
    expect(latestController.dirty).toBe(true);
    expect(latestController.phase).toBe("dirtyValid");

    const stagedActions = findElement(
      container,
      (el) => el.getAttribute("data-slot") === "commit-bar-staged-actions",
      "staged actions bar",
    );
    const applyBtn = findElement(
      stagedActions,
      (el) => el.tagName === "BUTTON" && el.textContent.includes("Apply"),
      "Apply button",
    );

    // 1. Clicking Apply opens the confirmation dialog and transitions controller to confirmCostly.
    act(() => {
      applyBtn.click();
    });
    expect(latestController.phase).toBe("confirmCostly");
    expect(onApply).not.toHaveBeenCalled();

    const firstDialog = findElement(
      container,
      (el) => el.getAttribute("role") === "alertdialog",
      "first confirmation dialog",
    );
    expect(firstDialog.textContent).toContain("Rebuild mesh for alpha=0.025?");

    // Cancelling closes the dialog, restores dirtyValid, and does not invoke onApply.
    const cancelBtn = findElement(
      firstDialog,
      (el) => el.tagName === "BUTTON" && el.textContent.trim() === "Cancel",
      "Cancel button",
    );
    act(() => {
      cancelBtn.click();
    });
    expect(
      findElements(container, (el) => el.getAttribute("role") === "alertdialog"),
    ).toHaveLength(0);
    expect(latestController.phase).toBe("dirtyValid");
    expect(latestController.dirty).toBe(true);
    expect(onApply).not.toHaveBeenCalled();

    // 2. Clicking Apply again and confirming executes confirmPendingApply() -> onApply and commits!
    act(() => {
      applyBtn.click();
    });
    const secondDialog = findElement(
      container,
      (el) => el.getAttribute("role") === "alertdialog",
      "second confirmation dialog",
    );
    const confirmBtn = findElement(
      secondDialog,
      (el) => el.tagName === "BUTTON" && el.textContent.includes("Confirm & Rebuild"),
      "Confirm & Rebuild button",
    );

    await act(async () => {
      confirmBtn.click();
    });

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(committedPayloads).toHaveLength(1);
    expect(committedPayloads[0]?.alpha).toBe(0.025);
    expect(latestController.dirty).toBe(false);
    expect(latestController.appliedFlash).toBe(true);
    expect(latestController.phase).toBe("appliedFlash");

    act(() => {
      root.unmount();
    });
  });

  it("resolves_both_string_and_function_confirmTitle_and_confirmMessage_without_TypeError", async () => {
    const env = installSimulationPreparationTestDom();
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const onDeleteStatic = vi.fn(async () => undefined);
    const onDeleteDynamic = vi.fn(async () => undefined);

    // 1. Static string confirmTitle + confirmMessage
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            header: {
              breadcrumbs: [{ id: "transport", label: "Charge Transport" }],
              deleteAction: {
                label: "Delete Charge Transport",
                confirmTitle: "Delete charge transport?",
                confirmMessage: "Removes current source from session.",
                onDelete: onDeleteStatic,
              },
            },
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const deleteStaticItem = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        el.textContent.includes("Delete Charge Transport"),
      "static delete menuitem",
    );
    act(() => {
      deleteStaticItem.click();
    });

    const staticDialog = findElement(
      container,
      (el) => el.getAttribute("role") === "alertdialog",
      "static delete confirmation dialog",
    );
    expect(staticDialog.textContent).toContain("Delete charge transport?");
    expect(staticDialog.textContent).toContain("Removes current source from session.");

    const confirmStaticBtn = findElement(
      staticDialog,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.includes("Delete Charge Transport"),
      "confirm static delete button",
    );
    await act(async () => {
      confirmStaticBtn.click();
    });
    expect(onDeleteStatic).toHaveBeenCalledTimes(1);

    // 2. Function confirmTitle + function confirmMessage / confirmDescription
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={{ ...BASE_DRAFT, name: "CoFeB strip" }}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            header: {
              breadcrumbs: [{ id: "film", label: "CoFeB strip" }],
              deleteAction: {
                label: "Delete Object",
                confirmTitle: (d) => `Delete "${d.name}"?`,
                confirmMessage: (d) => `Permanently deletes ${d.name} (Ms=${d.ms}).`,
                onDelete: onDeleteDynamic,
              },
            },
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const deleteDynamicItem = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        el.textContent.includes("Delete Object"),
      "dynamic delete menuitem",
    );
    act(() => {
      deleteDynamicItem.click();
    });

    const dynamicDialog = findElement(
      container,
      (el) => el.getAttribute("role") === "alertdialog",
      "dynamic delete confirmation dialog",
    );
    expect(dynamicDialog.textContent).toContain('Delete "CoFeB strip"?');
    expect(dynamicDialog.textContent).toContain(
      "Permanently deletes CoFeB strip (Ms=800000).",
    );

    const confirmDynamicBtn = findElement(
      dynamicDialog,
      (el) => el.tagName === "BUTTON" && el.textContent.includes("Delete Object"),
      "confirm dynamic delete button",
    );
    await act(async () => {
      confirmDynamicBtn.click();
    });
    expect(onDeleteDynamic).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("hides_show_as_python_without_handler_and_opens_preview_when_onOpenCodePreview_is_provided", () => {
    const env = installSimulationPreparationTestDom();
    restoreDom = env.restore;
    const container = env.document.createElement("div");
    env.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    // 1. Without onOpenCodePreview: "Show as Python" is hidden.
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            toPythonModuleSnippet: (d) => `film.ms = ${d.ms}`,
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onRevertField={() => undefined}
        />,
      );
    });

    const menuItemsWithoutHandler = findElements(
      container,
      (el) => el.getAttribute("role") === "menuitem",
    ).map((el) => el.textContent.trim());
    expect(menuItemsWithoutHandler).not.toContain("Show as Python");

    // 2. With onOpenCodePreview: "Show as Python" renders and invokes the handler.
    const onOpenCodePreview = vi.fn();
    act(() => {
      root.render(
        <InspectorTemplate
          baseline={BASE_DRAFT}
          dirtyFields={new Set()}
          draft={BASE_DRAFT}
          invalidFields={new Map()}
          selection={BASE_SELECTION}
          spec={createSampleSpec({
            toPythonModuleSnippet: (d) => `film.ms = ${d.ms}`,
          })}
          touchedFields={new Set()}
          onFieldChange={() => undefined}
          onFieldTouch={() => undefined}
          onOpenCodePreview={onOpenCodePreview}
          onRevertField={() => undefined}
        />,
      );
    });

    const showPythonItem = findElement(
      container,
      (el) =>
        el.getAttribute("role") === "menuitem" &&
        el.textContent.includes("Show as Python"),
      "Show as Python menuitem",
    );
    act(() => {
      showPythonItem.click();
    });
    expect(onOpenCodePreview).toHaveBeenCalledWith(
      "Permalloy film as Python",
      "python",
      "film.ms = 800000",
    );

    act(() => {
      root.unmount();
    });
  });
});
