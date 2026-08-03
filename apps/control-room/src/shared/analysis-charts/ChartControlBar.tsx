"use client";

import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/shared/ui/Select";

export type ChartLiveMode = "following" | "paused";
export type ChartRangeModeState =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed" }
  | { mode: "fullDecimated" };
export type ChartRangeMode = ChartRangeModeState["mode"];

interface ChartControlBarProps {
  liveMode: ChartLiveMode;
  rangeMode?: ChartRangeModeState;
  /** Total number of visible points (for display) */
  visiblePoints?: number;
  /** Total rows in dataset */
  totalRows?: number;
  onLiveModeToggle: () => void;
  onFitView?: () => void;
  onRangeModeChange?: (mode: ChartRangeModeState) => void;
  targetPoints?: 160 | 400 | 800 | 1600 | 3200 | 5000;
  onTargetPointsChange?: (targetPoints: 160 | 400 | 800 | 1600 | 3200 | 5000) => void;
  /** A fixed range exists only after the user zooms/selects it on the chart. */
  fixedRangeAvailable?: boolean;
  /** `tailTime` maps to the server's `from_t/to_t` contract and needs a t/time X axis. */
  timeRangeSupported?: boolean;
}

interface ChartRangeOption {
  label: string;
  value: string;
}

export function chartRangeOptions(
  timeRangeSupported = true,
  fixedRangeAvailable = false,
): readonly ChartRangeOption[] {
  return [
    { label: "Follow", value: "follow" },
    { label: "Last 100 points", value: "tailRows:100" },
    { label: "Last 160 points", value: "tailRows:160" },
    { label: "Last 400 points", value: "tailRows:400" },
    ...(timeRangeSupported
      ? [
          { label: "Last 1 ns", value: "tailTime:1e-9" },
          { label: "Last 10 ns", value: "tailTime:10e-9" },
        ]
      : []),
    ...(fixedRangeAvailable ? [{ label: "Fixed range", value: "fixed" }] : []),
    { label: "Full (decimated)", value: "fullDecimated" },
  ];
}

/**
 * ChartControlBar — primary toolbar for live/paused state, range mode,
 * and fit-to-view.
 *
 * - Follow / Paused: toggles `ChartLiveMode`. Shows "Paused" badge with
 *   accessible description when paused.
 * - Range mode selector: follow, last N rows, last T seconds, fixed, full.
 * - Fit: resets zoom (local ECharts action, zero fetch).
 *
 * Does NOT own ECharts directly — emits commands upward.
 */
export function ChartControlBar({
  liveMode,
  rangeMode,
  visiblePoints,
  totalRows,
  onLiveModeToggle,
  onFitView,
  onRangeModeChange,
  targetPoints = 1600,
  onTargetPointsChange,
  fixedRangeAvailable = false,
  timeRangeSupported = true,
}: ChartControlBarProps) {
  const isPaused = liveMode === "paused";

  return (
    <div className="fm-chart-control-bar" role="toolbar" aria-label="Chart controls">
      {/* Live / Paused toggle */}
      <Button
        aria-label={
          isPaused
            ? "Resume live chart updates"
            : "Pause chart — freeze current revision"
        }
        aria-pressed={isPaused}
        className={`fm-chart-control-bar__live-btn${isPaused ? " fm-chart-control-bar__live-btn--paused" : ""}`}
        onClick={onLiveModeToggle}
        size="sm"
        type="button"
        variant={isPaused ? "primary" : "secondary"}
      >
        {isPaused ? (
          <>
            <span aria-hidden="true" className="fm-chart-control-bar__pulse fm-chart-control-bar__pulse--paused" />
            Paused
          </>
        ) : (
          <>
            <span aria-hidden="true" className="fm-chart-control-bar__pulse fm-chart-control-bar__pulse--live" />
            Live
          </>
        )}
      </Button>

      {/* Point budget summary */}
      {visiblePoints != null ? (
        <span
          aria-label={`${visiblePoints} visible points${totalRows != null ? ` of ${totalRows} total` : ""}`}
          className="fm-chart-control-bar__points"
        >
          {visiblePoints.toLocaleString()}
          {totalRows != null && totalRows !== visiblePoints ? (
            <span className="fm-chart-control-bar__points-total">
              {" "}/ {totalRows.toLocaleString()}
            </span>
          ) : null}
          {" pts"}
        </span>
      ) : null}

      {/* Range mode selector — intentionally in the top toolbar, never a
          bottom scrolling slider. */}
      {rangeMode ? (
        <Select
          value={rangeModeValue(rangeMode)}
          onValueChange={(value) => {
            const next = rangeModeFromValue(value);
            if (next) onRangeModeChange?.(next);
          }}
        >
          <SelectTrigger
            aria-label="Chart range"
            className="fm-chart-control-bar__range-select"
            density="compact"
          >
            <span>{rangeModeLabel(rangeMode)}</span>
          </SelectTrigger>
          <SelectContent>
            {chartRangeOptions(timeRangeSupported, fixedRangeAvailable).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {onTargetPointsChange ? (
        <Select
          value={String(targetPoints)}
          onValueChange={(value) => {
            const next = Number(value);
            if ([160, 400, 800, 1600, 3200, 5000].includes(next)) {
              onTargetPointsChange(next as 160 | 400 | 800 | 1600 | 3200 | 5000);
            }
          }}
        >
          <SelectTrigger aria-label="Chart point budget" className="fm-chart-control-bar__points-select" density="compact">
            <span>{targetPoints.toLocaleString()} pts</span>
          </SelectTrigger>
          <SelectContent>
            {[160, 400, 800, 1600, 3200, 5000].map((value) => (
              <SelectItem key={value} value={String(value)}>{value.toLocaleString()} pts</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Fit / Reset zoom */}
      {onFitView ? (
        <Button
          aria-label="Reset zoom to fit all visible data"
          className="fm-chart-control-bar__fit-btn"
          onClick={onFitView}
          size="sm"
          type="button"
          variant="secondary"
        >
          Fit
        </Button>
      ) : null}
    </div>
  );
}

function rangeModeLabel(mode: ChartRangeModeState): string {
  switch (mode.mode) {
    case "follow":
      return "Follow";
    case "tailRows":
      return `Last ${mode.rows ?? "?"} rows`;
    case "tailTime":
      return `Last ${formatDuration(mode.durationS ?? 0)}`;
    case "fixed":
      return "Fixed range";
    case "fullDecimated":
      return "Full (decimated)";
  }
}

function rangeModeValue(mode: ChartRangeModeState): string {
  switch (mode.mode) {
    case "tailRows": return `tailRows:${mode.rows ?? 400}`;
    case "tailTime": return `tailTime:${mode.durationS ?? 1e-9}`;
    default: return mode.mode;
  }
}

function rangeModeFromValue(value: string): ChartRangeModeState | null {
  if (value === "follow") return { mode: "follow" };
  if (value === "fixed") return { mode: "fixed" };
  if (value === "fullDecimated") return { mode: "fullDecimated" };
  const [mode, raw] = value.split(":");
  const numeric = Number(raw);
  if (mode === "tailRows" && Number.isFinite(numeric)) {
    return { mode: "tailRows", rows: numeric };
  }
  if (mode === "tailTime" && Number.isFinite(numeric)) {
    return { mode: "tailTime", durationS: numeric };
  }
  return null;
}

function formatDuration(seconds: number): string {
  if (seconds >= 1) return `${formatDurationMagnitude(seconds)} s`;
  if (seconds >= 1e-3) return `${formatDurationMagnitude(seconds * 1e3)} ms`;
  if (seconds >= 1e-6) return `${formatDurationMagnitude(seconds * 1e6)} µs`;
  return `${formatDurationMagnitude(seconds * 1e9)} ns`;
}

function formatDurationMagnitude(value: number): string {
  return String(Number(value.toPrecision(3)));
}
