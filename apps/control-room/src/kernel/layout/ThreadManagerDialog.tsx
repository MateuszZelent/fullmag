"use client";

import { Check, Copy, Cpu, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { KernelApi } from "@/kernel/types";
import {
  REACT_RENDER_PROFILE_STORAGE_KEY,
  shouldEnableReactRenderProfiler,
} from "@/kernel/performance/reactRenderProfiler";
import {
  buildThreadManagerClipboardLog,
  buildThreadManagerModel,
  formatMs,
  type ThreadManagerLane,
} from "@/kernel/performance/threadManagerModel";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

const EMPTY_ENTRIES: RequestDiagnosticEntry[] = [];
type CopyState = "idle" | "copied" | "failed";

interface ThreadManagerDialogProps {
  kernel: KernelApi;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function ThreadManagerDialog({
  kernel,
  onOpenChange,
  open,
}: ThreadManagerDialogProps) {
  const entries = useThreadDiagnostics(kernel, open);
  const model = useMemo(() => buildThreadManagerModel(entries), [entries]);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyResetTimerRef = useRef<number | null>(null);
  const reactProfilerEnabled = shouldEnableReactRenderProfiler();
  const hardwareConcurrency =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : null;
  const memorySnapshot = readBrowserMemorySnapshot();

  useEffect(
    () => () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  const toggleReactProfiler = () => {
    if (typeof window === "undefined") return;
    try {
      if (reactProfilerEnabled) {
        window.localStorage.removeItem(REACT_RENDER_PROFILE_STORAGE_KEY);
      } else {
        window.localStorage.setItem(REACT_RENDER_PROFILE_STORAGE_KEY, "1");
      }
    } catch {
      return;
    }
    window.location.reload();
  };

  const copyDiagnosticsLog = useCallback(async () => {
    const log = buildThreadManagerClipboardLog({
      browserCores: hardwareConcurrency,
      entries,
      generatedAt: new Date(),
      jsHeapBytes: memorySnapshot?.usedJSHeapSize ?? null,
      model,
      reactProfilerEnabled,
    });

    try {
      await writeClipboardText(log);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyState("idle");
      copyResetTimerRef.current = null;
    }, 1_800);
  }, [
    entries,
    hardwareConcurrency,
    memorySnapshot?.usedJSHeapSize,
    model,
    reactProfilerEnabled,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-thread-manager" aria-describedby="fm-thread-manager-description">
        <DialogHeader>
          <DialogTitle>Thread Manager</DialogTitle>
          <DialogDescription id="fm-thread-manager-description" className="fm-visually-hidden">
            Browser performance diagnostics and measured thread areas.
          </DialogDescription>
          <DialogClose asChild>
            <button
              aria-label="Close thread manager"
              className="fm-thread-manager__close"
              type="button"
            >
              <X size={16} />
            </button>
          </DialogClose>
        </DialogHeader>

        <div className="fm-thread-manager__summary" aria-label="Thread summary">
          <MetricCard
            label="Browser cores"
            value={
              hardwareConcurrency === null ? "n/a" : String(hardwareConcurrency)
            }
          />
          <MetricCard label="Samples" value={String(model.sampleCount)} />
          <MetricCard
            label="Measured work"
            value={formatMs(model.totalMeasuredMs)}
          />
          <MetricCard
            label="JS heap"
            value={
              memorySnapshot
                ? formatBytes(memorySnapshot.usedJSHeapSize)
                : "n/a"
            }
          />
          <MetricCard
            label="React profiler"
            value={reactProfilerEnabled ? "on" : "off"}
          />
        </div>

        <div className="fm-thread-manager__toolbar">
          <span>Browser measures, not OS CPU counters.</span>
          <div className="fm-thread-manager__toolbar-actions">
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={copyDiagnosticsLog}
            >
              {copyState === "copied" ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Copy failed"
                  : "Copy log"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={toggleReactProfiler}
            >
              {reactProfilerEnabled
                ? "Disable React profiler"
                : "Enable React profiler"}
            </Button>
          </div>
        </div>

        <section
          className="fm-thread-manager__section"
          aria-label="Measured areas"
        >
          <div className="fm-thread-manager__section-title">
            <Cpu size={14} aria-hidden="true" />
            <span>Measured Areas</span>
          </div>
          {model.rows.length > 0 ? (
            <div className="fm-thread-manager__table" role="table">
              <div
                className="fm-thread-manager__row fm-thread-manager__row--header"
                role="row"
              >
                <span role="columnheader">Area</span>
                <span role="columnheader">Lane</span>
                <span role="columnheader">Samples</span>
                <span role="columnheader">Total</span>
                <span role="columnheader">Avg</span>
                <span role="columnheader">Max</span>
                <span role="columnheader">Share</span>
              </div>
              {model.rows.map((row) => (
                <div className="fm-thread-manager__row" role="row" key={row.id}>
                  <span role="cell" title={row.latestPath}>
                    {row.label}
                  </span>
                  <span role="cell" data-lane={row.lane}>
                    {laneLabel(row.lane)}
                  </span>
                  <span role="cell">{row.sampleCount}</span>
                  <span role="cell">{formatMs(row.totalMs)}</span>
                  <span role="cell">{formatMs(row.averageMs)}</span>
                  <span role="cell">{formatMs(row.maxMs)}</span>
                  <span role="cell">
                    <span className="fm-thread-manager__share">
                      <span
                        className="fm-thread-manager__share-fill"
                        style={{ width: `${Math.min(row.sharePercent, 100)}%` }}
                      />
                    </span>
                    {row.sharePercent.toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="fm-thread-manager__empty" role="status">
              No performance samples in the diagnostics buffer.
            </div>
          )}
        </section>

        <section
          className="fm-thread-manager__section"
          aria-label="Activity signals"
        >
          <div className="fm-thread-manager__section-title">
            <Cpu size={14} aria-hidden="true" />
            <span>Activity Signals</span>
          </div>
          {model.activityRows.length > 0 ? (
            <div
              className="fm-thread-manager__table fm-thread-manager__table--activity"
              role="table"
            >
              <div
                className="fm-thread-manager__row fm-thread-manager__row--header fm-thread-manager__row--activity"
                role="row"
              >
                <span role="columnheader">Signal</span>
                <span role="columnheader">Lane</span>
                <span role="columnheader">Samples</span>
                <span role="columnheader">Latest</span>
                <span role="columnheader">Max</span>
                <span role="columnheader">Total</span>
              </div>
              {model.activityRows.map((row) => (
                <div
                  className="fm-thread-manager__row fm-thread-manager__row--activity"
                  role="row"
                  key={row.id}
                >
                  <span role="cell">{row.label}</span>
                  <span role="cell" data-lane={row.lane}>
                    {laneLabel(row.lane)}
                  </span>
                  <span role="cell">{row.sampleCount}</span>
                  <span role="cell">
                    {formatRate(row.latestRate, row.unit)}
                  </span>
                  <span role="cell">{formatRate(row.maxRate, row.unit)}</span>
                  <span role="cell">
                    {row.totalCount} {totalUnitLabel(row.unit)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="fm-thread-manager__empty" role="status">
              No frame-loop or background activity samples in the diagnostics
              buffer.
            </div>
          )}
        </section>

        <section className="fm-thread-manager__section" aria-label="Workers">
          <div className="fm-thread-manager__section-title">
            <Cpu size={14} aria-hidden="true" />
            <span>Workers</span>
          </div>
          <div className="fm-thread-manager__workers">
            {model.workerRows.map((worker) => (
              <div
                className="fm-thread-manager__worker"
                data-status={worker.status}
                key={worker.id}
              >
                <span>{worker.label}</span>
                <strong>{worker.status}</strong>
                <small>{worker.detail}</small>
              </div>
            ))}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

interface BrowserMemorySnapshot {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

function useThreadDiagnostics(
  kernel: KernelApi,
  enabled: boolean,
): RequestDiagnosticEntry[] {
  const version = useSyncExternalStore(
    enabled
      ? kernel.diagnostics.subscribe.bind(kernel.diagnostics)
      : () => () => {},
    enabled ? kernel.diagnostics.getVersion.bind(kernel.diagnostics) : () => 0,
    () => 0,
  );

  return useMemo(() => {
    void version;
    return enabled ? kernel.diagnostics.listNewestFirst() : EMPTY_ENTRIES;
  }, [enabled, kernel.diagnostics, version]);
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="fm-thread-manager__metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function readBrowserMemorySnapshot(): BrowserMemorySnapshot | null {
  const memory = (globalThis.performance as Performance & {
    memory?: BrowserMemorySnapshot;
  } | undefined)?.memory;
  if (!memory) return null;
  if (!Number.isFinite(memory.usedJSHeapSize)) return null;
  return memory;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRate(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "n/a";
  if (unit === "fps") return `${value.toFixed(1)} fps`;
  if (unit === "frames/s") return `${value.toFixed(1)} frames/s`;
  return `${value.toFixed(1)} ${unit}`;
}

function totalUnitLabel(unit: string): string {
  if (unit === "fps") return "frames";
  if (unit === "frames/s") return "frames";
  if (unit === "dirty/s") return "invalidations";
  return unit;
}

function laneLabel(lane: ThreadManagerLane): string {
  switch (lane) {
    case "aggregate":
      return "aggregate";
    case "main":
      return "main";
    case "worker-io":
      return "worker/io";
    case "react":
      return "react";
    case "other":
      return "other";
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is unavailable");
  }
  await navigator.clipboard.writeText(text);
}
