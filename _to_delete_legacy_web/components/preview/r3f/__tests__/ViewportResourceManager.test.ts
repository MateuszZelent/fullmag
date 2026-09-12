import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VIEWPORT_BUDGET,
  ViewportResourceManager,
  type ResourceHandle,
} from "../ViewportResourceManager";

// Helper: create a trivial resource handle with a spy dispose.
function makeHandle<T>(key: string, value: T, bytes: number): ResourceHandle<T> & { disposed: boolean } {
  const h = {
    key,
    value,
    bytes,
    disposed: false,
    dispose: vi.fn(function (this: typeof h) {
      this.disposed = true;
    }),
  };
  h.dispose = vi.fn(() => { h.disposed = true; });
  return h;
}

function makeMgr(budgetOverride?: Partial<typeof DEFAULT_VIEWPORT_BUDGET>) {
  return new ViewportResourceManager({ ...DEFAULT_VIEWPORT_BUDGET, ...budgetOverride });
}

const MB = 1024 * 1024;

// ── canAllocate ────────────────────────────────────────────────────────────────

describe("ViewportResourceManager.canAllocate", () => {
  it("allows allocation within category limit", () => {
    const mgr = makeMgr();
    const result = mgr.canAllocate("geometry", 10 * MB);
    expect(result.canAllocate).toBe(true);
    expect(result.degradedReason).toBeUndefined();
  });

  it("returns category-limit when category ceiling is exceeded", () => {
    const mgr = makeMgr({ maxGeometryBytes: 5 * MB });
    const h = makeHandle("g1", {}, 4 * MB);
    mgr.register(h, "geometry");

    const result = mgr.canAllocate("geometry", 4 * MB);
    expect(result.canAllocate).toBe(false);
    expect(result.degradedReason).toBe("category-limit");
  });

  it("returns total-limit when global ceiling is exceeded", () => {
    const mgr = makeMgr({ maxTotalBytes: 10 * MB });
    // Fill up with a geometry resource to push total near ceiling
    mgr.register(makeHandle("g1", {}, 9 * MB), "geometry");

    const result = mgr.canAllocate("color", 4 * MB);
    expect(result.canAllocate).toBe(false);
    expect(result.degradedReason).toBe("total-limit");
  });

  it("classifies small allocations as cheap", () => {
    const mgr = makeMgr();
    expect(mgr.canAllocate("geometry", 1 * MB).budgetClass).toBe("cheap");
  });

  it("classifies mid-range allocations as normal", () => {
    const mgr = makeMgr();
    expect(mgr.canAllocate("geometry", 20 * MB).budgetClass).toBe("normal");
  });

  it("classifies large allocations as expensive", () => {
    const mgr = makeMgr();
    expect(mgr.canAllocate("geometry", 100 * MB).budgetClass).toBe("expensive");
  });
});

// ── acquireOrDegrade ──────────────────────────────────────────────────────────

describe("ViewportResourceManager.acquireOrDegrade", () => {
  it("calls factory and returns value on first acquire", () => {
    const mgr = makeMgr();
    const factory = vi.fn(() => makeHandle("geo-a", "mesh-a", 2 * MB));

    const result = mgr.acquireOrDegrade("geo-a", "geometry", 2 * MB, factory);

    expect(factory).toHaveBeenCalledOnce();
    expect(result.value).toBe("mesh-a");
    expect(result.cached).toBe(false);
    expect(result.degradedReason).toBeUndefined();
  });

  it("returns cached value and does NOT call factory again on second acquire", () => {
    const mgr = makeMgr();
    const factory = vi.fn(() => makeHandle("geo-b", "mesh-b", 2 * MB));

    mgr.acquireOrDegrade("geo-b", "geometry", 2 * MB, factory);
    const second = mgr.acquireOrDegrade("geo-b", "geometry", 2 * MB, factory);

    expect(factory).toHaveBeenCalledOnce();
    expect(second.cached).toBe(true);
    expect(second.value).toBe("mesh-b");
  });

  it("returns degraded result when category limit would be exceeded", () => {
    const mgr = makeMgr({ maxGeometryBytes: 5 * MB });
    mgr.register(makeHandle("existing", {}, 4 * MB), "geometry");

    const factory = vi.fn(() => makeHandle("big", {}, 4 * MB));
    const result = mgr.acquireOrDegrade("big", "geometry", 4 * MB, factory);

    expect(factory).not.toHaveBeenCalled();
    expect(result.value).toBeNull();
    expect(result.degradedReason).toBe("category-limit");
  });

  it("returns degraded result when total limit would be exceeded", () => {
    const mgr = makeMgr({ maxTotalBytes: 6 * MB });
    mgr.register(makeHandle("g1", {}, 5 * MB), "geometry");

    const factory = vi.fn(() => makeHandle("v1", {}, 4 * MB));
    const result = mgr.acquireOrDegrade("v1", "vector", 4 * MB, factory);

    expect(result.value).toBeNull();
    expect(result.degradedReason).toBe("total-limit");
  });
});

// ── release ───────────────────────────────────────────────────────────────────

describe("ViewportResourceManager.release", () => {
  it("calls dispose and removes resource from tracking", () => {
    const mgr = makeMgr();
    const h = makeHandle("geo-r", {}, 10 * MB);
    mgr.register(h, "geometry");

    expect(mgr.getStats().geometryBytes).toBe(10 * MB);

    mgr.release("geo-r");

    expect(h.disposed).toBe(true);
    expect(mgr.getStats().geometryBytes).toBe(0);
    expect(mgr.getStats().resourceCount).toBe(0);
  });

  it("is a no-op for unknown keys", () => {
    const mgr = makeMgr();
    expect(() => mgr.release("nonexistent")).not.toThrow();
  });
});

// ── disposeStale ──────────────────────────────────────────────────────────────

describe("ViewportResourceManager.disposeStale", () => {
  it("disposes resources not marked-used for ≥ staleFrames", () => {
    const mgr = makeMgr();
    const h = makeHandle("old", {}, 5 * MB);
    mgr.register(h, "geometry");

    // Advance 3 frames without marking h as used
    mgr.beginFrame();
    mgr.beginFrame();
    mgr.beginFrame();

    const count = mgr.disposeStale(3);

    expect(count).toBe(1);
    expect(h.disposed).toBe(true);
    expect(mgr.getStats().resourceCount).toBe(0);
  });

  it("keeps resources that were recently marked-used", () => {
    const mgr = makeMgr();
    const h = makeHandle("fresh", {}, 5 * MB);
    mgr.register(h, "geometry");

    mgr.beginFrame();
    mgr.markUsed("fresh");
    mgr.beginFrame();
    mgr.markUsed("fresh");
    mgr.beginFrame();
    mgr.markUsed("fresh");

    const count = mgr.disposeStale(3);

    expect(count).toBe(0);
    expect(h.disposed).toBe(false);
    expect(mgr.getStats().resourceCount).toBe(1);
  });

  it("does not evict a resource that is fresh enough", () => {
    const mgr = makeMgr();
    mgr.register(makeHandle("r1", {}, 1 * MB), "geometry");

    mgr.beginFrame();
    const count = mgr.disposeStale(3);

    // Only 1 frame has passed, staleFrames=3 — should NOT be disposed
    expect(count).toBe(0);
  });
});

// ── disposeAll ────────────────────────────────────────────────────────────────

describe("ViewportResourceManager.disposeAll", () => {
  it("disposes every resource and empties the registry", () => {
    const mgr = makeMgr();
    const h1 = makeHandle("g1", {}, 1 * MB);
    const h2 = makeHandle("c1", {}, 2 * MB);
    mgr.register(h1, "geometry");
    mgr.register(h2, "color");

    mgr.disposeAll("test");

    expect(h1.disposed).toBe(true);
    expect(h2.disposed).toBe(true);
    expect(mgr.getStats().resourceCount).toBe(0);
    expect(mgr.getStats().totalBytes).toBe(0);
  });
});

// ── register overwrites ───────────────────────────────────────────────────────

describe("ViewportResourceManager.register (overwrite)", () => {
  it("disposes the old resource when registering the same key again", () => {
    const mgr = makeMgr();
    const old = makeHandle("key1", "old-value", 1 * MB);
    const fresh = makeHandle("key1", "fresh-value", 2 * MB);

    mgr.register(old, "geometry");
    mgr.register(fresh, "geometry");

    expect(old.disposed).toBe(true);
    expect(mgr.getStats().geometryBytes).toBe(2 * MB);
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────

describe("ViewportResourceManager.getStats", () => {
  it("tracks bytes per category independently", () => {
    const mgr = makeMgr();
    mgr.register(makeHandle("g1", {}, 10 * MB), "geometry");
    mgr.register(makeHandle("c1", {}, 20 * MB), "color");
    mgr.register(makeHandle("v1", {}, 30 * MB), "vector");

    const s = mgr.getStats();
    expect(s.geometryBytes).toBe(10 * MB);
    expect(s.colorBytes).toBe(20 * MB);
    expect(s.vectorBytes).toBe(30 * MB);
    expect(s.totalBytes).toBe(60 * MB);
    expect(s.resourceCount).toBe(3);
  });

  it("reports staleCount for resources not touched this frame", () => {
    const mgr = makeMgr();
    mgr.register(makeHandle("a", {}, 1), "geometry");
    mgr.register(makeHandle("b", {}, 1), "geometry");

    mgr.beginFrame();
    // Only mark 'a' as used
    mgr.markUsed("a");

    expect(mgr.getStats().staleCount).toBe(1);
  });
});

// ── Acceptance criteria ───────────────────────────────────────────────────────

describe("Acceptance: large-mesh budget guard", () => {
  it("returns degraded when geometry + wireframe would exceed category limit", () => {
    // Simulate: 350 MB surface geometry already allocated, budget is 400 MB.
    // Trying to add 100 MB wireframe should fail.
    const mgr = makeMgr({ maxGeometryBytes: 400 * MB });
    mgr.register(makeHandle("surface", {}, 350 * MB), "geometry");

    const wireframeFactory = vi.fn(() => makeHandle("wireframe", {}, 100 * MB));
    const result = mgr.acquireOrDegrade("wireframe", "geometry", 100 * MB, wireframeFactory);

    expect(result.value).toBeNull();
    expect(result.degradedReason).toBe("category-limit");
    expect(wireframeFactory).not.toHaveBeenCalled();
  });

  it("returns degraded when vector arrows would exceed vector category limit", () => {
    const mgr = makeMgr({ maxVectorBytes: 50 * MB });
    mgr.register(makeHandle("existing-vectors", {}, 48 * MB), "vector");

    const arrowFactory = vi.fn(() => makeHandle("arrow-batch", {}, 20 * MB));
    const result = mgr.acquireOrDegrade("arrow-batch", "vector", 20 * MB, arrowFactory);

    expect(result.value).toBeNull();
    expect(result.degradedReason).toBe("category-limit");
    expect(arrowFactory).not.toHaveBeenCalled();
  });
});
