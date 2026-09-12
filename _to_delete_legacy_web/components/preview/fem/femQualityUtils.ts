/**
 * Utility helpers for FEM mesh quality display.
 * Extracted from FemMeshView3D.tsx so they can be reused by
 * FemPartExplorerPanel and other sub-components.
 */

import type { MeshQualityStats } from "../../../lib/session/types";

export function qualityToneClass(stats: MeshQualityStats | null): string {
  if (!stats) {
    return "border-border/25 bg-background/45 text-muted-foreground";
  }
  if (stats.sicn_p5 >= 0.3 && stats.gamma_min >= 0.1) {
    return "border-emerald-400/25 bg-emerald-500/12 text-emerald-100";
  }
  if (stats.sicn_p5 >= 0.1 && stats.gamma_min >= 0.03) {
    return "border-amber-400/25 bg-amber-500/12 text-amber-100";
  }
  return "border-rose-400/25 bg-rose-500/12 text-rose-100";
}

export function qualityLabel(stats: MeshQualityStats | null): string {
  if (!stats) {
    return "No quality";
  }
  if (stats.sicn_p5 >= 0.3 && stats.gamma_min >= 0.1) {
    return "Good";
  }
  if (stats.sicn_p5 >= 0.1 && stats.gamma_min >= 0.03) {
    return "Fair";
  }
  return "Needs review";
}

export function combineMeshQualityStats(
  statsList: readonly MeshQualityStats[],
): MeshQualityStats | null {
  if (statsList.length === 0) {
    return null;
  }
  if (statsList.length === 1) {
    return statsList[0] ?? null;
  }
  const totalElements = statsList.reduce((sum, entry) => sum + Math.max(0, entry.n_elements), 0);
  const weight = (fn: (e: MeshQualityStats) => number) =>
    totalElements > 0
      ? statsList.reduce((sum, e) => sum + fn(e) * Math.max(0, e.n_elements), 0) / totalElements
      : statsList.reduce((sum, e) => sum + fn(e), 0) / statsList.length;
  const combineHistogram = (
    extractor: (e: MeshQualityStats) => number[] | undefined,
  ): number[] | undefined => {
    const base = extractor(statsList[0]);
    if (!base || base.length === 0) return undefined;
    if (!statsList.every((e) => (extractor(e)?.length ?? 0) === base.length)) return undefined;
    return base.map((_, i) => statsList.reduce((sum, e) => sum + (extractor(e)?.[i] ?? 0), 0));
  };
  return {
    n_elements: totalElements,
    sicn_min: Math.min(...statsList.map((e) => e.sicn_min)),
    sicn_max: Math.max(...statsList.map((e) => e.sicn_max)),
    sicn_mean: weight((e) => e.sicn_mean),
    sicn_p5: Math.min(...statsList.map((e) => e.sicn_p5)),
    sicn_histogram: combineHistogram((e) => e.sicn_histogram),
    gamma_min: Math.min(...statsList.map((e) => e.gamma_min)),
    gamma_mean: weight((e) => e.gamma_mean),
    gamma_histogram: combineHistogram((e) => e.gamma_histogram),
    volume_min: Math.min(...statsList.map((e) => e.volume_min)),
    volume_max: Math.max(...statsList.map((e) => e.volume_max)),
    volume_mean: weight((e) => e.volume_mean),
    volume_std: weight((e) => e.volume_std),
    avg_quality: weight((e) => e.avg_quality),
  };
}
