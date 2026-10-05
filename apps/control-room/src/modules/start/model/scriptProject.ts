import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type { ProjectFromScriptRequest, ScriptFidelityResource } from "@/kernel/api/apiTypes";
import { describeFidelity, type FidelityView } from "@/kernel/persistence/scriptImportFidelity";

import type { Mx3Translation } from "./mx3Import";
import type { ScriptActionState } from "./scriptOpen";
import { templateScript, templateScriptFileName, type StudyTemplate } from "./templates";

/**
 * Creating a project from a template or a translated .mx3 script
 * (docs/design/start-screen/docs/08-script-open.md, phase 3). The API executes
 * the script in the Python helper to export its scene, so the person must say
 * yes first, naming the file and the start of its hash. The project embeds the
 * original script; its scene is an approximation whose fidelity the API reports
 * and this model words honestly.
 */

/** The API refuses script text above this size (UTF-8 bytes). */
export const SCRIPT_PROJECT_MAX_BYTES = 1024 * 1024;

export { describeFidelity, type FidelityView };

/** One script to turn into a project. */
export interface ScriptProjectSource {
  /** File name shown in provenance and in the consent prompt. */
  readonly fileName: string;
  readonly text: string;
  /** Recorded in the project: `template:<id>` or `mx3:<file>`. */
  readonly origin: string;
  /** The project name; the script stem when empty. */
  readonly projectName: string;
}

export type ScriptProjectOutcome =
  | { readonly kind: "created"; readonly projectName: string; readonly fidelity: ScriptFidelityResource }
  | { readonly kind: "failed"; readonly message: string };

/** Creates the project through the project document controller. */
export type ProjectCreator = (source: ScriptProjectSource) => Promise<ScriptProjectOutcome>;

export const PROJECT_CREATE_UNAVAILABLE =
  "Creating a project needs the project document service, which is not available here.";

export const TEMPLATE_PROJECT_WITHOUT_SCRIPT =
  "No script that loads against the public Python API ships for this template yet.";

const leafName = (fileName: string): string => fileName.split(/[\\/]/).pop() ?? fileName;

const baseName = (fileName: string): string => {
  const leaf = leafName(fileName);
  const dot = leaf.lastIndexOf(".");
  return (dot > 0 ? leaf.slice(0, dot) : leaf).trim();
};

export function buildTemplateProjectSource(template: StudyTemplate): ScriptProjectSource | null {
  const text = templateScript(template);
  if (text === null) return null;
  return {
    fileName: templateScriptFileName(template),
    text,
    origin: `template:${template.id}`,
    projectName: template.name,
  };
}

export function buildMx3ProjectSource(
  sourceFileName: string,
  translation: Pick<Mx3Translation, "script">,
): ScriptProjectSource {
  const stem = baseName(sourceFileName) || "mx3-import";
  return {
    fileName: `${stem}.py`,
    text: translation.script,
    origin: `mx3:${leafName(sourceFileName)}`,
    projectName: stem,
  };
}

export const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** Whether "Create project" can run now, and if not, exactly why. */
export function projectCreateState(
  source: ScriptProjectSource | null,
  creator: ProjectCreator | null,
): ScriptActionState {
  if (source === null) return { available: false, reason: TEMPLATE_PROJECT_WITHOUT_SCRIPT };
  if (!creator) return { available: false, reason: PROJECT_CREATE_UNAVAILABLE };
  if (utf8Length(source.text) > SCRIPT_PROJECT_MAX_BYTES) {
    return { available: false, reason: "The script is larger than 1 MiB, the limit for creating a project." };
  }
  return { available: true, reason: null };
}

/** First 12 hex digits of the SHA-256 of the script text, or null where the browser has no digest. */
export async function scriptHashPrefix(text: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 12);
  } catch {
    return null;
  }
}

export interface ConsentCopy {
  readonly title: string;
  /** The sentence that says what confirming does. */
  readonly body: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly confirmLabel: string;
}

/** The consent prompt: it runs the script, names the file and the hash prefix. */
export function consentCopy(source: ScriptProjectSource, hashPrefix: string | null): ConsentCopy {
  return {
    title: "Run this script to create a project?",
    body:
      "Creating a project runs the script in the Python helper to read its model. " +
      "Only continue if you trust it. The original script is stored in the project.",
    facts: [
      { label: "File", value: source.fileName },
      { label: "SHA-256", value: hashPrefix ? `${hashPrefix}…` : "not available in this browser" },
      { label: "Size", value: `${utf8Length(source.text)} bytes` },
    ],
    confirmLabel: "Run script and create project",
  };
}

/** The request body for the API; only built after the person confirmed. */
export function buildFromScriptRequest(source: ScriptProjectSource): ProjectFromScriptRequest {
  return {
    source: { name: source.fileName, text: source.text },
    project_name: source.projectName,
    origin: source.origin,
    consent: { executed_by_user: true },
  };
}

/** A person-readable reason for a failed create, using the API's own message. */
export function projectCreateFailureMessage(error: unknown): string {
  if (error instanceof ControlRoomApiError) {
    switch (error.status) {
      case 413:
        return "The script is larger than 1 MiB, the limit for creating a project.";
      case 422:
        return `The script could not be turned into a project and nothing was kept: ${error.message}`;
      case 400:
        return `The request was refused: ${error.message}`;
      default:
        return `Creating the project failed: ${error.message}`;
    }
  }
  return error instanceof Error ? `Creating the project failed: ${error.message}` : "Creating the project failed.";
}
