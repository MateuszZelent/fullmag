"use client";

import { Timer } from "lucide-react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import type {
  ActiveLaneCapabilitySnapshot,
} from "@/kernel/resources/useActiveLaneCapabilities";

import { hasStudyExecutionProfile } from "../../panels/StudyExecutionProfileModel";
import {
  normalizeDemagRealizationForLane,
  type StudyGlobalDraft,
} from "../../panels/StudyGlobalAuthoringModel";
import type { StudyStageDraft } from "../../panels/StudyStageAuthoringModel";
import {
  ENERGY_JOULE_UNITS_SI,
  TIME_UNITS_SI,
  TORQUE_APM_UNITS_SI,
} from "../../panels/study/ConnectedInspectorSpec";
import type { InspectorSectionSpec } from "../../template";
import {
  type StudyExecutionTestSnapshot,
  type StudyExecutionDraft,
  isExplicitFdmDraft,
  parseVector3Text,
} from "./studyShared";
export function buildHydratedStudyExecutionBaseline({
  globalDraft,
  requestedDiscretization,
  runtimeStatus,
  sceneData,
  sessionDiscretization,
  stageDrafts,
}: {
  globalDraft: StudyGlobalDraft;
  requestedDiscretization: string | null;
  runtimeStatus: {
    capabilities?: {
      active_lane?: ActiveLaneCapabilitySnapshot | null;
      [key: string]: unknown;
    };
  } | null | undefined;
  sceneData: SceneResource | null;
  sessionDiscretization: string | null;
  stageDrafts: readonly StudyStageDraft[];
}): StudyExecutionDraft {
    const capRecord = (runtimeStatus?.capabilities ?? {}) as unknown as Record<
      string,
      unknown
    >;
    const resolvedDev =
      runtimeStatus?.capabilities?.active_lane?.resolved?.device ?? "";
    const devicesAvailable = Array.isArray(capRecord.devices_available)
      ? (capRecord.devices_available as string[])
      : [];
    const cudaAvailable =
      typeof capRecord.cuda_available === "boolean"
        ? capRecord.cuda_available
        : devicesAvailable.some((d) => d === "gpu" || d.startsWith("cuda")) ||
          resolvedDev === "gpu" ||
          resolvedDev.startsWith("cuda");
    const rawDev = globalDraft.requestedDevice.toLowerCase();
    const requestedDevice: StudyExecutionDraft["requestedDevice"] =
      rawDev === "gpu" || rawDev.startsWith("cuda")
        ? "gpu"
        : rawDev === "cpu"
          ? "cpu"
          : "auto";
    const rawDisc = globalDraft.requestedBackend.toLowerCase();
    const discretization: StudyExecutionDraft["discretization"] =
      sessionDiscretization === "fem" || sessionDiscretization === "fdm"
        ? sessionDiscretization
        : rawDisc === "fem"
          ? "fem"
          : rawDisc === "fdm"
            ? "fdm"
            : rawDisc === "hybrid"
              ? "hybrid"
              : "auto";
    const precision: StudyExecutionDraft["precision"] =
      globalDraft.requestedPrecision === "single" ? "single" : "double";
    const qualificationMode: StudyExecutionDraft["qualificationMode"] =
      globalDraft.requestedMode === "extended"
        ? "extended"
        : globalDraft.requestedMode === "hybrid"
          ? "hybrid"
          : "strict";
    const magnetCount = (sceneData?.objects ?? []).filter(
      (obj) => obj.role === "magnet",
    ).length;
    const rawStudyRecord =
      sceneData && typeof sceneData.study === "object" && sceneData.study
        ? (sceneData.study as Record<string, unknown>)
        : null;
    const rawStudyFdm =
      rawStudyRecord &&
      typeof rawStudyRecord.fdm === "object" &&
      rawStudyRecord.fdm &&
      !Array.isArray(rawStudyRecord.fdm)
        ? (rawStudyRecord.fdm as Record<string, unknown>)
        : null;
    const rawStudyFdmDemag =
      rawStudyFdm &&
      typeof rawStudyFdm.demag === "object" &&
      rawStudyFdm.demag &&
      !Array.isArray(rawStudyFdm.demag)
        ? (rawStudyFdm.demag as Record<string, unknown>)
        : null;
    const fdm = globalDraft.fdm;
    const adv = globalDraft.solver.adaptiveTimestep;
    const profileBound = sceneData ? hasStudyExecutionProfile(sceneData) : false;
    const normalizedDemag = normalizeDemagRealizationForLane(
      globalDraft.demagRealization,
      {
        requestedBackend: profileBound ? null : globalDraft.requestedBackend,
        requestedDiscretization,
        sessionDiscretization,
      },
    );
    const femDemagSolver: StudyExecutionDraft["femDemagSolver"] =
      normalizedDemag === "poisson_robin" ||
      normalizedDemag === "poisson_dirichlet" ||
      normalizedDemag === "fredkin_koehler" ||
      normalizedDemag === "bem" ||
      normalizedDemag === "fmm" ||
      normalizedDemag === "airbox_robin"
        ? normalizedDemag
        : "auto";
    const fallbackDefaultCell = Array.isArray(rawStudyFdm?.default_cell)
      ? rawStudyFdm.default_cell.join(", ")
      : "";
    const fallbackPerMagnet =
      rawStudyFdm?.per_magnet && typeof rawStudyFdm.per_magnet === "object"
        ? JSON.stringify(rawStudyFdm.per_magnet)
        : "";
    const fallbackCommonCells = Array.isArray(rawStudyFdmDemag?.common_cells)
      ? rawStudyFdmDemag.common_cells.join(", ")
      : "";
    const fallbackCommonCellsXy = Array.isArray(rawStudyFdmDemag?.common_cells_xy)
      ? rawStudyFdmDemag.common_cells_xy.join(", ")
      : "";
    const rawDemagMode =
      fdm?.demagMode ??
      (typeof rawStudyFdmDemag?.mode === "string" ? rawStudyFdmDemag.mode : "auto");
    const rawBoundaryCorrection =
      fdm?.boundaryCorrection ??
      (typeof rawStudyFdm?.boundary_correction === "string"
        ? rawStudyFdm.boundary_correction
        : "");

    return {
      executionProfile: profileBound ? "bound" : "direct",
      discretization,
      requestedDevice,
      precision,
      qualificationMode,
      cpuThreadsText: globalDraft.requestedCpuThreads ?? "",
      parallelMode:
        globalDraft.parallelExecution.mode === "adaptive"
          ? "adaptive"
          : "serial",
      maxWorkers: Number(globalDraft.parallelExecution.maxWorkers) || 4,
      threadsPerWorker:
        Number(globalDraft.parallelExecution.threadsPerWorker) || 1,
      maxCpuPercent: Number(globalDraft.parallelExecution.maxCpuPercent) || 90,
      maxMemoryPercent:
        Number(globalDraft.parallelExecution.maxMemoryPercent) || 80,
      memoryReserveBytes:
        (Number(globalDraft.parallelExecution.memoryReserveMiB) || 1024) *
        1024 *
        1024,
      exchangeEnabled: globalDraft.exchangeEnabled,
      demagEnabled: globalDraft.demagEnabled,
      fdmDemagStrategy:
        normalizedDemag === "single_grid"
          ? "single_grid"
          : normalizedDemag === "multilayer_convolution"
            ? "multilayer_convolution"
            : "auto",
      fdmDemagMode:
        rawDemagMode === "two_d_stack" || rawDemagMode === "three_d"
          ? rawDemagMode
          : "auto",
      fdmDefaultCell: fdm?.defaultCell ?? fallbackDefaultCell,
      fdmPerMagnet: fdm?.perMagnet ?? fallbackPerMagnet,
      fdmCommonCells: fdm?.commonCells ?? fallbackCommonCells,
      fdmCommonCellsXy: fdm?.commonCellsXy ?? fallbackCommonCellsXy,
      fdmDemagExplain:
        fdm?.demagExplain ??
        (typeof rawStudyFdmDemag?.explain === "boolean"
          ? rawStudyFdmDemag.explain
          : true),
      fdmBoundaryCorrection: rawBoundaryCorrection || "engine_default",
      boundaryPhiFloor:
        Number(fdm?.boundaryPhiFloor ?? rawStudyFdm?.boundary_phi_floor) || 0.05,
      boundaryDeltaMinM:
        Number(fdm?.boundaryDeltaMin ?? rawStudyFdm?.boundary_delta_min) || 1e-10,
      femDemagSolver,
      femDemagPolicyJson: globalDraft.femDemagSolverPolicy || "",
      externalFieldTesla: parseVector3Text(globalDraft.externalField),
      defaultIntegrator:
        globalDraft.solver.integrator === "heun" ||
        globalDraft.solver.integrator === "rk23" ||
        globalDraft.solver.integrator === "rk45"
          ? globalDraft.solver.integrator
          : "auto",
      defaultTimestepMode: globalDraft.solver.timestepMode || "auto",
      defaultFixedDtS: Number(globalDraft.solver.fixDt) || 1e-13,
      defaultDtInitS:
        Number(adv?.dtInitial || globalDraft.solver.dtInitial) || 5e-14,
      defaultDtMinS: Number(adv?.dtMin || globalDraft.solver.dtMin) || 1e-15,
      defaultDtMaxS: Number(adv?.dtMax || globalDraft.solver.dtMax) || 1e-11,
      defaultMaxErr: Number(globalDraft.solver.maxErr) || 1e-5,
      defaultAtol: Number(adv?.atol) || 1e-7,
      defaultRtol: Number(adv?.rtol) || 1e-5,
      defaultSafety: Number(adv?.safety) || 0.9,
      defaultGrowthLimit: Number(adv?.growthLimit) || 2,
      defaultShrinkLimit: Number(adv?.shrinkLimit) || 0.2,
      defaultMaxSpinRotation: adv?.maxSpinRotation ?? "",
      defaultNormTolerance: adv?.normTolerance ?? "",
      defaultDemagIntervalS: Number(globalDraft.solver.demagInterval) || 0,
      defaultRelaxAlgorithm:
        globalDraft.solver.relaxAlgorithm || "llg_overdamped",
      defaultTorqueToleranceApm:
        Number(globalDraft.solver.torqueTolerance) || 100,
      defaultEnergyToleranceJ:
        Number(globalDraft.solver.energyTolerance) || 1e-20,
      defaultMaxRelaxSteps: Number(globalDraft.solver.maxRelaxSteps) || 50000,
      advancedSolverJson: "{}",
      cudaAvailable,
      gpuName:
        typeof capRecord.gpu_name === "string" && capRecord.gpu_name
          ? capRecord.gpu_name
          : cudaAvailable
            ? "CUDA GPU"
            : null,
      cpuThreadCap:
        typeof capRecord.cpu_thread_count === "number"
          ? capRecord.cpu_thread_count
          : typeof capRecord.cpu_threads === "number"
            ? capRecord.cpu_threads
            : 16,
      magneticObjectCount: magnetCount,
      hasChangeDeviceStage: stageDrafts.some((s) => s.kind === "change_device"),
      executionProfileBound: profileBound,
      requestedDiscretization,
      sessionDiscretization,
    };
}

export function applyStudyExecutionDraftToGlobal(
  draft: StudyExecutionDraft,
  sessionDiscretization: string | null,
  commitGlobalDraft: (updater: (base: StudyGlobalDraft) => StudyGlobalDraft) => Promise<boolean>,
): Promise<boolean> {
        const explicitFdm = isExplicitFdmDraft(draft);
        return commitGlobalDraft((base) => {
          const baseBackend = base.requestedBackend.trim().toLowerCase();
          const preservedBackend =
            sessionDiscretization === "fdm" || sessionDiscretization === "fem"
              ? baseBackend === "auto"
                ? "auto"
                : sessionDiscretization
              : base.requestedBackend;
          return {
            ...base,
            requestedBackend: preservedBackend,
            requestedDevice: draft.requestedDevice,
          requestedPrecision: draft.precision,
          requestedMode: draft.qualificationMode,
          exchangeEnabled: draft.exchangeEnabled,
          demagEnabled: draft.demagEnabled,
          demagRealization: explicitFdm
            ? draft.fdmDemagStrategy
            : draft.femDemagSolver,
          femDemagSolverPolicy: !explicitFdm
            ? draft.femDemagPolicyJson
            : base.femDemagSolverPolicy,
          ...(explicitFdm
            ? {
                fdm: {
                  boundaryCorrection:
                    draft.fdmBoundaryCorrection === "engine_default"
                      ? ""
                      : draft.fdmBoundaryCorrection,
                  boundaryDeltaMin:
                    draft.fdmBoundaryCorrection === "full"
                      ? String(draft.boundaryDeltaMinM)
                      : base.fdm?.boundaryDeltaMin ?? "",
                  boundaryPhiFloor:
                    draft.fdmBoundaryCorrection === "volume" ||
                    draft.fdmBoundaryCorrection === "full"
                      ? String(draft.boundaryPhiFloor)
                      : base.fdm?.boundaryPhiFloor ?? "",
                  commonCells: draft.fdmCommonCells,
                  commonCellsXy: draft.fdmCommonCellsXy,
                  defaultCell: draft.fdmDefaultCell,
                  demagExplain: draft.fdmDemagExplain,
                  demagMode: draft.fdmDemagMode,
                  demagStrategy: draft.fdmDemagStrategy,
                  perMagnet: draft.fdmPerMagnet,
                },
              }
            : {}),
          externalField: draft.externalFieldTesla.join(", "),
          requestedCpuThreads:
            draft.requestedDevice !== "gpu"
              ? draft.cpuThreadsText.trim()
              : base.requestedCpuThreads,
          parallelExecution: {
            ...base.parallelExecution,
            mode: draft.parallelMode,
            maxCpuPercent: String(draft.maxCpuPercent),
            maxMemoryPercent: String(draft.maxMemoryPercent),
            memoryReserveMiB: String(
              Math.max(0, Math.round(draft.memoryReserveBytes / (1024 * 1024))),
            ),
            maxWorkers:
              draft.parallelMode === "adaptive"
                ? String(draft.maxWorkers)
                : base.parallelExecution.maxWorkers,
            threadsPerWorker: String(draft.threadsPerWorker),
          },
          solver: {
            ...base.solver,
            integrator:
              draft.defaultIntegrator === "auto" ? "" : draft.defaultIntegrator,
            timestepMode: draft.defaultTimestepMode,
            fixDt:
              draft.defaultTimestepMode === "fixed"
                ? String(draft.defaultFixedDtS)
                : base.solver.fixDt,
            dtInitial:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultDtInitS)
                : base.solver.dtInitial,
            dtMin:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultDtMinS)
                : base.solver.dtMin,
            dtMax:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultDtMaxS)
                : base.solver.dtMax,
            maxErr:
              draft.defaultTimestepMode === "adaptive_max_error"
                ? String(draft.defaultMaxErr)
                : base.solver.maxErr,
            adaptiveTimestep:
              draft.defaultTimestepMode === "adaptive_advanced"
                ? {
                    atol: String(draft.defaultAtol),
                    rtol: String(draft.defaultRtol),
                    dtInitial: String(draft.defaultDtInitS),
                    dtMin: String(draft.defaultDtMinS),
                    dtMax: String(draft.defaultDtMaxS),
                    safety: String(draft.defaultSafety),
                    growthLimit: String(draft.defaultGrowthLimit),
                    shrinkLimit: String(draft.defaultShrinkLimit),
                    maxSpinRotation: draft.defaultMaxSpinRotation,
                    normTolerance: draft.defaultNormTolerance,
                  }
                : base.solver.adaptiveTimestep,
            demagInterval:
              draft.defaultDemagIntervalS > 0
                ? String(draft.defaultDemagIntervalS)
                : "",
            relaxAlgorithm: draft.defaultRelaxAlgorithm,
            torqueTolerance: String(draft.defaultTorqueToleranceApm),
            energyTolerance: String(draft.defaultEnergyToleranceJ),
            maxRelaxSteps: String(draft.defaultMaxRelaxSteps),
          },
          };
        });
}

export function createFallbackStudyExecutionBaseline(
  testSnapshot?: StudyExecutionTestSnapshot,
): StudyExecutionDraft {
    const cudaAvailable = testSnapshot?.cudaAvailable ?? true;
    const rawDev = testSnapshot?.requestedDevice ?? "auto";
    return {
      executionProfile: "direct",
      discretization: testSnapshot?.discretization ?? "fdm",
      requestedDevice: rawDev,
      precision: testSnapshot?.precision ?? "double",
      qualificationMode: testSnapshot?.qualificationMode ?? "strict",
      cpuThreadsText: "",
      parallelMode: "serial",
      maxWorkers: 4,
      threadsPerWorker: 1,
      maxCpuPercent: 90,
      maxMemoryPercent: 80,
      memoryReserveBytes: 1024 * 1024 * 1024,
      exchangeEnabled: true,
      demagEnabled: true,
      fdmDemagStrategy: "auto",
      fdmDemagMode: "auto",
      fdmDefaultCell: "",
      fdmPerMagnet: "",
      fdmCommonCells: "",
      fdmCommonCellsXy: "",
      fdmDemagExplain: true,
      fdmBoundaryCorrection: "engine_default",
      boundaryPhiFloor: 0.05,
      boundaryDeltaMinM: 1e-10,
      femDemagSolver: "auto",
      femDemagPolicyJson: "",
      externalFieldTesla: [0, 0, 0],
      defaultIntegrator: "auto",
      defaultTimestepMode: "auto",
      defaultFixedDtS: 1e-13,
      defaultDtInitS: 5e-14,
      defaultDtMinS: 1e-15,
      defaultDtMaxS: 1e-11,
      defaultMaxErr: 1e-5,
      defaultAtol: 1e-7,
      defaultRtol: 1e-5,
      defaultSafety: 0.9,
      defaultGrowthLimit: 2,
      defaultShrinkLimit: 0.2,
      defaultMaxSpinRotation: "",
      defaultNormTolerance: "",
      defaultDemagIntervalS: 0,
      defaultRelaxAlgorithm: "llg_overdamped",
      defaultTorqueToleranceApm: 100,
      defaultEnergyToleranceJ: 1e-20,
      defaultMaxRelaxSteps: 50000,
      advancedSolverJson: "{}",
      cudaAvailable,
      gpuName: cudaAvailable ? "NVIDIA CUDA GPU" : null,
      cpuThreadCap: 16,
      magneticObjectCount: testSnapshot?.magneticObjectCount ?? 1,
      hasChangeDeviceStage: false,
      executionProfileBound: false,
      requestedDiscretization: null,
      sessionDiscretization:
        testSnapshot?.sessionDiscretization !== undefined
          ? testSnapshot.sessionDiscretization
          : testSnapshot?.discretization === "fem"
            ? "fem"
            : "fdm",
    };
}

export function buildStudyDefaultSolverSection(): InspectorSectionSpec<StudyExecutionDraft> {
  return {
          id: "default-solver",
          title: "Default Time & Relax Solver",
          icon: Timer,
          modeTabId: "physics",
          defaultOpen: false,
          summary: (d) => `${d.defaultIntegrator.toUpperCase()} · ${d.defaultRelaxAlgorithm}`,
          rows: [
            {
              key: "defaultIntegrator",
              label: "Default time integrator",
              type: "select",
              options: [
                { value: "auto", label: "Engine default (RK23)" },
                { value: "rk23", label: "RK23 Bogacki–Shampine" },
                { value: "rk45", label: "RK45 Dormand–Prince" },
                { value: "heun", label: "Heun / RK2" },
              ],
            },
            {
              key: "defaultTimestepMode",
              label: "Default timestep mode",
              type: "segmented",
              structural: true,
              options: [
                { value: "auto", label: "Auto" },
                { value: "adaptive_max_error", label: "Adaptive" },
                { value: "adaptive_advanced", label: "atol/rtol" },
                { value: "fixed", label: "Fixed dt" },
              ],
            },
            {
              key: "defaultFixedDtS",
              label: "Default fixed timestep",
              symbol: "Δt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "fixed",
            },
            {
              key: "defaultDtInitS",
              label: "Initial timestep",
              symbol: (
                <>
                  Δt<sub>0</sub>
                </>
              ),
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "fs",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.defaultTimestepMode === "adaptive_max_error" ||
                d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultDtMinS",
              label: "Adaptive min dt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "fs",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.defaultTimestepMode === "adaptive_max_error" ||
                d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultDtMaxS",
              label: "Adaptive max dt",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
              minExclusive: true,
              showWhen: (d) =>
                d.defaultTimestepMode === "adaptive_max_error" ||
                d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultMaxErr",
              label: "Maximum embedded vector error",
              type: "number",
              min: 1e-12,
              max: 1e-1,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "adaptive_max_error",
            },
            {
              key: "defaultAtol",
              label: "Absolute tolerance (atol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultRtol",
              label: "Relative tolerance (rtol)",
              type: "number",
              min: 1e-15,
              max: 1e-2,
              scrub: "log",
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultSafety",
              label: "Safety factor",
              type: "number",
              min: 0.1,
              max: 1,
              step: 0.05,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultGrowthLimit",
              label: "Growth limit",
              type: "number",
              min: 1,
              max: 20,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultShrinkLimit",
              label: "Shrink limit",
              type: "number",
              min: 0.01,
              max: 1,
              step: 0.05,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultMaxSpinRotation",
              label: "Max spin rotation (optional)",
              type: "text",
              mono: true,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultNormTolerance",
              label: "Norm tolerance (optional)",
              type: "text",
              mono: true,
              showWhen: (d) => d.defaultTimestepMode === "adaptive_advanced",
            },
            {
              key: "defaultDemagIntervalS",
              label: "Demag update interval",
              type: "quantity",
              units: TIME_UNITS_SI,
              defaultDisplayUnit: "ps",
              min: 0,
            },
            {
              key: "defaultRelaxAlgorithm",
              label: "Default relax method",
              type: "select",
              options: [
                { value: "llg_overdamped", label: "Damped LLG" },
                { value: "projected_gradient_bb", label: "LLG Projected Gradient BB" },
                { value: "nonlinear_cg", label: "Nonlinear Conjugate Gradient" },
              ],
            },
            {
              key: "defaultTorqueToleranceApm",
              label: "Default max |m × B| stop",
              symbol: (
                <>
                  τ<sub>tol</sub>
                </>
              ),
              type: "quantity",
              units: TORQUE_APM_UNITS_SI,
              defaultDisplayUnit: "mT",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              key: "defaultEnergyToleranceJ",
              label: "Default energy tolerance",
              symbol: (
                <>
                  ε<sub>E</sub>
                </>
              ),
              type: "quantity",
              units: ENERGY_JOULE_UNITS_SI,
              defaultDisplayUnit: "J",
              min: 0,
              minExclusive: true,
              scrub: "log",
            },
            {
              key: "defaultMaxRelaxSteps",
              label: "Default max relax steps",
              type: "number",
              integer: true,
              min: 1,
            },
          ],
        };
}
