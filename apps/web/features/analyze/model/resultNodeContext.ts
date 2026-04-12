/**
 * Results node-context resolver.
 *
 * Maps `res-*` string node IDs to typed `ResultNodeContext` objects,
 * analogous to `parseStudyNodeContext` for study nodes.
 * This provides the bridge between legacy tree-node IDs and the
 * first-class ResultsWorkspaceState model.
 *
 * When possible, delegates to `resolveNodeHandle` from the model-builder
 * registry to resolve by NodeKind before falling back to legacy res-* prefixes.
 */

import { resolveNodeHandle, isNodeKindInDomain } from "@/features/model-builder/registry/nodeHandleResolver";
import type { NodeKind } from "@/features/model-builder/types";

// ── Context types ────────────────────────────────────────────

export type ResultNodeContext =
  | { kind: "results-root" }
  | { kind: "results-overview" }
  | { kind: "results-datasets" }
  | { kind: "results-dataset"; datasetId: string }
  | { kind: "results-dataset-solution"; datasetId: string; solutionId: string }
  | { kind: "results-fields" }
  | { kind: "results-field-quantity"; quantityId: string }
  | { kind: "results-derived-scalars" }
  | { kind: "results-state-io" }
  | { kind: "results-export" }
  | { kind: "results-analyses" }
  | { kind: "results-analysis"; analysisId: string }
  | { kind: "results-eigenmodes" }
  | { kind: "results-eigenmodes-spectrum" }
  | { kind: "results-eigenmodes-dispersion" }
  | { kind: "results-eigenmode"; modeIndex: number }
  | { kind: "results-vortex" }
  | { kind: "results-vortex-trajectory" }
  | { kind: "results-vortex-frequency" }
  | { kind: "results-vortex-orbit" }
  | { kind: "results-time-traces" }
  | { kind: "results-time-trace"; channel: string }
  | { kind: "results-plot-group"; plotGroupId: string }
  | { kind: "results-table"; tableId: string }
  | { kind: "results-report"; reportId: string };

// ── Resolver ─────────────────────────────────────────────────

export function parseResultNodeContext(
  nodeId: string | null | undefined,
): ResultNodeContext | null {
  if (!nodeId) return null;
  if (!nodeId.startsWith("res-") && nodeId !== "results") return null;

  // Root
  if (nodeId === "results") return { kind: "results-root" };
  if (nodeId === "res-overview") return { kind: "results-overview" };

  // Datasets
  if (nodeId === "res-datasets") return { kind: "results-datasets" };
  const datasetMatch = nodeId.match(/^res-dataset-solution-(.+)$/);
  if (datasetMatch) {
    return { kind: "results-dataset-solution", datasetId: "study-1", solutionId: datasetMatch[1] ?? "" };
  }
  if (nodeId.startsWith("res-dataset-")) {
    const suffix = nodeId.replace("res-dataset-", "");
    return { kind: "results-dataset", datasetId: suffix };
  }

  // Fields
  if (nodeId === "res-fields") return { kind: "results-fields" };
  if (nodeId.startsWith("res-qty-")) {
    return { kind: "results-field-quantity", quantityId: decodeURIComponent(nodeId.replace("res-qty-", "")) };
  }
  if (nodeId === "res-energy") return { kind: "results-derived-scalars" };

  // State I/O & Export
  if (nodeId === "res-state-io") return { kind: "results-state-io" };
  if (nodeId === "res-export") return { kind: "results-export" };

  // Analyses
  if (nodeId === "res-analyses") return { kind: "results-analyses" };
  if (nodeId === "res-analyses-pinned" || nodeId === "res-analyses-auto") {
    return { kind: "results-analyses" };
  }
  if (nodeId.startsWith("res-analysis-")) {
    return { kind: "results-analysis", analysisId: nodeId.replace("res-analysis-", "") };
  }

  // Eigenmodes
  if (nodeId === "res-eigenmodes") return { kind: "results-eigenmodes" };
  if (nodeId === "res-eigenmodes-spectrum") return { kind: "results-eigenmodes-spectrum" };
  if (nodeId === "res-eigenmodes-dispersion") return { kind: "results-eigenmodes-dispersion" };
  const eigenMatch = nodeId.match(/^res-eigenmode-(\d+)$/);
  if (eigenMatch) {
    return { kind: "results-eigenmode", modeIndex: Number(eigenMatch[1]) };
  }

  // Vortex / STNO
  if (nodeId === "res-vortex") return { kind: "results-vortex" };
  if (nodeId === "res-vortex-trajectory") return { kind: "results-vortex-trajectory" };
  if (nodeId === "res-vortex-frequency") return { kind: "results-vortex-frequency" };
  if (nodeId === "res-vortex-orbit") return { kind: "results-vortex-orbit" };

  // Time traces
  if (nodeId === "res-time-traces") return { kind: "results-time-traces" };
  if (nodeId.startsWith("res-time-trace-")) {
    return { kind: "results-time-trace", channel: nodeId.replace("res-time-trace-", "") };
  }

  // Plot groups, tables, reports (future typed nodes)
  if (nodeId.startsWith("res-plot-group-")) {
    return { kind: "results-plot-group", plotGroupId: nodeId.replace("res-plot-group-", "") };
  }
  if (nodeId.startsWith("res-table-")) {
    return { kind: "results-table", tableId: nodeId.replace("res-table-", "") };
  }
  if (nodeId.startsWith("res-report-")) {
    return { kind: "results-report", reportId: nodeId.replace("res-report-", "") };
  }

  // Fallback for any other res- prefix
  return { kind: "results-root" };
}

/** Check whether a node ID belongs to the results domain. */
export function isResultNodeId(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  // Prefer registry-based check
  const handle = resolveNodeHandle(nodeId);
  if (isNodeKindInDomain(handle.nodeKind, "results")) return true;
  // Legacy fallback
  return parseResultNodeContext(nodeId) !== null;
}

/** Map a ResultNodeContext back to its NodeKind for registry lookups. */
export function resultContextToNodeKind(ctx: ResultNodeContext): string {
  switch (ctx.kind) {
    case "results-root": return "results.root";
    case "results-overview": return "results.root";
    case "results-datasets": return "results.dataset";
    case "results-dataset": return "results.dataset";
    case "results-dataset-solution": return "results.dataset";
    case "results-fields": return "results.fields";
    case "results-field-quantity": return "results.field_quantity";
    case "results-derived-scalars": return "results.derived_scalars";
    case "results-state-io": return "results.state_io";
    case "results-export": return "results.export";
    case "results-analyses": return "results.analysis";
    case "results-analysis": return "results.analysis";
    case "results-eigenmodes": return "results.eigenmodes";
    case "results-eigenmodes-spectrum": return "results.eigen_spectrum";
    case "results-eigenmodes-dispersion": return "results.eigen_dispersion";
    case "results-eigenmode": return "results.eigenmode";
    case "results-vortex": return "results.root";
    case "results-vortex-trajectory": return "results.time_trace";
    case "results-vortex-frequency": return "results.eigen_spectrum";
    case "results-vortex-orbit": return "results.time_trace";
    case "results-time-traces": return "results.time_trace";
    case "results-time-trace": return "results.time_trace";
    case "results-plot-group": return "results.plot_group";
    case "results-table": return "results.table";
    case "results-report": return "results.report";
  }
}
