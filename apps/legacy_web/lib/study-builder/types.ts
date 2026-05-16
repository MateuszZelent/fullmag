import type { ScriptBuilderStageState } from "@/lib/session/types";

export type StudyPrimitiveStageKind =
  | "relax"
  | "run"
  | "eigenmodes"
  | "set_field"
  | "set_current"
  | "save_state"
  | "load_state"
  | "export";

export type StudyMacroStageKind =
  | "hysteresis_loop"
  | "field_sweep_relax"
  | "field_sweep_relax_snapshot"
  | "relax_run"
  | "relax_eigenmodes"
  | "parameter_sweep"
  | "current_sweep_run"
  | "dc_bias_plus_rf_probe";

interface StudyPipelineNodeBase {
  id: string;
  label: string;
  enabled: boolean;
  notes?: string | null;
  source?: "ui_authored" | "script_imported" | "macro_generated";
}

export interface PrimitiveStageNode extends StudyPipelineNodeBase {
  node_kind: "primitive";
  stage_kind: StudyPrimitiveStageKind;
  payload: Record<string, unknown>;
}

export interface MacroStageNode extends StudyPipelineNodeBase {
  node_kind: "macro";
  macro_kind: StudyMacroStageKind;
  config: Record<string, unknown>;
}

export interface StageGroupNode extends StudyPipelineNodeBase {
  node_kind: "group";
  collapsed: boolean;
  children: StudyPipelineNode[];
}

export type StudyPipelineNode = PrimitiveStageNode | MacroStageNode | StageGroupNode;

export interface StudyPipelineDocument {
  version: "study_pipeline.v1";
  nodes: StudyPipelineNode[];
}

export interface MaterializedStageMapEntry {
  nodeId: string;
  nodeLabel: string;
  stageIndexes: number[];
  childEntries?: MaterializedStageMapEntry[];
}

export interface StudyPipelineDiagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  nodeId: string | null;
  message: string;
  suggestion?: string | null;
}

export interface MaterializedStudyPipeline {
  stages: ScriptBuilderStageState[];
  map: MaterializedStageMapEntry[];
  diagnostics: StudyPipelineDiagnostic[];
}
