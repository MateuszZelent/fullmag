import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "../../../kernel/layout/simulationPreparationTestDom.test-support";
import { apiItem } from "./__fixtures__/workspaceApi";
import { script } from "./__fixtures__/workspaceScripts";
import type { ContinueSession, RecentIndexState } from "./types";
import type { RecentIndexController } from "./useRecentIndex";
import type { WorkspaceApiListState, WorkspaceItemsController } from "./useWorkspaceItems";
import type { WorkspaceScriptsController } from "./useWorkspaceScripts";
import { useWorkspaceSource, type WorkspaceSource } from "./useWorkspaceSource";
import type { ApiWorkspaceItem } from "./workspaceApiTypes";
import { NEEDS_DESKTOP, SCRIPT_NOT_IN_DESKTOP } from "./workspaceSource";

const host = vi.hoisted(() => ({ available: true }));
vi.mock("./workspaceHost", () => ({ workspaceHostAvailable: () => host.available }));

const apiItems: ApiWorkspaceItem[] = [
  apiItem({ id: "wi-p", kind: "project", projectId: "proj", name: "YIG", path: "D:\\sim\\yig.fms", meta: { solver: "FDM" } }),
  apiItem({ id: "wi-s", kind: "script", name: "sp4", path: "C:\\Work\\sp4.py" }),
  apiItem({ id: "wi-s2", kind: "script", name: "other", path: "C:\\work\\other.py" }),
  apiItem({ id: "wi-r", kind: "result", name: "run-1" }),
];

const readyState = (
  items: readonly ApiWorkspaceItem[] = apiItems,
  state: "ready" | "read_only_newer_schema" = "ready",
): WorkspaceApiListState => ({
  kind: "ready",
  list: { items, outcome: { state }, skipped: 0 },
});

function makeWorkspace(state: WorkspaceApiListState): WorkspaceItemsController {
  return {
    state,
    announcement: "api says hi",
    refresh: vi.fn(),
    pin: vi.fn(async () => null),
    forget: vi.fn(async () => null),
    scan: vi.fn(async () => ({ report: { scanned: 1, added: 0, updated: 0, missing: 0, skipped: 0, warnings: [] } })),
    addByPath: vi.fn(async (path: string) => ({ item: apiItem({ id: "added", kind: "script", name: "added", path }) })),
    thumbnailUrl: (id: string) => `/thumb/${id}`,
    archiveUrl: (id: string) => id,
    loadFrames: vi.fn(async () => ({ indexed: false, total: 0, from: 0, frames: [], truncated: false })),
    scanning: false,
  };
}

function makeDesktopRecent(state: RecentIndexState): RecentIndexController {
  return {
    state,
    rebuilding: false,
    announcement: "desktop recent",
    refresh: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    pin: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
  };
}

function makeDesktopScripts(state: WorkspaceScriptsController["state"]): WorkspaceScriptsController {
  return {
    state,
    readOnly: false,
    announcement: "desktop scripts",
    refresh: vi.fn(async () => undefined),
    pin: vi.fn(async () => null),
    forget: vi.fn(async () => null),
    open: vi.fn(async () => null),
    reveal: vi.fn(async () => null),
    pickAndOpen: vi.fn(async () => ({ item: null, failure: null })),
    saveNew: vi.fn(async () => ({ kind: "cancelled" as const })),
    readText: vi.fn(async () => ({ text: "print(1)" })),
  };
}

const desktopScriptsReady = (...ids: number[]) =>
  makeDesktopScripts({
    kind: "ready",
    items: ids.map((id) => script({ id, path: id === 4 ? "c:/work/sp4.py" : `/other${id}.py` })),
    outcome: { state: "ready" },
    skipped: 0,
  });

const session: ContinueSession = {
  projectId: "proj",
  runId: "r",
  checkpointAt: "2026-10-03T10:00:00Z",
  progress: { fraction: 0.5 },
  resumable: true,
};

describe("useWorkspaceSource", () => {
  let restoreDom: () => void;
  let roots: Root[];

  beforeEach(() => {
    restoreDom = installSimulationPreparationTestDom().restore;
    roots = [];
    host.available = true;
  });
  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    restoreDom();
  });

  async function mount(
    workspace: WorkspaceItemsController,
    recent: RecentIndexController,
    scripts: WorkspaceScriptsController,
  ): Promise<() => WorkspaceSource> {
    let latest: WorkspaceSource | undefined;
    function Probe() {
      latest = useWorkspaceSource(workspace, recent, scripts);
      return null;
    }
    const root = createRoot((globalThis.document as unknown as Document).createElement("div"));
    roots.push(root);
    await act(async () => root.render(<Probe />));
    return () => latest as WorkspaceSource;
  }

  const desktopUnavailable = { kind: "unavailable" } as const;
  const scriptsUnavailable = { kind: "unavailable", reason: "no desktop" } as const;

  describe("when the backend serves the database", () => {
    it("builds projects, scripts and results from the one answer", async () => {
      const source = await mount(
        makeWorkspace(readyState()),
        makeDesktopRecent(desktopUnavailable),
        makeDesktopScripts(scriptsUnavailable),
      );
      expect(source().origin).toBe("api");

      const recent = source().recent.state;
      expect(recent.kind === "ready" && recent.index.entries.map((e) => [e.projectId, e.workspaceId])).toEqual([
        ["proj", "wi-p"],
      ]);
      const scripts = source().scripts.state;
      expect(scripts.kind === "ready" && scripts.items.map((i) => i.id)).toEqual(["wi-s", "wi-s2"]);
      const results = source().results.state;
      expect(results.kind === "ready" && results.items.map((i) => i.id)).toEqual(["wi-r"]);
    });

    it("shows the project of a waiting checkpoint as running and keeps the session", async () => {
      const desktop = makeDesktopRecent({
        kind: "ready",
        index: { formatVersion: 1, generatedAt: "t", entries: [], continue: session },
      });
      const source = await mount(makeWorkspace(readyState()), desktop, makeDesktopScripts(scriptsUnavailable));
      const recent = source().recent.state;
      expect(recent.kind === "ready" && recent.index.continue).toBe(session);
      expect(recent.kind === "ready" && recent.index.entries[0]?.status).toBe("running");
    });

    it("has an empty project list, not a missing one, when the backend lists none", async () => {
      const source = await mount(
        makeWorkspace(readyState([apiItems[1]!])),
        makeDesktopRecent(desktopUnavailable),
        makeDesktopScripts(scriptsUnavailable),
      );
      expect(source().recent.state).toEqual({ kind: "empty" });
    });

    it("sends pins, removals and the rebuild to the backend by workspace id", async () => {
      const workspace = makeWorkspace(readyState());
      const desktop = makeDesktopRecent(desktopUnavailable);
      const source = await mount(workspace, desktop, makeDesktopScripts(scriptsUnavailable));

      await source().recent.pin("proj", true);
      await source().recent.forget("proj");
      await source().recent.rebuild();
      await source().recent.pin("unknown", true);

      expect(workspace.pin).toHaveBeenCalledTimes(1);
      expect(workspace.pin).toHaveBeenCalledWith("wi-p", true);
      expect(workspace.forget).toHaveBeenCalledWith("wi-p");
      expect(workspace.scan).toHaveBeenCalledTimes(1);
      expect(desktop.pin).not.toHaveBeenCalled();
      expect(source().recent.announcement).toBe("api says hi");
      expect(source().workspaceIdOfProject("proj")).toBe("wi-p");
    });

    it("pins and forgets scripts and results through the backend too", async () => {
      const workspace = makeWorkspace(readyState());
      const source = await mount(workspace, makeDesktopRecent(desktopUnavailable), makeDesktopScripts(scriptsUnavailable));
      await source().scripts.pin("wi-s", true);
      await source().scripts.forget("wi-s");
      await source().results.pin("wi-r", false);
      await source().results.forget("wi-r");
      expect(workspace.pin).toHaveBeenNthCalledWith(1, "wi-s", true);
      expect(workspace.forget).toHaveBeenNthCalledWith(1, "wi-s");
      expect(workspace.pin).toHaveBeenNthCalledWith(2, "wi-r", false);
      expect(workspace.forget).toHaveBeenNthCalledWith(2, "wi-r");
    });

    it("flags a database from a newer Fullmag as read-only", async () => {
      const source = await mount(
        makeWorkspace(readyState(apiItems, "read_only_newer_schema")),
        makeDesktopRecent(desktopUnavailable),
        makeDesktopScripts(scriptsUnavailable),
      );
      expect(source().scripts.readOnly).toBe(true);
    });

    it("finds the desktop's own id of a script by path, for actions only the desktop can do", async () => {
      const desktop = desktopScriptsReady(4, 5);
      const source = await mount(makeWorkspace(readyState()), makeDesktopRecent(desktopUnavailable), desktop);

      expect(source().scripts.desktopIdOf("wi-s")).toBe(4);
      expect(source().scripts.desktopIdOf("wi-s2")).toBeNull();
      expect(source().scripts.desktopIdOf(9)).toBe(9);

      expect(await source().scripts.open("wi-s")).toBeNull();
      expect(desktop.open).toHaveBeenCalledWith(4);
      expect(await source().scripts.reveal("wi-s")).toBeNull();
      expect(desktop.reveal).toHaveBeenCalledWith(4);
      expect(await source().scripts.readText("wi-s")).toEqual({ text: "print(1)" });
      expect(desktop.readText).toHaveBeenCalledWith(4);
    });

    it("says the desktop does not know a script it cannot match, and that a browser needs the app", async () => {
      const desktop = desktopScriptsReady(4);
      const source = await mount(makeWorkspace(readyState()), makeDesktopRecent(desktopUnavailable), desktop);
      expect(await source().scripts.open("wi-s2")).toBe(SCRIPT_NOT_IN_DESKTOP);
      expect(await source().scripts.readText("wi-s2")).toEqual({ failure: SCRIPT_NOT_IN_DESKTOP });
      expect(desktop.open).not.toHaveBeenCalled();

      host.available = false;
      const browser = await mount(
        makeWorkspace(readyState()),
        makeDesktopRecent(desktopUnavailable),
        makeDesktopScripts(scriptsUnavailable),
      );
      expect(await browser().scripts.reveal("wi-s")).toBe(NEEDS_DESKTOP);
      expect(await browser().scripts.open("wi-s")).toBe(NEEDS_DESKTOP);
    });

    it("registers a script the desktop picker opened with the backend, so its row exists", async () => {
      const workspace = makeWorkspace(readyState());
      const desktop = desktopScriptsReady(4);
      vi.mocked(desktop.pickAndOpen).mockResolvedValueOnce({
        item: script({ id: 4, name: "picked", path: "C:\\x\\picked.py" }),
        failure: null,
      });
      const source = await mount(workspace, makeDesktopRecent(desktopUnavailable), desktop);

      const picked = await source().scripts.pickAndOpen();
      expect(workspace.addByPath).toHaveBeenCalledWith("C:\\x\\picked.py", "script");
      expect(picked.item).toMatchObject({ id: "added", kind: "script" });
      expect(picked.failure).toBeNull();

      vi.mocked(desktop.pickAndOpen).mockResolvedValueOnce({ item: null, failure: null });
      expect(await source().scripts.pickAndOpen()).toEqual({ item: null, failure: null });

      vi.mocked(desktop.pickAndOpen).mockResolvedValueOnce({ item: null, failure: "dialog failed" });
      expect(await source().scripts.pickAndOpen()).toEqual({ item: null, failure: "dialog failed" });
    });

    it("reports the failure when the backend cannot list a picked or saved script", async () => {
      const workspace = makeWorkspace(readyState());
      vi.mocked(workspace.addByPath).mockResolvedValue({ failure: "Could not add: path does not exist" });
      const desktop = desktopScriptsReady(4);
      vi.mocked(desktop.pickAndOpen).mockResolvedValueOnce({ item: script({ id: 4, path: "/p.py" }), failure: null });
      vi.mocked(desktop.saveNew).mockResolvedValueOnce({ kind: "saved", item: script({ id: 4, path: "/p.py" }) });
      const source = await mount(workspace, makeDesktopRecent(desktopUnavailable), desktop);

      expect((await source().scripts.pickAndOpen()).failure).toBe("Could not add: path does not exist");
      const saved = await source().scripts.saveNew({ suggestedName: "p.py", text: "", origin: "template", originId: "t" });
      expect(saved).toEqual({ kind: "failed", message: "Could not add: path does not exist" });
    });

    it("passes a cancelled or failed save through unchanged", async () => {
      const desktop = desktopScriptsReady(4);
      vi.mocked(desktop.saveNew).mockResolvedValueOnce({ kind: "failed", message: "disk full" });
      const source = await mount(makeWorkspace(readyState()), makeDesktopRecent(desktopUnavailable), desktop);
      expect(
        await source().scripts.saveNew({ suggestedName: "a.py", text: "", origin: "mx3", originId: "a.mx3" }),
      ).toEqual({ kind: "failed", message: "disk full" });
    });
  });

  describe("while the backend has not answered", () => {
    it("shows every list as loading and results as loading", async () => {
      const source = await mount(
        makeWorkspace({ kind: "loading" }),
        makeDesktopRecent({ kind: "ready", index: { formatVersion: 1, generatedAt: "t", entries: [] } }),
        desktopScriptsReady(1),
      );
      expect(source().origin).toBe("pending");
      expect(source().recent.state).toEqual({ kind: "loading" });
      expect(source().scripts.state).toEqual({ kind: "loading" });
      expect(source().results.state).toEqual({ kind: "loading" });
    });
  });

  describe("when the backend does not serve the database", () => {
    const missing: WorkspaceApiListState = { kind: "unavailable", reason: "no route" };

    it("falls back to the desktop's lists and offers no results", async () => {
      const recent = makeDesktopRecent({ kind: "ready", index: { formatVersion: 1, generatedAt: "t", entries: [] } });
      const desktop = desktopScriptsReady(4);
      const source = await mount(makeWorkspace(missing), recent, desktop);

      expect(source().origin).toBe("desktop");
      expect(source().recent).toBe(recent);
      expect(source().scripts.state).toBe(desktop.state);
      expect(source().results.state).toEqual({ kind: "unavailable" });
      expect(source().workspaceIdOfProject("proj")).toBeNull();
    });

    it("drives the desktop controller with numeric ids and refuses string ids it cannot map", async () => {
      const desktop = desktopScriptsReady(4);
      const source = await mount(makeWorkspace(missing), makeDesktopRecent(desktopUnavailable), desktop);

      await source().scripts.pin(4, true);
      await source().scripts.open(4);
      await source().scripts.forget(4);
      expect(desktop.pin).toHaveBeenCalledWith(4, true);
      expect(desktop.open).toHaveBeenCalledWith(4);
      expect(desktop.forget).toHaveBeenCalledWith(4);
      expect(source().scripts.desktopIdOf(4)).toBe(4);

      expect(await source().scripts.pin("wi-x", true)).toBe(SCRIPT_NOT_IN_DESKTOP);
      expect(source().scripts.desktopIdOf("wi-x")).toBeNull();
      expect(desktop.pin).toHaveBeenCalledTimes(1);
    });

    it("ends in the desktop-only state when there is no desktop either", async () => {
      const source = await mount(
        makeWorkspace(missing),
        makeDesktopRecent(desktopUnavailable),
        makeDesktopScripts(scriptsUnavailable),
      );
      expect(source().recent.state).toEqual({ kind: "unavailable" });
      expect(source().scripts.state).toEqual({ kind: "unavailable", reason: "no desktop" });
      expect(source().results.state).toEqual({ kind: "unavailable" });
    });

    it("shows a backend failure, rather than hiding it, when there is no desktop to fall back on", async () => {
      const source = await mount(
        makeWorkspace({ kind: "error", message: "database is locked" }),
        makeDesktopRecent(desktopUnavailable),
        makeDesktopScripts(scriptsUnavailable),
      );
      expect(source().recent.state).toEqual({ kind: "error", message: "database is locked" });
    });

    it("still uses the desktop's data after a backend failure when there is a desktop", async () => {
      const recent = makeDesktopRecent({ kind: "ready", index: { formatVersion: 1, generatedAt: "t", entries: [] } });
      const source = await mount(
        makeWorkspace({ kind: "error", message: "boom" }),
        recent,
        desktopScriptsReady(4),
      );
      expect(source().recent).toBe(recent);
    });
  });
});
