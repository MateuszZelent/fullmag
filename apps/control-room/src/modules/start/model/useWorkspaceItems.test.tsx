import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";

import { installSimulationPreparationTestDom } from "../../../kernel/layout/simulationPreparationTestDom.test-support";
import { RAW_API_ITEM, RAW_API_SCRIPT_DETAIL } from "./__fixtures__/workspaceApi";
import {
  ALL_ITEMS_QUERY,
  FOCUS_REFETCH_MIN_MS,
  WORKSPACE_API_UNAVAILABLE,
  detailStateFromResource,
  focusRefetchDue,
  isRouteMissing,
  listStateFromResource,
  useWorkspaceItemDetail,
  useWorkspaceItems,
  workspaceItemDetailResourceKey,
  workspaceItemsResourceKey,
  type WorkspaceItemDetailState,
  type WorkspaceItemsController,
} from "./useWorkspaceItems";
import { useWorkspaceRoots, type WorkspaceRootsController } from "./useWorkspaceRoots";
import type { ApiWorkspaceList } from "./workspaceApiTypes";

interface FakeResource {
  data: unknown;
  error: Error | null;
  status: "idle" | "loading" | "ready" | "stale" | "error";
  refetch: ReturnType<typeof vi.fn>;
  revision: null;
}

const mocks = vi.hoisted(() => ({
  api: {
    workspace: {
      items: vi.fn(),
      item: vi.fn(),
      roots: vi.fn(),
      saveRoots: vi.fn(),
      scan: vi.fn(),
      addItem: vi.fn(),
      setPinned: vi.fn(),
      forget: vi.fn(),
      history: vi.fn(),
      thumbnailUrl: (id: string) => `http://host/v2/workspace/items/${id}/thumbnail`,
    },
  },
  invalidatePrefix: vi.fn(),
  useResource: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({ api: mocks.api, resources: { invalidatePrefix: mocks.invalidatePrefix } }),
}));
vi.mock("@/kernel/resources/useResource", () => ({ useResource: mocks.useResource }));

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

type Listener = () => void;

const readyList: ApiWorkspaceList = { items: [], outcome: { state: "ready" }, skipped: 0 };

describe("pure state derivation", () => {
  const resource = (over: Partial<Parameters<typeof listStateFromResource>[0]>) => ({
    data: null,
    error: null,
    status: "loading" as const,
    ...over,
  });

  it("is loading until something arrives", () => {
    expect(listStateFromResource(resource({}))).toEqual({ kind: "loading" });
    expect(listStateFromResource(resource({ status: "idle" }))).toEqual({ kind: "loading" });
  });

  it("is ready with the data, and keeps it when a later read failed", () => {
    expect(listStateFromResource(resource({ data: readyList, status: "ready" }))).toEqual({
      kind: "ready",
      list: readyList,
    });
    expect(
      listStateFromResource(resource({ data: readyList, status: "error", error: new Error("boom") })).kind,
    ).toBe("ready");
  });

  it("calls a missing route unavailable and any other failure an error", () => {
    for (const status of [404, 405, 501]) {
      const error = new ControlRoomApiError("no route", status);
      expect(listStateFromResource(resource({ status: "error", error }))).toEqual({
        kind: "unavailable",
        reason: WORKSPACE_API_UNAVAILABLE,
      });
    }
    expect(
      listStateFromResource(resource({ status: "error", error: new ControlRoomApiError("down", 503) })),
    ).toEqual({ kind: "error", message: "down" });
    expect(listStateFromResource(resource({ status: "error", error: new Error("The backend returned an unexpected workspace list.") })).kind).toBe("error");
  });

  it("derives the detail state the same way, idle without a selection", () => {
    const answer = { item: {} } as never;
    expect(detailStateFromResource({ data: null, error: null, status: "idle" }, false)).toEqual({ kind: "idle" });
    expect(detailStateFromResource({ data: null, error: null, status: "loading" }, true)).toEqual({ kind: "loading" });
    expect(detailStateFromResource({ data: answer, error: null, status: "ready" }, true)).toEqual({
      kind: "ready",
      answer,
    });
    expect(
      detailStateFromResource({ data: null, error: new ControlRoomApiError("x", 404), status: "error" }, true).kind,
    ).toBe("unavailable");
    expect(
      detailStateFromResource({ data: null, error: new Error("bad"), status: "error" }, true),
    ).toEqual({ kind: "error", message: "bad" });
  });

  it("recognises route-missing statuses only", () => {
    expect(isRouteMissing(new ControlRoomApiError("x", 404))).toBe(true);
    expect(isRouteMissing(new ControlRoomApiError("x", 500))).toBe(false);
    expect(isRouteMissing(new Error("x"))).toBe(false);
    expect(isRouteMissing(null)).toBe(false);
  });

  it("merges focus events closer than the window", () => {
    expect(focusRefetchDue(1000 + FOCUS_REFETCH_MIN_MS - 1, 1000)).toBe(false);
    expect(focusRefetchDue(1000 + FOCUS_REFETCH_MIN_MS, 1000)).toBe(true);
  });

  it("keys a list by its query and a detail by its id, under one prefix", () => {
    expect(workspaceItemsResourceKey(ALL_ITEMS_QUERY)).toBe(
      "workspace:items?kind=all&sort=last_used&search=&limit=500&missing=true",
    );
    expect(workspaceItemsResourceKey({ kind: "script", search: "a b" })).toContain("search=a%20b");
    expect(workspaceItemDetailResourceKey("a/b")).toBe("workspace:item:a%2Fb");
  });
});

describe("workspace hooks", () => {
  let restoreDom: () => void;
  let windowListeners: Map<string, Set<Listener>>;
  let documentListeners: Map<string, Set<Listener>>;
  let now: number;
  let roots: Root[];
  let visibility: string;
  let fake: FakeResource;
  let lastOptions: { enabled?: boolean; load: (c: { signal: AbortSignal }) => Promise<unknown>; resourceKey: string } | undefined;

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
    fake = { data: null, error: null, status: "loading", refetch: vi.fn(), revision: null };
    lastOptions = undefined;
    mocks.useResource.mockImplementation((options: NonNullable<typeof lastOptions>) => {
      lastOptions = options;
      return fake;
    });
    mocks.invalidatePrefix.mockReset();
    for (const fn of Object.values(mocks.api.workspace)) if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  });

  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    vi.restoreAllMocks();
    restoreDom();
  });

  async function mount<T>(use: () => T): Promise<{ current: () => T; rerender: () => Promise<void> }> {
    let latest: T | undefined;
    function Probe() {
      latest = use();
      return null;
    }
    const root = createRoot((globalThis.document as unknown as Document).createElement("div"));
    roots.push(root);
    await act(async () => root.render(<Probe />));
    await flush();
    return {
      current: () => latest as T,
      rerender: async () => {
        await act(async () => root.render(<Probe />));
        await flush();
      },
    };
  }

  const mountItems = () => mount<WorkspaceItemsController>(() => useWorkspaceItems());

  it("reads one resource for the whole list and loads it through the typed client", async () => {
    mocks.api.workspace.items.mockResolvedValue({ items: [RAW_API_ITEM], outcome: { state: "ready" } });
    const hook = await mountItems();
    expect(hook.current().state).toEqual({ kind: "loading" });
    expect(lastOptions?.resourceKey).toBe(workspaceItemsResourceKey(ALL_ITEMS_QUERY));

    const loaded = (await lastOptions?.load({ signal: new AbortController().signal })) as ApiWorkspaceList;
    expect(mocks.api.workspace.items).toHaveBeenCalledWith(ALL_ITEMS_QUERY, expect.objectContaining({ signal: expect.anything() }));
    expect(loaded.items.map((i) => i.id)).toEqual(["wi-script-1"]);
  });

  it("rejects an answer that is not the documented shape instead of passing it on", async () => {
    mocks.api.workspace.items.mockResolvedValue({ items: "nope" });
    await mountItems();
    await expect(lastOptions?.load({ signal: new AbortController().signal })).rejects.toThrow(
      "unexpected workspace list",
    );
  });

  it("exposes the resource as ready, and a 404 as unavailable so the screen can fall back", async () => {
    const hook = await mountItems();
    fake.data = readyList;
    fake.status = "ready";
    await hook.rerender();
    expect(hook.current().state.kind).toBe("ready");

    fake.data = null;
    fake.status = "error";
    fake.error = new ControlRoomApiError("not found", 404);
    await hook.rerender();
    expect(hook.current().state).toEqual({ kind: "unavailable", reason: WORKSPACE_API_UNAVAILABLE });

    fake.error = new ControlRoomApiError("overloaded", 503);
    await hook.rerender();
    expect(hook.current().state).toEqual({ kind: "error", message: "overloaded" });
  });

  it("refetches on focus, merging focus events closer than 750 ms", async () => {
    await mountItems();
    expect(fake.refetch).not.toHaveBeenCalled();

    now += 749;
    await fire(windowListeners, "focus");
    expect(fake.refetch).not.toHaveBeenCalled();

    now += 1;
    await fire(windowListeners, "focus");
    expect(fake.refetch).toHaveBeenCalledTimes(1);

    now += 100;
    await fire(windowListeners, "focus");
    expect(fake.refetch).toHaveBeenCalledTimes(1);
  });

  it("refetches when the document becomes visible, not when it is hidden", async () => {
    await mountItems();
    now += 5_000;
    visibility = "hidden";
    await fire(documentListeners, "visibilitychange");
    expect(fake.refetch).not.toHaveBeenCalled();
    visibility = "visible";
    await fire(documentListeners, "visibilitychange");
    expect(fake.refetch).toHaveBeenCalledTimes(1);
  });

  it("removes its listeners on unmount", async () => {
    await mountItems();
    expect(windowListeners.get("focus")?.size).toBe(1);
    await act(async () => roots.forEach((root) => root.unmount()));
    roots = [];
    expect(windowListeners.get("focus")?.size).toBe(0);
    expect(documentListeners.get("visibilitychange")?.size).toBe(0);
  });

  it("invalidates the workspace prefix after a pin, so every reader refetches, and announces it", async () => {
    mocks.api.workspace.setPinned.mockResolvedValue({});
    const hook = await mountItems();
    let result: string | null = "unset";
    await act(async () => {
      result = await hook.current().pin("wi-1", true);
    });
    expect(result).toBeNull();
    expect(mocks.api.workspace.setPinned).toHaveBeenCalledWith("wi-1", true);
    expect(mocks.invalidatePrefix).toHaveBeenCalledWith("workspace:", expect.any(Number));
    expect(hook.current().announcement).toBe("Pinned.");
  });

  it("uses a new revision for each invalidation", async () => {
    mocks.api.workspace.forget.mockResolvedValue({});
    const hook = await mountItems();
    await act(async () => {
      await hook.current().forget("a");
      await hook.current().forget("b");
    });
    const [first, second] = mocks.invalidatePrefix.mock.calls.map((call) => call[1] as number);
    expect(second).toBeGreaterThan(first ?? 0);
  });

  it("returns the failure, announces it and does not invalidate when an action fails", async () => {
    mocks.api.workspace.forget.mockRejectedValue(new ControlRoomApiError("database is read-only", 409));
    const hook = await mountItems();
    let result: string | null = null;
    await act(async () => {
      result = await hook.current().forget("wi-1");
    });
    expect(result).toBe("Could not remove the item from recent: database is read-only");
    expect(mocks.invalidatePrefix).not.toHaveBeenCalled();
    expect(hook.current().announcement).toBe(result);
  });

  it("scans, returns the report and invalidates; a failed scan returns its reason", async () => {
    mocks.api.workspace.scan.mockResolvedValueOnce({ scanned: 9, added: 1, updated: 2, missing: 0, skipped: 3, warnings: ["w"] });
    const hook = await mountItems();
    let outcome: Awaited<ReturnType<WorkspaceItemsController["scan"]>> | undefined;
    await act(async () => {
      outcome = await hook.current().scan(["D:\\sim"]);
    });
    expect(mocks.api.workspace.scan).toHaveBeenCalledWith(["D:\\sim"]);
    expect(outcome).toMatchObject({ report: { scanned: 9, added: 1, warnings: ["w"] } });
    expect(mocks.invalidatePrefix).toHaveBeenCalledTimes(1);
    expect(hook.current().scanning).toBe(false);

    mocks.api.workspace.scan.mockRejectedValueOnce(new Error("scanner busy"));
    await act(async () => {
      outcome = await hook.current().scan();
    });
    expect(outcome).toEqual({ failure: "The scan failed: scanner busy" });
    expect(mocks.invalidatePrefix).toHaveBeenCalledTimes(1);
  });

  it("adds a path and returns the item, or says why not", async () => {
    mocks.api.workspace.addItem.mockResolvedValueOnce(RAW_API_ITEM);
    const hook = await mountItems();
    let outcome: Awaited<ReturnType<WorkspaceItemsController["addByPath"]>> | undefined;
    await act(async () => {
      outcome = await hook.current().addByPath("C:\\work\\sp4.py", "script");
    });
    expect(mocks.api.workspace.addItem).toHaveBeenCalledWith("C:\\work\\sp4.py", "script");
    expect(outcome).toMatchObject({ item: { id: "wi-script-1" } });
    expect(mocks.invalidatePrefix).toHaveBeenCalledTimes(1);

    mocks.api.workspace.addItem.mockResolvedValueOnce({ nonsense: true });
    await act(async () => {
      outcome = await hook.current().addByPath("/x.py");
    });
    expect(outcome).toMatchObject({ failure: expect.stringContaining("did not describe") });

    mocks.api.workspace.addItem.mockRejectedValueOnce(new ControlRoomApiError("path does not exist", 400));
    await act(async () => {
      outcome = await hook.current().addByPath("/missing.py");
    });
    expect(outcome).toEqual({ failure: "Could not add /missing.py: path does not exist" });
  });

  it("builds thumbnail URLs through the client", async () => {
    const hook = await mountItems();
    expect(hook.current().thumbnailUrl("a")).toBe("http://host/v2/workspace/items/a/thumbnail");
  });

  it("is idle without a selection and loads the selected item's detail", async () => {
    const hook = await mount<WorkspaceItemDetailState>(() => useWorkspaceItemDetail(null));
    expect(hook.current()).toEqual({ kind: "idle" });
    expect(lastOptions?.enabled).toBe(false);

    mocks.api.workspace.item.mockResolvedValue({ item: RAW_API_ITEM, detail: RAW_API_SCRIPT_DETAIL });
    const selected = await mount<WorkspaceItemDetailState>(() => useWorkspaceItemDetail("wi-script-1"));
    expect(lastOptions?.enabled).toBe(true);
    expect(lastOptions?.resourceKey).toBe("workspace:item:wi-script-1");
    expect(selected.current()).toEqual({ kind: "loading" });

    const answer = (await lastOptions?.load({ signal: new AbortController().signal })) as { detail?: { kind: string } };
    expect(mocks.api.workspace.item).toHaveBeenCalledWith("wi-script-1", expect.anything());
    expect(answer.detail?.kind).toBe("script");
  });

  it("refetches the selected item's detail on focus too, and reports a 404 as unavailable", async () => {
    const hook = await mount<WorkspaceItemDetailState>(() => useWorkspaceItemDetail("wi-1"));
    now += 1_000;
    await fire(windowListeners, "focus");
    expect(fake.refetch).toHaveBeenCalledTimes(1);

    fake.status = "error";
    fake.error = new ControlRoomApiError("no such item", 404);
    await hook.rerender();
    expect(hook.current().kind).toBe("unavailable");
  });

  it("does not listen for focus while nothing is selected", async () => {
    await mount<WorkspaceItemDetailState>(() => useWorkspaceItemDetail(null));
    expect(windowListeners.get("focus")?.size ?? 0).toBe(0);
  });

  it("reads the indexed roots and saves them, invalidating the workspace prefix", async () => {
    mocks.api.workspace.saveRoots.mockResolvedValue({ roots: [] });
    const hook = await mount<WorkspaceRootsController>(() => useWorkspaceRoots());
    expect(hook.current().state).toEqual({ kind: "loading" });

    mocks.api.workspace.roots.mockResolvedValue({ roots: [{ path: "D:\\sim" }] });
    const loaded = (await lastOptions?.load({ signal: new AbortController().signal })) as { path: string }[];
    expect(loaded[0]?.path).toBe("D:\\sim");

    fake.data = loaded;
    fake.status = "ready";
    await hook.rerender();
    expect(hook.current().state).toMatchObject({ kind: "ready" });

    let failure: string | null = "unset";
    await act(async () => {
      failure = await hook.current().save([{ path: "D:\\sim", kinds: ["project"], recursive: true, enabled: true }]);
    });
    expect(failure).toBeNull();
    expect(mocks.api.workspace.saveRoots).toHaveBeenCalledWith([
      { path: "D:\\sim", kinds: ["project"], recursive: true, enabled: true },
    ]);
    expect(mocks.invalidatePrefix).toHaveBeenCalledWith("workspace:", expect.any(Number));

    mocks.api.workspace.saveRoots.mockRejectedValueOnce(new ControlRoomApiError("path is not a directory", 400));
    await act(async () => {
      failure = await hook.current().save([]);
    });
    expect(failure).toBe("Could not save the locations: path is not a directory");
    expect(mocks.invalidatePrefix).toHaveBeenCalledTimes(1);
  });

  it("reports roots as unavailable on a backend without the route", async () => {
    const hook = await mount<WorkspaceRootsController>(() => useWorkspaceRoots());
    fake.status = "error";
    fake.error = new ControlRoomApiError("not found", 404);
    await hook.rerender();
    expect(hook.current().state).toEqual({ kind: "unavailable", reason: WORKSPACE_API_UNAVAILABLE });
  });
});
