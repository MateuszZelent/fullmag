import type { StudyPipelineDiagnostic, StudyPipelineDocument } from "./types";

function flattenEnabledNodeKinds(document: StudyPipelineDocument): Array<{ kind: string; nodeId: string }> {
  const result: Array<{ kind: string; nodeId: string }> = [];
  const walk = (nodes: StudyPipelineDocument["nodes"]) => {
    for (const node of nodes) {
      if (!node.enabled) continue;
      if (node.node_kind === "primitive") {
        result.push({ kind: node.stage_kind, nodeId: node.id });
        continue;
      }
      if (node.node_kind === "macro") {
        result.push({ kind: node.macro_kind, nodeId: node.id });
        continue;
      }
      walk(node.children);
    }
  };
  walk(document.nodes);
  return result;
}

function collectNodeIds(document: StudyPipelineDocument): string[] {
  const ids: string[] = [];
  const walk = (nodes: StudyPipelineDocument["nodes"]) => {
    for (const node of nodes) {
      ids.push(node.id);
      if (node.node_kind === "group") {
        walk(node.children);
      }
    }
  };
  walk(document.nodes);
  return ids;
}

export function validateStudyPipeline(
  document: StudyPipelineDocument,
): StudyPipelineDiagnostic[] {
  const diagnostics: StudyPipelineDiagnostic[] = [];

  if (document.nodes.length === 0) {
    diagnostics.push({
      id: "pipeline-empty",
      severity: "warning",
      nodeId: null,
      message: "Study pipeline is empty.",
      suggestion: "Add a relax or run stage.",
    });
    return diagnostics;
  }

  const ids = collectNodeIds(document);
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    diagnostics.push({
      id: "duplicate-node-id",
      severity: "error",
      nodeId: duplicateIds[0] ?? null,
      message: "Duplicate pipeline node IDs detected.",
      suggestion: "Recreate duplicated nodes to ensure stable execution mapping.",
    });
  }

  const enabled = flattenEnabledNodeKinds(document);
  if (enabled.length === 0) {
    diagnostics.push({
      id: "pipeline-all-disabled",
      severity: "warning",
      nodeId: null,
      message: "All pipeline nodes are disabled.",
      suggestion: "Enable at least one stage before running study.",
    });
    return diagnostics;
  }

  const firstEigenIndex = enabled.findIndex((entry) =>
    entry.kind === "eigenmodes" || entry.kind === "relax_eigenmodes",
  );
  const hasRelaxBeforeEigen =
    firstEigenIndex <= 0
      ? false
      : enabled.slice(0, firstEigenIndex).some((entry) =>
          entry.kind === "relax" ||
          entry.kind === "relax_run" ||
          entry.kind === "relax_eigenmodes" ||
          entry.kind === "field_sweep_relax" ||
          entry.kind === "field_sweep_relax_snapshot" ||
          entry.kind === "parameter_sweep" ||
          entry.kind === "hysteresis_loop",
        );

  if (firstEigenIndex >= 0 && !hasRelaxBeforeEigen) {
    diagnostics.push({
      id: "eigen-without-relax",
      severity: "warning",
      nodeId: enabled[firstEigenIndex]?.nodeId ?? null,
      message: "Eigenmodes stage found without a prior relax stage.",
      suggestion: "Insert a relax stage before eigenmodes.",
    });
  }

  for (const entry of enabled) {
    if (
      entry.kind !== "hysteresis_loop"
      && entry.kind !== "field_sweep_relax_snapshot"
      && entry.kind !== "parameter_sweep"
    ) continue;
    const message =
      entry.kind === "hysteresis_loop"
        ? "Hysteresis macro will materialize into repeated settle-relax steps (plus optional save-state actions)."
        : "Composite macro will materialize into repeated run/relax/save execution steps.";
    diagnostics.push({
      id: `macro-preview-${entry.nodeId}`,
      severity: "info",
      nodeId: entry.nodeId,
      message,
      suggestion: "Open Materialized Preview to inspect the generated backend stage sequence.",
    });
  }

  return diagnostics;
}
