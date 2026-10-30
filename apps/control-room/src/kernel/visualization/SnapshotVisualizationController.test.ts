import { describe, expect, it } from "vitest";

import {
  MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS,
  SnapshotVisualizationController,
  snapshotVisualizationKey,
  type SnapshotVisualizationIdentity,
} from "./SnapshotVisualizationController";

describe("SnapshotVisualizationController", () => {
  it("starts with a stable live snapshot and default appearance", () => {
    const controller = new SnapshotVisualizationController();
    const initial = controller.getSnapshot();

    expect(initial).toEqual({ activeKey: null, definitions: {} });
    expect(controller.getSnapshot()).toBe(initial);

    const identity = snapshotIdentity("quantity-m");
    expect(controller.select(identity)).toBe(true);
    const key = snapshotVisualizationKey(identity);
    expect(controller.getSnapshot().definitions[key]).toEqual({
      identity,
      appearance: {
        component: "z",
        palette: "coolwarm",
        visible: true,
        rangeMode: "auto",
        min: null,
        max: null,
      },
    });
  });

  it("retains independent appearance settings for distinct snapshots", () => {
    const controller = new SnapshotVisualizationController();
    const first = snapshotIdentity("quantity-m", 0, "revision-1");
    const second = snapshotIdentity("quantity-h", 1, "revision-1");

    expect(controller.select(first)).toBe(true);
    const firstKey = snapshotVisualizationKey(first);
    expect(
      controller.updateAppearance(firstKey, {
        component: "x",
        palette: "viridis",
        visible: false,
        rangeMode: "manual",
        min: -2,
        max: 2,
      }),
    ).toBe(true);

    expect(controller.select(second)).toBe(true);
    const secondKey = snapshotVisualizationKey(second);
    expect(controller.getSnapshot().definitions[secondKey]?.appearance).toEqual({
      component: "z",
      palette: "coolwarm",
      visible: true,
      rangeMode: "auto",
      min: null,
      max: null,
    });

    expect(controller.select(first)).toBe(true);
    expect(controller.getSnapshot().activeKey).toBe(firstKey);
    expect(controller.getSnapshot().definitions[firstKey]?.appearance).toEqual({
      component: "x",
      palette: "viridis",
      visible: false,
      rangeMode: "manual",
      min: -2,
      max: 2,
    });
  });

  it("inherits appearance across revisions without changing the active viewport", () => {
    const controller = new SnapshotVisualizationController();
    const olderRevision = snapshotIdentity("quantity-m", 3, "revision-1");
    const newerRevision = { ...olderRevision, revision: "revision-2" };
    const nextRevision = { ...olderRevision, revision: "revision-3" };
    const olderKey = snapshotVisualizationKey(olderRevision);
    const newerKey = snapshotVisualizationKey(newerRevision);
    const nextKey = snapshotVisualizationKey(nextRevision);

    expect(controller.select(olderRevision)).toBe(true);
    expect(controller.updateAppearance(olderKey, { palette: "viridis" })).toBe(true);

    expect(controller.ensureDefinition(newerRevision)).toBe(true);
    expect(controller.getSnapshot().activeKey).toBe(olderKey);
    const newerDefinition = controller.getSnapshot().definitions[newerKey];
    expect(newerDefinition?.identity.revision).toBe("revision-2");
    expect(newerDefinition?.appearance.palette).toBe("viridis");

    expect(controller.updateAppearance(newerKey, { palette: "plasma" })).toBe(true);
    expect(controller.getSnapshot().definitions[olderKey]?.appearance.palette).toBe("viridis");
    expect(controller.ensureDefinition(nextRevision)).toBe(true);
    expect(controller.getSnapshot().definitions[nextKey]?.appearance.palette).toBe("plasma");
    expect(controller.getSnapshot().activeKey).toBe(olderKey);
  });

  it("isolates inherited appearance by logical identity fields", () => {
    const controller = new SnapshotVisualizationController();
    const identity = {
      ...snapshotIdentity("quantity-m", 3, "revision-1"),
      runId: "run-1|session=session-1",
    };
    const newerRevision = { ...identity, revision: "revision-2" };
    const key = snapshotVisualizationKey(identity);

    expect(controller.ensureDefinition(identity)).toBe(true);
    expect(controller.updateAppearance(key, { palette: "viridis" })).toBe(true);
    expect(controller.ensureDefinition(newerRevision)).toBe(true);
    const newerDefinition =
      controller.getSnapshot().definitions[snapshotVisualizationKey(newerRevision)];
    expect(newerDefinition?.appearance.palette).toBe("viridis");

    const isolatedIdentities = [
      { ...newerRevision, runId: "run-2|session=session-1" },
      { ...newerRevision, runId: "run-1|session=session-2" },
      { ...newerRevision, stageId: "stage-2" },
      { ...newerRevision, datasetId: "source-dataset-2" },
      { ...newerRevision, quantityId: "quantity-h" },
      { ...newerRevision, sampleIndex: 4 },
    ];
    for (const isolated of isolatedIdentities) {
      expect(controller.ensureDefinition(isolated)).toBe(true);
      const definition =
        controller.getSnapshot().definitions[snapshotVisualizationKey(isolated)];
      expect(definition?.appearance.palette).toBe("coolwarm");
    }
  });

  it("returns to live without dropping retained snapshot settings", () => {
    const controller = new SnapshotVisualizationController();
    const identity = snapshotIdentity("quantity-m");
    const key = snapshotVisualizationKey(identity);
    controller.select(identity);
    controller.updateAppearance(key, { palette: "magma" });
    const definitions = controller.getSnapshot().definitions;

    expect(controller.returnToLive()).toBe(true);
    expect(controller.getSnapshot()).toEqual({
      activeKey: null,
      definitions,
    });
    expect(controller.getSnapshot().definitions).toBe(definitions);

    expect(controller.select(identity)).toBe(true);
    expect(controller.getSnapshot().definitions[key]?.appearance.palette).toBe("magma");
    expect(controller.returnToLive()).toBe(true);

    const newerRevision = { ...identity, revision: "revision-2" };
    expect(controller.ensureDefinition(newerRevision)).toBe(true);
    expect(controller.getSnapshot().activeKey).toBeNull();
    expect(
      controller.getSnapshot().definitions[snapshotVisualizationKey(newerRevision)]?.appearance.palette,
    ).toBe("magma");
  });

  it("restores the preferred sample for one logical series without activating it", () => {
    const controller = new SnapshotVisualizationController();
    const displayed = snapshotIdentity("quantity-m", 5, "revision-1");
    const sameSeries = snapshotIdentity("quantity-m", 0, "revision-1");
    const otherRun = { ...sameSeries, runId: "run-2" };
    const otherStage = { ...sameSeries, stageId: "stage-2" };
    const otherDataset = { ...sameSeries, datasetId: "dataset-2" };
    const otherQuantity = { ...sameSeries, quantityId: "quantity-h" };
    const otherRevision = snapshotIdentity("quantity-m", 0, "revision-2");

    expect(controller.rememberSampleIndex(sameSeries)).toBe(true);
    expect(controller.getPreferredSampleIndex(sameSeries)).toBe(0);
    expect(controller.getPreferredSampleIndex(otherRevision)).toBe(0);
    expect(controller.getPreferredSampleIndex(otherRun)).toBeNull();
    expect(controller.getPreferredSampleIndex(otherStage)).toBeNull();
    expect(controller.getPreferredSampleIndex(otherDataset)).toBeNull();
    expect(controller.getPreferredSampleIndex(otherQuantity)).toBeNull();
    expect(controller.getSnapshot().activeKey).toBeNull();

    expect(controller.select(displayed)).toBe(true);
    expect(controller.getPreferredSampleIndex(sameSeries)).toBe(5);
    expect(controller.getPreferredSampleIndex(otherRevision)).toBe(5);

    const newerRevisionSelection = snapshotIdentity("quantity-m", 2, "revision-2");
    expect(controller.rememberSampleIndex(newerRevisionSelection)).toBe(true);
    expect(controller.getPreferredSampleIndex(otherRevision)).toBe(2);
    expect(controller.getSnapshot().activeKey).toBe(snapshotVisualizationKey(displayed));

    controller.returnToLive();
    expect(controller.getPreferredSampleIndex(sameSeries)).toBe(2);
  });

  it("keeps source revisions and delimiter-containing identities distinct", () => {
    const controller = new SnapshotVisualizationController();
    const revisionOne = snapshotIdentity("quantity", 0, "revision-1");
    const revisionTwo = snapshotIdentity("quantity", 0, "revision-2");
    const delimiterLeft: SnapshotVisualizationIdentity = {
      runId: "run:dataset",
      stageId: "stage",
      datasetId: "revision",
      quantityId: "quantity",
      sampleIndex: 0,
      revision: "revision",
    };
    const delimiterRight: SnapshotVisualizationIdentity = {
      runId: "run",
      stageId: "stage",
      datasetId: "dataset:revision",
      quantityId: "quantity",
      sampleIndex: 0,
      revision: "revision",
    };

    expect(snapshotVisualizationKey(delimiterLeft)).not.toBe(
      snapshotVisualizationKey(delimiterRight),
    );
    expect(controller.select(revisionOne)).toBe(true);
    expect(controller.select(revisionTwo)).toBe(true);
    expect(controller.select(delimiterLeft)).toBe(true);
    expect(controller.select(delimiterRight)).toBe(true);
    expect(controller.updateAppearance(snapshotVisualizationKey(delimiterLeft), {
      palette: "viridis",
    })).toBe(true);
    const nextDelimiterLeft = { ...delimiterLeft, revision: "revision-2" };
    const nextDelimiterRight = { ...delimiterRight, revision: "revision-2" };
    expect(controller.ensureDefinition(nextDelimiterLeft)).toBe(true);
    expect(controller.ensureDefinition(nextDelimiterRight)).toBe(true);
    expect(
      controller.getSnapshot().definitions[snapshotVisualizationKey(nextDelimiterLeft)]?.appearance.palette,
    ).toBe("viridis");
    expect(
      controller.getSnapshot().definitions[snapshotVisualizationKey(nextDelimiterRight)]?.appearance.palette,
    ).toBe("coolwarm");
    expect(Object.keys(controller.getSnapshot().definitions)).toHaveLength(6);
  });

  it("rejects invalid or no-op appearance updates without notifying", () => {
    const controller = new SnapshotVisualizationController();
    const identity = snapshotIdentity("quantity-m");
    const key = snapshotVisualizationKey(identity);
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    expect(controller.updateAppearance(key, { palette: "viridis" })).toBe(false);
    expect(controller.select(identity)).toBe(true);
    expect(notifications).toBe(1);

    const invalidPatches = [
      { component: "bad" },
      { palette: "" },
      { palette: "   " },
      { palette: "x".repeat(129) },
      { visible: "yes" },
      { rangeMode: "bad" },
      { min: Number.NaN },
      { max: Number.POSITIVE_INFINITY },
      { rangeMode: "manual", min: null, max: 1 },
      { rangeMode: "manual", min: 2, max: 1 },
      { rangeMode: "manual", min: 1, max: 1 },
    ] as const;

    for (const patch of invalidPatches) {
      expect(controller.updateAppearance(key, patch as never)).toBe(false);
    }
    expect(controller.updateAppearance(key, { component: "z" })).toBe(false);
    expect(controller.updateAppearance("unknown", { component: "x" })).toBe(false);
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("does not notify for repeated selections or live returns, and unsubscribes cleanly", () => {
    const controller = new SnapshotVisualizationController();
    const identity = snapshotIdentity("quantity-m");
    let notifications = 0;
    const unsubscribe = controller.subscribe(() => {
      notifications += 1;
    });

    expect(controller.returnToLive()).toBe(false);
    expect(controller.select(identity)).toBe(true);
    expect(controller.select(identity)).toBe(false);
    expect(controller.returnToLive()).toBe(true);
    expect(controller.returnToLive()).toBe(false);
    expect(notifications).toBe(2);

    unsubscribe();
    expect(controller.select(identity)).toBe(true);
    expect(controller.clear()).toBe(true);
    expect(notifications).toBe(2);
    expect(controller.clear()).toBe(false);
  });

  it("bounds scrub history while restoring edited settings after eviction", () => {
    const controller = new SnapshotVisualizationController();

    for (let sampleIndex = 0; sampleIndex < MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS; sampleIndex += 1) {
      expect(controller.select(snapshotIdentity("quantity-m", sampleIndex))).toBe(true);
    }

    const editedIdentity = snapshotIdentity("quantity-m", 1);
    const editedKey = snapshotVisualizationKey(editedIdentity);
    expect(controller.select(editedIdentity)).toBe(true);
    expect(controller.updateAppearance(editedKey, { palette: "plasma" })).toBe(true);

    for (let sampleIndex = MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS;
      sampleIndex < MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS * 2;
      sampleIndex += 1) {
      expect(controller.select(snapshotIdentity("quantity-m", sampleIndex))).toBe(true);
    }
    expect(Object.keys(controller.getSnapshot().definitions)).toHaveLength(
      MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS,
    );
    expect(controller.select(editedIdentity)).toBe(true);
    expect(controller.getSnapshot().activeKey).toBe(editedKey);
    expect(controller.getSnapshot().definitions[editedKey]?.appearance.palette).toBe("plasma");

    const defaultIdentity = snapshotIdentity("quantity-m", 0);
    const defaultKey = snapshotVisualizationKey(defaultIdentity);
    expect(controller.select(defaultIdentity)).toBe(true);
    expect(controller.getSnapshot().definitions[defaultKey]?.appearance).toEqual({
      component: "z",
      palette: "coolwarm",
      visible: true,
      rangeMode: "auto",
      min: null,
      max: null,
    });
  });

  it("bounds Inspector-only sample preferences", () => {
    const controller = new SnapshotVisualizationController();
    const first = snapshotIdentity("quantity-m", 1, "revision-1");

    for (let datasetIndex = 0; datasetIndex < MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS; datasetIndex += 1) {
      expect(controller.rememberSampleIndex({
        ...first,
        datasetId: `dataset-${datasetIndex}`,
        sampleIndex: datasetIndex,
      })).toBe(true);
    }

    const newest = {
      ...first,
      datasetId: "dataset-newest",
      sampleIndex: 99,
    };
    expect(controller.rememberSampleIndex(newest)).toBe(true);
    expect(controller.getPreferredSampleIndex({
      ...first,
      datasetId: "dataset-0",
      revision: "revision-2",
    })).toBeNull();
    expect(controller.getPreferredSampleIndex({
      ...first,
      datasetId: "dataset-1",
      revision: "revision-2",
    })).toBe(1);
    expect(
      controller.getPreferredSampleIndex({ ...newest, revision: "revision-2" }),
    ).toBe(99);
  });

  it("bounds cross-revision appearance preferences and clears them on session reset", () => {
    const controller = new SnapshotVisualizationController();

    for (let index = 0; index < MAX_SNAPSHOT_VISUALIZATION_DEFINITIONS; index += 1) {
      const identity = {
        ...snapshotIdentity("quantity-m", index, "revision-1"),
        datasetId: `dataset-${index}`,
      };
      expect(controller.ensureDefinition(identity)).toBe(true);
      expect(controller.updateAppearance(snapshotVisualizationKey(identity), {
        palette: `palette-${index}`,
      })).toBe(true);
    }

    const newest = {
      ...snapshotIdentity("quantity-m", 0, "revision-1"),
      datasetId: "dataset-newest",
    };
    expect(controller.ensureDefinition(newest)).toBe(true);
    expect(
      controller.updateAppearance(snapshotVisualizationKey(newest), {
        palette: "plasma",
      }),
    ).toBe(true);

    const evictedRevision = {
      ...snapshotIdentity("quantity-m", 0, "revision-2"),
      datasetId: "dataset-0",
    };
    expect(controller.ensureDefinition(evictedRevision)).toBe(true);
    const evictedDefinition =
      controller.getSnapshot().definitions[snapshotVisualizationKey(evictedRevision)];
    expect(evictedDefinition?.appearance.palette).toBe("coolwarm");

    const retainedRevision = { ...newest, revision: "revision-2" };
    expect(controller.ensureDefinition(retainedRevision)).toBe(true);
    const retainedDefinition =
      controller.getSnapshot().definitions[snapshotVisualizationKey(retainedRevision)];
    expect(retainedDefinition?.appearance.palette).toBe("plasma");

    expect(controller.clear()).toBe(true);
    const afterClear = { ...newest, revision: "revision-3" };
    expect(controller.ensureDefinition(afterClear)).toBe(true);
    const clearedDefinition =
      controller.getSnapshot().definitions[snapshotVisualizationKey(afterClear)];
    expect(clearedDefinition?.appearance.palette).toBe("coolwarm");
  });

  it("clears definitions only when the caller explicitly resets the session", () => {
    const controller = new SnapshotVisualizationController();
    const identity = snapshotIdentity("quantity-m");
    const key = snapshotVisualizationKey(identity);
    controller.select(identity);
    controller.updateAppearance(key, { visible: false });

    expect(controller.clear()).toBe(true);
    expect(controller.getSnapshot()).toEqual({ activeKey: null, definitions: {} });
    expect(controller.updateAppearance(key, { visible: true })).toBe(false);
    const newerRevision = { ...identity, revision: "revision-2" };
    expect(controller.ensureDefinition(newerRevision)).toBe(true);
    expect(
      controller.getSnapshot().definitions[snapshotVisualizationKey(newerRevision)]?.appearance.palette,
    ).toBe("coolwarm");
    expect(controller.clear()).toBe(true);
    expect(controller.clear()).toBe(false);
  });

  it("clears Inspector-only sample preferences without definitions", () => {
    const controller = new SnapshotVisualizationController();
    const identity = snapshotIdentity("quantity-m", 5);

    expect(controller.rememberSampleIndex(identity)).toBe(true);
    expect(controller.getPreferredSampleIndex(identity)).toBe(5);
    expect(controller.clear()).toBe(true);
    expect(controller.getPreferredSampleIndex(identity)).toBeNull();
    expect(controller.clear()).toBe(false);
  });
});

function snapshotIdentity(
  quantityId: string,
  sampleIndex = 0,
  revision = "revision-1",
): SnapshotVisualizationIdentity {
  return {
    runId: "run-1",
    stageId: "stage-1",
    datasetId: "dataset-1",
    quantityId,
    sampleIndex,
    revision,
  };
}
