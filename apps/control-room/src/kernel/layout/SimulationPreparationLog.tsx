"use client";

import {
  type MutableRefObject,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { copyTextToClipboard } from "@/shared/browser/copyTextToClipboard";
import { cn } from "@/shared/utils/className";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { ScrollArea } from "@/shared/ui/ScrollArea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import type { SimulationPreparationLogEntryView } from "./simulationPreparationModel";

interface ScrollMetrics {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  scrollTop: number;
}

type PreparationLogLevelFilter = "all" | "errors" | "warnings";

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

function assignRef<T>(ref: Ref<T>, value: T | null): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
  } else {
    (ref as MutableRefObject<T | null>).current = value;
  }
}

function filterPreparationLogEntries(
  entries: readonly SimulationPreparationLogEntryView[],
  query: string,
  levelFilter: PreparationLogLevelFilter,
): SimulationPreparationLogEntryView[] {
  const normalizedQuery = query.trim().toLowerCase();

  return entries.filter((entry) => {
    if (levelFilter === "warnings" && entry.level !== "warning") return false;
    if (levelFilter === "errors" && entry.level !== "error") return false;
    if (!normalizedQuery) return true;

    return `${entry.stageLabel}\n${entry.message}`
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

function serializePreparationLogEntries(
  entries: readonly SimulationPreparationLogEntryView[],
): string {
  return entries
    .map(
      (entry) =>
        `[${entry.timestampLabel}] ${entry.level.toUpperCase()} · ${entry.stageLabel}\n${entry.message}`,
    )
    .join("\n\n");
}

function downloadPreparationLog(text: string): void {
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    throw new Error("Text download is unavailable in this browser");
  }

  const objectUrl = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  let link: HTMLAnchorElement | null = null;
  let revokeScheduled = false;

  try {
    link = document.createElement("a");
    link.href = objectUrl;
    link.download = "simulation-preparation-log.txt";
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    revokeScheduled = true;
  } finally {
    link?.remove();
    if (!revokeScheduled) URL.revokeObjectURL(objectUrl);
  }
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

export function SimulationPreparationLog({
  entries,
}: {
  entries: readonly SimulationPreparationLogEntryView[];
}) {
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const [isFollowingTail, setIsFollowingTail] = useState(true);

  useEffect(() => {
    const viewport = preparationLogViewport(scrollAreaRef.current);
    if (!viewport) return;

    const handleScroll = () => {
      const next = isPreparationLogAtBottom(viewport);
      setIsFollowingTail(next);
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  const returnToTail = useCallback(() => {
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
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] =
    useState<PreparationLogLevelFilter>("all");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const scrollRootRef = useRef<HTMLDivElement | null>(null);

  const visibleEntries = useMemo(
    () => filterPreparationLogEntries(entries, query, levelFilter),
    [entries, levelFilter, query],
  );

  const attachScrollAreaRef = useCallback(
    (root: HTMLDivElement | null) => {
      scrollRootRef.current = root;
      assignRef(scrollAreaRef, root);
    },
    [scrollAreaRef],
  );

  // A layout effect so leaving the tail disconnects the observer in the same
  // commit. With a passive effect, the resize caused by the "Return to latest"
  // button fired the stale observer first and snapped the reader back down.
  useLayoutEffect(() => {
    const viewport = preparationLogViewport(scrollRootRef.current);
    if (!viewport || !isFollowingTail) return;
    const follow = () => followPreparationLogTail(viewport, true);
    follow();
    // Details can open or resize without a new resource revision.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(follow);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [isFollowingTail, visibleEntries]);

  const copyVisibleLog = useCallback(async () => {
    try {
      await copyTextToClipboard(serializePreparationLogEntries(visibleEntries));
      setActionMessage("Visible log copied.");
    } catch {
      setActionMessage(
        "Could not copy the visible log. Check clipboard permissions and try again.",
      );
    }
  }, [visibleEntries]);

  const downloadVisibleLog = useCallback(() => {
    try {
      downloadPreparationLog(serializePreparationLogEntries(visibleEntries));
      setActionMessage("Visible log downloaded as a text file.");
    } catch {
      setActionMessage("Could not download the visible log in this browser.");
    }
  }, [visibleEntries]);

  return (
    <section
      aria-labelledby="fm-simulation-preparation-log-title"
      className="fm-simulation-preparation-log"
    >
      <header className="fm-simulation-preparation-log__header">
        <h3 id="fm-simulation-preparation-log-title">Preparation log</h3>
        {isFollowingTail ? (
          <span className="fm-simulation-preparation-log__follow-state">
            Following latest
          </span>
        ) : entries.length > 0 ? (
          <Button
            aria-label="Return to live log tail"
            className="fm-simulation-preparation-log__tail-button"
            onClick={onReturnToTail}
            size="sm"
            type="button"
            variant="secondary"
          >
            <span>New entries</span>
            <span aria-hidden="true"> · Return to latest</span>
          </Button>
        ) : null}
      </header>

      <div
        aria-label="Preparation log controls"
        className="fm-simulation-preparation-log__controls"
        role="group"
      >
        <label
          className={cn(
            "fm-simulation-preparation-log__field",
            "fm-simulation-preparation-log__field--search",
          )}
        >
          <span>Search text or stage</span>
          <Input
            aria-label="Search preparation log text or stage"
            className="fm-simulation-preparation-log__search"
            onChange={(event) => {
              setActionMessage(null);
              setQuery(event.currentTarget.value);
            }}
            placeholder="Search text or stage"
            type="search"
            value={query}
          />
        </label>

        <div className="fm-simulation-preparation-log__field">
          <span id="fm-simulation-preparation-log-level-label">Level</span>
          <Select
            onValueChange={(value) => {
              setActionMessage(null);
              setLevelFilter(value as PreparationLogLevelFilter);
            }}
            value={levelFilter}
          >
            <SelectTrigger
              aria-labelledby="fm-simulation-preparation-log-level-label"
              className="fm-simulation-preparation-log__level-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="warnings">Warnings</SelectItem>
              <SelectItem value="errors">Errors</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="fm-simulation-preparation-log__actions">
          <Button
            disabled={visibleEntries.length === 0}
            onClick={() => void copyVisibleLog()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Copy visible log
          </Button>
          <Button
            disabled={visibleEntries.length === 0}
            onClick={downloadVisibleLog}
            size="sm"
            type="button"
            variant="secondary"
          >
            Download visible log .txt
          </Button>
        </div>

        <span className="fm-simulation-preparation-log__count">
          Showing {visibleEntries.length} of {entries.length} entries
        </span>
        {actionMessage ? (
          <span
            aria-live="polite"
            className="fm-simulation-preparation-log__action-message"
          >
            {actionMessage}
          </span>
        ) : null}
      </div>

      <ScrollArea
        ref={attachScrollAreaRef}
        aria-label="Recent simulation preparation log entries"
        className="fm-simulation-preparation-log__scroll"
      >
        <div
          aria-live="off"
          className="fm-simulation-preparation-log__entries"
          role="log"
        >
          {visibleEntries.length > 0 ? (
            visibleEntries.map((entry, index) => (
              <article
                className="fm-simulation-preparation-log__entry"
                data-level={entry.level}
                key={`${preparationLogEntryKey(entry)}:${index}`}
              >
                <div className="fm-simulation-preparation-log__metadata">
                  <time>{entry.timestampLabel}</time>
                  <span className="fm-simulation-preparation-log__level">
                    {entry.level}
                  </span>
                  <span className="fm-simulation-preparation-log__stage">
                    <span aria-hidden="true">Stage </span>
                    {entry.stageLabel}
                  </span>
                </div>
                <div className="fm-simulation-preparation-log__message">
                  {entry.message}
                </div>
              </article>
            ))
          ) : (
            <p className="fm-simulation-preparation-log__empty">
              {entries.length === 0
                ? "Waiting for preparation log entries."
                : "No entries match the current search and level filter."}
            </p>
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
