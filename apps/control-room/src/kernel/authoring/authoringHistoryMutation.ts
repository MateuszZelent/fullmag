import type { SceneResource } from "../api/apiTypes";
import { MODEL_SCENE_PATH } from "../api/apiPaths";
import type { CommandContext } from "../commands/commandTypes";
import { assertCurrentSessionScope } from "../commands/commandSessionScope";
import type { AuthoringHistoryWorkspaceState } from "./AuthoringHistoryController";

type AuthoringHistoryMutationContext = Pick<
  CommandContext,
  "api" | "authoringHistory" | "resourceData" | "selection"
> & {
  sessionScopeKey?: string | null;
  isCurrentSessionScope?: () => boolean;
};

/**
 * Capture the active session and history generation for an immediate authoring
 * mutation. Callers must build the source context with createCommandContext so
 * this fence can recheck the same session after each await.
 */
export function captureAuthoringMutationFence(
  context: CommandContext,
): CommandContext {
  const sessionScopeKey = context.sessionScopeKey ?? null;
  const historyGeneration = context.authoringHistory?.getGeneration?.();
  return {
    ...context,
    sessionScopeKey,
    isCurrentSessionScope: () =>
      Boolean(sessionScopeKey) &&
      context.isCurrentSessionScope?.() === true &&
      (historyGeneration === undefined ||
        context.authoringHistory?.getGeneration?.() === historyGeneration),
  };
}

export interface AuthoringMutationPreparation {
  before: SceneResource | null;
  beforeWorkspaceState?: AuthoringHistoryWorkspaceState | null;
  baseRevision: number | null;
  historyGeneration?: number;
}

export type AuthoringMutationSceneResolver<T> = (
  result: T,
) => SceneResource | null | Promise<SceneResource | null>;

export interface RunAuthoringMutationWithHistoryOptions {
  /** Capture UI state changed by the mutation itself after its successful ACK. */
  captureWorkspaceStateAfter?: boolean | ((result: unknown) => boolean);
}

export function authoringWriteOptions(
  baseRevision: number | null | undefined,
  sessionScopeKey?: string | null,
): { baseRevision?: number; sessionScopeKey?: string } | undefined {
  const options: { baseRevision?: number; sessionScopeKey?: string } = {};
  if (typeof baseRevision === "number" && Number.isFinite(baseRevision)) {
    options.baseRevision = baseRevision;
  }
  if (sessionScopeKey) {
    options.sessionScopeKey = sessionScopeKey;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sceneRevision(scene: SceneResource | null): number | null {
  const record = asRecord(scene);
  if (!record) return null;
  const revision = record.scene_revision ?? record.revision;
  return typeof revision === "number" && Number.isFinite(revision)
    ? revision
    : null;
}

export function captureAuthoringHistoryWorkspaceState(
  context: AuthoringHistoryMutationContext,
): AuthoringHistoryWorkspaceState | null {
  if (!context.selection) return null;
  const selection = context.selection?.get() ?? null;
  return {
    selection: selection ? structuredClone(selection) : null,
  };
}

function sceneFromMutationResult(value: unknown): SceneResource | null {
  const record = asRecord(value);
  if (!record) return null;

  const committedScene = asRecord(record.committed_scene);
  if (committedScene) return committedScene as SceneResource;

  const looksLikeScene =
    record.objects !== undefined ||
    record.scene !== undefined ||
    record.universe !== undefined ||
    record.materials !== undefined;
  return !looksLikeScene || sceneRevision(record as SceneResource) === null
    ? null
    : (record as SceneResource);
}

/**
 * Read the authoritative scene only when a history controller is attached.
 * A read failure must not prevent the requested mutation from being sent.
 */
export async function captureAuthoringHistoryScene(
  context: AuthoringHistoryMutationContext,
): Promise<SceneResource | null> {
  if (!context.authoringHistory || !context.api) return null;

  try {
    const options = context.sessionScopeKey
      ? { sessionScopeKey: context.sessionScopeKey }
      : undefined;
    const scene = await context.api.model.scene(options);
    if (sceneRevision(scene) !== null) return scene;
  } catch {
    // Fall through to the last resource snapshot when the read is transient.
  }

  const cachedScene = context.resourceData?.[MODEL_SCENE_PATH];
  return sceneRevision(asRecord(cachedScene) as SceneResource | null) === null
    ? null
    : (cachedScene as SceneResource);
}

export async function prepareAuthoringMutation(
  context: AuthoringHistoryMutationContext,
): Promise<AuthoringMutationPreparation> {
  const historyGeneration = context.authoringHistory?.getGeneration?.();
  const before = await captureAuthoringHistoryScene(context);
  return {
    before,
    beforeWorkspaceState: captureAuthoringHistoryWorkspaceState(context),
    baseRevision: sceneRevision(before),
    historyGeneration,
  };
}

/**
 * Record the scene transition belonging to a prepared authoring mutation.
 * Callers that own a multi-step mutation can use this after a successful
 * commit or after a partial ACK so that an already-persisted change is never
 * hidden from semantic history.
 */
export async function recordAuthoringMutationHistory(
  context: AuthoringHistoryMutationContext,
  label: string,
  preparation: AuthoringMutationPreparation,
  committedScene?: SceneResource | null,
  workspaceStateAfter?: AuthoringHistoryWorkspaceState | null,
): Promise<void> {
  const history = context.authoringHistory;
  if (!history || !preparation.before) return;
  const isCurrentGeneration = () =>
    context.isCurrentSessionScope?.() !== false &&
    (preparation.historyGeneration === undefined ||
      history.getGeneration?.() === preparation.historyGeneration);
  if (!isCurrentGeneration()) return;

  let after = committedScene ?? null;
  if (sceneRevision(after) === null) {
    after = await captureAuthoringHistoryScene(context);
  }
  if (!isCurrentGeneration()) return;

  const beforeRevision = preparation.baseRevision;
  const afterRevision = sceneRevision(after);
  if (
    !after ||
    beforeRevision === null ||
    afterRevision === null ||
    afterRevision <= beforeRevision
  ) {
    return;
  }

  try {
    const beforeWorkspaceState = preparation.beforeWorkspaceState;
    const afterWorkspaceState = workspaceStateAfter === undefined
      ? preparation.beforeWorkspaceState ?? null
      : workspaceStateAfter;
    history.record({
      after,
      ...(afterWorkspaceState ? { afterWorkspaceState } : {}),
      before: preparation.before,
      ...(beforeWorkspaceState ? { beforeWorkspaceState } : {}),
      committedRevision: afterRevision,
      label,
    });
  } catch {
    // History is an observability layer; a valid authoring ACK must survive a
    // malformed or unavailable local history snapshot.
  }
}

/**
 * Execute an immediate authoring mutation and record one semantic history
 * entry when the authoritative scene revision advances. The mutation remains
 * successful when scene capture or history recording is unavailable.
 */
export async function runAuthoringMutationWithHistory<T>(
  context: AuthoringHistoryMutationContext,
  label: string,
  mutation: (preparation: AuthoringMutationPreparation) => Promise<T>,
  resolveAfter?: AuthoringMutationSceneResolver<T>,
  options: RunAuthoringMutationWithHistoryOptions = {},
): Promise<T> {
  assertCurrentSessionScope(context);
  const preparation = await prepareAuthoringMutation(context);
  assertCurrentSessionScope(context);
  const result = await mutation(preparation);
  if (context.isCurrentSessionScope?.() === false) return result;
  const captureAfter = typeof options.captureWorkspaceStateAfter === "function"
    ? options.captureWorkspaceStateAfter(result)
    : options.captureWorkspaceStateAfter === true;
  const workspaceStateAfter = captureAfter
    ? captureAuthoringHistoryWorkspaceState(context)
    : preparation.beforeWorkspaceState ?? null;
  const after = resolveAfter
    ? await resolveAfter(result)
    : sceneFromMutationResult(result);
  await recordAuthoringMutationHistory(
    context,
    label,
    preparation,
    after,
    workspaceStateAfter,
  );
  return result;
}
