import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RAW_API_ITEM, RAW_API_RESULT_DETAIL, detailAnswer, entry, parsedItem } from "../model/__fixtures__/workspaceApi";
import { script } from "../model/__fixtures__/workspaceScripts";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";

import {
  ProjectInspector,
  type ProjectInspectorProps,
  type ResultInspectorActions,
  type ScriptInspectorActions,
} from "./ProjectInspector";

const rawResult = {
  id: "res-3",
  kind: "result",
  path: "C:\\out\\run-0003.zarr",
  name: "run-0003",
  first_seen_at: "2026-10-03T06:00:00.000Z",
  last_used_at: "2026-10-03T07:00:00.000Z",
  size_bytes: 1000,
};

const scriptActions = (over: Partial<ScriptInspectorActions> = {}): ScriptInspectorActions => ({
  readOnly: false,
  desktopIdOf: vi.fn(() => null),
  onOpen: vi.fn(),
  onReveal: vi.fn(),
  onReadText: vi.fn(),
  onTogglePin: vi.fn(),
  onForget: vi.fn(),
  ...over,
});
const resultActions = (): ResultInspectorActions => ({
  readOnly: false,
  onTogglePin: vi.fn(),
  onForget: vi.fn(),
  onSelectSource: vi.fn(),
  onOpenResults: vi.fn(),
});

const base: ProjectInspectorProps = {
  compute: null,
  entry: null,
  onForget: vi.fn(),
  onOpen: vi.fn(),
  onTogglePin: vi.fn(),
  openDisabledReason: null,
  section: "home",
  templateId: null,
};
const render = (over: Partial<ProjectInspectorProps> = {}) =>
  renderToStaticMarkup(<ProjectInspector {...base} {...over} />);

describe("ProjectInspector", () => {
  it("never renders blank: with nothing selected it names all three kinds", () => {
    const html = render();
    expect(html).toContain("Nothing selected");
    expect(html).toContain("a project, a script or a result folder");
  });

  it("renders the project inspector for a selected project", () => {
    expect(render({ entry: entry({ projectId: "p1", name: "YIG" }) })).toContain('aria-label="Project details"');
  });

  it("renders the script inspector for a selected script, resolving its desktop id", () => {
    const actions = scriptActions({ desktopIdOf: vi.fn(() => 7) });
    const html = render({ script: script({ id: "s1", name: "sp4" }), scriptActions: actions });
    expect(html).toContain('aria-label="Script details"');
    expect(actions.desktopIdOf).toHaveBeenCalledWith("s1");
  });

  it("renders the result inspector for a selected result folder", () => {
    const html = render({ result: parsedItem(rawResult), resultActions: resultActions() });
    expect(html).toContain('aria-label="Result details"');
    expect(html).toContain(">run-0003<");
  });

  it("passes the backend's detail on to whichever inspector is showing", () => {
    const detail: WorkspaceItemDetailState = {
      kind: "ready",
      answer: detailAnswer({ item: rawResult, detail: RAW_API_RESULT_DETAIL, linked_source: RAW_API_ITEM }),
    };
    const html = render({ result: parsedItem(rawResult), resultActions: resultActions(), detail });
    expect(html).toContain("zarr v2");
    expect(html).toContain("sp4</button>");
  });

  it("gives the project the lead when a stale selection leaves two items", () => {
    const html = render({
      entry: entry({ projectId: "p1" }),
      script: script({ id: "s1" }),
      scriptActions: scriptActions(),
      result: parsedItem(rawResult),
      resultActions: resultActions(),
    });
    expect(html).toContain('aria-label="Project details"');
    expect(html).not.toContain('aria-label="Script details"');
    expect(html).not.toContain('aria-label="Result details"');
  });

  it("shows the hint of the section, not an item, off the Home section", () => {
    const html = render({
      section: "settings",
      entry: entry({ projectId: "p1" }),
      result: parsedItem(rawResult),
      resultActions: resultActions(),
    });
    expect(html).toContain("Settings");
    expect(html).not.toContain('aria-label="Result details"');
  });

  it("does not render a result without its actions", () => {
    expect(render({ result: parsedItem(rawResult) })).toContain("Nothing selected");
  });
});
