import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { RequestDiagnosticsController } from "@/kernel/api/RequestDiagnosticsController";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import type { Selection } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";
import { ObjectVisualizationController } from "@/kernel/visualization/ObjectVisualizationController";
import {
  MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES,
  VisualizationDebugController,
} from "@/kernel/visualization/VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";
import { VisualizationDebugPanel } from "@/modules/inspector/panels/visualization-debug/VisualizationDebugPanel";
import type { VisualizationDebugPanelModel } from "@/modules/inspector/panels/visualization-debug/VisualizationDebugPanelModel";
import {
  createVisualizationDebugEvidenceActions,
  type VisualizationDebugEvidenceActionEnvironment,
} from "@/modules/inspector/panels/visualization-debug/visualizationDebugExport";

import { useViewport3DVisualizationDebugPublisher } from "./hooks/useViewport3DVisualizationDebugPublisher";
import { createViewport3DRenderAdoptionRegistry } from "./model/viewport3DRenderAdoptionRegistry";
import { scanFieldVectorDebugStatistics } from "./model/scanFieldVectorDebugStatistics";
import {
  buildViewport3DVisualizationDebugSnapshot,
  type Viewport3DVisualizationDebugCarrierInput,
} from "./model/viewport3DVisualizationDebugModel";
import { Viewport3DResourceTracker } from "./viewport3dDiagnostics";

type CommitFrame = (frame: {
  commitId: string;
  committedAtMs?: number;
  contextLost?: boolean | null;
  drawingBuffer?: readonly [number, number] | null;
}) => void;

describe("Visualization Debug integrated React lifecycle stress", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns every demand, scan, action, publisher, snapshot, subscription, and viewport resource to baseline", async () => {
    vi.useFakeTimers();
    const dom = installInteractiveTestDom();
    const kernel = makeKernel();
    const controller = kernel.visualizationDebug;
    const tracker = new Viewport3DResourceTracker();
    const counters = {
      activeObjectUrls: 0,
      activeTimers: 0,
      activeScans: 0,
      publishes: 0,
      scans: 0,
      timerSets: 0,
    };
    const observedModels: VisualizationDebugPanelModel[] = [];
    const actionEnvironment = makeActionEnvironment(counters);
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const originalCommit = controller.commit.bind(controller);
    const commitSpy = vi
      .spyOn(controller, "commit")
      .mockImplementation((...args) => originalCommit(...args));
    let commitFrame: CommitFrame | null = null;
    let accessibleSourceHandle: object | null = null;

    for (let cycle = 0; cycle < 50; cycle += 1) {
      const targetId = `object:stress-${cycle}` as const;
      const quantityId = cycle % 2 === 0 ? `m-${cycle}` : `h-demag-${cycle}`;
      const revision = `field-revision-${cycle}`;
      const resourceKey = `/v2/sessions/current/data/fields/${quantityId}/samples/vector?scope_kind=object&scope_id=stress-${cycle}&revision=${revision}`;
      const values = new Float64Array(16 * 100);
      values.fill(cycle + 1);
      const source = { quantityId, resourceKey, revision, targetId, values };
      accessibleSourceHandle = source;
      const registry = createViewport3DRenderAdoptionRegistry();
      const selection = debugSelection(cycle, targetId);
      const buildCandidate = async ({ signal }: { signal: AbortSignal; targetId: string }) => {
        counters.activeScans += 1;
        counters.scans += 1;
        try {
          const scannedStats = await scanFieldVectorDebugStatistics(values, {
            signal,
            yieldToMain: () => Promise.resolve(),
          });
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          return {
            materialize: ({ frame }: { frame: Parameters<CommitFrame>[0] }) =>
              buildSnapshot({
                frame,
                quantityId,
                resourceKey,
                revision,
                scannedStats,
                targetId,
                values,
              }),
          };
        } finally {
          counters.activeScans -= 1;
        }
      };

      await act(async () => {
        kernel.layout.setActiveViewportMainModule("viewport-3d");
        root.render(
          <KernelContext.Provider value={kernel}>
            <VisualizationDebugPanel
              actionEnvironment={actionEnvironment}
              createActions={(model, dependencies) => {
                observedModels.push(model);
                return createVisualizationDebugEvidenceActions(model, dependencies);
              }}
              selection={selection}
            />
            <IntegratedViewportConsumer
              buildCandidate={buildCandidate}
              controller={controller}
              onCommitFrame={(next) => {
                commitFrame = next;
              }}
              registry={registry}
              resourceKey={resourceKey}
              revision={revision}
              targetId={targetId}
              tracker={tracker}
            />
          </KernelContext.Provider>,
        );
      });
      await actUntil(() =>
        counters.activeScans === 0 &&
        counters.scans === cycle + 1 &&
        commitFrame !== null,
      );

      const frame = {
        commitId: `frame-${cycle}`,
        committedAtMs: cycle + 1,
        contextLost: false,
        drawingBuffer: [640, 480] as const,
      };
      await act(async () => commitFrame?.(frame));
      await settleReadyPanel(container);
      expect(commitSpy).toHaveBeenCalledTimes(cycle + 1);
      counters.publishes = commitSpy.mock.calls.length;
      expect(counters.publishes).toBe(cycle + 1);

      const snapshots = controller.getSnapshots(targetId);
      expect(snapshots).toHaveLength(1);
      expect(
        new TextEncoder().encode(JSON.stringify(snapshots[0])).byteLength,
      ).toBeLessThanOrEqual(MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES);
      expect(snapshots[0]?.carriers.flatMap((carrier) => carrier.samples)).toHaveLength(12);
      expect(
        Math.max(
          ...snapshots[0]!.carriers.flatMap((carrier) =>
            carrier.samples.map((sample) => sample.componentValues.length),
          ),
        ),
      ).toBe(8);
      assertNoBinaryCarrier(snapshots);
      assertNoBinaryCarrier(observedModels);

      const beforeSettledRepeat = {
        publishes: commitSpy.mock.calls.length,
        scans: counters.scans,
      };
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <VisualizationDebugPanel
              actionEnvironment={actionEnvironment}
              createActions={(model, dependencies) => {
                observedModels.push(model);
                return createVisualizationDebugEvidenceActions(model, dependencies);
              }}
              selection={selection}
            />
            <IntegratedViewportConsumer
              buildCandidate={buildCandidate}
              controller={controller}
              onCommitFrame={(next) => {
                commitFrame = next;
              }}
              registry={registry}
              resourceKey={resourceKey}
              revision={revision}
              targetId={targetId}
              tracker={tracker}
            />
          </KernelContext.Provider>,
        );
        commitFrame?.(frame);
      });
      expect({
        publishes: commitSpy.mock.calls.length,
        scans: counters.scans,
      }).toEqual(beforeSettledRepeat);

      await act(async () => findButton(container, "Export JSON").click());
      expect(counters.activeObjectUrls).toBe(0);
      expect(counters.timerSets).toBe(cycle + 1);

      await act(async () => {
        kernel.layout.setActiveViewportMainModule("results");
        root.render(
          <KernelContext.Provider value={kernel}>
            <VisualizationDebugPanel
              actionEnvironment={actionEnvironment}
              createActions={(model, dependencies) => {
                observedModels.push(model);
                return createVisualizationDebugEvidenceActions(model, dependencies);
              }}
              selection={selection}
            />
          </KernelContext.Provider>,
        );
      });
      expect(commitFrame).toBeNull();
      expect(controller.getDemandSnapshot(targetId).expanded).toBe(true);
      expect(controller.getSnapshots(targetId)).toEqual([]);
      expect(container.textContent).toContain("No active 3D viewport");
      expect(tracker.getLedgerSnapshot()).toEqual([]);
      expect(registry.snapshot(targetId)).toEqual([]);
      assertNoBinaryCarrier(observedModels);

      await act(async () => root.render(null));
      await flushScheduledWork();
      accessibleSourceHandle = null;
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      expect(controller.getLifecycleStats()).toEqual({
        activeDemandCount: 0,
        activePublisherCount: 0,
        demandSubscriptionCount: 0,
        demandedTargetCount: 0,
        retainedSnapshotCount: 0,
        snapshotSubscriptionCount: 0,
      });
      expect(counters.activeScans).toBe(0);
      expect(counters.activeObjectUrls).toBe(0);
      expect(counters.activeTimers).toBe(0);
      expect(commitFrame).toBeNull();
      expect(accessibleSourceHandle).toBeNull();
      expect(registry.snapshot(targetId)).toEqual([]);
      expect(tracker.getLedgerSnapshot()).toEqual([]);
      expect(tracker.getSnapshot()).toMatchObject({
        geometries: 0,
        materials: 0,
        renderTargets: 0,
        textures: 0,
        workers: 0,
      });
      expect(commitSpy).toHaveBeenCalledTimes(cycle + 1);
    }

    expect(counters).toEqual({
      activeObjectUrls: 0,
      activeTimers: 0,
      activeScans: 0,
      publishes: 50,
      scans: 50,
      timerSets: 50,
    });

    const lateTargetId = "object:late-publish";
    const lateRegistry = createViewport3DRenderAdoptionRegistry();
    const lateValues = new Float64Array(16 * 100);
    let lateSignal: AbortSignal | null = null;
    let resolveLate: () => void = () => undefined;
    const lateGate = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    const lateCandidate = async ({ signal }: { signal: AbortSignal }) => {
      lateSignal = signal;
      counters.activeScans += 1;
      try {
        await lateGate;
        const scannedStats = await scanFieldVectorDebugStatistics(lateValues, {
          signal,
        });
        return {
          materialize: ({ frame }: { frame: Parameters<CommitFrame>[0] }) =>
            buildSnapshot({
              frame,
              quantityId: "m-late",
              resourceKey: "resource:late",
              revision: "revision:late",
              scannedStats,
              targetId: lateTargetId,
              values: lateValues,
            }),
        };
      } finally {
        counters.activeScans -= 1;
      }
    };
    await act(async () => {
      kernel.layout.setActiveViewportMainModule("viewport-3d");
      root.render(
        <KernelContext.Provider value={kernel}>
          <VisualizationDebugPanel
            actionEnvironment={actionEnvironment}
            selection={debugSelection(50, lateTargetId)}
          />
          <IntegratedViewportConsumer
            buildCandidate={lateCandidate}
            controller={controller}
            onCommitFrame={(next) => {
              commitFrame = next;
            }}
            registry={lateRegistry}
            resourceKey="resource:late"
            revision="revision:late"
            targetId={lateTargetId}
            tracker={tracker}
          />
        </KernelContext.Provider>,
      );
    });
    await actUntil(() => lateSignal !== null && counters.activeScans === 1);
    await act(async () => root.render(null));
    await flushScheduledWork();
    expect((lateSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(commitFrame).toBeNull();
    expect(controller.getSnapshots(lateTargetId)).toEqual([]);
    resolveLate();
    resolveLate = () => undefined;
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(counters.activeScans).toBe(0);
    expect(commitSpy).toHaveBeenCalledTimes(50);
    expect(controller.getSnapshots(lateTargetId)).toEqual([]);
    expect(lateRegistry.snapshot(lateTargetId)).toEqual([]);
    expect(tracker.getLedgerSnapshot()).toEqual([]);
    expect(controller.getLifecycleStats()).toEqual({
      activeDemandCount: 0,
      activePublisherCount: 0,
      demandSubscriptionCount: 0,
      demandedTargetCount: 0,
      retainedSnapshotCount: 0,
      snapshotSubscriptionCount: 0,
    });
    assertNoBinaryCarrier(observedModels);
    await act(async () => root.unmount());
    dom.restore();
  }, 180_000);
});

function IntegratedViewportConsumer({
  buildCandidate,
  controller,
  onCommitFrame,
  registry,
  resourceKey,
  revision,
  targetId,
  tracker,
}: {
  buildCandidate: Parameters<typeof useViewport3DVisualizationDebugPublisher>[0]["buildCandidate"];
  controller: VisualizationDebugController;
  onCommitFrame(value: CommitFrame | null): void;
  registry: ReturnType<typeof createViewport3DRenderAdoptionRegistry>;
  resourceKey: string;
  revision: string;
  targetId: string;
  tracker: Viewport3DResourceTracker;
}) {
  const { onFrameCommitted } = useViewport3DVisualizationDebugPublisher({
    adoptionRegistry: registry,
    buildCandidate,
    carrierTargets: new Map([[`part:${targetId}`, [targetId]]]),
    controller,
    revision: `${revision}:${resourceKey}`,
    targetIds: [targetId],
    viewportId: "viewport-main",
  });
  useEffect(() => {
    onCommitFrame(onFrameCommitted);
    return () => onCommitFrame(null);
  }, [onCommitFrame, onFrameCommitted]);
  useEffect(() => {
    const geometry = tracker.track("geometry", { dispose: vi.fn() }, {
      byteLength: 1024,
      id: `geometry:${targetId}`,
    });
    const material = tracker.track("material", { dispose: vi.fn() }, {
      byteLength: 256,
      id: `material:${targetId}`,
    });
    return () => {
      tracker.release("geometry", geometry, "viewport-unmount");
      tracker.release("material", material, "viewport-unmount");
    };
  }, [targetId, tracker]);
  return <div data-testid="integrated-viewport-consumer" />;
}

function buildSnapshot({
  frame,
  quantityId,
  resourceKey,
  revision,
  scannedStats,
  targetId,
  values,
}: {
  frame: Parameters<CommitFrame>[0];
  quantityId: string;
  resourceKey: string;
  revision: string;
  scannedStats: Awaited<ReturnType<typeof scanFieldVectorDebugStatistics>>;
  targetId: string;
  values: Float64Array;
}): VisualizationDebugSnapshot {
  const decoded: DecodedFieldVector = {
    dtype: "float64",
    domainGenerationId: `domain:${revision}`,
    formatVersion: 3,
    grid: [100, 1, 1],
    indexing: "legacy_count_only",
    meshTopologyHash: `topology:${revision}`,
    meshTopologyRevision: revision,
    nComp: 16,
    nodeIndices: null,
    pointCount: 100,
    quantityId,
    scopeId: targetId.slice("object:".length),
    scopeKind: "object",
    valueCount: values.length,
    values,
  };
  const carrier: Viewport3DVisualizationDebugCarrierInput = {
    cache: {
      byteLength: values.byteLength,
      dataIdentityMatches: true,
      entryState: "ready",
      etag: `etag:${revision}`,
      key: resourceKey,
      responseMetadata: null,
      retainCount: 1,
    },
    carrierId: `part:${targetId}`,
    carrierRole: "magnetic",
    decoded,
    fieldBufferId: `buffer:${revision}`,
    fieldBufferState: "target-buffer",
    fieldRevision: revision,
    renderedComponent: "full",
    requestIdentityKnown: true,
    requestedComponent: "full",
    requestedPasses: ["surface", "vector-glyph"],
    requestedQuantityId: quantityId,
    requestedScopeId: targetId.slice("object:".length),
    requestedScopeKind: "object",
    resourceKey,
    scanState: "complete",
    scannedStats,
    surfaceDegradation: null,
    surfaceProjectionMode: null,
    surfaceAdoptedAtMs: frame.committedAtMs ?? 0,
    surfaceAdoptedFieldBufferId: `buffer:${revision}`,
    surfaceAdoptedResourceKey: resourceKey,
    surfaceAdoptedScalarBufferKey: null,
    surfaceAdoptionSequence: Number(revision) || 0,
    vectorDegradation: null,
    vectorAdoptedAtMs: frame.committedAtMs ?? 0,
    vectorAdoptedBuildKey: null,
    vectorAdoptedFieldBufferId: `buffer:${revision}`,
    vectorAdoptedItemCount: null,
    vectorAdoptedResourceKey: resourceKey,
    vectorAdoptionSequence: Number(revision) || 0,
  };
  return buildViewport3DVisualizationDebugSnapshot({
    capturedAtMs: frame.committedAtMs ?? 0,
    carriers: [carrier],
    fieldCacheBudget: {
      byteLength: values.byteLength,
      entryCount: 1,
      maxBytes: values.byteLength * 2,
    },
    frame: {
      committedAtMs: frame.committedAtMs ?? 0,
      commitId: frame.commitId,
      contextLost: frame.contextLost ?? null,
      drawingBuffer: frame.drawingBuffer ?? null,
      viewportId: "viewport-main",
    },
    target: { id: targetId, kind: "object", label: targetId },
    visualizationRevision: revision,
    webglSharedByteLength: 1280,
  });
}

function debugSelection(cycle: number, targetId: `object:${string}`): Selection {
  const objectId = targetId.slice("object:".length);
  return {
    kind: "object.visualization.debug",
    label: `Visualization Debug ${cycle}`,
    moduleSource: "inspector",
    nodeId: `${targetId}:visualization:debug`,
    objectId,
    ref: {
      kind: "object.visualization.debug",
      nodeId: `${targetId}:visualization:debug`,
      objectId,
      type: "scene-object",
      visualizationTargetId: targetId,
    },
  };
}

function makeKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const resources = new ResourceInvalidationController(bus);
  const realtimeConnectionSnapshot = { disrupted: false, status: "idle" } as const;
  const visualizationSyncSnapshot = {
    inflightTargetIds: [],
    pendingTargetIds: [],
    version: 0,
  };
  return {
    api: {
      data: {
        fields: {
          meta: async (quantityId: string) => ({
            components: 16,
            domain_generation_id: "stress-domain",
            field_revision: 1,
            kind: "vector",
            label: quantityId,
            location: "node",
            quantity_id: quantityId,
            stats: null,
            unit: "A/m",
          }),
        },
      },
      sessions: {
        current: {
          status: async () => ({
            capabilities: { explicit_topology: true },
            domain: { discretization: "fem" },
            resources: {},
          }),
        },
      },
      simulation: {
        solver: {
          status: async () => ({
            can_accept_commands: true,
            is_busy: false,
            revision: 1,
            run_id: null,
            runtime_state: "idle",
            runtime_status_code: "idle",
            runtime_status_kind: "idle",
            session_status: "ready",
            stage_kind: null,
            warnings: [],
          }),
        },
      },
      visualization: {
        acks: async () => ({ entries: [], revision: 0 }),
      },
    },
    bus,
    diagnosticRecorder: { record: vi.fn() },
    diagnostics: new RequestDiagnosticsController(),
    layout: new LayoutController(bus),
    resources,
    visualization: new ObjectVisualizationController(),
    visualizationDebug: new VisualizationDebugController(),
    visualizationSync: {
      getSnapshot: () => visualizationSyncSnapshot,
      subscribe: () => () => undefined,
    },
    realtimeConnection: {
      getSnapshot: () => realtimeConnectionSnapshot,
      subscribe: () => () => undefined,
    },
  } as unknown as KernelApi;
}

function makeActionEnvironment(counters: {
  activeObjectUrls: number;
  activeTimers: number;
  timerSets: number;
}): VisualizationDebugEvidenceActionEnvironment {
  let nextTimer = 0;
  const timers = new Set<number>();
  return {
    clipboard: { writeText: async () => undefined },
    createObjectURL: () => {
      counters.activeObjectUrls += 1;
      return "blob:visualization-debug-stress";
    },
    download: () => undefined,
    now: () => 1,
    revokeObjectURL: () => {
      counters.activeObjectUrls -= 1;
    },
    timers: {
      clear(handle) {
        if (timers.delete(handle as number)) counters.activeTimers -= 1;
      },
      set() {
        const id = ++nextTimer;
        timers.add(id);
        counters.activeTimers += 1;
        counters.timerSets += 1;
        return id;
      },
    },
  };
}

function assertNoBinaryCarrier(value: unknown): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, path: string) => {
    if (candidate == null || typeof candidate !== "object") return;
    expect(candidate, `${path} retained an ArrayBuffer/View`).not.toBeInstanceOf(
      ArrayBuffer,
    );
    expect(ArrayBuffer.isView(candidate), `${path} retained a typed array`).toBe(
      false,
    );
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      visit(entry, `${path}.${key}`);
    }
  };
  visit(value, "root");
}

async function settleReadyPanel(container: TestElement): Promise<void> {
  await actUntil(() => container.textContent.includes("Evidence export"));
}

async function actUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushScheduledWork();
    if (predicate()) return;
  }
  expect(predicate()).toBe(true);
}

async function flushScheduledWork(): Promise<void> {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
  });
}

function findButton(container: TestElement, name: string): TestElement {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (
      node instanceof TestElement &&
      node.tagName === "BUTTON" &&
      (node.getAttribute("aria-label") === name || node.textContent.includes(name))
    ) {
      found.push(node);
    }
    node.childNodes.forEach(visit);
  };
  visit(container);
  if (!found[0]) throw new Error(`Button ${name} was not rendered.`);
  return found[0];
}

type TestListener = (event: TestEvent) => void;

class TestEvent {
  bubbles: boolean;
  currentTarget: TestNode | null = null;
  defaultPrevented = false;
  readonly type: string;
  target: TestNode | null = null;
  private stopped = false;

  constructor(type: string, init: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.stopped = true;
  }
  isPropagationStopped(): boolean {
    return this.stopped;
  }
}

class TestNode {
  readonly childNodes: TestNode[] = [];
  ownerDocument: TestDocument;
  parentNode: TestNode | null = null;
  readonly nodeType: number;
  readonly nodeName: string;
  nodeValue: string | null = null;
  private readonly listeners = new Map<string, TestListener[]>();

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
    return this.parentNode.childNodes[
      this.parentNode.childNodes.indexOf(this) + 1
    ] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3
      ? this.nodeValue ?? ""
      : this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes.forEach((child) => {
      child.parentNode = null;
    });
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
  addEventListener(type: string, listener: TestListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: TestListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }
  dispatchEvent(event: TestEvent): boolean {
    if (!event.target) event.target = this;
    dispatchTestEvent(this, event);
    return !event.defaultPrevented;
  }
  invokeListeners(event: TestEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

function dispatchTestEvent(node: TestNode, event: TestEvent): void {
  event.currentTarget = node;
  node.invokeListeners(event);
  if (event.bubbles && !event.isPropagationStopped() && node.parentNode) {
    dispatchTestEvent(node.parentNode, event);
  }
}

class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style: Record<string, string> & {
    setProperty(name: string, value: string): void;
  };
  readonly tagName: string;

  constructor(ownerDocument: TestDocument, tagName: string) {
    super(ownerDocument, 1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    const style = Object.create(null) as TestElement["style"];
    style.setProperty = (name, value) => {
      style[name] = value;
    };
    this.style = style;
  }
  click(): void {
    this.dispatchEvent(new TestEvent("click", { bubbles: true }));
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

function installInteractiveTestDom(): {
  document: TestDocument;
  restore(): void;
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
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
