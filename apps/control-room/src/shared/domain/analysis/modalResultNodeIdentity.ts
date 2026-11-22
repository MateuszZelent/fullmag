export function modalResultModeNodeId(
  runId: string,
  stageId: string,
  fieldId: string,
): string {
  return `results:run:${encodeURIComponent(runId)}:resonance:stage:${encodeURIComponent(stageId)}:modal_eigen:modes:eigen-mode:${encodeURIComponent(fieldId)}`;
}

export function modalSpectrumMatchesSelection(
  publication: { run_id?: string | null; stage_id?: string | null } | null,
  selection: { analysisRunId?: string; analysisStageId?: string } | null | undefined,
): boolean {
  return publication !== null &&
    (!selection?.analysisRunId || selection.analysisRunId === publication.run_id) &&
    (!selection?.analysisStageId || selection.analysisStageId === publication.stage_id);
}
