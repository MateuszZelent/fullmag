import { ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH } from "@/kernel/api/apiPaths";
import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";

import { modeVisualizationDefinitionFromSelection } from "./postprocessingDefinitions";

export const PIN_MODE_VISUALIZATION_COMMAND = "analysis.postprocessing.pin-mode-visualization";
export const UNPIN_POSTPROCESSING_DEFINITION_COMMAND = "analysis.postprocessing.unpin-definition";

interface UnpinInput {
  definitionId: string;
}

function pinDisabledReason(context: CommandContext): string | null {
  if (!context.api) return "Control Room API is not available.";
  const result = modeVisualizationDefinitionFromSelection(context.selection?.get() ?? null);
  return result.ok ? null : result.reason;
}

async function pinModeVisualization(context: CommandContext): Promise<CommandResult> {
  const reason = pinDisabledReason(context);
  const result = modeVisualizationDefinitionFromSelection(context.selection?.get() ?? null);
  if (reason || !result.ok || !context.api) {
    return { message: reason ?? "Mode visualization cannot be pinned.", status: "failed" };
  }
  const definitions = context.api.analysis.postprocessing.definitions;
  const current = await definitions.list();
  if (current.definitions.some((definition) => definition.definition_id === result.definition.definition_id)) {
    return { message: "This mode visualization is already pinned.", status: "completed" };
  }
  const created = await definitions.create({
    definition: result.definition,
    expected_scene_revision: current.scene_revision,
  });
  context.resources?.invalidate(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, created.scene_revision);
  return { message: `Pinned ${created.definition.label}.`, status: "completed" };
}

function asUnpinInput(input: unknown): UnpinInput | null {
  if (!input || typeof input !== "object") return null;
  const definitionId = (input as { definitionId?: unknown }).definitionId;
  return typeof definitionId === "string" && definitionId.length > 0 ? { definitionId } : null;
}

async function unpinDefinition(context: CommandContext): Promise<CommandResult> {
  const input = asUnpinInput(context.input);
  if (!context.api || !input) {
    return { message: "Choose a pinned visualization to remove.", status: "failed" };
  }
  const definitions = context.api.analysis.postprocessing.definitions;
  const current = await definitions.list();
  const removed = await definitions.remove(input.definitionId, {
    expected_scene_revision: current.scene_revision,
  });
  context.resources?.invalidate(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, removed.scene_revision);
  return { message: "Pinned visualization removed.", status: "completed" };
}

/** Persistent user-created Results nodes (ADR 0054, spec 32 §8). */
export const POSTPROCESSING_DEFINITION_COMMANDS: CommandContribution[] = [
  {
    id: PIN_MODE_VISUALIZATION_COMMAND,
    title: "Pin mode visualization",
    category: "analysis",
    group: "analysis.postprocessing",
    scope: "selection",
    isEnabled: (context) => pinDisabledReason(context) === null,
    disabledReason: pinDisabledReason,
    run: pinModeVisualization,
  },
  {
    id: UNPIN_POSTPROCESSING_DEFINITION_COMMAND,
    title: "Remove pinned visualization",
    category: "analysis",
    group: "analysis.postprocessing",
    scope: "selection",
    isEnabled: (context) => Boolean(context.api) && asUnpinInput(context.input) !== null,
    disabledReason: (context) =>
      !context.api
        ? "Control Room API is not available."
        : asUnpinInput(context.input)
          ? null
          : "Choose a pinned visualization to remove.",
    run: unpinDefinition,
  },
];
