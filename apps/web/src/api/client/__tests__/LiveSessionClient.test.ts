import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openApiV2PathLiterals,
  assertOpenApiV2Path,
} from "../../generated/openapi-v2-paths";
import {
  LiveSessionClient,
  initLiveSessionClient,
  resetLiveSessionClientForTests,
} from "../LiveSessionClient";
import { sessionApiPaths } from "../sessionPaths";

describe("LiveSessionClient v2 transport contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetLiveSessionClientForTests();
  });

  it("generates only v2 browser paths", () => {
    expect(openApiV2PathLiterals.length).toBeGreaterThan(0);
    expect(openApiV2PathLiterals.filter((path) => path.startsWith("/v1"))).toEqual([]);
  });

  it("keeps session path helpers backed by generated OpenAPI v2 literals", () => {
    assertOpenApiV2Path(sessionApiPaths.status);
    assertOpenApiV2Path(sessionApiPaths.data.quantities);
    assertOpenApiV2Path(sessionApiPaths.data.fields);
    assertOpenApiV2Path(sessionApiPaths.visualization.display);
    assertOpenApiV2Path(sessionApiPaths.visualization.state);
    assertOpenApiV2Path(sessionApiPaths.simulation.commands);
    assertOpenApiV2Path(sessionApiPaths.simulation.runsCurrent);
    assertOpenApiV2Path(sessionApiPaths.meshing.sharedDomainTopology);
    assertOpenApiV2Path(sessionApiPaths.workspace.selection);
  });

  it("replays OpenAPI request bodies through the transport wrapper", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body;
      const bodyText =
        body instanceof ArrayBuffer
          ? new TextDecoder().decode(body)
          : typeof body === "string"
            ? body
            : "";
      expect(JSON.parse(bodyText)).toEqual({
        kind: "merge_patch",
        merge_patch: { objects: [] },
      });
      return new Response(
        JSON.stringify({
          transaction_id: "tx-test",
          committed_scene: { version: "scene.v1", objects: [] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LiveSessionClient({ baseUrl: "http://api.test" });
    await client.scene.transact({
      kind: "merge_patch",
      merge_patch: { objects: [] },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the global singleton when the resolved config is unchanged", () => {
    const first = initLiveSessionClient({ baseUrl: "http://api.test/" });
    const second = initLiveSessionClient({ baseUrl: "http://api.test" });
    const third = initLiveSessionClient({ baseUrl: "http://other.test" });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });
});
