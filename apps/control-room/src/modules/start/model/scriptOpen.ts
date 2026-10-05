import type { Mx3Translation } from "./mx3Import";
import { templateScript, templateScriptFileName, type StudyTemplate } from "./templates";
import { workspaceHostAvailable } from "./workspaceHost";
import type { WorkspaceItem } from "./workspaceItems";

/**
 * A template or a translated .mx3 is a Python script, not a project. Creating
 * one means saving that script as a file through the desktop host's native
 * Save dialog; the host owns the path, never overwrites a file the dialog did
 * not confirm, and records the file in the workspace database. Creating a file
 * never runs it: running is the separate, consented "Run in new window".
 */

/** Where a script that is about to be saved came from. */
export type ScriptOrigin = "template" | "mx3";

/** One canonical Fullmag Python script to save as a new file. */
export interface ScriptSaveRequest {
  /** Proposed file name, `<name>.py`; the person can change it in the dialog. */
  readonly suggestedName: string;
  readonly text: string;
  readonly origin: ScriptOrigin;
  /** The template id, or the name of the translated .mx3 file. */
  readonly originId: string;
}

export type ScriptSaveOutcome =
  | { readonly kind: "saved"; readonly item: WorkspaceItem }
  /** The person closed the Save dialog; nothing was written. */
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

/** Saves a script through the host and shows the new item in the Scripts list. */
export type ScriptSaver = (request: ScriptSaveRequest) => Promise<ScriptSaveOutcome>;

export const SCRIPT_SAVE_NEEDS_DESKTOP =
  "Saving a script file through the Save dialog needs the desktop app. Use Save script or Copy script to take the script with you.";

/** The save capability exists only where a desktop host does. */
export function scriptSaveAvailable(): boolean {
  return workspaceHostAvailable();
}

export type ScriptActionState =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string };

export const TEMPLATE_WITHOUT_SCRIPT =
  "No script that loads against the public Python API ships for this template yet.";

const leafName = (fileName: string): string => fileName.split(/[\\/]/).pop() ?? fileName;

const baseName = (fileName: string): string => {
  const leaf = leafName(fileName);
  const dot = leaf.lastIndexOf(".");
  return (dot > 0 ? leaf.slice(0, dot) : leaf).trim();
};

export function buildTemplateSaveRequest(template: StudyTemplate): ScriptSaveRequest | null {
  const text = templateScript(template);
  if (text === null) return null;
  return {
    suggestedName: templateScriptFileName(template),
    text,
    origin: "template",
    originId: template.id,
  };
}

export function buildImportSaveRequest(
  sourceFileName: string,
  translation: Pick<Mx3Translation, "script">,
): ScriptSaveRequest {
  const name = baseName(sourceFileName) || "mx3-import";
  return {
    suggestedName: `${name}.py`,
    text: translation.script,
    origin: "mx3",
    originId: leafName(sourceFileName),
  };
}

/** Whether "create script from template" can run now, and if not, exactly why. */
export function templateCreateState(
  template: StudyTemplate,
  saver: ScriptSaver | null,
): ScriptActionState {
  if (templateScript(template) === null) return { available: false, reason: TEMPLATE_WITHOUT_SCRIPT };
  if (!saver) return { available: false, reason: SCRIPT_SAVE_NEEDS_DESKTOP };
  return { available: true, reason: null };
}

/**
 * Whether the translated script can be saved now. An incomplete translation
 * can be saved too: it is editable text, its header and the report list what
 * is missing, and it is running that stops, which the report says.
 */
export function importSaveState(saver: ScriptSaver | null): ScriptActionState {
  if (!saver) return { available: false, reason: SCRIPT_SAVE_NEEDS_DESKTOP };
  return { available: true, reason: null };
}

/** Saves a template's script as a new file. Null when saved or cancelled, else why not. */
export async function createScriptFromTemplate(
  template: StudyTemplate,
  saver: ScriptSaver | null,
): Promise<string | null> {
  const state = templateCreateState(template, saver);
  const request = buildTemplateSaveRequest(template);
  if (!state.available || !request || !saver) return state.reason ?? TEMPLATE_WITHOUT_SCRIPT;
  const outcome = await saver(request);
  return outcome.kind === "failed" ? outcome.message : null;
}

/** Saves a translated .mx3 as a new script file. Null when saved or cancelled, else why not. */
export async function saveTranslatedMx3(
  sourceFileName: string,
  translation: Mx3Translation,
  saver: ScriptSaver | null,
): Promise<string | null> {
  const state = importSaveState(saver);
  if (!state.available || !saver) return state.reason ?? SCRIPT_SAVE_NEEDS_DESKTOP;
  const outcome = await saver(buildImportSaveRequest(sourceFileName, translation));
  return outcome.kind === "failed" ? outcome.message : null;
}
