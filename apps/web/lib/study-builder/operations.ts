import type {
  StudyMacroStageKind,
  StudyPipelineDocument,
  StudyPipelineNode,
  StudyPrimitiveStageKind,
} from "./types";

type InsertPosition = "before" | "after";

function nextNodeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
}

function cloneNode(node: StudyPipelineNode): StudyPipelineNode {
  const id = nextNodeId(node.node_kind);
  const label = `${node.label} (copy)`;
  const enabled = node.enabled;
  const notes = node.notes ?? null;
  if (node.node_kind === "primitive") {
    return {
      id,
      label,
      enabled,
      notes,
      node_kind: "primitive",
      stage_kind: node.stage_kind,
      payload: { ...node.payload },
    };
  }
  if (node.node_kind === "macro") {
    return {
      id,
      label,
      enabled,
      notes,
      node_kind: "macro",
      macro_kind: node.macro_kind,
      config: { ...node.config },
    };
  }
  if (node.node_kind === "group") {
    return {
      id,
      label,
      enabled,
      notes,
      node_kind: "group",
      collapsed: node.collapsed,
      children: node.children.map(cloneNode),
    };
  }
  return node;
}

function updateNodeRecursive(
  nodes: StudyPipelineNode[],
  nodeId: string,
  updater: (node: StudyPipelineNode) => StudyPipelineNode,
): StudyPipelineNode[] {
  return nodes.map((node) => {
    if (node.id === nodeId) {
      return updater(node);
    }
    if (node.node_kind === "group") {
      return {
        ...node,
        children: updateNodeRecursive(node.children, nodeId, updater),
      };
    }
    return node;
  });
}

function removeNodeRecursive(nodes: StudyPipelineNode[], nodeId: string): StudyPipelineNode[] {
  return nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => {
      if (node.node_kind !== "group") return node;
      return { ...node, children: removeNodeRecursive(node.children, nodeId) };
    });
}

function insertRelative(
  nodes: StudyPipelineNode[],
  anchorId: string,
  position: InsertPosition,
  newNode: StudyPipelineNode,
): StudyPipelineNode[] {
  const index = nodes.findIndex((node) => node.id === anchorId);
  if (index >= 0) {
    const target = position === "before" ? index : index + 1;
    const next = [...nodes];
    next.splice(target, 0, newNode);
    return next;
  }
  return nodes.map((node) => {
    if (node.node_kind !== "group") return node;
    return {
      ...node,
      children: insertRelative(node.children, anchorId, position, newNode),
    };
  });
}

function primitiveDefaults(kind: StudyPrimitiveStageKind): {
  label: string;
  payload: Record<string, unknown>;
} {
  switch (kind) {
    case "relax":
      return {
        label: "Relax",
        payload: {
          kind,
          entrypoint_kind: kind,
          integrator: "auto",
          relax_algorithm: "llg_overdamped",
          torque_tolerance: "1e-4",
          energy_tolerance: "",
          max_steps: "5000",
        },
      };
    case "run":
      return {
        label: "Run",
        payload: {
          kind,
          entrypoint_kind: kind,
          integrator: "rk45",
          fixed_timestep: "",
          until_seconds: "1e-9",
        },
      };
    case "eigenmodes":
      return {
        label: "Eigenmodes",
        payload: {
          kind,
          entrypoint_kind: kind,
          eigen_count: "10",
          eigen_target: "lowest",
          eigen_include_demag: true,
          eigen_equilibrium_source: "relax",
          eigen_normalization: "unit_l2",
          eigen_target_frequency: "",
          eigen_damping_policy: "ignore",
          eigen_k_vector: "",
          eigen_spin_wave_bc: "free",
          eigen_spin_wave_bc_config: null,
        },
      };
    case "set_field":
      return {
        label: "Set Field",
        payload: {
          kind,
          entrypoint_kind: kind,
          axis: "z",
          field_mT: "50",
        },
      };
    case "set_current":
      return {
        label: "Set Current",
        payload: {
          kind,
          entrypoint_kind: kind,
          current_density: "1e10",
          direction: "x",
        },
      };
    case "save_state":
      return {
        label: "Save State",
        payload: {
          kind,
          entrypoint_kind: kind,
          artifact_name: "state_snapshot",
        },
      };
    case "load_state":
      return {
        label: "Load State",
        payload: {
          kind,
          entrypoint_kind: kind,
          artifact_name: "state_snapshot",
        },
      };
    case "export":
      return {
        label: "Export",
        payload: {
          kind,
          entrypoint_kind: kind,
          quantity: "magnetization",
          format: "json",
        },
      };
  }
}

export function createPrimitiveNode(kind: StudyPrimitiveStageKind): StudyPipelineNode {
  const defaults = primitiveDefaults(kind);
  return {
    id: nextNodeId(kind),
    label: defaults.label,
    enabled: true,
    source: "ui_authored",
    node_kind: "primitive",
    stage_kind: kind,
    payload: defaults.payload,
  };
}

export function createMacroNode(
  kind: StudyMacroStageKind,
): StudyPipelineNode {
  const label =
    kind === "hysteresis_loop"
      ? "Hysteresis Loop"
      : kind === "field_sweep_relax"
        ? "Field Sweep + Relax"
        : kind === "field_sweep_relax_snapshot"
          ? "Field Sweep + Relax + Snapshot"
        : kind === "parameter_sweep"
          ? "Parameter Sweep"
        : kind === "current_sweep_run"
          ? "Current Sweep + Run"
        : kind === "dc_bias_plus_rf_probe"
          ? "DC Bias + RF Probe"
        : kind === "relax_run"
          ? "Relax -> Run"
          : "Relax -> Eigenmodes";
  return {
    id: nextNodeId(kind),
    label,
    enabled: true,
    source: "ui_authored",
    node_kind: "macro",
    macro_kind: kind,
    config:
      kind === "hysteresis_loop"
        ? {
            quantity: "b_ext",
            axis: "z",
            start_mT: -100,
            stop_mT: 100,
            steps: 21,
            relax_each: true,
            save_point_state: false,
          }
        : kind === "field_sweep_relax_snapshot"
          ? {
              start_mT: -100,
              stop_mT: 100,
              steps: 11,
              axis: "z",
              relax_each: true,
              save_point_state: true,
            }
        : kind === "parameter_sweep"
            ? {
                parameter: "b_ext",
                axis: "z",
                start_mT: -100,
                stop_mT: 100,
                steps: 11,
                solve_kind: "run_relax",
                run_until_seconds: "1e-12",
                save_point_state: false,
              }
        : kind === "current_sweep_run"
          ? {
              parameter: "current_density",
              direction: "x",
              start: "1e9",
              stop: "2e11",
              steps: 11,
              run_until_seconds: "1e-9",
              save_point_state: false,
            }
        : kind === "dc_bias_plus_rf_probe"
          ? {
              dc_field_mT: 30,
              rf_current_a: 0.01,
              rf_frequency_hz: 5e9,
              run_until_seconds: "1e-9",
              export_psd: true,
            }
        : kind === "field_sweep_relax"
          ? { start_mT: -100, stop_mT: 100, steps: 11, axis: "z", relax_each: true }
          : kind === "relax_run"
            ? { run_until_seconds: "1e-9" }
            : { eigen_count: "10", eigen_include_demag: true },
  };
}

export function appendNode(document: StudyPipelineDocument, node: StudyPipelineNode): StudyPipelineDocument {
  return { ...document, nodes: [...document.nodes, node] };
}

export function insertNodeNear(
  document: StudyPipelineDocument,
  anchorId: string,
  position: InsertPosition,
  node: StudyPipelineNode,
): StudyPipelineDocument {
  return {
    ...document,
    nodes: insertRelative(document.nodes, anchorId, position, node),
  };
}

export function deleteNode(document: StudyPipelineDocument, nodeId: string): StudyPipelineDocument {
  return {
    ...document,
    nodes: removeNodeRecursive(document.nodes, nodeId),
  };
}

export function duplicateNode(document: StudyPipelineDocument, nodeId: string): StudyPipelineDocument {
  const node = findNodeById(document.nodes, nodeId);
  if (!node) return document;
  return insertNodeNear(document, nodeId, "after", cloneNode(node));
}

export function toggleNodeEnabled(document: StudyPipelineDocument, nodeId: string): StudyPipelineDocument {
  return {
    ...document,
    nodes: updateNodeRecursive(document.nodes, nodeId, (node) => ({
      ...node,
      enabled: !node.enabled,
    })),
  };
}

export function patchNode(
  document: StudyPipelineDocument,
  nodeId: string,
  patch: Partial<Pick<StudyPipelineNode, "label" | "enabled" | "notes">>,
): StudyPipelineDocument {
  return {
    ...document,
    nodes: updateNodeRecursive(document.nodes, nodeId, (node) => ({
      ...node,
      ...patch,
    })),
  };
}

export function patchNodeConfig(
  document: StudyPipelineDocument,
  nodeId: string,
  patch: Record<string, unknown>,
): StudyPipelineDocument {
  return {
    ...document,
    nodes: updateNodeRecursive(document.nodes, nodeId, (node) => {
      if (node.node_kind === "macro") {
        return { ...node, config: { ...node.config, ...patch } };
      }
      if (node.node_kind === "primitive") {
        return { ...node, payload: { ...node.payload, ...patch } };
      }
      return node;
    }),
  };
}

export function findNodeById(nodes: StudyPipelineNode[], nodeId: string): StudyPipelineNode | null {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    if (node.node_kind === "group") {
      const child = findNodeById(node.children, nodeId);
      if (child) return child;
    }
  }
  return null;
}
