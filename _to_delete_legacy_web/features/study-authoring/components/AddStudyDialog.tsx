/**
 * AddStudyDialog — registry-driven "New Study" dialog.
 *
 * Presents study templates grouped by category (Basic, Composite, Sweep, Analysis).
 * On selection, dispatches a study creation command with default pipeline nodes.
 *
 * Uses the stageTemplateRegistry to construct default stage sequences,
 * keeping the UI decoupled from concrete study kinds.
 */

"use client";

import { memo, useState, useMemo, useCallback } from "react";
import {
  getStageTemplatesByCategory,
  type StageTemplateEntry,
  type StageCategory,
} from "../registry/stageTemplateRegistry";

// ── Study template descriptor ────────────────────────────────

export type StudyTemplateKind =
  | "relaxation"
  | "time_evolution"
  | "eigenmodes"
  | "frequency_response"
  | "field_sweep"
  | "current_sweep"
  | "hysteresis"
  | "parameter_sweep"
  | "composite";

export interface StudyTemplate {
  kind: StudyTemplateKind;
  label: string;
  description: string;
  category: "basic" | "composite" | "sweep" | "analysis";
  /** Stage kinds auto-added when this study is created. */
  defaultStageKinds: string[];
  iconToken: string;
}

const STUDY_TEMPLATES: StudyTemplate[] = [
  {
    kind: "relaxation",
    label: "Relaxation Study",
    description: "Relax magnetization to equilibrium state.",
    category: "basic",
    defaultStageKinds: ["relax"],
    iconToken: "circle-dot",
  },
  {
    kind: "time_evolution",
    label: "Time Evolution Study",
    description: "Run time-domain simulation with configured excitation.",
    category: "basic",
    defaultStageKinds: ["relax", "run"],
    iconToken: "play",
  },
  {
    kind: "eigenmodes",
    label: "Eigenfrequency Study",
    description: "Relax, then compute eigenmodes of the linearised LLG.",
    category: "analysis",
    defaultStageKinds: ["relax", "eigenmodes"],
    iconToken: "audio-waveform",
  },
  {
    kind: "frequency_response",
    label: "Frequency Response Study",
    description: "DC bias + RF probe for FMR/impedance analysis.",
    category: "analysis",
    defaultStageKinds: ["dc_bias_plus_rf_probe"],
    iconToken: "radio",
  },
  {
    kind: "field_sweep",
    label: "Field Sweep Study",
    description: "Sweep external field through multiple values with relaxation at each step.",
    category: "sweep",
    defaultStageKinds: ["field_sweep_relax"],
    iconToken: "flask-conical",
  },
  {
    kind: "current_sweep",
    label: "Current Sweep Study",
    description: "Sweep current amplitude and run dynamics at each value.",
    category: "sweep",
    defaultStageKinds: ["current_sweep_run"],
    iconToken: "flask-conical",
  },
  {
    kind: "hysteresis",
    label: "Hysteresis Study",
    description: "Full hysteresis loop with field ramping and relaxation.",
    category: "sweep",
    defaultStageKinds: ["hysteresis_loop"],
    iconToken: "flask-conical",
  },
  {
    kind: "parameter_sweep",
    label: "Parameter Sweep Study",
    description: "Sweep any parameter (damping, exchange, thickness, etc.).",
    category: "sweep",
    defaultStageKinds: ["parameter_sweep"],
    iconToken: "flask-conical",
  },
  {
    kind: "composite",
    label: "Custom Composite Study",
    description: "Start with an empty pipeline and add stages manually.",
    category: "composite",
    defaultStageKinds: [],
    iconToken: "puzzle",
  },
];

// ── Component types ──────────────────────────────────────────

export interface AddStudyDialogProps {
  open: boolean;
  onClose: () => void;
  onCreateStudy: (template: StudyTemplate) => void;
}

// ── Categories ───────────────────────────────────────────────

const CATEGORY_LABELS: Record<StudyTemplate["category"], string> = {
  basic: "Basic",
  analysis: "Analysis",
  sweep: "Sweep",
  composite: "Custom",
};

const CATEGORY_ORDER: StudyTemplate["category"][] = ["basic", "analysis", "sweep", "composite"];

// ── Component ────────────────────────────────────────────────

export const AddStudyDialog = memo(function AddStudyDialog({
  open,
  onClose,
  onCreateStudy,
}: AddStudyDialogProps) {
  const [selectedKind, setSelectedKind] = useState<StudyTemplateKind | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, StudyTemplate[]>();
    for (const t of STUDY_TEMPLATES) {
      const arr = map.get(t.category) ?? [];
      arr.push(t);
      map.set(t.category, arr);
    }
    return map;
  }, []);

  const selectedTemplate = useMemo(
    () => STUDY_TEMPLATES.find((t) => t.kind === selectedKind) ?? null,
    [selectedKind],
  );

  const handleCreate = useCallback(() => {
    if (!selectedTemplate) return;
    onCreateStudy(selectedTemplate);
    onClose();
  }, [selectedTemplate, onCreateStudy, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[560px] max-h-[80vh] rounded-xl border border-border bg-popover shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">Add Study</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Select a study template. Stages will be auto-populated with defaults.
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {CATEGORY_ORDER.map((cat) => {
            const templates = grouped.get(cat);
            if (!templates?.length) return null;
            return (
              <div key={cat}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  {CATEGORY_LABELS[cat]}
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {templates.map((t) => (
                    <button
                      key={t.kind}
                      type="button"
                      className={`text-left rounded-lg border p-3 transition-colors ${
                        selectedKind === t.kind
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-accent/50"
                      }`}
                      onClick={() => setSelectedKind(t.kind)}
                    >
                      <div className="text-sm font-medium text-foreground">{t.label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{t.description}</div>
                      {t.defaultStageKinds.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {t.defaultStageKinds.map((sk) => (
                            <span
                              key={sk}
                              className="text-[10px] px-1.5 py-0.5 rounded-sm bg-muted text-muted-foreground"
                            >
                              {sk}
                            </span>
                          ))}
                        </div>
                      )}
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
            disabled={!selectedTemplate}
            onClick={handleCreate}
          >
            Create Study
          </button>
        </div>
      </div>
    </div>
  );
});

export { STUDY_TEMPLATES };
export type { StudyTemplate as StudyTemplateDescriptor };
