import { describe, expect, it } from "vitest";

import { apiItem } from "./__fixtures__/workspaceApi";
import {
  describeEdit,
  editChange,
  scriptHistoryRows,
  scriptRunRows,
  shortHash,
} from "./scriptEvents";
import { parseApiEvents } from "./workspaceApiTypes";

const events = (raw: unknown[]) => parseApiEvents(raw);

describe("edit events", () => {
  it("reads before and after from nested objects", () => {
    const change = editChange({
      before: { sha256: "a1b2c3d4e5f6", lines: 112 },
      after: { sha256: "e4f5a6b7c8d9", lines: 120 },
    });
    expect(change).toEqual({
      beforeHash: "a1b2c3d",
      afterHash: "e4f5a6b",
      beforeLines: 112,
      afterLines: 120,
    });
    expect(describeEdit(change)).toBe("112 → 120 lines · a1b2c3d → e4f5a6b");
  });

  it("reads flat keys too", () => {
    expect(
      describeEdit(editChange({ before_sha256: "aaaaaaaa11", after_sha256: "bbbbbbbb22", before_lines: 1, after_lines: 2 })),
    ).toBe("1 → 2 lines · aaaaaaa → bbbbbbb");
  });

  it("describes what it has: only the new version, or nothing", () => {
    expect(describeEdit(editChange({ after: { sha256: "cccccccc33", lines: 9 } }))).toBe("9 lines · ccccccc");
    expect(describeEdit(editChange({}))).toBe("");
    expect(describeEdit(editChange({ before: "x", after: 3 }))).toBe("");
  });

  it("shortens a hash and keeps the absent one absent", () => {
    expect(shortHash("0123456789")).toBe("0123456");
    expect(shortHash(undefined)).toBeUndefined();
  });
});

describe("scriptHistoryRows", () => {
  it("labels each kind, names the actor and summarises edits and runs", () => {
    const rows = scriptHistoryRows(
      events([
        { at: "2026-10-03T10:00:00Z", kind: "run", actor: "cli", detail: { status: "failed", duration_seconds: 3.04, device: "cpu" } },
        { at: "2026-10-03T09:00:00Z", kind: "edit", actor: "desktop", detail: { before: { lines: 1 }, after: { lines: 4 } } },
        { at: "2026-10-03T08:00:00Z", kind: "rename", actor: "scanner", detail: {} },
        { at: "2026-10-03T07:00:00Z", kind: "teleport", actor: "unknown-tool", detail: { source: "import" } },
      ]),
    );
    expect(rows.map((r) => [r.label, r.actor, r.summary])).toEqual([
      ["Run", "command line", "Run failed · 3 s · cpu"],
      ["Edited", "desktop app", "1 → 4 lines"],
      ["Renamed", "folder scan", ""],
      ["teleport", "unknown-tool", "import"],
    ]);
  });
});

describe("scriptRunRows", () => {
  const folder = apiItem({
    id: "r1",
    kind: "result",
    name: "run-0003",
    sizeBytes: 318,
    firstSeenAt: "2026-10-03T06:00:00Z",
    meta: { run_id: "run-3", status: "completed", duration_seconds: 412 },
  });

  it("lists result folders first as selectable rows, then run events, newest first", () => {
    const rows = scriptRunRows(
      events([
        { at: "2026-10-01T10:00:00Z", kind: "run", actor: "cli", detail: { status: "ok", duration_seconds: 5, output_bytes: 77, run_id: "old" } },
        { at: "2026-10-04T10:00:00Z", kind: "run", actor: "cli", detail: { status: "started" } },
        { at: "2026-10-04T11:00:00Z", kind: "open", actor: "cli" },
      ]),
      [folder],
    );
    expect(rows.map((r) => r.key.split(":")[0])).toEqual(["event", "result", "event"]);
    const result = rows.find((r) => r.resultId);
    expect(result).toMatchObject({
      label: "run-0003",
      status: "ready",
      statusWord: "Complete",
      durationSeconds: 412,
      outputBytes: 318,
      resultId: "r1",
    });
    const started = rows[0];
    expect(started).toMatchObject({ status: "draft", statusWord: "Run started" });
    expect(rows[2]).toMatchObject({ label: "old", status: "ready", outputBytes: 77, durationSeconds: 5 });
  });

  it("lists a run once when its folder carries the run's id", () => {
    const rows = scriptRunRows(
      events([{ at: "2026-10-03T10:00:00Z", kind: "run", actor: "cli", detail: { status: "ok", run_id: "run-3" } }]),
      [folder],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resultId).toBe("r1");
  });

  it("is empty with nothing recorded", () => {
    expect(scriptRunRows([], [])).toEqual([]);
  });

  it("names a run without an id by its time and shows an unknown status as a draft", () => {
    const [row] = scriptRunRows(events([{ at: "2026-10-03T10:15:00Z", kind: "run", actor: "cli", detail: {} }]), []);
    expect(row).toMatchObject({ label: "2026-10-03 10:15", status: "draft", statusWord: "Run" });
  });
});

describe("backend edit events", () => {
  it("reads sha256_before/after and lines_before/after", () => {
    expect(
      describeEdit(editChange({ sha256_before: "aaaaaaaa11", sha256_after: "bbbbbbbb22", lines_before: 3, lines_after: 5 })),
    ).toBe("3 → 5 lines · aaaaaaa → bbbbbbb");
  });
});
