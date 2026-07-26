import { describe, expect, it, vi } from "vitest";
import { ChartViewportHandoffController } from "./ChartViewportHandoffController";

const handoff = (fieldId: string) => ({
  commandId: "analysis.chart.load-in-3d",
  fieldRef: { fieldId, resourceKey: `data/fields/${fieldId}` },
  selection: { resourceKey: "analysis/frequency", rowIds: ["7"], semanticTarget: fieldId },
});

describe("ChartViewportHandoffController", () => {
  it("adopts only a completed current handoff and cancels superseded work", async () => {
    const controller = new ChartViewportHandoffController();
    const adoptFirst = vi.fn();
    const adoptSecond = vi.fn();
    let resolveFirst!: (value: string) => void;
    const first = controller.run(
      handoff("first"),
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
      adoptFirst,
    );
    const second = controller.run(
      handoff("second"),
      async () => "second-buffer",
      adoptSecond,
    );
    resolveFirst("stale-buffer");

    await expect(first).resolves.toBe("cancelled");
    await expect(second).resolves.toBe("completed");
    expect(adoptFirst).not.toHaveBeenCalled();
    expect(adoptSecond).toHaveBeenCalledWith("second-buffer");
    expect(controller.getSnapshot()).toMatchObject({ status: "completed", handoff: { fieldRef: { fieldId: "second" } } });
  });

  it("never adopts explicitly aborted work", async () => {
    const controller = new ChartViewportHandoffController();
    const adopt = vi.fn();
    let resolve!: (value: string) => void;
    const result = controller.run(
      handoff("field"),
      () => new Promise<string>((done) => { resolve = done; }),
      adopt,
    );
    controller.cancel();
    resolve("buffer");
    await expect(result).resolves.toBe("cancelled");
    expect(adopt).not.toHaveBeenCalled();
    expect(controller.getSnapshot().status).toBe("cancelled");
  });
});
