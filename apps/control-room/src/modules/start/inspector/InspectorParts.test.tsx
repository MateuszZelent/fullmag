import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TestEvent,
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  type TestDocument,
  type TestElement,
} from "../../../kernel/layout/simulationPreparationTestDom.test-support";

import {
  InspectorActionBar,
  InspectorHeader,
  InspectorPanel,
  InspectorTabs,
  RunsTable,
  type RunRow,
} from "./InspectorParts";

const TABS = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
] as const;

describe("InspectorTabs markup", () => {
  const html = renderToStaticMarkup(
    <>
      <InspectorTabs baseId="x" label="Sections" onChange={vi.fn()} tabs={TABS} value="b" />
      <InspectorPanel baseId="x" tab="b">
        body
      </InspectorPanel>
    </>,
  );

  it("is a labelled tablist with one tab stop, and the panel is labelled by the selected tab", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Sections"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/id="x-tab-b"[^>]*tabindex="0"|tabindex="0"[^>]*id="x-tab-b"/);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-controls="x-panel"');
    expect(html).toMatch(/role="tabpanel"/);
    expect(html).toContain('aria-labelledby="x-tab-b"');
    expect(html).toContain('id="x-panel"');
  });
});

describe("InspectorParts interactions", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let roots: Root[];
  let clipboard: { writeText: ReturnType<typeof vi.fn<(value: string) => Promise<void>>> };

  beforeEach(() => {
    clipboard = { writeText: vi.fn(async (_value: string) => undefined) };
    dom = installSimulationPreparationTestDom({ clipboard });
    roots = [];
    const document = dom.document as TestDocument & { getElementById?: (id: string) => TestElement | null };
    document.getElementById = (id: string) =>
      findElements(document, (element) => element.getAttribute("id") === id)[0] ?? null;
  });
  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    dom.restore();
  });

  async function mount(node: React.ReactNode): Promise<TestElement> {
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    roots.push(root);
    await act(async () => root.render(node));
    return container;
  }

  const key = (target: TestElement, name: string) =>
    act(async () => {
      target.dispatchEvent(new TestEvent("keydown", { bubbles: true, key: name }));
    });

  it("moves between tabs with the arrows, Home and End, wrapping at the ends, and focuses the new tab", async () => {
    const seen: string[] = [];
    function Host() {
      const [value, setValue] = useState<"a" | "b" | "c">("a");
      return (
        <InspectorTabs
          baseId="t"
          label="Sections"
          onChange={(next) => {
            seen.push(next);
            setValue(next);
          }}
          tabs={TABS}
          value={value}
        />
      );
    }
    const container = await mount(<Host />);
    const tab = (id: string) =>
      findElement(container, (e) => e.getAttribute("id") === `t-tab-${id}`, `tab ${id}`);

    await key(tab("a"), "ArrowRight");
    expect(seen).toEqual(["b"]);
    expect(dom.document.activeElement?.getAttribute("id")).toBe("t-tab-b");

    await key(tab("b"), "End");
    await key(tab("c"), "ArrowRight");
    await key(tab("a"), "ArrowLeft");
    await key(tab("c"), "Home");
    expect(seen).toEqual(["b", "c", "a", "c", "a"]);

    await key(tab("a"), "Enter");
    expect(seen).toHaveLength(5);
    expect(tab("a").getAttribute("aria-selected")).toBe("true");
  });

  it("copies the path, says so in the button's name, and reports a clipboard that refuses", async () => {
    const failed = vi.fn();
    const container = await mount(
      <InspectorHeader
        chips={null}
        moreActions={[]}
        name="sp4"
        onCopyFailed={failed}
        onTogglePin={vi.fn()}
        path={"C:\\work\\sp4.py"}
        pinned={false}
      />,
    );
    const copy = () => findElement(container, (e) => e.tagName === "BUTTON" && /Copy path|Path copied/.test(e.getAttribute("aria-label") ?? ""), "copy");

    await act(async () => {
      copy().click();
      await Promise.resolve();
    });
    expect(clipboard.writeText).toHaveBeenCalledWith("C:\\work\\sp4.py");
    expect(copy().getAttribute("aria-label")).toBe("Path copied");

    clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      copy().click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("toggles the pin and runs the primary and external actions of the bar", async () => {
    const pin = vi.fn();
    const primary = vi.fn();
    const external = vi.fn();
    const container = await mount(
      <>
        <InspectorHeader chips={null} moreActions={[]} name="x" onTogglePin={pin} path="/x" pinned={false} />
        <InspectorActionBar
          externalLabel="Reveal"
          onExternal={external}
          onPrimary={primary}
          primaryAction="go"
          primaryLabel="Go"
          splitActions={[]}
        />
      </>,
    );
    const byLabel = (label: string) =>
      findElement(container, (e) => e.tagName === "BUTTON" && e.getAttribute("aria-label") === label, label);
    await act(async () => byLabel("Pin x").click());
    await act(async () => byLabel("Reveal").click());
    await act(async () =>
      findElement(container, (e) => e.getAttribute("data-action") === "go", "primary").click(),
    );
    expect([pin.mock.calls.length, external.mock.calls.length, primary.mock.calls.length]).toEqual([1, 1, 1]);
    expect(findElements(container, (e) => e.getAttribute("aria-label") === "More open options")).toHaveLength(0);
  });
});

describe("InspectorActionBar markup", () => {
  it("joins the dropdown to the primary button and gives each disabled control its reason", () => {
    const html = renderToStaticMarkup(
      <InspectorActionBar
        externalDisabledReason="Needs the desktop app"
        externalLabel="Reveal in folder"
        onExternal={vi.fn()}
        onPrimary={vi.fn()}
        primaryAction="open"
        primaryDisabledReason="The file is missing."
        primaryLabel="Open"
        splitActions={[{ id: "x", label: "X", onSelect: vi.fn() }]}
      >
        <p>extra</p>
      </InspectorActionBar>,
    );
    expect(html).toContain("fm-start-btn-group");
    expect(html).toContain('aria-label="More open options"');
    expect(html).toMatch(/data-action="open"[^>]*disabled=""[^>]*title="The file is missing\."/);
    expect(html).toMatch(/aria-label="Reveal in folder"[^>]*disabled=""[^>]*title="Needs the desktop app"/);
    expect(html).toContain("fm-start-actionbar__extra");
  });
});

describe("RunsTable", () => {
  const rows: RunRow[] = [
    { key: "1", label: "run-1", status: "ready", statusWord: "Ready", startedAt: "2026-10-03T10:00:00Z", durationSeconds: 120, outputBytes: 2000 },
    { key: "2", label: "run-2", status: "failed", statusWord: "Failed", onSelect: vi.fn() },
  ];
  const html = renderToStaticMarkup(<RunsTable formatOutput={(b) => (b === undefined ? "—" : `${b} B`)} rows={rows} />);

  it("has a hidden caption, column headers and row headers", () => {
    expect(html).toContain('<caption class="fm-start-visually-hidden">Runs</caption>');
    expect(html.match(/<th scope="col">/g)).toHaveLength(4);
    expect(html.match(/<th scope="row">/g)).toHaveLength(2);
  });

  it("writes a dash where a run recorded nothing, and makes only a selectable row a button", () => {
    expect(html).toContain("2 min");
    expect(html).toContain("2000 B");
    const second = html.slice(html.indexOf("run-2") - 200);
    expect(second.match(/—/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('title="Show run-2"');
  });
});
