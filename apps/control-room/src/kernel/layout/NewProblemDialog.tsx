"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Database, FolderOpen, Layers, ShieldCheck } from "lucide-react";

import {
  MODEL_SCENE_PATH, MODEL_READINESS_PATH, SESSIONS_PATH, SESSION_CURRENT_PATH,
  PLATFORM_OUTPUT_STORAGE_PATH,
} from "../api/apiPaths";
import type { OutputStorageDefaultsRequest } from "../api/apiTypes";
import { useKernel } from "../KernelContext";
import { createProblemWithPendingFormGuard } from "./createProblemWithPendingFormGuard";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { useOutputStorageDefaults } from "../resources/useOutputStorageDefaults";
import { tauriInvoke } from "../persistence/ProjectDocumentController";
import { useProjectDocumentSnapshot } from "../persistence/ProjectDocumentStatus";
import { joinStoragePath, newSimulationStorage, simulationTimestamp, suggestedProjectFolder,
  validateProjectFolder, validateStorageParent, validateStorageSeparation } from "./newProblemStorage";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle } from "@/shared/ui/Dialog";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

function subscribeDesktopAvailability() { return () => {}; }
function desktopPickerAvailable() { return tauriInvoke() !== null; }
function noDesktopPicker() { return false; }

export type NewProblemBackend = "fdm" | "fem";

export interface NewProblemRequest {
  readonly backend?: NewProblemBackend;
  /** Changes on every request, so the dialog remounts with fresh defaults. */
  readonly key: number;
  readonly open: boolean;
}

export function useNewProblemRequest(): readonly [NewProblemRequest, (open: boolean) => void] {
  const kernel = useKernel();
  const [request, setRequest] = useState<NewProblemRequest>({ key: 0, open: false });
  useEffect(
    () =>
      kernel.bus.on("workspace:new-problem-requested", ({ solver }) => {
        setRequest((current) => ({
          backend: solver === "FEM" ? "fem" : solver === "FDM" ? "fdm" : undefined,
          key: current.key + 1,
          open: true,
        }));
      }),
    [kernel.bus],
  );
  const setOpen = useCallback((open: boolean) => {
    setRequest((current) => (current.open === open ? current : { ...current, open }));
  }, []);
  return [request, setOpen] as const;
}

export function NewProblemDialog({
  hasActiveSession,
  initialBackend = "fdm",
  onOpenChange,
  open,
}: {
  readonly hasActiveSession: boolean;
  readonly initialBackend?: NewProblemBackend;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const kernel = useKernel();
  const defaults = useOutputStorageDefaults(open);
  const projectDocument = useProjectDocumentSnapshot();
  const [timestamp] = useState(() => simulationTimestamp(new Date()));
  const [backend, setBackend] = useState<NewProblemBackend>(initialBackend);
  const [name, setName] = useState(() => `Simulation ${timestamp.replace("_", " ")}`);
  const [folderOverride, setFolderOverride] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Partial<OutputStorageDefaultsRequest>>({});
  const [remember, setRemember] = useState(true);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const canBrowse = useSyncExternalStore(subscribeDesktopAvailability, desktopPickerAvailable, noDesktopPicker);
  const [creationAccepted, setCreationAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = defaults.data;
  const settings: Required<OutputStorageDefaultsRequest> = {
    output_parent: overrides.output_parent ?? base?.output_parent ?? "",
    temp_parent: overrides.temp_parent ?? base?.temp_parent ?? null,
    data_format: overrides.data_format ?? base?.data_format ?? "zarr",
    cleanup: overrides.cleanup ?? base?.cleanup ?? "on_success",
    existing_output: overrides.existing_output ?? base?.existing_output ?? "timestamp",
  };
  const folder = folderOverride ?? suggestedProjectFolder(name.replace(timestamp.replace("_", " "), "").trim(), timestamp);
  const tempParent = settings.temp_parent || (settings.output_parent ? joinStoragePath(settings.output_parent, ".fullmag-tmp") : "");
  const storage = newSimulationStorage({ ...settings, temp_parent: tempParent }, folder);
  const outputError = validateStorageParent(settings.output_parent);
  const folderError = validateProjectFolder(folder);
  const tempError = validateStorageParent(tempParent) || validateStorageSeparation(storage.output_dir || "", tempParent);
  const formatAvailable = base?.supported_formats.includes(settings.data_format) ?? false;
  const hasDirtyProject = projectDocument.state === "ready" && projectDocument.resource.dirty;
  const mustConfirmReplacement = hasActiveSession || hasDirtyProject;
  const disabled = pending || browsing || creationAccepted;
  const canCreate = !disabled && Boolean(base) && Boolean(name.trim()) && !outputError && !folderError && !tempError
    && formatAvailable && (!mustConfirmReplacement || replaceConfirmed) && projectDocument.state !== "loading";
  const update = <K extends keyof OutputStorageDefaultsRequest>(key: K, value: OutputStorageDefaultsRequest[K]) => {
    setOverrides((current) => ({ ...current, [key]: value }));
  };

  const browse = async (target: "output_parent" | "temp_parent") => {
    const invoke = tauriInvoke();
    if (!invoke) return;
    setBrowsing(true);
    setError(null);
    try {
      const selected = await invoke<string | null>("pick_output_directory");
      if (selected) update(target, selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to select the directory.");
    } finally { setBrowsing(false); }
  };

  const create = async () => {
    if (!canCreate) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await createProblemWithPendingFormGuard(kernel.api.sessions, kernel.pendingForms, {
        backend, device: "cpu", name: name.trim(), precision: "double",
        replace_current: hasActiveSession, output_storage: storage,
      }, () => kernel.authoringHistory?.clear());
      // The ACK is final. Subsequent archive/defaults errors must never enable
      // a second session create with the same form.
      setCreationAccepted(true);
      const response = outcome.response;
      const revision = `session:${response.session_id}`;
      kernel.resources.invalidate(SESSIONS_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidatePrefix(SESSION_CURRENT_PATH, revision);
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      kernel.resources.invalidate(MODEL_READINESS_PATH, revision);
      const warnings: string[] = [];
      if (outcome.draftsPreserved || outcome.finalizationError) {
        warnings.push("Review your preserved Inspector changes before continuing.");
      } else if (kernel.projectDocument) {
        try {
          await kernel.projectDocument.create(name.trim());
          const scene = await kernel.api.model.scene();
          await kernel.projectDocument.synchronizeAuthoring(scene);
        } catch (cause) {
          warnings.push(`The project document could not be prepared: ${message(cause)}`);
        }
      }
      if (remember) {
        try {
          await kernel.api.platform.saveOutputStorageDefaults({ ...settings, temp_parent: tempParent });
          kernel.resources.invalidate(PLATFORM_OUTPUT_STORAGE_PATH, `saved:${response.session_id}`);
        } catch (cause) {
          warnings.push(`Storage defaults could not be saved: ${message(cause)}`);
        }
      }
      if (warnings.length) setError(`The simulation was created. ${warnings.join(" ")}`);
      else onOpenChange(false);
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!pending && !browsing) onOpenChange(nextOpen); }}>
      <DialogContent className="fm-new-problem" aria-describedby="fm-new-problem-description">
        <DialogHeader className="fm-new-problem__header">
          <div className="fm-new-problem__heading-icon" aria-hidden="true"><Layers size={20} /></div>
          <div>
            <DialogTitle>New simulation</DialogTitle>
            <DialogDescription id="fm-new-problem-description">Set up your model and choose where its results will live.</DialogDescription>
          </div>
          <span className="fm-new-problem__profile">CPU · Double precision</span>
        </DialogHeader>
        <form className="fm-new-problem__form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <div className="fm-dialog__body fm-new-problem__body">
            <div className="fm-new-problem__fields">
              <section className="fm-new-problem__section" aria-label="Simulation setup">
                <label className="fm-new-problem__field" htmlFor="fm-new-problem-name">
                  <span>Simulation name</span>
                  <Input autoFocus disabled={disabled} id="fm-new-problem-name" maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
                </label>
                <div className="fm-new-problem__field">
                  <span>Discretization</span>
                  <SegmentedControl aria-label="Discretization" disabled={disabled} options={[{ label: "FDM", value: "fdm" }, { label: "FEM", value: "fem" }]} value={backend} onValueChange={setBackend} />
                  <p className="fm-new-problem__hint">{backend === "fdm" ? "A regular grid for finite difference simulations." : "A mesh for finite element simulations."}</p>
                </div>
              </section>
              <section className="fm-new-problem__section" aria-label="Results storage">
                <div className="fm-new-problem__section-heading"><FolderOpen size={15} aria-hidden="true" /><h3>Results storage</h3></div>
                <PathField label="Results directory" id="fm-new-problem-output" value={settings.output_parent} disabled={disabled}
                  invalid={Boolean(settings.output_parent && outputError)} canBrowse={canBrowse} onBrowse={() => void browse("output_parent")}
                  onChange={(value) => update("output_parent", value)} description="A directory on the computer running Fullmag." />
                <label className="fm-new-problem__field" htmlFor="fm-new-problem-folder">
                  <span className="fm-new-problem__label-row">Project folder<Button disabled={disabled || folderOverride === null} size="sm" type="button" variant="ghost" onClick={() => setFolderOverride(null)}>Use suggested</Button></span>
                  <Input aria-label="Project folder" aria-invalid={Boolean(folderError)} aria-describedby="fm-new-problem-folder-hint" disabled={disabled} id="fm-new-problem-folder" value={folder} onChange={(event) => setFolderOverride(event.target.value)} />
                  <p className="fm-new-problem__hint" id="fm-new-problem-folder-hint">{folderError || "The suggested name includes a timestamp."}</p>
                </label>
                <div className="fm-new-problem__field">
                  <span>Field &amp; table data</span>
                  <SegmentedControl aria-label="Data format" disabled={disabled} value={settings.data_format}
                    onValueChange={(value) => update("data_format", value)}
                    options={[{ label: "Zarr", value: "zarr" }, { label: "HDF5", value: "hdf5", disabled: !base?.supported_formats.includes("hdf5") }]} />
                  <p className="fm-new-problem__hint">{settings.data_format === "zarr" ? "Chunked arrays, suited to large simulations and Python analysis." : "Field and table datasets stored in HDF5 files."}</p>
                  {base?.hdf5_unavailable_reason ? <p className="fm-new-problem__hint">{base.hdf5_unavailable_reason}</p> : null}
                </div>
              </section>
              <section className="fm-new-problem__section" aria-label="Temporary storage">
                <PathField label="Temporary directory" id="fm-new-problem-temp" value={tempParent} disabled={disabled}
                  invalid={Boolean(tempParent && tempError)} error={tempError} canBrowse={canBrowse} onBrowse={() => void browse("temp_parent")}
                  onChange={(value) => update("temp_parent", value)} description="Each run uses its own folder inside this directory." />
                <details className="fm-new-problem__advanced">
                  <summary>Cleanup &amp; existing results</summary>
                  <div className="fm-new-problem__advanced-fields">
                    <label className="fm-new-problem__field" htmlFor="fm-new-problem-cleanup"><span>Remove temporary files</span>
                      <Select disabled={disabled} value={settings.cleanup} onValueChange={(value) => update("cleanup", value as OutputStorageDefaultsRequest["cleanup"])}>
                        <SelectTrigger id="fm-new-problem-cleanup"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="on_success">After successful runs</SelectItem><SelectItem value="always">After every run</SelectItem><SelectItem value="never">Keep temporary files</SelectItem></SelectContent>
                      </Select>
                    </label>
                    <label className="fm-new-problem__field" htmlFor="fm-new-problem-existing"><span>If a destination already exists</span>
                      <Select disabled={disabled} value={settings.existing_output} onValueChange={(value) => update("existing_output", value as OutputStorageDefaultsRequest["existing_output"])}>
                        <SelectTrigger id="fm-new-problem-existing"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="timestamp">Add a unique suffix</SelectItem><SelectItem value="error">Stop if destination exists</SelectItem></SelectContent>
                      </Select>
                    </label>
                  </div>
                </details>
                <label className="fm-new-problem__check"><Checkbox checked={remember} disabled={disabled} onChange={(event) => setRemember(event.target.checked)} /><span>Use these storage settings for new simulations</span></label>
              </section>
            </div>
            <aside className="fm-new-problem__preview" aria-label="Storage preview">
              <div className="fm-new-problem__section-heading"><Database size={16} aria-hidden="true" /><h3>Your simulation</h3></div>
              <strong className="fm-new-problem__preview-name">{name.trim() || "Untitled simulation"}</strong>
              <p className="fm-new-problem__hint">{backend.toUpperCase()} · CPU · Double precision</p>
              <div className="fm-new-problem__destination"><span>Results</span><code>{settings.output_parent ? storage.output_dir : "Choose a results directory"}</code><span className="fm-new-problem__format-badge">{settings.data_format === "zarr" ? "Zarr arrays" : "HDF5 datasets"}</span></div>
              <div className="fm-new-problem__destination"><span>Temporary files</span><code>{tempParent || "Choose a temporary directory"}</code><p className="fm-new-problem__hint">{settings.cleanup === "on_success" ? "Removed after success. Kept if a run fails." : settings.cleanup === "always" ? "Removed after a run finishes, including failures." : "Kept until you remove them."}</p></div>
              <div className="fm-new-problem__assurance"><ShieldCheck size={16} aria-hidden="true" /><p>Results are kept. Cleanup removes only temporary folders created by Fullmag.</p></div>
            </aside>
            {defaults.status === "loading" && !base ? <p className="fm-new-problem__notice" role="status">Loading your storage settings…</p> : null}
            {defaults.status === "error" ? <div className="fm-new-problem__notice" role="alert">Unable to load storage settings. <Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => defaults.refetch()}>Try again</Button></div> : null}
            {!formatAvailable && base ? <p className="fm-new-problem__notice" role="alert">The selected data format is unavailable in this runtime. Choose a supported format.</p> : null}
            {mustConfirmReplacement ? <label className="fm-new-problem__check fm-new-problem__replacement"><Checkbox checked={replaceConfirmed} disabled={disabled} onChange={(event) => setReplaceConfirmed(event.target.checked)} /><span>Replace the active simulation and its unsaved project changes.</span></label> : null}
            {error ? <p className="fm-new-problem__error" role="alert">{error}</p> : null}
          </div>
          <DialogFooter className="fm-new-problem__footer">
            <span className="fm-new-problem__footer-note">{creationAccepted ? "Simulation created" : "You can refine the model after creation."}</span>
            <DialogClose asChild><Button disabled={pending || browsing} size="sm" type="button" variant="ghost">{creationAccepted ? "Close" : "Cancel"}</Button></DialogClose>
            <Button disabled={!canCreate} size="sm" type="submit">{pending ? "Creating…" : "Create simulation"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PathField({ label, id, value, onChange, onBrowse, canBrowse, description, disabled, invalid, error }: {
  readonly label: string; readonly id: string; readonly value: string; readonly onChange: (value: string) => void;
  readonly onBrowse: () => void; readonly canBrowse: boolean; readonly description: string; readonly disabled: boolean; readonly invalid: boolean; readonly error?: string | null;
}) {
  return <div className="fm-new-problem__field"><label htmlFor={id}>{label}</label>
    <div className="fm-new-problem__path-control"><Input aria-describedby={`${id}-hint`} aria-invalid={invalid} disabled={disabled} id={id} placeholder="Choose a directory…" value={value} onChange={(event) => onChange(event.target.value)} />{canBrowse ? <Button disabled={disabled} size="sm" type="button" variant="ghost" aria-label={`Browse ${label.toLowerCase()}`} onClick={onBrowse}>Browse…</Button> : null}</div>
    <p className="fm-new-problem__hint" id={`${id}-hint`}>{invalid ? error || validateStorageParent(value) : description}</p>
  </div>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unable to create the simulation.";
}
