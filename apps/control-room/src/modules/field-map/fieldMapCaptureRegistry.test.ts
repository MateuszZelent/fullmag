import { describe, expect, it, vi } from "vitest";

import {
  getRegisteredFieldMapCapture,
  registerFieldMapCapture,
} from "./fieldMapCaptureRegistry";

describe("field-map capture registry", () => {
  it("keeps capture providers session-scoped and removes only the provider it registered", () => {
    const first = vi.fn();
    const replacement = vi.fn();
    const otherSession = vi.fn();
    const unregisterFirst = registerFieldMapCapture("session=A", first);
    const unregisterReplacement = registerFieldMapCapture("session=A", replacement);
    const unregisterOtherSession = registerFieldMapCapture("session=B", otherSession);

    unregisterFirst();
    expect(getRegisteredFieldMapCapture("session=A")).toBe(replacement);
    expect(getRegisteredFieldMapCapture("session=B")).toBe(otherSession);

    unregisterReplacement();
    expect(getRegisteredFieldMapCapture("session=A")).toBeNull();
    expect(getRegisteredFieldMapCapture("session=B")).toBe(otherSession);
    unregisterOtherSession();
    expect(getRegisteredFieldMapCapture("session=B")).toBeNull();
  });
});
