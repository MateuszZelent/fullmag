import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MaskFieldDriveResource,
  ReadyAntennaResource,
  RegionalFieldDriveResource,
  SceneDocument,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { InspectorEditSessionProvider } from "../../InspectorEditSession";
import {
  findElements,
  mountWave4TestElement,
  type TestElement,
  TestEvent,
} from "../model-roots/wave4TestDom.test-support";

/* ── Interactive Radix UI Primitives for Full End-to-End DOM Testing ── */

const SelectTestCtx = createContext<{
  disabled?: boolean;
  value?: string;
  onValueChange?: (val: string) => void;
}>({});

function stripRadixProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (
      k === "asChild" ||
      k === "collisionPadding" ||
      k === "sideOffset" ||
      k === "align" ||
      k === "position" ||
      k === "alignOffset" ||
      k === "onOpenChange" ||
      k === "onValueChange" ||
      k === "onCheckedChange" ||
      k === "onSelect" ||
      k === "onInteractOutside" ||
      k === "onPointerDownOutside" ||
      k === "onEscapeKeyDown" ||
      k === "onOpenAutoFocus" ||
      k === "onCloseAutoFocus" ||
      k === "defaultOpen" ||
      k === "modal"
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

vi.mock("@radix-ui/react-select", () => {
  const passthrough = (slot: string) => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("div", { ...stripRadixProps(props), "data-radix-slot": slot }, children);
    Comp.displayName = `RadixSelect_${slot}`;
    return Comp;
  };
  return {
    Root: ({
      children,
      disabled,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      disabled?: boolean;
      value?: string;
      onValueChange?: (v: string) => void;
    }) =>
      createElement(
        SelectTestCtx.Provider,
        { value: { disabled, value, onValueChange } },
        createElement("div", { "data-radix-select-root": "true", "data-value": value }, children),
      ),
    Trigger: ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("button", { type: "button", ...stripRadixProps(props) }, children),
    Value: ({ placeholder }: { placeholder?: string }) => {
      const ctx = useContext(SelectTestCtx);
      return createElement("span", null, ctx.value ?? placeholder ?? "");
    },
    Icon: passthrough("select-icon"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Content: passthrough("select-content"),
    Viewport: passthrough("select-viewport"),
    Group: passthrough("select-group"),
    Label: passthrough("select-label"),
    Item: ({
      children,
      disabled,
      value,
      ...props
    }: Record<string, unknown> & {
      children?: ReactNode;
      disabled?: boolean;
      value: string;
    }) => {
      const ctx = useContext(SelectTestCtx);
      return createElement(
        "button",
        {
          type: "button",
          role: "option",
          "data-select-item-value": value,
          disabled: Boolean(disabled || ctx.disabled),
          ...stripRadixProps(props),
          onClick: () => {
            if (!disabled && !ctx.disabled) {
              ctx.onValueChange?.(value);
            }
          },
        },
        children,
      );
    },
    ItemText: passthrough("select-item-text"),
    ItemIndicator: passthrough("select-item-indicator"),
    ScrollUpButton: passthrough("select-scroll-up"),
    ScrollDownButton: passthrough("select-scroll-down"),
    Separator: passthrough("select-separator"),
  };
});

vi.mock("@radix-ui/react-switch", () => ({
  Root: ({
    checked,
    children,
    disabled,
    onCheckedChange,
    ...props
  }: Record<string, unknown> & {
    checked?: boolean;
    children?: ReactNode;
    disabled?: boolean;
    onCheckedChange?: (next: boolean) => void;
  }) =>
    createElement(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        disabled: Boolean(disabled),
        ...stripRadixProps(props),
        onClick: () => {
          if (!disabled) onCheckedChange?.(!checked);
        },
      },
      children,
    ),
  Thumb: () => createElement("span", { "data-radix-slot": "switch-thumb" }),
}));

vi.mock("@radix-ui/react-slider", () => {
  const passthrough = (slot: string) => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("div", { ...stripRadixProps(props), "data-radix-slot": slot }, children);
    return Comp;
  };
  return {
    Root: passthrough("slider-root"),
    Track: passthrough("slider-track"),
    Range: passthrough("slider-range"),
    Thumb: passthrough("slider-thumb"),
  };
});

vi.mock("@radix-ui/react-tooltip", () => {
  const passthrough = (slot: string) => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("div", { ...stripRadixProps(props), "data-radix-slot": slot }, children);
    return Comp;
  };
  return {
    Provider: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Root: passthrough("tooltip-root"),
    Trigger: passthrough("tooltip-trigger"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Content: () => null,
    Arrow: () => null,
  };
});

vi.mock("@radix-ui/react-hover-card", () => {
  const passthrough = (slot: string) => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("div", { ...stripRadixProps(props), "data-radix-slot": slot }, children);
    return Comp;
  };
  return {
    Root: passthrough("hover-card-root"),
    Trigger: passthrough("hover-card-trigger"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Content: () => null,
    Arrow: () => null,
  };
});

vi.mock("@radix-ui/react-popover", () => {
  const passthrough = (slot: string) => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("div", { ...stripRadixProps(props), "data-radix-slot": slot }, children);
    return Comp;
  };
  return {
    Root: passthrough("popover-root"),
    Trigger: passthrough("popover-trigger"),
    Anchor: passthrough("popover-anchor"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Content: passthrough("popover-content"),
    Close: passthrough("popover-close"),
    Arrow: () => null,
  };
});

vi.mock("@radix-ui/react-dropdown-menu", () => {
  const passthrough = (slot: string, tag = "div") => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) => {
      const effectiveTag = props.asChild ? "div" : tag;
      return createElement(
        effectiveTag,
        { ...stripRadixProps(props), "data-radix-slot": slot },
        children,
      );
    };
    return Comp;
  };
  return {
    Root: passthrough("dd-root"),
    Trigger: passthrough("dd-trigger", "button"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Content: passthrough("dd-content"),
    Group: passthrough("dd-group"),
    Label: passthrough("dd-label"),
    Item: ({
      children,
      onClick,
      onSelect,
      ...props
    }: Record<string, unknown> & {
      children?: ReactNode;
      onClick?: (e: unknown) => void;
      onSelect?: (e: unknown) => void;
    }) =>
      createElement(
        "button",
        {
          type: "button",
          ...stripRadixProps(props),
          "data-radix-slot": "dd-item",
          onClick: (event: unknown) => {
            onClick?.(event);
            onSelect?.(event);
          },
        },
        children,
      ),
    CheckboxItem: passthrough("dd-checkbox-item", "button"),
    RadioGroup: passthrough("dd-radio-group"),
    RadioItem: passthrough("dd-radio-item", "button"),
    ItemIndicator: passthrough("dd-item-indicator"),
    Separator: passthrough("dd-separator"),
    Sub: passthrough("dd-sub"),
    SubTrigger: passthrough("dd-sub-trigger", "button"),
    SubContent: passthrough("dd-sub-content"),
  };
});

vi.mock("@radix-ui/react-context-menu", () => {
  const passthrough = (slot: string) => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) =>
      createElement("div", { ...stripRadixProps(props), "data-radix-slot": slot }, children);
    return Comp;
  };
  return {
    Root: passthrough("cm-root"),
    Trigger: passthrough("cm-trigger"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Content: () => null,
    Group: passthrough("cm-group"),
    Label: passthrough("cm-label"),
    Item: passthrough("cm-item"),
    CheckboxItem: passthrough("cm-checkbox"),
    RadioGroup: passthrough("cm-radio-group"),
    RadioItem: passthrough("cm-radio"),
    ItemIndicator: passthrough("cm-indicator"),
    Separator: passthrough("cm-separator"),
    Sub: passthrough("cm-sub"),
    SubTrigger: passthrough("cm-sub-trigger"),
    SubContent: () => null,
  };
});

vi.mock("@radix-ui/react-alert-dialog", () => {
  const passthrough = (slot: string, tag = "div") => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) => {
      const effectiveTag = props.asChild ? "div" : tag;
      return createElement(
        effectiveTag,
        { ...stripRadixProps(props), "data-radix-slot": slot },
        children,
      );
    };
    return Comp;
  };
  return {
    Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? createElement("div", { "data-slot": "alert-dialog-open" }, children) : null,
    Trigger: passthrough("ad-trigger", "button"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Overlay: passthrough("ad-overlay"),
    Content: passthrough("ad-content"),
    Title: passthrough("ad-title"),
    Description: passthrough("ad-desc"),
    Action: passthrough("ad-action", "button"),
    Cancel: passthrough("ad-cancel", "button"),
  };
});

vi.mock("@radix-ui/react-dialog", () => {
  const passthrough = (slot: string, tag = "div") => {
    const Comp = ({
      children,
      ...props
    }: Record<string, unknown> & { children?: ReactNode }) => {
      const effectiveTag = props.asChild ? "div" : tag;
      return createElement(
        effectiveTag,
        { ...stripRadixProps(props), "data-radix-slot": slot },
        children,
      );
    };
    return Comp;
  };
  return {
    Root: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? createElement("div", { "data-slot": "dialog-open" }, children) : null,
    Trigger: passthrough("dlg-trigger", "button"),
    Portal: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
    Overlay: passthrough("dlg-overlay"),
    Content: passthrough("dlg-content"),
    Title: passthrough("dlg-title"),
    Description: passthrough("dlg-desc"),
    Close: passthrough("dlg-close", "button"),
  };
});

vi.mock("@/shared/charts/ScientificEChart", () => ({
  ScientificEChart: ({ ariaLabel }: { ariaLabel?: string }) =>
    createElement("div", {
      "aria-label": ariaLabel ?? "chart",
      "data-testid": "mock-scientific-echart",
    }),
}));

/* ── Mutable Test State & Spies ── */

const SCOPE_KEY = "session=s-wave4&epoch=2&request_scope_epoch=api%3A1";

const state = vi.hoisted(() => ({
  sessionScopeKey: "session=s-wave4&epoch=2&request_scope_epoch=api%3A1" as string | null,
  sceneRevision: 12,
  sceneData: null as SceneDocument | null,
  regionalDrives: [] as RegionalFieldDriveResource[],
  maskDrives: [] as MaskFieldDriveResource[],
  readyAntennas: [] as ReadyAntennaResource[],
  selectionCurrent: null as Selection | null,
  createFieldDrive: vi.fn(),
  replaceFieldDrive: vi.fn(),
  deleteFieldDrive: vi.fn(),
  createMaskFieldDrive: vi.fn(),
  replaceMaskFieldDrive: vi.fn(),
  deleteMaskFieldDrive: vi.fn(),
  maskFieldDrivesFetch: vi.fn(),
  readyAntennaTerms: vi.fn(),
  sceneFetch: vi.fn(),
  executeCommand: vi.fn(),
  invalidateResource: vi.fn(),
  setSelection: vi.fn(),
  historyRecord: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => {
  const kernelStub = {
    api: {
      model: {
        scene: (...args: unknown[]) => state.sceneFetch(...args),
        createFieldDrive: (...args: unknown[]) => state.createFieldDrive(...args),
        replaceFieldDrive: (...args: unknown[]) => state.replaceFieldDrive(...args),
        deleteFieldDrive: (...args: unknown[]) => state.deleteFieldDrive(...args),
        createMaskFieldDrive: (...args: unknown[]) => state.createMaskFieldDrive(...args),
        replaceMaskFieldDrive: (...args: unknown[]) => state.replaceMaskFieldDrive(...args),
        deleteMaskFieldDrive: (...args: unknown[]) => state.deleteMaskFieldDrive(...args),
        maskFieldDrives: (...args: unknown[]) => state.maskFieldDrivesFetch(...args),
        readyAntennaTerms: (...args: unknown[]) => state.readyAntennaTerms(...args),
      },
    },
    authoringHistory: {
      getGeneration: () => 1,
      record: (...args: unknown[]) => state.historyRecord(...args),
    },
    commands: {
      execute: (...args: unknown[]) => state.executeCommand(...args),
      get: (id: string) =>
        id === "study.add-run-stage" ? { id, disabledReason: () => null } : null,
      isEnabled: () => true,
      getSessionScopeKey: () => state.sessionScopeKey,
    },
    layout: {
      get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
      setPanelVisible: vi.fn(),
    },
    resources: {
      invalidate: (...args: unknown[]) => state.invalidateResource(...args),
    },
    selection: {
      get: () => state.selectionCurrent,
      set: (...args: unknown[]) => state.setSelection(...args),
    },
  };
  return {
    KernelContext: createContext(kernelStub),
    useKernel: () => kernelStub,
  };
});

vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  publishCommittedSceneResource: vi.fn(),
  useSceneResource: () => ({ data: state.sceneData, status: "ready", error: null }),
}));

vi.mock("@/kernel/resources/fieldDriveResources", () => ({
  useFieldDrivesResource: () => ({
    data: { drives: state.regionalDrives, scene_revision: state.sceneRevision },
    status: "ready",
    error: null,
  }),
}));

vi.mock("@/kernel/resources/maskAntennaResources", () => ({
  useMaskFieldDrivesResource: () => ({
    data: { drives: state.maskDrives, scene_revision: state.sceneRevision },
    status: "ready",
    error: null,
  }),
  useReadyAntennasResource: () => ({
    data: { antennas: state.readyAntennas },
    status: "ready",
    error: null,
  }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useRuntimeCommandControlResourceData: () => ({}),
}));

import {
  evaluateFieldDriveEnvelopeAtTime,
  FieldDriveInspectorPanel,
} from "../../inspectors/objects/field-drives";

/* ── Helpers ── */

function baseScene(overrides: Record<string, unknown> = {}): SceneDocument {
  return {
    revision: state.sceneRevision,
    objects: [
      {
        id: "waveguide-1",
        name: "YIG Waveguide",
        regions: [
          { id: "core", name: "Core channel" },
          { id: "edge", name: "Edge damper" },
        ],
      },
      {
        id: "strip-mask",
        name: "Microstrip Mask",
        regions: [],
      },
    ],
    outputs: {
      table_autosave: {
        sample_period_s: 20e-12, // f_Nyq = 25 GHz
      },
    },
    study: {
      stages: [
        { stage_id: "relax-init", kind: "relax" },
        { stage_id: "run-1", kind: "run", duration_s: 2e-9, output_every_seconds: 20e-12 },
        { stage_id: "run-2", kind: "run", duration_s: 4e-9, output_every_seconds: 10e-12 },
      ],
    },
    ...overrides,
  } as unknown as SceneDocument;
}

function sampleMaskDrive(overrides: Partial<MaskFieldDriveResource> = {}): MaskFieldDriveResource {
  return {
    id: "mask-antenna",
    name: "CPW Mask Antenna",
    schema_version: "mask_field_drive.v1",
    enabled: true,
    frame: "world",
    position_m: [0, 0, 50e-9],
    shape: {
      kind: "box",
      center: [0, 0, 0],
      size: [2e-6, 500e-9, 40e-9],
    },
    target: { kind: "object", object_id: "waveguide-1" },
    time_origin: "stage_local",
    activation: { kind: "all_time_evolution" },
    terms: [
      {
        name: "even_mode",
        mask: {
          kind: "function",
          function: {
            expression_version: "field_expr.v1",
            name: "cpw_even",
            parameters: [{ name: "B01", value: 0.002 }],
            locals: [{ name: "kx", expression: "2 * pi / 1e-6" }],
            outputs: ["B01 * cos(kx * x)", "0.0", "B01 * sin(kx * x)"],
          },
        },
        time: {
          expression_version: "field_expr.v1",
          name: "rf_sin",
          parameters: [{ name: "f0", value: 8e9 }],
          locals: [],
          outputs: ["sin(2 * pi * f0 * t)"],
        },
      },
      {
        name: "sampled_bias",
        mask: {
          kind: "sampled",
          size: [1200, 200, 9],
          cell_m: [5e-9, 5e-9, 5e-9],
          origin_m: [-3e-6, -500e-9, 0],
          encoding: "f32_le_base64",
          data: "AAAA",
          sha256: "0123456789abcdef0123456789abcdef",
        },
        time: null,
      },
    ],
    ...overrides,
  };
}

function findButtonByText(host: TestElement, text: string): TestElement {
  const match = findElements(host, (el) => {
    if (el.tagName !== "BUTTON") return false;
    const trimmed = el.textContent?.trim() ?? "";
    return trimmed === text || (text === "Apply" && trimmed.startsWith("Apply"));
  })[0];
  if (!match) {
    throw new Error(`Button "${text}" not found`);
  }
  return match;
}

function clickEl(element: TestElement): void {
  act(() => {
    element.dispatchEvent(new TestEvent("click", { bubbles: true }));
  });
}

function findInputByAriaLabel(host: TestElement, label: string): TestElement {
  const match = findElements(
    host,
    (el) => el.tagName === "INPUT" && el.getAttribute("aria-label") === label,
  )[0];
  if (!match) {
    throw new Error(`Input aria-label="${label}" not found`);
  }
  return match;
}

function findInputAfterLabel(host: TestElement, labelText: string): TestElement {
  const labels = findElements(
    host,
    (el) => el.tagName === "LABEL" && (el.textContent?.trim() ?? "").startsWith(labelText),
  );
  for (const label of labels) {
    const htmlFor = label.getAttribute("for");
    if (htmlFor) {
      const target = findElements(
        host,
        (el) => el.tagName === "INPUT" && el.getAttribute("id") === htmlFor,
      )[0];
      if (target) return target;
    }
  }
  throw new Error(`Labeled input "${labelText}" not found`);
}

function clickSelectOption(host: TestElement, optionValue: string): void {
  const opt = findElements(
    host,
    (el) =>
      el.tagName === "BUTTON" && el.getAttribute("data-select-item-value") === optionValue,
  )[0];
  if (!opt) {
    throw new Error(`Select option "${optionValue}" not found`);
  }
  clickEl(opt);
}

type TestInputCompat = TestElement & {
  _onPropertyChange?: (event: {
    propertyName: string;
    target: TestElement;
    srcElement: TestElement;
  }) => void;
  _valueTracker?: { setValue: (v: string) => void };
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

function setInputText(inputEl: TestElement, nextValue: string): void {
  const compat = attachReactInputShim(inputEl);
  act(() => {
    inputEl.focus();
    inputEl.dispatchEvent(new TestEvent("focusin", { bubbles: true }));
  });
  const previous = inputEl.value;
  act(() => {
    inputEl.value = nextValue;
    compat._valueTracker?.setValue(previous);
    if (compat._onPropertyChange) {
      compat._onPropertyChange({
        propertyName: "value",
        target: inputEl,
        srcElement: inputEl,
      });
      return;
    }
    inputEl.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  state.sessionScopeKey = SCOPE_KEY;
  state.sceneRevision = 12;
  state.sceneData = baseScene();
  state.regionalDrives = [];
  state.maskDrives = [];
  state.readyAntennas = [
    {
      function: "fullmag.antennas.cpw",
      summary: "Coplanar waveguide Oersted field",
      arguments: [
        { name: "current_A", unit: "A", default: 0.01, doc: "Peak RF current" },
        { name: "signal_width_m", unit: "m", default: 200e-9, doc: "Signal line width" },
      ],
    },
  ];
  state.selectionCurrent = null;

  state.createFieldDrive.mockReset().mockImplementation(async (req: { drive: RegionalFieldDriveResource }) => ({
    drive: req.drive,
    scene_revision: state.sceneRevision + 1,
    committed_scene: { ...state.sceneData, revision: state.sceneRevision + 1, created_drive_id: req.drive.id },
  }));
  state.replaceFieldDrive.mockReset().mockImplementation(async (_id: string, req: { drive: RegionalFieldDriveResource }) => ({
    drive: req.drive,
    scene_revision: state.sceneRevision + 1,
    committed_scene: { ...state.sceneData, revision: state.sceneRevision + 1, updated_drive_id: req.drive.id },
  }));
  state.deleteFieldDrive.mockReset().mockImplementation(async (id: string) => ({
    scene_revision: state.sceneRevision + 1,
    committed_scene: { ...state.sceneData, revision: state.sceneRevision + 1, deleted_drive_id: id },
  }));
  state.createMaskFieldDrive.mockReset().mockImplementation(async (req: { drive: MaskFieldDriveResource }) => ({
    drive: req.drive,
    scene_revision: state.sceneRevision + 1,
    committed_scene: { ...state.sceneData, revision: state.sceneRevision + 1, created_mask_id: req.drive.id },
  }));
  state.replaceMaskFieldDrive.mockReset().mockImplementation(async (_id: string, req: { drive: MaskFieldDriveResource }) => ({
    drive: req.drive,
    scene_revision: state.sceneRevision + 1,
    committed_scene: { ...state.sceneData, revision: state.sceneRevision + 1, updated_mask_id: req.drive.id },
  }));
  state.deleteMaskFieldDrive.mockReset().mockImplementation(async (id: string) => ({
    scene_revision: state.sceneRevision + 1,
    committed_scene: { ...state.sceneData, revision: state.sceneRevision + 1, deleted_mask_id: id },
  }));
  state.maskFieldDrivesFetch.mockReset().mockImplementation(async () => ({
    drives: state.maskDrives,
    scene_revision: state.sceneRevision,
  }));
  state.readyAntennaTerms.mockReset().mockResolvedValue({
    terms: [
      {
        name: "cpw_generated_1",
        origin: {
          function: "fullmag.antennas.cpw",
          arguments: { current_A: 0.02, signal_width_m: 200e-9 },
          call_index: 0,
          output_index: 0,
        },
        mask: {
          kind: "function",
          function: {
            expression_version: "field_expr.v1",
            name: "cpw_term",
            parameters: [{ name: "I0", value: 0.02 }],
            locals: [],
            outputs: ["I0 * 0.1", "0.0", "I0 * 0.05"],
          },
        },
        time: null,
      },
    ],
  });
  state.sceneFetch.mockReset().mockImplementation(async () => state.sceneData);
  state.executeCommand.mockReset().mockResolvedValue({ status: "ok" });
  state.invalidateResource.mockReset();
  state.setSelection.mockReset();
  state.historyRecord.mockReset();
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. Pure Envelope Math Backwards Compatibility & Restored Parameters
   ═══════════════════════════════════════════════════════════════════════════ */

describe("evaluateFieldDriveEnvelopeAtTime", () => {
  it("evaluates sinc_pulse with default and custom sincAmplitude, sinusoidal offset, and canonical step pulse", () => {
    expect(
      evaluateFieldDriveEnvelopeAtTime(
        {
          waveformKind: "sinc_pulse",
          cutoffFreqHz: 20e9,
          carrierFreqHz: 10e9,
          chirpStopFreqHz: 25e9,
          timeCenterS: 0.5e-9,
          pulseSigmaS: 0.1e-9,
          phaseRad: 0,
          piecewisePoints: [],
        },
        0.5e-9,
      ),
    ).toBeCloseTo(1, 9);

    expect(
      evaluateFieldDriveEnvelopeAtTime(
        {
          waveformKind: "sinc_pulse",
          cutoffFreqHz: 20e9,
          sincAmplitude: 0.35,
          carrierFreqHz: 10e9,
          chirpStopFreqHz: 25e9,
          timeCenterS: 0.5e-9,
          pulseSigmaS: 0.1e-9,
          phaseRad: 0,
          piecewisePoints: [],
        },
        0.5e-9,
      ),
    ).toBeCloseTo(0.35, 9);

    expect(
      evaluateFieldDriveEnvelopeAtTime(
        {
          waveformKind: "sinusoidal",
          cutoffFreqHz: 20e9,
          carrierFreqHz: 10e9,
          sinusoidalOffset: 0.25,
          chirpStopFreqHz: 25e9,
          timeCenterS: 0,
          pulseSigmaS: 0.1e-9,
          phaseRad: 0,
          piecewisePoints: [],
        },
        0,
      ),
    ).toBeCloseTo(0.25, 9);

    expect(
      evaluateFieldDriveEnvelopeAtTime(
        {
          waveformKind: "pulse",
          pulseOnS: 0.2e-9,
          pulseOffS: 0.8e-9,
          cutoffFreqHz: 20e9,
          carrierFreqHz: 10e9,
          chirpStopFreqHz: 25e9,
          timeCenterS: 0,
          pulseSigmaS: 0.1e-9,
          phaseRad: 0,
          piecewisePoints: [],
        },
        0.5e-9,
      ),
    ).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. Regional Field Drive Parity Tests
   ═══════════════════════════════════════════════════════════════════════════ */

describe("FieldDriveInspectorPanel — Regional Field Drive parity", () => {
  it("generates unique editable ID on new draft, supports starter waveform suffix & sourceObjectId, applies cleanly when untouched, and navigates away from draft", async () => {
    state.regionalDrives = [
      {
        id: "field-drive",
        kind: "regional",
        name: "Existing Drive",
        enabled: true,
        amplitude_B_T: 0.002,
        direction: [0, 1, 0],
        target: { kind: "global" },
        spatial_profile: { kind: "uniform" },
        waveform: { kind: "constant" },
        time_origin: "stage_local",
        activation: { kind: "all_time_evolution" },
      },
    ];

    const draftSelection: Selection = {
      kind: "physics.field-drive",
      label: "New Sinc Pulse Drive",
      moduleSource: "explorer",
      nodeId: "model:physics:field-drives:draft:regional:sinc_pulse",
      objectId: null,
      ref: {
        draft: true,
        fieldDriveKind: "regional",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:draft:regional:sinc_pulse",
        sourceObjectId: "strip-mask",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: draftSelection }),
      ),
    );

    const idInput = findInputAfterLabel(mounted.host, "ID");
    expect((idInput as unknown as { value: string }).value).toBe("field-drive-2");

    // Clean Apply on untouched draft works via allowCleanApply without dirtying fields first
    const applyBtn = findButtonByText(mounted.host, "Apply");
    expect(applyBtn.hasAttribute("disabled")).toBe(false);
    clickEl(applyBtn);
    await flushMicrotasks();

    expect(state.createFieldDrive).toHaveBeenCalledTimes(1);
    expect(state.createFieldDrive).toHaveBeenCalledWith(
      {
        base_revision: 12,
        drive: expect.objectContaining({
          id: "field-drive-2",
          kind: "regional",
          enabled: false,
          spatial_profile: {
            kind: "geometry_mask",
            object_id: "strip-mask",
            envelope: { kind: "uniform" },
          },
          waveform: expect.objectContaining({
            kind: "sinc_pulse",
            cutoff_hz: 20e9,
            amplitude: 1,
          }),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    expect(state.historyRecord).toHaveBeenCalledTimes(1);
    expect(state.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:field-drive-2",
        ref: expect.objectContaining({
          fieldDriveId: "field-drive-2",
          kind: "physics.field-drive",
          type: "physics-field-drive",
        }),
      }),
      "inspector",
    );

    mounted.unmount();
  });

  it("hydrates stage_ids activation, saves updated stage_ids, and exposes Add run stage CTA when study has no run stages", async () => {
    state.regionalDrives = [
      {
        id: "staged-drive",
        kind: "regional",
        name: "Stage Scoped Drive",
        enabled: true,
        amplitude_B_T: 0.005,
        direction: [1, 0, 0],
        target: { kind: "global" },
        spatial_profile: { kind: "uniform" },
        waveform: { kind: "sinusoidal", frequency_hz: 5e9, phase_rad: 0, offset: 0.25 },
        time_origin: "absolute",
        activation: { kind: "stage_ids", stage_ids: ["run-2"] },
      },
    ];

    const sel: Selection = {
      kind: "physics.field-drive",
      label: "Stage Scoped Drive",
      moduleSource: "explorer",
      nodeId: "model:physics:field-drives:staged-drive",
      objectId: null,
      ref: {
        fieldDriveId: "staged-drive",
        fieldDriveKind: "regional",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:staged-drive",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: sel }),
      ),
    );

    // Toggle run-1 on in addition to hydrated run-2
    const run1Toggle = findElements(
      mounted.host,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("run-1"),
    )[0];
    expect(run1Toggle).toBeDefined();
    clickEl(run1Toggle!);
    await flushMicrotasks();

    const applyBtn = findButtonByText(mounted.host, "Apply");
    clickEl(applyBtn);
    await flushMicrotasks();

    expect(state.replaceFieldDrive).toHaveBeenCalledWith(
      "staged-drive",
      {
        base_revision: 12,
        drive: expect.objectContaining({
          time_origin: "absolute",
          waveform: {
            kind: "sinusoidal",
            frequency_hz: 5e9,
            phase_rad: 0,
            offset: 0.25,
          },
          activation: {
            kind: "stage_ids",
            stage_ids: ["run-2", "run-1"],
          },
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    mounted.unmount();

    // Now test empty run stages warning & "Add run stage" CTA
    state.sceneData = baseScene({
      study: { stages: [{ stage_id: "relax-only", kind: "relax" }] },
    });
    const mountedEmpty = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: sel }),
      ),
    );
    expect(mountedEmpty.host.textContent).toContain("No run stage with a stable ID is available");
    const addStageBtn = findButtonByText(mountedEmpty.host, "Add run stage");
    clickEl(addStageBtn);
    expect(state.executeCommand).toHaveBeenCalledWith(
      "study.add-run-stage",
      expect.objectContaining({ source: "inspector" }),
    );
    mountedEmpty.unmount();
  });

  it("preserves canonical pulse (t_on/t_off) and geometry_mask with spatial sinc envelope & Hann window without converting pulse to piecewise_linear", async () => {
    state.regionalDrives = [
      {
        id: "pulse-mask-drive",
        kind: "regional",
        name: "Gate Pulse Drive",
        enabled: true,
        amplitude_B_T: 0.01,
        direction: [0, 0, 1],
        target: { kind: "region", object_id: "waveguide-1", region_id: "core" },
        spatial_profile: {
          kind: "geometry_mask",
          object_id: "strip-mask",
          envelope: {
            kind: "sinc",
            axis: [1, 0, 0],
            period_m: 150e-9,
            center_m: 10e-9,
            width_m: null,
            window: "hann",
          },
        },
        waveform: {
          kind: "pulse",
          t_on: 0.1e-9,
          t_off: 0.9e-9,
        },
        time_origin: "stage_local",
        activation: { kind: "all_time_evolution" },
      },
    ];

    const sel: Selection = {
      kind: "physics.field-drive",
      label: "Gate Pulse Drive",
      moduleSource: "explorer",
      nodeId: "model:physics:field-drives:pulse-mask-drive",
      objectId: null,
      ref: {
        fieldDriveId: "pulse-mask-drive",
        fieldDriveKind: "regional",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:pulse-mask-drive",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: sel }),
      ),
    );

    // Verify canonical On time & Off time fields and Geometry mask + Envelope controls are rendered
    expect(mounted.host.textContent).toContain("On time");
    expect(mounted.host.textContent).toContain("Off time");
    expect(mounted.host.textContent).toContain("Mask geometry");
    expect(mounted.host.textContent).toContain("Envelope");
    expect(mounted.host.textContent).toContain("Window");

    // Rename slightly to trigger Apply and verify lossless canonical serialization
    const nameInput = findInputAfterLabel(mounted.host, "Name");
    setInputText(nameInput, "Gate Pulse Updated");
    await flushMicrotasks();

    clickEl(findButtonByText(mounted.host, "Apply"));
    await flushMicrotasks();

    expect(state.replaceFieldDrive).toHaveBeenCalledWith(
      "pulse-mask-drive",
      {
        base_revision: 12,
        drive: expect.objectContaining({
          name: "Gate Pulse Updated",
          target: { kind: "region", object_id: "waveguide-1", region_id: "core" },
          spatial_profile: {
            kind: "geometry_mask",
            object_id: "strip-mask",
            envelope: {
              kind: "sinc",
              axis: [1, 0, 0],
              period_m: 150e-9,
              center_m: 10e-9,
              width_m: null,
              window: "hann",
            },
          },
          waveform: {
            kind: "pulse",
            t_on: 0.1e-9,
            t_off: 0.9e-9,
          },
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );

    mounted.unmount();
  });

  it("uses controlled piecewise_linear inputs (updating without blur) and computes real Nyquist limit from table_autosave", async () => {
    state.regionalDrives = [
      {
        id: "pwl-drive",
        kind: "regional",
        name: "Piecewise Ramp",
        enabled: true,
        amplitude_B_T: 0.004,
        direction: [0, 1, 0],
        target: { kind: "global" },
        spatial_profile: { kind: "uniform" },
        waveform: {
          kind: "piecewise_linear",
          points: [
            [0, 0],
            [0.01e-9, 1], // dt = 10 ps -> maxFreq = 50 GHz > f_Nyq = 25 GHz
          ],
        },
        time_origin: "stage_local",
        activation: { kind: "all_time_evolution" },
      },
    ];

    const sel: Selection = {
      kind: "physics.field-drive",
      label: "Piecewise Ramp",
      moduleSource: "explorer",
      nodeId: "model:physics:field-drives:pwl-drive",
      objectId: null,
      ref: {
        fieldDriveId: "pwl-drive",
        fieldDriveKind: "regional",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:pwl-drive",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: sel }),
      ),
    );

    // Real Nyquist notice triggered from outputs.table_autosave.sample_period_s = 20 ps (25 GHz)
    expect(mounted.host.textContent).toContain("Excitation exceeds output Nyquist frequency");

    // Edit Waypoint 2 scale WITHOUT blurring -> immediately dirties and commits updated value
    const wp2Scale = findInputByAriaLabel(mounted.host, "Waypoint 2 scale");
    setInputText(wp2Scale, "0.75");
    await flushMicrotasks();

    clickEl(findButtonByText(mounted.host, "Apply"));
    await flushMicrotasks();

    expect(state.replaceFieldDrive).toHaveBeenCalledWith(
      "pwl-drive",
      {
        base_revision: 12,
        drive: expect.objectContaining({
          waveform: {
            kind: "piecewise_linear",
            points: [
              [0, 0],
              [0.01e-9, 0.75],
            ],
          },
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );

    // Confirm Delete Field Drive via AlertDialog
    const deleteMenuBtn = findElements(
      mounted.host,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Delete Field Drive"),
    )[0];
    expect(deleteMenuBtn).toBeDefined();
    clickEl(deleteMenuBtn!);
    await flushMicrotasks();

    const alertDialog = findElements(
      mounted.host,
      (el) => el.getAttribute("data-slot") === "alert-dialog-content",
    )[0];
    expect(alertDialog).toBeDefined();
    const confirmDeleteBtn = findElements(
      alertDialog!,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Delete Field Drive"),
    )[0];
    expect(confirmDeleteBtn).toBeDefined();
    clickEl(confirmDeleteBtn!);
    await flushMicrotasks();

    expect(state.deleteFieldDrive).toHaveBeenCalledWith(
      "pwl-drive",
      { base_revision: 12 },
      { sessionScopeKey: SCOPE_KEY },
    );

    mounted.unmount();
  });

  it("edits sinc_pulse Waveform amplitude distinctly from peak Amplitude B_0", async () => {
    state.regionalDrives = [
      {
        id: "sinc-amp-drive",
        kind: "regional",
        name: "Sinc Amplitude Drive",
        enabled: true,
        amplitude_B_T: 0.006,
        direction: [0, 1, 0],
        target: { kind: "global" },
        spatial_profile: { kind: "uniform" },
        waveform: {
          kind: "sinc_pulse",
          cutoff_hz: 15e9,
          t0: 0.2e-9,
          amplitude: 0.5,
        },
        time_origin: "stage_local",
        activation: { kind: "all_time_evolution" },
      },
    ];

    const sel: Selection = {
      kind: "physics.field-drive",
      label: "Sinc Amplitude Drive",
      moduleSource: "explorer",
      nodeId: "model:physics:field-drives:sinc-amp-drive",
      objectId: null,
      ref: {
        fieldDriveId: "sinc-amp-drive",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:sinc-amp-drive",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: sel }),
      ),
    );

    const wfAmpInput = findInputAfterLabel(mounted.host, "Waveform amplitude");
    expect(wfAmpInput.value).toBe("0.5");
    setInputText(wfAmpInput, "0.85");
    await flushMicrotasks();

    clickEl(findButtonByText(mounted.host, "Apply"));
    await flushMicrotasks();

    expect(state.replaceFieldDrive).toHaveBeenCalledWith(
      "sinc-amp-drive",
      {
        base_revision: 12,
        drive: expect.objectContaining({
          amplitude_B_T: 0.006,
          waveform: {
            kind: "sinc_pulse",
            cutoff_hz: 15e9,
            t0: 0.2e-9,
            amplitude: 0.85,
          },
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );

    mounted.unmount();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. P0 Mask Antenna Panel Parity Tests
   ═══════════════════════════════════════════════════════════════════════════ */

describe("FieldDriveInspectorPanel — Mask Antenna P0 parity", () => {
  it("preserves multi-term analytic & sampled ArrayMaskRows terms, edits Bx/By/Bz/locals/parameters/shape/frame, and never overwrites terms with a scalar stub", async () => {
    const existingMask = sampleMaskDrive();
    state.maskDrives = [existingMask];
    state.maskFieldDrivesFetch.mockResolvedValue({
      drives: [existingMask],
      scene_revision: 12,
    });

    const maskSel: Selection = {
      kind: "physics.field-drive",
      label: "CPW Mask Antenna",
      moduleSource: "explorer",
      nodeId: "model:physics:mask-antennas:mask-antenna",
      objectId: null,
      ref: {
        fieldDriveId: "mask-antenna",
        fieldDriveKind: "mask",
        kind: "physics.field-drive",
        nodeId: "model:physics:mask-antennas:mask-antenna",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: maskSel }),
      ),
    );

    // Verify sampled ArrayMaskRows and analytic Bx/By/Bz + local kx are rendered
    expect(mounted.host.textContent).toContain("1200 x 200 x 9");
    expect(mounted.host.textContent).toContain("array (written by a loop), read-only");
    expect(mounted.host.textContent).toContain("Position (m)");
    expect(mounted.host.textContent).toContain("Center offset (m)");

    const bzInput = findInputByAriaLabel(mounted.host, "Bz =");
    setInputText(bzInput, "2.0 * B01 * sin(kx * x)");

    // Switch Frame to Local (target object)
    clickEl(findButtonByText(mounted.host, "Local (target object)"));
    await flushMicrotasks();

    clickEl(findButtonByText(mounted.host, "Apply"));
    await flushMicrotasks();

    expect(state.replaceMaskFieldDrive).toHaveBeenCalledTimes(1);
    expect(state.replaceMaskFieldDrive).toHaveBeenCalledWith(
      "mask-antenna",
      {
        base_revision: 12,
        drive: expect.objectContaining({
          id: "mask-antenna",
          frame: "local",
          terms: [
            expect.objectContaining({
              name: "even_mode",
              mask: {
                kind: "function",
                function: expect.objectContaining({
                  outputs: [
                    "B01 * cos(kx * x)",
                    "0.0",
                    "2.0 * B01 * sin(kx * x)",
                  ],
                  locals: [{ name: "kx", expression: "2 * pi / 1e-6" }],
                  parameters: [{ name: "B01", value: 0.002 }],
                }),
              },
            }),
            expect.objectContaining({
              name: "sampled_bias",
              mask: expect.objectContaining({
                kind: "sampled",
                size: [1200, 200, 9],
                data: "AAAA",
              }),
            }),
          ],
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );

    mounted.unmount();
  });

  it("builds ready-antenna terms via api.model.readyAntennaTerms on a new mask draft and navigates to created mask antenna on Apply", async () => {
    state.maskDrives = [sampleMaskDrive()];

    const createMaskSel: Selection = {
      kind: "physics.field-drive",
      label: "New Mask Field Drive",
      moduleSource: "explorer",
      nodeId: "model:physics:field-drives:draft:mask",
      objectId: null,
      ref: {
        draft: true,
        fieldDriveKind: "mask",
        kind: "physics.field-drive",
        nodeId: "model:physics:field-drives:draft:mask",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: createMaskSel }),
      ),
    );

    // Unique ID avoids existing "mask-antenna"
    const idInput = findInputAfterLabel(mounted.host, "ID");
    expect((idInput as unknown as { value: string }).value).toBe("mask-antenna-2");

    // Select ready antenna from catalog and build terms
    clickSelectOption(mounted.host, "fullmag.antennas.cpw");
    await flushMicrotasks();

    const currentArgInput = findInputByAriaLabel(mounted.host, "current_A");
    setInputText(currentArgInput, "0.02");

    clickEl(findButtonByText(mounted.host, "Build terms"));
    await flushMicrotasks();

    expect(state.readyAntennaTerms).toHaveBeenCalledWith(
      {
        function: "fullmag.antennas.cpw",
        arguments: { current_A: 0.02, signal_width_m: 200e-9 },
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    expect(mounted.host.textContent).toContain("cpw_generated_1");

    // Apply newly created mask antenna
    clickEl(findButtonByText(mounted.host, "Apply"));
    await flushMicrotasks();

    expect(state.createMaskFieldDrive).toHaveBeenCalledWith(
      {
        base_revision: 12,
        drive: expect.objectContaining({
          id: "mask-antenna-2",
          terms: expect.arrayContaining([
            expect.objectContaining({
              name: "cpw_generated_1",
            }),
          ]),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );
    expect(state.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "physics.field-drive",
        nodeId: "model:physics:mask-antennas:mask-antenna-2",
        ref: expect.objectContaining({
          fieldDriveId: "mask-antenna-2",
          fieldDriveKind: "mask",
        }),
      }),
      "inspector",
    );

    mounted.unmount();
  });

  it("surfaces 3-way conflict rebase UI (Keep my values / Load scene version) when scene changes on the same field", async () => {
    const initial = sampleMaskDrive();
    state.maskDrives = [initial];

    const maskSel: Selection = {
      kind: "physics.field-drive",
      label: "CPW Mask Antenna",
      moduleSource: "explorer",
      nodeId: "model:physics:mask-antennas:mask-antenna",
      objectId: null,
      ref: {
        fieldDriveId: "mask-antenna",
        fieldDriveKind: "mask",
        kind: "physics.field-drive",
        nodeId: "model:physics:mask-antennas:mask-antenna",
        type: "physics-field-drive",
      },
    };

    const mounted = mountWave4TestElement(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: maskSel }),
      ),
    );

    // User edits Bz locally
    const bzInput = findInputByAriaLabel(mounted.host, "Bz =");
    setInputText(bzInput, "3.0 * B01 * sin(kx * x)");
    await flushMicrotasks();

    // Concurrent scene update modifies Bz on the server
    const serverUpdated = sampleMaskDrive({
      terms: [
        {
          ...initial.terms[0]!,
          mask: {
            kind: "function",
            function: {
              expression_version: "field_expr.v1",
              name: "cpw_even",
              parameters: [{ name: "B01", value: 0.005 }],
              locals: [{ name: "kx", expression: "2 * pi / 1e-6" }],
              outputs: ["B01 * cos(kx * x)", "0.0", "9.0 * B01 * sin(kx * x)"],
            },
          },
        },
        initial.terms[1]!,
      ],
    });
    state.sceneRevision = 13;
    state.sceneData = baseScene({ revision: 13 });
    state.maskDrives = [serverUpdated];
    state.maskFieldDrivesFetch.mockResolvedValue({
      drives: [serverUpdated],
      scene_revision: 13,
    });

    mounted.rerender(
      createElement(
        InspectorEditSessionProvider,
        null,
        createElement(FieldDriveInspectorPanel, { selection: maskSel }),
      ),
    );

    expect(mounted.host.textContent).toContain("Keep your values or load the scene version");
    const keepBtn = findButtonByText(mounted.host, "Keep my values");
    expect(findButtonByText(mounted.host, "Load scene version")).toBeDefined();

    // Resolve conflict keeping local Bz while picking up non-conflicting B01=0.005 from server
    clickEl(keepBtn);
    await flushMicrotasks();

    clickEl(findButtonByText(mounted.host, "Apply"));
    await flushMicrotasks();

    expect(state.replaceMaskFieldDrive).toHaveBeenCalledWith(
      "mask-antenna",
      {
        base_revision: 13,
        drive: expect.objectContaining({
          terms: expect.arrayContaining([
            expect.objectContaining({
              name: "even_mode",
              mask: {
                kind: "function",
                function: expect.objectContaining({
                  parameters: [{ name: "B01", value: 0.005 }],
                  outputs: [
                    "B01 * cos(kx * x)",
                    "0.0",
                    "3.0 * B01 * sin(kx * x)",
                  ],
                }),
              },
            }),
          ]),
        }),
      },
      { sessionScopeKey: SCOPE_KEY },
    );

    // Also verify AlertDialog-confirmed Delete Field Drive on Mask Antenna
    const deleteMenuBtn = findElements(
      mounted.host,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Delete Field Drive"),
    )[0];
    expect(deleteMenuBtn).toBeDefined();
    clickEl(deleteMenuBtn!);
    await flushMicrotasks();

    const alertDialog = findElements(
      mounted.host,
      (el) => el.getAttribute("data-slot") === "alert-dialog-content",
    )[0];
    expect(alertDialog).toBeDefined();
    const confirmDeleteBtn = findElements(
      alertDialog!,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Delete Field Drive"),
    )[0];
    expect(confirmDeleteBtn).toBeDefined();
    clickEl(confirmDeleteBtn!);
    await flushMicrotasks();

    expect(state.deleteMaskFieldDrive).toHaveBeenCalledWith(
      "mask-antenna",
      { base_revision: 13 },
      { sessionScopeKey: SCOPE_KEY },
    );

    mounted.unmount();
  });
});
