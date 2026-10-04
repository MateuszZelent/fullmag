import { describe, expect, it, vi } from "vitest";
import { createPlanarFrameRetention } from "./planarFrameRetention";

describe("planar frame retention", () => {
  it("keeps a known source through metadata refresh and rejects a changed definition", () => {
    const store = createPlanarFrameRetention<object>();
    const model = {};
    store.retain("A:1|plane-1", model, "revision=2&hash=old");
    const snapshot = store.getSnapshot();
    store.retain("A:1|plane-1", null, null);
    expect(store.getSnapshot()).toBe(snapshot);
    store.retain("A:1|plane-1", null, "revision=2&hash=old");
    expect(store.getSnapshot()).toBe(snapshot);
    store.retain("A:1|plane-1", null, "revision=3&hash=new");
    expect(store.getSnapshot()).toBeNull();
  });

  it("retains one frame during refresh without copying binary buffers", () => {
    const store = createPlanarFrameRetention<{ scalar: Float32Array }>();
    const scalar = new Float32Array([1, 2]);
    const model = { scalar };
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    store.retain("session=A&epoch=1|view=m", model);
    const snapshot = store.getSnapshot();
    store.retain("session=A&epoch=1|view=m", null);
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.getSnapshot()?.model.scalar).toBe(scalar);
    expect(store.getServerSnapshot()).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    store.retain("session=A&epoch=1|view=m", model);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.retain(null, null);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBeNull();
  });

  it("drops frames across session, epoch, quantity and domain boundaries", () => {
    const store = createPlanarFrameRetention<object>();
    for (const next of ["session=B&epoch=1|domain=D|view=m", "session=A&epoch=2|domain=D|view=m", "session=A&epoch=1|domain=E|view=m", "session=A&epoch=1|domain=D|view=H", null]) {
      store.retain("session=A&epoch=1|domain=D|view=m", {});
      store.retain(next, null);
      expect(store.getSnapshot()).toBeNull();
    }
  });
});
