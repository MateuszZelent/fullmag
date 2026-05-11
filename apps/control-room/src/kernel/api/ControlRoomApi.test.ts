import { describe, expect, it, vi } from "vitest";

import { ControlRoomApi } from "./ControlRoomApi";
import type { LiveStatusResource } from "./apiTypes";
import { RequestDiagnosticsController } from "./RequestDiagnosticsController";

const contractHeaders = { "x-api-contract-version": "1.0.0" };

const resourceRevisions: LiveStatusResource["resources"] = {
  artifact_revision: 0,
  artifacts_revision: 0,
  command_completion_revision: 0,
  commands_revision: 0,
  display_revision: 0,
  domain_generation_id: 0,
  engine_log_revision: 0,
  field_catalog_revision: 0,
  field_revision: 0,
  fields_revision: 0,
  mesh_build_revision: 0,
  mesh_revision: 0,
  scalars_revision: 0,
  scene_revision: null,
  slice_revision: 0,
  stages_revision: 0,
  topology_revision: 0,
  visualization_state_revision: 0,
  workspace_revision: 0,
};

function liveStatusFixture(
  resources: Partial<LiveStatusResource["resources"]> = {},
): LiveStatusResource {
  return {
    api_contract_version: "1.0.0",
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: true,
      node_fields: false,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: true,
    },
    display: {
      active_quantity_id: "m",
      auto_contrast: true,
      colormap: "viridis",
      contrast_max: null,
      contrast_min: null,
      field_component: "magnitude",
      max_points: 1000,
      slice_layer: 0,
      slice_mode: "xy",
      vector_density: 1,
      vector_glyphs: true,
      view_mode: "3d",
      x_chosen_size: 1,
      y_chosen_size: 1,
    },
    domain: {
      cell_count: 1,
      discretization: "fdm",
      generation_id: 0,
    },
    energies: {},
    metrics: {
      steps_per_second: null,
      total_steps: 0,
      uptime_seconds: 0,
    },
    resources: {
      ...resourceRevisions,
      ...resources,
    },
    run: null,
    runtime_bundle_version: "dev",
    session: {
      created_at: "0",
      name: "test",
      session_id: "session-1",
      workspace_root: "/tmp/fullmag",
    },
    solver: {
      state: "idle",
    },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("x-api-contract-version")) {
    headers.set("x-api-contract-version", "1.0.0");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function binaryResponse(body: ArrayBuffer, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("x-api-contract-version")) {
    headers.set("x-api-contract-version", "1.0.0");
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

function makeTopologyBuffer(): ArrayBuffer {
  const nodeCount = 4;
  const elementCount = 1;
  const boundaryFaceCount = 1;
  const markerCount = 1;
  const byteLength =
    32 +
    nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT +
    elementCount * 4 * Uint32Array.BYTES_PER_ELEMENT +
    boundaryFaceCount * 3 * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT +
    markerCount * Uint32Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMMT"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 1);
  view.setUint32(8, nodeCount, true);
  view.setUint32(12, elementCount, true);
  view.setUint32(16, boundaryFaceCount, true);
  view.setUint32(20, markerCount, true);
  view.setUint32(24, markerCount, true);

  let offset = 32;
  new Float64Array(buffer, offset, nodeCount * 3).set([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ]);
  offset += nodeCount * 3 * Float64Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 4).set([0, 1, 2, 3]);
  offset += 4 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 3).set([0, 1, 2]);
  offset += 3 * Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([10]);
  offset += Uint32Array.BYTES_PER_ELEMENT;
  new Uint32Array(buffer, offset, 1).set([20]);
  return buffer;
}

function makeFieldVectorBuffer(): ArrayBuffer {
  const buffer = new ArrayBuffer(48 + 3 * Float64Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (const [index, code] of [..."FMVP"].entries()) {
    view.setUint8(index, code.charCodeAt(0));
  }
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint8(6, 3);
  view.setUint32(12, 3, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  new TextEncoder().encodeInto("m", new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set([1, 0, -1]);
  return buffer;
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  if (body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(body));
  }

  return JSON.parse(String(body));
}

describe("ControlRoomApi", () => {
  it("loads current session status through the v2 resource path", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse(liveStatusFixture({ fields_revision: 7 }));
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-1",
    });

    const status = await api.sessions.current.status();

    expect(status.resources.fields_revision).toBe(7);
    const headers = new Headers(observedInit?.headers);
    expect(observedUrl).toBe("http://127.0.0.1:8765/v2/sessions/current/status");
    expect(observedInit?.method).toBe("GET");
    expect(headers.get("x-request-id")).toBe("req-1");
    expect(headers.get("x-fullmag-contract-version")).toBeNull();
  });

  it("binds the default browser fetch to globalThis", async () => {
    const originalFetch = globalThis.fetch;
    let observedThis: unknown = null;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: function receiverSensitiveFetch(
        this: typeof globalThis,
        url: RequestInfo | URL,
        init?: RequestInit,
      ) {
        void url;
        void init;
        if (this !== globalThis) {
          observedThis = null;
          throw new TypeError("Illegal invocation");
        }
        observedThis = globalThis;
        return Promise.resolve(jsonResponse(liveStatusFixture()));
      } satisfies typeof fetch,
      writable: true,
    });

    try {
      const api = new ControlRoomApi({
        baseUrl: "http://127.0.0.1:8765",
        requestIdFactory: () => "req-browser-fetch",
      });

      await expect(api.sessions.current.status()).resolves.toMatchObject({
        api_contract_version: "1.0.0",
      });
      expect(observedThis).toBe(globalThis);
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    }
  });

  it("rejects mismatched API contract response versions", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        jsonResponse(liveStatusFixture(), {
          headers: { "x-api-contract-version": "0.9.0" },
        }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 0,
      message: "API contract version mismatch: expected 1.0.0, got 0.9.0",
    });
  });

  it("rejects missing API contract response versions", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(JSON.stringify(liveStatusFixture()), { status: 200 }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 0,
      message: "API contract version mismatch: expected 1.0.0, got missing",
    });
  });

  it("reports non-ok status responses as API errors", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response("No active workspace", {
          headers: contractHeaders,
          status: 404,
        }),
    });

    await expect(api.sessions.current.status()).rejects.toMatchObject({
      status: 404,
      message: "No active workspace",
    });
  });

  it("submits structured commands through the v2 simulation command resource", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      observedUrl = String(url);
      observedInit = init;
      return jsonResponse({
        accepted: true,
        command_id: "cmd-1",
        error: null,
      });
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl,
      requestIdFactory: () => "req-command",
    });

    const response = await api.commands.submit({ kind: "pause" });

    expect(response).toEqual({
      accepted: true,
      command_id: "cmd-1",
      error: null,
    });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/simulation/commands",
    );
    expect(observedInit?.method).toBe("POST");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body =
      observedInit?.body instanceof ArrayBuffer
        ? new TextDecoder().decode(observedInit.body)
        : String(observedInit?.body);
    expect(JSON.parse(body)).toEqual({ kind: "pause" });
  });

  it("loads command queue and command detail through v2 command resources", async () => {
    const seenUrls: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        if (String(url).endsWith("/commands/cmd-2")) {
          return jsonResponse({
            command_id: "cmd-2",
            created_at_unix_ms: 1,
            kind: "pause",
            seq: 2,
            status: "completed",
          });
        }
        return jsonResponse({
          accepted_count: 1,
          can_accept_commands: true,
          commands: [],
          completed_count: 0,
          dispatched_count: 0,
          failed_count: 0,
          pending_count: 1,
          rejected_count: 0,
          revision: 3,
          running_count: 0,
        });
      },
    });

    const queue = await api.commands.list();
    const detail = await api.commands.detail("cmd-2");

    expect(queue.revision).toBe(3);
    expect(detail.command_id).toBe("cmd-2");
    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/simulation/commands",
      "http://127.0.0.1:8765/v2/sessions/current/simulation/commands/cmd-2",
    ]);
  });

  it("retries idempotent GET failures and records the final request diagnostic", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const seenRequestIds: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seenRequestIds.push(new Headers(init?.headers).get("x-request-id"));
      if (seenRequestIds.length === 1) {
        return new Response("temporary", {
          headers: contractHeaders,
          status: 503,
        });
      }
      return jsonResponse(liveStatusFixture({ fields_revision: 9 }));
    });

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl,
      requestIdFactory: () => "req-retry",
    });

    const status = await api.sessions.current.status();

    expect(status.resources.fields_revision).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(seenRequestIds).toEqual(["req-retry", "req-retry"]);
    expect(diagnostics.list()).toMatchObject([
      {
        method: "GET",
        outcome: "ok",
        path: "/v2/sessions/current/status",
        requestId: "req-retry",
        status: 200,
      },
    ]);
  });

  it("does not retry mutating commands and records rejected command diagnostics", async () => {
    const diagnostics = new RequestDiagnosticsController();
    const fetchImpl = vi.fn(
      async () =>
        jsonResponse({ error: "No active workspace" }, {
          status: 404,
        }),
    );

    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      diagnostics,
      fetchImpl,
      requestIdFactory: () => "req-post",
    });

    await expect(api.commands.submit({ kind: "pause" })).rejects.toMatchObject({
      status: 404,
      message: "No active workspace",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(diagnostics.list()).toMatchObject([
      {
        method: "POST",
        outcome: "error",
        path: "/v2/sessions/current/simulation/commands",
        requestId: "req-post",
        status: 404,
      },
    ]);
  });

  it("loads and decodes domain topology through the v2 binary facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return binaryResponse(makeTopologyBuffer(), {
          headers: { etag: '"topology-2"', ...contractHeaders },
        });
      },
      requestIdFactory: () => "req-topology",
    });

    const result = await api.data.domain.topology({ etag: '"topology-1"' });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready topology, received ${result.status}`);
    }
    expect(result.etag).toBe('"topology-2"');
    expect(result.byteLength).toBe(makeTopologyBuffer().byteLength);
    expect(result.data.nodeCount).toBe(4);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/domain/topology",
    );
    expect(observedInit?.method).toBe("GET");
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("if-none-match")).toBe('"topology-1"');
    expect(headers.get("x-request-id")).toBe("req-topology");
  });

  it("returns not-modified for fresh binary topology resources", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: { etag: '"topology-2"', ...contractHeaders },
          status: 304,
        }),
    });

    await expect(
      api.data.domain.topology({ etag: '"topology-2"' }),
    ).resolves.toEqual({
      etag: '"topology-2"',
      status: "not-modified",
    });
  });

  it("returns not-applicable for absent binary topology resources", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: contractHeaders,
          status: 204,
        }),
    });

    await expect(api.data.domain.topology()).resolves.toEqual({
      etag: null,
      status: "not-applicable",
    });
  });

  it("propagates aborted binary resource requests", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("aborted", "AbortError");
    const api = new ControlRoomApi({
      fetchImpl: async () => {
        controller.abort();
        throw abortError;
      },
    });

    await expect(
      api.data.domain.topology({ signal: controller.signal }),
    ).rejects.toBe(abortError);
  });

  it("queries scoped field vectors without exposing endpoint strings to modules", async () => {
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        observedUrl = String(url);
        return binaryResponse(makeFieldVectorBuffer(), {
          headers: { etag: '"field-1"', ...contractHeaders },
        });
      },
    });

    const result = await api.data.fields.vector("m", {
      component: "full",
      scope_id: "part-1",
      scope_kind: "part",
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error(`Expected ready field vector, received ${result.status}`);
    }
    expect(result.data.quantityId).toBe("m");
    expect(Array.from(result.data.values)).toEqual([1, 0, -1]);
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/data/fields/m/samples/vector?component=full&scope_id=part-1&scope_kind=part",
    );
  });

  it("patches visualization state through the typed v2 facade", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        observedUrl = String(url);
        observedInit = init;
        return jsonResponse({ active_quantity_id: "m" });
      },
    });

    const result = await api.visualization.patch({
      active_quantity_id: "m",
      vector_glyphs: true,
    });

    expect(result).toEqual({ active_quantity_id: "m" });
    expect(observedUrl).toBe(
      "http://127.0.0.1:8765/v2/sessions/current/visualization/state",
    );
    expect(observedInit?.method).toBe("PATCH");
    expect(parseRequestBody(observedInit?.body)).toEqual({
      active_quantity_id: "m",
      vector_glyphs: true,
    });
  });

  it("exposes scene, universe, and shared-domain manifest through facade methods", async () => {
    const seenUrls: string[] = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        seenUrls.push(String(url));
        return jsonResponse({ revision: seenUrls.length });
      },
    });

    await api.model.scene();
    await api.model.universe();
    await api.meshing.sharedDomainManifest();

    expect(seenUrls).toEqual([
      "http://127.0.0.1:8765/v2/sessions/current/model/scene",
      "http://127.0.0.1:8765/v2/sessions/current/model/universe",
      "http://127.0.0.1:8765/v2/sessions/current/meshing/meshes/shared-domain/manifest",
    ]);
  });

  it("treats an absent shared-domain manifest as not applicable", async () => {
    const api = new ControlRoomApi({
      fetchImpl: async () =>
        new Response(null, {
          headers: contractHeaders,
          status: 204,
        }),
    });

    await expect(api.meshing.sharedDomainManifest()).resolves.toBeNull();
  });
});
