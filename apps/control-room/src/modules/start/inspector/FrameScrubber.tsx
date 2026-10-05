"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";

import {
  FRAMES_PAGE_SIZE,
  frameLabel,
  formatFrameTime,
  pageStartOf,
  type FrameEntry,
  type FramesPage,
  type FramesSummary,
} from "../model/framesModel";

export const FRAME_INDEX_NOTE =
  "Index of saved frames: the step and time of each snapshot the run wrote. No image is rendered per frame.";

export type FrameStep = "first" | "previous" | "next" | "last";

/** The position after a prev/next/first/last request, kept inside the index. */
export function stepPosition(position: number, total: number, step: FrameStep): number {
  if (total <= 0) return 0;
  const last = total - 1;
  switch (step) {
    case "first":
      return 0;
    case "last":
      return last;
    case "previous":
      return Math.max(0, Math.min(position, last) - 1);
    case "next":
      return Math.min(last, Math.max(position, 0) + 1);
  }
}

/** Why a page could not be used; null when it is a usable page of an index. */
export function pageProblem(page: FramesPage): string | null {
  return page.indexed ? null : "The backend lists no saved frames for this folder.";
}

export interface FrameScrubberProps {
  readonly itemId: string;
  readonly summary: FramesSummary;
  /** Reads one page of the index; rejects with a readable message on failure. */
  readonly loadPage: (id: string, from: number, limit: number) => Promise<FramesPage>;
  /** Stage names by id, for the stage line; falls back to the id. */
  readonly stageName?: (stageId: string) => string;
}

export function FrameScrubber({ itemId, summary, loadPage, stageName }: FrameScrubberProps) {
  const headingId = useId();
  const total = summary.count;
  const [position, setPosition] = useState(0);
  const [pages, setPages] = useState<Readonly<Record<number, readonly FrameEntry[]>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const start = pageStartOf(position);
  const cached = pages[start];

  useEffect(() => {
    if (total === 0 || cached) return;
    let alive = true;
    loadPage(itemId, start, FRAMES_PAGE_SIZE).then(
      (page) => {
        if (!alive) return;
        const failure = pageProblem(page);
        if (failure) {
          setProblem(failure);
          return;
        }
        setProblem(null);
        setPages((current) => ({ ...current, [start]: page.frames }));
      },
      (error: unknown) => {
        if (alive) setProblem(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      alive = false;
    };
  }, [cached, itemId, loadPage, start, total]);

  if (total === 0) {
    return (
      <section aria-labelledby={headingId} className="fm-start-frames">
        <h3 className="fm-start-kv__title" id={headingId}>
          Saved frames
        </h3>
        <p className="fm-start-inspector__note">The frame index lists no frames.</p>
      </section>
    );
  }

  const current = position < total ? position : total - 1;
  const frame = cached?.find((entry) => entry.index === current);
  const label = frameLabel(current, total, frame);
  const stage = frame?.stageId ? (stageName?.(frame.stageId) ?? frame.stageId) : undefined;
  const move = (step: FrameStep) => setPosition(stepPosition(current, total, step));

  return (
    <section aria-labelledby={headingId} className="fm-start-frames" data-frames={total}>
      <h3 className="fm-start-kv__title" id={headingId}>
        Saved frames
      </h3>
      <p className="fm-start-inspector__note">{FRAME_INDEX_NOTE}</p>
      <div className="fm-start-frames__controls">
        <button
          aria-label="Previous frame"
          className="fm-start-frames__step"
          disabled={current === 0}
          onClick={() => move("previous")}
          type="button"
        >
          <ChevronLeft aria-hidden="true" size={14} />
        </button>
        <input
          aria-label="Saved frame"
          aria-valuetext={label}
          className="fm-start-frames__slider"
          max={total - 1}
          min={0}
          onChange={(event) => setPosition(Number(event.currentTarget.value))}
          step={1}
          type="range"
          value={current}
        />
        <button
          aria-label="Next frame"
          className="fm-start-frames__step"
          disabled={current >= total - 1}
          onClick={() => move("next")}
          type="button"
        >
          <ChevronRight aria-hidden="true" size={14} />
        </button>
      </div>
      <p aria-live="polite" className="fm-start-frames__label">
        {label}
      </p>
      {frame ? (
        <p className="fm-start-frames__meta">
          {[
            stage ? `stage ${stage}` : null,
            frame.quantityIds.length > 0 ? frame.quantityIds.join(", ") : null,
            summary.lastTimeS !== undefined ? `last saved t = ${formatFrameTime(summary.lastTimeS)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {problem ? <p className="fm-start-inspector__note">Could not read the index: {problem}</p> : null}
      {summary.truncated ? (
        <p className="fm-start-inspector__note">The index reached its entry limit; later frames are not listed.</p>
      ) : null}
      {summary.note ? <p className="fm-start-inspector__note">{summary.note}</p> : null}
    </section>
  );
}
