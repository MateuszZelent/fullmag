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

import type { ExplorerNode } from "./explorerTypes";
import {
  contextCommandItemsForNode,
  flattenVisibleExplorerRows,
  resolveExplorerFocusableRowId,
  resolveExplorerKeyboardTargetRowId,
  sliceVisibleExplorerRows,
} from "./ExplorerTreeView";

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

  it("resolves context command active state from the command registry", () => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) {
      commands.register(command);
    }
    const kernel = {
      api: { commands: { submit: async () => ({ accepted: true }) } },
      commands,
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
});
