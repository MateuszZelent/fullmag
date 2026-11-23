import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@radix-ui/react-tabs", async () => {
  const React = await import("react");
  const TabsCtx = React.createContext<{
    value?: string;
    onValueChange?: (next: string) => void;
  }>({});
  return {
    Root: ({
      children,
      value,
      onValueChange,
    }: {
      children?: ReactNode;
      value?: string;
      onValueChange?: (next: string) => void;
    }) => (
      <TabsCtx.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </TabsCtx.Provider>
    ),
    List: ({ children }: { children?: ReactNode }) => (
      <div role="tablist">{children}</div>
    ),
    Trigger: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return (
        <button
          aria-selected={ctx.value === value}
          role="tab"
          type="button"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
    Content: ({ children, value }: { children?: ReactNode; value: string }) => {
      const ctx = React.useContext(TabsCtx);
      return ctx.value === value ? <div role="tabpanel">{children}</div> : null;
    },
  };
});

vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open === false ? null : <>{children}</>,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: ComponentProps<"section">) => (
    <section {...props}>{children}</section>
  ),
  DialogDescription: (props: ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: ComponentProps<"footer">) => <footer {...props} />,
  DialogHeader: (props: ComponentProps<"header">) => <header {...props} />,
  DialogTitle: (props: ComponentProps<"h2">) => <h2 {...props} />,
}));

import type { VisualizationStateResource } from "@/kernel/api/apiTypes";
import { RegistryInspectorDialog } from "@/kernel/layout/RegistryInspectorDialog";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestEvent,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { KernelContext } from "@/kernel/KernelContext";
import { runtimeExplorerDetailStore } from "@/kernel/resources/runtimeExplorerDetailStore";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import type { ObjectVisualizationSnapshot } from "@/kernel/visualization/ObjectVisualizationController";
import type { VisualizationRegistrySyncSnapshot } from "@/kernel/visualization/VisualizationRegistrySyncController";
import { buildRuntimeJobTree } from "@/modules/explorer/builders/jobExplorerNodes";
import type { RuntimeJobDescriptor } from "@/modules/explorer/builders/runtimeExplorerSnapshot";
import { RuntimeProblemDiagnosticInspectorPanel } from "@/modules/inspector/panels/RuntimeExplorerInspectorPanels";
import {
  RuntimeDiagnosticCategoryView,
  RuntimeJobsOverviewView,
  RuntimeResourcesOverviewView,
} from "@/modules/inspector/panels/runtime/RuntimeJobsAndDiagnosticsSpecs";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { ComputeNodePolicyEditor } from "../ComputeNodePolicyEditor";
import {
  RAW_API_ITEM,
  RAW_API_PROJECT_DETAIL,
  detailAnswer,
  entry,
} from "../model/__fixtures__/workspaceApi";
import { parseComputeNodeSnapshot } from "../model/computeNodeInventory";
import type { ComputeNodePolicySummary } from "../model/types";
import type { WorkspaceItemDetailState } from "../model/useWorkspaceItems";
import { AboutInspector } from "./AboutInspector";
import { ProjectDetails } from "./ProjectDetails";

const rawProject = {
  ...RAW_API_ITEM,
  id: "wi-p",
  kind: "project",
  name: "waveguide_spinwaves",
  path: "/sims/waveguide.fmp",
  project_id: "proj-waveguide",
};

const baseEntry = entry({
  projectId: "proj-waveguide",
  workspaceId: "wi-p",
  name: "waveguide_spinwaves",
  path: "/sims/waveguide.fmp",
  revision: 12,
  manifestSchemaVersion: "2.0",
});

function buildProjectDetail(
  detailOverrides: Record<string, unknown>,
): WorkspaceItemDetailState {
  return {
    kind: "ready",
    answer: detailAnswer({
      item: rawProject,
      detail: {
        ...RAW_API_PROJECT_DETAIL,
        ...detailOverrides,
      },
      linked_results: [],
    }),
  };
}

describe("Task 26 — Start Screen, RegistryInspectorDialog & Runtime Inspectors", () => {
  it("eliminates forced 'Fields: unavailable' in ProjectDetails across populated, unrun, and legacy archives", () => {
    const withFieldsHtml = renderToStaticMarkup(
      <ProjectDetails
        detail={buildProjectDetail({
          summary: {
            ...(RAW_API_PROJECT_DETAIL.summary as Record<string, unknown>),
            outputs: {
              frames: 400,
              size_bytes: 104857600,
              fields: ["m", "B_demag"],
            },
          },
        })}
        entry={baseEntry}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onTogglePin={vi.fn()}
        openDisabledReason={null}
      />,
    );
    expect(withFieldsHtml).toContain(">m<");
    expect(withFieldsHtml).toContain(">B_demag<");
    expect(withFieldsHtml.toLowerCase()).not.toContain("unavailable");

    const unrunHtml = renderToStaticMarkup(
      <ProjectDetails
        detail={buildProjectDetail({
          runs: [],
          provenance: { authors: [], history: [], runs: [] },
          summary: {
            ...(RAW_API_PROJECT_DETAIL.summary as Record<string, unknown>),
            outputs: {},
          },
        })}
        entry={baseEntry}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onTogglePin={vi.fn()}
        openDisabledReason={null}
      />,
    );
    expect(unrunHtml).toContain("Not computed yet");
    expect(unrunHtml.toLowerCase()).not.toContain("unavailable");

    const legacyHtml = renderToStaticMarkup(
      <ProjectDetails
        detail={buildProjectDetail({
          summary: {
            ...(RAW_API_PROJECT_DETAIL.summary as Record<string, unknown>),
            outputs: { frames: 120 },
          },
        })}
        entry={baseEntry}
        onForget={vi.fn()}
        onOpen={vi.fn()}
        onTogglePin={vi.fn()}
        openDisabledReason={null}
      />,
    );
    expect(legacyHtml).not.toContain("Fields</dt>");
    expect(legacyHtml.toLowerCase()).not.toContain("unavailable");

    const aboutHtml = renderToStaticMarkup(<AboutInspector compute={null} />);
    expect(aboutHtml).not.toContain("v0.1.0");
  });

  it("submits ComputeNodePolicyEditor changes with expectedRevision and GiB reserves via Radix controls", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const snapshot = parseComputeNodeSnapshot("node-alpha", {
      schema_version: "compute_node_snapshot.v1",
      node_id: "node-alpha",
      inventory_revision: 3,
      sample: {
        source: "host_os",
        collected_at: "2026-10-13T12:00:00Z",
        freshness: { status: "current" },
      },
      cpu: {
        topology: {
          status: "available",
          value: { logical_cpus: [{ id: 0, socket_id: 0, numa_node_id: 0, core_id: 0 }] },
        },
        os_constraints: {
          allowed_logical_cpu_ids: { status: "available", value: [0] },
          quota: { status: "available", value: { mode: "unlimited" } },
        },
        effective_capacity_millis: { status: "available", value: 1000 },
      },
      memory: {
        total_bytes: { status: "available", value: 17179869184 },
        available_bytes: { status: "available", value: 8589934592 },
      },
      gpus: { status: "available", value: [] },
      enforcement: {
        cpu_affinity: "supported",
        cpu_quota: "supported",
        memory_cap: "supported",
        gpu_visibility: "supported",
        storage_quota: "supported",
      },
    });
    if (!snapshot) throw new Error("Expected valid snapshot fixture");

    const policy: ComputeNodePolicySummary = {
      revision: 7,
      activeWorkers: 1,
      maxParallelWorkers: 2,
      draining: false,
      overBudget: false,
      blockingReasons: [],
      allowedCpuIds: [0],
      allowedGpuUuids: [],
      cpuReserveMillis: 500,
      memoryReserveBytes: 2 * 1024 ** 3,
      scratchReserveBytes: 4 * 1024 ** 3,
      gpuVramReserves: {},
      priorityOrder: [0],
      parallelismPatternCount: 1,
      allowedParallelismPatterns: [{ kind: "single_process" }],
    };

    const onUpdate = vi.fn(async (_nodeId, _expectedRevision, _request) => ({
      ...policy,
      revision: 8,
      draining: true,
    }));

    try {
      await act(async () => {
        root.render(
          <ComputeNodePolicyEditor
            canEdit
            nodeId="node-alpha"
            onUpdate={onUpdate}
            policy={policy}
            snapshot={snapshot}
          />,
        );
      });

      const editBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Edit policy"),
        "Edit policy button",
      );
      await act(async () => {
        editBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      const drainSwitch = findElement(
        container,
        (el) =>
          (el.getAttribute("role") === "switch" || el.getAttribute("role") === "checkbox") &&
          (el.getAttribute("aria-label") ?? "").includes("Drain this node"),
        "Drain node Radix control",
      );
      await act(async () => {
        drainSwitch.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      const applyBtn = findElement(
        container,
        (el) => el.tagName === "BUTTON" && (el.textContent ?? "").includes("Apply policy"),
        "Apply policy button",
      );
      await act(async () => {
        applyBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(
        "node-alpha",
        7,
        expect.objectContaining({
          policy: expect.objectContaining({
            draining: true,
            reserved_budget: expect.objectContaining({
              memory_bytes: 2 * 1024 ** 3,
              storage_bytes: 4 * 1024 ** 3,
            }),
          }),
        }),
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("applies --depth: 8 CSS variable, deduplicates targets, and exposes Registered Commands in RegistryInspectorDialog", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const deepNested = {
      l1: { l2: { l3: { l4: { l5: { l6: { l7: { leafAtDepth8: "deep-value" } } } } } } },
    };
    const snapshot: ObjectVisualizationSnapshot = {
      version: 2,
      defaults: {} as ObjectVisualizationSnapshot["defaults"],
      overrides: deepNested as unknown as ObjectVisualizationSnapshot["overrides"],
    };
    const syncSnapshot: VisualizationRegistrySyncSnapshot = {
      error: null,
      inflightPatch: null,
      lastLocalChangedAt: null,
      lastRemoteRevision: 5,
      mutation: null,
      pendingFingerprint: null,
      pendingPatch: null,
      version: 2,
    };
    const visualizationState = {
      revision: 5,
      targets: {
        "object:waveguide": deepNested,
      },
    } as unknown as VisualizationStateResource;

    try {
      await act(async () => {
        root.render(
          <RegistryInspectorDialog
            commands={[{ id: "study.run", title: "Run Study", category: "Simulation" }]}
            onOpenChange={vi.fn()}
            onRetryMutation={vi.fn()}
            open
            snapshot={snapshot}
            syncSnapshot={syncSnapshot}
            visualizationState={visualizationState}
          />,
        );
      });

      const bodyText = dom.document.body.textContent ?? "";
      expect(bodyText).toContain("Registered Commands");

      const depth8Rows = findElements(
        dom.document.body,
        (el) =>
          el.getAttribute("data-depth") === "8" &&
          (el.style["--depth"] === "8" ||
            (el.getAttribute("style") ?? "").includes("--depth: 8")),
      );
      expect(depth8Rows.length).toBeGreaterThan(0);
      expect(depth8Rows[0]?.style.paddingInlineStart).toContain("calc(8 *");

      const stateDuplicateSummary = findElements(
        dom.document.body,
        (el) =>
          el.tagName === "SPAN" &&
          el.getAttribute("class") === "fm-registry-tree__key" &&
          el.textContent === "state",
      );
      expect(stateDuplicateSummary).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("unlocks selectable pending jobs.stage and navigates to offending node from runtime diagnostics", async () => {
    const pendingStageDescriptor = {
      detail: {
        cache: null,
        category: "job",
        condition: "ready",
        contractGap: false,
        facts: [],
        generation: null,
        key: "/v2/study/stages/stage-1",
        lifecycleStatus: "pending",
        location: null,
        message: null,
        owner: "stage:stage-1",
        requestedExecution: null,
        resolvedExecution: null,
        revision: 1,
        schema: null,
        sizeBytes: null,
        sourceStatus: "ready",
      },
      id: "job:stage:stage-1",
      kind: "stage",
      label: "Stage 1: Relax",
      selectable: false,
      state: {
        availability: "available",
        executionState: "not_started",
        resourceState: "ready",
        selectable: false,
        status: "ready",
      },
    } as unknown as RuntimeJobDescriptor;

    const jobTree = buildRuntimeJobTree([pendingStageDescriptor]);
    expect(jobTree[0]?.children?.[0]?.selectable).toBe(true);

    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const selectionController = new SelectionController(new EventBus<KernelEventMap>());

    runtimeExplorerDetailStore.publish([
      {
        id: "diag:problem",
        detail: {
          cache: null,
          category: "diagnostic",
          condition: "degraded",
          contractGap: false,
          facts: [
            { label: "Target", value: "study.execution" },
            { label: "Severity", value: "error" },
            { label: "Finding", value: "Explicit GPU device unavailable on active host" },
          ],
          generation: "gen-1",
          key: "/v2/diagnostics/problem",
          lifecycleStatus: "error",
          location: null,
          message: "Explicit GPU device unavailable on active host",
          owner: "study.execution",
          requestedExecution: null,
          resolvedExecution: null,
          revision: 3,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
      {
        category: "diagnostic",
        id: "diagnostics:solver",
        label: "High Courant number",
        parentId: "diagnostics:root",
        detail: {
          cache: null,
          category: "diagnostic",
          condition: "warning",
          contractGap: false,
          facts: [{ label: "Severity", value: "warning" }],
          generation: null,
          key: "/v2/diagnostics/simulation",
          lifecycleStatus: "warning",
          location: null,
          message: "Courant number exceeds 0.85",
          owner: "run:run-42",
          requestedExecution: null,
          resolvedExecution: null,
          revision: 1,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
      {
        category: "diagnostic",
        id: "diagnostics:frequency-domain",
        label: "Modal basis conditioning",
        parentId: "diagnostics:root",
        detail: {
          cache: null,
          category: "diagnostic",
          condition: "ready",
          contractGap: false,
          facts: [{ label: "Severity", value: "info" }],
          generation: null,
          key: "/v2/diagnostics/frequency-domain",
          lifecycleStatus: "ok",
          location: null,
          message: "Modal basis orthonormal within tolerance",
          owner: null,
          requestedExecution: null,
          resolvedExecution: null,
          revision: 1,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
    ]);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={{ selection: selectionController } as unknown as KernelApi}>
            <RuntimeProblemDiagnosticInspectorPanel
              selection={{
                kind: "diagnostics.problem",
                label: "Problem Diagnostics",
                moduleSource: "explorer",
                nodeId: "diag:problem",
                objectId: null,
                ref: {
                  descriptorId: "diag:problem",
                  kind: "diagnostics.problem",
                  nodeId: "diag:problem",
                  resourceKey: "/v2/diagnostics/problem",
                  type: "runtime-explorer",
                },
              }}
            />
          </KernelContext.Provider>,
        );
      });

      const jumpBtn = findElement(
        container,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.textContent ?? "").includes("Jump to Offending Node"),
        "Jump to Offending Node button",
      );
      await act(async () => {
        jumpBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });

      expect(selectionController.get().kind).toBe("study.execution");
    } finally {
      await act(async () => root.unmount());
      runtimeExplorerDetailStore.clear();
      dom.restore();
    }
  });

  it("reads real CommandRegistry.all() when commands prop is omitted and filters resources/jobs/diagnostics roots", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const registry = new CommandRegistry();
    registry.register({
      category: "simulation",
      id: "study.run",
      isEnabled: () => true,
      run: async () => ({ status: "completed" }),
      title: "Run Study",
    });
    registry.register({
      category: "simulation",
      id: "study.stop",
      isEnabled: () => false,
      run: async () => ({ status: "completed" }),
      title: "Stop Study",
    });

    const snapshot: ObjectVisualizationSnapshot = {
      version: 1,
      defaults: {} as ObjectVisualizationSnapshot["defaults"],
      overrides: {} as ObjectVisualizationSnapshot["overrides"],
    };
    const syncSnapshot: VisualizationRegistrySyncSnapshot = {
      error: null,
      inflightPatch: null,
      lastLocalChangedAt: null,
      lastRemoteRevision: 1,
      mutation: null,
      pendingFingerprint: null,
      pendingPatch: null,
      version: 1,
    };

    runtimeExplorerDetailStore.publish([
      {
        id: "res:mesh:domain",
        detail: {
          cache: null,
          category: "resource",
          condition: "ready",
          contractGap: false,
          facts: [],
          generation: "g1",
          key: "/v2/meshing/summary",
          lifecycleStatus: null,
          location: null,
          message: null,
          owner: null,
          requestedExecution: null,
          resolvedExecution: null,
          revision: 4,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
      {
        id: "job:run:current",
        detail: {
          cache: null,
          category: "job",
          condition: "failed",
          contractGap: false,
          facts: [],
          generation: null,
          key: "/v2/simulation/runs/current",
          lifecycleStatus: "failed",
          location: null,
          message: "Diverged",
          owner: null,
          requestedExecution: null,
          resolvedExecution: null,
          revision: 2,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
      {
        id: "diag:mesh",
        detail: {
          cache: null,
          category: "diagnostic",
          condition: "degraded",
          contractGap: false,
          facts: [{ label: "Severity", value: "error" }],
          generation: null,
          key: "/v2/diagnostics/mesh",
          lifecycleStatus: null,
          location: null,
          message: "Degenerate tetrahedron",
          owner: "mesh",
          requestedExecution: null,
          resolvedExecution: null,
          revision: 1,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
      {
        category: "diagnostic",
        id: "diagnostics:solver",
        label: "High Courant number",
        parentId: "diagnostics:root",
        detail: {
          cache: null,
          category: "diagnostic",
          condition: "warning",
          contractGap: false,
          facts: [{ label: "Severity", value: "warning" }],
          generation: null,
          key: "/v2/diagnostics/simulation",
          lifecycleStatus: "warning",
          location: null,
          message: "Courant number exceeds 0.85",
          owner: "run:run-42",
          requestedExecution: null,
          resolvedExecution: null,
          revision: 1,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
      {
        category: "diagnostic",
        id: "diagnostics:frequency-domain",
        label: "Modal basis conditioning",
        parentId: "diagnostics:root",
        detail: {
          cache: null,
          category: "diagnostic",
          condition: "ready",
          contractGap: false,
          facts: [{ label: "Severity", value: "info" }],
          generation: null,
          key: "/v2/diagnostics/frequency-domain",
          lifecycleStatus: "ok",
          location: null,
          message: "Modal basis orthonormal within tolerance",
          owner: null,
          requestedExecution: null,
          resolvedExecution: null,
          revision: 1,
          schema: null,
          sizeBytes: null,
          sourceStatus: "ready",
        },
      },
    ]);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider
            value={{ commands: registry } as unknown as KernelApi}
          >
            <RegistryInspectorDialog
              onOpenChange={vi.fn()}
              onRetryMutation={vi.fn()}
              open
              snapshot={snapshot}
              syncSnapshot={syncSnapshot}
              visualizationState={null}
            />
          </KernelContext.Provider>,
        );
      });

      const cmdTab = findElement(
        dom.document.body,
        (el) =>
          el.getAttribute("role") === "tab" &&
          (el.textContent ?? "").includes("Registered Commands"),
        "Registered Commands tab",
      );
      expect(cmdTab.textContent).toContain("2");
      await act(async () => {
        cmdTab.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(dom.document.body.textContent ?? "").toContain("Run Study (study.run)");
      expect(dom.document.body.textContent ?? "").toContain("Stop Study (study.stop)");

      await act(async () => {
        root.render(
          <RuntimeResourcesOverviewView
            selection={{
              kind: "resources.root",
              label: "Resources",
              moduleSource: "explorer",
              nodeId: "resources:root",
              objectId: null,
              ref: null,
            }}
          />,
        );
      });
      expect(container.textContent ?? "").toContain("/v2/meshing/summary");

      await act(async () => {
        root.render(
          <RuntimeJobsOverviewView
            selection={{
              kind: "jobs.root",
              label: "Jobs",
              moduleSource: "explorer",
              nodeId: "jobs:root",
              objectId: null,
              ref: null,
            }}
          />,
        );
      });
      expect(container.textContent ?? "").toContain("/v2/simulation/runs/current");

      const selectionController = new SelectionController(new EventBus<KernelEventMap>());
      await act(async () => {
        root.render(
          <KernelContext.Provider
            value={{ selection: selectionController } as unknown as KernelApi}
          >
            <RuntimeDiagnosticCategoryView
              categoryTitle="Diagnostics"
              selection={{
                kind: "diagnostics.root",
                label: "Diagnostics",
                moduleSource: "explorer",
                nodeId: "diagnostics:root",
                objectId: null,
                ref: null,
              }}
              specId="diagnostics.root"
            />
          </KernelContext.Provider>,
        );
      });
      expect(container.textContent ?? "").toContain("Degenerate tetrahedron");
      expect(container.textContent ?? "").toContain("Courant number exceeds 0.85");
      expect(container.textContent ?? "").toContain("/v2/diagnostics/frequency-domain");

      const allInspectBtns = findElements(
        container,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.textContent ?? "").includes("Inspect"),
      );
      expect(allInspectBtns).toHaveLength(3);
      await act(async () => {
        allInspectBtns[2]?.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(selectionController.get().kind).toBe("diagnostics.frequency-domain");

      const warnButton = findElement(
        container,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.textContent ?? "").trim() === "Warnings",
        "Warnings severity filter",
      );
      await act(async () => {
        warnButton.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(container.textContent ?? "").toContain("Courant number exceeds 0.85");
      expect(container.textContent ?? "").not.toContain("Degenerate tetrahedron");

      const inspectBtn = findElement(
        container,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.textContent ?? "").includes("Inspect"),
        "Inspect solver diagnostic button",
      );
      await act(async () => {
        inspectBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(selectionController.get().kind).toBe("diagnostics.solver");

      await act(async () => {
        root.render(
          <KernelContext.Provider
            value={{ selection: selectionController } as unknown as KernelApi}
          >
            <RuntimeDiagnosticCategoryView
              categoryTitle="Solver Diagnostics"
              selection={selectionController.get()}
              specId="diagnostics.solver"
            />
          </KernelContext.Provider>,
        );
      });
      const jumpRunBtn = findElement(
        container,
        (el) =>
          el.tagName === "BUTTON" &&
          (el.textContent ?? "").includes("Jump to Offending Node"),
        "Jump to run offending node",
      );
      await act(async () => {
        jumpRunBtn.dispatchEvent(new TestEvent("click", { bubbles: true }));
      });
      expect(selectionController.get().kind).toBe("jobs.run");
      expect(selectionController.get().nodeId).toBe("jobs:run:run-42");
    } finally {
      await act(async () => root.unmount());
      runtimeExplorerDetailStore.clear();
      dom.restore();
    }
  });
});
