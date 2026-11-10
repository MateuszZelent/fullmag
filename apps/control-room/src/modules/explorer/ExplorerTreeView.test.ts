import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MODEL_GEOMETRY_VALIDATION_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";
import type { KernelApi } from "@/kernel/types";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";

import { buildStudyNodes } from "./builders/study/studyExplorerNodes";
import type { ExplorerNode } from "./explorerTypes";
import {
  contextCommandItemsForNode,
  flattenVisibleExplorerRows,
  resolveExplorerFocusableRowId,
  resolveExplorerKeyboardTargetRowId,
  resolveExplorerRevealScrollTop,
  sliceVisibleExplorerRows,
} from "./ExplorerTreeView";
import { explorerStatusClassName } from "./explorerStatusClass";

function readSource(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

const explorerTreeViewSource = readSource(
  fileURLToPath(import.meta.resolve("./ExplorerTreeView.tsx")),
);
const explorerModuleSource = readSource(
  fileURLToPath(import.meta.resolve("./ExplorerModule.tsx")),
);

describe("flattenVisibleExplorerRows", () => {
  it("keeps collapsed descendants out of the rendered row list", () => {
    const nodes: ExplorerNode[] = [
      {
        id: "root",
        kind: "session.root",
        label: "Root",
        parentId: null,
        children: [
          {
            id: "child",
            kind: "objects.root",
            label: "Child",
            parentId: "root",
            children: [
              {
                id: "grandchild",
                kind: "object.root",
                label: "Grandchild",
                parentId: "child",
              },
            ],
          },
        ],
      },
    ];

    expect(
      flattenVisibleExplorerRows(nodes, new Set()).map((row) => row.node.id),
    ).toEqual(["root"]);
    expect(
      flattenVisibleExplorerRows(nodes, new Set(["root"])).map(
        (row) => row.node.id,
      ),
    ).toEqual(["root", "child"]);
    expect(
      flattenVisibleExplorerRows(nodes, new Set(["root", "child"])).map(
        (row) => row.node.id,
      ),
    ).toEqual(["root", "child", "grandchild"]);
  });

  it("windows large visible row lists with overscan", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      depth: 0,
      expanded: false,
      hasChildren: false,
      node: {
        id: `node-${index}`,
        kind: "object.root" as const,
        label: `Node ${index}`,
        parentId: null,
      },
    }));

    expect(
      sliceVisibleExplorerRows({
        overscan: 1,
        rowHeight: 10,
        rows,
        scrollTop: 250,
        viewportHeight: 30,
      }),
    ).toMatchObject({
      bottomPadding: 710,
      start: 24,
      topPadding: 240,
    });
  });

  it("scrolls an offscreen active node into the visible tree window", () => {
    const rowIds = Array.from({ length: 100 }, (_, index) => `node-${index}`);

    expect(
      resolveExplorerRevealScrollTop({
        activeNodeId: "node-50",
        rowHeight: 28,
        rowIds,
        scrollTop: 0,
        viewportHeight: 280,
      }),
    ).toBe(1148);
    expect(
      resolveExplorerRevealScrollTop({
        activeNodeId: "node-5",
        rowHeight: 28,
        rowIds,
        scrollTop: 0,
        viewportHeight: 280,
      }),
    ).toBeNull();
  });

  it("chooses a single focusable row for roving tree tabindex", () => {
    const rowIds = ["root", "geometry", "mesh"];

    expect(
      resolveExplorerFocusableRowId({
        activeNodeId: "geometry",
        keyboardRowId: "mesh",
        rowIds,
      }),
    ).toBe("mesh");
    expect(
      resolveExplorerFocusableRowId({
        activeNodeId: "geometry",
        keyboardRowId: "offscreen",
        rowIds,
      }),
    ).toBe("geometry");
    expect(
      resolveExplorerFocusableRowId({
        activeNodeId: null,
        keyboardRowId: null,
        rowIds,
      }),
    ).toBe("root");
    expect(
      resolveExplorerFocusableRowId({
        activeNodeId: null,
        keyboardRowId: null,
        rowIds: [],
      }),
    ).toBeNull();
  });

  it("resolves keyboard navigation targets for visible explorer rows", () => {
    const rowIds = ["root", "geometry", "mesh"];

    expect(
      resolveExplorerKeyboardTargetRowId({
        currentNodeId: "geometry",
        key: "ArrowDown",
        rowIds,
      }),
    ).toBe("mesh");
    expect(
      resolveExplorerKeyboardTargetRowId({
        currentNodeId: "geometry",
        key: "ArrowUp",
        rowIds,
      }),
    ).toBe("root");
    expect(
      resolveExplorerKeyboardTargetRowId({
        currentNodeId: "geometry",
        key: "Home",
        rowIds,
      }),
    ).toBe("root");
    expect(
      resolveExplorerKeyboardTargetRowId({
        currentNodeId: "geometry",
        key: "End",
        rowIds,
      }),
    ).toBe("mesh");
    expect(
      resolveExplorerKeyboardTargetRowId({
        currentNodeId: "geometry",
        key: "PageDown",
        rowIds,
      }),
    ).toBeNull();
  });

  it("resolves context command disabled state from the command registry", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }
    const kernel = {
      api: { commands: { submit: async () => ({ accepted: true }) } },
      commands,
      visualizationDebug: new VisualizationDebugController(),
    } as unknown as KernelApi;
    const node: ExplorerNode = {
      contextCommands: ["study.pause", "study.run"],
      id: "model:study",
      kind: "study.root",
      label: "Study",
      parentId: null,
    };

    const items = contextCommandItemsForNode({
      kernel,
      node,
      resourceData: {
        [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
        [MODEL_READINESS_PATH]: {
          blockers: [],
          ready_to_export: true,
          ready_to_run: true,
          scene_revision: 1,
        },
        [SESSION_STATUS_RESOURCE_KEY]: {
          capabilities: {
            binary_fields: true,
            explicit_topology: false,
          },
          domain: {
            discretization: "fdm",
          },
          resources: {
            mesh_revision: 0,
            scene_revision: 1,
          },
        },
        [SIMULATION_COMMANDS_PATH]: { commands: [] },
        [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
        [SIMULATION_STAGES_EXECUTION_PATH]: {
          active_stage_index: null,
          revision: 1,
          runtime_state: "idle",
          stages: [],
        },
      },
    });

    expect(
      items.find((item) => item.command.id === "study.pause"),
    ).toMatchObject({
      disabled: true,
      disabledReason: "Runtime is not running.",
    });
    expect(items.find((item) => item.command.id === "study.run")).toMatchObject({
      disabled: false,
    });
  });

  it("separates stage restart from held whole Study and keeps terminal postprocessing", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) commands.register(command);
    const kernel = { api: {}, commands } as unknown as KernelApi;
    const stages = [
      { stage_id: "first", kind: "relax" },
      { stage_id: "second", kind: "run" },
    ];
    const root = buildStudyNodes({
      stages: stages.map((stage, index) => ({
        index, kind: stage.kind, authoredStageId: stage.stage_id, stageId: stage.stage_id,
      })),
    });
    const clicked = root.children![0].children![0];
    const status = {
      capabilities: { binary_fields: true, explicit_topology: false },
      domain: { discretization: "fdm" },
      resources: { mesh_revision: 0, scene_revision: 1 },
      run: { run_id: "held-study" },
    };
    const resources = {
      [MODEL_SCENE_PATH]: { scene_revision: 1, study: { stages } },
      [SESSION_STATUS_RESOURCE_KEY]: status,
      [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "waiting_for_compute" },
      [SIMULATION_STAGES_EXECUTION_PATH]: null,
      [SIMULATION_COMMANDS_PATH]: {
        commands: [],
        runtime_controls: [
          { kind: "relax", enabled: true },
          { kind: "solve", enabled: false, reason: "Accepted preparation is pending; Compute remains held." },
        ],
      },
    };
    const stageItem = (resourceData: Record<string, unknown>) =>
      contextCommandItemsForNode({ kernel, node: clicked, resourceData })
        .find((item) => item.command.id === "study.execute-stage");
    expect(stageItem(resources)).toMatchObject({ disabled: true, disabledReason: "Model readiness is unavailable." });
    const ready = { ...resources, [MODEL_READINESS_PATH]: { scene_revision: 1, ready_to_run: true, blockers: [] } };
    expect(stageItem(ready)).toMatchObject({ disabled: false, context: { input: { stageId: "first" } } });
    expect(contextCommandItemsForNode({ kernel, node: root, resourceData: ready })
      .find((item) => item.command.id === "study.run")).toMatchObject({
        disabled: true, disabledReason: "Accepted preparation is pending; Compute remains held.",
      });

    const terminalResources = {
      ...resources,
      [SESSION_STATUS_RESOURCE_KEY]: {
        ...status,
        domain: { discretization: "fem" },
        capabilities: { binary_fields: true, explicit_topology: true },
      },
      [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "awaiting_command", revision: 4 },
      [SIMULATION_STAGES_EXECUTION_PATH]: { run_id: "held-study", runtime_state: "completed", revision: 4 },
      [SIMULATION_COMMANDS_PATH]: {
        commands: [], revision: 4,
        runtime_controls: [
          { kind: "compute_fields", enabled: true },
          { kind: "compute_energies", enabled: true },
        ],
      },
    };
    const postprocessing = contextCommandItemsForNode({ kernel, node: root, resourceData: terminalResources });
    expect(postprocessing.find((item) => item.command.id === "study.compute-fields")?.disabled).toBe(false);
    expect(postprocessing.find((item) => item.command.id === "study.compute-energies")?.disabled).toBe(false);
  });

  it("shares the owner’s mesh and stage reads with context menus", () => {
    expect(explorerTreeViewSource).toContain(
      "useRuntimeCommandControlResourceData({",
    );
    expect(explorerTreeViewSource).toContain(
      "includeSharedDomainReadiness: false",
    );
    expect(explorerTreeViewSource).toContain("includeStageExecution: false");
    expect(explorerModuleSource).toContain("sharedCommandResources={sharedCommandResources}");
    expect(explorerModuleSource).toContain("[MESHING_BUILDS_CURRENT_PATH]: activeBuild.status");
    expect(explorerModuleSource).toContain("[MESHING_SHARED_DOMAIN_MANIFEST_PATH]: manifest.status");
    expect(explorerModuleSource).toContain("[SIMULATION_STAGES_EXECUTION_PATH]: stageExecution.status");
    expect(explorerTreeViewSource).toContain("...sharedCommandResources");
    expect(explorerTreeViewSource).toContain(
      "resourceData={commandResourceData}",
    );
    expect(explorerTreeViewSource).toContain(
      "[MODEL_SCENE_PATH]: sceneResourceData",
    );
  });

  it("gives Study whole-cycle actions and pins stage actions to authored identity", () => {
    const root = buildStudyNodes({ stages: [
      { index: 0, kind: "relax", authoredStageId: "relax-b", stageId: "runtime-relax-b" },
      { index: 1, kind: "run", stageId: "generated-runtime-stage" },
    ] });
    expect(root.contextCommands).toContain("study.run");
    expect(root.contextCommands).not.toContain("study.execute-stage");
    const [relax, legacy] = root.children?.[0].children ?? [];
    expect(relax.contextCommands).toContain("study.execute-stage");
    expect(relax.contextCommandInputs).toMatchObject({
      "study.execute-stage": { stageId: "relax-b" },
      "study.remove-selected-stage": { stageId: "relax-b" },
      "study.skip": { stageId: "relax-b" },
    });
    expect(legacy.contextCommandInputs?.["study.execute-stage"]).toEqual({ stageId: null });
  });

  it("renders nonselectable semantic roots without selection affordances", () => {
    expect(explorerTreeViewSource).toContain(
      "const selectable = node.selectable !== false",
    );
    expect(explorerTreeViewSource).toContain(
      "aria-selected={selectable ? active : undefined}",
    );
    expect(explorerTreeViewSource).toContain(
      "onSelectNode={selectable ? handleSelect : undefined}",
    );
  });

  it("resolves context command state with node-provided command input", () => {
    const commands = new CommandRegistry();
    commands.register({
      id: "test.input-gated",
      title: "Input gated",
      group: "test",
      scope: "selection",
      isEnabled: (context) =>
        (context.input as { enabled?: boolean } | null)?.enabled === true,
      disabledReason: () => "Expected command input.",
      run: () => ({ status: "completed" }),
    });
    const kernel = {
      commands,
      visualizationDebug: new VisualizationDebugController(),
    } as unknown as KernelApi;
    const node: ExplorerNode = {
      contextCommands: ["test.input-gated"],
      contextCommandInputs: {
        "test.input-gated": { enabled: true },
      },
      id: "model:study:stages:stage:hysteresis-1:field-point:7:snapshot:hysteresis_point_007",
      kind: "study.stage.action",
      label: "Snapshot hysteresis_point_007",
      parentId: "model:study:stages:stage:hysteresis-1:field-point:7",
    };

    const items = contextCommandItemsForNode({
      kernel,
      node,
      resourceData: {},
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      disabled: false,
      disabledReason: "Expected command input.",
    });
  });

  it("resolves context command active state from the command registry", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }
    const kernel = {
      api: { commands: { submit: async () => ({ accepted: true }) } },
      commands,
      visualizationDebug: new VisualizationDebugController(),
    } as unknown as KernelApi;
    const node: ExplorerNode = {
      contextCommands: ["study.run"],
      id: "model:study",
      kind: "study.root",
      label: "Study",
      parentId: null,
    };

    const items = contextCommandItemsForNode({
      kernel,
      node,
      resourceData: {
        [MODEL_GEOMETRY_VALIDATION_PATH]: { diagnostics: [] },
        [SESSION_STATUS_RESOURCE_KEY]: {
          capabilities: {
            binary_fields: true,
            explicit_topology: false,
          },
          domain: {
            discretization: "fdm",
          },
          resources: {
            mesh_revision: 0,
            scene_revision: 1,
          },
        },
        [SIMULATION_COMMANDS_PATH]: {
          commands: [
            {
              command_id: "cmd-run",
              kind: "solve",
              status: "running",
            },
          ],
        },
        [SIMULATION_SOLVER_STATUS_PATH]: { runtime_state: "idle" },
        [SIMULATION_STAGES_EXECUTION_PATH]: {
          active_stage_index: null,
          revision: 1,
          runtime_state: "idle",
          stages: [],
        },
      },
    });

    expect(items.find((item) => item.command.id === "study.run")).toMatchObject({
      active: true,
      activeResource: expect.objectContaining({
        commandId: "cmd-run",
        kind: "command",
      }),
    });
  });

  it("keeps completed study stages addressable by status", () => {
    const rows = flattenVisibleExplorerRows(
      [
        {
          id: "model:study:stages:stage:stage-000",
          kind: "study.stage.relax",
          label: "Relax 1",
          parentId: "model:study:stages",
          status: "completed",
        },
      ],
      new Set(),
    );

    expect(rows[0]?.node).toMatchObject({
      id: "model:study:stages:stage:stage-000",
      status: "completed",
    });
  });

  it("styles completed explorer rows with the success token", () => {
    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readSource(fileURLToPath(explorerCssUrl));
    expect(css).toContain('.fm-explorer-tree-row[data-status="completed"]');
    expect(css).toContain("var(--fm-success)");
  });

  it("keeps result labels readable when the explorer is docked narrowly", () => {
    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readSource(fileURLToPath(explorerCssUrl));
    expect(css).toContain("display: flex;\n  flex-direction: column;");
    expect(css).toContain(".fm-explorer-tree {\n  flex: 1 1 auto;");
    expect(css).toContain("container-name: fm-explorer-panel");
    expect(css).toContain("@container fm-explorer-panel (max-width: 420px)");
    expect(css).toContain("grid-template-columns: var(--fm-space-4) var(--fm-icon-sm) minmax(0, 1fr) fit-content(38%)");
    expect(css).toContain(".fm-explorer-tree-row__metadata {\n  display: flex;\n  min-width: 0;");
    expect(css).toContain("@container fm-explorer-panel (max-width: 480px)");
    expect(css).toContain(".fm-explorer-tree-row__label {\n  min-width: 0;");
    expect(css.indexOf("/* Compact metadata keeps deep object/resource names readable in docked panels."))
      .toBeGreaterThan(css.indexOf("/* Active field badge */"));
    expect(explorerTreeViewSource).toContain('if (node.badge) tooltipParts.push(`— ${node.badge}`)');
    expect(explorerTreeViewSource).toContain('className="fm-explorer-node-tooltip">{tooltipParts.join(" ")}');
    expect(explorerTreeViewSource).toContain('aria-describedby={tooltipParts.length > 1 ? statusReasonId : undefined}');
  });

  it("keeps tree actions as named icons in the filter row instead of a footer row", () => {
    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readSource(fileURLToPath(explorerCssUrl));
    expect(css).toContain(".fm-explorer-filter-row {");
    expect(css).toContain("width: var(--fm-control-height-compact);");
    expect(explorerModuleSource).toContain('className="fm-explorer-filter-row"');
    expect(explorerModuleSource).not.toContain("<footer className=\"fm-explorer-toolbar\"");
    expect(explorerModuleSource).toContain('aria-label="Expand all explorer nodes"');
    expect(explorerModuleSource).toContain('aria-label="Collapse all explorer nodes"');
    expect(explorerModuleSource).toContain(
      'aria-label="Reset explorer filter and expand nodes"',
    );
  });

  it("renders active analysis fields as a separate explorer row state", () => {
    expect(explorerTreeViewSource).toContain(
      "fm-explorer-tree-row--active-analysis-field",
    );
    expect(explorerTreeViewSource).toContain(
      'data-active-analysis-field={node.activeAnalysisField ? "true" : undefined}',
    );
    expect(explorerTreeViewSource).toContain(
      'className="fm-explorer-tree-row__active-field"',
    );

    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readSource(fileURLToPath(explorerCssUrl));
    expect(css).toContain(".fm-explorer-tree-row--active-analysis-field");
    expect(css).toContain(".fm-explorer-tree-row__active-field");
  });

  it("maps explorer node statuses to explicit semantic CSS classes", () => {
    expect(explorerStatusClassName("completed")).toBe("fm-explorer-node--done");
    expect(explorerStatusClassName("running")).toBe("fm-explorer-node--active");
    expect(explorerStatusClassName("queued")).toBe("fm-explorer-node--muted");
    expect(explorerStatusClassName("skipped")).toBe("fm-explorer-node--muted");
    expect(explorerStatusClassName("unavailable")).toBe("fm-explorer-node--muted");
    expect(explorerStatusClassName("warning")).toBe("fm-explorer-node--warning");
    expect(explorerStatusClassName("failed")).toBe("fm-explorer-node--failed");

    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readSource(fileURLToPath(explorerCssUrl));
    expect(css).toContain(".fm-explorer-node--done");
    expect(css).toContain(".fm-explorer-node--active");
    expect(css).toContain(".fm-explorer-node--muted");
    expect(css).toContain(".fm-explorer-node--warning");
    expect(css).toContain(".fm-explorer-node--failed");
    expect(css).toContain('.fm-explorer-tree-row[data-status="unavailable"]');
  });
});
