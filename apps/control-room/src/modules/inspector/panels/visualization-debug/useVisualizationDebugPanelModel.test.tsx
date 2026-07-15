import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { FieldMetaResource } from "@/kernel/api/apiTypes";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";

import {
  VisualizationDebugFieldMetaRegistry,
  VisualizationDebugPanelModelAdapter,
  resolveVisualizationDebugFieldMetaRegistryValue,
  visualizationDebugFieldMetaHookInput,
  requestVisualizationDebugTarget,
} from "./useVisualizationDebugPanelModel";
import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";

const hookSource = readFileSync(
  join(
    process.cwd(),
    "src/modules/inspector/panels/visualization-debug/useVisualizationDebugPanelModel.ts",
  ),
  "utf8",
);

const objectSelection: SelectionRef = {
  kind: "object.visualization.debug",
  nodeId: "object:magnet:visualization:debug",
  objectId: "magnet",
  type: "scene-object",
  visualizationTargetId: "object:magnet",
};

function Probe({
  model,
  observations,
}: {
  model: VisualizationDebugPanelModel;
  observations: unknown[];
}) {
  observations.push(model);
  return <output data-state={model.state}>{model.target?.id ?? "none"}</output>;
}

describe("useVisualizationDebugPanelModel", () => {
  it("requests exact target demand and returns an idempotent release lease", () => {
    const controller = new VisualizationDebugController();
    const request = vi.spyOn(controller, "request");
    const release = requestVisualizationDebugTarget(controller, "object:magnet");

    expect(request).toHaveBeenCalledWith("object:magnet");
    expect(controller.getDemandSnapshot("object:magnet").expanded).toBe(true);
    release();
    release();
    expect(controller.getDemandSnapshot("object:magnet").expanded).toBe(false);
  });

  it("has equal deterministic server and first-client external-store snapshots", () => {
    const controller = new VisualizationDebugController();
    const observations: unknown[] = [];
    const kernel = {
      api: {
        visualization: { acks: async () => ({ entries: [], revision: 0 }) },
      },
      bus: {},
      diagnosticRecorder: {},
      diagnostics: {
        getVersion: () => 0,
        listNewestFirst: () => [],
        subscribe: () => () => undefined,
      },
      layout: {
        get: () => ({ activeViewportMainModuleId: "viewport-3d" }),
        subscribe: () => () => undefined,
      },
      resources: {
        getRevision: () => null,
        subscribe: () => () => undefined,
      },
      visualizationDebug: controller,
    } as unknown as KernelApi;

    const html = renderToStaticMarkup(
      <KernelContext.Provider value={kernel}>
        <VisualizationDebugPanelModelAdapter selection={objectSelection}>
          {(model) => <Probe model={model} observations={observations} />}
        </VisualizationDebugPanelModelAdapter>
      </KernelContext.Provider>,
    );

    expect(html).toContain('data-state="missing-snapshot"');
    expect(observations).toHaveLength(1);
    expect(controller.getDemandSnapshot("object:magnet").expanded).toBe(false);
  });

  it("enables the existing field-meta resource only after an exact carrier query exists", () => {
    expect(visualizationDebugFieldMetaHookInput(null)).toMatchObject({
      enabled: false,
    });
    expect(
      visualizationDebugFieldMetaHookInput({
        component: "x",
        key: "vector-key",
        metaQuery: {
          component: "x",
          scope_id: "part-a",
          scope_kind: "part",
          snapshot_id: "snapshot-4",
          stage_id: "stage-2",
        },
        metaQueryKey: "meta-key",
        metaResourceKey: "meta-key",
        phaseRad: 1.25,
        quantityId: "m",
        scopeId: "part-a",
        scopeKind: "part",
        snapshotId: "snapshot-4",
        stageId: "stage-2",
        vectorResourceKey: "vector-key",
        view: "phase_rotated_real",
      }),
    ).toEqual({
      component: "x",
      enabled: true,
      quantityId: "m",
      scope_id: "part-a",
      scope_kind: "part",
      snapshot_id: "snapshot-4",
      stage_id: "stage-2",
    });
    expect(hookSource).toContain("useFieldMetaResource");
    expect(hookSource).toContain("visualizationDebugFieldMetaHookInput(query)");
    expect(hookSource).not.toContain("modules/viewport-3d");
  });

  it("mounts stable per-meta-query observers and joins their data back into the public model", () => {
    expect(hookSource).toContain("VisualizationDebugFieldMetaObserver");
    expect(hookSource).toContain("fieldMetaByQueryKey: fieldMetaSnapshot.values");
    expect(hookSource).toContain("query.metaQueryKey");
    expect(hookSource).toContain("VisualizationDebugPanelModelAdapter");
    expect(hookSource).not.toContain("createContext");
    expect(hookSource).not.toContain("Context.Provider");
  });

  it("isolates derived meta registries per adapter instance", () => {
    const first = new VisualizationDebugFieldMetaRegistry();
    const second = new VisualizationDebugFieldMetaRegistry();
    const release = first.retain("query-a");
    const meta = {
      components: 3,
      domain_generation_id: "domain-1",
      field_revision: 1,
      kind: "vector",
      label: "m",
      location: "node",
      quantity_id: "m",
      stats: null,
      unit: "A/m",
    } satisfies FieldMetaResource;
    first.set("query-a", meta);

    expect(first.getSnapshot().values.get("query-a")).toBe(meta);
    expect(second.getSnapshot().values.has("query-a")).toBe(false);
    expect(first.getSnapshot()).not.toBe(second.getSnapshot());
    release();
  });

  it.each(["loading", "stale", "error"] as const)(
    "clears retained ready field metadata when the exact resource becomes %s",
    (status) => {
      const registry = new VisualizationDebugFieldMetaRegistry();
      const release = registry.retain("query-a");
      const ready = {
        components: 3,
        domain_generation_id: "domain-1",
        field_revision: 12,
        kind: "vector",
        label: "m",
        location: "node",
        quantity_id: "m",
        stats: null,
        unit: "A/m",
      } satisfies FieldMetaResource;
      registry.set("query-a", ready);
      registry.set(
        "query-a",
        resolveVisualizationDebugFieldMetaRegistryValue({
          data: ready,
          status,
        }),
      );

      expect(registry.getSnapshot().values.get("query-a")).toBeNull();
      release();
    },
  );

  it("releases query data and subscriptions on query removal and dispose", () => {
    const registry = new VisualizationDebugFieldMetaRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const releaseA = registry.retain("query-a");
    const releaseB = registry.retain("query-b");
    registry.set("query-a", null);
    registry.set("query-b", null);
    expect(registry.stats()).toEqual({
      entryCount: 2,
      listenerCount: 1,
      retainedQueryCount: 2,
    });

    releaseA();
    releaseA();
    expect(registry.getSnapshot().values.has("query-a")).toBe(false);
    expect(registry.stats().retainedQueryCount).toBe(1);
    registry.dispose();
    expect(registry.stats()).toEqual({
      entryCount: 0,
      listenerCount: 0,
      retainedQueryCount: 0,
    });
    releaseB();
    unsubscribe();
  });

  it("bounds the instance-local derived meta registry", () => {
    const registry = new VisualizationDebugFieldMetaRegistry();
    const releases = Array.from({ length: 20 }, (_, index) => {
      const key = `query-${index}`;
      const release = registry.retain(key);
      registry.set(key, null);
      return release;
    });
    expect(registry.stats()).toEqual({
      entryCount: 16,
      listenerCount: 0,
      retainedQueryCount: 16,
    });
    releases.forEach((release) => release());
    expect(registry.stats().entryCount).toBe(0);
  });

  it("uses a deterministic diagnostics server snapshot instead of mutable live diagnostics", () => {
    expect(hookSource).toContain("const DIAGNOSTICS_SERVER_VERSION = 0");
    expect(hookSource).toContain("() => DIAGNOSTICS_SERVER_VERSION");
    expect(hookSource).toContain(
      "diagnosticsVersion === DIAGNOSTICS_SERVER_VERSION",
    );
    expect(hookSource).toContain("EMPTY_REQUEST_DIAGNOSTICS");
  });

  it("publishes a snapshot, requests exact field meta, and joins the response into the mounted public model", async () => {
    const dom = installTestDom();
    const releaseMeta = vi.fn();
    const originalRetain = VisualizationDebugFieldMetaRegistry.prototype.retain;
    const retain = vi
      .spyOn(VisualizationDebugFieldMetaRegistry.prototype, "retain")
      .mockImplementation(function (
        this: VisualizationDebugFieldMetaRegistry,
        key,
      ) {
        const release = originalRetain.call(this, key);
        return () => {
          releaseMeta();
          release();
        };
      });
    const dispose = vi.spyOn(
      VisualizationDebugFieldMetaRegistry.prototype,
      "dispose",
    );
    const fieldMeta: FieldMetaResource = {
      components: 3,
      domain_generation_id: "domain-1",
      field_revision: 12,
      kind: "vector",
      label: "Magnetization",
      location: "node",
      quantity_id: "m",
      stats: { max: 3, mean: 2, min: 1 },
      unit: "A/m",
    };
    const meta = vi.fn(async () => fieldMeta);
    const kernel = makeMountedKernel({ meta });
    const observations: VisualizationDebugPanelModel[] = [];
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);

    await act(async () => {
      root.render(
        <KernelContext.Provider value={kernel}>
          <VisualizationDebugPanelModelAdapter selection={objectSelection}>
            {(model) => <Probe model={model} observations={observations} />}
          </VisualizationDebugPanelModelAdapter>
        </KernelContext.Provider>,
      );
    });
    expect(meta).not.toHaveBeenCalled();
    expect(
      kernel.visualizationDebug.getDemandSnapshot("object:magnet").expanded,
    ).toBe(true);

    const token = kernel.visualizationDebug.registerPublisher("viewport-primary");
    await act(async () => {
      kernel.visualizationDebug.commit(
        token,
        "object:magnet",
        mountedSnapshot(),
      );
    });
    for (let index = 0; index < 5 && meta.mock.calls.length === 0; index += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(observations.at(-1)?.state).toBe("ready");
    expect(meta).toHaveBeenCalledTimes(1);
    expect(meta).toHaveBeenCalledWith(
      "m",
      {
        component: "full",
        scope_id: "magnet",
        scope_kind: "object",
        snapshot_id: "snapshot-4",
        stage_id: "relax",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const latest = observations.at(-1)!;
    const observation = latest.viewports[0]?.carriers[0]?.observations[0];
    expect(observation?.backendMeta).toEqual(fieldMeta);
    expect(observation?.backendRenderComparison).toEqual({
      compatible: true,
      rangesMatch: true,
    });

    const emptySnapshot = mountedSnapshot();
    await act(async () => {
      kernel.visualizationDebug.commit(token, "object:magnet", {
        ...emptySnapshot,
        carriers: [],
        target: { ...emptySnapshot.target, carrierIds: [] },
      });
    });
    expect(observations.at(-1)?.state).toBe("target-not-rendered");
    expect(releaseMeta).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    expect(dispose).toHaveBeenCalledTimes(1);
    retain.mockRestore();
    dispose.mockRestore();
    dom.restore();
  });

  it("hydrates with the server diagnostics version when live diagnostics change between SSR and hydration", async () => {
    const kernel = makeMountedKernel({ meta: vi.fn(async () => null) });
    const serverObservations: unknown[] = [];
    const element = (
      <KernelContext.Provider value={kernel}>
        <VisualizationDebugPanelModelAdapter selection={objectSelection}>
          {(model) => <Probe model={model} observations={serverObservations} />}
        </VisualizationDebugPanelModelAdapter>
      </KernelContext.Provider>
    );
    const html = renderToStaticMarkup(element);
    expect(html).toBe(
      '<output data-state="missing-snapshot">object:magnet</output>',
    );

    kernel.diagnostics.record({
      method: "GET",
      outcome: "ok",
      path: "diagnostics-changed-after-ssr",
      requestId: "request-after-ssr",
    });
    await Promise.resolve();
    expect(kernel.diagnostics.getVersion()).toBe(1);

    const dom = installTestDom();
    const container = dom.document.createElement("div");
    const output = dom.document.createElement("output");
    output.setAttribute("data-state", "missing-snapshot");
    output.appendChild(dom.document.createTextNode("object:magnet"));
    container.appendChild(output);
    const clientObservations: unknown[] = [];
    const clientElement = (
      <KernelContext.Provider value={kernel}>
        <VisualizationDebugPanelModelAdapter selection={objectSelection}>
          {(model) => <Probe model={model} observations={clientObservations} />}
        </VisualizationDebugPanelModelAdapter>
      </KernelContext.Provider>
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container as unknown as Element, clientElement);
      await Promise.resolve();
    });

    expect(clientObservations[0]).toEqual(serverObservations[0]);
    expect(
      consoleError.mock.calls.some((args) =>
        args.some((value) => String(value).includes("hydration")),
      ),
    ).toBe(false);
    await act(async () => root!.unmount());
    consoleError.mockRestore();
    dom.restore();
  });
});

function makeMountedKernel({
  meta,
}: {
  meta: (quantityId: string, query: unknown, options: unknown) => Promise<FieldMetaResource | null>;
}): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  return {
    api: {
      data: { fields: { meta } },
      visualization: {
        acks: async () => ({ entries: [], revision: 0 }),
      },
    },
    bus,
    diagnosticRecorder: { record: vi.fn() },
    diagnostics: new RequestDiagnosticsController(),
    layout: new LayoutController(bus),
    resources,
    visualizationDebug: new VisualizationDebugController(),
  } as unknown as KernelApi;
}

function mountedSnapshot(): VisualizationDebugSnapshot {
  const resourceKey =
    "/data/fields/m/samples/vector?component=full&scope_kind=object&scope_id=magnet&snapshot_id=snapshot-4&stage_id=relax&view=phase_rotated_real";
  return {
    capturedAtMs: 12,
    carriers: [
      {
        cache: {
          byteLength: 96,
          entryState: "ready",
          etag: null,
          fieldCacheByteLength: 96,
          fieldCacheEntryCount: 1,
          fieldCacheMaxBytes: 1024,
          retainCount: 1,
        },
        carrierId: "part:magnet",
        carrierRole: "magnetic",
        memory: [],
        payload: {
          component: "full",
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
            adoptedFieldBufferId: "buffer-12",
            adoptedResourceKey: resourceKey,
            adoptedScalarBufferKey: "scalar-12",
            adoptedVectorBuildKey: null,
            frameCommitId: "frame-12",
          },
          fieldBufferState: "ready",
          requestedFieldBufferId: "buffer-12",
          requestedPasses: ["surface"],
          surface: {
            bufferKey: "scalar-12",
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
        request: { plannerRequestId: "request-12", resourceKey },
        revisions: {
          domainGenerationId: "domain-1",
          fieldRevision: "12",
          meshTopologyHash: "mesh-1",
          topologyRevision: "topology-1",
          visualizationRevision: "9",
        },
        samples: [],
        scanState: "complete",
        statistics: [
          {
            finiteCount: 3,
            max: 3,
            mean: 2,
            min: 1,
            nonFiniteCount: 0,
            p01: 1,
            p99: 3,
            source: "render-derived",
            zeroCount: 0,
          },
        ],
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
      frameCommittedAtMs: 11,
      frameCommitId: "frame-12",
      viewportId: "viewport-primary",
    },
    version: 1,
  };
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

  addEventListener(): void {}
  removeEventListener(): void {}
}

class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style: Record<string, string> & { setProperty: (name: string, value: string) => void };
  readonly tagName: string;

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    const style = Object.create(null) as Record<string, string> & {
      setProperty: (name: string, value: string) => void;
    };
    style.setProperty = (name: string, value: string) => {
      style[name] = value;
    };
    this.style = style;
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
