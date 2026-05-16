/**
 * ResultsAuthoringShell — registry-driven "Add Result" dialog.
 *
 * Lists all available result templates from the resultsTemplateRegistry,
 * grouped by category (data, visualization, analysis, output).
 * On selection, dispatches a ResultsCommand to add the result node.
 */

"use client";

import { memo, useState, useMemo, useCallback } from "react";
import {
  getAllResultTemplates,
  getResultTemplatesByCategory,
  type ResultTemplateEntry,
  type ResultTemplateCategory,
} from "../registry/resultsTemplateRegistry";
import type { ResultNodeKind } from "../model/resultsWorkspace";

// ── Props ────────────────────────────────────────────────────

export interface ResultsAuthoringShellProps {
  open: boolean;
  onClose: () => void;
  /** Called when the user selects a result node kind to add. */
  onAddResult: (kind: ResultNodeKind, label: string) => void;
  /** Available dataset IDs — disables templates that require a dataset when empty. */
  availableDatasetIds: string[];
}

// ── Category metadata ────────────────────────────────────────

const CATEGORY_LABELS: Record<ResultTemplateCategory, string> = {
  data: "Data Sources",
  visualization: "Visualization",
  analysis: "Analysis",
  output: "Output & Reports",
};

const CATEGORY_ORDER: ResultTemplateCategory[] = [
  "data",
  "visualization",
  "analysis",
  "output",
];

// ── Component ────────────────────────────────────────────────

export const ResultsAuthoringShell = memo(function ResultsAuthoringShell({
  open,
  onClose,
  onAddResult,
  availableDatasetIds,
}: ResultsAuthoringShellProps) {
  const [selectedKind, setSelectedKind] = useState<ResultNodeKind | null>(null);
  const [customLabel, setCustomLabel] = useState("");

  const hasDatasets = availableDatasetIds.length > 0;

  const grouped = useMemo(() => {
    const map = new Map<ResultTemplateCategory, ResultTemplateEntry[]>();
    for (const cat of CATEGORY_ORDER) {
      map.set(cat, getResultTemplatesByCategory(cat));
    }
    return map;
  }, []);

  const selectedTemplate = useMemo(() => {
    if (!selectedKind) return null;
    return getAllResultTemplates().find((t) => t.kind === selectedKind) ?? null;
  }, [selectedKind]);

  const canCreate =
    selectedKind != null &&
    selectedTemplate != null &&
    (!selectedTemplate.requiresDataset || hasDatasets);

  const handleCreate = useCallback(() => {
    if (!selectedKind || !selectedTemplate) return;
    const label = customLabel.trim() || selectedTemplate.label;
    onAddResult(selectedKind, label);
    setSelectedKind(null);
    setCustomLabel("");
    onClose();
  }, [selectedKind, selectedTemplate, customLabel, onAddResult, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] max-h-[75vh] rounded-xl border border-border bg-popover shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Add Result</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Choose a result type to add to your analysis workspace.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {CATEGORY_ORDER.map((cat) => {
            const templates = grouped.get(cat);
            if (!templates?.length) return null;
            return (
              <div key={cat}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {CATEGORY_LABELS[cat]}
                </h3>
                <div className="space-y-1">
                  {templates.map((t) => {
                    const disabled = t.requiresDataset && !hasDatasets;
                    return (
                      <button
                        key={t.kind}
                        type="button"
                        disabled={disabled}
                        className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                          disabled
                            ? "border-border/50 opacity-50 cursor-not-allowed"
                            : selectedKind === t.kind
                              ? "border-primary bg-primary/10"
                              : "border-border hover:bg-accent/50"
                        }`}
                        onClick={() => {
                          if (!disabled) setSelectedKind(t.kind);
                        }}
                      >
                        <div className="text-sm font-medium text-foreground">
                          {t.label}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {t.description}
                          {disabled && " (requires at least one dataset)"}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Custom label input (shown when template is selected) */}
          {selectedTemplate && (
            <div className="pt-2">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="result-label">
                Custom Label (optional)
              </label>
              <input
                id="result-label"
                type="text"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                placeholder={selectedTemplate.label}
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-md border border-border text-muted-foreground hover:bg-accent"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
            disabled={!canCreate}
            onClick={handleCreate}
          >
            Add {selectedTemplate?.label ?? "Result"}
          </button>
        </div>
      </div>
    </div>
  );
});
