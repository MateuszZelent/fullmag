import type { ScriptBuilderStageState } from "@/lib/session/types";
import type {
  MacroStageNode,
  MaterializedStageMapEntry,
  MaterializedStudyPipeline,
  PrimitiveStageNode,
  StudyPipelineDocument,
  StudyPipelineNode,
} from "./types";
import { validateStudyPipeline } from "./validate";

function toStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function primitivePayloadToStage(node: PrimitiveStageNode): ScriptBuilderStageState {
  const payload = node.payload;
  const integratorFallback = node.stage_kind === "relax" ? "auto" : "rk45";
  return {
    kind: toStringOr(payload.kind, node.stage_kind),
    entrypoint_kind: toStringOr(payload.entrypoint_kind, node.stage_kind),
    integrator: toStringOr(payload.integrator, integratorFallback),
    fixed_timestep: toStringOr(payload.fixed_timestep, ""),
    until_seconds: toStringOr(payload.until_seconds, ""),
    relax_algorithm: toStringOr(payload.relax_algorithm, "llg_overdamped"),
    torque_tolerance: toStringOr(payload.torque_tolerance, "1e-4"),
    energy_tolerance: toStringOr(payload.energy_tolerance, ""),
    max_steps: toStringOr(payload.max_steps, "5000"),
    eigen_count: toStringOr(payload.eigen_count, "10"),
    eigen_target: toStringOr(payload.eigen_target, "lowest"),
    eigen_include_demag: Boolean(payload.eigen_include_demag),
    eigen_equilibrium_source: toStringOr(payload.eigen_equilibrium_source, "relax"),
    eigen_normalization: toStringOr(payload.eigen_normalization, "unit_l2"),
    eigen_target_frequency: toStringOr(payload.eigen_target_frequency, ""),
    eigen_damping_policy: toStringOr(payload.eigen_damping_policy, "ignore"),
    eigen_k_vector: toStringOr(payload.eigen_k_vector, ""),
    eigen_spin_wave_bc: toStringOr(payload.eigen_spin_wave_bc, "free"),
    eigen_spin_wave_bc_config:
      payload.eigen_spin_wave_bc_config && typeof payload.eigen_spin_wave_bc_config === "object"
        ? (payload.eigen_spin_wave_bc_config as Record<string, unknown>)
        : null,
  };
}

function stage(kind: ScriptBuilderStageState["kind"], patch?: Partial<ScriptBuilderStageState>): ScriptBuilderStageState {
  const defaultIntegrator = kind === "relax" ? "auto" : "rk45";
  return {
    kind,
    entrypoint_kind: kind,
    integrator: defaultIntegrator,
    fixed_timestep: "",
    until_seconds: "",
    relax_algorithm: "llg_overdamped",
    torque_tolerance: "1e-4",
    energy_tolerance: "",
    max_steps: "5000",
    eigen_count: "10",
    eigen_target: "lowest",
    eigen_include_demag: false,
    eigen_equilibrium_source: "relax",
    eigen_normalization: "unit_l2",
    eigen_target_frequency: "",
    eigen_damping_policy: "ignore",
    eigen_k_vector: "",
    eigen_spin_wave_bc: "free",
    eigen_spin_wave_bc_config: null,
    ...patch,
  };
}

function expandMacro(node: MacroStageNode): ScriptBuilderStageState[] {
  if (node.macro_kind === "hysteresis_loop") {
    const steps = Math.max(2, Number(node.config.steps ?? 21));
    const relaxEach = node.config.relax_each !== false;
    const savePointState = Boolean(node.config.save_point_state);
    const expanded: ScriptBuilderStageState[] = [];
    for (let i = 0; i < steps; i += 1) {
      expanded.push(
        stage("run", {
          until_seconds: "1e-12",
          kind: "run",
          entrypoint_kind: "run",
        }),
      );
      if (relaxEach) {
        expanded.push(stage("relax"));
      }
      if (savePointState) {
        expanded.push(
          stage("save_state", {
            entrypoint_kind: "save_state",
          }),
        );
      }
    }
    return expanded;
  }
  if (node.macro_kind === "relax_run") {
    return [
      stage("relax"),
      stage("run", {
        until_seconds: toStringOr(node.config.run_until_seconds, "1e-9"),
      }),
    ];
  }
  if (node.macro_kind === "relax_eigenmodes") {
    return [
      stage("relax"),
      stage("eigenmodes", {
        eigen_count: toStringOr(node.config.eigen_count, "10"),
        eigen_include_demag: Boolean(node.config.eigen_include_demag ?? true),
      }),
    ];
  }
  if (node.macro_kind === "field_sweep_relax") {
    const steps = Math.max(1, Number(node.config.steps ?? 11));
    const relaxEach = node.config.relax_each !== false;
    const expanded: ScriptBuilderStageState[] = [];
    for (let i = 0; i < steps; i += 1) {
      expanded.push(
        stage("run", {
          until_seconds: "1e-12",
          kind: "run",
          entrypoint_kind: "run",
        }),
      );
      if (relaxEach) {
        expanded.push(stage("relax"));
      }
    }
    return expanded;
  }
  if (node.macro_kind === "field_sweep_relax_snapshot") {
    const steps = Math.max(1, Number(node.config.steps ?? 11));
    const relaxEach = node.config.relax_each !== false;
    const expanded: ScriptBuilderStageState[] = [];
    for (let i = 0; i < steps; i += 1) {
      expanded.push(
        stage("run", {
          until_seconds: "1e-12",
          kind: "run",
          entrypoint_kind: "run",
        }),
      );
      if (relaxEach) {
        expanded.push(stage("relax"));
      }
      expanded.push(
        stage("save_state", {
          entrypoint_kind: "save_state",
        }),
      );
    }
    return expanded;
  }
  if (node.macro_kind === "parameter_sweep") {
    const steps = Math.max(1, Number(node.config.steps ?? 11));
    const solveKind = String(node.config.solve_kind ?? "run_relax");
    const runEach = solveKind === "run" || solveKind === "run_relax" || solveKind === "relax_run";
    const relaxEach = solveKind === "relax" || solveKind === "run_relax" || solveKind === "relax_run";
    const savePointState = Boolean(node.config.save_point_state);
    const expanded: ScriptBuilderStageState[] = [];
    for (let i = 0; i < steps; i += 1) {
      if (runEach) {
        expanded.push(
          stage("run", {
            until_seconds: toStringOr(node.config.run_until_seconds, "1e-12"),
            kind: "run",
            entrypoint_kind: "run",
          }),
        );
      }
      if (relaxEach) {
        expanded.push(stage("relax"));
      }
      if (savePointState) {
        expanded.push(
          stage("save_state", {
            entrypoint_kind: "save_state",
          }),
        );
      }
    }
    return expanded;
  }
  return [stage("run", { until_seconds: "1e-12" })];
}

function walk(
  nodes: StudyPipelineNode[],
  stages: ScriptBuilderStageState[],
): MaterializedStageMapEntry[] {
  const map: MaterializedStageMapEntry[] = [];
  for (const node of nodes) {
    if (!node.enabled) {
      map.push({ nodeId: node.id, nodeLabel: node.label, stageIndexes: [] });
      continue;
    }
    const start = stages.length;
    if (node.node_kind === "primitive") {
      stages.push(primitivePayloadToStage(node));
      map.push({ nodeId: node.id, nodeLabel: node.label, stageIndexes: [start] });
      continue;
    }
    if (node.node_kind === "macro") {
      const expanded = expandMacro(node);
      stages.push(...expanded);
      map.push({
        nodeId: node.id,
        nodeLabel: node.label,
        stageIndexes: expanded.map((_, index) => start + index),
      });
      continue;
    }
    const childEntries = walk(node.children, stages);
    const flattened = childEntries.flatMap((entry) => entry.stageIndexes);
    map.push({
      nodeId: node.id,
      nodeLabel: node.label,
      stageIndexes: flattened,
      childEntries,
    });
  }
  return map;
}

export function materializeStudyPipeline(
  document: StudyPipelineDocument,
): MaterializedStudyPipeline {
  const stages: ScriptBuilderStageState[] = [];
  const map = walk(document.nodes, stages);
  const diagnostics = validateStudyPipeline(document);
  return { stages, map, diagnostics };
}
