import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureFrontendAudit,
  incrementFrontendAuditCounter,
  incrementFrontendAuditResourceFetch,
} from "../frontendAudit";

describe("frontendAudit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    vi.spyOn(console, "table").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes non-enumerable snapshotDelta for idle counter checks", async () => {
    const audit = ensureFrontendAudit();
    expect(audit).not.toBeNull();
    expect(typeof audit?.snapshotDelta).toBe("function");
    expect(Object.keys(audit ?? {})).not.toContain("snapshotDelta");

    const deltaPromise = audit!.snapshotDelta(1);
    incrementFrontendAuditCounter("typedArrayAllocations", 3);
    incrementFrontendAuditCounter("viewportInvalidates", 2);
    incrementFrontendAuditResourceFetch("mesh-topology", 1);
    incrementFrontendAuditResourceFetch("field-vector", 2);

    await vi.advanceTimersByTimeAsync(1000);
    const delta = await deltaPromise;

    expect(delta.counters.typedArrayAllocations).toBe(3);
    expect(delta.counters.viewportInvalidates).toBe(2);
    expect(delta.counters.dataPlaneFetches).toBe(3);
    expect(delta.resourceFetches).toEqual({
      "field-vector": 2,
      "mesh-topology": 1,
    });
    expect(console.table).toHaveBeenCalledWith(delta.counters);
    expect(console.table).toHaveBeenCalledWith(delta.resourceFetches);
  });
});
