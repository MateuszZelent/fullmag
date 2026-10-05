import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { apiItem } from "../model/__fixtures__/workspaceApi";

import { ResultRow, resultRowDomId, type ResultRowProps } from "./ResultRow";

const item = apiItem({
  id: "r1",
  kind: "result",
  name: "run-0003",
  path: "C:\\work\\sp4.out\\run-0003.zarr",
  sizeBytes: 318_000_000,
  modifiedAt: "2026-10-03T10:00:00Z",
  meta: { status: "completed", source_name: "sp4" },
});

const props = (over: Partial<ResultRowProps> = {}): ResultRowProps => ({
  item,
  selected: false,
  onSelect: vi.fn(),
  onActivate: vi.fn(),
  onTogglePin: vi.fn(),
  ...over,
});
const render = (over: Partial<ResultRowProps> = {}) => renderToStaticMarkup(<ResultRow {...props(over)} />);

describe("ResultRow", () => {
  it("is an option with a folder glyph, its name, source, badge, status, size and a stable id", () => {
    const html = render();
    expect(html).toContain('role="option"');
    expect(html).toContain('data-kind="result"');
    expect(html).toContain(`id="${resultRowDomId("r1")}"`);
    expect(html).toContain("run-0003");
    expect(html).toContain("from sp4");
    expect(html).toContain(">.zarr<");
    expect(html).toContain("Complete");
    expect(html).toContain("318 MB");
    expect(html).toContain('aria-selected="false"');
  });

  it("shows the folder's path, shortened, when no source is recorded", () => {
    const html = render({ item: { ...item, meta: {} } });
    expect(html).not.toContain("from ");
    expect(html).toContain('title="C:\\work\\sp4.out\\run-0003.zarr"');
  });

  it("marks selection and, for a pinned row, says so to assistive technology", () => {
    expect(render({ selected: true })).toContain('aria-selected="true"');
    expect(render({ item: { ...item, pinned: true } })).toContain(", pinned");
  });

  it("shows no status for a folder that recorded none, and the folder's own bad state", () => {
    const quiet = render({ item: { ...item, meta: {} } });
    expect(quiet).not.toContain("fm-start-pill");
    expect(render({ item: { ...item, status: "missing" } })).toContain("fm-start-pill--missing");
    expect(render({ item: { ...item, status: "missing" } })).toContain('data-status="missing"');
  });

  it("writes a dash for an unknown size", () => {
    expect(render({ item: { ...item, sizeBytes: undefined } })).toContain("—");
  });
});
