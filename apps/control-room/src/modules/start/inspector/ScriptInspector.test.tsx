import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RAW_API_ITEM, RAW_API_SCRIPT_DETAIL, detailAnswer } from "../model/__fixtures__/workspaceApi";
import { script } from "../model/__fixtures__/workspaceScripts";
import { RUN_NEEDS_DESKTOP } from "../model/scriptRun";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import { NEEDS_DESKTOP } from "../model/workspaceSource";

import {
  READ_ONLY_REASON,
  ScriptInspector,
  scriptChecks,
  scriptFacts,
  scriptMenus,
  type ScriptInspectorProps,
} from "./ScriptInspector";
import { parseApiItemDetail, type ScriptDetail } from "../model/workspaceApiTypes";

const item = script({
  id: "wi-script-1",
  name: "sp4",
  path: "C:\\work\\sp4.py",
  useCount: 3,
  sizeBytes: 2048,
  modifiedAt: "2026-10-02T09:30:00.000Z",
  meta: {
    lines: 120,
    summary: "Standard problem 4",
    usesFullmag: true,
    lastRun: { status: "ok", at: "2026-10-03T11:00:00.000Z", durationSeconds: 42.5, device: "cpu" },
  },
});

const ready = (over: Record<string, unknown> = {}): WorkspaceItemDetailState => ({
  kind: "ready",
  answer: detailAnswer({
    item: RAW_API_ITEM,
    detail: { ...RAW_API_SCRIPT_DETAIL, syntax: { ok: true }, imports: { unresolved: [] }, ...over },
    events: [
      {
        at: "2026-10-03T12:00:00Z",
        kind: "run",
        actor: "cli",
        detail: { status: "ok", duration_seconds: 42.5, device: "cpu", run_id: "run-3" },
      },
      {
        at: "2026-10-03T10:00:00Z",
        kind: "edit",
        actor: "desktop",
        detail: { before: { sha256: "a1b2c3d4e5f6", lines: 112 }, after: { sha256: "e4f5a6b7c8d9", lines: 120 } },
      },
    ],
    linked_results: [
      {
        id: "res-1",
        kind: "result",
        path: "C:\\work\\out\\run-0002.zarr",
        name: "run-0002",
        size_bytes: 318000000,
        first_seen_at: "2026-10-02T06:00:00Z",
        meta: { run_id: "run-2", status: "completed", duration_seconds: 412 },
      },
    ],
  }),
});

const idle: WorkspaceItemDetailState = { kind: "idle" };

const props = (over: Partial<ScriptInspectorProps> = {}): ScriptInspectorProps => ({
  item,
  detail: idle,
  readOnly: false,
  desktopId: null,
  onOpen: vi.fn(),
  onReveal: vi.fn(),
  onReadText: vi.fn(),
  onTogglePin: vi.fn(),
  onForget: vi.fn(),
  ...over,
});

const render = (over: Partial<ScriptInspectorProps> = {}) =>
  renderToStaticMarkup(<ScriptInspector {...props(over)} />);

const button = (html: string, action: string) =>
  new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html)?.[0] ?? "";

describe("ScriptInspector layout", () => {
  it("has the sketch's parts: preview, header, tabs, panel and the action bar", () => {
    const html = render();
    expect(html).toContain('aria-label="Script details"');
    expect(html).toContain('data-kind="script"');
    expect(html).toContain("Last result");
    expect(html).toContain(">sp4<");
    expect(html).toContain("C:\\work\\sp4.py");
    expect(html).toContain('aria-label="Copy path"');
    expect(html).toContain('aria-label="More actions"');
    expect(html).toContain('aria-label="More open options"');
    expect(html).toContain('aria-label="Reveal in folder"');
    expect(html).toContain("Run ok");
    expect(html).toContain(">.py<");
  });

  it("is a tablist of Overview, History and Runs with one selected tab and a labelled panel", () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Script sections"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(tabs).toEqual(["Overview", "History", "Runs"]);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toMatch(/role="tabpanel"/);
    expect(html).toMatch(/aria-labelledby="[^"]*-tab-overview"/);
  });

  it("shows the summary, the facts and the last run on Overview", () => {
    const html = render();
    expect(html).toContain("Standard problem 4");
    expect(html).toContain("120 lines");
    expect(html).toContain("2 kB");
    expect(html).toContain("3 times");
    expect(html).toMatch(/Uses fullmag<\/dt><dd>Yes</);
    expect(html).toContain("Last run");
    expect(html).toContain("42.5 s");
    expect(html).toContain("cpu");
  });

  it("says when no run is recorded and shows unknown facts as Unknown", () => {
    const html = render({ item: script({ id: "b", name: "bare", path: "/bare.py", useCount: 1 }) });
    expect(html).toContain("No run is recorded");
    expect(html).toContain("1 time");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("Summary");
  });
});

describe("ScriptInspector detail from the backend", () => {
  it("adds the checks and file facts when the backend read the file", () => {
    const html = render({ detail: ready({ syntax: { ok: true }, imports: { unresolved: ["scipy"] } }) });
    expect(html).toContain("Checks");
    expect(html).toContain("No syntax errors");
    expect(html).toMatch(/Imports not found<\/dt><dd>.*scipy/);
    expect(html).toMatch(/Environment reads<\/dt><dd>.*FULLMAG_DEVICE/);
    expect(html).toContain("utf-8");
    expect(html).toContain("e4f5a6b7c8d9");
  });

  it("reads 'unavailable' for a check the backend did not send, and does not crash", () => {
    const html = render({
      detail: {
        kind: "ready",
        answer: detailAnswer({ item: RAW_API_ITEM, detail: { kind: "script" } }),
      },
    });
    expect(html).toMatch(/Syntax<\/dt><dd>unavailable</);
    expect(html).toMatch(/Environment reads<\/dt><dd>unavailable</);
    expect(html).toMatch(/Encoding<\/dt><dd>unavailable</);
  });

  it("shows a syntax error as a danger banner and a chip, verbatim", () => {
    const html = render({ detail: ready({ syntax: { ok: false, line: 14, message: "unexpected indent" } }) });
    expect(html).toContain('data-banner="syntax"');
    expect(html).toContain("Syntax error at line 14.");
    expect(html).toContain("unexpected indent");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Syntax error</span>");
  });

  it("explains a file the backend could not read, keeping the row's facts", () => {
    const html = render({
      detail: { kind: "ready", answer: detailAnswer({ item: RAW_API_ITEM, detail: { kind: "script", read_error: "permission denied" } }) },
    });
    expect(html).toContain('data-banner="unreadable"');
    expect(html).toContain("permission denied");
    expect(html).toContain("120 lines");
  });

  it("says what it is waiting for, or why there is nothing", () => {
    expect(render({ detail: { kind: "loading" } })).toContain("Reading the file");
    expect(render({ detail: { kind: "error", message: "502" } })).toContain("Could not read the script details: 502");
    expect(render({ detail: { kind: "unavailable", reason: "x" } })).toContain("checked by a Fullmag backend");
  });

  it("lists the history as the script's own events, with edits shown as before and after", () => {
    const html = render({ detail: ready(), initialTab: "history" });
    expect(html).toContain("fm-start-timeline");
    expect(html).toContain("Edited");
    expect(html).toContain("112 → 120 lines · a1b2c3d → e4f5a6b");
    expect(html).toContain("desktop app");
    expect(html).toContain("Run");
    expect(html).toContain("command line");
  });

  it("shows the desktop history, or its absence, when the backend did not answer", () => {
    expect(render({ initialTab: "history" })).toContain("The history is read by the desktop app or the backend");
    expect(render({ detail: { kind: "loading" }, initialTab: "history" })).toContain("Reading the history");
  });

  it("lists runs and result folders in the Runs table, with each folder selectable", () => {
    const html = render({ detail: ready(), initialTab: "runs", onSelectResult: vi.fn() });
    expect(html).toContain("fm-start-runs");
    expect([...html.matchAll(/<th scope="col">([^<]*)</g)].map((m) => m[1])).toEqual([
      "Run",
      "Started",
      "Duration",
      "Output",
    ]);
    expect(html).toContain("run-0002");
    expect(html).toContain("318 MB");
    expect(html).toContain("7 min");
    expect(html).toContain("run-3");
    expect(html).toContain('title="Show run-0002"');
  });

  it("does not make a folder row a button without a selection handler", () => {
    expect(render({ detail: ready(), initialTab: "runs" })).not.toContain('title="Show run-0002"');
  });

  it("says no runs are recorded on an empty Runs tab, and why without a backend", () => {
    const empty: WorkspaceItemDetailState = {
      kind: "ready",
      answer: detailAnswer({ item: RAW_API_ITEM, detail: RAW_API_SCRIPT_DETAIL }),
    };
    expect(render({ detail: empty, initialTab: "runs" })).toContain("No run is recorded");
    expect(render({ initialTab: "runs" })).toContain("listed by a Fullmag backend");
  });

  it("previews the latest result folder that has a thumbnail", () => {
    const withThumb: WorkspaceItemDetailState = {
      kind: "ready",
      answer: detailAnswer({
        item: RAW_API_ITEM,
        detail: RAW_API_SCRIPT_DETAIL,
        linked_results: [
          { id: "res-9", kind: "result", path: "/o.zarr", name: "o", has_thumbnail: true, modified_at: "2026-10-03" },
        ],
      }),
    };
    const html = render({ detail: withThumb, thumbnailUrl: (id) => `/thumb/${id}/thumbnail` });
    expect(html).toContain('src="/thumb/res-9/thumbnail?v=2026-10-03"');
    expect(html).toContain('aria-label="Last result of sp4"');
  });
});

describe("ScriptInspector actions", () => {
  it("disables Run in new window, with the reason, when there is no desktop host", () => {
    const html = render();
    const run = button(html, "run-script");
    expect(run).toContain(' disabled=""');
    expect(run).toContain(`title="${RUN_NEEDS_DESKTOP}"`);
    expect(run).toContain("aria-describedby=");
    expect(html).toContain(`${RUN_NEEDS_DESKTOP}.`);
    expect(html).not.toContain("Review and run");
  });

  it("disables what only the desktop can do in a browser, and says so", () => {
    const html = render();
    const open = button(html, "open-script");
    expect(open).toContain(' disabled=""');
    expect(open).toContain(`title="${NEEDS_DESKTOP}"`);
    expect(html).toMatch(/<button[^>]*aria-label="Reveal in folder"[^>]*disabled=""/);
  });

  it("disables what needs the file when it is missing, and says so", () => {
    const html = render({ item: { ...item, status: "missing" } });
    expect(html).toContain('data-banner="missing"');
    expect(html).toContain("The file is missing.");
    expect(button(html, "open-script")).toContain('title="The file is missing."');
    expect(html).toMatch(/<button[^>]*aria-label="Reveal in folder"[^>]*disabled=""/);
  });

  it("disables pin when the database is read-only, naming the reason", () => {
    const html = render({ readOnly: true });
    expect(html).toMatch(/<button[^>]*aria-label="Pin sp4"[^>]*disabled=""[^>]*>/);
    expect(html).toContain(`title="${READ_ONLY_REASON}"`);
  });

  it("labels the pin by its state", () => {
    expect(render({ item: { ...item, pinned: true } })).toContain('aria-label="Unpin sp4"');
    expect(render({ item: { ...item, pinned: true } })).toContain('aria-pressed="true"');
  });
});

describe("scriptMenus", () => {
  const input = {
    item,
    readOnly: false,
    busy: false,
    desktopReason: null,
    onCopyPath: vi.fn(),
    onReveal: vi.fn(),
    onCopyScript: vi.fn(),
    onCopyCommand: vi.fn(),
    onForget: vi.fn(),
  };
  const byId = (menus: ReturnType<typeof scriptMenus>) =>
    Object.fromEntries([...menus.more, ...menus.split].map((a) => [a.id, a]));

  it("offers every documented action", () => {
    const menus = scriptMenus(input);
    expect(menus.more.map((a) => a.id)).toEqual(["copy-path", "reveal-script", "forget-script"]);
    expect(menus.split.map((a) => a.id)).toEqual(["copy-script", "copy-command"]);
    expect(menus.more[2]?.separatorBefore).toBe(true);
  });

  it("disables what needs the file, keeps the launch command and path, and forget needs a writable database", () => {
    const missing = byId(scriptMenus({ ...input, item: { ...item, status: "missing" }, readOnly: true }));
    expect(missing["reveal-script"]?.disabledReason).toBe("The file is missing.");
    expect(missing["copy-script"]?.disabledReason).toBe("The file is missing.");
    expect(missing["copy-command"]?.disabledReason).toBeUndefined();
    expect(missing["copy-path"]?.disabledReason).toBeUndefined();
    expect(missing["forget-script"]?.disabledReason).toBe(READ_ONLY_REASON);
  });

  it("names the missing desktop as the reason for reveal and copy", () => {
    const menus = byId(scriptMenus({ ...input, desktopReason: NEEDS_DESKTOP }));
    expect(menus["reveal-script"]?.disabledReason).toBe(NEEDS_DESKTOP);
    expect(menus["copy-script"]?.disabledReason).toBe(NEEDS_DESKTOP);
    expect(menus["copy-command"]?.disabledReason).toBeUndefined();
  });

  it("disables file actions while another one runs", () => {
    const menus = byId(scriptMenus({ ...input, busy: true }));
    expect(menus["reveal-script"]?.disabledReason).toBe("Another action is running");
  });
});

describe("scriptFacts and scriptChecks", () => {
  const detail = (raw: Record<string, unknown>): ScriptDetail => {
    const parsed = parseApiItemDetail({ kind: "script", ...raw });
    if (parsed?.kind !== "script") throw new Error("not a script");
    return parsed;
  };

  it("takes size from the detail when the row has none, and adds encoding and hash", () => {
    const rows = scriptFacts({ ...item, sizeBytes: undefined }, detail({ bytes: 5000, encoding: "utf-8", sha256: "abcdef0123456789" }));
    expect(rows.find((r) => r.label === "Size")?.value).toBe("5 kB");
    expect(rows.find((r) => r.label === "Encoding")?.value).toBe("utf-8");
    expect(rows.find((r) => r.label === "SHA-256")?.value).toBe("abcdef012345");
  });

  it("lists no file facts without a detail", () => {
    expect(scriptFacts(item, undefined).map((r) => r.label)).not.toContain("SHA-256");
  });

  it("reads the API's own shape: unresolved_imports at the top level, careful wording", () => {
    const checked = scriptChecks(
      detail({ syntax: { ok: true }, syntax_checked: true, unresolved_imports: ["scipy"], imports: ["numpy", "scipy"], env_reads: [] }),
    );
    expect(checked.map((r) => r.label)).toEqual(["Syntax", "Imports not found", "Environment reads"]);
    expect(checked[0]?.value).toBe("No syntax errors");
    const none = scriptChecks(detail({ syntax: { ok: true }, syntax_checked: true, unresolved_imports: [], env_reads: [] }));
    expect(none[1]?.value).toBe("All found by the interpreter");
  });

  it("says 'not checked' and names the line scan when Python did not check the file", () => {
    const rows = scriptChecks(
      detail({
        syntax: undefined,
        syntax_checked: false,
        degraded: true,
        degraded_reason: "static line scan; no Python interpreter",
        imports: ["numpy"],
        env_reads: [],
      }),
    );
    expect(rows.map((r) => r.label)).toEqual(["Syntax", "Imports (line scan)", "Environment reads", "Checked by"]);
    expect(rows[0]?.value).toBe("not checked");
  });

  it("reads each check, with 'unavailable' for the ones not sent", () => {
    const all = scriptChecks(detail({ syntax: { ok: false, line: 3, message: "bad" }, imports: { unresolved: ["a"] }, env_reads: [] }));
    expect(all.map((r) => r.label)).toEqual(["Syntax", "Imports not found", "Environment reads"]);
    expect(all[0]?.value).toBe("Error at line 3: bad");
    expect(all[2]?.value).toBe("None");
    expect(scriptChecks(detail({})).map((r) => r.value)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(scriptChecks(detail({ imports: { unresolved: [] } }))[1]?.value).toBe("All found by the interpreter");
  });
});
