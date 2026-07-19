"use client";

import {
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "@/shared/ui/Button";
import { ScrollArea } from "@/shared/ui/ScrollArea";

import type { SimulationPreparationLogEntryView } from "./simulationPreparationModel";

interface ScrollMetrics {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
}

export function isPreparationLogAtBottom(
  element: Pick<ScrollMetrics, "clientHeight" | "scrollHeight" | "scrollTop">,
  tolerancePx = 4,
): boolean {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <= tolerancePx
  );
}

export function followPreparationLogTail(
  element: Pick<ScrollMetrics, "scrollHeight" | "scrollTop">,
  shouldFollow: boolean,
): void {
  if (shouldFollow) {
    element.scrollTop = element.scrollHeight;
  }
}

function preparationLogViewport(
  root: HTMLDivElement | null,
): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>(".fm-scroll-area__viewport") ?? null;
}

export function SimulationPreparationLog({
  entries,
}: {
  entries: readonly SimulationPreparationLogEntryView[];
}) {
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const followingTailRef = useRef(true);
  const [isFollowingTail, setIsFollowingTail] = useState(true);

  useEffect(() => {
    const viewport = preparationLogViewport(scrollAreaRef.current);
    if (!viewport) return;

    const handleScroll = () => {
      const next = isPreparationLogAtBottom(viewport);
      followingTailRef.current = next;
      setIsFollowingTail(next);
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const viewport = preparationLogViewport(scrollAreaRef.current);
    if (!viewport) return;
    followPreparationLogTail(viewport, followingTailRef.current);
  }, [entries]);

  const returnToTail = useCallback(() => {
    const viewport = preparationLogViewport(scrollAreaRef.current);
    if (!viewport) return;
    followPreparationLogTail(viewport, true);
    followingTailRef.current = true;
    setIsFollowingTail(true);
  }, []);

  return (
    <SimulationPreparationLogView
      entries={entries}
      isFollowingTail={isFollowingTail}
      scrollAreaRef={scrollAreaRef}
      onReturnToTail={returnToTail}
    />
  );
}

export function SimulationPreparationLogView({
  entries,
  isFollowingTail,
  scrollAreaRef,
  onReturnToTail,
}: {
  entries: readonly SimulationPreparationLogEntryView[];
  isFollowingTail: boolean;
  scrollAreaRef: Ref<HTMLDivElement>;
  onReturnToTail: () => void;
}) {
  return (
    <section
      aria-labelledby="fm-simulation-preparation-log-title"
      className="fm-simulation-startup__log"
    >
      <div className="fm-simulation-startup__section-header">
        <h3 id="fm-simulation-preparation-log-title">Preparation log</h3>
        {!isFollowingTail && entries.length > 0 ? (
          <Button
            aria-label="Return to live log tail"
            onClick={onReturnToTail}
            size="sm"
            type="button"
            variant="secondary"
          >
            New entries
          </Button>
        ) : null}
      </div>
      <ScrollArea
        ref={scrollAreaRef}
        aria-label="Recent simulation preparation log entries"
        className="fm-simulation-startup__log-scroll"
      >
        <div
          aria-live="off"
          className="fm-simulation-startup__log-entries"
          role="log"
        >
          {entries.length > 0 ? (
            entries.map((entry) => (
              <div
                className="fm-simulation-startup__log-entry"
                data-level={entry.level}
                key={preparationLogEntryKey(entry)}
              >
                <time>{entry.timestampLabel}</time>
                <span className="fm-simulation-startup__log-level">
                  {entry.level}
                </span>
                <span className="fm-simulation-startup__log-stage">
                  {entry.stageLabel}
                </span>
                <span className="fm-simulation-startup__log-message">
                  {entry.message}
                </span>
              </div>
            ))
          ) : (
            <p className="fm-simulation-startup__empty-log">
              Waiting for preparation log entries.
            </p>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

function preparationLogEntryKey(
  entry: SimulationPreparationLogEntryView,
): string {
  return [
    entry.timestampLabel,
    entry.level,
    entry.stageLabel,
    entry.message,
  ].join(":");
}
