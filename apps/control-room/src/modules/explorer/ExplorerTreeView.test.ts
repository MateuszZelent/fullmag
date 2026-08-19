import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MODEL_GEOMETRY_VALIDATION_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "@/kernel/api/apiPaths";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";
import type { KernelApi } from "@/kernel/types";
import { VisualizationDebugController } from "@/kernel/visualization/VisualizationDebugController";

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

const explorerTreeViewSource = readFileSync(
  fileURLToPath(import.meta.resolve("./ExplorerTreeView.tsx")),
  "utf8",
);
const explorerModuleSource = readFileSync(
  fileURLToPath(import.meta.resolve("./ExplorerModule.tsx")),
  "utf8",
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

  it("keeps context-menu runtime resources off mesh readiness and stage execution", () => {
    expect(explorerTreeViewSource).toContain(
      "useRuntimeCommandControlResourceData({",
    );
    expect(explorerTreeViewSource).toContain(
      "includeSharedDomainReadiness: false",
    );
    expect(explorerTreeViewSource).toContain("includeStageExecution: false");
    expect(explorerTreeViewSource).toContain(
      "resourceData={runtimeResourceData}",
    );
  });

  it("renders nonselectable semantic roots without selection affordances", () => {
    expect(explorerTreeViewSource).toContain(
      "const selectable = node.selectable !== false",
    );
    expect(explorerTreeViewSource).toContain(
      "aria-selected={selectable ? active : undefined}",
    );
    expect(explorerTreeViewSource).toContain(
      "{selectable ? <ContextMenuItem onSelect={handleSelect}>Select</ContextMenuItem> : null}",
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
    const css = readFileSync(fileURLToPath(explorerCssUrl), "utf8");
    expect(css).toContain('.fm-explorer-tree-row[data-status="completed"]');
    expect(css).toContain("var(--fm-success)");
  });

  it("keeps result labels readable when the explorer is docked narrowly", () => {
    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readFileSync(fileURLToPath(explorerCssUrl), "utf8");
    expect(css).toContain("display: flex;\n  flex-direction: column;");
    expect(css).toContain(".fm-explorer-tree {\n  flex: 1 1 auto;");
    expect(css).toContain("container-name: fm-explorer-panel");
    expect(css).toContain("@container fm-explorer-panel (max-width: 360px)");
    expect(css).toContain("grid-template-columns: var(--fm-space-4) var(--fm-icon-sm) minmax(0, 1fr) auto auto auto");
    expect(css).toContain("width: max-content;");
    expect(css).toContain(".fm-explorer-tree-row__label {\n  min-width: 0;");
    expect(css.indexOf("/* The explorer is frequently docked below 360px."))
      .toBeGreaterThan(css.indexOf("/* Active field badge */"));
    expect(explorerTreeViewSource).toContain('title={node.badge}');
  });

  it("keeps the narrow explorer toolbar usable without removing button names", () => {
    const explorerCssUrl = new URL("../../design/styles/explorer.css", import.meta.url);
    const css = readFileSync(fileURLToPath(explorerCssUrl), "utf8");
    expect(css).toContain("@container fm-explorer-panel (max-width: 360px)");
    expect(css).toContain(".fm-explorer-toolbar__action > span");
    expect(css).toContain("width: var(--fm-control-height-compact);");
    expect(explorerModuleSource).toContain('aria-label="Expand all explorer nodes"');
    expect(explorerModuleSource).toContain('aria-label="Collapse all explorer nodes"');
    expect(explorerModuleSource).toContain('aria-label="Refresh explorer"');
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
    const css = readFileSync(fileURLToPath(explorerCssUrl), "utf8");
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
    const css = readFileSync(fileURLToPath(explorerCssUrl), "utf8");
    expect(css).toContain(".fm-explorer-node--done");
    expect(css).toContain(".fm-explorer-node--active");
    expect(css).toContain(".fm-explorer-node--muted");
    expect(css).toContain(".fm-explorer-node--warning");
    expect(css).toContain(".fm-explorer-node--failed");
    expect(css).toContain('.fm-explorer-tree-row[data-status="unavailable"]');
  });
});
