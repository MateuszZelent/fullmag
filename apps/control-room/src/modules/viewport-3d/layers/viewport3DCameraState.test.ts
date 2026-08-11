import { describe, expect, it } from "vitest";

import {
  resolveViewport3DCameraSnapshotScale,
  viewport3DCameraSnapshotsEqual,
  type Viewport3DLiveCameraSnapshot,
} from "./viewport3DCameraState";

function snapshot(
  patch: Partial<Viewport3DLiveCameraSnapshot> = {},
): Viewport3DLiveCameraSnapshot {
  return {
    orthographicScale: null,
    position: [200e-9, 0, 0],
    projection: "perspective",
    target: [0, 0, 0],
    up: [0, 0, 1],
    ...patch,
  };
}

describe("viewport3DCameraState", () => {
  it("detects a meaningful 20 nm move in a 200 nm scene", () => {
    const current = snapshot();
    const moved = snapshot({ position: [220e-9, 0, 0] });

    expect(
      viewport3DCameraSnapshotsEqual(
        current,
        moved,
        resolveViewport3DCameraSnapshotScale(current),
      ),
    ).toBe(false);
  });

  it("ignores picometre numerical jitter in a metre-scale view", () => {
    const current = snapshot({ position: [1, 0, 0] });
    const jittered = snapshot({ position: [1 + 1e-12, 0, 0] });

    expect(
      viewport3DCameraSnapshotsEqual(
        current,
        jittered,
        resolveViewport3DCameraSnapshotScale(current),
      ),
    ).toBe(true);
  });

  it("compares orthographic scale relatively and up direction angularly", () => {
    const current = snapshot({
      orthographicScale: 2e-6,
      projection: "orthographic",
    });
    const jittered = snapshot({
      orthographicScale: 2e-6 * (1 + 1e-10),
      projection: "orthographic",
      up: [1e-10, 0, 1],
    });

    expect(
      viewport3DCameraSnapshotsEqual(
        current,
        jittered,
        resolveViewport3DCameraSnapshotScale(current),
      ),
    ).toBe(true);
  });

  it("treats projection and material orthographic scale changes as different", () => {
    const current = snapshot();
    const orthographic = snapshot({
      orthographicScale: 2e-6,
      projection: "orthographic",
    });
    const scaled = snapshot({
      orthographicScale: 2.1e-6,
      projection: "orthographic",
    });

    expect(viewport3DCameraSnapshotsEqual(current, orthographic, 200e-9)).toBe(
      false,
    );
    expect(
      viewport3DCameraSnapshotsEqual(orthographic, scaled, 200e-9),
    ).toBe(false);
  });
});
