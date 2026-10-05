"use client";

import { FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/shared/ui/Button";
import { cn } from "@/shared/utils/className";

import { IMPORT_ACCEPT, IMPORT_FORMATS, classifyImportFile } from "../model/importFormats";
import { translateMx3, type Mx3Translation } from "../model/mx3Import";
import { copyScript, saveScriptFile } from "../model/scriptExport";
import type { ProjectCreator } from "../model/scriptProject";
import { buildImportSaveRequest, saveTranslatedMx3, type ScriptSaver } from "../model/scriptOpen";

import { Mx3ImportReport } from "./Mx3ImportReport";

export interface ImportSectionProps {
  /** Resolves to why the file did not open, or null on success. */
  readonly onOpenFile: (file: File) => Promise<string | null>;
  readonly openDisabledReason: string | null;
  /** Saves a translated script as a new file; null where there is no desktop host. */
  readonly scriptSaver?: ScriptSaver | null;
  /** Creates a project from the translated script after consent; null without a project document service. */
  readonly projectCreator?: ProjectCreator | null;
}

interface StagedImport {
  readonly fileName: string;
  readonly translation: Mx3Translation;
}

const studyNameFor = (fileName: string): string =>
  fileName.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || "mx3_import";

export function ImportSection({
  onOpenFile,
  openDisabledReason,
  scriptSaver = null,
  projectCreator = null,
}: ImportSectionProps) {
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [staged, setStaged] = useState<StagedImport | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setStaged(null);
    const verdict = classifyImportFile(file.name);
    if (verdict.kind !== "supported") {
      setMessage(verdict.reason);
      return;
    }
    if (verdict.format.id === "mx3") {
      // Translating is pure text work; nothing is written until the report is confirmed.
      setBusy(true);
      setMessage(null);
      try {
        const translation = translateMx3(await file.text(), { studyName: studyNameFor(file.name) });
        setStaged({ fileName: file.name, translation });
      } catch {
        setMessage(`Could not read ${file.name}.`);
      }
      setBusy(false);
      return;
    }
    if (openDisabledReason) {
      setMessage(openDisabledReason);
      return;
    }
    setBusy(true);
    setMessage(null);
    setMessage(await onOpenFile(file));
    setBusy(false);
  };

  const createStaged = async () => {
    if (!staged) return;
    setBusy(true);
    const failure = await saveTranslatedMx3(staged.fileName, staged.translation, scriptSaver);
    setMessage(failure);
    // A cancelled dialog is not a failure: the report stays so the person can try again.
    setBusy(false);
  };

  const saveStaged = () => {
    if (!staged) return;
    const request = buildImportSaveRequest(staged.fileName, staged.translation);
    setMessage(saveScriptFile(request.suggestedName, request.text) ? null : "Saving a file is not available here.");
  };

  const copyStaged = async () => {
    if (!staged) return;
    setMessage((await copyScript(staged.translation.script)) ? null : "The clipboard is not available here.");
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void handle(event.dataTransfer.files[0]);
  };

  return (
    <>
      <div className="fm-start-page-head">
        <div className="fm-start-page-head__copy">
          <h1>Import</h1>
          <p>
            Fullmag reads models from the common micromagnetic packages. What cannot be mapped is
            reported before anything is written. A .mx3 file is translated into a Python script you can review and save.
          </p>
        </div>
      </div>

      <div
        className={cn("fm-start-drop", dragging && "fm-start-drop--active")}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDrop={onDrop}
      >
        <FileUp aria-hidden="true" size={20} />
        <p>Drop a file here, or choose one.</p>
        <Button
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          type="button"
          variant="secondary"
        >
          Choose file…
        </Button>
        <input
          accept={IMPORT_ACCEPT}
          className="fm-start-visually-hidden"
          onChange={(event) => {
            void handle(event.target.files?.[0]);
            // Allow choosing the same file again after a refusal.
            event.target.value = "";
          }}
          ref={inputRef}
          tabIndex={-1}
          type="file"
        />
      </div>

      <div aria-live="polite" role="status">
        {message ? <p className="fm-start-notice fm-start-notice--warning">{message}</p> : null}
      </div>

      {staged ? (
        <Mx3ImportReport
          busy={busy}
          fileName={staged.fileName}
          onCopy={() => void copyStaged()}
          onDiscard={() => {
            setStaged(null);
            setMessage(null);
          }}
          onCreate={() => void createStaged()}
          onSave={saveStaged}
          projectCreator={projectCreator}
          saver={scriptSaver}
          translation={staged.translation}
        />
      ) : null}

      <table className="fm-start-formats">
        <caption className="fm-start-visually-hidden">Supported import formats</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Extension</th>
            <th scope="col">Fidelity</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {IMPORT_FORMATS.map((format) => (
            <tr key={format.id}>
              <th scope="row">{format.label}</th>
              <td className="fm-start-formats__ext">{format.extensions.join(" ")}</td>
              <td>{format.fidelity}</td>
              <td>
                {format.unavailableReason
                  ? "Not yet supported"
                  : format.partial
                    ? "Supported (subset)"
                    : "Supported"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
