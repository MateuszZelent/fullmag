import { describe, expect, it } from "vitest";

import { ControlRoomApi, ControlRoomApiError } from "./ControlRoomApi";
import {
  WORKSPACE_ITEMS_PATH,
  WORKSPACE_ITEM_FORGET_PATH,
  WORKSPACE_ITEM_HISTORY_PATH,
  WORKSPACE_ITEM_PATH,
  WORKSPACE_ITEM_PIN_PATH,
  WORKSPACE_ITEM_THUMBNAIL_PATH,
  WORKSPACE_ROOTS_PATH,
  WORKSPACE_SCAN_PATH,
  workspaceItemThumbnailUrl,
} from "./apiPaths";

const BASE = "http://127.0.0.1:8765";
const contractHeaders = { "x-api-contract-version": "1.0.0", "content-type": "application/json" };

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

function clientWith(respond: (request: Recorded) => Response) {
  const calls: Recorded[] = [];
  const api = new ControlRoomApi({
    baseUrl: BASE,
    maxGetRetries: 0,
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const recorded = {
        method: request.method,
        url: request.url,
        body: request.method === "GET" ? null : await request.text(),
      };
      calls.push(recorded);
      return respond(recorded);
    },
  });
  return { api, calls };
}

const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: contractHeaders });

describe("workspace API paths", () => {
  it("declares the routes of the workspace database", () => {
    expect(WORKSPACE_ITEMS_PATH).toBe("/v2/workspace/items");
    expect(WORKSPACE_ITEM_PATH).toBe("/v2/workspace/items/{id}");
    expect(WORKSPACE_ITEM_THUMBNAIL_PATH).toBe("/v2/workspace/items/{id}/thumbnail");
    expect(WORKSPACE_ITEM_PIN_PATH).toBe("/v2/workspace/items/{id}/pin");
    expect(WORKSPACE_ITEM_FORGET_PATH).toBe("/v2/workspace/items/{id}/forget");
    expect(WORKSPACE_ITEM_HISTORY_PATH).toBe("/v2/workspace/items/{id}/history");
    expect(WORKSPACE_ROOTS_PATH).toBe("/v2/workspace/roots");
    expect(WORKSPACE_SCAN_PATH).toBe("/v2/workspace/scan");
  });

  it("builds an absolute thumbnail URL with the id path-encoded", () => {
    expect(workspaceItemThumbnailUrl(BASE, "a/b c")).toBe(
      `${BASE}/v2/workspace/items/a%2Fb%20c/thumbnail`,
    );
  });
});

describe("ControlRoomApi.workspace", () => {
  it("lists items with the query as wire parameters", async () => {
    const { api, calls } = clientWith(() => ok({ items: [], outcome: { state: "ready" } }));
    await api.workspace.items({
      kind: "result",
      sort: "modified",
      search: "sp4",
      limit: 500,
      includeMissing: true,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v2/workspace/items");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      kind: "result",
      sort: "modified",
      search: "sp4",
      limit: "500",
      include_missing: "true",
    });
  });

  it("omits query parameters that were not asked for", async () => {
    const { api, calls } = clientWith(() => ok({ items: [] }));
    await api.workspace.items();
    expect(new URL(calls[0]?.url ?? "").search).toBe("");
  });

  it("reads one item by its encoded id", async () => {
    const { api, calls } = clientWith(() => ok({ item: {} }));
    await api.workspace.item("wi/1");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v2/workspace/items/wi%2F1");
  });

  it("reads history with a limit", async () => {
    const { api, calls } = clientWith(() => ok({ events: [] }));
    await api.workspace.history("wi-1", 20);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v2/workspace/items/wi-1/history");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("pins, forgets, adds and scans with the documented bodies", async () => {
    const { api, calls } = clientWith(() => ok({}));
    await api.workspace.setPinned("wi-1", true);
    await api.workspace.forget("wi-1");
    await api.workspace.addItem("C:\\work\\a.py", "script");
    await api.workspace.addItem("/data/run.zarr");
    await api.workspace.scan(["D:\\sim"]);
    await api.workspace.scan();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v2/workspace/items/wi-1/pin",
      "POST /v2/workspace/items/wi-1/forget",
      "POST /v2/workspace/items",
      "POST /v2/workspace/items",
      "POST /v2/workspace/scan",
      "POST /v2/workspace/scan",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ pinned: true });
    expect(JSON.parse(calls[2]?.body ?? "")).toEqual({ path: "C:\\work\\a.py", kind: "script" });
    expect(JSON.parse(calls[3]?.body ?? "")).toEqual({ path: "/data/run.zarr" });
    expect(JSON.parse(calls[4]?.body ?? "")).toEqual({ roots: ["D:\\sim"] });
    expect(JSON.parse(calls[5]?.body ?? "")).toEqual({});
  });

  it("reads and replaces the indexed roots", async () => {
    const { api, calls } = clientWith(() => ok({ roots: [] }));
    await api.workspace.roots();
    await api.workspace.saveRoots([
      { path: "D:\\sim", kinds: ["project"], recursive: true, enabled: false },
    ]);
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      roots: [{ path: "D:\\sim", kinds: ["project"], recursive: true, enabled: false }],
    });
  });

  it("gives the thumbnail URL against the client's base", () => {
    const { api } = clientWith(() => ok());
    expect(api.workspace.thumbnailUrl("wi-1")).toBe(`${BASE}/v2/workspace/items/wi-1/thumbnail`);
  });

  it("surfaces a missing route as an error carrying the 404 status", async () => {
    const { api } = clientWith(
      () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), {
          status: 404,
          headers: contractHeaders,
        }),
    );
    const failure = await api.workspace.items().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ControlRoomApiError);
    expect((failure as ControlRoomApiError).status).toBe(404);
  });
});
