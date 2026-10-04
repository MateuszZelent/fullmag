import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { script } from "../model/__fixtures__/workspaceScripts";
import { RUN_SCRIPT_UNAVAILABLE } from "../model/scriptRowModel";

import { ProjectInspector } from "./ProjectInspector";
import { ScriptDetails, type ScriptDetailsProps } from "./ScriptDetails";

const item = script({
  id: 7,
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

const actions = (): Omit<ScriptDetailsProps, "item"> => ({
  readOnly: false,
  onOpen: vi.fn(),
  onReveal: vi.fn(),
  onReadText: vi.fn(),
  onTogglePin: vi.fn(),
  onForget: vi.fn(),
});

const render = (over: Partial<ScriptDetailsProps> = {}) =>
  renderToStaticMarkup(<ScriptDetails item={item} {...actions()} {...over} />);

const button = (html: string, action: string) =>
  new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html)?.[0] ?? "";

describe("ScriptDetails", () => {
  it("shows the name, path, summary and the facts", () => {
    const html = render();
    expect(html).toContain('aria-label="Script details"');
    expect(html).toContain(">sp4<");
    expect(html).toContain("C:\\work\\sp4.py");
    expect(html).toContain("Standard problem 4");
    expect(html).toContain("120 lines");
    expect(html).toContain("2 kB");
    expect(html).toContain("3 times");
    expect(html).toMatch(/Uses fullmag<\/dt><dd>Yes</);
  });

  it("shows the last run and a history that has not loaded yet", () => {
    const html = render();
    expect(html).toContain("Last run");
    expect(html).toContain("42.5 s");
    expect(html).toContain("cpu");
    expect(html).toContain("Reading the history");
  });

  it("offers every documented action", () => {
    const html = render();
    for (const label of [
      "Open script",
      "Run in new window",
      "Reveal in folder",
      "Copy script",
      "Copy launch command",
      "Forget",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Pin sp4");
  });

  it("keeps Run in new window disabled, with the reason, and wires nothing to it", () => {
    const html = render();
    const run = button(html, "run-script");
    expect(run).toContain(' disabled=""');
    expect(run).toContain(`title="${RUN_SCRIPT_UNAVAILABLE}"`);
    expect(run).toContain("aria-describedby=");
    expect(html).toContain(`${RUN_SCRIPT_UNAVAILABLE}.`);
    // The other actions are live.
    expect(button(html, "open-script")).not.toContain(' disabled=""');
    expect(button(html, "copy-command")).not.toContain(' disabled=""');
  });

  it("shows the launch command as the tooltip of its button", () => {
    expect(button(render(), "copy-command")).toContain('title="fullmag &quot;C:\\work\\sp4.py&quot;"');
  });

  it("disables what needs the file when it is missing, and says so", () => {
    const html = render({ item: { ...item, status: "missing" } });
    expect(html).toContain("The file is missing.");
    expect(button(html, "open-script")).toContain(' disabled=""');
    expect(button(html, "reveal-script")).toContain(' disabled=""');
    expect(button(html, "copy-script")).toContain(' disabled=""');
    // The launch command is text; it does not need the file.
    expect(button(html, "copy-command")).not.toContain(' disabled=""');
    expect(button(html, "forget-script")).not.toContain(' disabled=""');
  });

  it("disables pin and forget when the database is read-only", () => {
    const html = render({ readOnly: true });
    expect(button(html, "forget-script")).toContain(' disabled=""');
    expect(html).toMatch(/<button[^>]*aria-label="Pin sp4"[^>]*disabled=""/);
  });

  it("says when no run is recorded and omits unknown facts", () => {
    const html = render({
      item: script({ id: 8, name: "bare", path: "/bare.py", useCount: 1 }),
    });
    expect(html).toContain("No run is recorded");
    expect(html).toContain("1 time");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("Summary");
  });
});

describe("ProjectInspector with a script", () => {
  const props = {
    compute: null,
    entry: null,
    onForget: vi.fn(),
    onOpen: vi.fn(),
    onTogglePin: vi.fn(),
    openDisabledReason: null,
    section: "home" as const,
    templateId: null,
  };

  it("renders the script inspector for a selected script on Home", () => {
    const html = renderToStaticMarkup(
      <ProjectInspector {...props} script={item} scriptActions={actions()} />,
    );
    expect(html).toContain('aria-label="Script details"');
  });

  it("never renders blank: with nothing selected it says what to do", () => {
    const html = renderToStaticMarkup(<ProjectInspector {...props} />);
    expect(html).toContain("Select a project or a script");
  });
});
