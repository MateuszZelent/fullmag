import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_FIELD_VECTOR_PATH } from "@/kernel/api/apiPaths";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";

import { ObjectVisualizationPanel } from "../ObjectVisualizationPanel";
import { VisualizationVectorAccountingRows } from "../VisualizationVectorAccountingRows";
import { VisualizationDebugPanel } from "./VisualizationDebugPanel";
import {
  createVisualizationDebugEvidenceActions,
  type VisualizationDebugEvidenceActionEnvironment,
} from "./visualizationDebugExport";

describe("VisualizationDebugPanel mounted interaction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts the real Task 10 adapter and supports keyboard evidence actions with complete cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(80_000);
    const dom = installInteractiveTestDom();
    const kernel = makeKernel();
    const clipboardWrite = vi.fn(async () => undefined);
    const createObjectURL = vi.fn((blob: Blob) => {
      void blob;
      return "blob:debug-evidence";
    });
    const download = vi.fn();
    const revokeObjectURL = vi.fn();
    const timers = createInspectableTimers();
    const dispose = vi.fn();
    const actionEnvironment: VisualizationDebugEvidenceActionEnvironment = {
      clipboard: { writeText: clipboardWrite },
      createObjectURL,
      download,
      now: () => Date.now(),
      revokeObjectURL,
      timers,
    };
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <VisualizationDebugPanel
            actionEnvironment={actionEnvironment}
            createActions={(model, dependencies) => {
              const actions = createVisualizationDebugEvidenceActions(
                model,
                dependencies,
              );
              return {
                ...actions,
                dispose() {
                  dispose();
                  actions.dispose();
                },
              };
            }}
            selection={debugSelection}
          />
        </KernelContext.Provider>,
      );
    });
    expect(kernel.visualizationDebug.getDemandSnapshot("object:magnet").expanded).toBe(true);

    const publisher = kernel.visualizationDebug.registerPublisher("viewport-primary");
    await act(async () => {
      kernel.visualizationDebug.commit(
        publisher,
        "object:magnet",
        mountedSnapshot(),
      );
    });
    await settleMountedPanel(container);

    expect(container.textContent).toContain("Evidence export");
    expect(container.textContent).toContain("Snapshot is stale");
    expect(container.textContent).toContain("Evidence is internally consistent");
    expect(container.textContent).toContain("Requested componentfull");
    expect(container.textContent).toContain("Decoded component— (not encoded)");

    const copySnapshot = findButton(container, "Copy snapshot");
    const copyResourceKey = findButton(container, "Copy resource key");
    const exportJson = findButton(container, "Export JSON");
    const rawJson = findButton(container, "Raw bounded JSON");
    const focusOrder = [copySnapshot, copyResourceKey, exportJson, rawJson];

    for (const button of focusOrder) {
      pressTab(dom.document, focusOrder);
      expect(dom.document.activeElement).toBe(button);
      expect(button.getAttribute("class")).toContain(
        button === rawJson
          ? "fm-inspector-section__header"
          : "fm-visualization-debug-action",
      );
    }

    await act(async () => keyboardActivate(copySnapshot, "Enter"));
    expect(clipboardWrite).toHaveBeenLastCalledWith(
      expect.stringContaining("fullmag.visualization-debug.v1"),
    );
    expect(findAlert(container, "Snapshot copied").textContent).toContain("Snapshot copied");

    await act(async () => keyboardActivate(copyResourceKey, " "));
    expect(clipboardWrite).toHaveBeenLastCalledWith(
      expect.stringContaining("scope_id=magnet"),
    );
    expect(findAlert(container, "Resource key copied").textContent).toContain("Resource key copied");

    await act(async () => keyboardActivate(exportJson, "Enter"));
    expect(download).toHaveBeenCalledWith(
      "blob:debug-evidence",
      expect.stringMatching(/\.json$/),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:debug-evidence");
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    expect(rawJson.getAttribute("aria-expanded")).toBe("false");
    await act(async () => keyboardActivate(rawJson, "Enter"));
    expect(rawJson.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain('"schemaVersion": "fullmag.visualization-debug.v1"');

    clipboardWrite.mockRejectedValueOnce(new Error("clipboard denied"));
    await act(async () => keyboardActivate(copySnapshot, "Enter"));
    const failure = findAlert(container, "Snapshot could not be copied");
    expect(failure.textContent).toContain("Snapshot could not be copied");
    expect(failure.getAttribute("data-kind")).toBe("error");
    expect(timers.pending()).toBe(1);

    await act(async () => root.unmount());
    expect(dispose).toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledTimes(createObjectURL.mock.calls.length);
    expect(kernel.visualizationDebug.getDemandSnapshot("object:magnet").expanded).toBe(false);
    dom.restore();
  });

  it("is directly renderable while Task 12 remains the registration owner", () => {
    expect(typeof VisualizationDebugPanel).toBe("function");
    expect(VisualizationDebugPanel.name).toBe("VisualizationDebugPanel");
  });

  it("mounts ordinary Visualization without requesting or subscribing to Debug evidence", async () => {
    const dom = installInteractiveTestDom();
    const kernel = makeKernel();
    const request = vi.spyOn(kernel.visualizationDebug, "request");
    const subscribe = vi.spyOn(kernel.visualizationDebug, "subscribe");
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <ObjectVisualizationPanel
            selection={{
              kind: "object.visualization",
              label: "Visualization",
              moduleSource: "explorer",
              nodeId: "model:object:magnet:visualization",
              objectId: "magnet",
              ref: null,
            }}
          />
        </KernelContext.Provider>,
      );
    });

    expect(request).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    dom.restore();
  });

  it("requests bounded Airbox evidence only while its vector accounting rows are mounted", async () => {
    const dom = installInteractiveTestDom();
    const kernel = makeKernel();
    const request = vi.spyOn(kernel.visualizationDebug, "request");
    const subscribe = vi.spyOn(kernel.visualizationDebug, "subscribe");
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <VisualizationVectorAccountingRows
            availableNodeCount={10_586}
            currentTopologyHash="mesh-1"
            exact
            targetKind="airbox"
          />
        </KernelContext.Provider>,
      );
    });

    expect(request).toHaveBeenCalledWith("airbox");
    expect(subscribe).toHaveBeenCalledWith("airbox", expect.any(Function));
    const publisher = kernel.visualizationDebug.registerPublisher("viewport-primary");
    await act(async () => {
      kernel.visualizationDebug.commit(
        publisher,
        "airbox",
        airboxAccountingSnapshot(),
      );
    });
    expect(container.textContent).toContain("Available air-only nodes10,586");
    expect(container.textContent).toContain("Decoded field samples10,586");
    expect(container.textContent).toContain("Adopted arrows10,586");

    await act(async () => root.unmount());
    expect(kernel.visualizationDebug.getDemandSnapshot("airbox").expanded).toBe(
      false,
    );
    dom.restore();
  });

  it("reports waiting instead of the fallback budget when Airbox availability is not exact", async () => {
    const dom = installInteractiveTestDom();
    const kernel = makeKernel();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <VisualizationVectorAccountingRows
            availableNodeCount={4096}
            currentTopologyHash={null}
            exact={false}
            targetKind="airbox"
          />
        </KernelContext.Provider>,
      );
    });

    expect(container.textContent).toContain("Available air-only nodeswaiting");
    expect(container.textContent).toContain("Decoded field sampleswaiting");
    expect(container.textContent).toContain("Adopted arrowswaiting");
    expect(container.textContent).not.toContain("4,096 est.");

    await act(async () => root.unmount());
    dom.restore();
  });
});

const debugSelection: Selection = {
  kind: "object.visualization.debug",
  label: "Visualization Debug",
  moduleSource: "inspector",
  nodeId: "object:magnet:visualization:debug",
  objectId: "magnet",
  ref: {
    kind: "object.visualization.debug",
    nodeId: "object:magnet:visualization:debug",
    objectId: "magnet",
    type: "scene-object",
    visualizationTargetId: "object:magnet",
  },
};

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    api: {
      data: {
        fields: {
          meta: async () => ({
            components: 3,
            domain_generation_id: "domain-1",
            field_revision: 42,
            kind: "vector",
            label: "Magnetization",
            location: "node",
            quantity_id: "m",
            stats: { max: 1, mean: 0, min: -1 },
            unit: "A/m",
          }),
        },
        meshRegionMemberships: () => new Promise(() => undefined),
      },
      meshing: {
        sharedDomain: {
          manifest: () => new Promise(() => undefined),
        },
      },
      model: {
        scene: () => new Promise(() => undefined),
      },
      sessions: {
        current: {
          status: () => new Promise(() => undefined),
        },
      },
      visualization: {
        acks: async () => ({ entries: [], revision: 42 }),
        state: () => new Promise(() => undefined),
      },
    },
    bus,
    diagnosticRecorder: { record: vi.fn() },
    diagnostics: new RequestDiagnosticsController(),
    layout: new LayoutController(bus),
    resources,
    cameraRegistry: { observeRemoteState: vi.fn() },
    visualization: new ObjectVisualizationController(),
    visualizationSync: {
      applyOptimisticState: (value: unknown) => value,
      getSnapshot: () => ({ version: 0 }),
      observeRemoteState: vi.fn(),
      subscribe: () => () => undefined,
    },
    visualizationDebug: new VisualizationDebugController(),
  } as unknown as KernelApi;
}

function mountedSnapshot(): VisualizationDebugSnapshot {
  const vectorPath = DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "m");
  const resourceKey = `${vectorPath}?component=full&scope_kind=object&scope_id=magnet`;
  return {
    capturedAtMs: 1_000,
    carriers: [
      {
        cache: {
          byteLength: 96,
          entryState: "ready",
          etag: '"field-42"',
          fieldCacheByteLength: 96,
          fieldCacheEntryCount: 1,
          fieldCacheMaxBytes: 1024,
          retainCount: 1,
        },
        carrierId: "part:magnet",
        carrierRole: "magnetic",
        memory: [],
        payload: {
          component: null,
          dtype: "float64",
          formatVersion: 3,
          grid: [1, 1, 1],
          indexing: "explicit_node_indices",
          nComp: 3,
          nodeIndexCount: 1,
          pointCount: 1,
          quantityId: "m",
          scopeId: "magnet",
          scopeKind: "object",
          valueCount: 3,
        },
        render: {
          adoption: {
            adoptedFieldBufferId: "buffer-42",
            adoptedResourceKey: resourceKey,
            adoptedScalarBufferKey: "scalar-42",
            adoptedVectorBuildKey: null,
            frameCommitId: "frame-42",
          },
          fieldBufferState: "ready",
          requestedFieldBufferId: "buffer-42",
          requestedPasses: ["surface"],
          surface: {
            bufferKey: "scalar-42",
            colorMode: "full",
            degradation: null,
            projectionMode: "magnitude",
            scalarByteLength: 8,
          },
          vectors: {
            buildKey: null,
            degradation: null,
            segmentByteLength: null,
            segmentCount: null,
          },
        },
        request: { plannerRequestId: "planner-42", resourceKey },
        revisions: {
          domainGenerationId: "domain-1",
          fieldRevision: "42",
          meshTopologyHash: "mesh-1",
          topologyRevision: "topology-1",
          visualizationRevision: "42",
        },
        samples: [
          {
            componentValues: [1, 0, 0],
            magnitude: 1,
            nodeIndex: 7,
            pointIndex: 0,
          },
        ],
        scanState: "complete",
        statistics: [],
      },
    ],
    disposition: "ready",
    issues: [],
    sharedMemory: [],
    target: {
      carrierIds: ["part:magnet"],
      id: "object:magnet",
      kind: "object",
      label: "Magnet",
    },
    viewport: {
      contextLost: false,
      drawingBuffer: [640, 480],
      frameCommittedAtMs: 990,
      frameCommitId: "frame-42",
      viewportId: "viewport-primary",
    },
    version: 1,
  };
}

function airboxAccountingSnapshot(): VisualizationDebugSnapshot {
  const snapshot = mountedSnapshot();
  const carrier = snapshot.carriers[0];
  if (!carrier?.payload) throw new Error("Mounted snapshot payload is required.");
  const resourceKey = `${DATA_FIELD_VECTOR_PATH.replace("{quantity_id}", "h_demag")}?component=full&scope_kind=airbox&scope_id=part%3A__air__`;
  return {
    ...snapshot,
    carriers: [
      {
        ...carrier,
        carrierId: "part:__air__",
        payload: {
          ...carrier.payload,
          grid: [10_586, 1, 1],
          nodeIndexCount: 10_586,
          pointCount: 10_586,
          quantityId: "h_demag",
          scopeId: "part:__air__",
          scopeKind: "airbox",
          valueCount: 31_758,
        },
        render: {
          ...carrier.render,
          adoption: {
            ...carrier.render.adoption,
            adoptedFieldBufferId: "airbox-buffer",
            adoptedResourceKey: resourceKey,
            adoptedVectorBuildKey: "airbox-build",
            adoptedVectorItemCount: 10_586,
          },
          requestedFieldBufferId: "airbox-buffer",
          requestedPasses: ["vector-glyph"],
          vectors: {
            buildKey: "airbox-build",
            degradation: null,
            segmentByteLength: 508_128,
            segmentCount: 10_586,
          },
        },
        request: { plannerRequestId: "planner-airbox", resourceKey },
      },
    ],
    target: {
      carrierIds: ["part:__air__"],
      id: "airbox",
      kind: "airbox",
      label: "Airbox",
    },
  };
}

function createInspectableTimers() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  return {
    clear(handle: unknown) {
      callbacks.delete(handle as number);
    },
    pending: () => callbacks.size,
    set(callback: () => void) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
  };
}

async function settleMountedPanel(container: TestElement): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (container.textContent.includes("Evidence export")) return;
    await act(async () => {
      await Promise.resolve();
    });
  }
  throw new Error("VisualizationDebugPanel did not reach the ready state.");
}

function findButton(container: TestElement, name: string): TestElement {
  const button = findElements(container, (element) =>
    element.tagName === "BUTTON" &&
    (element.getAttribute("aria-label") === name || element.textContent.includes(name)),
  )[0];
  if (!button) throw new Error(`Button ${name} was not rendered.`);
  return button;
}

function findAlert(container: TestElement, text: string): TestElement {
  const alert = findElements(
    container,
    (candidate) =>
      candidate.getAttribute("role") === "alert" &&
      candidate.textContent.includes(text),
  )[0];
  if (!alert) throw new Error(`Alert ${text} was not rendered.`);
  return alert;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function pressTab(document: TestDocument, focusOrder: readonly TestElement[]): void {
  const current = focusOrder.indexOf(document.activeElement as TestElement);
  focusOrder[(current + 1) % focusOrder.length]!.focus();
}

async function keyboardActivate(
  element: TestElement,
  key: " " | "Enter",
): Promise<void> {
  element.focus();
  const event = new TestEvent("keydown", { bubbles: true, key });
  element.dispatchEvent(event);
  if (!event.defaultPrevented) element.click();
  await Promise.resolve();
}

type TestListener = (event: TestEvent) => void;

class TestEvent {
  bubbles: boolean;
  cancelable = true;
  currentTarget: TestNode | null = null;
  defaultPrevented = false;
  readonly key?: string;
  readonly type: string;
  target: TestNode | null = null;
  private propagationStopped = false;

  constructor(type: string, init: { bubbles?: boolean; key?: string } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.key = init.key;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  isPropagationStopped(): boolean {
    return this.propagationStopped;
  }
}

class TestNode {
  readonly childNodes: TestNode[] = [];
  ownerDocument: TestDocument;
  parentNode: TestNode | null = null;
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null = null;
  private readonly listeners = new Map<string, { capture: TestListener[]; bubble: TestListener[] }>();

  constructor(ownerDocument: TestDocument, nodeType: number, nodeName: string) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.nodeName = nodeName;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }

  appendChild<T extends TestNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends TestNode>(child: T, before: TestNode | null): T {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
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

  addEventListener(
    type: string,
    listener: TestListener,
    options?: boolean | { capture?: boolean },
  ): void {
    const phase =
      options === true || (typeof options === "object" && options.capture)
        ? "capture"
        : "bubble";
    const listeners = this.listeners.get(type) ?? { capture: [], bubble: [] };
    listeners[phase].push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestListener): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    listeners.capture = listeners.capture.filter((item) => item !== listener);
    listeners.bubble = listeners.bubble.filter((item) => item !== listener);
  }

  dispatchEvent(event: TestEvent): boolean {
    if (!event.target) event.target = this;
    const path: TestNode[] = [this];
    let parent = this.parentNode;
    while (parent) {
      path.push(parent);
      parent = parent.parentNode;
    }
    for (const node of [...path].reverse()) {
      node.invoke(event, "capture");
      if (event.isPropagationStopped()) return !event.defaultPrevented;
    }
    for (const node of path) {
      node.invoke(event, "bubble");
      if (event.isPropagationStopped() || !event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  private invoke(event: TestEvent, phase: "capture" | "bubble"): void {
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type)?.[phase] ?? []) {
      listener.call(this, event);
    }
  }
}

class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style: Record<string, string> & {
    setProperty: (name: string, value: string) => void;
  };
  readonly tagName: string;

  get options(): TestElement[] {
    return this.childNodes.filter(
      (child): child is TestElement =>
        child instanceof TestElement && child.tagName === "OPTION",
    );
  }

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    const style = Object.create(null) as TestElement["style"];
    style.setProperty = (name: string, value: string) => {
      style[name] = value;
    };
    this.style = style;
  }

  click(): void {
    this.dispatchEvent(new TestEvent("click", { bubbles: true }));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
}

class TestDocument extends TestNode {
  activeElement: TestElement | null = null;
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

function installInteractiveTestDom(): {
  document: TestDocument;
  restore: () => void;
} {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const document = new TestDocument();
  class TestHtmlIFrameElement extends TestElement {}
  const window = {
    document,
    Element: TestElement,
    Event: TestEvent,
    HTMLElement: TestElement,
    HTMLIFrameElement: TestHtmlIFrameElement,
    KeyboardEvent: TestEvent,
    Node: TestNode,
    addEventListener() {},
    removeEventListener() {},
  };
  document.defaultView = window;
  for (const [key, value] of Object.entries({
    document,
    Element: TestElement,
    Event: TestEvent,
    HTMLElement: TestElement,
    KeyboardEvent: TestEvent,
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
