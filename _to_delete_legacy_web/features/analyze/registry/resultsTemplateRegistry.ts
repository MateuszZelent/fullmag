/**
 * Results Template Registry
 *
 * Maps ResultNodeKind → creation metadata, labels, and icon tokens.
 * Provides the same contribution-based pattern as stageTemplateRegistry,
 * but for the results/analyze subsystem.
 */

import type { ResultNodeKind } from "../model/resultsWorkspace";

// ── Public types ─────────────────────────────────────────────

export type ResultTemplateCategory =
  | "data"
  | "visualization"
  | "analysis"
  | "output";

export interface ResultTemplateEntry {
  /** Matches ResultNodeKind */
  kind: ResultNodeKind;
  /** Human-readable label shown in "Add Result" menu */
  label: string;
  /** Short description for the dialog */
  description: string;
  /** Icon token (from iconography/iconRegistry) */
  iconToken: string;
  /** Grouping category for the Add Result menu */
  category: ResultTemplateCategory;
  /** Whether a source dataset must be selected first */
  requiresDataset: boolean;
}

// ── Registry storage ─────────────────────────────────────────

const RESULT_TEMPLATE_MAP = new Map<ResultNodeKind, ResultTemplateEntry>();

export function registerResultTemplate(entry: ResultTemplateEntry): void {
  RESULT_TEMPLATE_MAP.set(entry.kind, entry);
}

export function getResultTemplate(kind: ResultNodeKind): ResultTemplateEntry | undefined {
  return RESULT_TEMPLATE_MAP.get(kind);
}

export function getAllResultTemplates(): ResultTemplateEntry[] {
  return Array.from(RESULT_TEMPLATE_MAP.values());
}

export function getResultTemplatesByCategory(
  category: ResultTemplateCategory,
): ResultTemplateEntry[] {
  return getAllResultTemplates().filter((t) => t.category === category);
}

export function resultLabel(kind: ResultNodeKind): string {
  return RESULT_TEMPLATE_MAP.get(kind)?.label ?? kind;
}

export function resultIconToken(kind: ResultNodeKind): string {
  return RESULT_TEMPLATE_MAP.get(kind)?.iconToken ?? "circle";
}

// ── Built-in entries ─────────────────────────────────────────

const BUILT_IN: ResultTemplateEntry[] = [
  {
    kind: "solution",
    label: "Solution",
    description: "Register a solution revision or imported solve result for lineage-aware results.",
    iconToken: "results.overview",
    category: "data",
    requiresDataset: false,
  },
  {
    kind: "dataset",
    label: "Dataset",
    description: "Import solution outputs from a completed study run.",
    iconToken: "results.dataset",
    category: "data",
    requiresDataset: false,
  },
  {
    kind: "derived_value",
    label: "Derived Value",
    description: "Create a quantity-driven scalar or summary metric bound to a dataset.",
    iconToken: "results.derived_scalars",
    category: "visualization",
    requiresDataset: true,
  },
  {
    kind: "plot_group",
    label: "Plot Group",
    description: "Create a group of related line, scatter, or heatmap plots.",
    iconToken: "results.plot_group",
    category: "visualization",
    requiresDataset: true,
  },
  {
    kind: "table",
    label: "Data Table",
    description: "Tabular view of selected quantities with sorting and filtering.",
    iconToken: "results.table",
    category: "visualization",
    requiresDataset: true,
  },
  {
    kind: "analysis",
    label: "Analysis Workspace",
    description: "Eigenmodes, vortex, FMR, or custom post-processing analysis.",
    iconToken: "results.analysis",
    category: "analysis",
    requiresDataset: true,
  },
  {
    kind: "export",
    label: "Export",
    description: "Export selected quantities to VTK, JSON, CSV, or HDF5.",
    iconToken: "results.export",
    category: "output",
    requiresDataset: true,
  },
  {
    kind: "report",
    label: "Report",
    description: "Aggregate plots, tables, and analyses into a summary report.",
    iconToken: "results.report",
    category: "output",
    requiresDataset: false,
  },
];

for (const entry of BUILT_IN) {
  registerResultTemplate(entry);
}
