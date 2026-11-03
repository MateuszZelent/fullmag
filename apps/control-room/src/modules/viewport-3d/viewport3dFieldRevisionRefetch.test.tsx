import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import {
  DATA_FIELDS_PATH,
  SESSIONS_PATH,
  SESSION_STATUS_PATH,
  SIMULATION_COMMANDS_PATH,
} from "@/kernel/api/apiPaths";
import type { FieldVectorQuery } from "@/kernel/api/apiTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import {
  updateRealtimeCommunicationPolicy,
} from "@/kernel/realtime/communicationPolicy";
import { RealtimeInvalidationBridge } from "@/kernel/realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { sessionScopedResourceKey } from "@/kernel/resources/sessionResourceIdentity";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";
import type { KernelApi } from "@/kernel/types";

import {
  resolveViewport3DFieldVectorResourceKey,
  useViewport3DFieldVectorRequest,
} from "./viewport3dResources";

const contractHeaders = { "x-api-contract-version": "1.0.0" };
const query = {
  component: "full" as const,
  scope_id: "revision-refetch-test",
  scope_kind: "part" as const,
};
const resourceKey = resolveViewport3DFieldVectorResourceKey("H_demag", query);

type FieldMetaProbeObservation = {
  edenDemag: ReturnType<typeof useFieldMetaResource>;
  hDemag: ReturnType<typeof useFieldMetaResource>;
};

afterEach(() => updateRealtimeCommunicationPolicy({}));

describe("viewport 3D field revision refetch", () => {
  it("never adopts a delayed field response from the previous session epoch", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    let sessionEpoch = "session-1@1000";
    let vectorRequests = 0;
    let oldRequestSignal: AbortSignal | undefined;
    let resolveOldResponse: ((response: Response) => void) | null = null;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        if (new URL(requestUrl).pathname === SESSIONS_PATH) {
          return sessionListResponse();
        }
        if (new URL(requestUrl).pathname === SESSION_STATUS_PATH) {
          return jsonResponse({
            resources: {},
            session: { session_epoch: sessionEpoch, session_id: "session-1", request_scope_epoch: `test-api:${sessionEpoch}` },
          });
        }
        if (requestUrl.includes("/data/fields/H_demag/samples/vector")) {
          vectorRequests += 1;
          if (vectorRequests === 1) {
            oldRequestSignal = init?.signal ?? undefined;
            return new Promise<Response>((resolve) => {
              resolveOldResponse = resolve;
            });
          }
          return fieldVectorResponse(2);
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api,
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({ config: { enabled: false } }),
      resources,
    } as unknown as KernelApi;
    const observations: Array<ReturnType<typeof useViewport3DFieldVectorRequest>> = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe observations={observations} />
          </KernelContext.Provider>,
        );
      });
      await waitFor(() => vectorRequests === 1, "old epoch field request did not start");

      sessionEpoch = "session-1@2000";
      await act(async () => resources.invalidate(SESSION_STATUS_RESOURCE_KEY, 2));
      await waitFor(
        () => vectorRequests === 2 && observations.at(-1)?.data?.values[0] === 2,
        "new epoch field response was not adopted",
      );
      expect(oldRequestSignal?.aborted).toBe(true);

      await act(async () => resolveOldResponse?.(fieldVectorResponse(1)));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(observations.at(-1)?.data?.values[0]).toBe(2);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a slow vector GET alive and coalesces many revisions to bounded refreshes", async () => {
    updateRealtimeCommunicationPolicy({ field_sample_publish_ms: 20 });
    const requests: Array<{
      resolve: (response: Response) => void;
      signal: AbortSignal | undefined;
    }> = [];
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        if (new URL(requestUrl).pathname === SESSIONS_PATH) {
          return sessionListResponse();
        }
        if (new URL(requestUrl).pathname === SESSION_STATUS_PATH) {
          return jsonResponse({
            resources: {},
            session: {
              session_epoch: "session-1@1700000000000",
              request_scope_epoch: "test-api:1",
              session_id: "session-1",
            },
          });
        }
        if (requestUrl.includes("/data/fields/H_demag/samples/vector")) {
          return new Promise<Response>((resolve, reject) => {
            const signal = init?.signal ?? undefined;
            requests.push({ resolve, signal });
            signal?.addEventListener(
              "abort",
              () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              { once: true },
            );
          });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources, {
      scheduleFlush: (flush) => {
        flush();
        return () => undefined;
      },
    });
    const kernel = {
      api,
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const observations: Array<ReturnType<typeof useViewport3DFieldVectorRequest>> = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);

    const invalidate = async (revision: number) => {
      await act(async () => {
        bridge.handleEvent({
          payload: {
            changes: [
              {
                recommended_fetch: resourceKey,
                resource: "fields",
                resource_id: "samples",
                revision,
              },
            ],
          },
          type: "resource.batch_changed",
        });
      });
    };

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe observations={observations} />
          </KernelContext.Provider>,
        );
      });
      await waitFor(() => requests.length === 1, "initial slow field request did not start");

      for (let revision = 2; revision <= 20; revision += 1) {
        await invalidate(revision);
      }
      expect(requests).toHaveLength(1);
      expect(requests[0]?.signal?.aborted).toBe(false);

      await act(async () => requests[0]?.resolve(fieldVectorResponse(1)));
      await waitFor(
        () => requests.length === 2 && observations.at(-1)?.data?.values[0] === 1,
        "coalesced refresh did not start while retaining the initial field",
      );
      expect(observations.at(-1)?.status).toBe("stale");
      expect(observations.at(-1)?.data?.values[0]).toBe(1);

      for (let revision = 21; revision <= 40; revision += 1) {
        await invalidate(revision);
      }
      expect(requests).toHaveLength(2);
      expect(requests[1]?.signal?.aborted).toBe(false);

      await act(async () => requests[1]?.resolve(fieldVectorResponse(2)));
      await waitFor(
        () => requests.length === 3 && observations.at(-1)?.data?.values[0] === 2,
        "latest coalesced revision did not schedule one eventual refresh",
      );
      expect(observations.at(-1)?.status).toBe("stale");
      expect(observations.at(-1)?.data?.values[0]).toBe(2);
      expect(
        resources.getRevision(
          sessionScopedResourceKey(
            {
              requestScopeEpoch: "test-api:1",
              sessionEpoch: "session-1@1700000000000",
              sessionId: "session-1",
            },
            resourceKey,
          ),
        ),
      ).toBe(40);

      await act(async () => requests[2]?.resolve(fieldVectorResponse(3)));
      await waitFor(
        () =>
          observations.at(-1)?.status === "ready" &&
          observations.at(-1)?.data?.values[0] === 3,
        "final coalesced field response did not become ready",
      );
      expect(requests).toHaveLength(3);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("cancels and rejects a delayed response when the query scope identity changes", async () => {
    let oldRequestSignal: AbortSignal | undefined;
    let unmountRequestSignal: AbortSignal | undefined;
    let resolveOldResponse: ((response: Response) => void) | null = null;
    let vectorRequests = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        if (new URL(requestUrl).pathname === SESSIONS_PATH) {
          return sessionListResponse();
        }
        if (new URL(requestUrl).pathname === SESSION_STATUS_PATH) {
          return jsonResponse({
            resources: {},
            session: {
              session_epoch: "session-1@1700000000000",
              request_scope_epoch: "test-api:1",
              session_id: "session-1",
            },
          });
        }
        if (requestUrl.includes("/data/fields/H_demag/samples/vector")) {
          vectorRequests += 1;
          const scopeId = new URL(requestUrl).searchParams.get("scope_id");
          if (scopeId === query.scope_id) {
            oldRequestSignal = init?.signal ?? undefined;
            return new Promise<Response>((resolve) => {
              resolveOldResponse = resolve;
            });
          }
          if (scopeId === "unmount-scope") {
            return new Promise<Response>((_resolve, reject) => {
              unmountRequestSignal = init?.signal ?? undefined;
              unmountRequestSignal?.addEventListener(
                "abort",
                () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                { once: true },
              );
            });
          }
          return fieldVectorResponse(2);
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const kernel = {
      api,
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const observations: Array<ReturnType<typeof useViewport3DFieldVectorRequest>> = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    let rootMounted = true;

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe observations={observations} />
          </KernelContext.Provider>,
        );
      });
      await waitFor(() => vectorRequests === 1, "original scope request did not start");

      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe
              observations={observations}
              requestQuery={{ ...query, scope_id: "next-scope" }}
            />
          </KernelContext.Provider>,
        );
      });
      await waitFor(
        () => vectorRequests === 2 && observations.at(-1)?.data?.values[0] === 2,
        "new scope response was not adopted",
      );
      expect(oldRequestSignal?.aborted).toBe(true);

      await act(async () => resolveOldResponse?.(fieldVectorResponse(1)));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(observations.at(-1)?.data?.values[0]).toBe(2);

      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe
              observations={observations}
              requestQuery={{ ...query, scope_id: "unmount-scope" }}
            />
          </KernelContext.Provider>,
        );
      });
      await waitFor(() => vectorRequests === 3, "new scope request did not start");

      await act(async () => root.unmount());
      rootMounted = false;
      expect(unmountRequestSignal?.aborted).toBe(true);
    } finally {
      if (rootMounted) await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("refetches a live-owned 204 on field revision without posting compute_fields", async () => {
    updateRealtimeCommunicationPolicy({ field_sample_publish_ms: 1 });
    const calls: Array<{ method: string; url: string }> = [];
    let vectorRequests = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        calls.push({ method: init?.method ?? "GET", url: requestUrl });
        if (new URL(requestUrl).pathname === SESSIONS_PATH) {
          return sessionListResponse();
        }
        if (new URL(requestUrl).pathname === SESSION_STATUS_PATH) {
          return jsonResponse({
            resources: {},
            session: {
              session_epoch: "session-1@1700000000000",
              request_scope_epoch: "test-api:1",
              session_id: "session-1",
            },
          });
        }
        if (requestUrl.includes("/data/fields/H_demag/samples/vector")) {
          vectorRequests += 1;
          return vectorRequests === 1
            ? new Response(null, { headers: contractHeaders, status: 204 })
            : fieldVectorResponse();
        }
        if (requestUrl.includes("/data/fields/H_demag/meta")) {
          return jsonResponse({ state: "pending" });
        }
        throw new Error(`Unexpected request ${requestUrl}`);
      },
    });
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources, {
      scheduleFlush: (flush) => {
        flush();
        return () => undefined;
      },
    });
    const kernel = {
      api,
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const observations: Array<ReturnType<typeof useViewport3DFieldVectorRequest>> = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <Probe observations={observations} />
          </KernelContext.Provider>,
        );
      });
      await waitFor(() => vectorRequests === 1, "initial field request did not return 204");
      expect(observations.at(-1)?.data).toBeNull();

      await act(async () => {
        bridge.handleEvent({
          payload: {
            changes: [
              {
                recommended_fetch: resourceKey,
                resource: "fields",
                resource_id: "samples",
                revision: 2,
              },
            ],
          },
          type: "resource.batch_changed",
        });
      });
      await waitFor(
        () => vectorRequests === 2 && observations.at(-1)?.data !== null,
        "field revision did not refetch the pending vector",
      );

      expect(observations.at(-1)?.data?.quantityId).toBe("H_demag");
      expect(
        calls.filter(
          (call) =>
            call.method === "POST" &&
            call.url.endsWith(SIMULATION_COMMANDS_PATH),
        ),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("refetches object-scoped vector and scalar Inspector metadata after batch field samples change", async () => {
    const requests = new Map<string, number>();
    const urls = new Map<string, string[]>();
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        const requestUrl = String(url);
        if (new URL(requestUrl).pathname === SESSIONS_PATH) {
          return sessionListResponse();
        }
        if (new URL(requestUrl).pathname === SESSION_STATUS_PATH) {
          return jsonResponse({
            resources: {},
            session: {
              request_scope_epoch: "test-api:1",
              session_epoch: "session-1@1700000000000",
              session_id: "session-1",
            },
          });
        }
        const quantityId = ["H_demag", "eden_demag"].find((candidate) =>
          requestUrl.includes(`/data/fields/${candidate}/meta`),
        );
        if (!quantityId) throw new Error(`Unexpected request ${requestUrl}`);
        const requestCount = (requests.get(quantityId) ?? 0) + 1;
        requests.set(quantityId, requestCount);
        urls.set(quantityId, [...(urls.get(quantityId) ?? []), requestUrl]);
        return jsonResponse({ field_revision: requestCount, state: "ready" });
      },
    });
    const bus = new EventBus<KernelEventMap>();
    const resources = new ResourceInvalidationController(bus);
    const bridge = new RealtimeInvalidationBridge(resources, {
      scheduleFlush: (flush) => {
        flush();
        return () => undefined;
      },
    });
    const kernel = {
      api,
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as unknown as KernelApi;
    const observations: FieldMetaProbeObservation[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <FieldMetaProbe observations={observations} />
          </KernelContext.Provider>,
        );
      });
      await waitFor(
        () =>
          requests.get("H_demag") === 1 && requests.get("eden_demag") === 1,
        "initial object-scoped Inspector metadata requests did not complete",
      );

      await act(async () => {
        bridge.handleEvent({
          payload: {
            changes: [
              {
                recommended_fetch: DATA_FIELDS_PATH,
                quantity_ids: ["H_demag", "eden_demag"],
                resource: "fields",
                resource_id: "samples",
                revision: 2,
              },
            ],
          },
          type: "resource.batch_changed",
        });
      });
      await waitFor(
        () =>
          requests.get("H_demag") === 2 && requests.get("eden_demag") === 2,
        "field batch revision did not refetch object-scoped Inspector metadata",
      );

      expect(observations.at(-1)?.hDemag.data?.field_revision).toBe(2);
      expect(observations.at(-1)?.edenDemag.data?.field_revision).toBe(2);
      expect(urls.get("H_demag")).toEqual([
        "http://127.0.0.1:8765/v2/sessions/current/data/fields/H_demag/meta?component=magnitude&scope_id=film&scope_kind=object",
        "http://127.0.0.1:8765/v2/sessions/current/data/fields/H_demag/meta?component=magnitude&scope_id=film&scope_kind=object",
      ]);
      expect(urls.get("eden_demag")).toEqual([
        "http://127.0.0.1:8765/v2/sessions/current/data/fields/eden_demag/meta?component=full&scope_id=film&scope_kind=object",
        "http://127.0.0.1:8765/v2/sessions/current/data/fields/eden_demag/meta?component=full&scope_id=film&scope_kind=object",
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function Probe({
  observations,
  requestQuery = query,
}: {
  observations: Array<ReturnType<typeof useViewport3DFieldVectorRequest>>;
  requestQuery?: FieldVectorQuery;
}) {
  observations.push(
    useViewport3DFieldVectorRequest({
      consumers: ["revision-refetch-test"],
      quantityId: "H_demag",
      query: requestQuery,
      requestId: "revision-refetch-test",
    }),
  );
  return null;
}

function FieldMetaProbe({
  observations,
}: {
  observations: FieldMetaProbeObservation[];
}) {
  const hDemag = useFieldMetaResource({
    component: "magnitude",
    quantityId: "H_demag",
    scope_id: "film",
    scope_kind: "object",
  });
  const edenDemag = useFieldMetaResource({
    component: "full",
    quantityId: "eden_demag",
    scope_id: "film",
    scope_kind: "object",
  });
  observations.push({ edenDemag, hDemag });
  return null;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(message);
}

/** Session identity is confirmed against the session collection. */
function sessionListResponse(): Response {
  return jsonResponse({
    schema_version: "2.0.0",
    sessions: [
      {
        current: true,
        name: "session-1",
        session_id: "session-1",
        status: "running",
      },
    ],
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: contractHeaders });
}

function fieldVectorResponse(firstValue = 1): Response {
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
  new TextEncoder().encodeInto("H_demag", new Uint8Array(buffer, 28, 16));
  new Float64Array(buffer, 48).set([firstValue, 0, -1]);
  return new Response(buffer, {
    headers: {
      ...contractHeaders,
      etag: '"field-revision-2"',
      "x-fullmag-field-revision": "2",
      "x-fullmag-quantity-id": "H_demag",
    },
  });
}

class TestNode {
  readonly childNodes: TestNode[] = [];
  ownerDocument: TestDocument;
  parentNode: TestNode | null = null;
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null = null;

  constructor(ownerDocument: TestDocument, nodeType: number, nodeName: string) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }
  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }
  appendChild<T extends TestNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore<T extends TestNode>(child: T, before: TestNode | null): T {
    if (!before) return this.appendChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }
  removeChild<T extends TestNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class TestElement extends TestNode {
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly tagName: string;

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
  }
}

class TestDocument extends TestNode {
  readonly body: TestElement;
  readonly documentElement: TestElement;
  defaultView: Record<string, unknown> | null = null;

  constructor() {
    super(null as unknown as TestDocument, 9, "#document");
    this.ownerDocument = this;
    this.documentElement = new TestElement(this, "html");
    this.body = new TestElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
  }
  createComment(value: string): TestNode {
    const node = new TestNode(this, 8, "#comment");
    node.nodeValue = value;
    return node;
  }
  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }
  createElementNS(_namespace: string, tagName: string): TestElement {
    return this.createElement(tagName);
  }
  createTextNode(value: string): TestNode {
    const node = new TestNode(this, 3, "#text");
    node.nodeValue = value;
    return node;
  }
}

function installTestDom(): { document: TestDocument; restore: () => void } {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const document = new TestDocument();
  class TestHtmlIFrameElement extends TestElement {}
  const window = {
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    Node: TestNode,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = window;
  for (const [key, value] of Object.entries({
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    Node: TestNode,
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return {
    document,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
