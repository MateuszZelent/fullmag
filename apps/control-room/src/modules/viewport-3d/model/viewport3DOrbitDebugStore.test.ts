import { describe, expect, it, vi } from "vitest";

import { normalizeViewport3DOrbitDebugAngles } from "../layers/CameraControls.model";
import { createViewport3DOrbitDebugStore } from "./viewport3DOrbitDebugStore";

describe("Viewport3DOrbitDebugStore", () => {
  it("keeps live reports separate from requested angle and commit revisions", () => {
    const store = createViewport3DOrbitDebugStore();
    const onChange = vi.fn();
    store.subscribe(onChange);

    const initial = store.getSnapshot();
    store.reportAngles(initial.angles);
    expect(onChange).not.toHaveBeenCalled();

    const reportedAngles = { azimuth: 0.8, polar: 1.2 };
    store.reportAngles(reportedAngles);
    expect(store.getSnapshot()).toMatchObject({
      angles: reportedAngles,
      commitRevision: 0,
      revision: 0,
    });

    const requestedAngles = { azimuth: 2.1, polar: 2.2 };
    store.applyAngles(requestedAngles);
    expect(store.getSnapshot()).toMatchObject({
      angles: normalizeViewport3DOrbitDebugAngles(requestedAngles),
      commitRevision: 0,
      revision: 1,
    });

    store.commitAngles();
    expect(store.getSnapshot()).toMatchObject({
      commitRevision: 1,
      revision: 1,
    });
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
