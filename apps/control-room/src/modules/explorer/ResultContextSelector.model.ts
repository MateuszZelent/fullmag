export interface ResultContextOption {
  id: string;
  label: string;
}

export function resultContextOptions({
  currentRunId,
  knownRunIds,
}: {
  currentRunId: string | null;
  knownRunIds: readonly string[];
}): ResultContextOption[] {
  const seen = new Set<string>();
  const options: ResultContextOption[] = [];
  if (currentRunId) {
    seen.add(currentRunId);
    options.push({ id: currentRunId, label: `Current run · ${currentRunId}` });
  }
  for (const runId of knownRunIds) {
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    options.push({ id: runId, label: `Run · ${runId}` });
  }
  return options;
}
