import { afterEach, describe, expect, it, vi } from "vitest";

import { script } from "./__fixtures__/workspaceScripts";
import {
  copyText,
  displayPath,
  folderOf,
  formatDuration,
  formatLines,
  launchCommand,
  runChip,
} from "./scriptRowModel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("launchCommand", () => {
  it("quotes a Windows path and keeps its backslashes literal", () => {
    expect(launchCommand("C:\\Users\\Ana Maria\\sp4.py")).toBe('fullmag "C:\\Users\\Ana Maria\\sp4.py"');
  });

  it("strips the verbatim prefix the OS sometimes adds", () => {
    expect(launchCommand("\\\\?\\C:\\work\\a.py")).toBe('fullmag "C:\\work\\a.py"');
    expect(launchCommand("\\\\?\\UNC\\srv\\share\\a.py")).toBe('fullmag "\\\\srv\\share\\a.py"');
  });

  it("escapes what a double-quoted POSIX word still expands", () => {
    expect(launchCommand("/home/ana/my sims/sp4.py")).toBe('fullmag "/home/ana/my sims/sp4.py"');
    expect(launchCommand('/tmp/a"b$c`d\\e.py')).toBe('fullmag "/tmp/a\\"b\\$c\\`d\\\\e.py"');
  });

  it("cannot be broken out of on Windows, where a path holds no double quote", () => {
    expect(launchCommand('C:\\a"b.py')).toBe('fullmag "C:\\ab.py"');
  });
});

describe("runChip", () => {
  it("maps the states the CLI records", () => {
    expect(runChip({ status: "ok", at: "" })).toMatchObject({ status: "ready", label: "Run ok" });
    expect(runChip({ status: "failed", at: "" })).toMatchObject({ status: "failed", label: "Run failed" });
  });

  it("never shows an unfinished run as running", () => {
    const chip = runChip({ status: "started", at: "" });
    expect(chip).toMatchObject({ status: "draft", label: "Run started" });
    expect(chip?.title).toContain("did not report an outcome");
  });

  it("passes an unknown status through and returns null without a run", () => {
    expect(runChip({ status: "queued-elsewhere", at: "" })).toMatchObject({
      status: "draft",
      label: "queued-elsewhere",
    });
    expect(runChip(undefined)).toBeNull();
  });
});

describe("formatLines and formatDuration", () => {
  it("formats the line count and marks a truncated count", () => {
    expect(formatLines(script({ id: 1, meta: { lines: 1 } }))).toBe("1 line");
    expect(formatLines(script({ id: 1, meta: { lines: 1240 } }))).toBe("1,240 lines");
    expect(formatLines(script({ id: 1, meta: { lines: 5000, truncated: true } }))).toBe("5,000+ lines");
    expect(formatLines(script({ id: 1 }))).toBeNull();
  });

  it("formats durations and refuses nonsense", () => {
    expect(formatDuration(42.46)).toBe("42.5 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(7260)).toBe("2 h 1 min");
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe("paths", () => {
  it("takes the folder of either separator style", () => {
    expect(folderOf("C:\\work\\sp4.py")).toBe("C:\\work");
    expect(folderOf("/home/ana/sp4.py")).toBe("/home/ana");
    expect(folderOf("sp4.py")).toBe("sp4.py");
  });

  it("hides the verbatim prefix in displayed paths", () => {
    expect(displayPath("\\\\?\\C:\\a.py")).toBe("C:\\a.py");
    expect(displayPath("/a.py")).toBe("/a.py");
  });
});

describe("copyText", () => {
  it("writes to the clipboard and reports success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("reports false when there is no clipboard or it refuses", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText("x")).toBe(false);
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    expect(await copyText("x")).toBe(false);
  });
});

describe("a run that the desktop host recorded", () => {
  it("shows a cancelled run as stopped, never as failed or running", () => {
    expect(runChip({ status: "cancelled", at: "2026-10-05T10:00:00.000Z" })?.label).toBe("Run stopped");
  });
});
