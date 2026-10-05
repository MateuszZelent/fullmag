/**
 * The saved-frame index of a result folder (`frames.json`, schema
 * `fullmag.frames_index.v1`) as the workspace API serves it: a summary inside
 * the item detail and pages from `GET /v2/workspace/items/{id}/frames`.
 *
 * The index lists frames the run saved (step, physical time, stage); it holds
 * no image and no field data. Pure; parsers never throw on an optional field.
 */

export interface FrameEntry {
  /** Position over the whole folder, from 0. */
  readonly index: number;
  readonly step: number;
  readonly timeS: number;
  readonly stageId?: string;
  readonly quantityIds: readonly string[];
  readonly bytes?: number;
  readonly path: string;
}

export interface FramesStageCount {
  readonly stageId: string;
  readonly count: number;
}

export interface FramesSummary {
  readonly count: number;
  readonly firstStep?: number;
  readonly lastStep?: number;
  readonly firstTimeS?: number;
  readonly lastTimeS?: number;
  /** The index reached its entry limit; later frames are not listed. */
  readonly truncated: boolean;
  readonly stages: readonly FramesStageCount[];
  readonly note?: string;
}

export interface FramesPage {
  /** False when the run wrote no index. */
  readonly indexed: boolean;
  readonly total: number;
  readonly from: number;
  readonly frames: readonly FrameEntry[];
  readonly truncated: boolean;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const count = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && n >= 0 && Number.isInteger(n) ? n : undefined;
};

export function parseFramesSummary(value: unknown): FramesSummary | undefined {
  if (!isRecord(value)) return undefined;
  const total = count(value.count);
  if (total === undefined) return undefined;
  const stages = Array.isArray(value.stages)
    ? value.stages.flatMap((entry): FramesStageCount[] => {
        if (!isRecord(entry)) return [];
        const n = count(entry.count);
        return n === undefined ? [] : [{ stageId: str(entry.stage_id) ?? "", count: n }];
      })
    : [];
  return {
    count: total,
    firstStep: count(value.first_step),
    lastStep: count(value.last_step),
    firstTimeS: num(value.first_time_s),
    lastTimeS: num(value.last_time_s),
    truncated: value.truncated === true,
    stages,
    note: str(value.note),
  };
}

function parseFrame(value: unknown): FrameEntry | undefined {
  if (!isRecord(value)) return undefined;
  const index = count(value.index);
  const step = count(value.step);
  const timeS = num(value.time_s);
  if (index === undefined || step === undefined || timeS === undefined) return undefined;
  return {
    index,
    step,
    timeS,
    stageId: str(value.stage_id),
    quantityIds: Array.isArray(value.quantity_ids)
      ? value.quantity_ids.filter((id): id is string => typeof id === "string" && id !== "")
      : [],
    bytes: count(value.bytes),
    path: typeof value.path === "string" ? value.path : "",
  };
}

/** A page of the index; an answer that is not a page is `undefined`, never a guess. */
export function parseFramesPage(value: unknown): FramesPage | undefined {
  if (!isRecord(value)) return undefined;
  const total = count(value.total);
  const from = count(value.from);
  if (total === undefined || from === undefined || !Array.isArray(value.frames)) return undefined;
  return {
    indexed: value.indexed === true,
    total,
    from,
    frames: value.frames.flatMap((entry) => {
      const frame = parseFrame(entry);
      return frame ? [frame] : [];
    }),
    truncated: value.truncated === true,
  };
}

/** Frames per request; the backend allows 1000. */
export const FRAMES_PAGE_SIZE = 200;

/** First index of the page that holds `index`. */
export function pageStartOf(index: number, pageSize: number = FRAMES_PAGE_SIZE): number {
  return Math.floor(Math.max(0, index) / pageSize) * pageSize;
}

/** `0.003 ns`: physical time in nanoseconds, four significant digits. */
export function formatFrameTime(timeS: number): string {
  const ns = timeS * 1e9;
  if (ns === 0) return "0 ns";
  return `${Number(ns.toPrecision(4))} ns`;
}

/** The scrubber's label: `frame 3 of 10 · step 20 · t = 0.002 ns`, stage appended when known. */
export function frameLabel(position: number, total: number, frame: FrameEntry | undefined): string {
  const head = `frame ${(position + 1).toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`;
  if (!frame) return `${head} · reading the index…`;
  return `${head} · step ${frame.step.toLocaleString("en-US")} · t = ${formatFrameTime(frame.timeS)}`;
}

/** What the saved frames cover, for the summary row: `10 frames · 0 – 4 ns`. */
export function framesSummaryLine(summary: FramesSummary): string {
  const frames = `${summary.count.toLocaleString("en-US")} ${summary.count === 1 ? "frame" : "frames"}`;
  if (summary.firstTimeS === undefined || summary.lastTimeS === undefined) return frames;
  const span =
    summary.count === 1
      ? formatFrameTime(summary.firstTimeS)
      : `${formatFrameTime(summary.firstTimeS)} to ${formatFrameTime(summary.lastTimeS)}`;
  return `${frames} · ${span}${summary.truncated ? " · index truncated" : ""}`;
}
