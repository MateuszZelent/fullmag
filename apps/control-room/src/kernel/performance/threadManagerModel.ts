import type { RequestDiagnosticEntry } from "../api/RequestDiagnosticsController";
import type { MemoryBudgetEntry } from "./MemoryBudgetRegistry";

export type ThreadManagerLane =
  | "aggregate"
  | "main"
  | "worker-io"
  | "react"
  | "other";

interface ThreadManagerRow {
  averageMs: number;
  id: string;
  label: string;
  lane: ThreadManagerLane;
  lastMs: number;
  latestPath: string;
  maxMs: number;
  sampleCount: number;
  sharePercent: number;
  totalMs: number;
}

interface ThreadManagerWorkerRow {
  detail: string;
  id: string;
  label: string;
  sampleCount: number;
  status: "active" | "idle";
}

export interface ThreadManagerModel {
  activityRows: ThreadManagerActivityRow[];
  rows: ThreadManagerRow[];
  sampleCount: number;
  totalMeasuredMs: number;
  workerRows: ThreadManagerWorkerRow[];
}

interface ThreadManagerActivityRow {
  id: string;
  label: string;
  lane: ThreadManagerLane;
  maxRate: number;
  sampleCount: number;
  totalCount: number;
  unit: string;
  latestRate: number;
}

export interface ThreadManagerClipboardLogInput {
  browserCores: number | null;
  entries: readonly RequestDiagnosticEntry[];
  generatedAt: Date;
  jsHeapBytes: number | null;
  memoryBudgetRows?: readonly ThreadManagerMemoryBudgetRow[];
  model: ThreadManagerModel;
  reactProfilerEnabled: boolean;
}

export interface ThreadManagerMemoryBudgetRow {
  byteLength: number;
  category: string;
  entryCount: number;
  id: string;
  label: string;
  maxBytes: number | null;
  status: "ok" | "over-budget" | "unbounded-high" | "unbounded";
  utilizationPercent: number | null;
}

interface ThreadManagerGroupAccumulator {
  id: string;
  label: string;
  lane: ThreadManagerLane;
  lastMs: number;
  latestPath: string;
  latestTimestampMs: number;
  maxMs: number;
  sampleCount: number;
  totalMs: number;
}

const RAW_LOG_ENTRY_LIMIT = 200;
const PERFORMANCE_PREFIX = "fullmag.";
const VIEWPORT3D_PREFIX = "fullmag.viewport3d.";
const API_BINARY_PREFIX = "fullmag.api.requestBinaryResource.";
const REACT_RENDER_PREFIX = "fullmag.react.render.";
const VIEWPORT3D_FRAME_WINDOW_PATH = "fullmag.viewport3d.frame-window";
const LONG_TASK_PATH = "fullmag.browser.longtask";
const LONG_ANIMATION_FRAME_PATH = "fullmag.browser.long-animation-frame";

export function buildThreadManagerModel(
  entries: readonly RequestDiagnosticEntry[],
): ThreadManagerModel {
  const activity = new Map<string, ThreadManagerActivityRow>();
  const groups = new Map<string, ThreadManagerGroupAccumulator>();
  let sampleCount = 0;
  let totalMeasuredMs = 0;

  const orderedEntries = entries.toSorted(
    (left, right) => left.timestampMs - right.timestampMs,
  );
  for (const entry of orderedEntries) {
    if (entry.channel !== "performance") continue;
    if (!entry.path.startsWith(PERFORMANCE_PREFIX)) continue;
    const durationMs = entry.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
      continue;
    }

    if (entry.path === VIEWPORT3D_FRAME_WINDOW_PATH) {
      addViewportFrameWindowActivity(activity, entry);
      continue;
    }

    const classification = classifyThreadManagerPath(entry);
    const group = groups.get(classification.id) ?? {
      id: classification.id,
      label: classification.label,
      lane: classification.lane,
      lastMs: 0,
      latestPath: entry.path,
      latestTimestampMs: Number.NEGATIVE_INFINITY,
      maxMs: 0,
      sampleCount: 0,
      totalMs: 0,
    };

    group.sampleCount += 1;
    group.totalMs += durationMs;
    group.maxMs = Math.max(group.maxMs, durationMs);
    if (entry.timestampMs >= group.latestTimestampMs) {
      group.latestTimestampMs = entry.timestampMs;
      group.lastMs = durationMs;
      group.latestPath = entry.path;
    }
    groups.set(group.id, group);

    sampleCount += 1;
    totalMeasuredMs += durationMs;
  }

  const rows = Array.from(groups.values())
    .map((group) => ({
      averageMs: group.totalMs / group.sampleCount,
      id: group.id,
      label: group.label,
      lane: group.lane,
      lastMs: group.lastMs,
      latestPath: group.latestPath,
      maxMs: group.maxMs,
      sampleCount: group.sampleCount,
      sharePercent:
        totalMeasuredMs > 0 ? (group.totalMs / totalMeasuredMs) * 100 : 0,
      totalMs: group.totalMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

  return {
    activityRows: Array.from(activity.values()).sort(
      (left, right) => right.latestRate - left.latestRate,
    ),
    rows,
    sampleCount,
    totalMeasuredMs,
    workerRows: buildWorkerRows(rows),
  };
}

export function buildThreadManagerClipboardLog({
  browserCores,
  entries,
  generatedAt,
  jsHeapBytes,
  memoryBudgetRows = [],
  model,
  reactProfilerEnabled,
}: ThreadManagerClipboardLogInput): string {
  const lines = [
    "Thread Manager Snapshot",
    `Generated: ${generatedAt.toISOString()}`,
    `Browser cores: ${browserCores ?? "n/a"}`,
    `Samples: ${model.sampleCount}`,
    `Measured work: ${formatMs(model.totalMeasuredMs)}`,
    `JS heap: ${jsHeapBytes === null ? "n/a" : formatBytes(jsHeapBytes)}`,
    `React profiler: ${reactProfilerEnabled ? "on" : "off"}`,
    "",
    "Measured Areas",
  ];

  if (model.rows.length === 0) {
    lines.push("none");
  } else {
    lines.push("area\tlane\tsamples\ttotal\tavg\tmax\tshare\tlatest_path");
    for (const row of model.rows) {
      lines.push(
        [
          row.label,
          row.lane,
          String(row.sampleCount),
          formatMs(row.totalMs),
          formatMs(row.averageMs),
          formatMs(row.maxMs),
          `${row.sharePercent.toFixed(0)}%`,
          row.latestPath,
        ].join("\t"),
      );
    }
  }

  lines.push("", "Activity Signals");
  if (model.activityRows.length === 0) {
    lines.push("none");
  } else {
    lines.push("signal\tlane\tsamples\tlatest\tmax\ttotal");
    for (const row of model.activityRows) {
      lines.push(
        [
          row.label,
          row.lane,
          String(row.sampleCount),
          formatRate(row.latestRate, row.unit),
          formatRate(row.maxRate, row.unit),
          `${row.totalCount} ${totalUnitLabel(row.unit)}`,
        ].join("\t"),
      );
    }
  }

  lines.push("", "Memory Budgets");
  if (memoryBudgetRows.length === 0) {
    lines.push("none");
  } else {
    lines.push("component\tcategory\tusage\tlimit\tentries\tutil\tstatus");
    for (const row of memoryBudgetRows) {
      lines.push(
        [
          row.label,
          row.category,
          formatBytes(row.byteLength),
          row.maxBytes === null ? "unbounded" : formatBytes(row.maxBytes),
          String(row.entryCount),
          row.utilizationPercent === null
            ? "n/a"
            : `${row.utilizationPercent.toFixed(0)}%`,
          row.status,
        ].join("\t"),
      );
    }
  }

  lines.push("", "Workers");
  for (const worker of model.workerRows) {
    lines.push(
      [worker.label, worker.status, String(worker.sampleCount), worker.detail].join(
        "\t",
      ),
    );
  }

  lines.push("", `Raw Diagnostics (newest first, max ${RAW_LOG_ENTRY_LIMIT})`);
  lines.push("timestamp\tmethod\tpath\tduration\tdetail");
  for (const entry of entries.slice(0, RAW_LOG_ENTRY_LIMIT)) {
    lines.push(
      [
        String(entry.timestampMs),
        entry.method,
        entry.path,
        entry.durationMs === null ? "n/a" : formatMs(entry.durationMs),
        entry.detail ?? "",
      ].join("\t"),
    );
  }

  return lines.join("\n");
}

export function buildThreadManagerMemoryBudgetRows(
  entries: readonly MemoryBudgetEntry[],
): ThreadManagerMemoryBudgetRow[] {
  return entries
    .map((entry) => {
      const utilizationPercent =
        entry.maxBytes && entry.maxBytes > 0
          ? (entry.byteLength / entry.maxBytes) * 100
          : null;
      return {
        byteLength: Math.max(0, entry.byteLength),
        category: entry.category,
        entryCount: Math.max(0, entry.entryCount),
        id: entry.id,
        label: entry.label,
        maxBytes: entry.maxBytes,
        status: resolveMemoryBudgetStatus(entry, utilizationPercent),
        utilizationPercent,
      };
    })
    .sort((left, right) => right.byteLength - left.byteLength);
}

function resolveMemoryBudgetStatus(
  entry: MemoryBudgetEntry,
  utilizationPercent: number | null,
): ThreadManagerMemoryBudgetRow["status"] {
  if (utilizationPercent !== null) {
    return utilizationPercent > 100 ? "over-budget" : "ok";
  }
  if (entry.byteLength >= 100 * 1024 * 1024) return "unbounded-high";
  return "unbounded";
}

function classifyThreadManagerPath(entry: RequestDiagnosticEntry): {
  id: string;
  label: string;
  lane: ThreadManagerLane;
} {
  const path = entry.path;
  if (path.startsWith(VIEWPORT3D_PREFIX)) {
    return { id: "viewport-3d", label: "Viewport 3D", lane: "main" };
  }

  if (path === LONG_TASK_PATH) {
    const source = readDetailValue(entry.detail, "source") ?? "unknown";
    return {
      id: `browser-longtask:${source}`,
      label: `Long task: ${source}`,
      lane: "main",
    };
  }

  if (path === LONG_ANIMATION_FRAME_PATH) {
    const source = readDetailValue(entry.detail, "source") ?? "unknown";
    return {
      id: `browser-long-animation-frame:${source}`,
      label: `Long animation frame: ${source}`,
      lane: "main",
    };
  }

  if (path.startsWith(API_BINARY_PREFIX)) {
    return {
      id: "api-binary",
      label: "API / binary decode",
      lane: "worker-io",
    };
  }

  if (path.startsWith(REACT_RENDER_PREFIX)) {
    const moduleName =
      path.slice(REACT_RENDER_PREFIX.length).split(".")[0] || "React";
    if (moduleName === "WorkspaceDockLayout") {
      return {
        id: "react:WorkspaceDockLayout",
        label: "Workspace dock aggregate",
        lane: "aggregate",
      };
    }

    return {
      id: `react:${moduleName}`,
      label: `React: ${moduleName}`,
      lane: "react",
    };
  }

  return { id: "other", label: "Other performance", lane: "other" };
}

function addViewportFrameWindowActivity(
  activity: Map<string, ThreadManagerActivityRow>,
  entry: RequestDiagnosticEntry,
): void {
  const detail = entry.detail ?? "";
  const frames = readDetailNumber(detail, "frames");
  const fps = readDetailNumber(detail, "fps");
  if (frames === null || fps === null) return;
  const windowMs = readDetailNumber(detail, "windowMs");
  const elapsedMs =
    windowMs ??
    (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
      ? entry.durationMs
      : null);

  const current = activity.get("viewport-3d-frame-loop") ?? {
    id: "viewport-3d-frame-loop",
    label: "Viewport 3D frame loop",
    lane: "main" as const,
    latestRate: 0,
    maxRate: 0,
    sampleCount: 0,
    totalCount: 0,
    unit: "fps",
  };
  current.sampleCount += 1;
  current.totalCount += frames;
  current.latestRate = fps;
  current.maxRate = Math.max(current.maxRate, fps);
  activity.set(current.id, current);

  const dirtyReasonCounts = readDirtyReasonCounts(detail);
  if (dirtyReasonCounts.length === 0) {
    const untracked = activity.get("viewport-3d-untracked-frames") ?? {
      id: "viewport-3d-untracked-frames",
      label: "Viewport frames without tracked dirty reason",
      lane: "main" as const,
      latestRate: 0,
      maxRate: 0,
      sampleCount: 0,
      totalCount: 0,
      unit: "frames/s",
    };
    untracked.sampleCount += 1;
    untracked.totalCount += frames;
    untracked.latestRate = fps;
    untracked.maxRate = Math.max(untracked.maxRate, fps);
    activity.set(untracked.id, untracked);
  }

  for (const [reason, count] of dirtyReasonCounts) {
    const reasonRow = activity.get(`viewport-3d-dirty:${reason}`) ?? {
      id: `viewport-3d-dirty:${reason}`,
      label: `Viewport dirty: ${reason}`,
      lane: "main" as const,
      latestRate: 0,
      maxRate: 0,
      sampleCount: 0,
      totalCount: 0,
      unit: "dirty/s",
    };
    const rate =
      elapsedMs !== null && elapsedMs > 0 ? count / (elapsedMs / 1_000) : 0;
    reasonRow.sampleCount += 1;
    reasonRow.totalCount += count;
    reasonRow.latestRate = rate;
    reasonRow.maxRate = Math.max(reasonRow.maxRate, rate);
    activity.set(reasonRow.id, reasonRow);
  }
}

function readDetailNumber(detail: string, key: string): number | null {
  const match = detail.match(new RegExp(`(?:^|;)${key}=([0-9.]+)(?:;|$)`));
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function readDetailValue(detail: string | null | undefined, key: string): string | null {
  if (!detail) return null;
  const match = detail.match(new RegExp(`(?:^|;)${key}=([^;]+)(?:;|$)`));
  return match?.[1]?.trim() || null;
}

function readDirtyReasonCounts(detail: string): Array<[string, number]> {
  const match = detail.match(/(?:^|;)dirty=([^;]+)(?:;|$)/);
  if (!match?.[1] || match[1] === "none") return [];
  const counts: Array<[string, number]> = [];
  for (const item of match[1].split(",")) {
    const [reason, countText] = item.split(":");
    if (!reason || !countText) continue;
    const count = Number(countText);
    if (!Number.isFinite(count) || count <= 0) continue;
    counts.push([reason, count]);
  }
  return counts;
}

function buildWorkerRows(rows: ThreadManagerRow[]): ThreadManagerWorkerRow[] {
  const binary = rows.find((row) => row.id === "api-binary");
  return [
    {
      detail: binary
        ? `${formatMs(binary.totalMs)} measured across ${binary.sampleCount} binary decode/request sample(s)`
        : "No binary decode samples in the current diagnostics buffer",
      id: "binary-decode",
      label: "Binary decode worker",
      sampleCount: binary?.sampleCount ?? 0,
      status: binary ? "active" : "idle",
    },
  ];
}

export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 100) return `${Math.round(value)} ms`;
  if (value >= 10) return `${value.toFixed(1)} ms`;
  return `${value.toFixed(2)} ms`;
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

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
