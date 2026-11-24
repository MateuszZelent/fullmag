"use client";

import { FileUp } from "lucide-react";
import { useReducer, useRef, useState, type DragEvent, type FormEvent } from "react";

import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { cn } from "@/shared/utils/className";

import { stlScaleToSi, type StlLengthUnit } from "@/kernel/authoring/importedStlImport";
import { IMPORT_ACCEPT, IMPORT_FORMATS, classifyImportFile } from "../model/importFormats";
import { translateMx3, type Mx3Translation } from "../model/mx3Import";
import { copyScript, saveScriptFile } from "../model/scriptExport";
import type { ProjectCreator, ScriptProjectSource } from "../model/scriptProject";
import { readPythonImport } from "../model/pythonImport";
import { CreateProjectAction } from "../ui/CreateProjectAction";
import { buildImportSaveRequest, saveTranslatedMx3, type ScriptSaver } from "../model/scriptOpen";

import { Mx3ImportReport } from "./Mx3ImportReport";

export interface ImportSectionProps {
  /** Resolves to why the file did not open, or null on success. */
  readonly onOpenFile: (file: File) => Promise<string | null>;
  readonly openDisabledReason: string | null;
  /** Saves a translated script as a new file; null where there is no desktop host. */
  readonly scriptSaver?: ScriptSaver | null;
  /** Creates a project from reviewed Python source after consent; null without a project document service. */
  readonly projectCreator?: ProjectCreator | null;
  readonly previewCreator?: ProjectCreator | null;
  readonly onImportStl: (file: File, units: StlLengthUnit, scale: number) => Promise<string | null>;
  readonly onCreateFemWorkspace: () => Promise<string | null>;
  readonly stlWorkspaceState: "active" | "none" | "unconfirmed";
}

interface StagedImport {
  readonly fileName: string;
  readonly translation: Mx3Translation;
}

type ImportReview =
  | { kind: "none" }
  | { kind: "mx3"; staged: StagedImport }
  | { kind: "python"; source: ScriptProjectSource }
  | { kind: "stl"; file: File; units: string; scale: string; invalidScale: boolean };

type ImportReviewAction =
  | { type: "clear" }
  | { type: "mx3"; staged: StagedImport }
  | { type: "python"; source: ScriptProjectSource }
  | { type: "stl"; file: File }
  | { type: "units"; units: string }
  | { type: "scale"; scale: string }
  | { type: "scaleValidity"; invalid: boolean };

function updateImportReview(review: ImportReview, action: ImportReviewAction): ImportReview {
  switch (action.type) {
    case "clear": return { kind: "none" };
    case "mx3": return { kind: "mx3", staged: action.staged };
    case "python": return { kind: "python", source: action.source };
    case "stl": return { kind: "stl", file: action.file, units: "", scale: "1", invalidScale: false };
    case "units": return review.kind === "stl" ? { ...review, units: action.units } : review;
    case "scale": return review.kind === "stl" ? { ...review, scale: action.scale, invalidScale: false } : review;
    case "scaleValidity": return review.kind === "stl" ? { ...review, invalidScale: action.invalid } : review;
  }
}

const studyNameFor = (fileName: string): string =>
  fileName.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "_") || "mx3_import";

export function ImportSection({
  onOpenFile,
  openDisabledReason,
  scriptSaver = null,
  projectCreator = null,
  previewCreator = null,
  onImportStl,
  onCreateFemWorkspace,
  stlWorkspaceState,
}: ImportSectionProps) {
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, dispatch] = useReducer(updateImportReview, { kind: "none" });
  const staged = review.kind === "mx3" ? review.staged : null;
  const pythonSource = review.kind === "python" ? review.source : null;
  const stl = review.kind === "stl" ? review : null;
  const scaleRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file || busy) return;
    dispatch({ type: "clear" });
    const verdict = classifyImportFile(file.name);
    if (verdict.kind !== "supported") {
      setMessage(verdict.reason);
      return;
    }
    if (verdict.format.id === "stl") {
      if (stlWorkspaceState !== "active") {
        setMessage(stlWorkspaceState === "none"
          ? "Create a FEM workspace first. Then return to Import and choose the STL file again."
          : "Fullmag could not confirm the active workspace. Refresh the session list before importing STL.");
        return;
      }
      dispatch({ type: "stl", file });
      setMessage(null);
      return;
    }
    if (verdict.format.id === "python") {
      setBusy(true);
      setMessage(null);
      try {
        dispatch({ type: "python", source: await readPythonImport(file) });
      } catch (error) {
        setMessage(error instanceof Error ? error.message : `Could not read ${file.name}.`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (verdict.format.id === "mx3") {
      // Translating is pure text work; nothing is written until the report is confirmed.
      setBusy(true);
      setMessage(null);
      try {
        const translation = translateMx3(await file.text(), { studyName: studyNameFor(file.name) });
        dispatch({ type: "mx3", staged: { fileName: file.name, translation } });
      } catch {
        setMessage(`Could not read ${file.name}.`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (openDisabledReason) {
      setMessage(openDisabledReason);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await onOpenFile(file));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const createStaged = async () => {
    if (!staged) return;
    setBusy(true);
    try {
      const failure = await saveTranslatedMx3(staged.fileName, staged.translation, scriptSaver);
      // A cancelled dialog leaves the report available for another attempt.
      setMessage(failure);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
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

  const submitStl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!stl || busy) return;
    const units = stl.units as StlLengthUnit;
    const scale = Number(stl.scale);
    if (!Number.isFinite(scale) || scale <= 0 || stlScaleToSi(scale, units) === null) {
      dispatch({ type: "scaleValidity", invalid: true });
      setMessage("Choose a positive scale that remains finite and greater than zero in metres.");
      scaleRef.current?.focus();
      return;
    }
    dispatch({ type: "scaleValidity", invalid: false });
    setBusy(true);
    setMessage(null);
    try {
      const failure = await onImportStl(stl.file, units, scale);
      setMessage(failure);
      if (!failure) dispatch({ type: "clear" });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The STL surface could not be imported.");
    } finally {
      setBusy(false);
    }
  };

  const createFemWorkspace = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const failure = await onCreateFemWorkspace();
      setMessage(failure ?? "FEM workspace setup was requested. After creating the workspace, return to Import and choose the STL file again.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open FEM workspace setup.");
    } finally {
      setBusy(false);
    }
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
            reported before anything is written. Review a .py source file before creating a project,
            translate a .mx3 file into Python, or import an STL triangle surface into an open workspace.
          </p>
        </div>
      </div>

      <section aria-labelledby="fm-stl-import-title" className="fm-start-report">
        <h2 className="fm-start-report__title" id="fm-stl-import-title">Import an STL surface</h2>
        <p className="fm-start-inspector__note">
          STL stores triangle coordinates without a reliable length unit. Choose the coordinate unit
          and a positive scale explicitly. FEM is required for volume meshing. This adds geometry only; it does not activate a material
          or physics module.
        </p>
        {stlWorkspaceState === "none" ? (
          <div>
            <p className="fm-start-inspector__note">
              Create a FEM workspace before selecting the STL. Workspace setup does not start a solver.
              After the workspace opens, return here and choose the file again.
            </p>
            <Button disabled={busy} onClick={() => void createFemWorkspace()} type="button" variant="secondary">
              Create FEM workspace…
            </Button>
          </div>
        ) : stlWorkspaceState === "unconfirmed" ? (
          <p className="fm-start-inspector__note" role="status">
            Import is available after Fullmag confirms the active workspace.
          </p>
        ) : null}
        {stl ? (
          <form aria-label="STL import settings" className="fm-start-report" onSubmit={(event) => void submitStl(event)}>
            <fieldset className="fm-start-run-fieldset">
              <legend>Surface settings for {stl.file.name}</legend>
              <label className="fm-start-run-field" htmlFor="fm-stl-units">
                Coordinate length unit
                <select
                  aria-describedby="fm-stl-units-help"
                  id="fm-stl-units"
                  name="stl_units"
                  onChange={(event) => dispatch({ type: "units", units: event.currentTarget.value })}
                  required
                  value={stl.units}
                >
                  <option value="">Choose a unit…</option>
                  <option value="m">Metres (m)</option>
                  <option value="mm">Millimetres (mm)</option>
                  <option value="um">Micrometres (µm)</option>
                  <option value="nm">Nanometres (nm)</option>
                </select>
              </label>
              <p className="fm-start-inspector__note" id="fm-stl-units-help">
                Pick the unit used by the coordinates stored in this STL. Fullmag does not infer it from the filename.
              </p>
              <label className="fm-start-run-field" htmlFor="fm-stl-scale">
                Positive scale multiplier
                <Input
                  aria-describedby="fm-stl-scale-help fm-start-import-status"
                  aria-invalid={stl.invalidScale || undefined}
                  ref={scaleRef}
                  id="fm-stl-scale"
                  name="stl_scale"
                  min="5e-324"
                  onChange={(event) => {
                    dispatch({ type: "scale", scale: event.currentTarget.value });
                  }}
                  required
                  step="any"
                  type="number"
                  value={stl.scale}
                />
              </label>
              <p className="fm-start-inspector__note" id="fm-stl-scale-help">
                Multiplies every STL coordinate after conversion from the selected unit. Default: 1.
              </p>
              <Button disabled={busy} type="submit">Import surface</Button>
              <Button
                disabled={busy}
                onClick={() => {
                  dispatch({ type: "clear" });
                  setMessage(null);
                }}
                type="button"
                variant="ghost"
              >
                Choose another file
              </Button>
            </fieldset>
          </form>
        ) : null}
      </section>

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
          aria-label="Import a file"
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

      <div aria-live="polite" id="fm-start-import-status" role="status">
        {message ? <p className="fm-start-notice fm-start-notice--warning">{message}</p> : null}
      </div>

      {pythonSource ? (
        <section aria-label="Python source review" className="fm-start-report">
          <h2 className="fm-start-report__title">Review: {pythonSource.fileName}</h2>
          <p className="fm-start-inspector__note">
            Self-contained scripts only. Companion files and relative assets are not included.
            You can review the source here. Opening a preview or creating a project requires consent to evaluate it.
          </p>
          <pre aria-label="Python source" className="fm-start-report__source" style={{ maxHeight: "24rem", overflow: "auto" }} tabIndex={0}><code>{pythonSource.text}</code></pre>
          <CreateProjectAction creator={projectCreator} disabled={busy} source={pythonSource} />
          <CreateProjectAction creator={previewCreator} disabled={busy} label="Open model preview…"
            preview source={pythonSource} variant="secondary" />
          <Button onClick={() => dispatch({ type: "clear" })} type="button" variant="ghost">Discard</Button>
        </section>
      ) : null}

      {staged ? (
        <Mx3ImportReport
          busy={busy}
          fileName={staged.fileName}
          onCopy={() => void copyStaged()}
          onDiscard={() => {
            dispatch({ type: "clear" });
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
