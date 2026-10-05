import { afterEach, describe, expect, it, vi } from "vitest";

import {
  scriptOpenRecent,
  scriptPick,
  scriptPreflight,
  scriptRun,
  scriptRunStatus,
  scriptRunStop,
  scriptTrustForget,
  subscribeScriptRun,
} from "./scriptRunHost";
import { DEFAULT_RUN_OPTIONS } from "./scriptRun";
import { WorkspaceHostError } from "./workspaceItems";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function withHost<F extends Invoke>(invoke: F, listen?: unknown): F {
  vi.stubGlobal("window", { __TAURI__: { core: { invoke }, ...(listen ? { event: { listen } } : {}) } });
  return invoke;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const RAW_HANDLE = {
  ticket: "t0",
  item_id: 3,
  name: "a.py",
  display_path: "/w/a.py",
  bytes: 1,
  lines: 1,
  sha256: "ab".repeat(32),
  modified_at: "",
  encoding: "utf-8",
};

describe("script run host adapter", () => {
  it("is unavailable without a desktop host, with a typed error", async () => {
    vi.stubGlobal("window", {});
    await expect(scriptPick()).rejects.toMatchObject({ name: "WorkspaceHostError", code: "unavailable" });
    await expect(scriptRun("t", DEFAULT_RUN_OPTIONS)).rejects.toBeInstanceOf(WorkspaceHostError);
  });

  it("maps a host that predates the commands to command_missing", async () => {
    withHost(vi.fn(async () => Promise.reject(new Error("Command script_pick not found"))));
    await expect(scriptPick()).rejects.toMatchObject({ code: "command_missing" });
  });

  it("keeps a real host failure as host_error", async () => {
    withHost(vi.fn(async () => Promise.reject(new Error("script file not found: /w/a.py"))));
    await expect(scriptOpenRecent(3)).rejects.toMatchObject({ code: "host_error" });
  });

  it("sends an item id and a ticket, never a path, in the commands' argument names", async () => {
    const invoke = withHost(
      vi.fn(async (command: string) => {
        if (command === "script_open_recent") return RAW_HANDLE;
        if (command === "script_preflight") return { ticket: "t0", inspect: { syntax: { ok: true } } };
        if (command === "script_run") return { status: "declined" };
        if (command === "script_run_status") return { run_handle: "r1", state: "running" };
        return null;
      }),
    );
    expect((await scriptOpenRecent(3)).ticket).toBe("t0");
    expect(invoke).toHaveBeenCalledWith("script_open_recent", { itemId: 3 });
    expect((await scriptPreflight("t0")).facts?.syntax).toEqual({ state: "ok" });
    expect(invoke).toHaveBeenCalledWith("script_preflight", { ticket: "t0" });
    expect(await scriptRun("t0", { ...DEFAULT_RUN_OPTIONS, device: "cpu" })).toEqual({ status: "declined" });
    expect(invoke).toHaveBeenCalledWith("script_run", {
      request: { ticket: "t0", requested: { device: "cpu" }, wait_for_solve: true, results: "managed" },
    });
    expect((await scriptRunStatus("r1")).state).toBe("running");
    expect(invoke).toHaveBeenCalledWith("script_run_status", { runHandle: "r1" });
    await scriptRunStop("r1");
    expect(invoke).toHaveBeenCalledWith("script_run_stop", { runHandle: "r1" });
    await scriptTrustForget(3);
    expect(invoke).toHaveBeenCalledWith("script_trust_forget", { itemId: 3 });
    for (const call of invoke.mock.calls) expect(JSON.stringify(call)).not.toContain("/w/a.py");
  });

  it("rejects an invalid answer instead of passing it on", async () => {
    withHost(vi.fn(async () => ({ status: "maybe" })));
    await expect(scriptRun("t", DEFAULT_RUN_OPTIONS)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("returns null when the picker is cancelled", async () => {
    withHost(vi.fn(async () => null));
    expect(await scriptPick()).toBeNull();
  });
});

describe("status events", () => {
  it("does nothing without an event bridge", () => {
    withHost(vi.fn(async () => null));
    const stop = subscribeScriptRun("r1", vi.fn(), vi.fn());
    expect(typeof stop).toBe("function");
    stop();
  });

  it("delivers validated statuses, reports invalid ones, and stops listening", async () => {
    let deliver: ((message: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    const listen = vi.fn(async (_event: string, handler: (message: { payload: unknown }) => void) => {
      deliver = handler;
      return unlisten;
    });
    withHost(vi.fn(async () => null), listen);
    const onStatus = vi.fn();
    const onInvalid = vi.fn();
    const stop = subscribeScriptRun("r1", onStatus, onInvalid);
    await Promise.resolve();
    expect(listen).toHaveBeenCalledWith("script-run:r1", expect.any(Function));
    deliver!({ payload: { run_handle: "r1", state: "materializing" } });
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ runHandle: "r1", state: "materializing" }));
    deliver!({ payload: { state: "unknown" } });
    expect(onInvalid).toHaveBeenCalledTimes(1);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases a listener that was registered after the caller already stopped", async () => {
    const unlisten = vi.fn();
    let resolve!: (stop: () => void) => void;
    const listen = vi.fn(() => new Promise<() => void>((r) => (resolve = r)));
    withHost(vi.fn(async () => null), listen);
    const stop = subscribeScriptRun("r1", vi.fn(), vi.fn());
    stop();
    resolve(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
