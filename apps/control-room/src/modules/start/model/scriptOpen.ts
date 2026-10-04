import type { Mx3Translation } from "./mx3Import";
import { templateScript, templateScriptFileName, type StudyTemplate } from "./templates";

/** Where a script that is about to become a project came from. */
export type ScriptOrigin =
  | { readonly kind: "template"; readonly templateId: string }
  | { readonly kind: "import"; readonly format: "mx3"; readonly sourceFileName: string };

/** One canonical Fullmag Python script to open as a new project with no runs. */
export interface ScriptOpenRequest {
  readonly projectName: string;
  /** Suggested file name for the script, `<name>.py`. */
  readonly fileName: string;
  readonly source: string;
  readonly origin: ScriptOrigin;
}

/** Resolves to why the project did not open, or null once it is open. */
export type ScriptOpener = (request: ScriptOpenRequest) => Promise<string | null>;

/**
 * The Control Room has no flow that turns Python text into a project today.
 * Projects are created empty (`POST /v2/persistence/projects`, a name only) or
 * opened from a `.fms` archive, and a workspace session is created empty
 * (`POST /v2/sessions`); Python is only ever rendered from the scene document,
 * never ingested. Until the API gains such an operation there is nothing honest
 * to bind, so `resolveScriptOpener` returns null and every caller shows this.
 */
export const SCRIPT_OPEN_UNAVAILABLE =
  "This build cannot open a Python script as a project yet: the API creates projects empty or from .fms archives and has no operation that accepts script text. Save the script and run it with the fullmag command line.";

/** The one place a script-open operation is bound once the API provides one. */
export function resolveScriptOpener(): ScriptOpener | null {
  return null;
}

export type ScriptActionState =
  | { readonly available: true; readonly reason: null }
  | { readonly available: false; readonly reason: string };

export const TEMPLATE_WITHOUT_SCRIPT =
  "No script that loads against the public Python API ships for this template yet.";

const baseName = (fileName: string): string => {
  const leaf = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = leaf.lastIndexOf(".");
  return (dot > 0 ? leaf.slice(0, dot) : leaf).trim();
};

export function buildTemplateOpenRequest(template: StudyTemplate): ScriptOpenRequest | null {
  const source = templateScript(template);
  if (source === null) return null;
  return {
    projectName: template.name,
    fileName: templateScriptFileName(template),
    source,
    origin: { kind: "template", templateId: template.id },
  };
}

export function buildImportOpenRequest(
  sourceFileName: string,
  translation: Pick<Mx3Translation, "script">,
): ScriptOpenRequest {
  const name = baseName(sourceFileName) || "mx3-import";
  return {
    projectName: name,
    fileName: `${name}.py`,
    source: translation.script,
    origin: { kind: "import", format: "mx3", sourceFileName },
  };
}

/** Whether "create from template" can run now, and if not, exactly why. */
export function templateCreateState(
  template: StudyTemplate,
  opener: ScriptOpener | null,
): ScriptActionState {
  if (templateScript(template) === null) return { available: false, reason: TEMPLATE_WITHOUT_SCRIPT };
  if (!opener) return { available: false, reason: SCRIPT_OPEN_UNAVAILABLE };
  return { available: true, reason: null };
}

/** Whether the translated script can be opened now, and if not, exactly why. */
export function importOpenState(
  translation: Pick<Mx3Translation, "runnable" | "blockers">,
  opener: ScriptOpener | null,
): ScriptActionState {
  if (!translation.runnable) {
    return {
      available: false,
      reason: `The translation is incomplete: ${translation.blockers.join("; ")}.`,
    };
  }
  if (!opener) return { available: false, reason: SCRIPT_OPEN_UNAVAILABLE };
  return { available: true, reason: null };
}

/** Opens a template as a new project named after it. Null on success. */
export async function createProjectFromTemplate(
  template: StudyTemplate,
  opener: ScriptOpener | null,
): Promise<string | null> {
  const state = templateCreateState(template, opener);
  const request = buildTemplateOpenRequest(template);
  if (!state.available || !request || !opener) return state.reason ?? TEMPLATE_WITHOUT_SCRIPT;
  return opener(request);
}

/** Opens a translated .mx3 as a new project named after the file. Null on success. */
export async function openTranslatedMx3(
  sourceFileName: string,
  translation: Mx3Translation,
  opener: ScriptOpener | null,
): Promise<string | null> {
  const state = importOpenState(translation, opener);
  if (!state.available || !opener) return state.reason ?? SCRIPT_OPEN_UNAVAILABLE;
  return opener(buildImportOpenRequest(sourceFileName, translation));
}
