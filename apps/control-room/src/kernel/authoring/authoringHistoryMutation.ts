import type { SceneResource } from "../api/apiTypes";
import { MODEL_SCENE_PATH } from "../api/apiPaths";
import type { CommandContext } from "../commands/commandTypes";

type AuthoringHistoryMutationContext = Pick<
  CommandContext,
  "api" | "authoringHistory" | "resourceData"
>;

export interface AuthoringMutationPreparation {
  before: SceneResource | null;
  baseRevision: number | null;
}

export type AuthoringMutationSceneResolver<T> = (
  result: T,
) => SceneResource | null | Promise<SceneResource | null>;

export function authoringWriteOptions(
  baseRevision: number | null | undefined,
): { baseRevision: number } | undefined {
  return typeof baseRevision === "number" && Number.isFinite(baseRevision)
    ? { baseRevision }
    : undefined;
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
    const scene = await context.api.model.scene();
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
  const before = await captureAuthoringHistoryScene(context);
  return { before, baseRevision: sceneRevision(before) };
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
): Promise<T> {
  const preparation = await prepareAuthoringMutation(context);
  const result = await mutation(preparation);
  const history = context.authoringHistory;
  if (!history || !preparation.before) return result;

  let after = resolveAfter
    ? await resolveAfter(result)
    : sceneFromMutationResult(result);
  if (sceneRevision(after) === null) {
    after = await captureAuthoringHistoryScene(context);
  }

  const beforeRevision = preparation.baseRevision;
  const afterRevision = sceneRevision(after);
  if (
    !after ||
    beforeRevision === null ||
    afterRevision === null ||
    afterRevision <= beforeRevision
  ) {
    return result;
  }

  try {
    history.record({
      after,
      before: preparation.before,
      committedRevision: afterRevision,
      label,
    });
  } catch {
    // History is an observability layer; a valid authoring ACK must survive a
    // malformed or unavailable local history snapshot.
  }
  return result;
}
