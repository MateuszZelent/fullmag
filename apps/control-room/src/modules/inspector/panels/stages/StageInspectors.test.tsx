import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Accordion } from "@/shared/ui/Accordion";
import { KernelContext } from "@/kernel/KernelContext";
import {
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
  ANALYSIS_HYSTERESIS_BRANCHES_PATH,
  ANALYSIS_HYSTERESIS_METRICS_PATH,
  ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
  ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  DATA_FIELD_VECTOR_PATH,
  SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
  SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
} from "@/kernel/api/apiPaths";
import type {
  HysteresisAdaptiveRefinementResource,
  HysteresisAdaptiveRefinementSchema,
  HysteresisAngularFamilyResource,
  HysteresisBranchesResource,
  HysteresisBookmarksResource,
  HysteresisMetricsResource,
  HysteresisMetricsSchema,
  HysteresisMinorLoopsResource,
  HysteresisMinorLoopSchema,
  HysteresisPointSchema,
  HysteresisPointsResource,
  HysteresisBranchSchema,
  HysteresisExecutionTreeResource,
  HysteresisProgressSchema,
  HysteresisProtocolSchema,
  HysteresisReversalFieldsResource,
  HysteresisSettleTraceEntrySchema,
  HysteresisSettleTraceResource,
  HysteresisSettlePipelineSchema,
  HysteresisStagePlanSchema,
} from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";

const selection = new SelectionController(new EventBus<KernelEventMap>());

function hysteresisPointsResource(
  points: HysteresisPointSchema[],
): HysteresisPointsResource {
  return {
    points,
    revision: 0,
    stage_id: "hysteresis-1",
    stage_index: 0,
  };
}

function hysteresisBranchesResource(
  branches: HysteresisBranchSchema[],
): HysteresisBranchesResource {
  return {
    branches,
    revision: 0,
    stage_id: "hysteresis-1",
    stage_index: 0,
  };
}

function hysteresisMinorLoopsResource(
  minorLoops: HysteresisMinorLoopSchema[],
): HysteresisMinorLoopsResource {
  return {
    minor_loops: minorLoops,
    revision: 0,
    stage_id: "hysteresis-1",
    stage_index: 0,
  };
}

function hysteresisReversalFieldsResource(
  reversalFields: HysteresisPointSchema[],
): HysteresisReversalFieldsResource {
  return {
    reversal_fields: reversalFields,
    revision: 0,
    stage_id: "hysteresis-1",
    stage_index: 0,
  };
}

function hysteresisAdaptiveRefinementResource(
  adaptiveRefinement: HysteresisAdaptiveRefinementSchema,
): HysteresisAdaptiveRefinementResource {
  return {
    adaptive_refinement: adaptiveRefinement,
    revision: 22,
    stage_id: "hysteresis-1",
    stage_index: 0,
  };
}

const mockKernel = {
  commands: {
    execute: () => Promise.resolve(),
    register: () => () => {},
  },
  bus: {
    emit: () => {},
    on: () => () => {},
  },
  api: {
    analysis: {
      hysteresis: {
        points: () => Promise.resolve(hysteresisPointsResource([])),
        metrics: () => Promise.resolve(null),
        adaptiveRefinement: () => Promise.resolve(null),
      },
    },
  },
  resources: {
    getRevision: () => 0,
    subscribe: () => () => {},
    read: () => null,
  },
  selection,
  visualizationDebug: new VisualizationDebugController(),
} as unknown as KernelApi;

import { createDefaultStudyStageDraft } from "../StudyStageAuthoringModel";
import {
  resolveFrequencyDomainAuthoringView,
  resolveStudyStageInspectorKind,
} from "../StudyStageInspectorRouter";
import type { StudyStageModel } from "../StudyInspectorPanelModel";
import { ChangeDeviceStageInspector } from "./ChangeDeviceStageInspector";
import { AddFieldDriveStageInspector } from "./AddFieldDriveStageInspector";
import { EigenmodesStageInspector } from "./EigenmodesStageInspector";
import { FrequencyResponseStageInspector } from "./FrequencyResponseStageInspector";
import {
  HysteresisStageInspector,
  hysteresisInitialStateActionPresentation,
} from "./HysteresisStageInspector";
import { resolveHysteresisInspectorView } from "./hysteresis/HysteresisInspectorUtils";
import { RelaxStageInspector } from "./RelaxStageInspector";
import { RunStageInspector } from "./RunStageInspector";
import { SaveStateStageInspector } from "./SaveStateStageInspector";
import type { StageInspectorFrameProps } from "./StageInspectorFrame";

function stage(kind: string): StudyStageModel {
  return {
    algorithm: null,
    artifactRefs: [],
    checkpointRef: null,
    commandId: null,
    completedAtIso: null,
    completedAtUnixMs: null,
    energyTolerance: null,
    index: 0,
    kind,
    label: kind,
    maxSteps: null,
    progressPercent: 0,
    runtimeMetric: null,
    stageId: `${kind}-1`,
    status: "queued",
    stopReason: null,
    timeBudgetKind: "physical",
    torqueTolerance: null,
    torqueToleranceFormatted: null,
    torqueToleranceShortFormatted: null,
    transition: null,
    untilSeconds: null,
  };
}

function props(kind: Parameters<typeof createDefaultStudyStageDraft>[0]): StageInspectorFrameProps {
  return {
    authoringBusy: false,
    authoringFeedback: null,
    draft: createDefaultStudyStageDraft(kind, 0),
    draftIndex: 0,
    expectedKind: kind,
    kindLabel: kind,
    onCommit: () => undefined,
    onUpdateDraft: () => undefined,
    runRuntimeCommand: () => undefined,
    runtimeCommandDisabledReason: () => null,
    stage: stage(kind),
    stageExecutionRevision: 7,
    validation: [],
  };
}

function render(
  children: ReactNode,
  defaultValue = [
    "identity",
    "authoring",
    "telemetry",
    "add-field-drive",
    "add-field-waveform",
    "add-field-activation",
    "run-time-integration",
    "run-drive",
    "run-sampling",
    "run-gamma-response",
    "run-progress",
    "eigenmodes-command-center",
    "frequency-response-command-center",
  ],
): string {
  return renderToStaticMarkup(
    <KernelContext.Provider value={mockKernel}>
      <Accordion type="multiple" defaultValue={defaultValue}>
        {children}
      </Accordion>
    </KernelContext.Provider>,
  );
}

function hysteresisFamilyVariantPointsRef(
  stageId: string,
  variantId: string,
): string {
  return ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH.replace(
    "{stage_id}",
    stageId,
  ).replace("{variant_id}", variantId);
}

describe("Study stage inspectors", () => {
  it("renders a dedicated inspector for every supported study stage kind", () => {
    expect(render(<RelaxStageInspector {...props("relax")} />)).toContain(
      "Stop Criteria",
    );
    expect(render(<RelaxStageInspector {...props("relax")} />)).toContain(
      "Numerics",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Time Integration",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Drive &amp; Dynamics",
    );
    expect(
      render(
        <AddFieldDriveStageInspector
          {...props("add_field_drive")}
          pipelineDrafts={[
            createDefaultStudyStageDraft("relax", 0),
            createDefaultStudyStageDraft("add_field_drive", 1),
            { ...createDefaultStudyStageDraft("run", 2), untilSeconds: "2e-9" },
          ]}
        />,
      ),
    ).toContain("Regional Field Drive");
    expect(
      render(
        <AddFieldDriveStageInspector
          {...props("add_field_drive")}
          pipelineDrafts={[
            createDefaultStudyStageDraft("relax", 0),
            createDefaultStudyStageDraft("add_field_drive", 1),
            { ...createDefaultStudyStageDraft("run", 2), untilSeconds: "2e-9" },
          ]}
        />,
      ),
    ).toContain("Sampled source spectrum |FFT(B)|");
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Sampling &amp; Outputs",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Gamma Response",
    );
    expect(render(<RunStageInspector {...props("run")} />)).toContain(
      "Run Progress",
    );
    expect(
      render(<ChangeDeviceStageInspector {...props("change_device")} />),
    ).toContain("Execution Device");
    expect(
      render(<ChangeDeviceStageInspector {...props("change_device")} />),
    ).toContain("Runtime Boundary");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Measurement Plan");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Settle Pipeline");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Live Progress");
    expect(
      render(<HysteresisStageInspector {...props("hysteresis")} />),
    ).toContain("Live");
    expect(
      render(<EigenmodesStageInspector {...props("eigenmodes")} />),
    ).toContain("Eigenproblem");
    expect(
      render(<EigenmodesStageInspector {...props("eigenmodes")} />),
    ).toContain("Linearization State");
    expect(
      render(
        <FrequencyResponseStageInspector
          {...props("frequency_response")}
        />,
      ),
    ).toContain("Frequency Sweep");
    expect(
      render(
        <FrequencyResponseStageInspector
          {...props("frequency_response")}
        />,
      ),
    ).toContain("Spin-Wave Sampling");
    expect(render(<SaveStateStageInspector {...props("save_state")} />)).toContain(
      "Output Target",
    );
    expect(render(<SaveStateStageInspector {...props("save_state")} />)).toContain(
      "Captured State",
    );
  });

  it.each([
    [
      "eigenmodes",
      EigenmodesStageInspector,
      [
        "Modal Stage Command Center",
        "Calculation workflow",
        "fmr_modal / free_modes / dispersion_modal",
        "Equilibrium source",
        "Operator",
        "Boundary/k sampling",
        "Solver request",
        "Outputs",
        "Current validation status",
        "Capability status",
        "Latest manifest links",
        "Requested vs resolved execution",
        "Validate stage",
        "Run modal stage",
        "Export canonical Python",
      ],
    ],
    [
      "frequency_response",
      FrequencyResponseStageInspector,
      [
        "Driven Response Command Center",
        "Calculation workflow",
        "fmr_response / response_map",
        "Equilibrium source",
        "Operator",
        "Boundary/k sampling",
        "Excitation phasor",
        "Frequency sweep",
        "Outputs",
        "Current native production CPU slice",
        "Unsupported lanes",
        "Latest progress",
        "Validate driven response",
        "Run response sweep",
        "Export canonical Python",
      ],
    ],
  ] as const)(
    "renders the %s stage overview as a command center",
    (kind, Inspector, expectedLabels) => {
      const html = render(<Inspector {...props(kind)} />);

      for (const label of expectedLabels) {
        expect(html).toContain(label);
      }
      expect(html).toContain("Save stage draft before running this workflow");
      expect(html).not.toContain("Use the Study run command after saving this stage");
      expect(html).toMatch(
        kind === "eigenmodes"
          ? /<button[^>]*class="[^"]*fm-button[^"]*"[^>]*>.*Run modal stage.*<\/button>/
          : /<button[^>]*class="[^"]*fm-button[^"]*"[^>]*>.*Run response sweep.*<\/button>/,
      );
      expect(html).toContain(
        '<span class="fm-inspector-field-row__value">Canonical Python export is available after the saved stage patch is materialized</span>',
      );
      expect(html).not.toMatch(
        /<button[^>]*disabled=""[^>]*>(?:Run modal stage|Run response sweep|Export canonical Python)<\/button>/,
      );
      if (kind === "frequency_response") {
        expect(html).toContain(
          '<span class="fm-inspector-field-row__label">Frequency sweep</span><span class="fm-inspector-field-row__value">1 GHz</span>',
        );
      }
      expect(html).not.toContain("generic stage properties");
    },
  );

  it("renders dynamic eigenmode progress in the stage detail frame", () => {
    const frameProps = props("eigenmodes");
    const html = render(
      <EigenmodesStageInspector
        {...frameProps}
        stage={{
          ...frameProps.stage!,
          progressDetail: "heartbeat 8.5s since last solver update",
          progressLabel: "solving",
          progressPercent: 35,
          status: "running",
        }}
      />,
      ["telemetry"],
    );

    expect(html).toContain("Eigenmode solve progress");
    expect(html).toContain("solving");
    expect(html).toContain("heartbeat 8.5s since last solver update");
    expect(html).not.toContain("fm-study-progress--indeterminate");
    expect(html).toContain("aria-valuenow=\"35\"");
  });

  it("keeps a running eigenmode stage visibly active without iteration telemetry", () => {
    const frameProps = props("eigenmodes");
    const html = render(
      <EigenmodesStageInspector
        {...frameProps}
        stage={{
          ...frameProps.stage!,
          commandId: "cmd-eigen-1",
          progressPercent: 0,
          startedAtUnixMs: 1_781_467_068_771,
          status: "running",
        }}
        stageExecutionRevision={650}
      />,
      ["telemetry", "eigenmodes-command-center", "eigenmodes-results"],
    );

    expect(html).toContain("stage running; per-iteration modal telemetry pending");
    expect(html).toContain(
      "running; solver stage is active; no modal iteration counter published yet",
    );
    expect(html).toContain(
      "simulation/stages/execution@650; stage lifecycle observed",
    );
    expect(html).toContain("2026-06-14T19:57:48.771Z");
    expect(html).toContain("not published");
    expect(html).toContain("cmd-eigen-1");
    expect(html).toContain("Effective modal request");
    expect(html).toContain("count 10; target lowest; equilibrium relax; boundary free");
    expect(html).toContain("Effective operator defaults");
    expect(html).toContain("linearized_llg; normalization unit_l2; damping ignore; demag included");
    expect(html).toContain(
      "lifecycle is running; modal iteration progress has not been published by the solver yet",
    );
    expect(html).toContain("requested 10; result artifacts pending");
  });

  it("shows driven-response PBC and active sweep telemetry without falling back to free", () => {
    const frameProps = props("frequency_response");
    const html = render(
      <FrequencyResponseStageInspector
        {...frameProps}
        authoringView="boundary"
        draft={
          {
            ...frameProps.draft!,
            bc: '{"kind":"periodic","axes":["x","y"]}',
            magnetostaticBc: "periodic_airbox_k0",
          } as typeof frameProps.draft
        }
        stage={{
          ...frameProps.stage!,
          commandId: "cmd-response-1",
          lastProgressUnixMs: 1_781_467_092_000,
          progressDetail: "frequency 3/7; current 3 GHz",
          progressLabel: "sweeping",
          progressPercent: 42,
          startedAtUnixMs: 1_781_467_068_771,
          status: "running",
        }}
        stageExecutionRevision={651}
      />,
      [
        "telemetry",
        "frequency-response-boundary-detail",
        "frequency-response-command-center",
        "frequency-response-wavevector",
      ],
    );

    expect(html).toContain("Frequency response sweep progress");
    expect(html).toContain("sweeping");
    expect(html).toContain("frequency 3/7; current 3 GHz");
    expect(html).toContain(
      "simulation/stages/execution@651; progress telemetry observed",
    );
    expect(html).toContain("cmd-response-1");
    expect(html).toContain("Spin-wave BC");
    expect(html).toContain("periodic; axes x, y");
    expect(html).toContain("Magnetostatic BC");
    expect(html).toContain("periodic_airbox_k0");
    expect(html).not.toContain("Boundary condition</span><span>free</span>");
  });

  it("enables hysteresis initial-state action when a point snapshot exists", () => {
    expect(hysteresisInitialStateActionPresentation("hysteresis_point_005")).toEqual({
      disabled: false,
      title: "Use point magnetization as the initial state for the selected or only object",
    });
    expect(hysteresisInitialStateActionPresentation(null)).toEqual({
      disabled: true,
      title: "Snapshot not saved for this point",
    });
  });

  it("routes hysteresis explorer child actions to the hysteresis inspector", () => {
    expect(resolveStudyStageInspectorKind("study.stage.action", "hysteresis")).toBe(
      "hysteresis",
    );
    expect(resolveStudyStageInspectorKind("study.stage.hysteresis", null)).toBe(
      "hysteresis",
    );
  });

  it("routes change-device stage nodes to the change-device inspector", () => {
    expect(
      resolveStudyStageInspectorKind("study.stage.change_device", null),
    ).toBe("change_device");
    expect(
      resolveStudyStageInspectorKind("study.stage.action", "change_device"),
    ).toBe("change_device");
  });

  it("routes add-field-drive instructions to their dedicated inspector", () => {
    expect(
      resolveStudyStageInspectorKind("study.stage.add_field_drive", null),
    ).toBe("add_field_drive");
    expect(
      resolveStudyStageInspectorKind("study.stage.action", "add_field_drive"),
    ).toBe("add_field_drive");
  });

  it("resolves every frequency-domain authoring child to a narrow draft view", () => {
    expect(
      resolveFrequencyDomainAuthoringView("study.stage.eigenmodes.setup"),
    ).toBe("setup");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.eigenmodes.equilibrium",
      ),
    ).toBe("equilibrium");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.eigenmodes.calculation_mode",
      ),
    ).toBe("calculation_mode");
    expect(
      resolveFrequencyDomainAuthoringView("study.stage.eigenmodes.operator"),
    ).toBe("operator");
    expect(
      resolveFrequencyDomainAuthoringView("study.stage.eigenmodes.k_path"),
    ).toBe("k_path");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.eigenmodes.boundary",
      ),
    ).toBe("boundary");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.eigenmodes.periodic_pairs",
      ),
    ).toBe("periodic_pairs");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.k_grid",
      ),
    ).toBe("k_grid");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.boundary",
      ),
    ).toBe("boundary");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.periodic_pairs",
      ),
    ).toBe("periodic_pairs");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.setup",
      ),
    ).toBe("setup");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.excitation",
      ),
    ).toBe("excitation");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.calculation_mode",
      ),
    ).toBe("calculation_mode");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.sweep",
      ),
    ).toBe("sweep");
    expect(
      resolveFrequencyDomainAuthoringView(
        "study.stage.frequency_response.outputs",
      ),
    ).toBe("outputs");
  });

  it("renders only equilibrium controls in the eigen equilibrium authoring view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="equilibrium"
      />,
      ["authoring", "eigenmodes-equilibrium-detail"],
    );

    expect(html).toContain("Equilibrium");
    expect(html).toContain("Eq artifact");
    expect(html).toContain("Linearization Point");
    expect(html).toContain("Physics invariant");
    expect(html).toContain("m0 x H0 ~= 0; |m0| = 1");
    expect(html).toContain("State provenance");
    expect(html).toContain("relaxed initial state");
    expect(html).toContain("Artifact readiness");
    expect(html).toContain("no artifact required for relax source");
    expect(html).not.toContain("Mode count");
    expect(html).not.toContain("k sampling");
  });

  it("renders response equilibrium readiness in the response equilibrium child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="equilibrium"
      />,
      ["authoring", "frequency-response-equilibrium-detail"],
    );

    expect(html).toContain("Linearization Point");
    expect(html).toContain("Response readiness");
    expect(html).toContain("same equilibrium can be reused for modal comparison");
    expect(html).toContain("Provenance link");
    expect(html).toContain("provided current state");
    expect(html).toContain("Artifact readiness");
    expect(html).toContain("no artifact required for provided source");
    expect(html).not.toContain("Modal Setup Contract");
  });

  it("renders the eigenmodes calculation-mode detail view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="calculation_mode"
      />,
      ["authoring", "eigenmodes-calculation-mode"],
    );

    expect(html).toContain("Eigenmodes Calculation Mode");
    expect(html).toContain("Workflow mode");
    expect(html).toContain("fmr_modal");
    expect(html).toContain("free_modes");
    expect(html).toContain("dispersion_modal");
    expect(html).toContain("StudyIR::Eigenmodes");
    expect(html).toContain("Save stage writes calculation_mode");
    expect(html).toContain("Apply calculation mode");
    expect(html).not.toContain("transaction wiring pending");
    expect(html).not.toContain("fmr_response");
  });

  it("renders modal setup semantics in the eigenmodes setup child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="setup"
      />,
      ["authoring", "eigenmodes-setup-detail"],
    );

    expect(html).toContain("Study Settings");
    expect(html).toContain("Mode request");
    expect(html).toContain("count 10; target lowest");
    expect(html).toContain("Operator preset");
    expect(html).toContain("linearized_llg tangent projection");
    expect(html).toContain("Requested execution");
    expect(html).toContain("backend/device/precision resolved by planner");
    expect(html).toContain("Expected result family");
    expect(html).toContain("FMR modal spectrum / free modes / dispersion");
    expect(html).not.toContain("Driven Response Setup Contract");
  });

  it("renders modal solver lane semantics in the eigenmodes solver child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="solver"
      />,
      ["authoring", "eigenmodes-solver-detail"],
    );

    expect(html).toContain("Solver Configuration");
    expect(html).toContain("Requested execution");
    expect(html).toContain("cpu; backend/device/precision resolved by planner");
    expect(html).toContain("Solver lane");
    expect(html).toContain("native SLEPc shift-invert modal lane with reference CPU parity path");
    expect(html).toContain("Tolerance policy");
    expect(html).toContain("residual, window, and tangent-space checks are published through eigen diagnostics");
    expect(html).toContain("Progress");
    expect(html).toContain("0%");
    expect(html).toContain("Runtime metric");
    expect(html).toContain("not available");
    expect(html).not.toContain("Driven Response Solver Contract");
  });

  it("renders editable excitation controls in the response excitation view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="excitation"
      />,
    );

    expect(html).toContain("Excitation");
    expect(html).toContain("Excitation phase");
    expect(html).toContain("Save stage");
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>.*Save stage.*<\/button>/,
    );
    expect(html).not.toContain("Frequencies");
    expect(html).not.toContain("k sampling");
  });

  it("renders modal operator semantics in the eigen operator child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="operator"
      />,
      ["authoring", "eigenmodes-operator-detail"],
    );

    expect(html).toContain("Physics and Variables");
    expect(html).toContain("linearized LLG tangent-space eigenproblem");
    expect(html).toContain("Demag term");
    expect(html).toContain("included");
    expect(html).toContain("Normalization");
    expect(html).toContain("unit_l2");
    expect(html).toContain("Damping policy");
    expect(html).toContain("ignore");
    expect(html).toContain("Backend semantics");
    expect(html).toContain("shared physics contract; execution resolves CPU/GPU later");
    expect(html).not.toContain("Driven Sweep Contract");
  });

  it("renders k-space workflow semantics in the eigen k-path child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="k_sampling"
      />,
      ["authoring", "eigenmodes-k-sampling-detail"],
    );

    expect(html).toContain("Modal k-Space Sampling");
    expect(html).toContain("Boundary condition");
    expect(html).toContain("free");
    expect(html).toContain("k vector");
    expect(html).toContain("not set");
    expect(html).toContain("k sampling");
    expect(html).toContain("Gamma/free FMR when empty; dispersion_modal when nonzero k-path is set");
    expect(html).toContain("Demag-k gate");
    expect(html).toContain("nonzero-k demag readiness is reported in diagnostics");
    expect(html).not.toContain("Driven Sweep Contract");
  });

  it("renders modal boundary semantics in the eigen boundary child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="boundary"
      />,
      ["authoring", "eigenmodes-boundary-detail"],
    );

    expect(html).toContain("Boundary");
    expect(html).toContain("Boundary condition");
    expect(html).toContain("free");
    expect(html).toContain("Supported choices");
    expect(html).toContain("free/open; static periodic; Floquet/Bloch");
    expect(html).toContain("Periodic pair requirement");
    expect(html).toContain("static periodic and Floquet require validated periodic pairs");
    expect(html).toContain("Single-k vector");
    expect(html).toContain("not set");
    expect(html).toContain("k-path handoff");
    expect(html).toContain("open Eigenmodes k-Path for dispersion sampling");
    expect(html).toContain("Phase convention");
    expect(html).toContain("exp(-i k dot delta_r)");
    expect(html).toContain("Floquet k=0 validation");
    expect(html).toContain("Floquet(k=0) == static periodic");
    expect(html).toContain("Nonzero-k demag gate");
    expect(html).toContain("nonzero-k dynamic demag unsupported while demag is enabled");
    expect(html).not.toContain("Driven Response Boundary Contract");
  });

  it("renders the frequency-response calculation-mode detail view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="calculation_mode"
      />,
      ["authoring", "frequency_response-calculation-mode"],
    );

    expect(html).toContain("Frequency Response Calculation Mode");
    expect(html).toContain("Workflow mode");
    expect(html).toContain("fmr_response");
    expect(html).toContain("response_map");
    expect(html).toContain("StudyIR::FrequencyResponse");
    expect(html).toContain("nonzero-k response unavailable");
    expect(html).toContain("Validate requirements");
    expect(html).toContain("Validate current calculation-mode requirements");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Validate requirements<\/button>/);
    expect(html).toContain("Save stage writes calculation_mode");
    expect(html).not.toContain("transaction wiring pending");
    expect(html).not.toContain("free_modes");
  });

  it("does not expose generic contract copy in frequency-domain stage child inspectors", () => {
    const eigenViews = [
      "setup",
      "equilibrium",
      "solver",
      "operator",
      "diagnostics",
      "outputs",
      "boundary",
      "periodic_pairs",
      "k_sampling",
      "k_path",
    ] as const;
    const responseViews = [
      "setup",
      "excitation",
      "equilibrium",
      "solver",
      "sweep",
      "outputs",
      "diagnostics",
      "boundary",
      "periodic_pairs",
      "k_grid",
    ] as const;

    const html = [
      ...eigenViews.map((authoringView) =>
        render(
          <EigenmodesStageInspector
            {...props("eigenmodes")}
            authoringView={authoringView}
          />,
          ["authoring"],
        ),
      ),
      ...responseViews.map((authoringView) =>
        render(
          <FrequencyResponseStageInspector
            {...props("frequency_response")}
            authoringView={authoringView}
          />,
          ["authoring"],
        ),
      ),
    ].join("\n");

    expect(html).not.toContain("Contract");
  });

  it("does not expose future-resource placeholder rows in frequency-domain child inspectors", () => {
    const eigenViews = [
      ["setup", "eigenmodes-setup-detail"],
      ["equilibrium", "eigenmodes-equilibrium-detail"],
      ["solver", "eigenmodes-solver-detail"],
      ["operator", "eigenmodes-operator-detail"],
      ["diagnostics", "eigenmodes-diagnostics-detail"],
      ["outputs", "eigenmodes-outputs-detail"],
      ["boundary", "eigenmodes-boundary-detail"],
      ["periodic_pairs", "eigenmodes-periodic-pairs-detail"],
      ["k_sampling", "eigenmodes-k-sampling-detail"],
      ["k_path", "eigenmodes-k-path-detail"],
    ] as const;
    const responseViews = [
      ["setup", "frequency-response-setup-detail"],
      ["excitation", "frequency-response-excitation-detail"],
      ["equilibrium", "frequency-response-equilibrium-detail"],
      ["solver", "frequency-response-solver-detail"],
      ["sweep", "frequency-response-sweep-detail"],
      ["outputs", "frequency-response-outputs-detail"],
      ["diagnostics", "frequency-response-diagnostics-detail"],
      ["boundary", "frequency-response-boundary-detail"],
      ["periodic_pairs", "frequency-response-periodic-pairs-detail"],
      ["k_grid", "frequency-response-k-grid-detail"],
    ] as const;

    const html = [
      ...eigenViews.map(([authoringView, detail]) =>
        render(
          <EigenmodesStageInspector
            {...props("eigenmodes")}
            authoringView={authoringView}
          />,
          ["authoring", detail],
        ),
      ),
      ...responseViews.map(([authoringView, detail]) =>
        render(
          <FrequencyResponseStageInspector
            {...props("frequency_response")}
            authoringView={authoringView}
          />,
          ["authoring", detail],
        ),
      ),
    ].join("\n");

    expect(html).not.toMatch(
      /not applicable|not available until|unavailable until|missing until|backend default until|capability-gated|Result artifact is not available yet/i,
    );
  });

  it("renders driven response setup semantics in the response setup child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="setup"
      />,
      ["authoring", "frequency-response-setup-detail"],
    );

    expect(html).toContain("Study Settings");
    expect(html).toContain("Direct solve");
    expect(html).toContain("(i omega B - L) q = f");
    expect(html).toContain("Executable lane");
    expect(html).toContain("FEM magnetic-only CPU response; double precision");
    expect(html).toContain("Frequency summary");
    expect(html).toContain("1 GHz");
    expect(html).not.toContain("Modal Setup Contract");
  });

  it("renders driven solver lane semantics in the response solver child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="solver"
      />,
      ["authoring", "frequency-response-solver-detail"],
    );

    expect(html).toContain("Solver Configuration");
    expect(html).toContain("Requested execution");
    expect(html).toContain("cpu; double precision production slice");
    expect(html).toContain("Solver lane");
    expect(html).toContain("matrix_free_solver; krylov_solver = gmres");
    expect(html).toContain("Tolerance policy");
    expect(html).toContain("response residuals and solver status are published through response diagnostics");
    expect(html).toContain("Progress");
    expect(html).toContain("0%");
    expect(html).toContain("Unsupported lanes");
    expect(html).toContain("GPU response, single precision, nonzero-k response, magnetoelastic response");
    expect(html).not.toContain("Modal Solver Contract");
  });

  it("renders driven excitation semantics in the response excitation child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="excitation"
      />,
      ["authoring", "frequency-response-excitation-detail"],
    );

    expect(html).toContain("Excitation");
    expect(html).toContain("Drive vector");
    expect(html).toContain("0, 0, 1 A/m");
    expect(html).toContain("Excitation phase");
    expect(html).toContain("0 rad");
    expect(html).toContain("Phase display");
    expect(html).toContain("0 deg");
    expect(html).toContain("Vector validation");
    expect(html).toContain("finite nonzero vector");
    expect(html).toContain("Phase validation");
    expect(html).toContain("finite phase");
    expect(html).toContain("Source selector");
    expect(html).toContain("field phasor; antenna/source support is reported in diagnostics");
    expect(html).toContain("Projection");
    expect(html).toContain("projected into local tangent plane");
    expect(html).toContain("Phasor convention");
    expect(html).toContain("delta_h exp(i omega t + phase_rad)");
    expect(html).not.toContain("Modal Operator Contract");
  });

  it("renders driven sweep semantics in the response sweep child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="sweep"
      />,
      ["authoring", "frequency-response-sweep-detail"],
    );

    expect(html).toContain("Frequency Sweep");
    expect(html).toContain("Frequency grid");
    expect(html).toContain("1 GHz");
    expect(html).toContain("Frequency count");
    expect(html).toContain("1 point(s)");
    expect(html).toContain("Estimated artifacts");
    expect(html).toContain("1 frequency-point artifact(s)");
    expect(html).toContain("Deduplication");
    expect(html).toContain("no duplicates");
    expect(html).toContain("Frequency validation");
    expect(html).toContain("all frequencies finite and positive");
    expect(html).toContain("Authoring units");
    expect(html).toContain("Hz input; results display auto-scales to MHz/GHz");
    expect(html).toContain("Observable");
    expect(html).toContain("susceptibility_tensor");
    expect(html).toContain("Partial artifacts");
    expect(html).toContain("write per-frequency point artifacts for progress/resume visibility");
    expect(html).not.toContain("Modal Operator Contract");
  });

  it("renders driven response boundary semantics in the response boundary child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="boundary"
      />,
      ["authoring", "frequency-response-boundary-detail"],
    );

    expect(html).toContain("Boundary");
    expect(html).toContain("Boundary condition");
    expect(html).toContain("free");
    expect(html).toContain("Current production slice");
    expect(html).toContain("k = 0 free/open or static-periodic response");
    expect(html).toContain("Static periodic");
    expect(html).toContain("requires validated mesh.periodic_node_pairs");
    expect(html).toContain("Floquet/Bloch response");
    expect(html).toContain("disabled until nonzero-k driven response is supported");
    expect(html).toContain("Periodic pair selector");
    expect(html).toContain("open Frequency Response Periodic Pairs");
    expect(html).toContain("Static periodic diagnostics");
    expect(html).toContain("projection, node pair count, frame mismatch, and drive mismatch");
    expect(html).not.toContain("Modal Boundary Contract");
  });

  it("renders driven response output products in the response outputs child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="outputs"
      />,
      ["authoring", "frequency-response-outputs-detail"],
    );

    expect(html).toContain("Output");
    expect(html).toContain("Primary observable");
    expect(html).toContain("susceptibility_tensor");
    expect(html).toContain("Complex magnetization response");
    expect(html).toContain("required for 3D response field visualization");
    expect(html).toContain("Susceptibility tensor");
    expect(html).toContain("enabled by observable susceptibility_tensor");
    expect(html).toContain("Absorbed power density");
    expect(html).toContain("published for FMR absorption charts when backend provides it");
    expect(html).toContain("Response amplitude/phase");
    expect(html).toContain("required for FMR sweep chart and peak table");
    expect(html).toContain("Frequency point metadata");
    expect(html).toContain("one JSON metadata artifact per solved frequency");
    expect(html).toContain("Response field payload");
    expect(html).toContain("complex vector payload for selected frequency 3D field");
    expect(html).toContain("Diagnostics output");
    expect(html).toContain(
      "response/diagnostics/solver.v1.json plus progress/cancel resources",
    );
    expect(html).not.toContain("Modal Outputs Contract");
  });

  it("renders modal diagnostics in the eigen diagnostics child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="diagnostics"
      />,
      ["authoring", "eigenmodes-diagnostics-detail"],
    );

    expect(html).toContain("Diagnostics");
    expect(html).toContain("UI validation");
    expect(html).toContain("valid");
    expect(html).toContain("IR validation");
    expect(html).toContain("Eigenmodes stage lowers to StudyIR::Eigenmodes");
    expect(html).toContain("Planner diagnostics");
    expect(html).toContain("backend/device/precision resolved during planning");
    expect(html).toContain("Capability matrix");
    expect(html).toContain("reference CPU modal path ready; native production modal readiness is reported in diagnostics");
    expect(html).toContain("Eigen diagnostics artifact");
    expect(html).toContain("eigen/diagnostics.v2.json");
    expect(html).toContain("Mode field diagnostics");
    expect(html).toContain("tangent leakage, residuals, normalization, and field payload presence");
    expect(html).not.toContain("Driven Response Diagnostics Contract");
  });

  it("renders modal output products in the eigen outputs child view", () => {
    const html = render(
      <EigenmodesStageInspector
        {...props("eigenmodes")}
        authoringView="outputs"
      />,
      ["authoring", "eigenmodes-outputs-detail"],
    );

    expect(html).toContain("Output");
    expect(html).toContain("Spectrum output");
    expect(html).toContain("eigen/spectrum.v2.json for modal FMR and free-mode tables");
    expect(html).toContain("Mode metadata");
    expect(html).toContain("per-sample/per-mode JSON metadata for selected modes");
    expect(html).toContain("Mode field payload");
    expect(html).toContain("Zarr complex vector payloads for 3D mode visualization");
    expect(html).toContain("Mode selection");
    expect(html).toContain("sample/mode selectors are enabled when spectrum metadata exists");
    expect(html).toContain("Dispersion output");
    expect(html).toContain("eigen/dispersion.csv when k-path sampling is active");
    expect(html).toContain("Branch tracking output");
    expect(html).toContain("eigen/branches.v2.json for branch-aware dispersion");
    expect(html).toContain("Diagnostics output");
    expect(html).toContain("eigen/diagnostics.v2.json for residuals, tangent leakage, and freshness");
    expect(html).toContain("Storage policy");
    expect(html).toContain("JSON metadata and Zarr field payloads; raw binary only as transitional export");
    expect(html).not.toContain("Driven Response Outputs Contract");
  });

  it("renders driven response diagnostics in the response diagnostics child view", () => {
    const html = render(
      <FrequencyResponseStageInspector
        {...props("frequency_response")}
        authoringView="diagnostics"
      />,
      ["authoring", "frequency-response-diagnostics-detail"],
    );

    expect(html).toContain("Diagnostics");
    expect(html).toContain("UI validation");
    expect(html).toContain("valid");
    expect(html).toContain("IR validation");
    expect(html).toContain("FrequencyResponse stage lowers to FemFrequencyResponsePlanIR");
    expect(html).toContain("Planner rejection reasons");
    expect(html).toContain("GPU response, single precision, nonzero-k response, magnetoelastic response");
    expect(html).toContain("Capability matrix");
    expect(html).toContain("magnetic CPU partial production; GPU and nonzero-k response unsupported");
    expect(html).toContain("Response progress resource");
    expect(html).toContain("response/progress.v1.json and response/cancel_requested.v1.json");
    expect(html).toContain("Diagnostics artifact");
    expect(html).toContain("response/diagnostics/solver.v1.json");
    expect(html).toContain("Static periodic diagnostics");
    expect(html).toContain("shared periodic pair resource when static-periodic response is selected");
    expect(html).not.toContain("Modal Diagnostics Contract");
  });

  it("resolves dedicated hysteresis inspector views from explorer child nodes", () => {
    expect(resolveHysteresisInspectorView("study:stage:0:plan")).toBe("plan");
    expect(resolveHysteresisInspectorView("study:stage:0:protocol")).toBe(
      "protocol",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:orientation")).toBe(
      "orientation",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:saturation")).toBe(
      "saturation",
    );
    expect(
      resolveHysteresisInspectorView("study:stage:0:adaptive-refinement"),
    ).toBe("adaptive-refinement");
    expect(resolveHysteresisInspectorView("study:stage:0:angular-family")).toBe(
      "angular-family",
    );
    expect(
      resolveHysteresisInspectorView(
        "model:study:stages:stage:hysteresis-1:settle-pipeline",
      ),
    ).toBe("settle-pipeline");
    expect(resolveHysteresisInspectorView("study:stage:0:live-run")).toBe(
      "live-run",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:points:completed")).toBe(
      "points-completed",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:points:queued")).toBe(
      "points-queued",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:points:planned")).toBe(
      "points-planned",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:points:bookmarks")).toBe(
      "points-bookmarks",
    );
    expect(
      resolveHysteresisInspectorView(
        "study:stage:0:points:bookmarks:snapshot:hysteresis_point_004",
      ),
    ).toBe("snapshots");
    expect(
      resolveHysteresisInspectorView(
        "study:stage:0:points:bookmarks:key_event:switching-004",
      ),
    ).toBe("points-bookmarks");
    expect(resolveHysteresisInspectorView("study:stage:0:branches:forward")).toBe(
      "branch-detail",
    );
    expect(
      resolveHysteresisInspectorView("study:stage:0:branches:branch:ascending"),
    ).toBe("branch-detail");
    expect(
      resolveHysteresisInspectorView(
        "study:stage:0:branches:branch:ascending:field-point:12",
      ),
    ).toBe("point-detail");
    expect(
      resolveHysteresisInspectorView("study:stage:0:branches:minor-loops"),
    ).toBe("branch-detail");
    expect(resolveHysteresisInspectorView("study:stage:0:field-point:4")).toBe(
      "point-detail",
    );
    expect(
      resolveHysteresisInspectorView(
        "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_004",
      ),
    ).toBe("snapshots");
    expect(resolveHysteresisInspectorView("study:stage:0:field-point:4:algorithm:0")).toBe(
      "settle-trace",
    );
    expect(
      resolveHysteresisInspectorView(
        "study:stage:0:field-point:4:warning:point-4-warnings",
      ),
    ).toBe("execution-node");
    expect(
      resolveHysteresisInspectorView(
        "study:stage:0:field-point:4:key_event:switching-004",
      ),
    ).toBe("execution-node");
    expect(resolveHysteresisInspectorView("study:stage:0:field-current:algorithm:0")).toBe(
      "settle-pipeline",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:field-current")).toBe(
      "current-field",
    );
    expect(resolveHysteresisInspectorView("study:stage:0:transitions")).toBe(
      "transitions",
    );
    expect(
      resolveHysteresisInspectorView("study:stage:0:transitions:use-selected-point"),
    ).toBe("transitions");
    expect(resolveHysteresisInspectorView("study:stage:0:state-transition")).toBe(
      "transitions",
    );
  });

  it("renders only the selected dedicated hysteresis child inspector view", () => {
    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="saturation" />,
      ["hysteresis-saturation"],
    );

    expect(markup).toContain("Auto-Saturation");
    expect(markup).not.toContain("Measurement Plan");
    expect(markup).not.toContain("Loop Metrics");
    expect(markup.indexOf("Auto-Saturation")).toBeLessThan(
      markup.indexOf("Identity"),
    );
  });

  it("renders the selected hysteresis settle pipeline child inspector view", () => {
    const customProps = props("hysteresis");
    customProps.draft = {
      ...createDefaultStudyStageDraft("hysteresis", 0),
      settleSteps: JSON.stringify([
        {
          applies_to: "major",
          damping: 0.5,
          kind: "dynamics_settle",
          max_steps: 25,
          method: "heun_dynamics_settle",
          on_non_convergence: "retry_with_smaller_dt",
          retry_max_attempts: 3,
          retry_timestep_scale: 0.5,
          step_id: "field-dynamics",
          stop_criteria: {
            max_torque_T: 1e-4,
          },
          timestep_s: 1e-12,
        },
      ]),
      settleBranches: JSON.stringify([
        {
          branch_id: "non_converged_fallback",
          run: {
            alpha: 1,
            kind: "relax",
            max_steps: 100,
            method: "llg_overdamped",
            on_non_convergence: "continue_with_warning",
            torque_tolerance: 1e-5,
          },
          when: "non_converged",
        },
      ]),
      settlePipelineMode: "tree",
    };
    const markup = render(
      <HysteresisStageInspector
        {...customProps}
        view="settle-pipeline"
      />,
      ["hysteresis-settle"],
    );

    expect(markup).toContain("Settle Pipeline");
    expect(markup).toContain("field-dynamics");
    expect(markup).toContain("dynamics_settle");
    expect(markup).toContain("Applies to: major");
    expect(markup).toContain("Damping: 0.5");
    expect(markup).toContain("Retry scale: 0.5");
    expect(markup).toContain("Retry attempts: 3");
    expect(markup).toContain("Stop criteria");
    expect(markup).toContain("max_torque_T");
    expect(markup).toContain("Fallback branches");
    expect(markup).toContain("non_converged_fallback");
    expect(markup).toContain("Trigger: non_converged");
    expect(markup).toContain("Run: relax");
    expect(markup).not.toContain("Measurement Plan");
    expect(markup).not.toContain("Live Progress");
    expect(markup.indexOf("Settle Pipeline")).toBeLessThan(
      markup.indexOf("Identity"),
    );
  });

  it("renders a dedicated hysteresis orientation inspector from the orientation resource", () => {
    const orientationKey = SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    sharedResourceRuntimeStore.updateData(
      orientationKey,
      {
        direction: [0, 1, 0],
        measurement_axis: "field_axis",
        orientation: { kind: "preset", preset_name: "in_plane_y" },
        revision: 42,
        stage_id: "hysteresis-1",
        stage_index: 0,
      },
      0,
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="orientation" />,
      ["hysteresis-orientation"],
    );

    expect(markup).toContain("Field Orientation");
    expect(markup).toContain("in_plane_y");
    expect(markup).toContain("0.00000, 1.00000, 0.00000");
    expect(markup).toContain("field_axis");
    expect(markup).toContain("42");
    expect(markup).not.toContain("Measurement Plan");
    expect(markup).not.toContain("Settle Pipeline");
    expect(markup.indexOf("Field Orientation")).toBeLessThan(
      markup.indexOf("Identity"),
    );
  });

  it("renders a dedicated hysteresis forward branch detail inspector", () => {
    const branchesKey = ANALYSIS_HYSTERESIS_BRANCHES_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const branches: HysteresisBranchSchema[] = [
      {
        branch_id: "descending",
        branch_index: 0,
        branch_role: "forward_descending",
        direction: -1,
        point_count: 2,
        start_point_id: 0,
        end_point_id: 1,
        start_field_mT: 100,
        end_field_mT: -100,
        parent_branch_id: null,
        minor_loop_id: null,
        points: [],
      },
    ];
    sharedResourceRuntimeStore.updateData(
      branchesKey,
      hysteresisBranchesResource(branches),
      0,
    );
    selection.set(
      {
        kind: "study.stage.action",
        label: "Forward",
        nodeId: "model:study:stages:stage:hysteresis-1:branches:forward",
        objectId: null,
        ref: {
          kind: "study.stage.action",
          nodeId: "model:study:stages:stage:hysteresis-1:branches:forward",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="branch-detail" />,
      ["hysteresis-branch-detail"],
    );

    expect(markup).toContain("Forward Branch");
    expect(markup).toContain("descending");
    expect(markup).toContain("forward_descending");
    expect(markup).toContain("100.000");
    expect(markup).toContain("-100.000");
    expect(markup).toContain("This branch has no embedded point list");

    selection.clear("explorer");
  });

  it("renders a runtime hysteresis branch detail inspector by branch id", () => {
    const branchesKey = ANALYSIS_HYSTERESIS_BRANCHES_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const branches: HysteresisBranchSchema[] = [
      {
        branch_id: "descending",
        branch_index: 0,
        branch_role: "forward_descending",
        direction: -1,
        point_count: 2,
        start_point_id: 0,
        end_point_id: 1,
        start_field_mT: 100,
        end_field_mT: -100,
        parent_branch_id: null,
        minor_loop_id: null,
        points: [],
      },
      {
        branch_id: "ascending",
        branch_index: 1,
        branch_role: "return_ascending",
        direction: 1,
        point_count: 3,
        start_point_id: 2,
        end_point_id: 4,
        start_field_mT: -100,
        end_field_mT: 100,
        parent_branch_id: null,
        minor_loop_id: null,
        points: [],
      },
    ];
    sharedResourceRuntimeStore.updateData(
      branchesKey,
      hysteresisBranchesResource(branches),
      0,
    );
    selection.set(
      {
        kind: "study.stage.action",
        label: "Ascending branch",
        nodeId: "model:study:stages:stage:hysteresis-1:branches:branch:ascending",
        objectId: null,
        ref: {
          hysteresisExecutionNodeId: "branch:ascending",
          hysteresisExecutionNodeKind: "branch",
          kind: "study.stage.action",
          nodeId:
            "model:study:stages:stage:hysteresis-1:branches:branch:ascending",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="branch-detail" />,
      ["hysteresis-branch-detail"],
    );

    expect(markup).toContain("ascending");
    expect(markup).toContain("return_ascending");
    expect(markup).toContain("3 point(s)");
    expect(markup).not.toContain("forward_descending");

    selection.clear("explorer");
  });

  it("renders a dedicated hysteresis minor-loop branch detail inspector", () => {
    const minorLoopsKey = ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const minorLoops: HysteresisMinorLoopSchema[] = [
      {
        loop_id: "minor-1",
        reversal_field_mT: -20,
        return_field_mT: 35,
        parent_branch_id: "descending",
        reversal_point_id: 4,
        return_point_id: 9,
        policy: "closed",
        closure_status: "closed",
        closure_error_m_parallel: 0.003,
        recoil_susceptibility: 0.12,
        minor_loop_area: 4.5,
        settle_trace: [],
        points: [],
      },
    ];
    sharedResourceRuntimeStore.updateData(
      minorLoopsKey,
      hysteresisMinorLoopsResource(minorLoops),
      0,
    );
    selection.set(
      {
        kind: "study.stage.action",
        label: "Minor Loops",
        nodeId: "model:study:stages:stage:hysteresis-1:branches:minor-loops",
        objectId: null,
        ref: {
          kind: "study.stage.action",
          nodeId: "model:study:stages:stage:hysteresis-1:branches:minor-loops",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="branch-detail" />,
      ["hysteresis-branch-detail"],
    );

    expect(markup).toContain("Minor Loops");
    expect(markup).toContain("minor-1");
    expect(markup).toContain("closed");
    expect(markup).toContain("-20.000");
    expect(markup).toContain("35.000");
    expect(markup).toContain("closure error");
    expect(markup).toContain("recoil susceptibility");

    selection.clear("explorer");
  });

  it("renders live hysteresis field and active algorithm from the progress resource", () => {
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 4,
      completed_points: 4,
      current_field_mT: 87.5,
      current_point_index: 4,
      current_settle_step_index: 1,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 76,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };

    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-live-progress"],
    );

    expect(markup).toContain("87.50 mT");
    expect(markup).toContain("87.500");
    expect(markup).toContain("5 / 81");
    expect(markup).toContain("minimize projected_gradient_bb");
  });

  it("warns when saturation status only reflects an unverified preparation field", () => {
    const metricsKey = ANALYSIS_HYSTERESIS_METRICS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const metrics: HysteresisMetricsSchema = {
      H_c: 12.5,
      H_c_minus: -13,
      H_c_plus: 12,
      H_eb: -0.5,
      M_r_minus: -0.4,
      M_r_plus: 0.42,
      loop_area: 8.75,
      magnetization_average_weighting: "uniform_sample_average",
      saturation_preparation_field_mT: 300,
      saturation_status: "preparation_applied_unverified",
    };
    const metricsResource: HysteresisMetricsResource = {
      metrics,
      revision: 1,
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(metricsKey, metricsResource, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="saturation" />,
      ["hysteresis-saturation"],
    );

    expect(markup).toContain("Preparation field only");
    expect(markup).toContain("H_sat is not confirmed");
    expect(markup).toContain("coercivity and remanence metrics have limited interpretation");
  });

  it("shows active first-point calculation before any hysteresis point is completed", () => {
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 0,
      completed_points: 0,
      current_field_mT: 200,
      current_point_index: 0,
      current_settle_step_index: 0,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 80,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("0 / 81 done");
    expect(markup).toContain("Calculating point 1 / 81 at 200.000 mT.");
    expect(markup).not.toContain("No calculated points available.");
  });

  it("renders hysteresis point settle quality warnings", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        field_value_mT: -50,
        has_non_converged_steps: true,
        m_avg: [0.0, 0.0, -0.42],
        m_ip: 0,
        m_oop: -0.42,
        m_parallel: -0.42,
        minor_loop_id: null,
        parent_branch_id: null,
        point_id: 2,
        protocol_role: "return",
        recoil_start_point_id: null,
        reversal_index: null,
        run_status: "Completed",
        settle_status: "non_converged",
        snapshot_id: "hysteresis_point_003",
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_003`,
        status: "Completed",
        terminal_settle_reason: "converged",
        warning_count: 1,
      },
    ];
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("Settle");
    expect(markup).toContain("non_converged");
    expect(markup).toContain("1 warning");
  });

  it("marks adaptive refinement points in the hysteresis points table", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        adaptive_inserted: true,
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        field_value_mT: -12.5,
        has_non_converged_steps: false,
        m_avg: [0.0, 0.0, -0.12],
        m_ip: 0,
        m_oop: -0.12,
        m_parallel: -0.12,
        minor_loop_id: null,
        parent_branch_id: null,
        point_id: 7,
        protocol_role: "adaptive",
        recoil_start_point_id: null,
        refinement_parent_left_point_id: 3,
        refinement_parent_right_point_id: 4,
        refinement_reason: ["zero_crossing", "high_susceptibility"],
        reversal_index: null,
        run_status: "Completed",
        settle_status: "converged",
        status: "Completed",
        terminal_settle_reason: "converged",
        warning_count: 0,
      },
    ];
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("Source");
    expect(markup).toContain("Adaptive");
    expect(markup).toContain("Adaptive refinement: zero_crossing, high_susceptibility");
  });

  it("warns when progress reports completed hysteresis points but history is empty", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 1,
      completed_points: 1,
      current_field_mT: 95,
      current_point_index: 1,
      current_settle_step_index: 0,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 79,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource([]), 0);
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("Hysteresis progress reports 1 completed point, but no point history is available.");
  });

  it("renders a dedicated completed hysteresis points inspector", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        point_id: 4,
        field_value_mT: 25,
        m_parallel: 0.8,
        m_oop: 0.7,
        m_ip: 0.1,
        m_avg: [0.1, 0.2, 0.8],
        status: "completed",
        run_status: "completed",
        settle_status: "converged",
        has_non_converged_steps: false,
        terminal_settle_reason: "converged",
        warning_count: 0,
        snapshot_id: "hysteresis_point_005",
        protocol_role: "descending",
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        parent_branch_id: null,
        minor_loop_id: null,
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_json_artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshot_zarr_store_ref: "hysteresis.zarr",
        snapshot_storage_format: "zarr_v2_json_fallback",
        field_vector_A_per_m: [0, 0, 19894.367886486918],
        field_orientation: { kind: "preset", preset_name: "oop_positive" },
        measurement_axis: "field_axis",
        field_display_unit: "mT",
        is_reversal_field: false,
        reversal_index: null,
        recoil_start_point_id: null,
      },
    ];
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 5,
      completed_points: 1,
      current_field_mT: 12.5,
      current_point_index: 5,
      current_settle_step_index: 0,
      current_settle_step_kind: "relax",
      current_settle_step_method: "llg_overdamped",
      queued_points: 79,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 80,
    };
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points-completed" />,
      ["hysteresis-points-completed"],
    );

    expect(markup).toContain("Completed Points");
    expect(markup).toContain("1 completed");
    expect(markup).toContain("Role");
    expect(markup).toContain("Branch");
    expect(markup).toContain("H (mT)");
    expect(markup).toContain("Angle");
    expect(markup).toContain("M_oop");
    expect(markup).toContain("M_ip");
    expect(markup).toContain("M_x");
    expect(markup).toContain("M_y");
    expect(markup).toContain("M_z");
    expect(markup).toContain("Snapshot");
    expect(markup).toContain("25.00");
    expect(markup).toContain("0.80000");
    expect(markup).toContain("0.70000");
    expect(markup).toContain("0.10000");
    expect(markup).toContain("0.20000");
    expect(markup).toContain("descending");
    expect(markup).toContain("oop_positive");
    expect(markup).toContain("available");
    expect(markup).toContain(">3D<");
    expect(markup).toContain(">Init<");
    expect(markup).toContain(">Compare<");
    expect(markup).toContain(">Bookmark<");
    expect(markup).toContain(">Export<");
  });

  it("renders a dedicated queued hysteresis points inspector", () => {
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 1,
      completed_points: 1,
      current_field_mT: 95,
      current_point_index: 1,
      current_settle_step_index: 0,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 79,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points-queued" />,
      ["hysteresis-points-queued"],
    );

    expect(markup).toContain("Queued Points");
    expect(markup).toContain("79 queued");
    expect(markup).toContain("79 field points remain queued");
    expect(markup).toContain("Detailed point records will appear after each field step is completed");
  });

  it("renders a dedicated planned hysteresis points inspector", () => {
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progress: HysteresisProgressSchema = {
      active: true,
      active_point_index: 1,
      completed_points: 1,
      current_field_mT: 95,
      current_point_index: 1,
      current_settle_step_index: 0,
      current_settle_step_kind: "minimize",
      current_settle_step_method: "projected_gradient_bb",
      queued_points: 79,
      revision: 0,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "running",
      total_points: 81,
    };
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points-planned" />,
      ["hysteresis-points-planned"],
    );

    expect(markup).toContain("Planned Points");
    expect(markup).toContain("81 planned");
    expect(markup).toContain("81 field points are planned; 1 have completed");
  });

  it("renders a dedicated hysteresis point bookmarks inspector", () => {
    const executionTreeKey = `${SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    )}?after=1&before=1&include_bookmarks=true&include_snapshots=true&include_warnings=true&window=active`;
    const executionTree: HysteresisExecutionTreeResource = {
      active_point_index: 4,
      after: 1,
      before: 1,
      include_bookmarks: true,
      include_snapshots: true,
      include_warnings: true,
      nodes: [
        {
          children: [
            {
              kind: "snapshot",
              label: "Snapshot hysteresis_point_005",
              node_id: "snapshot:hysteresis_point_005",
              point_id: 4,
              resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
              selection_ref: "hysteresis-snapshot:hysteresis-1:4:hysteresis_point_005",
              settle_step_id: null,
              stage_id: "hysteresis-1",
              status: "completed",
              updated_revision: 5,
            },
          ],
          kind: "bookmark",
          label: "Coercivity candidate",
          node_id: "bookmark:hc",
          point_id: 4,
          resource_ref: null,
          selection_ref: "hysteresis-bookmark:hysteresis-1:4",
          settle_step_id: null,
          stage_id: "hysteresis-1",
          status: "completed",
          updated_revision: 5,
        },
        {
          kind: "key_event",
          label: "Reversal field",
          node_id: "event:reversal",
          point_id: 6,
          resource_ref: null,
          selection_ref: "hysteresis-key-event:hysteresis-1:6",
          settle_step_id: null,
          stage_id: "hysteresis-1",
          status: "completed",
          updated_revision: 6,
        },
      ],
      revision: 6,
      stage_id: "hysteresis-1",
      stage_index: 0,
      total_points: 9,
      window: "active",
    };
    const bookmarksKey = ANALYSIS_HYSTERESIS_BOOKMARKS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const bookmarks: HysteresisBookmarksResource = {
      bookmarks: [
        {
          bookmark_id: "bookmark:hc",
          created_at_unix_ms: "1710000000000",
          field_value_mT: 25,
          label: "Coercivity candidate",
          point_id: 4,
          resource_ref: "analysis/hysteresis/hysteresis-1/points/4",
          selection_ref: "hysteresis-bookmark:hysteresis-1:4",
          snapshot_id: "hysteresis_point_005",
          snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005&stage_id=hysteresis-1`,
          stage_id: "hysteresis-1",
          status: "completed",
        },
      ],
      revision: 7,
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(bookmarksKey, bookmarks, 0);
    sharedResourceRuntimeStore.updateData(executionTreeKey, executionTree, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points-bookmarks" />,
      ["hysteresis-points-bookmarks"],
    );

    expect(markup).toContain("Point Markers");
    expect(markup).toContain("3 markers");
    expect(markup).toContain("Coercivity candidate");
    expect(markup).toContain("analysis/hysteresis/hysteresis-1/points/4");
    expect(markup).toContain("Snapshot hysteresis_point_005");
    expect(markup).toContain("Reversal field");
    expect(markup).toContain("hysteresis-snapshot:hysteresis-1:4:hysteresis_point_005");
  });

  it("renders a dedicated hysteresis execution node inspector", () => {
    const executionTreeKey = `${SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    )}?after=1&before=1&include_bookmarks=true&include_snapshots=true&include_warnings=true&window=active`;
    const executionTree: HysteresisExecutionTreeResource = {
      active_point_index: 7,
      after: 1,
      before: 1,
      include_bookmarks: true,
      include_snapshots: true,
      include_warnings: true,
      nodes: [
        {
          children: [
            {
              kind: "warning",
              label: "2 warning(s)",
              node_id: "point-7:warnings",
              point_id: 7,
              resource_ref: "analysis/hysteresis/hysteresis-1/points/7",
              selection_ref: "hysteresis-warning:hysteresis-1:7",
              settle_step_id: null,
              stage_id: "hysteresis-1",
              status: "warning",
              updated_revision: 23,
            },
          ],
          kind: "field_point",
          label: "Field +30 mT",
          node_id: "point-7",
          point_id: 7,
          resource_ref: null,
          selection_ref: null,
          settle_step_id: null,
          stage_id: "hysteresis-1",
          status: "active",
          updated_revision: 23,
        },
      ],
      revision: 23,
      stage_id: "hysteresis-1",
      stage_index: 0,
      total_points: 21,
      window: "active",
    };
    sharedResourceRuntimeStore.updateData(executionTreeKey, executionTree, 0);
    selection.set(
      {
        kind: "study.stage.action",
        label: "2 warning(s)",
        nodeId:
          "model:study:stages:stage:hysteresis-1:field-point:7:warning:point-7-warnings",
        objectId: null,
        ref: {
          hysteresisExecutionNodeId: "point-7:warnings",
          hysteresisExecutionNodeKind: "warning",
          hysteresisPointId: 7,
          kind: "study.stage.action",
          nodeId:
            "model:study:stages:stage:hysteresis-1:field-point:7:warning:point-7-warnings",
          resourceRef: "analysis/hysteresis/hysteresis-1/points/7",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="execution-node" />,
      ["hysteresis-execution-node"],
    );

    expect(markup).toContain("Execution Node");
    expect(markup).toContain("2 warning(s)");
    expect(markup).toContain("point-7:warnings");
    expect(markup).toContain("hysteresis-warning:hysteresis-1:7");
    expect(markup).toContain("analysis/hysteresis/hysteresis-1/points/7");

    selection.clear("explorer");
  });

  it("renders an active hysteresis snapshot with a return-to-live action", () => {
    selection.set(
      {
        kind: "analysis.chart-point",
        label: "Point 4 (25 mT)",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        objectId: null,
        ref: {
          chartId: "hysteresis:hysteresis-1",
          kind: "analysis.chart-point",
          nodeId: "analysis:hysteresis:hysteresis-1:point:4",
          pointId: 4,
          quantity: "m",
          rowIndex: 4,
          seriesId: "hysteresis:hysteresis-1:m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          tableId: "hysteresis:hysteresis-1",
          type: "analysis-chart-point",
          x: 25,
          y: 0.8,
        },
      },
      "analysis-plots",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-live-progress"],
    );

    expect(markup).toContain("Snapshot hysteresis_point_005");
    expect(markup).toContain("4 at 25.000 mT");
    expect(markup).toContain("Return to live");

    selection.clear("analysis-plots");
  });

  it("renders a dedicated hysteresis transitions inspector for selected saved points", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const progressKey = SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        point_id: 4,
        field_value_mT: 25,
        m_parallel: 0.8,
        m_oop: 0.7,
        m_ip: 0.1,
        m_avg: [0.1, 0.2, 0.8],
        status: "completed",
        run_status: "completed",
        settle_status: "converged",
        has_non_converged_steps: false,
        terminal_settle_reason: "converged",
        warning_count: 0,
        snapshot_id: "hysteresis_point_005",
        protocol_role: "descending",
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        parent_branch_id: null,
        minor_loop_id: null,
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_json_artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshot_zarr_store_ref: "hysteresis.zarr",
        snapshot_storage_format: "zarr_v2_json_fallback",
        field_vector_A_per_m: [0, 0, 19894.367886486918],
        field_orientation: { kind: "preset", preset_name: "oop_positive" },
        measurement_axis: "field_axis",
        field_display_unit: "mT",
        is_reversal_field: false,
        reversal_index: null,
        recoil_start_point_id: null,
      },
    ];
    const progress: HysteresisProgressSchema = {
      active: false,
      active_point_index: null,
      completed_points: 5,
      current_field_mT: null,
      current_settle_step_index: null,
      current_settle_step_kind: null,
      current_settle_step_method: null,
      queued_points: 0,
      revision: 1,
      stage_id: "hysteresis-1",
      stage_index: 0,
      stage_kind: "hysteresis",
      status: "completed",
      total_points: 5,
    };
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);
    sharedResourceRuntimeStore.updateData(progressKey, progress, 0);
    selection.set(
      {
        kind: "analysis.chart-point",
        label: "Point 4 (25 mT)",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        objectId: null,
        ref: {
          chartId: "hysteresis:hysteresis-1",
          kind: "analysis.chart-point",
          nodeId: "analysis:hysteresis:hysteresis-1:point:4",
          pointId: 4,
          quantity: "m",
          rowIndex: 4,
          seriesId: "hysteresis:hysteresis-1:m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          tableId: "hysteresis:hysteresis-1",
          type: "analysis-chart-point",
          x: 25,
          y: 0.8,
        },
      },
      "analysis-plots",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="transitions" />,
      ["hysteresis-transitions"],
    );

    expect(markup).toContain("Transitions");
    expect(markup).toContain("5 / 5");
    expect(markup).toContain("4 at 25.000 mT");
    expect(markup).toContain("Continue to next stage");
    expect(markup).not.toContain("explicit action pending runtime command");
    expect(markup).toContain("Export loop CSV");
    expect(markup).toContain("Use selected point as initial");
    expect(markup).not.toContain("Select a saved hysteresis point");

    selection.clear("analysis-plots");
  });

  it("renders active 3D replay controls in the hysteresis points inspector", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        point_id: 4,
        field_value_mT: 25,
        m_parallel: 0.8,
        m_oop: 0.7,
        m_ip: 0.1,
        m_avg: [0.1, 0.2, 0.8],
        status: "completed",
        run_status: "completed",
        settle_status: "converged",
        has_non_converged_steps: false,
        terminal_settle_reason: "converged",
        warning_count: 0,
        snapshot_id: "hysteresis_point_005",
        protocol_role: "descending",
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        parent_branch_id: null,
        minor_loop_id: null,
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_json_artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshot_zarr_store_ref: "hysteresis.zarr",
        snapshot_storage_format: "zarr_v2_json_fallback",
        field_vector_A_per_m: [0, 0, 19894.367886486918],
        field_orientation: { kind: "preset", preset_name: "oop_positive" },
        measurement_axis: "field_axis",
        field_display_unit: "mT",
        is_reversal_field: false,
        reversal_index: null,
        recoil_start_point_id: null,
      },
    ];
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);
    selection.set(
      {
        kind: "analysis.chart-point",
        label: "Point 4 (25 mT)",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        objectId: null,
        ref: {
          chartId: "hysteresis:hysteresis-1",
          kind: "analysis.chart-point",
          nodeId: "analysis:hysteresis:hysteresis-1:point:4",
          pointId: 4,
          quantity: "m",
          rowIndex: 4,
          seriesId: "hysteresis:hysteresis-1:m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          tableId: "hysteresis:hysteresis-1",
          type: "analysis-chart-point",
          x: 25,
          y: 0.8,
        },
      },
      "analysis-plots",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("3D viewport state");
    expect(markup).toContain("Snapshot hysteresis_point_005");
    expect(markup).toContain("Point 4 at 25.000 mT");
    expect(markup).toContain("Return to live");
    expect(markup).toContain("Export loop CSV");

    selection.clear("analysis-plots");
  });

  it("renders a dedicated hysteresis field-point detail inspector", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const pointKey = ANALYSIS_HYSTERESIS_POINT_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    ).replace("{point_id}", "4");
    const points: HysteresisPointSchema[] = [
      {
        point_id: 4,
        field_value_mT: 25,
        m_parallel: 0.8,
        m_oop: 0.7,
        m_ip: 0.1,
        m_avg: [0.1, 0.2, 0.8],
        status: "completed",
        run_status: "completed",
        settle_status: "converged",
        has_non_converged_steps: false,
        terminal_settle_reason: "torque_threshold",
        warning_count: 0,
        snapshot_id: "hysteresis_point_005",
        protocol_role: "descending",
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        parent_branch_id: null,
        minor_loop_id: null,
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_json_artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshot_zarr_store_ref: "hysteresis.zarr",
        snapshot_storage_format: "zarr_v2_json_fallback",
        snapshot_storage_status: "available",
        snapshot_storage_reason: "snapshot found in hysteresis.zarr",
        field_vector_A_per_m: [0, 0, 19894.367886486918],
        field_orientation: { kind: "preset", preset_name: "oop_positive" },
        measurement_axis: "field_axis",
        field_display_unit: "mT",
        is_reversal_field: false,
        reversal_index: null,
        recoil_start_point_id: null,
      },
    ];
    const pointDetail: HysteresisPointSchema = {
      ...points[0],
      m_parallel: 0.91,
      terminal_settle_reason: "resource_detail",
    };
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);
    sharedResourceRuntimeStore.updateData(pointKey, pointDetail, 3);
    selection.set(
      {
        kind: "study.stage.action",
        label: "Field point 4",
        nodeId: "model:study:stages:stage:hysteresis-1:field-point:4",
        objectId: null,
        ref: {
          kind: "study.stage.action",
          nodeId: "model:study:stages:stage:hysteresis-1:field-point:4",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="point-detail" />,
      ["hysteresis-point-detail"],
    );

    expect(markup).toContain("Field Point");
    expect(markup).toContain("25.000");
    expect(markup).toContain("0.910000");
    expect(markup).toContain("resource_detail");
    expect(markup).toContain("hysteresis_point_005");
    expect(markup).toContain("Load 3D");
    expect(markup).toContain("Use as initial");

    selection.clear("explorer");
  });

  it("renders saved hysteresis snapshots with replay and initial-state actions", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        point_id: 4,
        field_value_mT: 25,
        m_parallel: 0.8,
        m_oop: 0.7,
        m_ip: 0.1,
        m_avg: [0.1, 0.2, 0.8],
        status: "completed",
        run_status: "completed",
        settle_status: "converged",
        has_non_converged_steps: false,
        terminal_settle_reason: "converged",
        warning_count: 0,
        snapshot_id: "hysteresis_point_005",
        protocol_role: "descending",
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        parent_branch_id: null,
        minor_loop_id: null,
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_json_artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshot_zarr_store_ref: "hysteresis.zarr",
        snapshot_storage_format: "zarr_v2_json_fallback",
        snapshot_storage_status: "available",
        snapshot_storage_reason: "snapshot found in hysteresis.zarr",
        field_vector_A_per_m: [0, 0, 19894.367886486918],
        field_orientation: { kind: "preset", preset_name: "oop_positive" },
        measurement_axis: "field_axis",
        field_display_unit: "mT",
        is_reversal_field: false,
        reversal_index: null,
        recoil_start_point_id: null,
      },
    ];
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);
    selection.set(
      {
        kind: "study.stage.action",
        label: "Snapshot hysteresis_point_005",
        nodeId:
          "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_005",
        objectId: null,
        ref: {
          kind: "study.stage.action",
          nodeId:
            "model:study:stages:stage:hysteresis-1:field-point:4:snapshot:hysteresis_point_005",
          pointId: 4,
          quantityId: "m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          stageIndex: 0,
          targetId: "hysteresis-step:hysteresis-1:4",
          type: "hysteresis-snapshot",
        },
      },
      "explorer",
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="snapshots" />,
      ["hysteresis-snapshots"],
    );

    expect(markup).toContain("hysteresis_point_005");
    expect(markup).toContain("available");
    expect(markup).toContain("hysteresis.zarr");
    expect(markup).toContain("snapshot found in hysteresis.zarr");
    expect(markup).toContain("3D viewport state");
    expect(markup).toContain("Return to live");
    expect(markup).toContain(">3D<");
    expect(markup).toContain(">Init<");

    selection.clear("explorer");
  });

  it("disables hysteresis point replay actions when snapshot payload is missing", () => {
    const pointsKey = ANALYSIS_HYSTERESIS_POINTS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const points: HysteresisPointSchema[] = [
      {
        point_id: 4,
        field_value_mT: 25,
        m_parallel: 0.8,
        m_oop: 0.7,
        m_ip: 0.1,
        m_avg: [0.1, 0.2, 0.8],
        status: "completed",
        run_status: "completed",
        settle_status: "converged",
        has_non_converged_steps: false,
        terminal_settle_reason: "converged",
        warning_count: 0,
        snapshot_id: "hysteresis_point_005",
        protocol_role: "descending",
        branch_id: "descending",
        branch_ids: ["descending"],
        branch_index: 0,
        parent_branch_id: null,
        minor_loop_id: null,
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_vector_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_005`,
        snapshot_json_artifact_ref: "hysteresis_snapshots/hysteresis_point_005/m.json",
        snapshot_zarr_store_ref: "hysteresis.zarr",
        snapshot_storage_format: "zarr_v2_json_fallback",
        snapshot_storage_status: "missing",
        snapshot_storage_reason: "snapshot payload not found in hysteresis.zarr or JSON fallback",
        field_vector_A_per_m: [0, 0, 19894.367886486918],
        field_orientation: { kind: "preset", preset_name: "oop_positive" },
        measurement_axis: "field_axis",
        field_display_unit: "mT",
        is_reversal_field: false,
        reversal_index: null,
        recoil_start_point_id: null,
      },
    ];
    sharedResourceRuntimeStore.updateData(pointsKey, hysteresisPointsResource(points), 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="points" />,
      ["hysteresis-points"],
    );

    expect(markup).toContain("Snapshot payload is missing for this point");
    expect(markup).toContain("disabled=\"\"");
  });

  it("renders settle trace for the selected hysteresis point", () => {
    selection.set(
      {
        kind: "analysis.chart-point",
        label: "Point 4 (25 mT)",
        nodeId: "analysis:hysteresis:hysteresis-1:point:4",
        objectId: null,
        ref: {
          chartId: "hysteresis:hysteresis-1",
          kind: "analysis.chart-point",
          nodeId: "analysis:hysteresis:hysteresis-1:point:4",
          pointId: 4,
          quantity: "m",
          rowIndex: 4,
          seriesId: "hysteresis:hysteresis-1:m",
          snapshotId: "hysteresis_point_005",
          stageId: "hysteresis-1",
          tableId: "hysteresis:hysteresis-1",
          type: "analysis-chart-point",
          x: 25,
          y: 0.8,
        },
      },
      "analysis-plots",
    );

    const settleTraceKey = ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH
      .replace("{stage_id}", "hysteresis-1")
      .replace("{point_id}", "4");
    const settleTrace: HysteresisSettleTraceEntrySchema[] = [
      {
        algorithm_id: "minimize",
        energy: -5.93e-16,
        fallback_reason: null,
        field_value_mT: 25,
        method: "projected_gradient_bb",
        point_id: 4,
        resolved_parameters: {
          energy_tolerance: 1e-20,
          max_steps: 200,
        },
        resolved_timestep_s: 1e-13,
        retry_attempt: 0,
        status: "converged",
        stop_reason: "energy",
        step_index: 0,
        torque: 2.6e-2,
      } as HysteresisSettleTraceEntrySchema,
      {
        algorithm_id: "relax",
        energy: -5.94e-16,
        fallback_reason: "previous_step_non_converged",
        field_value_mT: 25,
        method: "llg_overdamped",
        point_id: 4,
        resolved_timestep_s: 5e-14,
        retry_attempt: 1,
        status: "non_converged",
        step_index: 1,
        torque: 5.1e-2,
      },
    ];
    sharedResourceRuntimeStore.updateData(settleTraceKey, settleTrace, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-settle-trace"],
    );

    expect(markup).toContain("Settle Trace");
    expect(markup).toContain("projected_gradient_bb");
    expect(markup).toContain("llg_overdamped");
    expect(markup).toContain("previous_step_non_converged");
    expect(markup).toContain("retry 1");
    expect(markup).toContain("Stop reason: energy");
    expect(markup).toContain("Resolved params");
    expect(markup).toContain("energy_tolerance");

    selection.clear("analysis-plots");
  });

  it("renders stage-level preparation and probe settle trace before point selection", () => {
    selection.clear("analysis-plots");
    selection.clear("explorer");

    const stageSettleTraceKey = ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const stageSettleTrace: HysteresisSettleTraceResource = {
      revision: 4,
      settle_trace: [
        {
          algorithm_id: "prepare_minimize",
          energy: -5.93e-16,
          fallback_reason: null,
          field_value_mT: 0,
          method: "projected_gradient_bb",
          point_id: null,
          protocol_role: "preparation",
          resolved_timestep_s: 1e-13,
          retry_attempt: 0,
          status: "converged",
          step_index: 0,
          torque: 2.6e-2,
        },
        {
          algorithm_id: "probe_relax",
          energy: -5.94e-16,
          fallback_reason: null,
          field_value_mT: 300,
          method: "llg_overdamped",
          point_id: null,
          protocol_role: "saturation_probe",
          retry_attempt: 0,
          status: "converged",
          step_index: 1,
          torque: 5.1e-2,
        },
      ],
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(
      stageSettleTraceKey,
      stageSettleTrace,
      4,
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="settle-trace" />,
      ["hysteresis-settle-trace"],
    );

    expect(markup).toContain("Settle Trace");
    expect(markup).toContain("prepare_minimize");
    expect(markup).toContain("probe_relax");
    expect(markup).toContain("preparation");
    expect(markup).toContain("saturation_probe");
    expect(markup).not.toContain("Select a calculated point");
  });

  it("renders settle trace for a hysteresis field point selected in explorer", () => {
    selection.set(
      {
        kind: "study.stage.hysteresis",
        label: "H = 25 mT",
        nodeId: "model:study:stages:stage:hysteresis-1:field-point:4",
        objectId: null,
        ref: {
          kind: "study.stage.hysteresis",
          nodeId: "model:study:stages:stage:hysteresis-1:field-point:4",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const settleTraceKey = ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH
      .replace("{stage_id}", "hysteresis-1")
      .replace("{point_id}", "4");
    const settleTrace: HysteresisSettleTraceEntrySchema[] = [
      {
        algorithm_id: "minimize",
        energy: -5.93e-16,
        fallback_reason: null,
        field_value_mT: 25,
        method: "projected_gradient_bb",
        point_id: 4,
        resolved_timestep_s: 1e-13,
        retry_attempt: 0,
        status: "converged",
        step_index: 0,
        torque: 2.6e-2,
      },
    ];
    sharedResourceRuntimeStore.updateData(settleTraceKey, settleTrace, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="settle-trace" />,
      ["hysteresis-settle-trace"],
    );

    expect(markup).toContain("Settle Trace");
    expect(markup).toContain("projected_gradient_bb");
    expect(markup).not.toContain("Current Field");

    selection.clear("explorer");
  });

  it("renders settle trace for a hysteresis algorithm node selected in explorer", () => {
    selection.set(
      {
        kind: "study.stage.action",
        label: "Minimize",
        nodeId:
          "model:study:stages:stage:hysteresis-1:branches:branch:ascending:algorithm:minimize",
        objectId: null,
        ref: {
          hysteresisExecutionNodeId:
            "hysteresis-1:branch:ascending:field-point:7:algorithm:minimize",
          hysteresisExecutionNodeKind: "settle_algorithm",
          hysteresisPointId: 7,
          kind: "study.stage.action",
          nodeId:
            "model:study:stages:stage:hysteresis-1:branches:branch:ascending:algorithm:minimize",
          stageId: "hysteresis-1",
          stageIndex: 0,
          type: "study-stage",
        },
      },
      "explorer",
    );

    const settleTraceKey = ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH
      .replace("{stage_id}", "hysteresis-1")
      .replace("{point_id}", "7");
    const settleTrace: HysteresisSettleTraceEntrySchema[] = [
      {
        algorithm_id: "minimize",
        energy: -4.8e-16,
        fallback_reason: null,
        field_value_mT: -25,
        method: "projected_gradient_bb",
        point_id: 7,
        protocol_role: "major_ascending",
        resolved_timestep_s: 1e-13,
        retry_attempt: 0,
        status: "converged",
        step_index: 0,
        torque: 1.4e-2,
      },
    ];
    sharedResourceRuntimeStore.updateData(settleTraceKey, settleTrace, 0);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="settle-trace" />,
      ["hysteresis-settle-trace"],
    );

    expect(markup).toContain("Settle Trace");
    expect(markup).toContain("projected_gradient_bb");
    expect(markup).toContain("converged");

    selection.clear("explorer");
  });

  it("renders detected hysteresis reversal fields in loop metrics", () => {
    const metricsKey = ANALYSIS_HYSTERESIS_METRICS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const reversalFieldsKey = ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const metrics: HysteresisMetricsSchema = {
      H_c: 12.5,
      H_c_minus: -13,
      H_c_plus: 12,
      H_eb: -0.5,
      M_r_minus: -0.4,
      M_r_plus: 0.42,
      loop_area: 8.75,
      magnetization_average_weighting: "uniform_sample_average",
      metric_statuses: {
        H_c: {
          reason: "Metric value is available.",
          status: "available",
        },
        H_c_minus: {
          reason: "Metric requires negative coercive crossing.",
          status: "unavailable",
        },
        loop_area: {
          reason: "Metric value exists, but loop closure is open.",
          status: "warning",
        },
      },
      loop_closure_summary: {
        field_gap_mT: -100,
        m_parallel_gap: -0.8,
        reason: "First and last points do not return to the same applied field.",
        status: "open",
      },
      max_differential_susceptibility: 0.095,
      saturation_preparation_field_mT: 300,
      saturation_status: "saturated",
      switching_field_candidates: [
        {
          branch_id: "descending",
          field_value_mT: -5,
          point_id_after: 13,
          point_id_before: 12,
          susceptibility_per_mT: -0.095,
        },
      ],
      warnings: ["Negative coercive crossing is unavailable."],
      convergence_quality_summary: {
        converged_points: 12,
        non_converged_points: 1,
        status: "warning",
        total_points: 13,
        warning_points: 0,
      },
    };
    const reversalFields: HysteresisPointSchema[] = [
      {
        branch_id: "descending",
        branch_ids: ["descending", "ascending"],
        branch_index: 0,
        field_value_mT: -37.5,
        is_reversal_field: true,
        m_avg: [0.1, 0.0, -0.42],
        m_ip: 0.1,
        m_oop: -0.42,
        m_parallel: -0.42,
        minor_loop_id: null,
        parent_branch_id: null,
        point_id: 12,
        protocol_role: "return",
        recoil_start_point_id: 12,
        reversal_index: 0,
        snapshot_id: "hysteresis_point_013",
        snapshot_resource_ref: `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m")}?snapshot_id=hysteresis_point_013`,
        status: "Completed",
      },
    ];
    const metricsResource: HysteresisMetricsResource = {
      metrics,
      revision: 1,
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(metricsKey, metricsResource, 0);
    sharedResourceRuntimeStore.updateData(
      reversalFieldsKey,
      hysteresisReversalFieldsResource(reversalFields),
      0,
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="metrics" />,
      ["hysteresis-metrics"],
    );

    expect(markup).toContain("Reversal Fields");
    expect(markup).toContain("-37.500 mT (point 12)");
    expect(markup).toContain("9.5000e-2");
    expect(markup).toContain("-5.000 mT (-9.500e-2 1/mT)");
    expect(markup).toContain("warning: 12/13 converged");
    expect(markup).toContain("open: dH=-100.000 mT, dm=-8.000e-1");
    expect(markup).toContain("H_c: available; H_c_minus: unavailable; loop_area: warning");
    expect(markup).toContain("Negative coercive crossing is unavailable.");
  });

  it("renders hysteresis plan from the runtime resource before falling back to the draft", () => {
    const planKey = SIMULATION_STAGE_HYSTERESIS_PLAN_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const adaptiveRefinementKey = ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const plan: HysteresisStagePlanSchema = {
      branch_mode: "minor_loop",
      field_max_mT: 120,
      field_min_mT: -80,
      field_schedule: {
        segments: [
          {
            segment_id: "dense-remanence",
            start: 10,
            stop: -10,
            step: 1,
          },
        ],
      },
      field_step_mT: 5,
      field_values_mT: null,
      field_unit_provenance: {
        authored_quantity: "mu0_h",
        authored_unit: "mT",
        canonical_quantity: "h_ext",
        canonical_unit: "A/m",
        display_unit: "mT",
        mu0_h_per_m: 1.2566370614359172e-6,
      },
      minor_loops: [],
      revision: 22,
      schedule_refinements: null,
      stage_id: "hysteresis-1",
      stage_index: 0,
      storage_estimate: {
        bytes_per_component: 8,
        components_per_site: 3,
        estimated_bytes: 12_582_912,
        point_count: 41,
        policy: "selected_every_5",
        site_count: 12_288,
        snapshot_count: 8,
        status: "estimated",
        warnings: ["Every-step storage estimate should be acknowledged."],
      },
    };
    const adaptiveRefinement: HysteresisAdaptiveRefinementSchema = {
      candidates: [
        {
          candidate_id: "adaptive_candidate_001",
          dm_dh_per_mT: 0.012,
          field_value_mT: 0,
          parent_left_field_mT: -25,
          parent_left_point_id: 3,
          parent_right_field_mT: 25,
          parent_right_point_id: 4,
          pass_index: 1,
          reasons: ["zero_crossing"],
          status: "computed",
        },
      ],
      enabled: true,
      kind: "adaptive_refinement",
      max_insertions_per_pass: 2,
      max_passes: 1,
      points: [
        {
          adaptive_inserted: true,
          field_value_mT: 0,
          m_avg: [0.01, 0, 0],
          m_ip: 0.01,
          m_oop: 0,
          m_parallel: 0.01,
          point_id: 7,
          refinement_parent_left_point_id: 3,
          refinement_parent_right_point_id: 4,
          refinement_reason: ["zero_crossing"],
          status: "Completed",
        },
      ],
      settle_trace: [],
      source_point_count: 3,
      status: "computed",
    };
    sharedResourceRuntimeStore.updateData(planKey, plan, 22);
    sharedResourceRuntimeStore.updateData(
      adaptiveRefinementKey,
      hysteresisAdaptiveRefinementResource(adaptiveRefinement),
      22,
    );

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="plan" />,
      ["hysteresis-plan"],
    );

    expect(markup).toContain("minor_loop");
    expect(markup).toContain("piecewise");
    expect(markup).toContain("1 segment(s) defined");
    expect(markup).toContain("mu0_h (mT)");
    expect(markup).toContain("h_ext (A/m)");
    expect(markup).toContain("1.256637061436e-6");
    expect(markup).toContain("estimated | 41 point(s) | 8 snapshot(s) | 12.0 MiB");
    expect(markup).toContain("Every-step storage estimate should be acknowledged.");
    expect(markup).toContain("computed | 1 candidate(s) | 1 computed point(s)");
  });

  it("renders a dedicated hysteresis adaptive refinement inspector", () => {
    const adaptiveRefinementKey = ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const adaptiveRefinement: HysteresisAdaptiveRefinementSchema = {
      candidates: [
        {
          candidate_id: "adaptive_candidate_001",
          dm_dh_per_mT: 0.012,
          field_value_mT: 0,
          parent_left_field_mT: -25,
          parent_left_point_id: 3,
          parent_right_field_mT: 25,
          parent_right_point_id: 4,
          pass_index: 1,
          reasons: ["zero_crossing", "high_susceptibility"],
          status: "computed",
        },
      ],
      enabled: true,
      kind: "adaptive_refinement",
      max_insertions_per_pass: 2,
      max_passes: 1,
      points: [
        {
          adaptive_inserted: true,
          branch_id: "descending",
          branch_ids: ["descending"],
          branch_index: 0,
          field_value_mT: 0,
          has_non_converged_steps: false,
          m_avg: [0.01, 0, 0],
          m_ip: 0.01,
          m_oop: 0,
          m_parallel: 0.01,
          minor_loop_id: null,
          parent_branch_id: null,
          point_id: 7,
          protocol_role: "adaptive",
          recoil_start_point_id: null,
          refinement_parent_left_point_id: 3,
          refinement_parent_right_point_id: 4,
          refinement_reason: ["zero_crossing"],
          reversal_index: null,
          run_status: "Completed",
          settle_status: "converged",
          status: "Completed",
          terminal_settle_reason: "converged",
          warning_count: 0,
        },
      ],
      settle_trace: [],
      source_point_count: 6,
      status: "computed",
    };
    sharedResourceRuntimeStore.updateData(
      adaptiveRefinementKey,
      hysteresisAdaptiveRefinementResource(adaptiveRefinement),
      22,
    );

    const markup = render(
      <HysteresisStageInspector
        {...props("hysteresis")}
        view="adaptive-refinement"
      />,
      ["hysteresis-adaptive-refinement"],
    );

    expect(markup).toContain("Adaptive Refinement");
    expect(markup).toContain("computed");
    expect(markup).toContain("6");
    expect(markup).toContain("adaptive_candidate_001");
    expect(markup).toContain("zero_crossing, high_susceptibility");
    expect(markup).toContain("Inserted point");
    expect(markup).toContain("3 -&gt; 4");
  });

  it("renders a dedicated hysteresis angular family inspector", () => {
    const familyKey = ANALYSIS_HYSTERESIS_FAMILY_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const family: HysteresisAngularFamilyResource = {
      active_variant_id: "ip_x",
      family_id: "waveguide_ip_oop_family",
      label: "IP/OOP comparison",
      revision: 31,
      series: [
        {
          data_status: "computed_active_stage",
          label: "In plane X",
          measurement_axis: "parallel_to_field",
          metrics: {
            H_c: 12.5,
            loop_area: 3.75,
          } as HysteresisAngularFamilyResource["series"][number]["metrics"],
          orientation: { kind: "preset", preset: "in_plane_x" },
          point_count: 2,
          points: [
            {
              field_value_mT: 50,
              m_avg: [0.8, 0, 0],
              m_ip: 0.8,
              m_oop: 0,
              m_parallel: 0.8,
              point_id: 0,
              status: "Completed",
            },
            {
              field_value_mT: -50,
              m_avg: [-0.7, 0, 0],
              m_ip: 0.7,
              m_oop: 0,
              m_parallel: -0.7,
              point_id: 1,
              status: "Completed",
            },
          ],
          points_resource_ref: hysteresisFamilyVariantPointsRef(
            "hysteresis-1",
            "ip_x",
          ),
          variant_id: "ip_x",
        },
        {
          data_status: "pending_run",
          label: "OOP",
          measurement_axis: "parallel_to_field",
          metrics: null,
          orientation: { kind: "preset", preset: "oop_positive" },
          point_count: 0,
          points: [],
          points_resource_ref: hysteresisFamilyVariantPointsRef(
            "hysteresis-1",
            "oop",
          ),
          variant_id: "oop",
        },
      ],
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(familyKey, family, 31);

    const markup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="angular-family" />,
      ["hysteresis-angular-family"],
    );

    expect(markup).toContain("Angular Family");
    expect(markup).toContain("waveguide_ip_oop_family");
    expect(markup).toContain("1/2 computed");
    expect(markup).toContain("computed_active_stage (active)");
    expect(markup).toContain("pending_run");
    expect(markup).toContain("in_plane_x");
    expect(markup).toContain("oop_positive");
    expect(markup).toContain("H_c=1.2500e+1, loop_area=3.7500e+0");
    expect(markup).toContain(
      hysteresisFamilyVariantPointsRef("hysteresis-1", "ip_x"),
    );
  });

  it("renders hysteresis protocol and settle pipeline from runtime resources", () => {
    const protocolKey = SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const settlePipelineKey = SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const protocol: HysteresisProtocolSchema = {
      branch_mode: "major_with_minor",
      initial_protocol: "positive_saturation",
      revision: 23,
      saturation: { mode: "auto" },
      stage_id: "hysteresis-1",
      stage_index: 0,
      storage: { magnetization: "selected" },
    };
    const settlePipeline: HysteresisSettlePipelineSchema = {
      revision: 23,
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            alpha: 0.9,
            kind: "minimize",
            max_steps: 2000,
            method: "projected_gradient_bb",
            torque_tolerance: 250,
          },
        ],
      },
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(protocolKey, protocol, 23);
    sharedResourceRuntimeStore.updateData(settlePipelineKey, settlePipeline, 23);

    const protocolMarkup = render(
      <HysteresisStageInspector {...props("hysteresis")} view="protocol" />,
      ["hysteresis-protocol"],
    );
    const settleMarkup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-settle"],
    );

    expect(protocolMarkup).toContain("positive_saturation");
    expect(protocolMarkup).toContain("major_with_minor");
    expect(protocolMarkup).toContain("selected");
    expect(settleMarkup).toContain("projected_gradient_bb");
    expect(settleMarkup).toContain("Max steps: 2000");
  });

  it("renders hysteresis settle pipeline when execution tree nodes are absent", () => {
    const executionTreeKey = SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    sharedResourceRuntimeStore.updateData(
      executionTreeKey,
      {
        revision: 31,
        stage_id: "hysteresis-1",
        stage_index: 0,
      } as never,
      31,
    );

    const settleMarkup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-settle"],
    );

    expect(settleMarkup).toContain("Settle Pipeline");
  });

  it("prefers resolved hysteresis settle pipeline fields over raw fallback steps", () => {
    const settlePipelineKey = SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH.replace(
      "{stage_id}",
      "hysteresis-1",
    );
    const settlePipeline: HysteresisSettlePipelineSchema = {
      resolved_branch_ids: ["descending", "ascending"],
      resolved_steps: [
        {
          applies_to: { branch_id: "ascending" },
          kind: "minimize",
          method: "projected_gradient_bb",
          resolved_parameters: {
            alpha: 0.5,
            max_steps: 1500,
            torque_tolerance: 175,
          },
          step_id: "resolved-minimize",
          step_index: 0,
        },
      ],
      revision: 24,
      settle_pipeline: {
        kind: "sequence",
        steps: [
          {
            kind: "llg",
            max_steps: 12,
            method: "raw-fallback",
          },
        ],
      },
      stage_id: "hysteresis-1",
      stage_index: 0,
    };
    sharedResourceRuntimeStore.updateData(settlePipelineKey, settlePipeline, 24);

    const settleMarkup = render(
      <HysteresisStageInspector {...props("hysteresis")} />,
      ["hysteresis-settle"],
    );

    expect(settleMarkup).toContain("projected_gradient_bb");
    expect(settleMarkup).toContain("resolved-minimize");
    expect(settleMarkup).toContain("Max steps: 1500");
    expect(settleMarkup).toContain("descending");
    expect(settleMarkup).not.toContain("raw-fallback");
  });
});
