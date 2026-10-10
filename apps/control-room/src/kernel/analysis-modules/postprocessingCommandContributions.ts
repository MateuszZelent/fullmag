import { ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH } from "@/kernel/api/apiPaths";
import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";
import {
  isReferenceAxisUnit,
  isReferenceFrequencyUnit,
  referencePointPairsValidationError,
} from "@/shared/domain/analysis/referenceImport";

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

type ImportInputValidation =
  | { input: ImportDispersionReferenceInput; reason: null }
  | { input: null; reason: string };

function validateImportInput(input: unknown): ImportInputValidation {
  if (!input || typeof input !== "object") {
    return { input: null, reason: "Choose a file, its columns and units, and a label." };
  }
  const candidate = input as Partial<ImportDispersionReferenceInput>;
  if (
    typeof candidate.fileName !== "string" || candidate.fileName.trim().length === 0 ||
    typeof candidate.label !== "string" || candidate.label.trim().length === 0
  ) {
    return { input: null, reason: "Choose a file name and a non-empty reference label." };
  }
  const sourceUnits = candidate.sourceUnits;
  if (
    !sourceUnits || typeof sourceUnits !== "object" ||
    !isReferenceFrequencyUnit(sourceUnits.frequency) || !isReferenceAxisUnit(sourceUnits.path)
  ) {
    return { input: null, reason: "Choose supported units for the path coordinate and frequency." };
  }
  const pointError = referencePointPairsValidationError(candidate.points);
  if (pointError) return { input: null, reason: pointError };
  return { input: candidate as ImportDispersionReferenceInput, reason: null };
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
  return validateImportInput(context.input).reason;
}

async function importDispersionReference(context: CommandContext): Promise<CommandResult> {
  if (!context.api) {
    return { message: "Control Room API is not available.", status: "failed" };
  }
  const dataset = importDataset(context);
  const validation = validateImportInput(context.input);
  if (!dataset) {
    return { message: "Select a dispersion relation in the Results tree.", status: "failed" };
  }
  if (!validation.input) {
    return { message: validation.reason, status: "failed" };
  }
  try {
    const definitions = context.api.analysis.postprocessing.definitions;
    const current = await definitions.list();
    const created = await definitions.create({
      definition: importedReferenceDefinition({ ...validation.input, dataset }),
      expected_scene_revision: current.scene_revision,
    });
    try {
      context.resources?.invalidate(ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH, created.scene_revision);
    } catch {
      return {
        message: `Imported reference ${created.definition.label}. Refresh the results view to see it.`,
        status: "completed",
      };
    }
    return { message: `Imported reference ${created.definition.label}.`, status: "completed" };
  } catch (error) {
    return {
      message: error instanceof Error && error.message.length > 0
        ? `Reference import failed: ${error.message}`
        : "Reference import failed.",
      status: "failed",
    };
  }
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
