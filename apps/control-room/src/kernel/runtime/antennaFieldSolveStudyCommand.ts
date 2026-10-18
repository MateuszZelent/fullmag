import type { JsonObject, SceneResource } from "../api/apiTypes";
import { readStudyStageSource } from "../../shared/domain/study/studyStageSource";
import { antennaFieldSolveDefinitionPortError } from "../../shared/domain/study/antennaFieldSolveCapability";
import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "../api/apiPaths";
import { runAuthoringMutationWithHistory } from "../authoring/authoringHistoryMutation";
import { obsoleteSessionResult } from "../commands/commandSessionScope";
import type { CommandContext, CommandContribution, CommandResult } from "../commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

export const ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND = "study.add-antenna-field-solve-stage";

interface AntennaSolveTarget { objectId: string; stageId: string; portModeId?: string }

function solveTarget(context: CommandContext): AntennaSolveTarget | null {
  if (context.input !== undefined) {
    if (!context.input || typeof context.input !== "object") return null;
    const input = context.input as Record<string, unknown>;
    if (input.portModeId !== undefined && (typeof input.portModeId !== "string" || !input.portModeId.trim())) return null;
    return typeof input.objectId === "string" && input.objectId.trim()
      && typeof input.stageId === "string" && input.stageId.trim()
      ? { objectId: input.objectId, stageId: input.stageId, ...(input.portModeId === undefined ? {} : { portModeId: input.portModeId as string }) } : null;
  }
  const ref = context.selection?.get()?.ref;
  return ref?.type === "scene-object" && ref.kind === "object.antenna.solution"
    && ref.antennaResourceId
    ? { objectId: ref.objectId, stageId: ref.antennaResourceId } : null;
}

/** Build a reference instruction, not a copy or a physical-readiness certificate. */
export function antennaFieldSolveStudyStages(
  scene: SceneResource,
  target: AntennaSolveTarget,
): { stages: JsonObject[]; alreadyAdded: boolean; existingStageEnabled?: boolean; studyPipeline?: JsonObject } {
  if ((scene.objects ?? []).filter((object) => object.id === target.objectId).length !== 1) {
    throw new Error("The antenna source object is missing or ambiguous.");
  }
  const definitions = (scene.antenna_field_solve_stages ?? []).filter((stage) => stage.id === target.stageId);
  if (definitions.length !== 1 || definitions[0].source_object_id !== target.objectId) {
    throw new Error("The field-solve definition is missing, ambiguous, or owned by another object.");
  }
  const definition = definitions[0];
  const capabilityError = antennaFieldSolveDefinitionPortError(definition.port_mode_ids);
  if (capabilityError) throw new Error(capabilityError);
  const portModeId = target.portModeId ?? (definition.port_mode_ids.length === 1 ? definition.port_mode_ids[0] : undefined);
  if (!portModeId?.trim() || definition.port_mode_ids.filter((id) => id === portModeId).length !== 1) {
    throw new Error("Field solve requires exactly one explicit port mode from its definition. Select it in the antenna Inspector; no stages were changed.");
  }
  for (const portId of definition.port_mode_ids) {
    const ports = (scene.antenna_port_modes ?? []).filter((port) => port.id === portId);
    if (ports.length !== 1 || ports[0].source_object_id !== target.objectId
      || ports[0].current_transport_id !== definition.current_transport_id) {
      throw new Error("The field-solve port reference is missing, ambiguous, or owned by another source/transport.");
    }
  }
  const rawStages = scene.study?.stages ?? [];
  const source = readStudyStageSource(scene.study);
  if (source.kind === "invalid") throw new Error(source.error ?? "The study pipeline is malformed.");
  if (source.kind === "flat" && (!Array.isArray(rawStages)
    || rawStages.some((stage) => !stage || typeof stage !== "object" || Array.isArray(stage)))) {
    throw new Error("The study pipeline is malformed; refresh or repair it before adding a stage.");
  }
  const stages = Array.isArray(rawStages) ? rawStages as JsonObject[] : [];
  const matches = source.kind === "flat" ? stages.filter((stage) => stage.stage_id === definition.id) : [];
  const action: JsonObject = {
    kind: "antenna_field_solve",
    entrypoint_kind: "flat_antenna_field_solve",
    stage_id: definition.id,
    port_mode_ids: [portModeId],
  };
  const pipeline = scene.study?.study_pipeline;
  if (pipeline !== undefined && pipeline !== null) {
    if (typeof pipeline !== "object" || Array.isArray(pipeline)) throw new Error("The study pipeline is malformed.");
    const document = pipeline as JsonObject;
    const documentNodes = document.nodes === undefined ? [] : document.nodes as JsonObject[];
    const nodes: JsonObject[] = [];
    const visit = (children: unknown): void => {
      if (!Array.isArray(children)) throw new Error("The study pipeline children are malformed.");
      for (const child of children) {
        if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("The study pipeline node is malformed.");
        const node = child as JsonObject;
        if (typeof node.id !== "string" || !node.id.trim() || nodes.some((previous) => previous.id === node.id)) {
          throw new Error("The study pipeline node ID is missing or ambiguous.");
        }
        nodes.push(node);
        if (node.node_kind === "group") visit(node.children === undefined ? [] : node.children);
        else if (node.node_kind !== "primitive" && node.node_kind !== "macro") throw new Error("The study pipeline node kind is unsupported.");
        if (node.node_kind === "primitive" && node.stage_kind === "antenna_field_solve"
          && (!node.payload || typeof node.payload !== "object" || Array.isArray(node.payload)
            || typeof node.payload.stage_id !== "string" || !node.payload.stage_id.trim())) {
          throw new Error("An existing antenna pipeline node has no explicit definition reference.");
        }
      }
    };
    visit(documentNodes);
    const references = nodes.filter((node) => node.node_kind === "primitive"
      && node.stage_kind === "antenna_field_solve"
      && node.payload && typeof node.payload === "object" && !Array.isArray(node.payload)
      && node.payload.stage_id === definition.id);
    if (references.length > 0) {
      const payload = references[0].payload as JsonObject;
      if (references.length !== 1 || payload.kind !== action.kind
        || payload.entrypoint_kind !== action.entrypoint_kind
        || !Array.isArray(payload.port_mode_ids)
        || payload.port_mode_ids.length !== 1 || payload.port_mode_ids[0] !== portModeId) {
        throw new Error("The study already contains a conflicting antenna reference; no stages were changed.");
      }
      const entry = source.entries.find((candidate) => candidate.queueId === references[0].id);
      return { stages, alreadyAdded: true, existingStageEnabled: entry?.enabled === true };
    }
    const nodeId = `antenna-field-solve:${encodeURIComponent(definition.id)}`;
    if (nodes.some((node) => node.id === nodeId)) throw new Error("The study already contains a conflicting pipeline node ID.");
    return {
      stages, alreadyAdded: false,
      studyPipeline: { ...document, nodes: [...documentNodes, {
        id: nodeId, label: `Field solve ${definition.id}`, enabled: true,
        source: "ui_authored", node_kind: "primitive", stage_kind: "antenna_field_solve", payload: action,
      }] },
    };
  }
  if (matches.length > 0) {
    const existing = matches[0];
    if (matches.length !== 1 || existing.kind !== action.kind
      || existing.entrypoint_kind !== action.entrypoint_kind
      || !Array.isArray(existing.port_mode_ids)
      || existing.port_mode_ids.length !== 1 || existing.port_mode_ids[0] !== portModeId) {
      throw new Error("The study already contains a conflicting stage ID; no stages were changed.");
    }
    return { stages, alreadyAdded: true };
  }
  return { stages: [...stages, action], alreadyAdded: false };
}

export type AntennaStudyReference =
  | { state: "missing" }
  | { state: "invalid"; message: string }
  | { state: "present"; queueId: string; index: number; enabled: boolean };

/** Resolve navigation through the same reference/conflict checks as the add command. */
export function antennaFieldSolveStudyReference(scene: SceneResource, target: AntennaSolveTarget): AntennaStudyReference {
  try {
    const plan = antennaFieldSolveStudyStages(scene, target);
    if (!plan.alreadyAdded) return { state: "missing" };
    const source = readStudyStageSource(scene.study);
    const matches = source.entries.flatMap((entry, index) =>
      (entry.stageKind ?? entry.payload.kind) === "antenna_field_solve" && entry.payload.stage_id === target.stageId
        ? [{ entry, index }] : []);
    if (matches.length !== 1) return { state: "invalid", message: "The Study reference is missing or ambiguous; no execution is selected." };
    const { entry, index } = matches[0];
    return { state: "present", queueId: entry.queueId ?? String(entry.payload.stage_id ?? entry.payload.id ?? index),
      index, enabled: entry.enabled };
  } catch (error) {
    return { state: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}

export const addAntennaFieldSolveStudyCommand: CommandContribution = {
  id: ADD_ANTENNA_FIELD_SOLVE_STAGE_COMMAND,
  title: "Add Field Solve to Study",
  category: "Study",
  group: "study-authoring",
  scope: "selection",
  isEnabled: (context) => Boolean(context.api && solveTarget(context)),
  disabledReason: (context) => !context.api ? "Control-room API is unavailable."
    : !solveTarget(context) ? "Select an antenna field-solve definition." : null,
  run: async (context) => {
    const target = solveTarget(context);
    if (!context.api || !target) return { status: "failed", message: "Select an antenna field-solve definition with a source object." };
    const obsolete = obsoleteSessionResult(context);
    if (obsolete) return obsolete;
    const options = context.sessionScopeKey ? { sessionScopeKey: context.sessionScopeKey } : undefined;
    let historyScene: SceneResource | null = null;
    return runAuthoringMutationWithHistory<CommandResult>(context, "Add antenna field solve to Study", async (preparation) => {
      const scene = preparation.before ?? await context.api!.model.scene(options);
      historyScene = scene;
      const obsoleteAfterRead = obsoleteSessionResult(context);
      if (obsoleteAfterRead) return obsoleteAfterRead;
      const revision = scene.scene_revision ?? scene.revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        return { status: "failed", message: "Scene revision is unavailable; refresh the scene and retry." };
      }
      const next = antennaFieldSolveStudyStages(scene, target);
      if (next.alreadyAdded) return { status: "completed", message: next.existingStageEnabled === false
        ? "Field solve is already in Study, but the stage or an ancestor group is disabled. Enable it explicitly in Study to execute it; no stages changed."
        : "Field solve is already in Study; no stages changed." };
      const response = await context.api!.model.commitTransaction({
        kind: "merge_patch", base_revision: revision,
        merge_patch: { study: next.studyPipeline ? { study_pipeline: next.studyPipeline } : { stages: next.stages } },
      }, options);
      historyScene = response.committed_scene;
      const obsoleteAfterWrite = obsoleteSessionResult(context);
      if (obsoleteAfterWrite) return obsoleteAfterWrite;
      for (const path of [MODEL_SCENE_PATH, MODEL_STUDY_PATH, MODEL_READINESS_PATH, SIMULATION_STAGES_EXECUTION_PATH, SESSION_STATUS_RESOURCE_KEY]) {
        context.resources?.invalidate(path, response.scene_revision);
      }
      return { status: "completed", message: "Field-solve reference added to Study. Preparation and physical validation are still required." };
    }, () => historyScene);
  },
};
