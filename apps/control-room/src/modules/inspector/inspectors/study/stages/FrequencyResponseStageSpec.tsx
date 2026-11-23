"use client";

import {
  FileOutput,
  Magnet,
  Play,
  Waves,
  Workflow,
} from "lucide-react";
import { useContext, useMemo, useState } from "react";

import type {
  FrequencyDomainManifestResource,
  MeshPeriodicPairsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import { KernelContext } from "@/kernel/KernelContext";
import type { StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  inspectorValuesEqual,
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../../template";
import {
  buildFrequencyDomainCalculationModeRows,
  type FrequencyDomainCalculationModeRow,
} from "../../../panels/frequencyDomainInspectorModel";
import type { StudyStageModel } from "../../../panels/StudyInspectorPanelModel";
import {
  readStageTextureAssignments,
  validateStudyStageDraft,
} from "../../../panels/StudyStageAuthoringModel";
import {
  ANGLE_RAD_UNITS_SI,
  FIELD_APM_UNITS_SI,
  FREQUENCY_UNITS_SI,
  PipelineStrip,
  WAVEVECTOR_UNITS_SI,
  type PipelineStripStep,
} from "../../../panels/study/ConnectedInspectorSpec";
import { useKernelStudyAuthoring } from "../../../panels/study/useConnectedStudyAuthoring";
import {
  hasKernelResourceRuntime,
  StageInitialStateRadixControl,
  StageLiveTelemetryPanel,
  StageSpecHost,
  StageTextureOverridesRow,
  StudyStageTelemetryBridge,
} from "../../../panels/stages/StageSharedControls";
import { stageBreadcrumbs } from "./stageShared";
import {
  parseExplicitFrequencySweepHz,
  type SpectralStageTestSnapshot,
  type SpectralValidationContext,
  sanitizeCapabilityStatus,
  resolveInitialFrequencyResponseTab,
  summarizePeriodicPairsResource,
  SpectralCapabilitiesLoader,
} from "./spectralStageShared";
import {
  type FrequencyResponseStageSpecDraft,
  toFrequencyResponseStudyStageDraft,
  buildHydratedFrequencyResponseBaseline,
  createFallbackFrequencyResponseBaseline,
  deriveFrequencyResponseFieldPatch,
} from "./spectralStageModels";
export function FrequencyResponseStageInspectorPanel({
  selection,
  testSnapshot,
}: InspectorPanelProps & {
  testSnapshot?: SpectralStageTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !testSnapshot) {
    return <ConnectedFrequencyResponseStageInspectorPanel selection={selection} />;
  }
  return (
    <FrequencyResponseStageInspectorPanelView
      selection={selection}
      testSnapshot={testSnapshot}
    />
  );
}

function ConnectedFrequencyResponseStageInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitSelectedStageDraft,
    commitStudyMetadata,
    executeSelectedStage,
    globalDraft,
    lastAuthoringError,
    pipelineStripSteps,
    runtimeStatus,
    sceneData,
    sceneRevision,
    selectedStageDraft,
    selectedStageIndex,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hasResources = hasKernelResourceRuntime(kernel);
  const canLoadManifest =
    hasResources &&
    Boolean(runtimeStatus?.domain && runtimeStatus?.resources) &&
    Boolean(kernel?.api?.analysis?.frequencyDomain?.manifestV1);
  const canLoadPeriodicPairs =
    hasResources && Boolean(kernel?.api?.meshing?.periodicPairs);

  const hydratedBaseline = useMemo<FrequencyResponseStageSpecDraft>(
    () =>
      buildHydratedFrequencyResponseBaseline({
        requestedDevice: globalDraft.requestedDevice,
        requestedPrecision: globalDraft.requestedPrecision,
        selectedStageDraft,
        selectedStageIndex,
        selection,
        stageDrafts,
      }),
    [
      globalDraft.requestedDevice,
      globalDraft.requestedPrecision,
      selectedStageDraft,
      selectedStageIndex,
      selection,
      stageDrafts,
    ],
  );
  const validationContext = useMemo<SpectralValidationContext>(
    () => ({
      activeLane: runtimeStatus?.capabilities.active_lane,
      algorithmsAvailable: runtimeStatus?.capabilities.algorithms_available,
      backend: globalDraft.requestedBackend,
      demagEnabled: globalDraft.demagEnabled,
      device: globalDraft.requestedDevice,
      mode: globalDraft.requestedMode,
      precision: globalDraft.requestedPrecision,
    }),
    [
      globalDraft.demagEnabled,
      globalDraft.requestedBackend,
      globalDraft.requestedDevice,
      globalDraft.requestedMode,
      globalDraft.requestedPrecision,
      runtimeStatus?.capabilities.active_lane,
      runtimeStatus?.capabilities.algorithms_available,
    ],
  );

  return (
    <StudyStageTelemetryBridge selection={selection}>
      {(selectedStageModel) => (
        <SpectralCapabilitiesLoader
          canLoadManifest={canLoadManifest}
          canLoadPeriodicPairs={canLoadPeriodicPairs}
        >
          {({ manifest, periodicPairs }) => (
            <FrequencyResponseStageInspectorPanelView
              hydratedBaseline={hydratedBaseline}
              lastAuthoringError={lastAuthoringError}
              manifest={manifest}
              periodicPairs={periodicPairs}
              pipelineNodeId={selectedStageDraft?.pipelineNodeId}
              pipelineStripSteps={pipelineStripSteps}
              sceneData={sceneData}
              sceneRevision={sceneRevision}
              selection={selection}
              stageModel={selectedStageModel}
              validationContext={validationContext}
              onCommitStage={(draft) =>
                commitSelectedStageDraft(
                  (base) => toFrequencyResponseStudyStageDraft(draft, base),
                  "frequency_response",
                )
              }
              onRunStage={(stageId, initialChoice) =>
                executeSelectedStage(
                  stageId,
                  initialChoice,
                  "frequency_response",
                )
              }
              onSwitchPrecisionToDouble={() =>
                commitStudyMetadata({ requested_precision: "double" })
              }
            />
          )}
        </SpectralCapabilitiesLoader>
      )}
    </StudyStageTelemetryBridge>
  );
}

function FrequencyResponseStageInspectorPanelView({
  hydratedBaseline,
  lastAuthoringError = null,
  manifest = null,
  onCommitStage,
  onRunStage,
  onSwitchPrecisionToDouble,
  periodicPairs = null,
  pipelineNodeId,
  pipelineStripSteps,
  sceneData = null,
  sceneRevision = null,
  selection,
  stageModel = null,
  testSnapshot,
  validationContext,
}: InspectorPanelProps & {
  hydratedBaseline?: FrequencyResponseStageSpecDraft;
  lastAuthoringError?: string | null;
  manifest?: FrequencyDomainManifestResource | null;
  onCommitStage?: (draft: FrequencyResponseStageSpecDraft) => Promise<boolean>;
  onRunStage?: (stageId: string, initialChoice?: StageInitialStateChoice) => Promise<void>;
  onSwitchPrecisionToDouble?: () => Promise<boolean>;
  periodicPairs?: MeshPeriodicPairsResource | null;
  pipelineNodeId?: string;
  pipelineStripSteps?: readonly PipelineStripStep[];
  sceneData?: SceneResource | null;
  sceneRevision?: number | null;
  stageModel?: StudyStageModel | null;
  testSnapshot?: SpectralStageTestSnapshot;
  validationContext?: SpectralValidationContext;
}) {
  const kernel = useContext(KernelContext);
  const [initialChoice, setInitialChoice] = useState<StageInitialStateChoice>({
    kind: "default_for_target",
  });
  const stageIndex =
    selection.ref?.type === "study-stage" && typeof selection.ref.stageIndex === "number"
      ? selection.ref.stageIndex
      : 1;
  const stageId =
    hydratedBaseline?.stageId ??
    (selection.ref?.type === "study-stage" && selection.ref.stageId
      ? selection.ref.stageId
      : `freq_${stageIndex + 1}`);

  const fallbackBaseline = useMemo<FrequencyResponseStageSpecDraft>(
    () => createFallbackFrequencyResponseBaseline(stageId, testSnapshot),
    [stageId, testSnapshot],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const calculationModeRows = useMemo<FrequencyDomainCalculationModeRow[]>(
    () =>
      buildFrequencyDomainCalculationModeRows(
        manifest?.capabilities,
        manifest?.floquet_nonzero_k_response_supported,
      )
        .filter((row) => ["fmr_response", "response_map"].includes(row.mode))
        .map((row) => ({
          ...row,
          capabilityStatus: sanitizeCapabilityStatus(row.capabilityStatus),
        })),
    [manifest?.capabilities, manifest?.floquet_nonzero_k_response_supported],
  );

  const resolvedSteps = useMemo<readonly PipelineStripStep[]>(
    () =>
      pipelineStripSteps && pipelineStripSteps.length > 0
        ? pipelineStripSteps
        : [
            {
              id: "relax_1",
              index: 0,
              kind: "study.stage.relax",
              label: "Relax",
              status: "completed",
            },
            {
              id: stageId,
              index: stageIndex,
              kind: "study.stage.frequency_response",
              label: "Frequency Response",
              status: "ready",
            },
          ],
    [pipelineStripSteps, stageId, stageIndex],
  );

  const titleLabel = `Frequency Response ${stageIndex + 1}`;
  const initialModeTabId = resolveInitialFrequencyResponseTab(selection.kind);

  const spec = useMemo<InspectorSpec<FrequencyResponseStageSpecDraft>>(
    () => ({
      id: "study.stage.frequency_response",
      header: {
        breadcrumbs: stageBreadcrumbs(titleLabel),
        canFitView: true,
        primaryHeaderAction: {
          label: "Run up to here",
          icon: Play,
          onRun: async (ctx) => {
            if (!inspectorValuesEqual(ctx.draft, ctx.baseline) && onCommitStage) {
              const saved = await onCommitStage(ctx.draft);
              if (saved === false) return;
            }
            if (onRunStage) {
              await onRunStage(ctx.draft.stageId, initialChoice);
            } else {
              ctx.notify("Frequency response solve queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Waves,
        title: () => titleLabel,
        kindLabel: "Linearized harmonic response stage",
        entityId: stageId,
        statePill: (d) =>
          d.precision !== "double"
            ? { tone: "err", label: "Requires FP64" }
            : d.excitationFieldApm.every((v) => v === 0)
              ? { tone: "err", label: "Zero excitation" }
              : d.equilibriumSource === "relax" && !d.hasPrecedingRelax
                ? { tone: "warn", label: "Equilibrium missing" }
                : { tone: "ok", label: "Ready" },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "mode",
          label: "Mode",
          value: d.calculationMode === "response_map" ? "2D k-Grid Map" : "FMR Sweep",
        },
        {
          id: "sweep",
          label: "Sweep",
          value:
            d.sweepMode === "explicit_list"
              ? `${parseExplicitFrequencySweepHz(d.explicitFrequenciesText).frequenciesHz.length} explicit pts`
              : `${(d.sweepMinHz / 1e9).toFixed(1)}–${(d.sweepMaxHz / 1e9).toFixed(1)} GHz (${d.sweepCount} pts)`,
        },
        { id: "solver", label: "Solver", value: d.solverMethod },
        { id: "device", label: "Device", value: d.resolvedDeviceLabel },
      ],
      modeTabs: [
        { id: "setup", label: "Setup & Equilibrium" },
        { id: "excitation", label: "Excitation & Sweep" },
        { id: "solver", label: "Solver & Outputs" },
      ],
      notices: (d): readonly InspectorNotice<FrequencyResponseStageSpecDraft>[] => {
        const list: InspectorNotice<FrequencyResponseStageSpecDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "authoring-error",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        if (d.precision !== "double") {
          list.push({
            id: "fp64-required",
            tone: "err",
            text: "Driven harmonic frequency-response solvers require double precision (FP64).",
            quickFix: {
              label: "Switch Study Precision to FP64",
              onApply: async (ctx) => {
                ctx.setField("precision", "double");
                if (onSwitchPrecisionToDouble) {
                  await onSwitchPrecisionToDouble();
                }
              },
            },
          });
        }
        if (d.excitationFieldApm.every((component) => component === 0)) {
          list.push({
            id: "zero-excitation",
            tone: "err",
            text: "Harmonic RF excitation amplitude cannot be [0, 0, 0]. Specify at least one non-zero RF field component.",
            focusFieldKey: "excitationFieldApm",
            quickFix: {
              label: "Set 1 mT transverse RF drive",
              onApply: (ctx) =>
                ctx.setField("excitationFieldApm", [0, 795.77, 0]),
            },
          });
        }
        if (d.equilibriumSource === "relax" && !d.hasPrecedingRelax) {
          list.push({
            id: "missing-relax",
            tone: "warn",
            text: "Equilibrium source references a preceding Relax stage, which is not yet in the pipeline.",
            quickFix: {
              label: "Use current runtime state",
              onApply: (ctx) => ctx.setField("equilibriumSource", "provided"),
            },
          });
        }
        const stageDraft = toFrequencyResponseStudyStageDraft(d);
        const issues = validateStudyStageDraft(stageDraft, validationContext);
        for (let i = 0; i < issues.length; i += 1) {
          const issue = issues[i]!;
          if (list.some((existing) => existing.text === issue.message)) continue;
          list.push({
            id: `stage-validation-${i}`,
            tone: issue.severity === "error" ? "err" : "warn",
            text: issue.message,
          });
        }
        return list;
      },
      sections: [
        {
          id: "pipeline-mode",
          title: "Pipeline & Calculation Mode",
          icon: Workflow,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <PipelineStrip
                  currentIndex={stageIndex}
                  steps={resolvedSteps}
                  onSelectStep={(step) => {
                    if (step.selection) ctx.selectNode(step.selection);
                  }}
                />
              ),
            },
            {
              key: "stageId",
              label: "Stage ID",
              type: "text",
              mono: true,
              disabledReason: () =>
                pipelineNodeId
                  ? "Canonical pipeline stage IDs are managed by the pipeline graph."
                  : null,
              validate: (val) => (!val.trim() ? "Stage ID is required." : null),
            },
            {
              key: "stageEnabled",
              label: "Include in study",
              type: "switch",
            },
            {
              key: "calculationMode",
              label: "Calculation mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "fmr_response", label: "Driven FMR Sweep" },
                { value: "response_map", label: "Driven k-Space Map" },
              ],
            },
            {
              type: "table",
              label: "Calculation mode capabilities",
              wide: true,
              rowKey: (row) => (row as FrequencyDomainCalculationModeRow).mode,
              rows: () => calculationModeRows,
              columns: [
                {
                  id: "mode",
                  header: "Mode",
                  mono: true,
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).mode,
                },
                {
                  id: "boundary",
                  header: "Boundary",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).boundaryPreset,
                },
                {
                  id: "k",
                  header: "Wavevector",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).kRequirement,
                },
                {
                  id: "cap",
                  header: "Capability",
                  renderCell: (row) =>
                    (row as FrequencyDomainCalculationModeRow).capabilityStatus,
                },
              ],
            },
            {
              key: "equilibriumSource",
              label: "Equilibrium source",
              type: "select",
              structural: true,
              options: [
                { value: "provided", label: "Current runtime state" },
                { value: "relax", label: "Preceding Relax stage" },
                { value: "artifact", label: "Named state artifact" },
              ],
            },
            {
              key: "equilibriumArtifact",
              label: "Equilibrium artifact",
              type: "text",
              mono: true,
              showWhen: (d) => d.equilibriumSource === "artifact",
              validate: (val) => (!val.trim() ? "Artifact name is required." : null),
            },
            {
              type: "custom",
              label: "Saved state seed",
              wide: true,
              render: ({ draft }) => (
                <StageInitialStateRadixControl
                  choice={initialChoice}
                  hasAuthoredReset={Boolean(
                    readStageTextureAssignments(
                      draft.stageMagnetizationAssignments,
                    )?.length,
                  )}
                  onPreviewResult={
                    kernel?.savedResultsPlayback
                      ? (result) =>
                          kernel.savedResultsPlayback?.openStudyResult(result)
                      : undefined
                  }
                  sceneRevision={sceneRevision}
                  stageId={draft.stageId}
                  onChange={setInitialChoice}
                />
              ),
            },
            ...(sceneData
              ? [
                  {
                    type: "custom" as const,
                    label: "Texture overrides",
                    wide: true,
                    render: ({
                      draft,
                      patchDraft,
                    }: {
                      draft: FrequencyResponseStageSpecDraft;
                      patchDraft: (p: Partial<FrequencyResponseStageSpecDraft>) => void;
                    }) => (
                      <StageTextureOverridesRow
                        scene={sceneData}
                        value={draft.stageMagnetizationAssignments}
                        onChange={(stageMagnetizationAssignments) =>
                          patchDraft({ stageMagnetizationAssignments })
                        }
                      />
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "excitation-sweep",
          title: "Harmonic RF Excitation & Frequency Sweep",
          icon: Magnet,
          modeTabId: "excitation",
          defaultOpen: true,
          rows: [
            {
              key: "excitationFieldApm",
              label: "RF excitation amplitude",
              symbol: (
                <>
                  h<sub>rf</sub>
                </>
              ),
              type: "vector3",
              units: FIELD_APM_UNITS_SI,
              defaultDisplayUnit: "mT",
              validate: (vec) =>
                vec.every((c) => c === 0)
                  ? "Excitation vector must be non-zero."
                  : null,
            },
            {
              key: "excitationPhaseRad",
              label: "RF excitation phase",
              symbol: (
                <>
                  φ<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: ANGLE_RAD_UNITS_SI,
              defaultDisplayUnit: "deg",
            },
            {
              key: "sweepMode",
              label: "Frequency sweep mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "range_lin", label: "Linear range" },
                { value: "range_log", label: "Log range" },
                { value: "explicit_list", label: "Explicit list" },
              ],
            },
            {
              key: "sweepMinHz",
              label: "Minimum frequency",
              symbol: (
                <>
                  f<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.sweepMode !== "explicit_list",
            },
            {
              key: "sweepMaxHz",
              label: "Maximum frequency",
              symbol: (
                <>
                  f<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.sweepMode !== "explicit_list",
              validate: (val, d) =>
                val <= d.sweepMinHz ? "Maximum frequency must exceed minimum frequency." : null,
            },
            {
              key: "sweepCount",
              label: "Frequency points",
              symbol: (
                <>
                  N<sub>f</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 2,
              max: 10000,
              showWhen: (d) => d.sweepMode !== "explicit_list",
            },
            {
              key: "explicitFrequenciesText",
              label: "Explicit frequencies",
              type: "expression",
              placeholder: "2.5GHz, 5GHz, 10GHz",
              showWhen: (d) => d.sweepMode === "explicit_list",
              validate: (val) => parseExplicitFrequencySweepHz(val).error,
            },
            {
              key: "lateralBc",
              label: "Lateral boundary condition",
              type: "select",
              structural: true,
              options: [
                { value: "free", label: "Open / Free spins" },
                { value: "pinned", label: "Pinned boundary (∂Ω = 0)" },
                { value: "periodic_1d", label: "1D Periodic (waveguide)" },
                { value: "periodic_2d", label: "2D Bloch-Periodic film" },
                { value: "custom", label: "Custom / JSON BC" },
              ],
            },
            {
              key: "customBcText",
              label: "Custom boundary condition",
              type: "expression",
              showWhen: (d) => d.lateralBc === "custom",
            },
            {
              key: "magnetostaticBc",
              label: "Magnetostatic BC",
              type: "select",
              structural: true,
              options: [
                { value: "open", label: "Open space" },
                { value: "periodic_airbox_k0", label: "Periodic airbox (k = 0)" },
                { value: "floquet_airbox", label: "Bloch–Floquet (k ≠ 0) airbox" },
              ],
            },
            {
              label: "Periodic boundary pairs",
              type: "readonly",
              showWhen: (d) =>
                d.lateralBc === "periodic_1d" ||
                d.lateralBc === "periodic_2d" ||
                d.magnetostaticBc !== "open",
              format: () => summarizePeriodicPairsResource(periodicPairs),
            },
            {
              key: "kVectorRadPerM",
              label: "Reference wavevector k",
              symbol: "k",
              type: "vector3",
              units: WAVEVECTOR_UNITS_SI,
              defaultDisplayUnit: "rad/µm",
              showWhen: (d) => d.calculationMode === "response_map",
            },
            {
              key: "kGridCountX",
              label: "Wavevector grid points",
              symbol: (
                <>
                  N<sub>kx</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 2,
              max: 4096,
              showWhen: (d) => d.calculationMode === "response_map",
            },
            {
              key: "kGridMaxRadPerM",
              label: "Max wavevector k_max",
              symbol: (
                <>
                  k<sub>max</sub>
                </>
              ),
              type: "quantity",
              units: WAVEVECTOR_UNITS_SI,
              defaultDisplayUnit: "rad/µm",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.calculationMode === "response_map",
            },
            {
              key: "kSamplingJson",
              label: "k-sampling grid JSON",
              type: "expression",
              multiline: true,
              placeholder: '{"kind":"grid","nx":64,"k_max_rad_per_m":25000000}',
              showWhen: (d) => d.calculationMode === "response_map",
            },
          ],
        },
        {
          id: "linear-solver-outputs",
          title: "Linear System Solver & Outputs",
          icon: FileOutput,
          modeTabId: "solver",
          defaultOpen: true,
          rows: [
            {
              key: "solverMethod",
              label: "Solver method",
              type: "select",
              options: [
                { value: "auto", label: "Auto (capability-resolved)" },
                { value: "dense_reference", label: "Dense direct reference (CPU)" },
                { value: "cpu_sparse_direct", label: "CPU Sparse LU direct" },
                { value: "full_coupled_field_split", label: "Field-split block preconditioner" },
                { value: "schur_reduced", label: "Schur-complement reduced" },
                { value: "modal_reduced", label: "Modal subspace projection" },
                { value: "gpu_operator_host_krylov", label: "GPU operator + host GMRES" },
                { value: "gpu_device_krylov", label: "Full GPU device GMRES" },
              ],
            },
            {
              key: "includeDemag",
              label: "Include demagnetization",
              type: "switch",
            },
            {
              key: "dampingPolicy",
              label: "Damping policy",
              type: "segmented",
              options: [
                { value: "include", label: "Include Gilbert α" },
                { value: "ignore", label: "Undamped limit" },
              ],
            },
            {
              key: "normalization",
              label: "Mode normalization",
              type: "segmented",
              options: [
                { value: "unit_l2", label: "Unit L2" },
                { value: "unit_max_amplitude", label: "Unit max amplitude" },
              ],
            },
            {
              key: "observable",
              label: "Response observable",
              type: "select",
              structural: true,
              options: [
                { value: "spatial_average_m", label: "Volume-averaged ⟨δm⟩" },
                { value: "absorbed_power", label: "Absorbed RF power P_abs" },
                { value: "susceptibility_tensor", label: "Susceptibility tensor χ(f)" },
                { value: "port_impedance", label: "Antenna port ΔZ(f)" },
                { value: "custom", label: "Custom observable key" },
              ],
            },
            {
              key: "customObservableKey",
              label: "Custom observable key",
              type: "text",
              mono: true,
              showWhen: (d) => d.observable === "custom",
            },
            {
              type: "custom",
              label: "Sweep solve status",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Run this stage to solve the harmonic linear system across the configured frequency sweep."
                  stageModel={stageModel}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (draft) => {
          if (onCommitStage) {
            return onCommitStage(draft);
          }
          return true;
        },
      },
    }),
    [
      calculationModeRows,
      initialChoice,
      kernel,
      lastAuthoringError,
      onCommitStage,
      onRunStage,
      onSwitchPrecisionToDouble,
      periodicPairs,
      pipelineNodeId,
      resolvedSteps,
      sceneData,
      sceneRevision,
      stageId,
      stageIndex,
      stageModel,
      titleLabel,
      validationContext,
    ],
  );

  return (
    <StageSpecHost
      baseline={baseline}
      options={initialModeTabId ? { initialModeTabId } : undefined}
      selection={selection}
      spec={spec}
      deriveFieldPatch={deriveFrequencyResponseFieldPatch}
    />
  );
}
