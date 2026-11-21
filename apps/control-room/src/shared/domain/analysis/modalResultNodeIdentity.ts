export function modalResultModeNodeId(
  runId: string,
  stageId: string,
  fieldId: string,
): string {
  return `results:run:${encodeURIComponent(runId)}:resonance:stage:${encodeURIComponent(stageId)}:modal_eigen:modes:eigen-mode:${encodeURIComponent(fieldId)}`;
}
