import { describe, expect, it } from "vitest";

import {
  createViewport3DCameraTrajectoryProbe,
  type Viewport3DCameraTrajectorySample,
} from "./viewport3DCameraTrajectoryProbe";

function sample(frame: number): Viewport3DCameraTrajectorySample {
  return {
    active: true,
    committedCamera: null,
    epoch: 7,
    frame,
    liveCamera: null,
    reason: "change",
    registry: null,
    source: "orbit",
    storeCamera: null,
    timestamp: frame * 16,
  };
}

describe("viewport3DCameraTrajectoryProbe", () => {
  it("is allocation-free and empty while disabled", () => {
    const probe = createViewport3DCameraTrajectoryProbe({
      capacity: 64,
      enabled: false,
    });

    for (let frame = 0; frame < 100; frame += 1) {
      probe.record(sample(frame));
    }

    expect(probe.snapshot()).toEqual([]);
    expect(probe.size()).toBe(0);
  });

  it("keeps only the newest bounded trajectory samples", () => {
    const probe = createViewport3DCameraTrajectoryProbe({
      capacity: 64,
      enabled: true,
    });

    for (let frame = 0; frame < 100; frame += 1) {
      probe.record(sample(frame));
    }

    expect(probe.snapshot()).toHaveLength(64);
    expect(probe.snapshot()[0]?.frame).toBe(36);
    expect(probe.snapshot()[63]?.frame).toBe(99);

    probe.clear();
    expect(probe.snapshot()).toEqual([]);
  });

  it("defensively clones snapshots exposed to browser diagnostics", () => {
    const probe = createViewport3DCameraTrajectoryProbe({
      capacity: 2,
      enabled: true,
    });
    probe.record(sample(1));

    const exposed = probe.snapshot();
    exposed[0]!.reason = "commit";

    expect(probe.snapshot()[0]?.reason).toBe("change");
  });
});
