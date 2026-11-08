import type { ModelReadinessResource, RuntimeStageInitialStateRequest } from "../api/apiTypes";
import type { ControlRoomApi } from "../api/ControlRoomApi";

type StageResultInitialState = Extract<RuntimeStageInitialStateRequest, { kind: "stage_result" }>;

type AuthoredInitialState = Extract<RuntimeStageInitialStateRequest, { kind: "authored_initial_state" }>;
export type PreparedStageInitialState = Extract<AuthoredInitialState["source"], { kind: "prepared" }>;

export type StageInitialStateChoice =
  | { kind: "default_for_target" }
  | { kind: "authored_study" }
  | { kind: "authored_stage" }
  | { kind: "latest_compatible_state" }
  | PreparedStageInitialState
  | StageResultInitialState;

export interface AuthoredStageCommandInput {
  stageId: string;
  initialState?: StageInitialStateChoice;
}

interface PinnedStageChoice {
  sceneRevision: number;
  choice: StageInitialStateChoice;
}

const stageChoices = new WeakMap<ControlRoomApi, {
  scope: string;
  stages: Map<string, PinnedStageChoice>;
}>();

export function getStageInitialStateChoice(
  api: ControlRoomApi,
  scope: string | null | undefined,
  stageId: string,
): PinnedStageChoice | undefined {
  const workspace = stageChoices.get(api);
  return workspace && workspace.scope === scope
    ? workspace.stages.get(stageId)
    : undefined;
}

export function setStageInitialStateChoice(
  api: ControlRoomApi,
  scope: string,
  stageId: string,
  sceneRevision: number,
  choice: StageInitialStateChoice,
): void {
  let workspace = stageChoices.get(api);
  if (!workspace || workspace.scope !== scope) {
    workspace = { scope, stages: new Map() };
    stageChoices.set(api, workspace);
  }
  if (choice.kind === "default_for_target") {
    workspace.stages.delete(stageId);
  } else {
    workspace.stages.set(stageId, { sceneRevision, choice: structuredClone(choice) });
  }
}

export function preparedStageInitialStateChoice(
  readiness: Pick<ModelReadinessResource, "scene_revision" | "prepared_initial_state"> | null | undefined,
  sceneRevision: number | null,
): PreparedStageInitialState | null {
  if (sceneRevision === null || readiness?.scene_revision !== sceneRevision ||
      !readiness.prepared_initial_state) return null;
  return preparedChoice(readiness.prepared_initial_state, sceneRevision);
}

export function matchesPreparedStageInitialState(
  choice: PreparedStageInitialState,
  current: PreparedStageInitialState | null,
): boolean {
  return current?.scene_revision === choice.scene_revision &&
    current.initial_state_revision === choice.initial_state_revision &&
    current.publication_id === choice.publication_id;
}

function preparedChoice(
  value: { scene_revision?: unknown; initial_state_revision?: unknown; publication_id?: unknown },
  sceneRevision: number,
): PreparedStageInitialState | null {
  const { scene_revision, initial_state_revision, publication_id } = value;
  if (scene_revision !== sceneRevision || typeof initial_state_revision !== "number" ||
      !Number.isSafeInteger(initial_state_revision) || initial_state_revision < 0 ||
      !nonEmptyId(publication_id) || publication_id.length > 256) return null;
  return { kind: "prepared", scene_revision, initial_state_revision, publication_id };
}

export function stageInitialStateRequest(
  choice: unknown,
  stageId: string,
  sceneRevision: number,
): RuntimeStageInitialStateRequest | null {
  if (choice === undefined) return { kind: "default_for_target" };
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return null;
  const value = choice as Record<string, unknown>;
  switch (value.kind) {
    case "default_for_target":
      return { kind: "default_for_target" };
    case "authored_study":
      return { kind: "authored_initial_state", source: { kind: "study", scene_revision: sceneRevision } };
    case "authored_stage":
      return { kind: "authored_initial_state", source: { kind: "stage", scene_revision: sceneRevision, stage_id: stageId } };
    case "prepared": {
      const source = preparedChoice(value, sceneRevision);
      return source ? { kind: "authored_initial_state", source } : null;
    }
    case "latest_compatible_state":
      return { kind: "latest_compatible_state" };
    case "stage_result": {
      const { run_id, step_id, case_id, artifact_id, content_sha256, allow_stale_model } = value;
      if (!nonEmptyId(run_id) || !nonEmptyId(step_id) || !nonEmptyId(case_id) || !nonEmptyId(artifact_id) ||
          typeof content_sha256 !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/.test(content_sha256) ||
          (allow_stale_model !== undefined && typeof allow_stale_model !== "boolean")) {
        return null;
      }
      return {
        kind: "stage_result", run_id, step_id, case_id, artifact_id, content_sha256,
        ...(allow_stale_model === undefined ? {} : { allow_stale_model }),
      };
    }
    default:
      return null;
  }
}

function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}
