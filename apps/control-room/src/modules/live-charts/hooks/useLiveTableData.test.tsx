import { describe, expect, it } from "vitest";

import {
  shouldLoadLiveTableRows,
  shouldPauseLiveTableRows,
  liveTableUnsupportedReason,
} from "./useLiveTableData";

describe("useLiveTableData", () => {
  it("does no heavy work while inactive or paused with retained rows", () => {
    expect(shouldLoadLiveTableRows({ active: false, hasSchema: true, paused: false })).toBe(false);
    expect(shouldLoadLiveTableRows({ active: true, hasSchema: true, paused: true })).toBe(false);
    expect(shouldPauseLiveTableRows({ active: true, hasRows: true, paused: true })).toBe(true);
    expect(shouldPauseLiveTableRows({ active: true, hasRows: true, paused: false })).toBe(false);
  });

  it("calls a resumed active surface eligible for exactly the latest resource fetch", () => {
    expect(shouldLoadLiveTableRows({ active: true, hasSchema: true, paused: false })).toBe(true);
  });

  it("reports an empty published schema as unsupported", () => {
    expect(liveTableUnsupportedReason([], "ready")).toBe("The active runtime does not publish scalar table samples.");
  });
});
