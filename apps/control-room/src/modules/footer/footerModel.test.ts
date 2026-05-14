import { describe, expect, it } from "vitest";

import {
  SESSION_EVENTS_WS_PATH,
  SESSION_STATUS_PATH,
} from "@/kernel/api/apiPaths";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";

import {
  filterTransportEntries,
  formatTransportByteSize,
  formatTransportTimestamp,
  summarizeTransportPath,
} from "./footerModel";

function entry(
  patch: Partial<RequestDiagnosticEntry>,
): RequestDiagnosticEntry {
  return {
    byteLength: null,
    channel: "http",
    contentType: null,
    detail: null,
    direction: "rx",
    durationMs: null,
    id: "entry-1",
    messageType: null,
    method: "GET",
    outcome: "ok",
    path: SESSION_STATUS_PATH,
    requestId: "req-1",
    status: 200,
    timestampMs: 0,
    ...patch,
  };
}

describe("footerModel", () => {
  it("formats payload sizes for transport logs", () => {
    expect(formatTransportByteSize(null)).toBe("—");
    expect(formatTransportByteSize(42)).toBe("42 B");
    expect(formatTransportByteSize(250 * 1024 * 1024)).toBe("250.0 MB");
  });

  it("uses a deterministic timestamp format", () => {
    expect(formatTransportTimestamp(Date.UTC(2026, 4, 14, 12, 34, 56))).toBe(
      "12:34:56",
    );
  });

  it("filters entries by direction and channel", () => {
    const entries = [
      entry({ direction: "rx", id: "http-rx" }),
      entry({ channel: "websocket", direction: "rx", id: "ws-rx" }),
      entry({ direction: "tx", id: "http-tx" }),
    ];

    expect(
      filterTransportEntries(entries, { channel: "http", direction: "rx" }).map(
        (item) => item.id,
      ),
    ).toEqual(["http-rx"]);
  });

  it("shows websocket message types as row targets", () => {
    expect(
      summarizeTransportPath(
        entry({
          channel: "websocket",
          messageType: "resource.batch_changed",
          path: SESSION_EVENTS_WS_PATH,
        }),
      ),
    ).toBe("resource.batch_changed");
  });
});
