import type { ScriptBuilderStageState } from "@/lib/session/types";
import type { PrimitiveStageNode, StudyPipelineDocument } from "./types";

function inferPrimitiveKind(stage: ScriptBuilderStageState): PrimitiveStageNode["stage_kind"] {
  const entrypoint = String(stage.entrypoint_kind ?? "").toLowerCase();
  const kind = String(stage.kind ?? "").toLowerCase();
  if (entrypoint.includes("relax") || kind.includes("relax")) return "relax";
  if (entrypoint.includes("eigen") || kind.includes("eigen")) return "eigenmodes";
  if (entrypoint.includes("run") || kind.includes("run")) return "run";
  return "run";
}

function importedStageLabel(stage: ScriptBuilderStageState, index: number): string {
  const kind = inferPrimitiveKind(stage);
  const title = kind.charAt(0).toUpperCase() + kind.slice(1);
  return `Stage ${index + 1} - ${title}`;
}

function primitiveNodeFromStage(stage: ScriptBuilderStageState, index: number): PrimitiveStageNode {
  return {
    id: `stage_${index + 1}_${stage.kind}`,
    label: importedStageLabel(stage, index),
    enabled: true,
    source: "script_imported",
    node_kind: "primitive",
    stage_kind: inferPrimitiveKind(stage),
    payload: { ...stage },
  };
}

export function migrateFlatStagesToStudyPipeline(
  stages: ScriptBuilderStageState[],
): StudyPipelineDocument {
  return {
    version: "study_pipeline.v1",
    nodes: stages.map(primitiveNodeFromStage),
  };
}
