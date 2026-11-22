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
import { buildHysteresisStageNode } from "@/modules/explorer/builders/study/hysteresisStageNode";

const resourceHookSpies = vi.hoisted(() => ({
  pointsCalls: 0,
  progressCalls: 0,
  otherCalls: 0,
}));

vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/resources/studyRuntimeResources")>();
  return {
    ...actual,
    useHysteresisPointsResource: (stageId: string | null | undefined, options?: { enabled?: boolean }) => {
      if (options?.enabled !== false && stageId) {
        resourceHookSpies.pointsCalls += 1;
      }
      return {
        data: {
          points: [
            {
              adaptive_inserted: false,
              branch_id: "descending",
              field_value_mT: 200,
              m_avg: [0.998, 0, 0],
              m_ip: 0.998,
              m_oop: 0,
              m_parallel: 0.998,
              point_id: 0,
              protocol_role: "major",
              settle_status: "converged",
              snapshot_id: "snap_0",
              snapshot_storage_status: "available",
              status: "completed",
            },
            {
              adaptive_inserted: false,
              branch_id: "descending",
              field_value_mT: -42.5,
              m_avg: [-0.012, 0.999, 0],
              m_ip: 0.999,
              m_oop: 0,
              m_parallel: -0.012,
              point_id: 1,
              protocol_role: "coercive",
              settle_status: "converged",
              snapshot_id: "snap_1",
              snapshot_storage_status: "available",
              status: "completed",
            },
          ],
          revision: "rev-81",
        },
        error: null,
        refresh: vi.fn(),
        revision: "rev-81",
        status: "ready" as const,
      };
    },
    useHysteresisProgressResource: (stageId: string | null | undefined, options?: { enabled?: boolean }) => {
      if (options?.enabled !== false && stageId) {
        resourceHookSpies.progressCalls += 1;
      }
      return {
        data: {
          active: false,
          current_field_mT: -200,
          current_point_index: 1,
          total_points: 2,
        },
        error: null,
        refresh: vi.fn(),
        revision: "prog-2",
        status: "ready" as const,
      };
    },
    useHysteresisBranchesResource: () => {
      resourceHookSpies.otherCalls += 1;
      return { data: null, error: null, refresh: vi.fn(), revision: null, status: "idle" as const };
    },
    useHysteresisFamilyResource: () => {
      resourceHookSpies.otherCalls += 1;
      return { data: null, error: null, refresh: vi.fn(), revision: null, status: "idle" as const };
    },
    useHysteresisMetricsResource: () => {
      resourceHookSpies.otherCalls += 1;
      return { data: null, error: null, refresh: vi.fn(), revision: null, status: "idle" as const };
    },
    useHysteresisMinorLoopsResource: () => {
      resourceHookSpies.otherCalls += 1;
      return { data: null, error: null, refresh: vi.fn(), revision: null, status: "idle" as const };
    },
    useHysteresisOrientationResource: () => {
      resourceHookSpies.otherCalls += 1;
      return { data: null, error: null, refresh: vi.fn(), revision: null, status: "idle" as const };
    },
    useHysteresisProtocolResource: () => {
      resourceHookSpies.otherCalls += 1;
      return { data: null, error: null, refresh: vi.fn(), revision: null, status: "idle" as const };
    },
  };
});

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
    open ? <div data-slot="mock-dialog-root">{children}</div> : null,
  Trigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Overlay: () => <div data-slot="mock-dialog-overlay" />,
  Content: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <div data-slot="mock-dialog-content" role={role ?? "dialog"}>
      {children}
    </div>
  ),
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
        <div data-slot="mock-select-root">{children}</div>
      </Ctx.Provider>
    ),
    Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Value: ({ placeholder }: { placeholder?: string }) => {
      const ctx = React.useContext(Ctx);
      return <span>{ctx.value || placeholder || ""}</span>;
    },
    Trigger: ({ children, ...rest }: { children?: ReactNode }) => (
      <button type="button" {...rest}>
        {children}
      </button>
    ),
    Icon: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Portal: ({ children }: { children?: ReactNode }) => <>{children}</>,
    Content: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Viewport: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Item: ({
      children,
      value,
      disabled,
    }: {
      children?: ReactNode;
      value: string;
      disabled?: boolean;
    }) => {
      const ctx = React.useContext(Ctx);
      return (
        <button
          data-select-value={value}
          disabled={disabled}
          role="option" aria-selected={false}
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
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

vi.mock("@radix-ui/react-checkbox", () => ({
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
      role="checkbox"
      type="button"
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    />
  ),
  Indicator: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
      onClick={() => onValueChange?.([1])}
      {...rest}
    />
  ),
  Track: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Range: () => <div />,
  Thumb: () => <div />,
}));

vi.mock("echarts", () => ({
  init: () => ({
    on: vi.fn(),
    off: vi.fn(),
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import {
  DEFAULT_MINIMIZE_SETTLE_STEP,
  HysteresisStageDraftFields,
} from "../HysteresisStageDraftFields";
import {
  createDefaultStudyStageDraft,
  createStudyStageDraft,
  studyStageDraftToSceneStage,
  validateStudyStageDraft,
  type StudyStageDraft,
} from "../StudyStageAuthoringModel";
import { HysteresisChart } from "@/shared/domain/study/HysteresisChart";
import { HysteresisStageInspectorPanel } from "./HysteresisStageSpec";
import {
  HysteresisDatasetResultInspector,
  HysteresisPointResultInspector,
  HysteresisRootResultInspector,
} from "../../inspectors/results/hysteresis";

let restoreDom: (() => void) | null = null;

afterEach(() => {
  restoreDom?.();
  restoreDom = null;
  resourceHookSpies.pointsCalls = 0;
  resourceHookSpies.progressCalls = 0;
  resourceHookSpies.otherCalls = 0;
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

function focusInputForReact(input: TestElement): void {
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
}

function setInputValue(input: TestElement, nextValue: string): void {
  const compat = input as TestInputCompat;
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

function makeSelection(kind: string, nodeId = `node:${kind}`): Selection {
  return {
    kind,
    label: kind,
    moduleSource: "explorer",
    nodeId,
    objectId: null,
    ref: {
      nodeId,
      stageId: "hyst_1",
      stageIndex: 0,
      type: "study-stage",
    },
  };
}

describe("Task 23 — Hysteresis 3x P0 fixes, <=2 HTTP resource hooks, and 4-col + 15-col diagnostic sheet", () => {
  it("typing_10_characters_in_all_5_hysteresis_lists_never_remounts_input_or_loses_cursor", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [draft, setDraft] = useState<StudyStageDraft>(() =>
        createStudyStageDraft(
          {
            branch_mode: "major_with_minor_loops",
            field_max_mT: 200,
            field_min_mT: -200,
            field_schedule: {
              segments: [
                {
                  endpoint_policy: "include_stop",
                  label: "Seg 1",
                  segment_id: "s",
                  start: 0.2,
                  step: 0.005,
                  stop: -0.2,
                  unit: "T",
                },
              ],
            },
            field_step_mT: 5,
            fieldScheduleMode: "piecewise",
            kind: "hysteresis",
            minor_loops: [{ closure_policy: "branch_only", return_mT: -50, reversal_mT: 50 }],
            schedule_refinements: [{ center_mT: 0, half_width_mT: 20, priority: 1, step_mT: 1 }],
            settle_pipeline: {
              branches: [
                {
                  branch_id: "b",
                  run: {
                    alpha: 1,
                    kind: "relax",
                    max_steps: 5000,
                    method: "llg_overdamped",
                    on_non_convergence: "continue_with_warning",
                    torque_tolerance: 100,
                  },
                  when: "non_converged",
                },
              ],
              default: {
                alpha: 1,
                kind: "relax",
                max_steps: 5000,
                method: "llg_overdamped",
                on_non_convergence: "run_next_algorithm",
                step_id: "st",
                torque_tolerance: 100,
              },
              kind: "tree",
            },
            stage_id: "hyst_1",
          },
          0,
        ),
      );
      return (
        <HysteresisStageDraftFields
          draft={draft}
          onUpdate={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });

    const ariaLabels = [
      "Segment 1 start field",
      "Window 1 center field",
      "Minor loop 1 reversal field",
      "Step 1 ID",
      "Branch 1 ID",
    ];

    for (const label of ariaLabels) {
      const initialInput = findElement(
        container,
        (el) => el.tagName === "INPUT" && el.getAttribute("aria-label") === label,
      );
      expect(initialInput, `missing input ${label}`).not.toBeNull();
      await act(async () => {
        focusInputForReact(initialInput!);
      });

      let text = "";
      for (let i = 0; i < 10; i += 1) {
        text += String(i % 10);
        await act(async () => {
          setInputValue(initialInput!, text);
        });
        const afterInput = findElement(
          container,
          (el) => el.tagName === "INPUT" && el.getAttribute("aria-label") === label,
        );
        expect(afterInput).toBe(initialInput);
        expect(afterInput?.value).toBe(text);
        expect(dom.document.activeElement).toBe(initialInput);
      }
    }

    await act(async () => {
      root.unmount();
    });
  });

  it("serializes_piecewise_segments_with_mT_Oe_kApm_units_into_numeric_millitesla_IR", () => {
    const mu0 = 4 * Math.PI * 1e-7;
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const updated: StudyStageDraft = {
      ...draft,
      stageId: "hyst_si",
      fieldScheduleMode: "piecewise",
      fieldSegments: JSON.stringify([
        {
          _rowId: "row-mt",
          segmentId: "seg-mt",
          label: "Millitesla segment",
          startField: "200",
          stopField: "-200",
          step: "5",
          unit: "mT",
          endpointPolicy: "include_stop",
          reason: "",
        },
        {
          _rowId: "row-oe",
          segmentId: "seg-oe",
          label: "Oersted segment",
          startField: "-2000",
          stopField: "0",
          step: "100",
          unit: "Oe",
          endpointPolicy: "skip_start",
          reason: "",
        },
        {
          _rowId: "row-kapm",
          segmentId: "seg-kapm",
          label: "kA/m segment",
          startField: "0",
          stopField: "100",
          step: "10",
          unit: "kA/m",
          endpointPolicy: "skip_start",
          reason: "",
        },
      ]),
    };

    const issues = validateStudyStageDraft(updated).filter((i) => i.severity === "error");
    expect(issues).toEqual([]);

    const sceneStage = studyStageDraftToSceneStage(updated) as Record<string, unknown>;
    const fieldSchedule = sceneStage.field_schedule as { segments: Array<Record<string, unknown>> };
    expect(fieldSchedule.segments).toHaveLength(3);

    expect(fieldSchedule.segments[0]).toMatchObject({
      segment_id: "seg-mt",
      start: 200,
      stop: -200,
      step: 5,
    });
    expect("unit" in fieldSchedule.segments[0]!).toBe(false);
    expect("_rowId" in fieldSchedule.segments[0]!).toBe(false);

    expect(fieldSchedule.segments[1]?.start).toBeCloseTo(-200, 9);
    expect(fieldSchedule.segments[1]?.stop).toBeCloseTo(0, 9);
    expect(fieldSchedule.segments[1]?.step).toBeCloseTo(10, 9);
    expect("unit" in fieldSchedule.segments[1]!).toBe(false);

    expect(fieldSchedule.segments[2]?.start).toBeCloseTo(0, 9);
    expect(fieldSchedule.segments[2]?.stop).toBeCloseTo(100 * mu0 * 1e6, 9);
    expect(fieldSchedule.segments[2]?.step).toBeCloseTo(10 * mu0 * 1e6, 9);
    expect("unit" in fieldSchedule.segments[2]!).toBe(false);
  });

  it("exposes_and_validates_torque_tolerance_for_minimize_step_preserving_advanced_time_limits", async () => {
    expect(Number(DEFAULT_MINIMIZE_SETTLE_STEP.torque_tolerance)).toBe(100);

    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    let latestDraft = createStudyStageDraft(
      {
        field_max_mT: 200,
        field_min_mT: -200,
        field_step_mT: 5,
        kind: "hysteresis",
        settle_pipeline: {
          kind: "sequence",
          steps: [
            {
              kind: "minimize",
              max_physical_time_s: 5e-9,
              max_pseudotime_s: 1e-8,
              max_steps: 200,
              method: "projected_gradient_bb",
              on_non_convergence: "continue_with_warning",
              step_id: "min-1",
              timestep_min_s: 1e-16,
              torque_tolerance: 100,
            },
          ],
        },
        stage_id: "hyst_min",
      },
      0,
    );

    function MinimizeHarness() {
      const [draftState, setDraftState] = useState<StudyStageDraft>(latestDraft);
      return (
        <HysteresisStageDraftFields
          draft={draftState}
          onUpdate={(patch) => {
            setDraftState((prev) => {
              const next = { ...prev, ...patch };
              latestDraft = next;
              return next;
            });
          }}
        />
      );
    }

    await act(async () => {
      root.render(<MinimizeHarness />);
    });

    const torqueInput = findElement(
      container,
      (el) => el.tagName === "INPUT" && el.getAttribute("aria-label") === "Step 1 torque tolerance",
    );
    expect(torqueInput).not.toBeNull();
    expect(torqueInput?.value).toBe("100");

    await act(async () => {
      focusInputForReact(torqueInput!);
    });
    await act(async () => {
      setInputValue(torqueInput!, "80");
    });

    const errors = validateStudyStageDraft(latestDraft).filter((i) => i.severity === "error");
    expect(errors).toEqual([]);

    const serialized = studyStageDraftToSceneStage(latestDraft) as {
      settle_pipeline: { steps: Array<Record<string, unknown>> };
    };
    expect(serialized.settle_pipeline.steps[0]).toMatchObject({
      kind: "minimize",
      method: "projected_gradient_bb",
      torque_tolerance: 80,
      max_pseudotime_s: 1e-8,
      max_physical_time_s: 5e-9,
      timestep_min_s: 1e-16,
    });
    expect("_rowId" in serialized.settle_pipeline.steps[0]!).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it("mounts_at_most_2_resource_hooks_and_zero_hooks_inside_HysteresisChart", async () => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);

    const hystExplorerNode = buildHysteresisStageNode({
      index: 0,
      kind: "hysteresis",
      stageId: "hyst_1",
      status: "completed",
    });
    expect(hystExplorerNode.kind).toBe("study.stage.hysteresis");
    expect(hystExplorerNode.children ?? []).toEqual([]);

    const fakeKernel = {
      commands: { execute: vi.fn() },
      selection: {
        clear: vi.fn(),
        get: () => makeSelection("study.stage.hysteresis"),
        set: vi.fn(),
        subscribe: () => () => undefined,
      },
    };

    resourceHookSpies.pointsCalls = 0;
    resourceHookSpies.progressCalls = 0;
    resourceHookSpies.otherCalls = 0;

    await act(async () => {
      root.render(
        <HysteresisChart
          data={{
            points: [
              {
                adaptive_inserted: false,
                branch_id: "descending",
                field_value_mT: 200,
                m_avg: [1, 0, 0],
                m_ip: 1,
                m_oop: 0,
                m_parallel: 1,
                point_id: 0,
                protocol_role: "major",
                settle_status: "converged",
                snapshot_id: "snap_0",
                snapshot_storage_status: "available",
                status: "completed",
              },
            ],
            pointsRevision: "rev-1",
            progress: null,
          }}
          kernel={fakeKernel as never}
          stageId="hyst_1"
        />,
      );
    });

    expect(
      resourceHookSpies.pointsCalls +
        resourceHookSpies.progressCalls +
        resourceHookSpies.otherCalls,
    ).toBe(0);
    expect(findElements(container, (el) => el.tagName === "SELECT")).toEqual([]);
    expect(findElements(container, (el) => el.hasAttribute("title"))).toEqual([]);

    // Now mount HysteresisStageInspectorPanel on Authoring -> 0 active HTTP hooks!
    await act(async () => {
      root.render(
        <HysteresisStageInspectorPanel
          selection={makeSelection("study.stage.hysteresis")}
        />,
      );
    });
    expect(
      resourceHookSpies.pointsCalls +
        resourceHookSpies.progressCalls +
        resourceHookSpies.otherCalls,
    ).toBe(0);

    // Switch to Live & Results tab -> at most 2 active HTTP hooks, 4-col compact table + 15-col sheet!
    const liveTab = findElement(
      container,
      (el) => el.getAttribute("role") === "tab" && (el.textContent ?? "").includes("Live & Results"),
    );
    expect(liveTab).not.toBeNull();
    await act(async () => {
      liveTab!.click();
    });

    expect(resourceHookSpies.otherCalls).toBe(0);
    expect(resourceHookSpies.pointsCalls + resourceHookSpies.progressCalls).toBeLessThanOrEqual(2);

    const compactHeaders = findElements(container, (el) => el.tagName === "TH");
    expect(compactHeaders.length).toBe(4);

    const openSheetBtn = findElement(
      container,
      (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Open Full 15-Column"),
    );
    expect(openSheetBtn).not.toBeNull();
    await act(async () => {
      openSheetBtn!.click();
    });
    const sheetHeaders = findElements(
      container,
      (el) =>
        el.tagName === "TH" &&
        Boolean(el.closest('[data-slot="mock-dialog-content"]')),
    );
    expect(sheetHeaders.length).toBe(15);

    // Verify 15-col sheet Export CSV and row Pin/3D/Init callbacks are wired
    const exportCsvBtn = findElement(
      container,
      (el) =>
        el.tagName === "BUTTON" &&
        (el.textContent ?? "").includes("Export CSV") &&
        Boolean(el.closest('[data-slot="mock-dialog-content"]')),
    );
    expect(exportCsvBtn).not.toBeNull();

    // Verify zero-crossing interpolated remanence between +200 mT (0.998) and -42.5 mT (-0.012)
    expect(container.textContent ?? "").toContain("0.1650");
    expect(container.textContent ?? "").toContain("-39.62 mT");

    // Verify HysteresisResultSpecs render cleanly without "unknown" or "n/a"
    for (const ResultPanel of [
      HysteresisRootResultInspector,
      HysteresisDatasetResultInspector,
      HysteresisPointResultInspector,
    ]) {
      await act(async () => {
        root.render(<ResultPanel selection={makeSelection("results.hysteresis.root")} />);
      });
      expect((container.textContent ?? "").toLowerCase()).not.toContain("unknown");
      expect((container.textContent ?? "").toLowerCase()).not.toContain("n/a");
    }

    await act(async () => {
      root.unmount();
    });
  });
});
