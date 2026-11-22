"use client";

import {
  Activity,
  Compass,
  Gauge,
  Play,
  Shield,
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
  type InspectorSpec,
} from "../../../template";
import {
  buildFrequencyDomainCalculationModeRows,
  type FrequencyDomainCalculationModeRow,
} from "../../../panels/frequencyDomainInspectorModel";
import type { StudyStageModel } from "../../../panels/StudyInspectorPanelModel";
import { readStageTextureAssignments } from "../../../panels/StudyStageAuthoringModel";
import {
  FIELD_TESLA_UNITS_SI,
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
  DEFAULT_CANONICAL_K_PATH,
  type SpectralStageTestSnapshot,
  type SpectralValidationContext,
  type EigenmodesStageSpecDraft,
  sanitizeCapabilityStatus,
  resolveInitialEigenmodesTab,
  toEigenmodesStudyStageDraft,
  summarizePeriodicPairsResource,
  SpectralCapabilitiesLoader,
} from "./spectralStageShared";
import {
  buildEigenmodesStageNotices,
  buildHydratedEigenmodesBaseline,
  createFallbackEigenmodesBaseline,
  deriveEigenmodesFieldPatch,
} from "./spectralStageModels";
export function EigenmodesStageInspectorPanel({
  selection,
  testSnapshot,
}: InspectorPanelProps & {
  testSnapshot?: SpectralStageTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !testSnapshot) {
    return <ConnectedEigenmodesStageInspectorPanel selection={selection} />;
  }
  return (
    <EigenmodesStageInspectorPanelView
      selection={selection}
      testSnapshot={testSnapshot}
    />
  );
}

function ConnectedEigenmodesStageInspectorPanel({
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

  const hydratedBaseline = useMemo<EigenmodesStageSpecDraft>(
    () =>
      buildHydratedEigenmodesBaseline({
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
            <EigenmodesStageInspectorPanelView
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
                  (base) => toEigenmodesStudyStageDraft(draft, base),
                  "eigenmodes",
                )
              }
              onRunStage={(stageId, initialChoice) =>
                executeSelectedStage(stageId, initialChoice, "eigenmodes")
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

function EigenmodesStageInspectorPanelView({
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
  hydratedBaseline?: EigenmodesStageSpecDraft;
  lastAuthoringError?: string | null;
  manifest?: FrequencyDomainManifestResource | null;
  onCommitStage?: (draft: EigenmodesStageSpecDraft) => Promise<boolean>;
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
      : `eigen_${stageIndex + 1}`);

  const fallbackBaseline = useMemo<EigenmodesStageSpecDraft>(
    () => createFallbackEigenmodesBaseline(stageId, testSnapshot),
    [stageId, testSnapshot],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;

  const calculationModeRows = useMemo<FrequencyDomainCalculationModeRow[]>(
    () =>
      buildFrequencyDomainCalculationModeRows(
        manifest?.capabilities,
        manifest?.floquet_nonzero_k_response_supported,
      )
        .filter((row) =>
          ["fmr_modal", "free_modes", "dispersion_modal"].includes(row.mode),
        )
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
              kind: "study.stage.eigenmodes",
              label: "Eigenmodes",
              status: "ready",
            },
          ],
    [pipelineStripSteps, stageId, stageIndex],
  );

  const titleLabel = `Eigenmodes ${stageIndex + 1}`;
  const initialModeTabId = resolveInitialEigenmodesTab(selection.kind);

  const spec = useMemo<InspectorSpec<EigenmodesStageSpecDraft>>(
    () => ({
      id: "study.stage.eigenmodes",
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
              ctx.notify("Eigenmodes solve queued", ctx.draft.stageId);
            }
          },
        },
      },
      identity: {
        domain: "study",
        icon: Waves,
        title: () => titleLabel,
        kindLabel: "Linearized modal stage",
        entityId: stageId,
        statePill: (d) =>
          d.precision !== "double"
            ? { tone: "err", label: "Requires FP64" }
            : !d.hasPrecedingRelax && d.equilibriumSource === "relax"
              ? { tone: "warn", label: "Equilibrium missing" }
              : { tone: "ok", label: "Ready" },
      },
      facts: (d): readonly InspectorFact[] => [
        {
          id: "mode",
          label: "Mode",
          value:
            d.calculationMode === "fmr_modal"
              ? "FMR k = 0"
              : d.calculationMode === "dispersion_modal"
                ? "Dispersion k-Path"
                : "Free modes",
        },
        { id: "modes", label: "Modes", value: `N = ${d.modeCount}` },
        {
          id: "target",
          label: "Target",
          value:
            d.spectralTarget === "nearest"
              ? `Shift ${(d.targetFrequencyHz / 1e9).toFixed(2)} GHz`
              : d.spectralTarget === "frequency_window"
                ? "Band window"
                : "Lowest",
        },
        { id: "device", label: "Device", value: d.resolvedDeviceLabel },
      ],
      modeTabs: [
        { id: "setup", label: "Setup & Equilibrium" },
        { id: "physics", label: "Physics & Wavevector" },
        { id: "solver", label: "Solver & Outputs" },
      ],
      notices: (d) =>
        buildEigenmodesStageNotices({
          d,
          lastAuthoringError,
          onSwitchPrecisionToDouble,
          validationContext,
        }),
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
                { value: "fmr_modal", label: "FMR k = 0" },
                { value: "free_modes", label: "Free modes" },
                { value: "dispersion_modal", label: "Dispersion k-Path" },
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
          ],
        },
        {
          id: "equilibrium",
          title: "Equilibrium & Bias Sweep",
          icon: Compass,
          modeTabId: "setup",
          defaultOpen: true,
          rows: [
            {
              key: "equilibriumSource",
              label: "Equilibrium source",
              symbol: (
                <>
                  m<sub>eq</sub>
                </>
              ),
              type: "select",
              structural: true,
              options: [
                { value: "relax", label: "Preceding Relax stage" },
                { value: "provided", label: "Current runtime state" },
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
                      draft: EigenmodesStageSpecDraft;
                      patchDraft: (p: Partial<EigenmodesStageSpecDraft>) => void;
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
            {
              key: "enableBiasSweep",
              label: "Enable bias field sweep (Kittel)",
              type: "switch",
              structural: true,
            },
            {
              key: "biasSampleFieldTesla",
              label: "Primary bias sample",
              symbol: (
                <>
                  B<sub>0</sub>
                </>
              ),
              type: "vector3",
              units: FIELD_TESLA_UNITS_SI,
              defaultDisplayUnit: "mT",
              showWhen: (d) => d.enableBiasSweep,
            },
            {
              key: "biasFieldSamplesApmText",
              label: "Bias sweep samples (A/m, one [Hx, Hy, Hz] per line)",
              type: "expression",
              multiline: true,
              placeholder: "0, 0, 39788.7\n0, 0, 79577.5",
              showWhen: (d) => d.enableBiasSweep,
            },
            {
              key: "biasEquilibriumPolicy",
              label: "Equilibrium policy",
              type: "segmented",
              showWhen: (d) => d.enableBiasSweep,
              options: [
                { value: "relax_each", label: "Relax each field" },
                { value: "continuation", label: "Continuation" },
              ],
            },
            {
              key: "biasContinuationSeed",
              label: "Continuation seed",
              type: "select",
              showWhen: (d) => d.enableBiasSweep,
              options: [
                { value: "initial_state", label: "Initial state" },
                {
                  value: "previous_accepted_equilibrium",
                  label: "Previous accepted equilibrium",
                },
              ],
            },
          ],
        },
        {
          id: "operator-boundary",
          title: "Linearized Operator & Boundary",
          icon: Shield,
          modeTabId: "physics",
          defaultOpen: true,
          rows: [
            {
              key: "operator",
              label: "Linearized operator",
              symbol: "ℒ",
              type: "select",
              options: [
                { value: "linearized_llg", label: "Standard tangent-space LLG" },
                { value: "full_2x2", label: "Full 2×2 transverse complex" },
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
              symbol: "α",
              type: "segmented",
              options: [
                { value: "ignore", label: "Conservative (α = 0)" },
                { value: "include", label: "Complex damped (linewidth)" },
              ],
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
              label: "Bloch phase convention",
              type: "readonly",
              mono: true,
              showWhen: (d) =>
                d.lateralBc === "periodic_1d" ||
                d.lateralBc === "periodic_2d" ||
                d.magnetostaticBc === "floquet_airbox",
              format: () => "exp(-i k · Δr)",
            },
          ],
        },
        {
          id: "wavevector-sampling",
          title: "Wavevector Sampling",
          icon: Activity,
          modeTabId: "physics",
          defaultOpen: true,
          showWhen: (d) =>
            d.calculationMode === "dispersion_modal" ||
            d.calculationMode === "free_modes",
          rows: [
            {
              key: "kSamplingMode",
              label: "Wavevector sampling mode",
              symbol: "k",
              type: "segmented",
              structural: true,
              options: [
                { value: "none", label: "Γ = 0" },
                { value: "single_k", label: "Single k" },
                { value: "k_path", label: "Γ–X–M Path" },
                { value: "k_grid", label: "2D k-Grid" },
              ],
            },
            {
              key: "kVectorRadPerM",
              label: "Wavevector k",
              symbol: "k",
              type: "vector3",
              units: WAVEVECTOR_UNITS_SI,
              defaultDisplayUnit: "rad/µm",
              showWhen: (d) => d.kSamplingMode === "single_k",
            },
            {
              key: "kPathHighSymmetry",
              label: "High-symmetry k-path",
              type: "expression",
              multiline: true,
              placeholder: DEFAULT_CANONICAL_K_PATH,
              showWhen: (d) => d.kSamplingMode === "k_path",
            },
            {
              key: "kSamplesPerSegment",
              label: "Samples per segment",
              type: "number",
              integer: true,
              min: 2,
              max: 512,
              showWhen: (d) => d.kSamplingMode === "k_path",
            },
            {
              key: "kSamplingJson",
              label: "k-sampling grid JSON",
              type: "expression",
              multiline: true,
              placeholder: '{"kind":"grid","nx":32,"ny":32}',
              showWhen: (d) => d.kSamplingMode === "k_grid",
            },
          ],
        },
        {
          id: "eigensolver",
          title: "Eigensolver & Mode Outputs",
          icon: Gauge,
          modeTabId: "solver",
          defaultOpen: true,
          rows: [
            {
              key: "modeCount",
              label: "Number of modes",
              symbol: (
                <>
                  N<sub>m</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 1,
              max: 500,
            },
            {
              key: "spectralTarget",
              label: "Spectral target",
              type: "segmented",
              structural: true,
              options: [
                { value: "lowest", label: "Lowest" },
                { value: "nearest", label: "Shift-invert" },
                { value: "frequency_window", label: "Window" },
              ],
            },
            {
              key: "targetFrequencyHz",
              label: "Target frequency",
              symbol: (
                <>
                  f<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: FREQUENCY_UNITS_SI,
              defaultDisplayUnit: "GHz",
              min: 0,
              minExclusive: true,
              showWhen: (d) => d.spectralTarget === "nearest",
            },
            {
              key: "windowMinHz",
              label: "Window minimum",
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
              showWhen: (d) => d.spectralTarget === "frequency_window",
            },
            {
              key: "windowMaxHz",
              label: "Window maximum",
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
              showWhen: (d) => d.spectralTarget === "frequency_window",
              validate: (val, d) =>
                val <= d.windowMinHz ? "Window maximum must exceed window minimum." : null,
            },
            {
              key: "maxKrylovIterations",
              label: "Max Krylov iterations",
              type: "number",
              integer: true,
              min: 10,
              max: 100000,
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
              type: "custom",
              label: "Modal solve status",
              wide: true,
              render: () => (
                <StageLiveTelemetryPanel
                  emptyDescription="Run this stage to compute modal frequencies, damping linewidths, and 3D mode shapes."
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
      deriveFieldPatch={deriveEigenmodesFieldPatch}
    />
  );
}
