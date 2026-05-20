import { describe, expect, it } from "vitest";

import {
  SESSION_EVENTS_WS_PATH,
  SESSION_STATUS_PATH,
  SIMULATION_COMMAND_DETAIL_PATH,
  SIMULATION_COMMANDS_PATH,
} from "@/kernel/api/apiPaths";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";

import {
  buildTransportMessagePreview,
  filterTransportEntries,
  formatTransportDuration,
  formatTransportByteSize,
  formatTransportTimestamp,
  formatTransportTimestampSignature,
  resolveTransportCorrelation,
  serializeTransportEntry,
  sortTransportEntries,
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
      "12:34:56.000",
    );
    expect(
      formatTransportTimestampSignature(Date.UTC(2026, 4, 14, 12, 34, 56, 789)),
    ).toBe("2026-05-14T12:34:56.789Z");
  });

  it("formats nullable transport latency", () => {
    expect(formatTransportDuration(null)).toBe("—");
    expect(formatTransportDuration(12.6)).toBe("13 ms");
  });

  it("builds compact clickable message previews", () => {
    expect(buildTransportMessagePreview(entry({ direction: "tx" }))).toBe(
      `TX GET ${SESSION_STATUS_PATH}`,
    );
    expect(
      buildTransportMessagePreview(
        entry({
          channel: "websocket",
          messageType: "resource.batch_changed",
        }),
      ),
    ).toBe("RX WS resource.batch_changed");
    expect(
      buildTransportMessagePreview(
        entry({
          channel: "performance",
          durationMs: 12.7,
          method: "MEASURE",
          path: "fullmag.viewport3d.buildTopologyRenderModel",
        }),
      ),
    ).toBe("RX PERF fullmag.viewport3d.buildTopologyRenderModel");
  });

  it("serializes full entries for the details modal", () => {
    const commandDetailPath = SIMULATION_COMMAND_DETAIL_PATH.replace(
      "{command_id}",
      "cmd-42",
    );

    expect(
      JSON.parse(
        serializeTransportEntry(
          entry({
            byteLength: 262144000,
            path: commandDetailPath,
            timestampMs: Date.UTC(2026, 4, 14, 12, 34, 56),
          }),
        ),
      ),
    ).toMatchObject({
      byteLength: 262144000,
      commandId: "cmd-42",
      path: commandDetailPath,
      resourceKey: commandDetailPath,
      timestamp: "2026-05-14T12:34:56.000Z",
    });
  });

  it("resolves transport correlation details from request metadata", () => {
    const commandDetailPath = SIMULATION_COMMAND_DETAIL_PATH.replace(
      "{command_id}",
      "cmd-42",
    );

    expect(
      resolveTransportCorrelation(
        entry({
          detail: "stage_id=stage-003",
          path: commandDetailPath,
        }),
      ),
    ).toEqual({
      commandId: "cmd-42",
      resourceKey: commandDetailPath,
      stageId: "stage-003",
    });

    expect(
      resolveTransportCorrelation(
        entry({
          detail: "attempt 1; command_id=cmd-77; accepted=true",
          path: SIMULATION_COMMANDS_PATH,
        }),
      ),
    ).toMatchObject({
      commandId: "cmd-77",
    });
  });

  it("filters entries by direction and channel", () => {
    const entries = [
      entry({ direction: "rx", id: "http-rx" }),
      entry({ channel: "websocket", direction: "rx", id: "ws-rx" }),
      entry({ channel: "performance", direction: "rx", id: "perf-rx" }),
      entry({ direction: "tx", id: "http-tx" }),
    ];

    expect(
      filterTransportEntries(entries, { channel: "http", direction: "rx" }).map(
        (item) => item.id,
      ),
    ).toEqual(["http-rx"]);
    expect(
      filterTransportEntries(entries, {
        channel: "performance",
        direction: "rx",
      }).map((item) => item.id),
    ).toEqual(["perf-rx"]);
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

  it("sorts entries by requested transport columns", () => {
    const entries = [
      entry({
        byteLength: 2048,
        channel: "http",
        direction: "rx",
        durationMs: 40,
        id: "b",
        status: 200,
        timestampMs: 20,
      }),
      entry({
        byteLength: null,
        channel: "websocket",
        direction: "tx",
        durationMs: null,
        id: "c",
        status: null,
        timestampMs: 30,
      }),
      entry({
        byteLength: 1024,
        channel: "http",
        direction: "tx",
        durationMs: 10,
        id: "a",
        outcome: "error",
        status: 500,
        timestampMs: 10,
      }),
    ];

    expect(
      sortTransportEntries(entries, { direction: "desc", key: "time" }).map(
        (item) => item.id,
      ),
    ).toEqual(["c", "b", "a"]);
    expect(
      sortTransportEntries(entries, { direction: "asc", key: "direction" }).map(
        (item) => item.id,
      ),
    ).toEqual(["b", "a", "c"]);
    expect(
      sortTransportEntries(entries, { direction: "asc", key: "channel" }).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      sortTransportEntries(entries, { direction: "asc", key: "status" }).map(
        (item) => item.id,
      ),
    ).toEqual(["b", "a", "c"]);
    expect(
      sortTransportEntries(entries, { direction: "asc", key: "size" }).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      sortTransportEntries(entries, { direction: "asc", key: "latency" }).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });
});
