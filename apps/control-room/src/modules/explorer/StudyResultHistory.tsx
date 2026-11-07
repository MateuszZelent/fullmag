"use client";

import { useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import type { StudyStageResult } from "@/kernel/api/apiTypes";
import {
  studyResultCacheKey, studyResultCompletionLabel, studyResultDomainLabel, studyResultPredecessorLabel,
} from "@/kernel/api/studyResultPlayback";
import { useStudyStageResultsResource } from "@/kernel/resources/studyStageResultsResource";
import { useStudyResultScalarsResource } from "@/kernel/resources/studyResultPlaybackResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { useSavedResultsPlaybackSelection } from "@/kernel/saved-results/useSavedResultsPlayback";
import { Button } from "@/shared/ui/Button";

export function StudyResultHistory({ runId, onPreviewRun }: { runId?: string; onPreviewRun: (runId: string) => void }) {
  const { savedResultsPlayback } = useKernel();
  const selection = useSavedResultsPlaybackSelection();
  const selected = selection?.studyResult;
  const sceneRevision = useSessionStatusSelector(({ data }) => data?.resources.scene_revision ?? null);
  const [page, setPage] = useState<{ runId?: string; sceneRevision: number | null; cursors: string[] }>({
    runId, sceneRevision, cursors: [],
  });
  const cursors = page.runId === runId && page.sceneRevision === sceneRevision ? page.cursors : [];
  const results = useStudyStageResultsResource({ runId, cursor: cursors.at(-1), limit: 10, sceneRevision, enabled: true });
  const catalog = results.data?.scene_revision === sceneRevision ? results.data : null;
  const next = catalog?.next_cursor;
  return (
    <details className="max-h-64 overflow-auto border-b border-fm-border px-2 py-1" open={selected ? true : undefined}>
      <summary className="cursor-pointer">Saved Study results</summary>
      {results.status === "error" ? (
        <div role="status">
          {results.error?.message ?? "Saved Study results are unavailable."}
          <Button size="sm" variant="ghost" onClick={results.refetch}>Retry</Button>
        </div>
      ) : !catalog ? <p role="status">Loading saved Study results…</p>
        : catalog.results.length === 0 ? <p>No published final states.</p>
        : (
          <ul aria-label="Published Study final states" className="m-0 grid list-none gap-1 p-0">
            {catalog.results.map((result) => {
              const key = studyResultCacheKey(result);
              const active = selected ? studyResultCacheKey(selected) === key : false;
              const predecessor = studyResultPredecessorLabel(result);
              return (
                <li key={key}>
                  <Button size="sm" variant={active ? "secondary" : "ghost"} aria-pressed={active}
                    disabled={!savedResultsPlayback || !result.supports_magnetization_input}
                    onClick={() => {
                      savedResultsPlayback?.openStudyResult(result);
                      onPreviewRun(result.source.run_id);
                    }}>
                    {result.authored_stage_id ?? result.source.step_id} · {result.source.case_id} · {result.source.run_id}
                  </Button>
                  <span className="block px-2 text-xs">{studyResultCompletionLabel(result.completion)}</span>
                  <span className="block px-2 text-xs">{studyResultDomainLabel(result.domain_relation)}</span>
                  {predecessor ? <span className="block px-2 text-xs">{predecessor}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      {cursors.length || next ? (
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={!cursors.length}
            onClick={() => setPage({ runId, sceneRevision, cursors: cursors.slice(0, -1) })}>Newer</Button>
          <Button size="sm" variant="ghost" disabled={!next}
            onClick={() => { if (next) setPage({ runId, sceneRevision, cursors: [...cursors, next] }); }}>Older</Button>
        </div>
      ) : null}
      {selected ? <StudyResultScalarHistory key={studyResultCacheKey(selected)} result={selected} /> : null}
    </details>
  );
}

function StudyResultScalarHistory({ result }: { result: StudyStageResult }) {
  const [expanded, setExpanded] = useState(false);
  const [starts, setStarts] = useState<number[]>([0]);
  const resource = useStudyResultScalarsResource(expanded ? result : null, starts.at(-1) ?? 0);
  const window = resource.data;
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer">Archived scalar samples · {result.authored_stage_id ?? result.source.step_id}</summary>
      {expanded && resource.status === "error" ? (
        <div role="status">
          {resource.error?.message ?? "Archived scalar samples are unavailable."}
          <Button size="sm" variant="ghost" onClick={resource.refetch}>Retry</Button>
        </div>
      ) : expanded && !window ? <p role="status">Loading archived scalar samples…</p>
        : expanded && window ? (
          <>
            <p>{window.coverage === "terminal_sample" ? "Terminal sample" : `${window.total_rows} solver samples`}</p>
            <div className="max-h-48 overflow-auto">
              <table aria-label="Archived scalar values">
                <thead><tr>{window.columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
                <tbody>{window.rows.map((row, index) => (
                  <tr key={index}>{row.map((value, column) => <td key={column}>{value.toPrecision(7)}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={starts.length < 2}
                onClick={() => setStarts(starts.slice(0, -1))}>Previous samples</Button>
              <Button size="sm" variant="ghost" disabled={window.next_start == null}
                onClick={() => { if (window.next_start != null) setStarts([...starts, window.next_start]); }}>Next samples</Button>
            </div>
          </>
        ) : null}
    </details>
  );
}
