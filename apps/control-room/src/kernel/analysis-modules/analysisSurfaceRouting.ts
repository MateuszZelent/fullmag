import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";

import type { AnalysisModuleId } from "./analysisModuleContract";
import { analysisNodeKindFor } from "./analysisNodeKindAliases";

/**
 * Transitional host for plan stage 3: until modules contribute their own views,
 * the selected Results node picks the existing Analysis surface of its owning
 * module, so Analysis follows the Explorer instead of its own tabs.
 */
const MODULE_SURFACES: Readonly<Partial<Record<AnalysisModuleId, AnalysisSurface>>> = {
  "analysis.dispersion": "dispersion",
  "analysis.resonance": "resonance-fmr",
  "analysis.time-domain": "dynamics",
};

const KERNEL_RESULT_SURFACES: Readonly<Record<string, AnalysisSurface>> = {
  "results.dynamics.root": "dynamics",
  "results.observation_frames.root": "dynamics",
  "results.observation_frame": "dynamics",
  "results.hysteresis.root": "hysteresis",
};

export function analysisModuleIdForNodeKind(kind: string): AnalysisModuleId | null {
  const analysisKind = analysisNodeKindFor(kind);
  if (!analysisKind) return null;
  const [, family] = analysisKind.split(".");
  return family ? (`analysis.${family}` as AnalysisModuleId) : null;
}

/** Analysis surface for a selected Explorer node, or null when the node does not drive Analysis. */
export function analysisSurfaceForSelectionKind(kind: string | null | undefined): AnalysisSurface | null {
  if (!kind) return null;
  const kernelSurface = KERNEL_RESULT_SURFACES[kind];
  if (kernelSurface) return kernelSurface;
  const moduleId = analysisModuleIdForNodeKind(kind);
  return moduleId ? MODULE_SURFACES[moduleId] ?? null : null;
}
