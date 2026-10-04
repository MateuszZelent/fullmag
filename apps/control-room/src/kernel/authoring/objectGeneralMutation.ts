import type { CommandContext } from "../commands/commandTypes";
import {
  deleteObjectTransaction,
  patchObjectTransaction,
} from "./geometryLifecycleCommands";
import { runAuthoringMutationWithHistory } from "./authoringHistoryMutation";

export interface ObjectIdentityMutation {
  baseRevision: number | null;
  name: string;
  notes: string;
  objectId: string;
}

export interface ObjectDeleteMutation {
  baseRevision: number | null;
  name: string;
  objectId: string;
}

function requestOptions(context: CommandContext) {
  return context.sessionScopeKey
    ? { sessionScopeKey: context.sessionScopeKey }
    : undefined;
}

export async function patchObjectIdentityWithHistory(
  context: CommandContext,
  mutation: ObjectIdentityMutation,
) {
  if (!context.api) throw new Error("Control-room API is unavailable.");
  const options = requestOptions(context);
  return runAuthoringMutationWithHistory(
    context,
    `Edit identity ${mutation.name}`,
    (preparation) => patchObjectTransaction(
      context.api!,
      mutation.objectId,
      {
        base_revision: preparation.baseRevision ?? mutation.baseRevision,
        name: mutation.name,
        notes: mutation.notes,
      },
      options,
    ),
  );
}

export async function deleteObjectWithHistory(
  context: CommandContext,
  mutation: ObjectDeleteMutation,
) {
  if (!context.api) throw new Error("Control-room API is unavailable.");
  const options = requestOptions(context);
  let selectionClearedByMutation = false;
  return runAuthoringMutationWithHistory(
    context,
    `Delete ${mutation.name}`,
    async (preparation) => {
      const response = await deleteObjectTransaction(
        context.api!,
        mutation.objectId,
        { base_revision: preparation.baseRevision ?? mutation.baseRevision },
        options,
      );
      if (
        context.isCurrentSessionScope?.() !== false &&
        context.selection?.get().objectId === mutation.objectId
      ) {
        context.selection.clear("geometry-authoring");
        selectionClearedByMutation = true;
      }
      return response;
    },
    undefined,
    { captureWorkspaceStateAfter: () => selectionClearedByMutation },
  );
}
