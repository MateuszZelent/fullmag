"use client";

import { useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";

import { useKernel } from "../KernelContext";
import type { ScriptImportNotice } from "../persistence/ProjectDocumentController";
import { describeScriptImportNotice } from "./scriptImportNotice";

const noSubscription = () => () => {};
const noNotice = (): ScriptImportNotice | null => null;

/**
 * Reports, once a project was created from a script, whether the exported
 * scene matches the script. It stays until dismissed or another project
 * replaces it, because a failed round trip changes what scene edits mean.
 */
export function ScriptImportBanner() {
  const controller = useKernel().projectDocument;
  const notice = useSyncExternalStore(
    controller?.subscribe ?? noSubscription,
    controller?.getScriptImportNotice ?? noNotice,
    noNotice,
  );
  if (!controller || !notice) return null;
  const view = describeScriptImportNotice(notice);
  return (
    <section
      aria-label="Script import"
      className="pointer-events-auto my-1 mr-3 flex max-w-[min(40rem,calc(100vw-1.5rem))] shrink-0 self-end flex-wrap items-center gap-x-3 gap-y-1 rounded-fm-control border border-fm-border bg-fm-surface px-3 py-2 text-fm-xs text-fm-secondary shadow-fm-control"
      data-script-import-fidelity={notice.fidelity.round_trip}
      role="status"
    >
      <span className={view.fidelity.tone === "ok" ? "font-medium text-fm-success" : "font-medium text-fm-warning"}>
        {view.fidelity.headline}
      </span>
      <span>{view.summary}</span>
      <span>{view.fidelity.detail}</span>
      {view.fidelity.notes.length > 0 ? (
        <details className="w-full">
          <summary>Details ({view.fidelity.notes.length})</summary>
          <ul>
            {view.fidelity.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <Button onClick={() => controller.dismissScriptImportNotice()} size="sm" type="button" variant="secondary">
        Dismiss
      </Button>
    </section>
  );
}
