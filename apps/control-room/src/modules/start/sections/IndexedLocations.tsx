"use client";

import { FolderOpen, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Input } from "@/shared/ui/Input";

import {
  ALL_KINDS,
  KIND_LABEL,
  addRoot,
  describeScan,
  removeRoot,
  sameRoots,
  toggleKind,
  updateRoot,
} from "../model/rootsDraft";
import type { WorkspaceItemsController } from "../model/useWorkspaceItems";
import { useWorkspaceRoots } from "../model/useWorkspaceRoots";
import type { ApiScanReport, ApiWorkspaceRoot } from "../model/workspaceApiTypes";

interface IndexedLocationsProps {
  readonly workspace: WorkspaceItemsController;
}

/**
 * Where the backend looks for projects, scripts and result folders. A browser
 * has no folder picker, so a folder is added by typing its absolute path; the
 * desktop app also offers its native picker.
 */
export function IndexedLocations({ workspace }: IndexedLocationsProps) {
  const roots = useWorkspaceRoots();
  const baseId = useId();
  const [draft, setDraft] = useState<readonly ApiWorkspaceRoot[] | null>(null);
  const [path, setPath] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<ApiScanReport | null>(null);
  const [scanFailure, setScanFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const picker = tauriInvoke();

  const served = roots.state.kind === "ready" ? roots.state.roots : null;
  const current = draft ?? served ?? [];
  const dirty = draft !== null && served !== null && !sameRoots(draft, served);
  const edit = (next: readonly ApiWorkspaceRoot[]) => {
    setDraft(next);
    setSaved(false);
  };

  const add = (raw: string) => {
    const result = addRoot(current, raw);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    setProblem(null);
    setPath("");
    edit(result.roots);
  };

  const browse = async () => {
    try {
      const selected = await picker?.<string | null>("pick_output_directory");
      if (selected) add(selected);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const failure = await roots.save(draft);
    setSaving(false);
    setProblem(failure);
    if (!failure) {
      setDraft(null);
      setSaved(true);
    }
  };

  const scan = async () => {
    setScanFailure(null);
    const outcome = await workspace.scan();
    if ("report" in outcome) setReport(outcome.report);
    else setScanFailure(outcome.failure);
  };

  return (
    <section aria-labelledby={`${baseId}-title`} className="fm-start-section" data-section="indexed-locations">
      <h2 className="fm-start-section__title" id={`${baseId}-title`}>
        Indexed locations
      </h2>
      <p className="fm-start-inspector__note">
        Fullmag lists the projects (.fms), scripts (.py) and result folders (.zarr) it finds in these
        folders.
      </p>

      {roots.state.kind === "loading" ? (
        <p className="fm-start-inspector__note" role="status">
          Reading the locations…
        </p>
      ) : null}
      {roots.state.kind === "error" ? (
        <p className="fm-start-inspector__note" role="alert">
          Could not read the locations: {roots.state.message}
        </p>
      ) : null}
      {roots.state.kind === "unavailable" ? (
        <p className="fm-start-inspector__note">{roots.state.reason}</p>
      ) : null}

      {current.length === 0 && roots.state.kind === "ready" ? (
        <p className="fm-start-inspector__note">No folder is indexed yet. Add one below.</p>
      ) : null}

      {current.length > 0 ? (
        <ul aria-label="Indexed folders" className="fm-start-roots">
          {current.map((root) => (
            <li className="fm-start-roots__item" key={root.path}>
              <span className="fm-start-roots__path" title={root.path}>
                {root.path}
              </span>
              <span
                aria-label={`Kinds indexed in ${root.path}`}
                className="fm-start-roots__kinds"
                role="group"
              >
                {ALL_KINDS.map((kind) => (
                  <label className="fm-start-roots__check" key={kind}>
                    <Checkbox
                      checked={root.kinds.includes(kind)}
                      onChange={() => edit(updateRoot(current, root.path, (r) => toggleKind(r, kind)))}
                    />
                    {KIND_LABEL[kind]}
                  </label>
                ))}
              </span>
              <label className="fm-start-roots__check">
                <Checkbox
                  checked={root.recursive}
                  onChange={() =>
                    edit(updateRoot(current, root.path, (r) => ({ ...r, recursive: !r.recursive })))
                  }
                />
                Subfolders
              </label>
              <label className="fm-start-roots__check">
                <Checkbox
                  checked={root.enabled}
                  onChange={() =>
                    edit(updateRoot(current, root.path, (r) => ({ ...r, enabled: !r.enabled })))
                  }
                />
                Enabled
              </label>
              <Button
                aria-label={`Remove ${root.path}`}
                onClick={() => edit(removeRoot(current, root.path))}
                size="icon"
                title="Remove from the list"
                type="button"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" size={14} />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {roots.state.kind === "ready" ? (
        <form
          className="fm-start-addpath"
          onSubmit={(event) => {
            event.preventDefault();
            add(path);
          }}
        >
          <label className="fm-start-addpath__field">
            <span>Folder to index (absolute path)</span>
            <Input
              aria-describedby={problem ? `${baseId}-problem` : undefined}
              aria-invalid={problem !== null}
              autoComplete="off"
              onChange={(event) => setPath(event.target.value)}
              spellCheck={false}
              type="text"
              value={path}
            />
          </label>
          <Button disabled={path.trim() === ""} size="sm" type="submit" variant="secondary">
            <Plus aria-hidden="true" size={14} />
            Add folder
          </Button>
          {picker ? (
            <Button onClick={() => void browse()} size="sm" type="button" variant="secondary">
              <FolderOpen aria-hidden="true" size={14} />
              Browse…
            </Button>
          ) : null}
        </form>
      ) : null}
      {problem ? (
        <p className="fm-start-addpath__error" id={`${baseId}-problem`} role="alert">
          {problem}
        </p>
      ) : null}

      <div className="fm-start-roots__actions">
        <Button disabled={!dirty || saving} onClick={() => void save()} size="sm" type="button" variant="primary">
          <Save aria-hidden="true" size={14} />
          {saving ? "Saving…" : "Save locations"}
        </Button>
        <Button
          aria-busy={workspace.scanning}
          disabled={workspace.scanning || dirty}
          onClick={() => void scan()}
          size="sm"
          title={dirty ? "Save the locations first" : "Scan the indexed folders now"}
          type="button"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" size={14} />
          {workspace.scanning ? "Scanning…" : "Scan now"}
        </Button>
        {saved ? (
          <span className="fm-start-inspector__note" role="status">
            Locations saved.
          </span>
        ) : null}
      </div>

      {report ? (
        <div className="fm-start-scan" role="status">
          <p className="fm-start-inspector__note">{describeScan(report)}</p>
          {report.warnings.length > 0 ? (
            <ul className="fm-start-scan__warnings">
              {report.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {scanFailure ? (
        <p className="fm-start-addpath__error" role="alert">
          {scanFailure}
        </p>
      ) : null}
    </section>
  );
}
