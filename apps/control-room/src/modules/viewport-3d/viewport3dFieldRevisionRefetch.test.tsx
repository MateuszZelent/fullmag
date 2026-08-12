import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import { DATA_FIELDS_PATH, SIMULATION_COMMANDS_PATH } from "@/kernel/api/apiPaths";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { DiagnosticRecorderController } from "@/kernel/performance/diagnostic-recorder/DiagnosticRecorderController";
import {
  updateRealtimeCommunicationPolicy,
} from "@/kernel/realtime/communicationPolicy";
import { RealtimeInvalidationBridge } from "@/kernel/realtime/RealtimeInvalidationBridge";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
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
  it("refetches a live-owned 204 on field revision without posting compute_fields", async () => {
    updateRealtimeCommunicationPolicy({ field_sample_publish_ms: 1 });
    const calls: Array<{ method: string; url: string }> = [];
    let vectorRequests = 0;
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        calls.push({ method: init?.method ?? "GET", url: requestUrl });
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
    const api = new ControlRoomApi({
      baseUrl: "http://127.0.0.1:8765",
      fetchImpl: async (url) => {
        const requestUrl = String(url);
        const quantityId = ["H_demag", "eden_demag"].find((candidate) =>
          requestUrl.includes(`/data/fields/${candidate}/meta`),
        );
        if (!quantityId) throw new Error(`Unexpected request ${requestUrl}`);
        const requestCount = (requests.get(quantityId) ?? 0) + 1;
        requests.set(quantityId, requestCount);
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
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function Probe({
  observations,
}: {
  observations: Array<ReturnType<typeof useViewport3DFieldVectorRequest>>;
}) {
  observations.push(
    useViewport3DFieldVectorRequest({
      consumers: ["revision-refetch-test"],
      quantityId: "H_demag",
      query,
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

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(message);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: contractHeaders });
}

function fieldVectorResponse(): Response {
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
  new Float64Array(buffer, 48).set([1, 0, -1]);
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
