import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { project, script } from "../model/__fixtures__/workspaceScripts";
import { projectRow, scriptRow } from "../model/recentRows";

import { buildListItems, VIRTUALISE_ABOVE } from "./recentListModel";
import { ScriptRow } from "./ScriptRow";

const render = (item = script({ id: 3, name: "sp4", path: "/home/ana/bench/sp4.py" }), selected = false) =>
  renderToStaticMarkup(
    <ScriptRow
      item={item}
      onActivate={vi.fn()}
      onSelect={vi.fn()}
      onTogglePin={vi.fn()}
      selected={selected}
    />,
  );

describe("ScriptRow", () => {
  it("shows the .py badge, name, folder and an option role for the listbox", () => {
    const html = render();
    expect(html).toContain('role="option"');
    expect(html).toContain('id="fm-start-script-3"');
    expect(html).toContain(">.py<");
    expect(html).toContain(">sp4<");
    expect(html).toContain("/home/ana/bench");
    // The folder, not the file name, sits on the second line.
    expect(html).not.toContain(">/home/ana/bench/sp4.py<");
  });

  it("shows lines, the last run chip and when it was last used", () => {
    const html = render(
      script({
        id: 1,
        lastUsedAt: "2020-01-02T10:00:00Z",
        meta: { lines: 120, lastRun: { status: "ok", at: "2020-01-02T10:00:00Z" } },
      }),
    );
    expect(html).toContain("120 lines");
    expect(html).toContain("Run ok");
    expect(html).toContain("fm-start-pill--ready");
    expect(html).toContain("2020");
  });

  it("shows a failed last run and a dash when the line count is unknown", () => {
    const html = render(script({ id: 1, meta: { lastRun: { status: "failed", at: "" } } }));
    expect(html).toContain("Run failed");
    expect(html).toContain("fm-start-pill--failed");
    expect(html).toContain(">—<");
  });

  it("flags a missing file with the Missing state and not the run chip", () => {
    const html = render(
      script({ id: 1, status: "missing", meta: { lastRun: { status: "ok", at: "" } } }),
    );
    expect(html).toContain('data-status="missing"');
    expect(html).toContain("Missing");
    expect(html).not.toContain("Run ok");
  });

  it("marks a pinned script for assistive technology as well as visually", () => {
    const html = render(script({ id: 1, pinned: true }));
    expect(html).toContain('data-pinned="true"');
    expect(html).toContain(", pinned");
    expect(render(script({ id: 1 }))).not.toContain(", pinned");
  });

  it("reflects the selection", () => {
    expect(render(undefined, true)).toContain('aria-selected="true"');
    expect(render(undefined, false)).toContain('aria-selected="false"');
  });
});

describe("buildListItems over mixed rows", () => {
  const rows = [
    scriptRow(script({ id: 1, pinned: true })),
    projectRow(project({ projectId: "p" })),
    scriptRow(script({ id: 2, lastUsedAt: "2001-01-01T00:00:00Z" })),
  ];

  it("numbers only the selectable rows and hoists pinned into one group", () => {
    const items = buildListItems(rows, true, new Date("2026-10-04T12:00:00Z"));
    expect(items.filter((i) => i.kind === "header").map((i) => i.kind === "header" && i.id)).toEqual([
      "pinned",
      "yesterday",
      "older",
    ]);
    const ordinals = items.flatMap((i) => (i.kind === "row" ? [i.ordinal] : []));
    expect(ordinals).toEqual([0, 1, 2]);
  });

  it("stays flat when the sort is not by recency", () => {
    const items = buildListItems(rows, false);
    expect(items.every((i) => i.kind === "row")).toBe(true);
  });

  it("keeps the virtualisation threshold of the project list", () => {
    expect(VIRTUALISE_ABOVE).toBe(40);
  });
});
