import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceItemsController } from "../model/useWorkspaceItems";
import type { WorkspaceRootsController } from "../model/useWorkspaceRoots";

import { IndexedLocations } from "./IndexedLocations";
import { SettingsSection } from "./SettingsSection";

const roots = vi.hoisted(() => ({ current: null as unknown as WorkspaceRootsController }));
vi.mock("../model/useWorkspaceRoots", () => ({ useWorkspaceRoots: () => roots.current }));
// The profile catalogue needs a kernel; it is covered where the kernel is provided.
vi.mock("./ExecutionProfilesSettings", () => ({ ExecutionProfilesSettings: () => null }));

const workspace = (over: Partial<WorkspaceItemsController> = {}): WorkspaceItemsController => ({
  state: { kind: "ready", list: { items: [], outcome: { state: "ready" }, skipped: 0 } },
  announcement: "",
  refresh: vi.fn(),
  pin: vi.fn(async () => null),
  forget: vi.fn(async () => null),
  scan: vi.fn(async () => ({ failure: "x" })),
  addByPath: vi.fn(async () => ({ failure: "x" })),
  thumbnailUrl: (id: string) => id,
  archiveUrl: (id: string) => id,
  loadFrames: vi.fn(async () => ({ indexed: false, total: 0, from: 0, frames: [], truncated: false })),
  scanning: false,
  ...over,
});

const readyRoots = (...paths: string[]): WorkspaceRootsController => ({
  state: {
    kind: "ready",
    roots: paths.map((path) => ({ path, kinds: ["project", "script"], recursive: true, enabled: path !== "/off" })),
  },
  save: vi.fn(async () => null),
});

/** The opening tag of the button whose label contains `text`. */
function openingTagOf(html: string, text: string): string {
  const segment = html.split("<button").find((part) => part.includes(text) && part.indexOf(text) < part.indexOf("</button>"));
  return segment ? `<button${segment.slice(0, segment.indexOf(">") + 1)}` : "";
}

const render = (over: Partial<WorkspaceItemsController> = {}) =>
  renderToStaticMarkup(<IndexedLocations workspace={workspace(over)} />);

beforeEach(() => {
  roots.current = readyRoots("D:\\sim", "/off");
});

describe("IndexedLocations", () => {
  it("is a labelled section listing each folder with its kinds and flags", () => {
    const html = render();
    expect(html).toContain("Indexed locations");
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('data-section="indexed-locations"');
    expect(html).toContain('aria-label="Indexed folders"');
    expect(html).toContain("D:\\sim");
    expect(html).toContain('aria-label="Kinds indexed in D:\\sim"');
    for (const label of ["Projects", "Scripts", "Results", "Subfolders", "Enabled"]) expect(html).toContain(label);
    expect(html).toContain('aria-label="Remove D:\\sim"');
  });

  it("checks the kinds a root indexes and unchecks the others, and the disabled flag", () => {
    const html = render();
    const first = html.slice(html.indexOf("D:\\sim"), html.indexOf("/off"));
    expect(first.match(/checked=""/g)).toHaveLength(4);
    const second = html.slice(html.indexOf("/off"));
    expect(second.match(/checked=""/g)).toHaveLength(3);
  });

  it("adds a folder by typing its absolute path, since a browser has no folder picker", () => {
    const html = render();
    expect(html).toContain("Folder to index (absolute path)");
    expect(html).toContain("Add folder");
    // There is no native picker without the desktop host.
    expect(html).not.toContain("Browse…");
  });

  it("starts with Save disabled (nothing changed) and Scan now enabled", () => {
    const html = render();
    expect(openingTagOf(html, "Save locations")).toContain(' disabled=""');
    expect(openingTagOf(html, "Scan now")).not.toContain(' disabled=""');
    expect(openingTagOf(html, "Scan now")).toContain('title="Scan the indexed folders now"');
  });

  it("shows a scan in progress as busy and disabled", () => {
    const html = render({ scanning: true });
    expect(html).toContain("Scanning…");
    expect(openingTagOf(html, "Scanning…")).toContain('aria-busy="true"');
    expect(openingTagOf(html, "Scanning…")).toContain(' disabled=""');
  });

  it("says when no folder is indexed yet", () => {
    roots.current = readyRoots();
    expect(render()).toContain("No folder is indexed yet");
  });

  it("says what is happening, or wrong, instead of a list", () => {
    roots.current = { state: { kind: "loading" }, save: vi.fn() };
    expect(render()).toContain("Reading the locations");
    roots.current = { state: { kind: "error", message: "database is locked" }, save: vi.fn() };
    expect(render()).toContain("Could not read the locations: database is locked");
    roots.current = { state: { kind: "unavailable", reason: "no route" }, save: vi.fn() };
    const html = render();
    expect(html).toContain("no route");
    expect(html).not.toContain("Folder to index");
  });
});

describe("SettingsSection", () => {
  const recent = {
    state: { kind: "unavailable" as const },
    rebuilding: false,
    announcement: "",
    refresh: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
  };

  it("shows Indexed locations when the backend serves the database", () => {
    const html = renderToStaticMarkup(<SettingsSection recent={recent} workspace={workspace()} />);
    expect(html).toContain("Indexed locations");
    expect(html).not.toContain("Scanned locations");
  });

  it("keeps the desktop's Scanned locations without it", () => {
    const html = renderToStaticMarkup(
      <SettingsSection recent={recent} workspace={workspace({ state: { kind: "unavailable", reason: "x" } })} />,
    );
    expect(html).toContain("Scanned locations");
    expect(html).not.toContain("Indexed locations");
    expect(renderToStaticMarkup(<SettingsSection recent={recent} />)).toContain("Scanned locations");
  });
});
