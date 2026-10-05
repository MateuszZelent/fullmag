import { describeFidelity, type FidelityView } from "../persistence/scriptImportFidelity";

import type { ScriptImportNotice } from "../persistence/ProjectDocumentController";

export interface ScriptImportNoticeView {
  readonly summary: string;
  readonly fidelity: FidelityView;
}

/** Banner text for a project that was created from a script. */
export function describeScriptImportNotice(notice: ScriptImportNotice): ScriptImportNoticeView {
  return {
    summary: `${notice.projectName} was created from ${notice.scriptName} (${notice.sha256.slice(0, 12)}).`,
    fidelity: describeFidelity(notice.fidelity),
  };
}
