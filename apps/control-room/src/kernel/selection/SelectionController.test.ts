import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import {
  LIVE_CHART_SELECTION_IDENTITY_MAX_LENGTH,
  readLegacyLiveChartSelectionIdentity,
  parseLiveChartSelectionIdentity,
  serializeLiveChartSelectionIdentity,
} from "./selectionTypes";

import { SelectionController } from "./SelectionController";

function setup() {
  const bus = new EventBus<KernelEventMap>();
  const controller = new SelectionController(bus);
  return { bus, controller };
}

describe("SelectionController", () => {
  it("starts with empty selection", () => {
    const { controller } = setup();
    const sel = controller.get();
    expect(sel.objectId).toBeNull();
    expect(sel.nodeId).toBeNull();
    expect(sel.moduleSource).toBeNull();
  });

  it("set() updates state and records source module", () => {
    const { controller } = setup();
    controller.set({ objectId: "body-1" }, "explorer");
    expect(controller.get().objectId).toBe("body-1");
    expect(controller.get().moduleSource).toBe("explorer");
  });

  it("set() emits workspace:selection-changed on the bus", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    bus.on("workspace:selection-changed", listener);

    controller.set({ objectId: "body-2" }, "viewport");
    expect(listener).toHaveBeenCalledWith({
      selectionId: "body-2",
      source: "viewport",
    });
  });

  it("set() does not emit when nothing changes", () => {
    const { bus, controller } = setup();
    controller.set({ objectId: "body-1" }, "explorer");

    const listener = vi.fn();
    bus.on("workspace:selection-changed", listener);

    controller.set({ objectId: "body-1" }, "explorer");
    expect(listener).not.toHaveBeenCalled();
  });

  it("compares analysis chart point refs before emitting selection events", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    const pointSelection = {
      kind: "analysis.chart-point",
      label: "mx 0.2",
      nodeId: "analysis:charts:default:point:data.table:default:step:mx:1",
      objectId: null,
      ref: {
        chartId: "default",
        kind: "analysis.chart-point" as const,
        nodeId: "analysis:charts:default:point:data.table:default:step:mx:1",
        quantity: "mx",
        rowIndex: 1,
        seriesId: "data.table:default:step:mx",
        tableId: "default",
        type: "analysis-chart-point" as const,
        x: 2,
        y: 0.2,
      },
    };

    controller.set(pointSelection, "analysis-plots");
    bus.on("workspace:selection-changed", listener);
    controller.set(pointSelection, "analysis-plots");

    expect(listener).not.toHaveBeenCalled();
  });

  it("treats a Live Chart point revision as part of selection identity", () => {
    const { bus, controller } = setup();
    const listener = vi.fn();
    const livePoint = {
      kind: "live.chart-point",
      label: "mx 0.2",
      nodeId: "live:chart:magnetization:point:mx:1:7",
      objectId: null,
      ref: {
        descriptorId: "magnetization",
        kind: "live.chart-point",
        nodeId: "live:chart:magnetization:point:mx:1:7",
        pointIndex: 1,
        revision: 7,
        seriesId: "mx",
        type: "live-chart-point",
      },
    } as const;

    controller.set(livePoint, "live-charts");
    bus.on("workspace:selection-changed", listener);
    controller.set(livePoint, "live-charts");
    controller.set(
      {
        ...livePoint,
        ref: { ...livePoint.ref, revision: 8 },
      },
      "live-charts",
    );

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("parses only bounded current live chart identities and serializes canonically", () => {
    const parsed = parseLiveChartSelectionIdentity("live:chart:custom%20signal");

    expect(parsed).toEqual({ descriptorId: "custom signal", kind: "live.chart" });
    expect(serializeLiveChartSelectionIdentity(parsed!)).toBe(
      "live:chart:custom%20signal",
    );
    expect(parseLiveChartSelectionIdentity("analysis:charts:default")).toBeNull();
    expect(parseLiveChartSelectionIdentity("analysis:charts:frequency-domain:run-1")).toBeNull();
    expect(parseLiveChartSelectionIdentity("live:chart:bad%ZZ")).toBeNull();
    expect(parseLiveChartSelectionIdentity(`live:chart:${"a".repeat(LIVE_CHART_SELECTION_IDENTITY_MAX_LENGTH)}`)).toBeNull();
    expect(serializeLiveChartSelectionIdentity({ descriptorId: "bad/id", kind: "live.chart" })).toBeNull();
  });

  it("reads the one legacy live identity only through the explicit migration context", () => {
    expect(
      readLegacyLiveChartSelectionIdentity(
        "analysis:charts:default",
        "legacy-live-preference",
      ),
    ).toEqual({ descriptorId: "default", kind: "live.chart" });
    expect(
      readLegacyLiveChartSelectionIdentity(
        "analysis:charts:frequency-domain:run-1",
        "legacy-live-preference",
      ),
    ).toBeNull();
    expect(
      readLegacyLiveChartSelectionIdentity(
        "analysis:charts:default",
        "current-selection",
      ),
    ).toBeNull();
  });

  it("clear() resets to null", () => {
    const { controller } = setup();
    controller.set({ objectId: "body-1", nodeId: "node-1" }, "explorer");
    controller.clear("explorer");

    expect(controller.get().objectId).toBeNull();
    expect(controller.get().nodeId).toBeNull();
  });

  it("subscribe() receives changes and returns unsubscribe", () => {
    const { controller } = setup();
    const listener = vi.fn();
    const unsub = controller.subscribe(listener);

    controller.set({ objectId: "body-3" }, "test");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: "body-3" }),
    );

    unsub();
    controller.set({ objectId: "body-4" }, "test");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lets a selection guard reject a change before state is updated", () => {
    const { bus, controller } = setup();
    controller.set({ kind: "object.material", nodeId: "material:a" }, "explorer");
    const eventListener = vi.fn();
    bus.on("workspace:selection-changed", eventListener);
    const guard = vi.fn(() => false);
    const removeGuard = controller.addChangeGuard(guard);

    controller.set({ kind: "object.mesh", nodeId: "mesh:b" }, "explorer");

    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "object.mesh", nodeId: "mesh:b" }),
      expect.objectContaining({ kind: "object.material", nodeId: "material:a" }),
      "explorer",
    );
    expect(controller.get()).toEqual(
      expect.objectContaining({ kind: "object.material", nodeId: "material:a" }),
    );
    expect(eventListener).not.toHaveBeenCalled();

    removeGuard();
    controller.set({ kind: "object.mesh", nodeId: "mesh:b" }, "explorer");
    expect(controller.get()).toEqual(
      expect.objectContaining({ kind: "object.mesh", nodeId: "mesh:b" }),
    );
  });
});
