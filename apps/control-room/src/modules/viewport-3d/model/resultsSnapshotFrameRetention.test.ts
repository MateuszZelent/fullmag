import { describe, expect, it } from "vitest";

import type { SnapshotVisualizationAppearance, SnapshotVisualizationIdentity } from "@/kernel/visualization/SnapshotVisualizationController";

import {
  canUseRetainedResultsSnapshotFrame,
  resultsSnapshotFrameAppearanceKey,
  resultsSnapshotFrameSeriesKey,
  ResultsSnapshotFrameRetentionStore,
  type RetainedResultsSnapshotFrame,
} from "./resultsSnapshotFrameRetention";

const identity = (overrides: Partial<SnapshotVisualizationIdentity> = {}): SnapshotVisualizationIdentity => ({
  runId: "run-1",
  stageId: "propagate",
  datasetId: "[\"current\",null,\"m\"]",
  quantityId: "m",
  sampleIndex: 0,
  revision: "rev-1",
  ...overrides,
});

const appearance = (overrides: Partial<SnapshotVisualizationAppearance> = {}): SnapshotVisualizationAppearance => ({
  component: "z",
  palette: "coolwarm",
  visible: true,
  rangeMode: "auto",
  min: null,
  max: null,
  ...overrides,
});

const seriesKey = resultsSnapshotFrameSeriesKey({
  sessionIdentityKey: "session-1",
  source: { kind: "current" },
  identity: identity(),
});
const appearanceKey = resultsSnapshotFrameAppearanceKey(appearance());
const frame: RetainedResultsSnapshotFrame = {
  seriesKey,
  appearanceKey,
  sampleIndex: 4,
  coordinateCaption: "Physical time 4 ns",
  legendComponent: "x",
  palette: "coolwarm",
  colors: new Float32Array([0.1, 0.2, 0.3]),
  range: { min: -1, max: 1 },
};

describe("results snapshot frame retention identity", () => {
  it("keeps samples in one series together but fences run, source, session, and revision changes", () => {
    expect(resultsSnapshotFrameSeriesKey({
      sessionIdentityKey: "session-1",
      source: { kind: "current" },
      identity: identity({ sampleIndex: 9 }),
    })).toBe(seriesKey);

    expect(resultsSnapshotFrameSeriesKey({
      sessionIdentityKey: "session-2",
      source: { kind: "current" },
      identity: identity(),
    })).not.toBe(seriesKey);
    expect(resultsSnapshotFrameSeriesKey({
      sessionIdentityKey: "session-1",
      source: { kind: "workspace", itemId: "7" },
      identity: identity(),
    })).not.toBe(seriesKey);
    expect(resultsSnapshotFrameSeriesKey({
      sessionIdentityKey: "session-1",
      source: { kind: "current" },
      identity: identity({ runId: "run-2", revision: "rev-2" }),
    })).not.toBe(seriesKey);
  });

  it("allows a different requested sample but fences same-sample and hidden frames", () => {
    expect(canUseRetainedResultsSnapshotFrame(frame, seriesKey, true, 5)).toBe(true);
    expect(canUseRetainedResultsSnapshotFrame(
      frame,
      seriesKey,
      true,
      4,
    )).toBe(false);
    expect(canUseRetainedResultsSnapshotFrame(frame, seriesKey, false, 5)).toBe(false);
    expect(canUseRetainedResultsSnapshotFrame(frame, `${seriesKey}-other`, true, 5)).toBe(false);
  });

  it("retains one external-store frame and clears it without React state", () => {
    const store = new ResultsSnapshotFrameRetentionStore();
    const notifications: number[] = [];
    const unsubscribe = store.subscribe(() => notifications.push(1));

    expect(store.getSnapshot()).toBeNull();
    store.commit(frame);
    expect(store.getSnapshot()).toBe(frame);
    store.clear();
    expect(store.getSnapshot()).toBeNull();
    expect(notifications).toHaveLength(2);

    unsubscribe();
    store.commit(frame);
    expect(notifications).toHaveLength(2);
  });
});
