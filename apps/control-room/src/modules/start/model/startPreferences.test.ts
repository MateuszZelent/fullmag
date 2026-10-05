import { describe, expect, it } from "vitest";

import {
  TELEMETRY_OFF_TEXT,
  TELEMETRY_ON_TEXT,
  parseSettingAnswer,
  telemetryEnabledOf,
  telemetryStatusText,
  updateNoticeOf,
  updateNoticeText,
} from "./startPreferences";

const answer = (key: string, value: unknown, over: Record<string, unknown> = {}) =>
  parseSettingAnswer({ key, value, is_default: false, writable: true, ...over });

describe("parseSettingAnswer", () => {
  it("reads key, value and flags", () => {
    expect(answer("telemetry.enabled", true)).toEqual({
      key: "telemetry.enabled",
      value: true,
      isDefault: false,
      writable: true,
    });
  });

  it("rejects anything that is not a setting", () => {
    expect(parseSettingAnswer(null)).toBeUndefined();
    expect(parseSettingAnswer([])).toBeUndefined();
    expect(parseSettingAnswer({ value: true })).toBeUndefined();
  });
});

describe("telemetry", () => {
  it("is off unless the stored value is exactly true", () => {
    expect(telemetryEnabledOf(undefined)).toBe(false);
    expect(telemetryEnabledOf(answer("telemetry.enabled", false))).toBe(false);
    expect(telemetryEnabledOf(answer("telemetry.enabled", "true"))).toBe(false);
    expect(telemetryEnabledOf(answer("telemetry.enabled", 1))).toBe(false);
    expect(telemetryEnabledOf(answer("telemetry.enabled", true))).toBe(true);
  });

  it("never claims that data is sent", () => {
    expect(telemetryStatusText(false)).toBe(TELEMETRY_OFF_TEXT);
    expect(telemetryStatusText(true)).toBe(TELEMETRY_ON_TEXT);
    expect(TELEMETRY_OFF_TEXT).toBe("Telemetry off — this build sends no data");
    expect(TELEMETRY_ON_TEXT).toBe("Telemetry on — no collector is configured in this build");
    expect(TELEMETRY_ON_TEXT.toLowerCase()).not.toMatch(/sending|sent to|uploads?/);
  });
});

describe("update notice", () => {
  it("is hidden when nothing is stored", () => {
    expect(updateNoticeOf(undefined)).toBeUndefined();
    expect(updateNoticeOf(answer("update.available", null, { is_default: true, writable: false }))).toBeUndefined();
    expect(updateNoticeOf(answer("update.available", false))).toBeUndefined();
    expect(updateNoticeOf(answer("update.available", 7))).toBeUndefined();
  });

  it("shows the version an updater stored", () => {
    const notice = updateNoticeOf(answer("update.available", { version: "0.9.0" }));
    expect(notice).toEqual({ version: "0.9.0" });
    expect(updateNoticeText(notice!)).toBe("Update available: 0.9.0");
    expect(updateNoticeOf(answer("update.available", "1.0.0"))).toEqual({ version: "1.0.0" });
  });

  it("shows a bare notice for a record without a version", () => {
    const notice = updateNoticeOf(answer("update.available", {}));
    expect(notice).toEqual({});
    expect(updateNoticeText(notice!)).toBe("Update available");
  });
});
