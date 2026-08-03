import { describe, expect, it } from "vitest";

import { liveChartsCommandRequests } from "./liveChartsCommandRequests";

describe("liveChartsCommandRequests", () => {
  it("publishes one durable fit revision until the mounted consumer unmounts", async () => {
    const unsubscribe = liveChartsCommandRequests.subscribe(() => undefined);
    expect(liveChartsCommandRequests.getFitRequestSnapshot()).toBe(0);

    const pending = liveChartsCommandRequests.request({ kind: "fit" });
    expect(liveChartsCommandRequests.getFitRequestSnapshot()).toBe(1);

    liveChartsCommandRequests.complete();
    await expect(pending).resolves.toBe("completed");
    expect(liveChartsCommandRequests.getFitRequestSnapshot()).toBe(1);

    unsubscribe();
    expect(liveChartsCommandRequests.getFitRequestSnapshot()).toBe(0);
  });

  it("does not advance the fit revision for non-fit commands", async () => {
    const unsubscribe = liveChartsCommandRequests.subscribe(() => undefined);
    const pending = liveChartsCommandRequests.request({
      kind: "set-live-mode",
      liveMode: "paused",
    });
    expect(liveChartsCommandRequests.getFitRequestSnapshot()).toBe(0);
    liveChartsCommandRequests.complete();
    await expect(pending).resolves.toBe("completed");
    unsubscribe();
  });

  it("fails a pending command when its last mounted consumer unmounts", async () => {
    const unsubscribe = liveChartsCommandRequests.subscribe(() => undefined);
    const pending = liveChartsCommandRequests.request({ kind: "fit" });
    expect(liveChartsCommandRequests.getSnapshot()).toEqual({ kind: "fit" });
    unsubscribe();
    await expect(pending).resolves.toBe("failed");
    expect(liveChartsCommandRequests.getSnapshot()).toBeNull();
  });

  it("carries a Follow or Pause request to the mounted controller", async () => {
    let action = null as ReturnType<typeof liveChartsCommandRequests.getSnapshot>;
    const unsubscribe = liveChartsCommandRequests.subscribe(() => { action = liveChartsCommandRequests.getSnapshot(); });
    const pending = liveChartsCommandRequests.request({ kind: "set-live-mode", liveMode: "paused" });
    expect(action).toEqual({ kind: "set-live-mode", liveMode: "paused" });
    liveChartsCommandRequests.complete();
    await expect(pending).resolves.toBe("completed");
    unsubscribe();
  });
});
