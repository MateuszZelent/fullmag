import { describe, expect, it } from "vitest";

import { formatResultsSampleOrdinal } from "./resultsSampleLabels";

describe("formatResultsSampleOrdinal", () => {
  it("uses a one-based user-facing ordinal", () => {
    expect(formatResultsSampleOrdinal(0, 6)).toBe("Sample 1 of 6");
    expect(formatResultsSampleOrdinal(5, 6)).toBe("Sample 6 of 6");
  });

  it("does not turn an invalid technical index into a false sample label", () => {
    expect(formatResultsSampleOrdinal(null, 6)).toBe("Sample unavailable");
    expect(formatResultsSampleOrdinal(6, 6)).toBe("Sample unavailable");
    expect(formatResultsSampleOrdinal(0, 0)).toBe("Sample unavailable");
  });
});
