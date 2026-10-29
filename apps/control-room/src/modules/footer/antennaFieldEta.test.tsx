import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "@/kernel/layout/simulationPreparationTestDom.test-support";

import {
  ANTENNA_ETA_WINDOW_SIZE,
  estimateAntennaFieldEta,
  formatAntennaFieldEta,
  observeAntennaEta,
  useAntennaFieldEta,
  type AntennaEtaHistory,
  type AntennaEtaObservation,
} from "./antennaFieldEta";

const empty = (): AntennaEtaHistory => ({
  identity: null, total: 0, lastCompleted: 0, lastElapsed: 0, records: [],
});
const observation = (
  completed: number, elapsedSeconds: number, identity = "session/epoch/scope/run/stage", total = 20,
): AntennaEtaObservation => ({ completed, elapsedSeconds, identity, total });

function history(...observations: AntennaEtaObservation[]) {
  return observations.reduce((current, next) => observeAntennaEta(current, next), empty());
}

describe("antenna field ETA", () => {
  it("excludes source preparation and late-join completed work from the observed delta", () => {
    const baseline = observation(500, 7_000, "scope/run/stage", 1_145);
    const current = observation(503, 7_030, baseline.identity, baseline.total);
    const estimate = estimateAntennaFieldEta(history(baseline, current), current);
    expect(estimate).toEqual({ state: "ready", seconds: 6_420 });
  });

  it("requires three newly completed targets and at least ten observed seconds", () => {
    for (const current of [observation(2, 20), observation(3, 9), observation(0, 100)]) {
      expect(estimateAntennaFieldEta(history(observation(0, 0), current), current).state).toBe("estimating");
    }
    const current = observation(3, 10);
    expect(estimateAntennaFieldEta(history(observation(0, 0), current), current).state).toBe("ready");
  });

  it("revises the estimate as a slow current target accumulates elapsed pulses", () => {
    let current = observation(3, 30);
    let samples = history(observation(0, 0), observation(1, 3), observation(2, 9), current);
    expect(estimateAntennaFieldEta(samples, current)).toEqual({ state: "ready", seconds: 170 });
    current = observation(3, 60);
    samples = observeAntennaEta(samples, current);
    expect(estimateAntennaFieldEta(samples, current)).toEqual({ state: "ready", seconds: 340 });
    expect(samples.records).toHaveLength(4);
    current = observation(4, 66);
    samples = observeAntennaEta(samples, current);
    expect(estimateAntennaFieldEta(samples, current)).toEqual({ state: "ready", seconds: 264 });
  });

  it("bounds completion history while pulses never consume the window", () => {
    let samples = history(observation(0, 0, "identity", 10_000));
    for (let completed = 1; completed <= 100; completed += 1) {
      samples = observeAntennaEta(samples, observation(completed, completed * 10, "identity", 10_000));
    }
    expect(samples.records).toHaveLength(ANTENNA_ETA_WINDOW_SIZE);
    const records = samples.records;
    for (let pulse = 1; pulse <= 1_000; pulse += 1) {
      samples = observeAntennaEta(samples, observation(100, 1_000 + pulse, "identity", 10_000));
    }
    expect(samples.records).toBe(records);
    expect(samples.lastElapsed).toBe(2_000);
  });

  it.each([
    observation(3, 30, "other/session/run/stage"),
    observation(2, 40),
    observation(3, 29),
    observation(3, 30, undefined, 21),
  ])("resets on identity, count, clock or total regression/change: %j", (current) => {
    const samples = observeAntennaEta(history(observation(0, 0), observation(3, 30)), current);
    expect(samples.records).toHaveLength(1);
    expect(estimateAntennaFieldEta(samples, current).state).toBe("estimating");
  });

  it.each([
    null,
    { ...observation(3, 30), completed: -1 },
    { ...observation(3, 30), completed: 21 },
    { ...observation(3, 30), completed: Number.NaN },
    { ...observation(3, 30), elapsedSeconds: Number.POSITIVE_INFINITY },
    { ...observation(3, 30), total: 0 },
    { ...observation(3, 30), identity: "" },
  ])("drops invalid or inactive observations without a stale estimate: %j", (current) => {
    const samples = observeAntennaEta(history(observation(0, 0), observation(3, 30)), current);
    expect(samples.records).toHaveLength(0);
    expect(estimateAntennaFieldEta(samples, current)).toEqual({ state: "inactive", seconds: null });
  });

  it("does not convert N/N into an overall-stage zero ETA", () => {
    const current = observation(20, 200);
    expect(estimateAntennaFieldEta(history(observation(0, 0), current), current))
      .toEqual({ state: "complete", seconds: null });
  });

  it("does not publish infinite or overflowing estimates", () => {
    const current = observation(3, Number.MAX_VALUE);
    expect(estimateAntennaFieldEta(history(observation(0, 0), current), current).state).toBe("estimating");
  });

  it.each([
    [5.1, "~6 s"], [59.5, "~60 s"], [61, "~2 min"], [721, "~13 min"],
    [3_600, "~1 h"], [4_801, "~1 h 21 min"],
  ])("formats %s seconds without false millisecond precision", (seconds, label) => {
    expect(formatAntennaFieldEta(seconds as number)).toBe(label);
  });
});

function Probe({ sample, onRender }: { sample: AntennaEtaObservation | null; onRender?: () => void }) {
  onRender?.();
  const eta = useAntennaFieldEta(sample);
  return <output data-state={eta.state}>{eta.seconds === null ? "" : formatAntennaFieldEta(eta.seconds)}</output>;
}

describe("mounted antenna ETA history", () => {
  it("starts identically in SSR and computes only observed current-identity deltas without timers", async () => {
    const baseline = observation(10, 1_000);
    const ssr = renderToStaticMarkup(<Probe sample={baseline} />);
    expect(ssr).toContain('data-state="estimating"');
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const interval = vi.spyOn(globalThis, "setInterval");
    let renders = 0;
    const render = async (sample: AntennaEtaObservation | null) => {
      const before = renders;
      await act(async () => root.render(<Probe sample={sample} onRender={() => { renders += 1; }} />));
      expect(renders - before).toBeLessThanOrEqual(2);
    };
    try {
      await render(baseline);
      expect(container.querySelector("output")?.getAttribute("data-state")).toBe("estimating");
      await render(observation(13, 1_030));
      expect(container.textContent).toBe("~2 min");
      await render(observation(13, 1_060));
      expect(container.textContent).toBe("~3 min");
      await render(observation(13, 1_060, "new/session/run/stage"));
      expect(container.querySelector("output")?.getAttribute("data-state")).toBe("estimating");
      expect(container.textContent).toBe("");
      await render(observation(20, 1_100, "new/session/run/stage"));
      expect(container.querySelector("output")?.getAttribute("data-state")).toBe("complete");
      await render(null);
      expect(container.querySelector("output")?.getAttribute("data-state")).toBe("inactive");
      expect(container.textContent).toBe("");
      expect(interval).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      interval.mockRestore();
      dom.restore();
    }
  });
});
