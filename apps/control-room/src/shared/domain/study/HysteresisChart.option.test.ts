import { describe, expect, it } from "vitest";

import {
  buildHysteresisChartOption,
  HYSTERESIS_CHART_SET_OPTION_OPTS,
  type HysteresisChartColors,
  type HysteresisChartOptionInput,
} from "./HysteresisChart";

const colors: HysteresisChartColors = {
  active: "#a",
  axis: "#b",
  border: "#c",
  branchAscending: "#d",
  branchDescending: "#e",
  metric: "#f",
  remanence: "#g",
  surface: "#h",
  text: "#i",
  textMuted: "#j",
};

function points(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    field_value_mT: 100 - index * 5,
    m_avg: [0, 0.99 - index * 0.001, 0],
    m_ip: 0.99 - index * 0.001,
    m_oop: 0,
    m_parallel: 0.99 - index * 0.001,
    point_id: index,
    snapshot_id: null,
    status: "Completed",
  }));
}

function input(overrides: Partial<HysteresisChartOptionInput> = {}): HysteresisChartOptionInput {
  return {
    activePoint: null,
    angularFamily: null,
    branchMode: null,
    branches: [],
    colors,
    formatXValue: (value) => value,
    liveFieldValue: null,
    liveSweep: false,
    liveYValue: null,
    metrics: null,
    minorLoops: [],
    points: points(6),
    preserveZoomWindow: false,
    viewMode: "full",
    xAxisUnit: "mT",
    yAxisKey: "m_parallel",
    ...overrides,
  };
}

function seriesOf(option: ReturnType<typeof buildHysteresisChartOption>) {
  return option.series as Array<Record<string, unknown>>;
}

describe("buildHysteresisChartOption", () => {
  it("is a pure function of its input", () => {
    const source = input({ liveFieldValue: 75, liveYValue: 0.985 });
    const snapshot = JSON.stringify(source.points);
    const first = buildHysteresisChartOption(source);
    const second = buildHysteresisChartOption(source);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(source.points)).toBe(snapshot);
  });

  it("gives every series a stable id so the reused instance can merge by id", () => {
    const option = buildHysteresisChartOption(
      input({ liveFieldValue: 75, liveYValue: 0.985 }),
    );
    const ids = seriesOf(option).map((series) => series.id);

    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("hysteresis-live-field");
    expect(HYSTERESIS_CHART_SET_OPTION_OPTS.replaceMerge).toEqual(["series"]);
  });

  it("switches the live marker id when a point is selected", () => {
    const sourcePoints = points(6);
    const option = buildHysteresisChartOption(
      input({ activePoint: sourcePoints[2], points: sourcePoints }),
    );
    const ids = seriesOf(option).map((series) => series.id);

    expect(ids).toContain("hysteresis-active-point");
    expect(ids).not.toContain("hysteresis-live-field");
  });

  it("clears absent markers explicitly instead of leaving merged leftovers", () => {
    const option = buildHysteresisChartOption(input());
    const line = seriesOf(option)[0];

    expect(line.markPoint).toEqual({ data: [] });
    expect(line.markLine).toEqual({ data: [] });
  });

  it("applies live updates without update tweening", () => {
    expect(buildHysteresisChartOption(input({ liveSweep: true })).animationDurationUpdate).toBe(0);
    expect(buildHysteresisChartOption(input({ liveSweep: false })).animationDurationUpdate).toBeGreaterThan(0);
  });

  it("keeps the user's zoom window on updates of an existing instance", () => {
    const initial = buildHysteresisChartOption(input()).dataZoom as Array<Record<string, unknown>>;
    const update = buildHysteresisChartOption(input({ preserveZoomWindow: true }))
      .dataZoom as Array<Record<string, unknown>>;

    expect(initial.every((entry) => entry.start === 0 && entry.end === 100)).toBe(true);
    expect(update.every((entry) => !("start" in entry) && !("end" in entry))).toBe(true);
    expect(update.map((entry) => entry.type)).toEqual(initial.map((entry) => entry.type));
  });
});
