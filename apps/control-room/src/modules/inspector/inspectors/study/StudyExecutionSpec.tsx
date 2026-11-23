"use client";

import {
  Cpu,
  Gauge,
  History,
  Magnet,
  Sliders,
} from "lucide-react";
import { useCallback, useContext, useMemo } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  runFdmGridRefreshOperation,
} from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { KernelContext } from "@/kernel/KernelContext";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../template";
import { ProjectBatchesSection } from "../../panels/ProjectBatchesSection";
import { ProjectRunsSection } from "../../panels/ProjectRunsSection";
import type {
  StudyExecutionProfileAssignment,
} from "../../panels/StudyExecutionProfileModel";
import {
  type StudyGlobalDraft,
  validateAdaptiveWorkflow,
} from "../../panels/StudyGlobalAuthoringModel";
import { rawStudyStages } from "../../panels/studyInspectorShared";
import type { StudyStageDraft } from "../../panels/StudyStageAuthoringModel";
import {
  ConnectedInspectorSpec,
  FIELD_TESLA_UNITS_SI,
  LENGTH_UNITS_SI,
  MEMORY_BYTES_UNITS_SI,
} from "../../panels/study/ConnectedInspectorSpec";
import {
  buildStudyCommandContext,
  useKernelStudyAuthoring,
} from "../../panels/study/useConnectedStudyAuthoring";
import {
  type StudyExecutionTestSnapshot,
  type StudyExecutionDraft,
  resolveLockedSessionDiscretization,
  isExplicitFdmDraft,
  studyBreadcrumbs,
  resolveEffectiveDeviceDisplay,
  hasSubscribableResourceStore,
} from "./studyShared";
import {
  StudyExecutionFdmGridPreview,
  StudyExecutionProfileRadixCard,
} from "./StudyExecutionProfileCard";
import {
  applyStudyExecutionDraftToGlobal,
  buildHydratedStudyExecutionBaseline,
  buildStudyDefaultSolverSection,
  createFallbackStudyExecutionBaseline,
} from "./StudyExecutionModelAndSolver";
export function StudyExecutionInspectorPanel({
  selection,
  testSnapshot,
}: InspectorPanelProps & {
  testSnapshot?: StudyExecutionTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  if (kernel && !testSnapshot) {
    return <ConnectedStudyExecutionInspectorPanel selection={selection} />;
  }
  return (
    <StudyExecutionInspectorPanelView
      selection={selection}
      testSnapshot={testSnapshot}
    />
  );
}

function ConnectedStudyExecutionInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  const {
    commitExecutionProfile,
    commitGlobalDraft,
    globalDraft,
    lastAuthoringError,
    requestedDiscretization,
    runtimeStatus,
    sceneData,
    sceneRevision,
    sessionDiscretization,
    sessionScopeKey,
    stageDrafts,
  } = useKernelStudyAuthoring(selection);

  const hydratedBaseline = useMemo<StudyExecutionDraft>(
    () =>
      buildHydratedStudyExecutionBaseline({
        globalDraft,
        requestedDiscretization,
        runtimeStatus,
        sceneData,
        sessionDiscretization,
        stageDrafts,
      }),
    [
      globalDraft,
      requestedDiscretization,
      runtimeStatus,
      sceneData,
      sessionDiscretization,
      stageDrafts,
    ],
  );
  const handleApplyFdmGrid = useCallback(async () => {
    if (!kernel) return;
    await runFdmGridRefreshOperation(
      buildStudyCommandContext(kernel, {
        runtimeStatus,
        sceneData,
        sessionScopeKey: sessionScopeKey ?? undefined,
        sourceDetail: "study-execution",
      }),
      {
        kind: "fdm_grid_refresh",
        ...(sceneRevision !== null
          ? { precondition: { scene_revision: sceneRevision } }
          : {}),
        reason: "study-execution",
      },
    );
  }, [kernel, runtimeStatus, sceneData, sceneRevision, sessionScopeKey]);

  return (
    <StudyExecutionInspectorPanelView
      globalDraftForPreview={globalDraft}
      hydratedBaseline={hydratedBaseline}
      lastAuthoringError={lastAuthoringError}
      sceneData={sceneData}
      selection={selection}
      stageDrafts={stageDrafts}
      onApplyFdmGrid={handleApplyFdmGrid}
      onApplyProfile={commitExecutionProfile}
      onCommitExecution={(draft) =>
        applyStudyExecutionDraftToGlobal(
          draft,
          sessionDiscretization,
          commitGlobalDraft,
        )
      }
    />
  );
}

function StudyExecutionInspectorPanelView({
  globalDraftForPreview,
  hydratedBaseline,
  lastAuthoringError = null,
  onApplyFdmGrid,
  onApplyProfile,
  onCommitExecution,
  sceneData = null,
  selection,
  stageDrafts = [],
  testSnapshot,
}: InspectorPanelProps & {
  globalDraftForPreview?: StudyGlobalDraft;
  hydratedBaseline?: StudyExecutionDraft;
  lastAuthoringError?: string | null;
  onApplyFdmGrid?: () => Promise<void>;
  onApplyProfile?: (assignment: StudyExecutionProfileAssignment) => Promise<boolean>;
  onCommitExecution?: (draft: StudyExecutionDraft) => Promise<boolean>;
  sceneData?: SceneResource | null;
  stageDrafts?: readonly StudyStageDraft[];
  testSnapshot?: StudyExecutionTestSnapshot;
}) {
  const kernel = useContext(KernelContext);
  const canSubscribeResources = hasSubscribableResourceStore(kernel);
  const fallbackBaseline = useMemo<StudyExecutionDraft>(
    () => createFallbackStudyExecutionBaseline(testSnapshot),
    [testSnapshot],
  );
  const baseline = hydratedBaseline ?? fallbackBaseline;
  const adaptiveWorkflowError = useMemo(
    () => (sceneData ? validateAdaptiveWorkflow(rawStudyStages(sceneData))[0]?.message ?? null : null),
    [sceneData],
  );

  const requestedBackendHint =
    globalDraftForPreview?.requestedBackend?.trim().toLowerCase() ?? null;

  const formatDiscretizationFact = useCallback(
    (draft: StudyExecutionDraft): string => {
      const requested =
        requestedBackendHint ||
        draft.requestedDiscretization?.trim().toLowerCase() ||
        draft.discretization.toLowerCase();
      const lockedDisc = resolveLockedSessionDiscretization(draft);
      if (requested === "auto") {
        return lockedDisc ? `Auto \u2192 ${lockedDisc.toUpperCase()}` : "Auto";
      }
      return lockedDisc
        ? lockedDisc.toUpperCase()
        : draft.discretization.toUpperCase();
    },
    [requestedBackendHint],
  );

  const spec = useMemo<InspectorSpec<StudyExecutionDraft>>(
    () => ({
      id: "study.execution",
      header: {
        breadcrumbs: studyBreadcrumbs("Execution"),
        canFitView: true,
      },
      identity: {
        domain: "study",
        icon: Cpu,
        title: () => "Execution",
        kindLabel: "Discretization & hardware realization",
        entityId: "study:execution",
        statePill: (draft) => {
          const resolved = resolveEffectiveDeviceDisplay(draft);
          if (resolved.blockedGpu) {
            return { tone: "err", label: "GPU unavailable" };
          }
          if (draft.requestedDevice === "auto") {
            return { tone: "info", label: "Auto-resolved" };
          }
          return { tone: "ok", label: "Qualified" };
        },
      },
      facts: (draft): readonly InspectorFact[] => {
        const resolved = resolveEffectiveDeviceDisplay(draft);
        const discLabel = formatDiscretizationFact(draft);
        return [
          { id: "disc", label: "Discretization", value: discLabel },
          {
            id: "device",
            label: "Device",
            value: resolved.factValue,
            tone: resolved.blockedGpu ? "err" : "ok",
          },
          {
            id: "precision",
            label: "Precision",
            value: draft.precision === "double" ? "FP64" : "FP32",
          },
          {
            id: "qual",
            label: "Qualification",
            value:
              draft.qualificationMode === "strict"
                ? "Strict"
                : draft.qualificationMode === "hybrid"
                  ? "Hybrid"
                  : "Extended",
          },
        ];
      },
      modeTabs: [
        { id: "hardware", label: "Hardware & Lane" },
        { id: "physics", label: "Global Physics & Solver" },
      ],
      notices: (draft): readonly InspectorNotice<StudyExecutionDraft>[] => {
        const list: InspectorNotice<StudyExecutionDraft>[] = [];
        if (lastAuthoringError) {
          list.push({
            id: "exec-authoring-err",
            tone: "err",
            text: lastAuthoringError,
          });
        }
        const resolved = resolveEffectiveDeviceDisplay(draft);
        if (resolved.blockedGpu) {
          list.push({
            id: "explicit-gpu-blocked",
            tone: "err",
            title: "Explicit GPU execution is blocked",
            text: "No CUDA-capable GPU is available on this host. Fullmag never silently falls back to CPU when GPU is explicitly requested. Switch to Auto or Switch to CPU to proceed.",
            focusFieldKey: "requestedDevice",
            quickFix: {
              label: "Switch to Auto",
              onApply: (ctx) => {
                ctx.setField("requestedDevice", "auto");
              },
            },
          });
          list.push({
            id: "explicit-gpu-switch-cpu",
            tone: "warn",
            text: "Alternatively, select explicit CPU execution for multi-threaded host solve.",
            quickFix: {
              label: "Switch to CPU",
              ghost: true,
              onApply: (ctx) => {
                ctx.setField("requestedDevice", "cpu");
              },
            },
          });
        }
        if (
          isExplicitFdmDraft(draft) &&
          draft.fdmDemagStrategy === "single_grid" &&
          draft.magneticObjectCount > 1
        ) {
          list.push({
            id: "fdm-single-grid-multibody",
            tone: "err",
            text: "Single-grid FFT demagnetization supports 1 magnetic body; switch to Multilayer convolution for multi-body FDM.",
            quickFix: {
              label: "Switch to Multilayer convolution",
              onApply: (ctx) => ctx.setField("fdmDemagStrategy", "multilayer_convolution"),
            },
          });
        }
        if (
          draft.parallelMode === "adaptive" &&
          (resolveLockedSessionDiscretization(draft) !== "fem" ||
            draft.requestedDevice !== "cpu")
        ) {
          list.push({
            id: "adaptive-pool-lane",
            tone: "err",
            text: "Adaptive worker pool requires an FEM session on CPU.",
            quickFix: {
              label: "Switch to Serial",
              onApply: (ctx) => ctx.setField("parallelMode", "serial"),
            },
          });
        }
        return list;
      },
      sections: [
        ...(canSubscribeResources && !testSnapshot && onApplyProfile
          ? [
              {
                id: "execution-profile",
                title: "Study Execution Profile",
                icon: Sliders,
                modeTabId: "hardware",
                defaultOpen: baseline.executionProfileBound,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <StudyExecutionProfileRadixCard
                        sceneData={sceneData}
                        sessionDiscretization={baseline.sessionDiscretization}
                        stages={stageDrafts}
                        onApplyAssignment={onApplyProfile}
                      />
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "discretization-device",
          title: "Discretization & Device",
          icon: Cpu,
          modeTabId: "hardware",
          defaultOpen: true,
          summary: (d) =>
            `${formatDiscretizationFact(d)} · ${resolveEffectiveDeviceDisplay(d).factValue}`,
          rows: [
            {
              label: "Discretization",
              type: "readonly",
              hint: "Assigned by the session simulation mode",
              format: (d) => `${formatDiscretizationFact(d)} (Session)`,
            },
            {
              key: "requestedDevice",
              label: "Device",
              type: "segmented",
              structural: true,
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              validate: (val, d) =>
                val === "gpu" && !d.cudaAvailable
                  ? "No CUDA GPU detected; explicit GPU never falls back to CPU."
                  : null,
              options: [
                { value: "auto", label: "Auto" },
                { value: "gpu", label: "GPU (CUDA)" },
                { value: "cpu", label: "CPU" },
              ],
            },
            {
              label: "Resolved device",
              type: "readonly",
              showWhen: (d) => d.requestedDevice === "auto" || d.requestedDevice === "gpu",
              format: (d) => resolveEffectiveDeviceDisplay(d).readoutValue,
            },
            {
              key: "precision",
              label: "Precision",
              type: "segmented",
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              options: [
                { value: "double", label: "FP64 (Double)" },
                { value: "single", label: "FP32 (Single)" },
              ],
            },
            {
              key: "qualificationMode",
              label: "Qualification mode",
              type: "segmented",
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              options: [
                { value: "strict", label: "Strict" },
                { value: "extended", label: "Extended" },
                { value: "hybrid", label: "Hybrid" },
              ],
            },
          ],
        },
        {
          id: "compute-budget",
          title: "Compute & Memory Budget",
          icon: Gauge,
          modeTabId: "hardware",
          defaultOpen: true,
          summary: (d) =>
            `${d.parallelMode === "adaptive" ? "Adaptive pool" : "Serial"} · ${d.cpuThreadsText.trim() || "Auto"} threads`,
          rows: [
            {
              key: "cpuThreadsText",
              label: "CPU threads",
              symbol: (
                <>
                  N<sub>t</sub>
                </>
              ),
              type: "text",
              mono: true,
              placeholder: "Auto (host default)",
              disabledReason: (d) =>
                d.executionProfileBound
                  ? "Managed by bound execution profile."
                  : null,
              showWhen: (d) => d.requestedDevice !== "gpu",
              validate: (val) => {
                const trimmed = String(val ?? "").trim();
                if (!trimmed) return null;
                const parsed = Number(trimmed);
                return Number.isInteger(parsed) && parsed >= 1 && parsed <= 256
                  ? null
                  : "Enter blank (auto) or an integer thread count between 1 and 256.";
              },
            },
            {
              key: "parallelMode",
              label: "Independent k points",
              type: "segmented",
              structural: true,
              options: [
                { value: "serial", label: "Serial" },
                { value: "adaptive", label: "Adaptive pool" },
              ],
            },
            {
              key: "maxWorkers",
              label: "Max workers",
              symbol: (
                <>
                  N<sub>w</sub>
                </>
              ),
              type: "number",
              integer: true,
              min: 1,
              max: 64,
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "threadsPerWorker",
              label: "Threads per worker",
              type: "number",
              integer: true,
              min: 1,
              max: 64,
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "maxCpuPercent",
              label: "Max CPU share",
              type: "range",
              min: 10,
              max: 100,
              step: 5,
              unitSuffix: "%",
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "maxMemoryPercent",
              label: "Max RAM share",
              type: "range",
              min: 10,
              max: 95,
              step: 5,
              unitSuffix: "%",
              showWhen: (d) => d.parallelMode === "adaptive",
            },
            {
              key: "memoryReserveBytes",
              label: "System RAM reserve",
              type: "quantity",
              units: MEMORY_BYTES_UNITS_SI,
              defaultDisplayUnit: "MiB",
              min: 0,
              showWhen: (d) => d.parallelMode === "adaptive",
            },
          ],
        },
        {
          id: "global-physics",
          title: "Global Field, Grid & Interactions",
          icon: Magnet,
          modeTabId: "physics",
          defaultOpen: true,
          summary: (d) =>
            `${d.exchangeEnabled ? "Exchange ON" : "Exchange OFF"} · ${d.demagEnabled ? "Demag ON" : "Demag OFF"}`,
          rows: [
            {
              key: "exchangeEnabled",
              label: "Exchange interaction",
              symbol: (
                <>
                  A<sub>ex</sub>
                </>
              ),
              type: "switch",
            },
            {
              key: "demagEnabled",
              label: "Demagnetization",
              symbol: (
                <>
                  H<sub>demag</sub>
                </>
              ),
              type: "switch",
              structural: true,
            },
            {
              key: "fdmDemagStrategy",
              label: "FDM demag realization",
              type: "select",
              showWhen: (d) => d.demagEnabled && isExplicitFdmDraft(d),
              options: [
                { value: "auto", label: "Auto" },
                { value: "single_grid", label: "Single FFT grid" },
                { value: "multilayer_convolution", label: "Multilayer convolution" },
              ],
            },
            {
              key: "fdmDemagMode",
              label: "FDM demag dimensionality",
              type: "segmented",
              showWhen: (d) => d.demagEnabled && isExplicitFdmDraft(d),
              options: [
                { value: "auto", label: "Auto" },
                { value: "two_d_stack", label: "2D stack" },
                { value: "three_d", label: "3D full" },
              ],
            },
            {
              key: "fdmDefaultCell",
              label: "FDM default cell (dx, dy, dz in m)",
              type: "text",
              mono: true,
              placeholder: "2e-9, 2e-9, 1e-9",
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              type: "custom",
              label: "FDM grid preview",
              wide: true,
              showWhen: (d) => isExplicitFdmDraft(d) && Boolean(sceneData),
              render: (ctx) => (
                <StudyExecutionFdmGridPreview
                  draft={ctx.draft}
                  globalDraftForPreview={globalDraftForPreview}
                  sceneData={sceneData}
                  onApplyFdmGrid={onApplyFdmGrid}
                />
              ),
            },
            {
              key: "fdmPerMagnet",
              label: "FDM per-magnet grids JSON",
              type: "expression",
              multiline: true,
              placeholder: '{"free":{"cell":[2e-9,2e-9,1e-9]}}',
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmCommonCells",
              label: "Common convolution cells (Nx, Ny, Nz)",
              type: "text",
              mono: true,
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmCommonCellsXy",
              label: "Common XY cells (Nx, Ny)",
              type: "text",
              mono: true,
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmDemagExplain",
              label: "Explain FDM demag plan",
              type: "switch",
              showWhen: (d) => isExplicitFdmDraft(d),
            },
            {
              key: "fdmBoundaryCorrection",
              label: "FDM boundary correction",
              type: "select",
              structural: true,
              showWhen: (d) => isExplicitFdmDraft(d),
              options: [
                { value: "engine_default", label: "Engine default" },
                { value: "none", label: "None — staircase" },
                { value: "volume", label: "Volume fraction T0" },
                { value: "full", label: "Surface + volume T1" },
              ],
            },
            {
              key: "boundaryPhiFloor",
              label: "Boundary volume floor",
              symbol: (
                <>
                  φ<sub>min</sub>
                </>
              ),
              type: "number",
              min: 0.001,
              max: 0.999,
              step: 0.01,
              showWhen: (d) =>
                isExplicitFdmDraft(d) &&
                (d.fdmBoundaryCorrection === "volume" || d.fdmBoundaryCorrection === "full"),
            },
            {
              key: "boundaryDeltaMinM",
              label: "Boundary intersection floor",
              symbol: (
                <>
                  δ<sub>min</sub>
                </>
              ),
              type: "quantity",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
              minExclusive: true,
              min: 0,
              showWhen: (d) => isExplicitFdmDraft(d) && d.fdmBoundaryCorrection === "full",
            },
            {
              key: "femDemagSolver",
              label: "FEM demag realization",
              type: "select",
              showWhen: (d) => d.demagEnabled && !isExplicitFdmDraft(d),
              options: [
                { value: "auto", label: "Auto" },
                { value: "poisson_robin", label: "Poisson Robin" },
                { value: "poisson_dirichlet", label: "Poisson Dirichlet" },
                { value: "fredkin_koehler", label: "Fredkin–Koehler" },
                { value: "bem", label: "BEM" },
                { value: "fmm", label: "FMM" },
                { value: "airbox_robin", label: "Airbox Robin" },
              ],
            },
            {
              key: "femDemagPolicyJson",
              label: "FEM demag solver policy JSON",
              type: "expression",
              multiline: true,
              placeholder: "{}",
              showWhen: (d) => !isExplicitFdmDraft(d),
            },
            {
              key: "externalFieldTesla",
              label: "External bias field",
              symbol: (
                <>
                  B<sub>ext</sub>
                </>
              ),
              type: "vector3",
              units: FIELD_TESLA_UNITS_SI,
              defaultDisplayUnit: "mT",
            },
          ],
        },
        buildStudyDefaultSolverSection(),
        ...(canSubscribeResources && !testSnapshot
          ? [
              {
                id: "execution-runs-batches",
                title: "Execution Runs & Parameter Batches",
                icon: History,
                modeTabId: "hardware",
                defaultOpen: false,
                rows: [
                  {
                    type: "custom" as const,
                    wide: true,
                    render: () => (
                      <div className="grid gap-3">
                        <ProjectRunsSection />
                        <ProjectBatchesSection />
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
      ],
      commitBar: {
        mode: "staged",
        lockReason: (draft) =>
          draft.parallelMode === "adaptive" ? adaptiveWorkflowError : null,
        onApply: async (draft) => {
          if (onCommitExecution) {
            return onCommitExecution(draft);
          }
          return true;
        },
      },
    }),
    [
      adaptiveWorkflowError,
      baseline.executionProfileBound,
      baseline.sessionDiscretization,
      canSubscribeResources,
      formatDiscretizationFact,
      globalDraftForPreview,
      lastAuthoringError,
      onApplyFdmGrid,
      onApplyProfile,
      onCommitExecution,
      sceneData,
      stageDrafts,
      testSnapshot,
    ],
  );

  return <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />;
}
