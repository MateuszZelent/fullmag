import { afterEach, describe, expect, it, vi } from "vitest";

import { readRecentIndex, rebuildRecentIndex } from "./recentIndexHost";

afterEach(() => vi.unstubAllGlobals());

describe("recent index host diagnostics", () => {
  it("reports unavailable only when the browser has no desktop bridge", async () => {
    vi.stubGlobal("window", {});
    await expect(readRecentIndex()).resolves.toEqual({ kind: "unavailable" });
  });

  it.each([
    "Command recent_index_read not found",
    "unknown command: recent_index_read",
    "recent_index_read not allowed",
    "workspace database file not found: recent.db",
    "workspace database is locked",
  ])("preserves a present desktop host's error: %s", async (message) => {
    const invoke = vi.fn(async () => { throw new Error(message); });
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(readRecentIndex()).resolves.toEqual({ kind: "error", message });
    expect(invoke).toHaveBeenCalledWith("recent_index_read", undefined);
  });

  it("keeps a host string rejection visible on rebuild", async () => {
    const invoke = vi.fn(async () => { throw "recent_index_rebuild not allowed"; });
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(rebuildRecentIndex()).resolves.toEqual({
      kind: "error", message: "recent_index_rebuild not allowed",
    });
  });

  it("still parses a successful empty desktop index", async () => {
    const invoke = vi.fn(async () => ({ format_version: 1, entries: [] }));
    vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
    await expect(readRecentIndex()).resolves.toEqual({ kind: "empty" });
  });
});
