import { ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH } from "@/kernel/api/apiPaths";
import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";

import {
  importedReferenceDefinition,
  modeVisualizationDefinitionFromSelection,
  modeVisualizationOwnerMatch,
} from "./postprocessingDefinitions";

export const PIN_MODE_VISUALIZATION_COMMAND = "analysis.postprocessing.pin-mode-visualization";
export const UNPIN_POSTPROCESSING_DEFINITION_COMMAND = "analysis.postprocessing.unpin-definition";
export const IMPORT_DISPERSION_REFERENCE_COMMAND = "analysis.postprocessing.import-dispersion-reference";

export interface ImportDispersionReferenceInput {
  fileName: string;
  label: string;
  points: readonly (readonly [number, number])[];
  sourceUnits: { frequency: string; path: string };
}

function asImportInput(input: unknown): ImportDispersionReferenceInput | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<ImportDispersionReferenceInput>;
  return typeof candidate.fileName === "string" &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    Array.isArray(candidate.points) &&
    candidate.points.length >= 2 &&
    candidate.sourceUnits
    ? (candidate as ImportDispersionReferenceInput)
    : null;
}

/** The selected dispersion result whose run and stage the reference is compared with. */
function importDataset(context: CommandContext) {
  const ref = context.selection?.get()?.ref;
  if (ref?.type !== "frequency-domain" || !ref.analysisRunId || !ref.analysisStageId || ref.artifactRevision === undefined) {
    return null;
  }
  return { artifactRevision: ref.artifactRevision, runId: ref.analysisRunId, stageId: ref.analysisStageId };
}

function importDisabledReason(context: CommandContext): string | null {
  if (!context.api) return "Control Room API is not available.";
  if (!importDataset(context)) return "Select a dispersion relation in the Results tree.";
  if (!asImportInput(context.input)) return "Choose a file, its columns and units, and a label.";
  return null;
}

async function importDispersionReference(context: CommandContext): Promise<CommandResult> {
  const reason = importDisabledReason(context);
  const dataset = importDataset(context);
  const input = asImportInput(context.input);
  if (reason || !dataset || !input || !context.api) {
    return { message: reason ?? "Reference cannot be imported.", status: "failed" };
  }
  const definitions = context.api.analysis.postprocessing.definitions;
  const current = await definitions.list();
  const created = await definitions.create({
    definition: importedReferenceDefinition({ ...input, dataset }),
    expected_scene_revision: current.scene_revision,
  });
  context.resources?.invalidate(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, created.scene_revision);
  return { message: `Imported reference ${created.definition.label}.`, status: "completed" };
}

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
  const ownerMatches = current.definitions.map((definition) =>
    modeVisualizationOwnerMatch(definition, result.definition),
  );
  if (ownerMatches.includes("exact")) {
    return { message: "This mode visualization is already pinned.", status: "completed" };
  }
  if (ownerMatches.includes("compatible-incomplete")) {
    return {
      message:
        "An existing pin and this selection share the same published field owner, but lack enough sample or mode identity to tell whether they are the same mode. Review or remove the existing pin before adding another.",
      status: "failed",
    };
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
    id: IMPORT_DISPERSION_REFERENCE_COMMAND,
    title: "Import dispersion reference",
    category: "analysis",
    group: "analysis.postprocessing",
    scope: "selection",
    isEnabled: (context) => importDisabledReason(context) === null,
    disabledReason: importDisabledReason,
    run: importDispersionReference,
  },
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
