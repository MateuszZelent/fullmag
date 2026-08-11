"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

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

export function ResultContextSelector({
  currentRunId,
  knownRunIds,
  onChange,
  selectedRunId,
}: {
  currentRunId: string | null;
  knownRunIds: readonly string[];
  onChange: (runId: string) => void;
  selectedRunId: string | null;
}) {
  const options = resultContextOptions({ currentRunId, knownRunIds });
  if (options.length === 0) {
    return (
      <section className="fm-result-context fm-result-context--unavailable" aria-label="Result context">
        <span className="fm-result-context__label">Result context unavailable</span>
        <span className="fm-result-context__reason">Run catalog is not published</span>
      </section>
    );
  }

  const resolvedValue = options.some((option) => option.id === selectedRunId)
    ? selectedRunId
    : currentRunId ?? options[0]?.id;

  return (
    <section className="fm-result-context" aria-label="Result context">
      <span className="fm-result-context__label">Result context</span>
      <Select value={resolvedValue ?? undefined} onValueChange={onChange}>
        <SelectTrigger aria-label="Selected result run" className="fm-result-context__trigger" density="compact">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </section>
  );
}
