/**
 * Stage Template Registry
 *
 * Centralizes the mapping from stage kind → UI metadata, factory, and Python emit hint.
 * All places that need to create, label, or icon a stage go through this registry
 * instead of scattering hardcoded switch/case blocks.
 */

import type {
  StudyPrimitiveStageKind,
  StudyMacroStageKind,
  StudyPipelineNode,
} from "@/lib/study-builder/types";
import {
  createPrimitiveNode,
  createMacroNode,
} from "@/lib/study-builder/operations";

// ── Public types ─────────────────────────────────────────────

export type StageCategory = "primitive" | "macro" | "analysis" | "sweep";

export interface StageTemplateEntry {
  /** Unique kind key — either a primitive or macro kind string */
  kind: string;
  /** Human-readable label shown in "Add Stage" menu and pipeline canvas */
  label: string;
  /** Icon registry token (from iconography/iconRegistry) */
  iconToken: string;
  /** Grouping category for the Add Stage menu */
  category: StageCategory;
  /** Factory that creates a default pipeline node of this kind */
  create: () => StudyPipelineNode;
  /** Hint for canonical Python DSL emit */
  pythonEmitHint: string;
}

// ── Registry storage ─────────────────────────────────────────

const STAGE_TEMPLATE_MAP = new Map<string, StageTemplateEntry>();

export function registerStageTemplate(entry: StageTemplateEntry): void {
  STAGE_TEMPLATE_MAP.set(entry.kind, entry);
}

export function getStageTemplate(kind: string): StageTemplateEntry | undefined {
  return STAGE_TEMPLATE_MAP.get(kind);
}

export function getAllStageTemplates(): StageTemplateEntry[] {
  return Array.from(STAGE_TEMPLATE_MAP.values());
}

export function getStageTemplatesByCategory(category: StageCategory): StageTemplateEntry[] {
  return getAllStageTemplates().filter((t) => t.category === category);
}

export function stageLabel(kind: string): string {
  return STAGE_TEMPLATE_MAP.get(kind)?.label ?? kind;
}

export function stageIconToken(kind: string): string {
  return STAGE_TEMPLATE_MAP.get(kind)?.iconToken ?? "circle";
}

// ── Primitive stage templates ────────────────────────────────

const PRIMITIVES: Array<{
  kind: StudyPrimitiveStageKind;
  label: string;
  iconToken: string;
  category: StageCategory;
  pythonEmitHint: string;
}> = [
  { kind: "relax",      label: "Relax",       iconToken: "study.stage.relax",       category: "primitive", pythonEmitHint: "problem.relax()" },
  { kind: "run",        label: "Run",         iconToken: "study.stage.run",         category: "primitive", pythonEmitHint: "problem.run_until()" },
  { kind: "eigenmodes", label: "Eigenmodes",  iconToken: "study.stage.eigenmodes",  category: "primitive", pythonEmitHint: "problem.eigenmodes()" },
  { kind: "set_field",  label: "Set Field",   iconToken: "study.stage.set_field",   category: "primitive", pythonEmitHint: "problem.set_field()" },
  { kind: "set_current", label: "Set Current", iconToken: "study.stage.set_current", category: "primitive", pythonEmitHint: "problem.set_current()" },
  { kind: "save_state", label: "Save State",  iconToken: "study.stage.save_state",  category: "primitive", pythonEmitHint: "problem.save_state()" },
  { kind: "load_state", label: "Load State",  iconToken: "study.stage.load_state",  category: "primitive", pythonEmitHint: "problem.load_state()" },
  { kind: "export",     label: "Export",      iconToken: "study.stage.export",      category: "primitive", pythonEmitHint: "problem.export()" },
];

for (const p of PRIMITIVES) {
  registerStageTemplate({
    kind: p.kind,
    label: p.label,
    iconToken: p.iconToken,
    category: p.category,
    create: () => createPrimitiveNode(p.kind),
    pythonEmitHint: p.pythonEmitHint,
  });
}

// ── Macro stage templates ────────────────────────────────────

const MACROS: Array<{
  kind: StudyMacroStageKind;
  label: string;
  iconToken: string;
  category: StageCategory;
  pythonEmitHint: string;
}> = [
  { kind: "hysteresis_loop",            label: "Hysteresis Loop",            iconToken: "study.macro.hysteresis_loop",            category: "sweep",  pythonEmitHint: "study.hysteresis_loop()" },
  { kind: "field_sweep_relax",          label: "Field Sweep + Relax",       iconToken: "study.macro.field_sweep_relax",          category: "sweep",  pythonEmitHint: "study.field_sweep_relax()" },
  { kind: "field_sweep_relax_snapshot", label: "Field Sweep + Snapshot",    iconToken: "study.macro.field_sweep_relax_snapshot", category: "sweep",  pythonEmitHint: "study.field_sweep_relax_snapshot()" },
  { kind: "relax_run",                  label: "Relax → Run",               iconToken: "study.macro.relax_run",                  category: "macro",  pythonEmitHint: "study.relax_run()" },
  { kind: "relax_eigenmodes",           label: "Relax → Eigensolve",        iconToken: "study.macro.relax_eigenmodes",           category: "macro",  pythonEmitHint: "study.relax_eigenmodes()" },
  { kind: "parameter_sweep",            label: "Parameter Sweep",           iconToken: "study.macro.parameter_sweep",            category: "sweep",  pythonEmitHint: "study.parameter_sweep()" },
  { kind: "current_sweep_run",          label: "Current Sweep + Run",       iconToken: "study.macro.current_sweep_run",          category: "sweep",  pythonEmitHint: "study.current_sweep_run()" },
  { kind: "dc_bias_plus_rf_probe",      label: "DC Bias + RF Probe",        iconToken: "study.macro.dc_bias_plus_rf_probe",      category: "analysis", pythonEmitHint: "study.dc_bias_rf_probe()" },
];

for (const m of MACROS) {
  registerStageTemplate({
    kind: m.kind,
    label: m.label,
    iconToken: m.iconToken,
    category: m.category,
    create: () => createMacroNode(m.kind),
    pythonEmitHint: m.pythonEmitHint,
  });
}
