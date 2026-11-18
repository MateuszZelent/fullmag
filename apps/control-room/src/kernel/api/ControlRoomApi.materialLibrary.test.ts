import { describe, expect, it, vi } from "vitest";
import { ControlRoomApi } from "./ControlRoomApi";

const properties = { Ms: 800000, Aex: 1.3e-11, alpha: 0.01, Dind: null, Dbulk: null };
const source = { catalog_id: "builtin:permalloy", catalog_revision: 1, name: "Permalloy", kind: "builtin" as const, properties, references: [{ citation: "Baseline" }] };
const write = { name: "Measured", properties: { ...properties, Ms: 900000 }, references: [{ citation: "Sample A" }, { url: "https://example.org/method" }], source };
const headers = { "x-api-contract-version": "1.0.0" };

function harness(status = 200) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    return new Response(JSON.stringify(status === 409 ? { error: "material revision conflict" } : { revision: 8, catalog_revision: 23, entries: [], id: "custom:sample", ...write }), { status, headers });
  });
  return { calls, api: new ControlRoomApi({ baseUrl: "http://localhost:3217", fetchImpl }), fetchImpl };
}
const body = (value?: RequestInit) => new Response(value?.body).json();

describe("shared material library facade", () => {
  it("reads the catalog independently of scene and forwards cancellation", async () => {
    const { api, calls } = harness();
    const controller = new AbortController();
    await api.workspace.listMaterials({ signal: controller.signal });
    expect(calls[0].url.pathname).toBe("/v2/workspace/material-library");
    expect(calls[0].init?.method).toBe("GET");
    expect(new Headers(calls[0].init?.headers).get("x-fullmag-session-scope")).toBeNull();
    expect(calls[0].init?.signal).toBeTruthy();
    controller.abort();
    expect(calls[0].init?.signal?.aborted).toBe(true);
  });

  it("creates an independent variant with all references and a source snapshot", async () => {
    const { api, calls } = harness(201);
    const saved = await api.workspace.createMaterial(write);
    expect(saved.catalog_revision).toBe(23);
    expect(saved.revision).toBe(8);
    expect(calls[0].init?.method).toBe("POST");
    expect(await body(calls[0].init)).toEqual(write);
  });

  it("does not turn a create conflict into an update", async () => {
    const { api, calls } = harness(409);
    await expect(api.workspace.createMaterial({ id: "custom:sample", ...write })).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("POST");
  });

  it("pins an update to the entry identity and revision", async () => {
    const { api, calls } = harness();
    await api.workspace.updateMaterial("custom:sample", { base_revision: 7, ...write });
    expect(decodeURIComponent(calls[0].url.pathname)).toBe("/v2/workspace/material-library/custom:sample");
    expect(calls[0].init?.method).toBe("PUT");
    expect(await body(calls[0].init)).toEqual({ base_revision: 7, ...write });
  });

  it("sends the required delete revision in a JSON body", async () => {
    const { api, calls } = harness();
    await api.workspace.deleteMaterial("custom:sample", { base_revision: 7 });
    expect(calls[0].init?.method).toBe("DELETE");
    expect(await body(calls[0].init)).toEqual({ base_revision: 7 });
  });

  it("publishes and updates material versions through the workspace catalog", async () => {
    const { api, calls } = harness();
    const input = { material_id: "custom:sample", base_revision: 3, family: "yig", version: "sample_a", display_name: "Sample A" };
    await api.workspace.publishMaterialVersion(input);
    const metadata = { base_revision: 4, display_name: "New name", archived: true };
    await api.workspace.updateMaterialVersion("yig", "sample_a", metadata);
    expect(calls.map(({ url, init }) => [url.pathname, init?.method])).toEqual([
      ["/v2/workspace/material-library/versions", "POST"],
      ["/v2/workspace/material-library/versions/yig/sample_a", "PATCH"],
    ]);
    expect(await body(calls[0].init)).toEqual(input);
    expect(await body(calls[1].init)).toEqual(metadata);
  });

  it("keeps source import and assignment in one scoped authoring transaction", async () => {
    const { api, calls } = harness();
    await api.model.createMaterial("mat:copy", "Measured", write.properties, write.references,
      { baseRevision: 12, sessionScopeKey: "session=one&epoch=one%401" },
      { source, assignToObjectId: "object:first" });
    expect(calls).toHaveLength(1);
    expect(await body(calls[0].init)).toMatchObject({ kind: "create_material", base_revision: 12,
      material_id: "mat:copy", source, assign_to_object_id: "object:first", references: write.references });
    expect(new Headers(calls[0].init?.headers).get("x-fullmag-session-scope")).toBe("session=one&epoch=one%401");
  });
});
