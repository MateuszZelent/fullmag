"use client";

import { FileUp } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/shared/ui/Button";
import { cn } from "@/shared/utils/className";

import { IMPORT_ACCEPT, IMPORT_FORMATS, classifyImportFile } from "../model/importFormats";

export interface ImportSectionProps {
  /** Resolves to why the file did not open, or null on success. */
  readonly onOpenFile: (file: File) => Promise<string | null>;
  readonly openDisabledReason: string | null;
}

export function ImportSection({ onOpenFile, openDisabledReason }: ImportSectionProps) {
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    const verdict = classifyImportFile(file.name);
    if (verdict.kind !== "supported") {
      setMessage(verdict.reason);
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
            reported before anything is written.
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
              <td>{format.unavailableReason ? "Not yet supported" : "Supported"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
