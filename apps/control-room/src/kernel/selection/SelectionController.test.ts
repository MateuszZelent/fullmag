import { describe, expect, it, vi } from "vitest";

import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";

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
});
