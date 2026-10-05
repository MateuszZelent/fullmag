import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSimulationPreparationTestDom } from "../../../kernel/layout/simulationPreparationTestDom.test-support";
import { script } from "./__fixtures__/workspaceScripts";
import {
  useScriptHistory,
  useWorkspaceScripts,
  type ScriptHistoryState,
  type WorkspaceScriptsController,
} from "./useWorkspaceScripts";
import { WorkspaceHostError, type WorkspaceEvent, type WorkspaceList } from "./workspaceItems";

const host = vi.hoisted(() => ({
  forgetWorkspaceItem: vi.fn(),
  listWorkspace: vi.fn(),
  openScript: vi.fn(),
  openScriptDialog: vi.fn(),
  pinWorkspaceItem: vi.fn(),
  readScriptText: vi.fn(),
  revealWorkspaceItem: vi.fn(),
  saveNewScript: vi.fn(),
  workspaceHistory: vi.fn(),
}));

vi.mock("./workspaceHost", () => host);

const list = (...ids: number[]): WorkspaceList => ({
  items: ids.map((id) => script({ id })),
  outcome: { state: "ready" },
  skipped: 0,
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

type Listener = () => void;

describe("workspace hooks", () => {
  let restoreDom: () => void;
  let windowListeners: Map<string, Set<Listener>>;
  let documentListeners: Map<string, Set<Listener>>;
  let now: number;
  let roots: Root[];
  let visibility: string;

  const track = (store: Map<string, Set<Listener>>) => ({
    addEventListener: (type: string, listener: Listener) => {
      store.set(type, (store.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: Listener) => {
      store.get(type)?.delete(listener);
    },
  });
  const fire = (store: Map<string, Set<Listener>>, type: string) =>
    act(async () => {
      for (const listener of [...(store.get(type) ?? [])]) listener();
      await Promise.resolve();
    });

  beforeEach(() => {
    const dom = installSimulationPreparationTestDom();
    restoreDom = dom.restore;
    windowListeners = new Map();
    documentListeners = new Map();
    visibility = "visible";
    Object.assign(globalThis.window as object, track(windowListeners));
    Object.assign(dom.document as object, track(documentListeners));
    Object.defineProperty(dom.document, "visibilityState", { get: () => visibility, configurable: true });
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    roots = [];
    for (const fn of Object.values(host)) fn.mockReset();
  });

  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    vi.restoreAllMocks();
    restoreDom();
  });

  async function mountScripts(): Promise<{ current: () => WorkspaceScriptsController }> {
    let latest: WorkspaceScriptsController | undefined;
    function Probe() {
      latest = useWorkspaceScripts();
      return null;
    }
    const root = createRoot((globalThis.document as unknown as Document).createElement("div"));
    roots.push(root);
    await act(async () => root.render(<Probe />));
    await flush();
    return { current: () => latest! };
  }

  it("reads the list on mount and exposes it as ready", async () => {
    host.listWorkspace.mockResolvedValue(list(1, 2));
    const hook = await mountScripts();

    expect(host.listWorkspace).toHaveBeenCalledTimes(1);
    expect(host.listWorkspace).toHaveBeenCalledWith({
      kind: "script",
      sort: "last_used",
      limit: 500,
      includeMissing: true,
    });
    const state = hook.current().state;
    expect(state.kind === "ready" && state.items.map((item) => item.id)).toEqual([1, 2]);
    expect(hook.current().readOnly).toBe(false);
  });

  it("flags a database from a newer Fullmag as read-only", async () => {
    host.listWorkspace.mockResolvedValue({ ...list(1), outcome: { state: "read_only_newer_schema" } });
    const hook = await mountScripts();
    expect(hook.current().readOnly).toBe(true);
  });

  it("re-reads on focus, merging focus events closer than 750 ms", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    await mountScripts();
    expect(host.listWorkspace).toHaveBeenCalledTimes(1);

    now += 749;
    await fire(windowListeners, "focus");
    expect(host.listWorkspace).toHaveBeenCalledTimes(1);

    now += 1;
    await fire(windowListeners, "focus");
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);

    // The merge window restarts from the latest read.
    now += 100;
    await fire(windowListeners, "focus");
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);
  });

  it("re-reads when the document becomes visible, not when it is hidden", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    await mountScripts();
    now += 5_000;

    visibility = "hidden";
    await fire(documentListeners, "visibilitychange");
    expect(host.listWorkspace).toHaveBeenCalledTimes(1);

    visibility = "visible";
    await fire(documentListeners, "visibilitychange");
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);
  });

  it("removes its listeners on unmount", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    await mountScripts();
    expect(windowListeners.get("focus")?.size).toBe(1);
    expect(documentListeners.get("visibilitychange")?.size).toBe(1);

    await act(async () => roots.forEach((root) => root.unmount()));
    roots = [];
    expect(windowListeners.get("focus")?.size).toBe(0);
    expect(documentListeners.get("visibilitychange")?.size).toBe(0);
  });

  it("re-reads after a successful action and announces it", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    host.pinWorkspaceItem.mockResolvedValue(undefined);
    const hook = await mountScripts();

    let result: string | null = "unset";
    await act(async () => { result = await hook.current().pin(1, true); });

    expect(result).toBeNull();
    expect(host.pinWorkspaceItem).toHaveBeenCalledWith(1, true);
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);
    expect(hook.current().announcement).toBe("Script pinned.");
  });

  it("returns a failure message, keeps the list and does not re-read when an action fails", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    host.forgetWorkspaceItem.mockRejectedValue(new WorkspaceHostError("host_error", "database is locked"));
    const hook = await mountScripts();

    let result: string | null = null;
    await act(async () => { result = await hook.current().forget(1); });

    expect(result).toBe("Could not remove the script from recent: database is locked");
    expect(host.listWorkspace).toHaveBeenCalledTimes(1);
    expect(hook.current().state.kind).toBe("ready");
    expect(hook.current().announcement).toBe(result);
  });

  it("re-reads after open and after a picked script, but not after a cancelled picker", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    host.openScript.mockResolvedValue(script({ id: 1 }));
    const hook = await mountScripts();

    await act(async () => { await hook.current().open(1); });
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);

    host.openScriptDialog.mockResolvedValueOnce(null);
    let picked: Awaited<ReturnType<WorkspaceScriptsController["pickAndOpen"]>> | undefined;
    await act(async () => { picked = await hook.current().pickAndOpen(); });
    expect(picked).toEqual({ item: null, failure: null });
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);

    host.openScriptDialog.mockResolvedValueOnce(script({ id: 3, name: "new" }));
    await act(async () => { picked = await hook.current().pickAndOpen(); });
    expect(picked?.item?.id).toBe(3);
    expect(host.listWorkspace).toHaveBeenCalledTimes(3);
    expect(hook.current().announcement).toBe("Opened new.");
  });

  it("saveNew re-reads the list once saved, treats a cancelled dialog as nothing, and reports failures", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    const hook = await mountScripts();
    const request = { suggestedName: "sp4.py", text: "x = 1", origin: "template", originId: "umag-sp4" } as const;

    host.saveNewScript.mockResolvedValueOnce(null);
    await act(async () => { expect(await hook.current().saveNew(request)).toEqual({ kind: "cancelled" }); });
    expect(host.listWorkspace).toHaveBeenCalledTimes(1);

    host.saveNewScript.mockResolvedValueOnce(script({ id: 9, name: "umag-sp4" }));
    await act(async () => {
      const outcome = await hook.current().saveNew(request);
      expect(outcome.kind === "saved" && outcome.item.id).toBe(9);
    });
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);
    expect(host.saveNewScript).toHaveBeenLastCalledWith(request);
    expect(hook.current().announcement).toBe("Saved umag-sp4.");

    host.saveNewScript.mockRejectedValueOnce(new Error("already exists"));
    await act(async () => {
      expect(await hook.current().saveNew(request)).toEqual({
        kind: "failed",
        message: "Could not save the script: already exists",
      });
    });
    expect(host.listWorkspace).toHaveBeenCalledTimes(2);
  });

  it("reveal and readText report failures without touching the list", async () => {
    host.listWorkspace.mockResolvedValue(list(1));
    host.revealWorkspaceItem.mockRejectedValue(new Error("no shell"));
    host.readScriptText.mockResolvedValueOnce({ name: "sp4", text: "print(1)" });
    host.readScriptText.mockRejectedValueOnce(new Error("gone"));
    const hook = await mountScripts();

    await expect(hook.current().reveal(1)).resolves.toBe("Could not reveal the script: no shell");
    await expect(hook.current().readText(1)).resolves.toEqual({ text: "print(1)" });
    await expect(hook.current().readText(1)).resolves.toEqual({ failure: "Could not read the script: gone" });
    expect(host.listWorkspace).toHaveBeenCalledTimes(1);
  });

  it("reports the unavailable state when there is no desktop host", async () => {
    host.listWorkspace.mockRejectedValue(
      new WorkspaceHostError("unavailable", "The workspace needs the desktop app."),
    );
    const hook = await mountScripts();
    expect(hook.current().state).toEqual({
      kind: "unavailable",
      reason: "The workspace needs the desktop app.",
    });
  });

  it("treats a host without the workspace commands as unavailable", async () => {
    host.listWorkspace.mockRejectedValue(new WorkspaceHostError("command_missing", "predates workspace"));
    const hook = await mountScripts();
    expect(hook.current().state.kind).toBe("unavailable");
  });

  it("maps other host failures to an error state, and keeps a showing list on a failed re-read", async () => {
    host.listWorkspace.mockRejectedValueOnce(new WorkspaceHostError("host_error", "disk failure"));
    const hook = await mountScripts();
    expect(hook.current().state).toEqual({ kind: "error", message: "disk failure" });

    host.listWorkspace.mockRejectedValueOnce("plain string failure");
    await act(async () => { await hook.current().refresh(); });
    expect(hook.current().state).toEqual({ kind: "error", message: "plain string failure" });

    host.listWorkspace.mockResolvedValueOnce(list(1));
    await act(async () => { await hook.current().refresh(); });
    expect(hook.current().state.kind).toBe("ready");

    host.listWorkspace.mockRejectedValueOnce(new Error("transient"));
    await act(async () => { await hook.current().refresh(); });
    expect(hook.current().state.kind).toBe("ready");
  });

  it("drops a slow older read when a newer one has been issued", async () => {
    let resolveOld!: (value: WorkspaceList) => void;
    host.listWorkspace.mockImplementationOnce(() => new Promise<WorkspaceList>((resolve) => { resolveOld = resolve; }));
    host.listWorkspace.mockResolvedValueOnce(list(2));
    const hook = await mountScripts();
    expect(hook.current().state.kind).toBe("loading");

    await act(async () => { await hook.current().refresh(); });
    await act(async () => { resolveOld(list(1)); await Promise.resolve(); });

    const state = hook.current().state;
    expect(state.kind === "ready" && state.items.map((item) => item.id)).toEqual([2]);
  });

  describe("useScriptHistory", () => {
    const event = (key: string): WorkspaceEvent => ({
      key,
      at: "2026-10-03T12:00:00.000Z",
      kind: "open",
      actor: "user",
      detail: "",
    });

    async function mountHistory(id: number, refreshKey: string) {
      let latest: ScriptHistoryState | undefined;
      function Probe({ itemId, keyed }: { itemId: number; keyed: string }) {
        latest = useScriptHistory(itemId, keyed);
        return null;
      }
      const root = createRoot((globalThis.document as unknown as Document).createElement("div"));
      roots.push(root);
      await act(async () => root.render(<Probe itemId={id} keyed={refreshKey} />));
      await flush();
      return {
        current: () => latest!,
        rerender: async (itemId: number, keyed: string) => {
          await act(async () => root.render(<Probe itemId={itemId} keyed={keyed} />));
          await flush();
        },
      };
    }

    it("loads a compact tail of events and refetches when the refresh key changes", async () => {
      host.workspaceHistory.mockResolvedValue([event("a")]);
      const hook = await mountHistory(7, "t1");
      expect(host.workspaceHistory).toHaveBeenCalledWith(7, 8);
      expect(hook.current()).toEqual({ kind: "ready", events: [event("a")] });

      await hook.rerender(7, "t1");
      expect(host.workspaceHistory).toHaveBeenCalledTimes(1);

      host.workspaceHistory.mockResolvedValue([event("b"), event("a")]);
      await hook.rerender(7, "t2");
      expect(host.workspaceHistory).toHaveBeenCalledTimes(2);
      expect(hook.current()).toEqual({ kind: "ready", events: [event("b"), event("a")] });

      await hook.rerender(8, "t2");
      expect(host.workspaceHistory).toHaveBeenLastCalledWith(8, 8);
    });

    it("maps unavailable and other failures", async () => {
      host.workspaceHistory.mockRejectedValueOnce(new WorkspaceHostError("unavailable", "no host"));
      const hook = await mountHistory(7, "t1");
      expect(hook.current()).toEqual({ kind: "unavailable" });

      host.workspaceHistory.mockRejectedValueOnce(new WorkspaceHostError("command_missing", "old host"));
      await hook.rerender(7, "t2");
      expect(hook.current()).toEqual({ kind: "unavailable" });

      host.workspaceHistory.mockRejectedValueOnce(new WorkspaceHostError("host_error", "broken"));
      await hook.rerender(7, "t3");
      expect(hook.current()).toEqual({ kind: "error", message: "broken" });
    });

    it("ignores an answer that arrives after the id changed", async () => {
      let resolveOld!: (events: WorkspaceEvent[]) => void;
      host.workspaceHistory.mockImplementationOnce(
        () => new Promise<WorkspaceEvent[]>((resolve) => { resolveOld = resolve; }),
      );
      host.workspaceHistory.mockResolvedValueOnce([event("new")]);
      const hook = await mountHistory(1, "t");
      await hook.rerender(2, "t");
      await act(async () => { resolveOld([event("old")]); await Promise.resolve(); });
      expect(hook.current()).toEqual({ kind: "ready", events: [event("new")] });
    });
  });
});
