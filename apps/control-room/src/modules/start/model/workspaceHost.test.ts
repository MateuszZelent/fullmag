import { afterEach, describe, expect, it, vi } from "vitest";

import { RAW_SCRIPT } from "./__fixtures__/workspaceScripts";
import {
  forgetWorkspaceItem,
  isMissingCommand,
  listWorkspace,
  openScript,
  openScriptDialog,
  pinWorkspaceItem,
  readScriptText,
  revealWorkspaceItem,
  workspaceHistory,
  workspaceHostAvailable,
} from "./workspaceHost";
import { WorkspaceHostError } from "./workspaceItems";

function withHost<F extends (command: string, args?: Record<string, unknown>) => Promise<unknown>>(
  invoke: F,
): F {
  vi.stubGlobal("window", { __TAURI__: { core: { invoke } } });
  return invoke;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace host adapter", () => {
  it("is unavailable without a desktop host, with a typed error", async () => {
    vi.stubGlobal("window", {});
    expect(workspaceHostAvailable()).toBe(false);
    await expect(listWorkspace({ kind: "script", sort: "last_used" })).rejects.toMatchObject({
      name: "WorkspaceHostError",
      code: "unavailable",
    });
    await expect(openScriptDialog()).rejects.toBeInstanceOf(WorkspaceHostError);
  });

  it("sends the list query in the documented wire shape", async () => {
    const invoke = withHost(
      vi.fn(async () => ({ items: [RAW_SCRIPT], outcome: { state: "ready" } })),
    );
    const list = await listWorkspace({
      kind: "script",
      sort: "use_count",
      search: "sp4",
      limit: 50,
      includeMissing: true,
    });
    expect(invoke).toHaveBeenCalledWith("workspace_list", {
      query: { kind: "script", sort: "use_count", search: "sp4", limit: 50, include_missing: true },
    });
    expect(list.items[0]?.name).toBe("sp4");
  });

  it("omits optional query fields that were not given", async () => {
    const invoke = withHost(vi.fn(async () => ({ items: [], outcome: { state: "ready" } })));
    await listWorkspace({ kind: "all", sort: "name" });
    expect(invoke).toHaveBeenCalledWith("workspace_list", { query: { kind: "all", sort: "name" } });
  });

  it("calls the action commands with exactly the documented arguments", async () => {
    const invoke = withHost(
      vi.fn(async (command: string) => {
        if (command === "workspace_open_script") return RAW_SCRIPT;
        if (command === "workspace_open_script_dialog") return null;
        if (command === "workspace_history") return { events: [] };
        if (command === "workspace_read_script_text") {
          return { name: "sp4", path: "p", sha256: "h", text: "x" };
        }
        return null;
      }),
    );
    await pinWorkspaceItem(7, true);
    await forgetWorkspaceItem(7);
    await revealWorkspaceItem(7);
    expect((await openScript(7)).id).toBe(7);
    expect(await openScriptDialog()).toBeNull();
    expect(await workspaceHistory(7, 8)).toEqual([]);
    expect((await readScriptText(7)).text).toBe("x");
    expect(invoke.mock.calls).toEqual([
      ["workspace_pin", { id: 7, pinned: true }],
      ["workspace_forget", { id: 7 }],
      ["workspace_reveal", { id: 7 }],
      ["workspace_open_script", { id: 7 }],
      ["workspace_open_script_dialog", undefined],
      ["workspace_history", { id: 7, limit: 8 }],
      ["workspace_read_script_text", { id: 7 }],
    ]);
  });

  it("rejects a malformed answer with invalid_response", async () => {
    withHost(vi.fn(async () => ({ items: "nope" })));
    await expect(listWorkspace({ kind: "script", sort: "last_used" })).rejects.toMatchObject({
      code: "invalid_response",
    });
    withHost(vi.fn(async () => ({ id: "x" })));
    await expect(openScript(1)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("tells a missing command from a failure of an existing one", async () => {
    withHost(vi.fn(() => Promise.reject("Command workspace_list not found")));
    await expect(listWorkspace({ kind: "script", sort: "last_used" })).rejects.toMatchObject({
      code: "command_missing",
    });
    withHost(vi.fn(() => Promise.reject(new Error("script file not found: C:\\x.py"))));
    await expect(openScript(1)).rejects.toMatchObject({
      code: "host_error",
      message: "script file not found: C:\\x.py",
    });
  });

  it("classifies host rejections", () => {
    expect(isMissingCommand("Command foo not found")).toBe(true);
    expect(isMissingCommand(new Error("unknown command foo"))).toBe(true);
    expect(isMissingCommand("script file not found")).toBe(false);
  });
});
