import {
  ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import { obsoleteSessionResult } from "@/kernel/commands/commandSessionScope";
import type { CommandContext, CommandContribution, CommandResult } from "@/kernel/commands/commandTypes";
import {
  isReferenceAxisUnit,
  isReferenceFrequencyUnit,
  referencePointPairsValidationError,
} from "@/shared/domain/analysis/referenceImport";

import type {
  AnalysisResultDatasetManifestResource,
  PostprocessingDefinition,
} from "@/kernel/api/apiTypes";
import type { PublishedModeVisualizationSelectionRef } from "./postprocessingDefinitions";

import {
  importedReferenceDefinition,
  modeVisualizationAnalysisResultSelection,
  modeVisualizationDefinitionFromAnalysisResult,
  modeVisualizationDefinitionFromSelection,
  modeVisualizationOwnerMatch,
} from "./postprocessingDefinitions";
import {
  legacyModeVisualizationIdentity,
  resolveLegacyModeVisualizationSelection,
} from "./legacyModeVisualizationSelection";

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

function invalidatePostprocessingDefinitionMutation(
  context: CommandContext,
  sceneRevision: number,
): void {
  context.resources?.invalidate(MODEL_SCENE_PATH, sceneRevision);
  context.resources?.invalidate(
    ANALYSIS_POSTPROCESSING_DEFINITIONS_PATH,
    sceneRevision,
  );
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
    const obsoleteBeforeRead = obsoleteSessionResult(context);
    if (obsoleteBeforeRead) return obsoleteBeforeRead;
    const options = context.sessionScopeKey ? { sessionScopeKey: context.sessionScopeKey } : undefined;
    const definitions = context.api.analysis.postprocessing.definitions;
    const current = await definitions.list(options);
    const obsoleteAfterRead = obsoleteSessionResult(context);
    if (obsoleteAfterRead) return obsoleteAfterRead;
    const definition = await importedReferenceDefinition({ ...validation.input, dataset });
    const obsoleteAfterDigest = obsoleteSessionResult(context);
    if (obsoleteAfterDigest) return obsoleteAfterDigest;
    const created = await definitions.create({
      definition,
      expected_scene_revision: current.scene_revision,
    }, options);
    const obsoleteAfterWrite = obsoleteSessionResult(context);
    if (obsoleteAfterWrite) return obsoleteAfterWrite;
    context.authoringHistory?.clear();
    try {
      invalidatePostprocessingDefinitionMutation(context, created.scene_revision);
    } catch {
      return {
        message: `Imported reference ${created.definition.label}. Refresh the results view to see it.`,
        status: "completed",
      };
    }
    return { message: `Imported reference ${created.definition.label}.`, status: "completed" };
  } catch (error) {
    const obsolete = obsoleteSessionResult(context);
    if (obsolete) return obsolete;
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
  const selection = context.selection?.get() ?? null;
  if (selection?.ref?.type === "analysis-result") {
    const published = modeVisualizationAnalysisResultSelection(selection);
    return published.ok ? null : published.reason;
  }
  if (selection?.ref?.type === "frequency-domain") {
    const legacy = legacyModeVisualizationIdentity(selection);
    return legacy.ok ? null : legacy.reason;
  }
  const legacy = modeVisualizationDefinitionFromSelection(selection);
  return legacy.ok ? null : legacy.reason;
}

function samePublishedDatasetManifest(
  left: AnalysisResultDatasetManifestResource,
  right: AnalysisResultDatasetManifestResource,
): boolean {
  return (
    left.run_id === right.run_id &&
    left.stage_id === right.stage_id &&
    left.dataset_id === right.dataset_id &&
    left.dataset_revision === right.dataset_revision
  );
}

async function pinModeVisualization(context: CommandContext): Promise<CommandResult> {
  const reason = pinDisabledReason(context);
  if (reason || !context.api) {
    return { message: reason ?? "Mode visualization cannot be pinned.", status: "failed" };
  }
  const selection = context.selection?.get() ?? null;
  if (selection?.ref?.type === "analysis-result") {
    const published = modeVisualizationAnalysisResultSelection(selection);
    if (!published.ok) return { message: published.reason, status: "failed" };
    return pinPublishedResultModeVisualization(context, selection, published.selection);
  }
  if (selection?.ref?.type === "frequency-domain") {
    return pinLegacyModeVisualization(context, selection);
  }
  const legacy = modeVisualizationDefinitionFromSelection(selection);
  if (!legacy.ok) return { message: legacy.reason, status: "failed" };
  return pinResolvedModeVisualization(context, legacy.definition);
}

async function pinLegacyModeVisualization(
  context: CommandContext,
  selection: Parameters<typeof modeVisualizationDefinitionFromSelection>[0],
): Promise<CommandResult> {
  const identity = legacyModeVisualizationIdentity(selection);
  if (!identity.ok) return { message: identity.reason, status: "failed" };
  const obsoleteBeforeCatalog = obsoleteSessionResult(context);
  if (obsoleteBeforeCatalog) return obsoleteBeforeCatalog;
  const controller = new AbortController();
  const options = context.sessionScopeKey
    ? { sessionScopeKey: context.sessionScopeKey, signal: controller.signal }
    : { signal: controller.signal };
  const results = context.api!.analysis.results;
  const assertCurrentSession = (): void => {
    if (obsoleteSessionResult(context)) {
      controller.abort();
      throw new Error("The selected session changed while resolving the Results catalog.");
    }
  };

  try {
    const resolved = await resolveLegacyModeVisualizationSelection(
      selection,
      controller.signal,
      {
        loadDatasetPage: async (query, signal) => {
          assertCurrentSession();
          const page = await results.datasets(identity.identity.runId, query, {
            ...options,
            signal,
          });
          assertCurrentSession();
          return page;
        },
        loadItemPage: async (datasetId, query, signal) => {
          assertCurrentSession();
          const page = await results.items(
            identity.identity.runId,
            datasetId,
            query,
            { ...options, signal },
          );
          assertCurrentSession();
          return page;
        },
      },
    );
    const obsoleteAfterCatalog = obsoleteSessionResult(context);
    if (obsoleteAfterCatalog) return obsoleteAfterCatalog;
    if (!resolved.ok) return { message: resolved.reason, status: "failed" };
    const published = modeVisualizationAnalysisResultSelection(resolved.selection);
    if (!published.ok) return { message: published.reason, status: "failed" };
    return pinPublishedResultModeVisualization(
      context,
      resolved.selection,
      published.selection,
    );
  } catch (error) {
    const obsolete = obsoleteSessionResult(context);
    if (obsolete) return obsolete;
    const detail = error instanceof Error && error.message.length > 0
      ? error.message
      : "Unknown error.";
    return { message: "Mode visualization pin failed: " + detail, status: "failed" };
  }
}

async function pinResolvedModeVisualization(
  context: CommandContext,
  definition: PostprocessingDefinition,
): Promise<CommandResult> {
  const obsoleteBeforeRead = obsoleteSessionResult(context);
  if (obsoleteBeforeRead) return obsoleteBeforeRead;
  const options = context.sessionScopeKey ? { sessionScopeKey: context.sessionScopeKey } : undefined;
  const definitions = context.api!.analysis.postprocessing.definitions;
  const current = await definitions.list(options);
  const obsoleteAfterRead = obsoleteSessionResult(context);
  if (obsoleteAfterRead) return obsoleteAfterRead;
  const ownerMatches = current.definitions.map((saved) =>
    modeVisualizationOwnerMatch(saved, definition),
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
  const obsoleteBeforeWrite = obsoleteSessionResult(context);
  if (obsoleteBeforeWrite) return obsoleteBeforeWrite;
  const created = await definitions.create({
    definition,
    expected_scene_revision: current.scene_revision,
  }, options);
  const obsoleteAfterWrite = obsoleteSessionResult(context);
  if (obsoleteAfterWrite) return obsoleteAfterWrite;
  context.authoringHistory?.clear();
  try {
    invalidatePostprocessingDefinitionMutation(context, created.scene_revision);
  } catch {
    return {
      message: `Pinned ${created.definition.label}. Refresh the results view to see it.`,
      status: "completed",
    };
  }
  return { message: `Pinned ${created.definition.label}.`, status: "completed" };
}

async function pinPublishedResultModeVisualization(
  context: CommandContext,
  selection: Parameters<typeof modeVisualizationDefinitionFromAnalysisResult>[0],
  ref: PublishedModeVisualizationSelectionRef,
): Promise<CommandResult> {
  const obsoleteBeforeManifestRead = obsoleteSessionResult(context);
  if (obsoleteBeforeManifestRead) return obsoleteBeforeManifestRead;
  const options = context.sessionScopeKey ? { sessionScopeKey: context.sessionScopeKey } : undefined;
  try {
    const results = context.api!.analysis.results;
    const manifest = await results.dataset(ref.runId, ref.datasetId, options);
    const obsoleteAfterManifestRead = obsoleteSessionResult(context);
    if (obsoleteAfterManifestRead) return obsoleteAfterManifestRead;
    if (
      manifest.run_id !== ref.runId ||
      manifest.stage_id !== ref.stageId ||
      manifest.dataset_id !== ref.datasetId ||
      manifest.dataset_revision !== ref.datasetRevision
    ) {
      return { message: "The published dataset manifest no longer matches the selected result.", status: "failed" };
    }

    const obsoleteBeforeItemRead = obsoleteSessionResult(context);
    if (obsoleteBeforeItemRead) return obsoleteBeforeItemRead;
    const item = await results.item(ref.runId, ref.datasetId, ref.itemId, options);
    const obsoleteAfterItemRead = obsoleteSessionResult(context);
    if (obsoleteAfterItemRead) return obsoleteAfterItemRead;

    const obsoleteBeforeManifestRecheck = obsoleteSessionResult(context);
    if (obsoleteBeforeManifestRecheck) return obsoleteBeforeManifestRecheck;
    const currentManifest = await results.dataset(ref.runId, ref.datasetId, options);
    const obsoleteAfterManifestRecheck = obsoleteSessionResult(context);
    if (obsoleteAfterManifestRecheck) return obsoleteAfterManifestRecheck;
    if (
      !samePublishedDatasetManifest(manifest, currentManifest) ||
      currentManifest.run_id !== ref.runId ||
      currentManifest.stage_id !== ref.stageId ||
      currentManifest.dataset_id !== ref.datasetId ||
      currentManifest.dataset_revision !== ref.datasetRevision
    ) {
      return { message: "The published dataset changed while its item was being verified.", status: "failed" };
    }

    const resolved = modeVisualizationDefinitionFromAnalysisResult(selection, currentManifest, item);
    if (!resolved.ok) return { message: resolved.reason, status: "failed" };
    return await pinResolvedModeVisualization(context, resolved.definition);
  } catch (error) {
    const obsolete = obsoleteSessionResult(context);
    if (obsolete) return obsolete;
    const detail = error instanceof Error && error.message.length > 0 ? error.message : "Unknown error.";
    return { message: "Mode visualization pin failed: " + detail, status: "failed" };
  }
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
  const obsoleteBeforeRead = obsoleteSessionResult(context);
  if (obsoleteBeforeRead) return obsoleteBeforeRead;
  const options = context.sessionScopeKey ? { sessionScopeKey: context.sessionScopeKey } : undefined;
  const definitions = context.api.analysis.postprocessing.definitions;
  const current = await definitions.list(options);
  const obsoleteAfterRead = obsoleteSessionResult(context);
  if (obsoleteAfterRead) return obsoleteAfterRead;
  const removed = await definitions.remove(input.definitionId, {
    expected_scene_revision: current.scene_revision,
  }, options);
  const obsoleteAfterWrite = obsoleteSessionResult(context);
  if (obsoleteAfterWrite) return obsoleteAfterWrite;
  context.authoringHistory?.clear();
  invalidatePostprocessingDefinitionMutation(context, removed.scene_revision);
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
