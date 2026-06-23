import { describe, expect, it } from "vitest";

import { MemoryBudgetRegistry } from "./MemoryBudgetRegistry";
import { buildThreadManagerMemoryBudgetRows } from "./threadManagerModel";

describe("MemoryBudgetRegistry", () => {
  it("keeps provider snapshots compatible and normalizes ledger fields", () => {
    const registry = new MemoryBudgetRegistry();

    registry.register("viewport3d.cache", () => ({
      byteLength: 2048,
      category: "viewport-cache",
      entryCount: 2,
      id: "viewport3d.cache",
      label: "Viewport cache",
      maxBytes: 4096,
    }));

    expect(registry.snapshot()).toEqual([
      expect.objectContaining({
        byteLength: 2048,
        category: "viewport-cache",
        entryCount: 2,
        id: "viewport3d.cache",
        label: "Viewport cache",
        maxBytes: 4096,
        owner: "viewport3d",
        releaseReason: null,
      }),
    ]);
  });

  it("adds ledger entries to totals and groups snapshots by category", () => {
    const registry = new MemoryBudgetRegistry();

    registry.registerLedgerEntry({
      byteLength: 100,
      category: "webgl",
      createdAtMs: 1,
      entryCount: 1,
      id: "viewport3d.geometry.free-layer",
      label: "Free layer geometry",
      maxBytes: null,
      owner: "viewport-3d",
    });
    registry.registerLedgerEntry({
      byteLength: 50,
      category: "webgl",
      createdAtMs: 2,
      entryCount: 2,
      id: "viewport3d.material.free-layer",
      label: "Free layer materials",
      maxBytes: null,
      owner: "viewport-3d",
    });

    expect(registry.totalBytes()).toBe(150);
    expect(registry.snapshotByCategory()).toEqual([
      expect.objectContaining({
        byteLength: 150,
        category: "webgl",
        entryCount: 3,
        maxBytes: null,
      }),
    ]);
  });

  it("updates and releases ledger entries idempotently", () => {
    const registry = new MemoryBudgetRegistry();

    registry.registerLedgerEntry({
      byteLength: 10,
      category: "binary-buffer",
      entryCount: 1,
      id: "decode.buffer",
      label: "Decode buffer",
      maxBytes: 100,
      owner: "api",
    });

    expect(registry.updateLedgerEntry("decode.buffer", { byteLength: 80 })).toBe(
      true,
    );
    expect(registry.totalBytes()).toBe(80);
    expect(registry.releaseLedgerEntry("decode.buffer")).toBe(true);
    expect(registry.releaseLedgerEntry("decode.buffer")).toBe(false);
    expect(registry.totalBytes()).toBe(0);
  });

  it("notifies subscribers until unsubscribe", () => {
    const registry = new MemoryBudgetRegistry();
    let notifications = 0;
    const unsubscribe = registry.subscribe(() => {
      notifications += 1;
    });

    const initialVersion = registry.getVersion();
    registry.registerLedgerEntry({
      byteLength: 10,
      category: "diagnostics-buffer",
      entryCount: 1,
      id: "diagnostics.timeline",
      label: "Diagnostics timeline",
      maxBytes: null,
      owner: "diagnostics",
    });
    unsubscribe();
    registry.registerLedgerEntry({
      byteLength: 10,
      category: "diagnostics-buffer",
      entryCount: 1,
      id: "diagnostics.console",
      label: "Diagnostics console",
      maxBytes: null,
      owner: "diagnostics",
    });

    expect(notifications).toBe(1);
    expect(registry.getVersion()).toBe(initialVersion + 2);
  });

  it("keeps unbounded high entries visible to thread-manager classification", () => {
    const registry = new MemoryBudgetRegistry();
    registry.registerLedgerEntry({
      byteLength: 101 * 1024 * 1024,
      category: "object-url",
      entryCount: 1,
      id: "viewport3d.object-url.large",
      label: "Large object URL",
      maxBytes: null,
      owner: "viewport-3d",
    });

    expect(buildThreadManagerMemoryBudgetRows(registry.snapshot())).toEqual([
      expect.objectContaining({
        id: "viewport3d.object-url.large",
        status: "unbounded-high",
      }),
    ]);
  });
});
