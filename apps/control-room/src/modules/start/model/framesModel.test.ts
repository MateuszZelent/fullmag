import { describe, expect, it } from "vitest";

import {
  FRAMES_PAGE_SIZE,
  formatFrameTime,
  frameLabel,
  framesSummaryLine,
  pageStartOf,
  parseFramesPage,
  parseFramesSummary,
} from "./framesModel";

const rawFrame = (index: number, over: Record<string, unknown> = {}) => ({
  index,
  step: index * 10,
  time_s: index * 1e-12,
  stage_id: "run",
  quantity_ids: ["m", "H_eff"],
  bytes: 128,
  path: `fields/m/step_${String(index * 10).padStart(6, "0")}.json`,
  ...over,
});

describe("parseFramesSummary", () => {
  it("reads the counts, range and per-stage totals", () => {
    const summary = parseFramesSummary({
      schema: "fullmag.frames_index.v1",
      count: 5,
      first_step: 0,
      last_step: 40,
      first_time_s: 0,
      last_time_s: 4e-12,
      truncated: false,
      stages: [
        { stage_id: "relax", count: 2 },
        { stage_id: "run", count: 3 },
      ],
      note: null,
    });
    expect(summary).toEqual({
      count: 5,
      firstStep: 0,
      lastStep: 40,
      firstTimeS: 0,
      lastTimeS: 4e-12,
      truncated: false,
      stages: [
        { stageId: "relax", count: 2 },
        { stageId: "run", count: 3 },
      ],
      note: undefined,
    });
  });

  it("is undefined without a count, never a guessed zero", () => {
    expect(parseFramesSummary(null)).toBeUndefined();
    expect(parseFramesSummary({})).toBeUndefined();
    expect(parseFramesSummary({ count: -1 })).toBeUndefined();
    expect(parseFramesSummary({ count: 1.5 })).toBeUndefined();
  });
});

describe("parseFramesPage", () => {
  it("keeps valid frames and drops malformed entries", () => {
    const page = parseFramesPage({
      indexed: true,
      total: 3,
      from: 1,
      truncated: true,
      frames: [rawFrame(1), { index: 2, step: 20 }, rawFrame(3, { bytes: "x", quantity_ids: undefined })],
    });
    expect(page?.indexed).toBe(true);
    expect(page?.truncated).toBe(true);
    expect(page?.frames.map((frame) => frame.index)).toEqual([1, 3]);
    expect(page?.frames[0]).toMatchObject({ step: 10, timeS: 1e-12, stageId: "run", bytes: 128 });
    expect(page?.frames[1]).toMatchObject({ quantityIds: [], bytes: undefined });
  });

  it("rejects an answer that is not a page", () => {
    expect(parseFramesPage(undefined)).toBeUndefined();
    expect(parseFramesPage({ total: 1, from: 0 })).toBeUndefined();
    expect(parseFramesPage({ total: "1", from: 0, frames: [] })).toBeUndefined();
  });

  it("reads an unindexed folder as indexed: false", () => {
    expect(parseFramesPage({ indexed: false, total: 0, from: 0, frames: [], truncated: false })).toEqual({
      indexed: false,
      total: 0,
      from: 0,
      frames: [],
      truncated: false,
    });
  });
});

describe("labels", () => {
  it("formats physical time in nanoseconds", () => {
    expect(formatFrameTime(0)).toBe("0 ns");
    expect(formatFrameTime(2e-12)).toBe("0.002 ns");
    expect(formatFrameTime(1.23456789e-9)).toBe("1.235 ns");
  });

  it("labels a frame as frame i of N with step and time", () => {
    const frame = parseFramesPage({ total: 10, from: 0, frames: [rawFrame(2)] })!.frames[0];
    expect(frameLabel(2, 10, frame)).toBe("frame 3 of 10 · step 20 · t = 0.002 ns");
    expect(frameLabel(4, 10, undefined)).toBe("frame 5 of 10 · reading the index…");
  });

  it("summarises the range and says when the index is truncated", () => {
    expect(
      framesSummaryLine({ count: 3, firstTimeS: 0, lastTimeS: 4e-9, truncated: true, stages: [] }),
    ).toBe("3 frames · 0 ns to 4 ns · index truncated");
    expect(framesSummaryLine({ count: 1, firstTimeS: 1e-9, lastTimeS: 1e-9, truncated: false, stages: [] })).toBe(
      "1 frame · 1 ns",
    );
    expect(framesSummaryLine({ count: 2, truncated: false, stages: [] })).toBe("2 frames");
  });

  it("aligns pages to the page size", () => {
    expect(pageStartOf(0)).toBe(0);
    expect(pageStartOf(FRAMES_PAGE_SIZE - 1)).toBe(0);
    expect(pageStartOf(FRAMES_PAGE_SIZE)).toBe(FRAMES_PAGE_SIZE);
    expect(pageStartOf(-5)).toBe(0);
  });
});
