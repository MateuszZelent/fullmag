import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FramesSummary } from "../model/framesModel";

import { FRAME_INDEX_NOTE, FrameScrubber, pageProblem, stepPosition } from "./FrameScrubber";

const summary = (over: Partial<FramesSummary> = {}): FramesSummary => ({
  count: 10,
  firstStep: 0,
  lastStep: 90,
  firstTimeS: 0,
  lastTimeS: 9e-12,
  truncated: false,
  stages: [{ stageId: "run", count: 10 }],
  ...over,
});
const render = (over: Partial<FramesSummary> = {}) =>
  renderToStaticMarkup(<FrameScrubber itemId="r1" loadPage={vi.fn()} summary={summary(over)} />);

describe("stepPosition", () => {
  it("moves one frame and stays inside the index", () => {
    expect(stepPosition(3, 10, "next")).toBe(4);
    expect(stepPosition(3, 10, "previous")).toBe(2);
    expect(stepPosition(0, 10, "previous")).toBe(0);
    expect(stepPosition(9, 10, "next")).toBe(9);
    expect(stepPosition(5, 10, "first")).toBe(0);
    expect(stepPosition(5, 10, "last")).toBe(9);
  });

  it("is zero for an empty index and clamps a stale position", () => {
    expect(stepPosition(4, 0, "next")).toBe(0);
    expect(stepPosition(40, 10, "previous")).toBe(8);
  });
});

describe("pageProblem", () => {
  it("accepts an indexed page and explains an unindexed one", () => {
    expect(pageProblem({ indexed: true, total: 1, from: 0, frames: [], truncated: false })).toBeNull();
    expect(pageProblem({ indexed: false, total: 0, from: 0, frames: [], truncated: false })).toMatch(
      /no saved frames/,
    );
  });
});

describe("FrameScrubber markup", () => {
  it("is a labelled range slider with prev/next and says it is an index, not images", () => {
    const html = render();
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="Saved frame"');
    expect(html).toContain('max="9"');
    expect(html).toContain('min="0"');
    expect(html).toContain('aria-label="Previous frame"');
    expect(html).toContain('aria-label="Next frame"');
    expect(html).toContain(FRAME_INDEX_NOTE);
    expect(html).toContain("No image is rendered per frame");
    expect(html).not.toContain("<img");
  });

  it("starts at the first frame with no invented step or time", () => {
    const html = render();
    expect(html).toContain("frame 1 of 10 · reading the index…");
    expect(html).toContain("disabled");
    expect(html).not.toContain("t = ");
  });

  it("says so for an empty index and notes truncation", () => {
    expect(render({ count: 0 })).toContain("The frame index lists no frames.");
    expect(render({ truncated: true })).toContain("entry limit");
    expect(render({ note: "final: frames.json has an unknown schema" })).toContain("unknown schema");
  });
});
