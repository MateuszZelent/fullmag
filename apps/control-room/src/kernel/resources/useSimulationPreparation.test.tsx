import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SIMULATION_PREPARATION_PATH } from "../api/apiPaths";
import type { SimulationPreparationResource } from "../api/apiTypes";
import { ControlRoomApiError } from "../api/ControlRoomApi";
import { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import { KernelContext } from "../KernelContext";
import { DiagnosticRecorderController } from "../performance/diagnostic-recorder/DiagnosticRecorderController";
import { updateRealtimeCommunicationPolicy } from "../realtime/communicationPolicy";
import type { ResourceResult } from "./resourceTypes";
import { ResourceInvalidationController } from "./ResourceInvalidationController";
import { useSimulationPreparation } from "./useSimulationPreparation";

interface Deferred<TData> {
  promise: Promise<TData>;
  reject: (reason?: unknown) => void;
  resolve: (value: TData) => void;
}

type PreparationResult = ResourceResult<SimulationPreparationResource>;

afterEach(() => {
  updateRealtimeCommunicationPolicy({});
  vi.restoreAllMocks();
});

function deferred<TData>(): Deferred<TData> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: TData) => void;
  const promise = new Promise<TData>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

function preparationFixture(revision: number): SimulationPreparationResource {
  return {
    active_stage_id: "planning",
    completed_at_unix_ms: null,
    failure: null,
    log_tail: [],
    preparation_id: "prep-1",
    requested_execution: {
      backend: "fdm",
      device: "gpu",
      engine_id: null,
      mode: "strict",
      precision: "double",
      runtime_family: null,
      worker: null,
    },
    resolved_execution: null,
    revision,
    stages: [],
    started_at_unix_ms: 1_000,
    status: "running",
  };
}

function makeKernel(
  preparation: (options?: { signal?: AbortSignal }) => Promise<SimulationPreparationResource>,
) {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    kernel: {
      api: { simulation: { preparation } },
      bus,
      diagnosticRecorder: new DiagnosticRecorderController({
        config: { enabled: false },
      }),
      resources,
    } as React.ComponentProps<typeof KernelContext.Provider>["value"],
    bus,
    resources,
  };
}

function Probe({
  enabled = true,
  observations,
}: {
  enabled?: boolean;
  observations: PreparationResult[];
}) {
  observations.push(useSimulationPreparation({ enabled }));
  return null;
}

function resultSnapshot(result: PreparationResult) {
  return {
    data: result.data,
    error: result.error,
    revision: result.revision,
    status: result.status,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    });
  }
  throw new Error(message);
}

describe("useSimulationPreparation", () => {
  it.each([
    new ControlRoomApiError("authorization token secret-token rejected", 401),
    new ControlRoomApiError(
      "API contract version mismatch: expected 1.0.0, got 0.9.0",
      0,
    ),
    new ControlRoomApiError("internal path /private/model.py failed", 500),
  ])("keeps an initial non-transient facade failure visible", async (failure) => {
    const load = vi.fn(() => Promise.reject(failure));
    const { kernel, resources } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 1);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe observations={observations} />
        </KernelContext.Provider>,
      );
    });
    let latest: ReturnType<typeof resultSnapshot> | null = null;
    try {
      await waitFor(
        () => observations.some((observation) => observation.status === "error"),
        "initial preparation failure was normalized away",
      );
      latest = resultSnapshot(observations.at(-1)!);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }

    expect(latest).toEqual({
      data: null,
      error: failure,
      revision: 1,
      status: "error",
    });
  });

  it("retains stale revision 7 while 8 loads, adopts 8, and keeps it when refresh fails", async () => {
    updateRealtimeCommunicationPolicy({ status_refresh_ms: 1 });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const revision7 = deferred<SimulationPreparationResource>();
    const revision8 = deferred<SimulationPreparationResource>();
    const revision9 = deferred<SimulationPreparationResource>();
    const load = vi
      .fn()
      .mockImplementationOnce(() => revision7.promise)
      .mockImplementationOnce(() => revision8.promise)
      .mockImplementation(() => revision9.promise);
    const { bus, kernel, resources } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 7);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe observations={observations} />
        </KernelContext.Provider>,
      );
    });

    expect(resultSnapshot(observations[0]!)).toMatchObject({
      data: null,
      revision: 7,
      status: "loading",
    });
    await waitFor(() => load.mock.calls.length === 1, "revision 7 did not load");
    await act(async () => {
      revision7.resolve(preparationFixture(7));
      await revision7.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
      data: { revision: 7 },
      revision: 7,
      status: "ready",
    });

    now.mockReturnValue(2_000);
    await act(async () => {
      resources.invalidate(SIMULATION_PREPARATION_PATH, 8);
    });
    const staleRevision8 = resultSnapshot(observations.at(-1)!);
    await waitFor(() => load.mock.calls.length === 2, "revision 8 did not load");
    await act(async () => {
      revision8.resolve(preparationFixture(8));
      await revision8.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
      data: { revision: 8 },
      revision: 8,
      status: "ready",
    });

    const failure = new Error("preparation unavailable");
    now.mockReturnValue(3_000);
    const failures: KernelEventMap["resource:load-failed"][] = [];
    const unsubscribeFailure = bus.on("resource:load-failed", (event) => {
      failures.push(event);
    });
    await act(async () => {
      resources.invalidate(SIMULATION_PREPARATION_PATH, 9);
    });
    const staleRevision9 = resultSnapshot(observations.at(-1)!);
    await waitFor(() => load.mock.calls.length === 3, "revision 9 did not load");
    await act(async () => {
      revision9.reject(failure);
      await revision9.promise.catch(() => undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    });
    const failedRevision9 = resultSnapshot(observations.at(-1)!);

    unsubscribeFailure();
    await act(async () => root.unmount());
    dom.restore();
    expect(staleRevision8).toMatchObject({
      data: { revision: 7 },
      revision: 8,
      status: "stale",
    });
    expect(staleRevision9).toMatchObject({
      data: { revision: 8 },
      revision: 9,
      status: "stale",
    });
    expect(failedRevision9).toEqual({
      data: preparationFixture(8),
      error: null,
      revision: 9,
      status: "stale",
    });
    expect(failures).toEqual([
      {
        cause: "preparation unavailable",
        errorName: "Error",
        resourceKey: SIMULATION_PREPARATION_PATH,
        revision: 9,
        situation: "Loading runtime resource through the v2 resource hook",
        source: "resource-hook",
        status: null,
      },
    ]);
  });

  it("keeps disabled hooks idle without issuing a request", async () => {
    const load = vi.fn(() => Promise.resolve(preparationFixture(1)));
    const { kernel } = makeKernel(load);
    const observations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe enabled={false} observations={observations} />
        </KernelContext.Provider>,
      );
    });

    expect(resultSnapshot(observations.at(-1)!)).toMatchObject({
      data: null,
      revision: null,
      status: "idle",
    });
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    dom.restore();
  });

  it("matches the server and first client snapshot and aborts on unmount", async () => {
    const pending = deferred<SimulationPreparationResource>();
    let signal: AbortSignal | undefined;
    const load = vi.fn((options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return pending.promise;
    });
    const { kernel, resources } = makeKernel(load);
    resources.invalidate(SIMULATION_PREPARATION_PATH, 11);
    const serverObservations: PreparationResult[] = [];
    renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <Probe observations={serverObservations} />
      </KernelContext.Provider>,
    );

    const clientObservations: PreparationResult[] = [];
    const dom = installTestDom();
    const root = createRoot(dom.document.createElement("div") as unknown as Element);
    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <Probe observations={clientObservations} />
        </KernelContext.Provider>,
      );
    });

    expect(resultSnapshot(clientObservations[0]!)).toEqual(
      resultSnapshot(serverObservations[0]!),
    );
    await waitFor(() => load.mock.calls.length === 1, "request did not start");
    expect(signal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
    dom.restore();
  });
});

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

function installTestDom(): {
  document: TestDocument;
  restore: () => void;
} {
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
