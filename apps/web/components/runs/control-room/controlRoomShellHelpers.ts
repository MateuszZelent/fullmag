import type { Dispatch, SetStateAction } from "react";
import type { Slice2DToolbarState } from "@/src/features/slice2d";
import type { ScriptBuilderCurrentModuleEntry } from "@/lib/session/types";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { parseStudyNodeContext } from "@/lib/study-builder/node-context";
import type { StudyPipelineDocument } from "@/lib/study-builder/types";
import type { ResultWorkspaceKind } from "@/features/analyze/model/analyzeTypes";

export type RibbonPreviewComponent = "3D" | "x" | "y" | "z" | "magnitude";
export type ResultAnalysisKind = ResultWorkspaceKind;

type WorkspaceLaunchIntent = {
  displayName?: string | null;
  entryPath?: string | null;
  resumeProjectId?: string | null;
} | null | undefined;

export function surfaceColorFieldFromRibbonComponent(
  component: RibbonPreviewComponent,
): "orientation" | "x" | "y" | "z" | "magnitude" {
  if (component === "x" || component === "y" || component === "z") {
    return component;
  }
  if (component === "3D") {
    return "orientation";
  }
  return "magnitude";
}

export function launchDisplayName(intent: WorkspaceLaunchIntent): string | null {
  if (!intent) return null;
  if (intent.displayName) return intent.displayName;
  if (intent.entryPath) {
    const parts = intent.entryPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? intent.entryPath;
  }
  return intent.resumeProjectId ?? null;
}

function nextAntennaName(
  prefix: string,
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): string {
  let index = modules.length + 1;
  while (modules.some((module) => module.name === `${prefix}_${index}`)) {
    index += 1;
  }
  return `${prefix}_${index}`;
}

export function makeRibbonAntenna(
  kind: "MicrostripAntenna" | "CPWAntenna",
  modules: readonly ScriptBuilderCurrentModuleEntry[],
): ScriptBuilderCurrentModuleEntry {
  return {
    kind: "antenna_field_source",
    name: nextAntennaName(kind === "CPWAntenna" ? "cpw" : "microstrip", modules),
    solver: "mqs_2p5d_az",
    air_box_factor: 12,
    antenna_kind: kind,
    antenna_params:
      kind === "CPWAntenna"
        ? {
            signal_width: 1e-6,
            gap: 0.25e-6,
            ground_width: 1e-6,
            thickness: 100e-9,
            height_above_magnet: 200e-9,
            preview_length: 5e-6,
            center_x: 0,
            center_y: 0,
            current_distribution: "uniform",
          }
        : {
            width: 1e-6,
            thickness: 100e-9,
            height_above_magnet: 200e-9,
            preview_length: 5e-6,
            center_x: 0,
            center_y: 0,
            current_distribution: "uniform",
          },
    drive: {
      current_a: 0.01,
      frequency_hz: null,
      phase_rad: 0,
      waveform: null,
    },
  };
}

export function syncStudyRuntimeState(
  ctx: { setRunUntilInput: (v: string) => void; setSolverSettings: Dispatch<SetStateAction<any>> },
  stages: ReturnType<typeof materializeStudyPipeline>["stages"],
): void {
  const firstRun = stages.find((stage) => stage.kind === "run");
  const firstRelax = stages.find((stage) => stage.kind === "relax");
  if (firstRun?.until_seconds) {
    ctx.setRunUntilInput(firstRun.until_seconds);
  }
  if (firstRelax) {
    ctx.setSolverSettings((current: any) => ({
      ...current,
      integrator: firstRelax.integrator || current.integrator,
      fixedTimestep: firstRelax.fixed_timestep || current.fixedTimestep,
      relaxAlgorithm: firstRelax.relax_algorithm || current.relaxAlgorithm,
      torqueTolerance: firstRelax.torque_tolerance || current.torqueTolerance,
      energyTolerance: firstRelax.energy_tolerance || current.energyTolerance,
      maxRelaxSteps: firstRelax.max_steps || current.maxRelaxSteps,
    }));
  }
}

export function resolveStudyAnchorNodeId(
  document: StudyPipelineDocument,
  selectedNodeId: string | null,
): string | null {
  const studyNode = parseStudyNodeContext(selectedNodeId);
  if (studyNode?.kind !== "study-stage") {
    return null;
  }
  if (studyNode.source === "pipeline") {
    return studyNode.stageKey;
  }
  const flatIndex = Number(studyNode.stageKey);
  return Number.isFinite(flatIndex) ? document.nodes[flatIndex]?.id ?? null : null;
}

export function normalizeSliceComponent(
  component: string | null | undefined,
): Slice2DToolbarState["component"] {
  if (component === "x" || component === "y" || component === "z" || component === "magnitude") {
    return component;
  }
  return "magnitude";
}

export function buildResultWorkspaceEntryInput(
  kind: ResultAnalysisKind,
  opts: {
    now: number;
    quantityId: string;
    quantityLabel: string;
    quantityBadge: string | null;
  },
) {
  const { now, quantityId, quantityLabel, quantityBadge } = opts;
  if (kind === "spectrum") {
    return {
      key: `user:spectrum:${now}`,
      kind,
      label: "Eigen Spectrum",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "dispersion") {
    return {
      key: `user:dispersion:${now}`,
      kind,
      label: "Eigen Dispersion",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "modes") {
    return {
      key: `user:modes:${now}`,
      kind,
      label: "Mode Inspector",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "time-traces") {
    return {
      key: `user:vortex:time-traces:${now}`,
      kind,
      label: "Vortex Time Traces",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "vortex-frequency") {
    return {
      key: `user:vortex:frequency:${now}`,
      kind,
      label: "Vortex FFT / PSD",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "vortex-trajectory") {
    return {
      key: `user:vortex:trajectory:${now}`,
      kind,
      label: "Vortex Trajectory",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "vortex-orbit") {
    return {
      key: `user:vortex:orbit:${now}`,
      kind,
      label: "Vortex Orbit Amplitude",
      badge: "manual",
      openAfterCreate: true,
    };
  }
  if (kind === "table") {
    return {
      key: `user:table:${now}`,
      kind,
      label: "Results Table",
      badge: quantityLabel,
      openAfterCreate: true,
    };
  }
  return {
    key: `user:quantity:${quantityId}:${now}`,
    kind: "quantity" as const,
    label: quantityLabel,
    quantityId,
    badge: quantityBadge,
    openAfterCreate: true,
  };
}
