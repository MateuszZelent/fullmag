import { describe, expect, it, vi } from "vitest";

import { apiItem } from "./__fixtures__/workspaceApi";
import { script } from "./__fixtures__/workspaceScripts";
import type { ContinueSession } from "./types";
import {
  ADD_PATH_NOT_ABSOLUTE,
  NEEDS_DESKTOP,
  SCRIPT_NOT_IN_DESKTOP,
  addPathOutcome,
  comparablePath,
  desktopActionRefusal,
  desktopIdForPath,
  isAbsolutePath,
  itemsOfKind,
  originOf,
  recentStateFromApi,
  scriptsStateFromApi,
} from "./workspaceSource";

const thumbnailUrl = (id: string) => `/t/${id}`;

describe("originOf", () => {
  it("prefers the API once it answered, waits while it loads, and falls back otherwise", () => {
    expect(originOf({ kind: "ready", list: { items: [], outcome: { state: "ready" }, skipped: 0 } })).toBe("api");
    expect(originOf({ kind: "loading" })).toBe("pending");
    expect(originOf({ kind: "unavailable", reason: "no route" })).toBe("desktop");
    expect(originOf({ kind: "error", message: "boom" })).toBe("desktop");
  });
});

describe("splitting the API list by kind", () => {
  const items = [
    apiItem({ id: "p", kind: "project", projectId: "proj" }),
    apiItem({ id: "s", kind: "script" }),
    apiItem({ id: "r", kind: "result" }),
  ];

  it("filters by kind", () => {
    expect(itemsOfKind(items, "result").map((i) => i.id)).toEqual(["r"]);
  });

  it("makes projects an index, empty when there are none", () => {
    const session: ContinueSession = {
      projectId: "proj",
      runId: "run",
      checkpointAt: "2026-10-03T10:00:00Z",
      progress: { fraction: 0.5 },
      resumable: true,
    };
    const state = recentStateFromApi(items, thumbnailUrl, session, "t");
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.index.entries.map((e) => [e.projectId, e.workspaceId, e.status])).toEqual([
      ["proj", "p", "running"],
    ]);
    expect(state.index.continue).toBe(session);

    expect(recentStateFromApi(itemsOfKind(items, "script"), thumbnailUrl, undefined, "t")).toEqual({
      kind: "empty",
    });
  });

  it("makes scripts rows with the API's own ids and passes the outcome on", () => {
    const state = scriptsStateFromApi(items, { state: "read_only_newer_schema" }, 2);
    expect(state).toMatchObject({
      kind: "ready",
      outcome: { state: "read_only_newer_schema" },
      skipped: 2,
    });
    if (state.kind === "ready") expect(state.items.map((i) => i.id)).toEqual(["s"]);
  });
});

describe("matching an API script to the desktop record", () => {
  it("compares Windows paths case-blind with unified separators and without the verbatim prefix", () => {
    expect(comparablePath("\\\\?\\C:\\Work\\SP4.py")).toBe("c:/work/sp4.py");
    expect(comparablePath("C:/work/sp4.py")).toBe("c:/work/sp4.py");
    expect(comparablePath("\\\\?\\UNC\\srv\\share\\a.py")).toBe("//srv/share/a.py");
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(comparablePath("/home/Me/a.py")).toBe("/home/Me/a.py");
    expect(comparablePath("/home/me/a.py")).not.toBe(comparablePath("/home/Me/a.py"));
  });

  it("finds the desktop id of the same file and none for another", () => {
    const desktop = [script({ id: 4, path: "C:\\Work\\sp4.py" }), script({ id: "7", path: "/x.py" })];
    expect(desktopIdForPath("c:/work/SP4.py", desktop)).toBe(4);
    expect(desktopIdForPath("C:\\work\\other.py", desktop)).toBeNull();
    // A string id is an API id, not a desktop one.
    expect(desktopIdForPath("/x.py", desktop)).toBeNull();
  });
});

describe("desktop-only actions", () => {
  it("say the app is needed in a browser, and that the script is unknown on a desktop", () => {
    expect(desktopActionRefusal(false)).toBe(NEEDS_DESKTOP);
    expect(desktopActionRefusal(true)).toBe(SCRIPT_NOT_IN_DESKTOP);
  });
});

describe("isAbsolutePath", () => {
  it.each(["C:\\data\\run.zarr", "c:/data", "\\\\server\\share\\x", "/home/me/model.fms", " /padded "])(
    "accepts %s",
    (path) => expect(isAbsolutePath(path)).toBe(true),
  );
  it.each(["", "relative/run.zarr", "run.zarr", "C:data", "\\\\", "~/x", "./x"])(
    "rejects %s",
    (path) => expect(isAbsolutePath(path)).toBe(false),
  );
});

describe("addPathOutcome", () => {
  it("refuses a relative path without asking the backend, and says what is wanted", async () => {
    const add = vi.fn(async () => null);
    expect(await addPathOutcome("data/run.zarr", add)).toBe(ADD_PATH_NOT_ABSOLUTE);
    expect(await addPathOutcome("   ", add)).toBe(ADD_PATH_NOT_ABSOLUTE);
    expect(add).not.toHaveBeenCalled();
    expect(ADD_PATH_NOT_ABSOLUTE).toContain("C:\\data\\run.zarr");
  });

  it("sends an absolute path trimmed, and resolves to null when it was added", async () => {
    const add = vi.fn(async () => null);
    expect(await addPathOutcome("  C:\\data\\run.zarr ", add)).toBeNull();
    expect(add).toHaveBeenCalledWith("C:\\data\\run.zarr");
  });

  it("passes the backend's reason through when it refused the path", async () => {
    const add = vi.fn(async () => "Could not add /nope: path does not exist");
    expect(await addPathOutcome("/nope", add)).toBe("Could not add /nope: path does not exist");
  });
});
