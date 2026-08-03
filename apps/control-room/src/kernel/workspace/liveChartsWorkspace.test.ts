import { beforeEach, describe, expect, it } from "vitest";

import {
  liveChartsWorkspaceStore,
  resetLiveChartsWorkspaceForTests,
} from "./liveChartsWorkspace";

describe("liveChartsWorkspaceStore", () => {
  beforeEach(() => {
    resetLiveChartsWorkspaceForTests();
  });

  it("keeps descriptor, cursor, and range view state without chart samples", () => {
    liveChartsWorkspaceStore.setSelectedDescriptorId("magnetization");
    liveChartsWorkspaceStore.setSelectedPoint({
      pointIndex: 4,
      revision: "42",
      seriesId: "mx",
      x: 12,
      y: 0.98,
    });
    liveChartsWorkspaceStore.setRange({ fromSI: 1e-9, toSI: 3e-9 });

    const snapshot = liveChartsWorkspaceStore.getSnapshot();
    expect(snapshot).toEqual({
      range: { fromSI: 1e-9, toSI: 3e-9 },
      selectedDescriptorId: "magnetization",
      selectedPoint: { pointIndex: 4, revision: "42", seriesId: "mx", x: 12, y: 0.98 },
    });
    expect(JSON.stringify(snapshot)).not.toContain("samples");
  });

  it("clears an invalid range instead of retaining it", () => {
    liveChartsWorkspaceStore.setRange({ fromSI: 3, toSI: 1 });

    expect(liveChartsWorkspaceStore.getSnapshot().range).toBeNull();
  });
});
