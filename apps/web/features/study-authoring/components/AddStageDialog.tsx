/**
 * AddStageDialog — registry-driven "Add Stage" dialog.
 *
 * Lists all available stage templates from the stageTemplateRegistry,
 * grouped by category (primitive, macro, sweep, analysis).
 * On selection, dispatches a pipeline command to add the stage.
 */

"use client";

import { memo, useState, useMemo, useCallback } from "react";
import {
  getAllStageTemplates,
  getStageTemplatesByCategory,
  type StageTemplateEntry,
  type StageCategory,
} from "../registry/stageTemplateRegistry";

// ── Props ────────────────────────────────────────────────────

export interface AddStageDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called when the user selects a stage template. */
  onAddStage: (templateKind: string) => void;
  /** Id of the stage after which the new stage will be inserted (or null for append). */
  anchorStageId?: string | null;
}

// ── Category metadata ────────────────────────────────────────

const CATEGORY_LABELS: Record<StageCategory, string> = {
  primitive: "Basic Stages",
  macro: "Composite Macros",
  sweep: "Sweep & Parametric",
  analysis: "Analysis",
};

const CATEGORY_ORDER: StageCategory[] = ["primitive", "macro", "sweep", "analysis"];

// ── Component ────────────────────────────────────────────────

export const AddStageDialog = memo(function AddStageDialog({
  open,
  onClose,
  onAddStage,
  anchorStageId,
}: AddStageDialogProps) {
  const [selectedKind, setSelectedKind] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<StageCategory, StageTemplateEntry[]>();
    for (const cat of CATEGORY_ORDER) {
      map.set(cat, getStageTemplatesByCategory(cat));
    }
    return map;
  }, []);

  const handleAdd = useCallback(() => {
    if (!selectedKind) return;
    onAddStage(selectedKind);
    setSelectedKind(null);
    onClose();
  }, [selectedKind, onAddStage, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[70vh] rounded-xl border border-border bg-popover shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Add Stage</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {anchorStageId
              ? "Insert a new stage after the selected stage."
              : "Append a new stage at the end of the pipeline."}
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
                  {templates.map((t) => (
                    <button
                      key={t.kind}
                      type="button"
                      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                        selectedKind === t.kind
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-accent/50"
                      }`}
                      onClick={() => setSelectedKind(t.kind)}
                    >
                      <div className="text-sm font-medium text-foreground">{t.label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {t.pythonEmitHint}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
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
            disabled={!selectedKind}
            onClick={handleAdd}
          >
            Add Stage
          </button>
        </div>
      </div>
    </div>
  );
});
