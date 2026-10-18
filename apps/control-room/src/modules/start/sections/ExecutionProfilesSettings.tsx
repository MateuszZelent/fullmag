"use client";

import { useRef, useState } from "react";

import type { ExecutionProfile, PublishExecutionProfileRequest } from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { useExecutionProfilesResource } from "@/kernel/resources/useExecutionProfilesResource";
import type { ComputeProbeController } from "../model/types";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import {
  duplicateProfileDraft,
  newProfileDraft,
  profileFromDraft,
  sameProfile,
  type ExecutionProfileDraft,
} from "../model/executionProfileDraft";
import {
  executionAvailabilityFor,
  type ExecutionAvailability,
} from "../model/executionAvailability";

type Profiles = ReturnType<typeof useExecutionProfilesResource>;
type Defaults = ExecutionProfile["defaults"];
type PublicationRequest = Omit<PublishExecutionProfileRequest, "profile"> & { profile: ExecutionProfile };
const GIB_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function ExecutionProfilesSettings({
  canPublishExecutionProfiles = false,
  onPublishExecutionProfile,
  executionAvailability,
}: {
  readonly canPublishExecutionProfiles?: boolean;
  readonly onPublishExecutionProfile?: ComputeProbeController["publishExecutionProfile"];
  readonly executionAvailability?: ExecutionAvailability;
}) {
  const resource = useExecutionProfilesResource();
  return <ProfileEditor
    executionAvailability={executionAvailability}
    key={resource.scope}
    resource={resource}
    canPublish={canPublishExecutionProfiles && onPublishExecutionProfile !== undefined}
    onPublish={onPublishExecutionProfile}
  />;
}

export function newExecutionProfileDraft(
  source: ExecutionProfile | undefined,
  executionAvailability?: ExecutionAvailability,
): ExecutionProfileDraft {
  const nextDraft = newProfileDraft(source);
  if (!source) {
    const availability = executionAvailabilityFor(
      executionAvailability,
      nextDraft.profile.defaults.backend,
    );
    if (!availability.gpu.enabled && availability.cpu.enabled) {
      nextDraft.profile = {
        ...nextDraft.profile,
        defaults: { ...nextDraft.profile.defaults, device: "cpu" },
      };
    }
  }
  return nextDraft;
}

function ProfileEditor({ executionAvailability, resource, canPublish, onPublish }: {
  readonly executionAvailability?: ExecutionAvailability;
  readonly resource: Profiles;
  readonly canPublish: boolean;
  readonly onPublish?: ComputeProbeController["publishExecutionProfile"];
}) {
  const [draft, setDraft] = useState<ExecutionProfileDraft | null>(null);
  const [pending, setPending] = useState<PublicationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const inflight = useRef(false);
  const ready = resource.status === "ready" && !resource.error && !resource.refreshError;
  const locked = busy || pending !== null;

  const report = (text: string, error = false) => { setMessage(text); setFailed(error); };
  const finish = (profile: ExecutionProfile) => {
    setPending(null);
    setDraft(null);
    setRefreshRequired(false);
    report(`Published ${profile.profile_id} · ${profile.version}.`);
    resource.refetch();
  };
  const reconcile = async (request: PublicationRequest) => {
    const entry = await resource.findPublication(request.client_intent_id);
    if (entry) {
      if (!sameProfile(entry.profile, request.profile)) throw new Error("The publication identity returned different content. Keep this draft and check the catalogue.");
      finish(entry.profile);
      return true;
    }
    report("Publication is not confirmed. Check again or retry the same publication; the draft is kept.", true);
    return false;
  };
  const publish = async (request: PublicationRequest) => {
    if (!canPublish || !onPublish) {
      report("Publishing profiles is available only in the local Fullmag desktop app.", true);
      return;
    }
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setPending(request);
    report("Publishing profile…");
    try {
      const result = await onPublish(request);
      if (!sameProfile(result.entry.profile, request.profile)) throw new Error("The publication response does not match the draft.");
      finish(result.entry.profile);
    } catch (error) {
      // A server/storage failure can follow an atomic write; reconcile it too.
      if (error instanceof ControlRoomApiError && [400, 401, 403, 409, 413, 422].includes(error.status)) {
        setPending(null);
        setRefreshRequired(error.status === 409);
        report(error.message, true);
      } else {
        try { await reconcile(request); }
        catch { report("The publication outcome is unknown. Keep this draft and check publication when the connection returns.", true); }
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };
  const checkPublication = async () => {
    if (!pending || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try { await reconcile(pending); }
    catch (error) { report(error instanceof Error ? error.message : "Could not check publication.", true); }
    finally { inflight.current = false; setBusy(false); }
  };
  const apply = () => {
    if (!draft || !resource.data || !ready || refreshRequired) return;
    try {
      const profile = profileFromDraft(draft);
      void publish({ expected_revision: resource.data.revision, client_intent_id: crypto.randomUUID(), profile });
    } catch (error) { report(error instanceof Error ? error.message : "Check the profile fields.", true); }
  };
  const begin = (profile?: ExecutionProfile) => {
    const nextDraft = newExecutionProfileDraft(profile, executionAvailability);
    setDraft(nextDraft);
    setRefreshRequired(false);
    report("");
  };
  const beginDuplicate = (profile: ExecutionProfile) => {
    setDraft(duplicateProfileDraft(profile, `exec:copy:${crypto.randomUUID()}`));
    setRefreshRequired(false);
    report("");
  };
  const update = (patch: Partial<ExecutionProfile>) => setDraft((current) => current
    ? { ...current, profile: { ...current.profile, ...patch } } : current);
  const updateDefault = <K extends keyof Defaults>(key: K, value: Defaults[K] | "inherit") => {
    if (!draft) return;
    const defaults = { ...draft.profile.defaults };
    if (value === "inherit") delete defaults[key];
    else defaults[key] = value;
    update({ defaults });
  };
  const deviceAvailability = draft
    ? executionAvailabilityFor(executionAvailability, draft.profile.defaults.backend)
    : null;

  return (
    <section aria-labelledby="fm-start-profiles-title" className="fm-start-section fm-start-profiles" data-execution-profiles="">
      <div className="fm-start-compute-settings__head">
        <div>
          <h2 className="fm-start-section__title" id="fm-start-profiles-title">Execution profiles</h2>
          <p className="fm-start-compute-settings__intro">Save reusable solver preferences as fixed versions. Running jobs keep their accepted settings.</p>
        </div>
        <Button disabled={busy || resource.status === "loading"} onClick={() => { resource.refetch(); setRefreshRequired(false); }} size="sm" variant="secondary">Refresh profiles</Button>
      </div>
      {resource.error || resource.refreshError ? <p className="fm-start-compute-settings__error" role="alert">{(resource.error ?? resource.refreshError)?.message}</p> : null}
      {!resource.data && resource.status === "loading" ? <p role="status">Loading profiles…</p> : null}
      {resource.data && !ready ? <p className="fm-start-compute-settings__notice">Showing the last catalogue reading. Refresh before publishing.</p> : null}
      {resource.data ? <p className="fm-start-compute-settings__intro">{resource.data.entries.length} saved versions · catalogue revision {resource.data.revision}</p> : null}
      {!draft ? <>
        <div className="fm-start-profiles__actions">
          <Button disabled={!ready || !canPublish} onClick={() => begin()} size="sm">Create profile</Button>
        </div>
        {resource.data?.entries.length ? <ul className="fm-start-profiles__list">
          {[...resource.data.entries].reverse().map((entry) => <li key={entry.client_intent_id}>
            <div><strong>{entry.profile.profile_id}</strong><span>Version {entry.profile.version}</span>
              {entry.profile.description ? <p>{entry.profile.description}</p> : null}
              <ProfileInspection profile={entry.profile} />
            </div>
            <div className="fm-start-profiles__list-actions">
              <Button
                aria-label={`Duplicate ${entry.profile.profile_id} ${entry.profile.version}`}
                disabled={!ready || !canPublish}
                onClick={() => beginDuplicate(entry.profile)}
                size="sm"
                variant="secondary"
              >
                Duplicate
              </Button>
              <Button
                aria-label={`New version of ${entry.profile.profile_id} ${entry.profile.version}`}
                disabled={!ready || !canPublish}
                onClick={() => begin(entry.profile)}
                size="sm"
                variant="secondary"
              >
                New version
              </Button>
            </div>
          </li>)}
        </ul> : ready ? <p className="fm-start-compute-settings__intro">No profiles yet. Create a version to save your preferred solver settings.</p> : null}
      </> : <form onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <fieldset className="fm-start-profiles__fields" disabled={locked || !canPublish}>
          <label>Profile ID<Input value={draft.profile.profile_id} onChange={(event) => update({ profile_id: event.target.value })} placeholder="exec:interactive" /></label>
          <label>Version<Input value={draft.profile.version} onChange={(event) => update({ version: event.target.value })} placeholder="2" /></label>
          <label className="fm-start-profiles__wide">Description<Input value={draft.profile.description} onChange={(event) => update({ description: event.target.value })} /></label>
          <ProfileChoice label="Backend" value={draft.profile.defaults.backend} options={["auto", "fdm", "fem", "hybrid"]} onChange={(value) => updateDefault("backend", value)} disabled={locked || !canPublish} />
          <ProfileChoice
            disabled={locked || !canPublish}
            disabledOptions={deviceAvailability?.gpu.enabled ? undefined : { gpu: deviceAvailability?.gpu.reason ?? "GPU availability is not confirmed." }}
            label="Device"
            onChange={(value) => updateDefault("device", value)}
            options={["auto", "cpu", "gpu"]}
            value={draft.profile.defaults.device}
          />
          <ProfileChoice label="Precision" value={draft.profile.defaults.precision} options={["single", "double"]} onChange={(value) => updateDefault("precision", value)} disabled={locked || !canPublish} />
          <ProfileChoice label="Execution mode" value={draft.profile.defaults.mode} options={["strict", "extended", "hybrid"]} onChange={(value) => updateDefault("mode", value)} disabled={locked || !canPublish} />
          <label>CPU threads per task<Input value={draft.threads} onChange={(event) => setDraft({ ...draft, threads: event.target.value })} placeholder="Inherit · auto · 8" /></label>
          <label>RAM per task (GiB)<Input type="number" min="0" step="any" value={draft.ramGiB} onChange={(event) => setDraft({ ...draft, ramGiB: event.target.value })} placeholder={hasExplicitReset(draft.profile.defaults.resources?.ram) ? "Reset retained" : "Inherit"} /></label>
          <label>Scratch per task (GiB)<Input type="number" min="0" step="any" value={draft.scratchGiB} onChange={(event) => setDraft({ ...draft, scratchGiB: event.target.value })} placeholder={hasExplicitReset(draft.profile.defaults.resources?.scratch) ? "Reset retained" : "Inherit"} /></label>
          <label>GPU VRAM per device (GiB)<Input type="number" min="0" step="any" value={draft.vramGiB} onChange={(event) => setDraft({ ...draft, vramGiB: event.target.value })} placeholder={draft.profile.defaults.resources?.gpu === null || draft.profile.defaults.resources?.gpu?.vram_per_device_bytes === null ? "Reset retained" : "Inherit"} /></label>
        </fieldset>
        <p className="fm-start-compute-settings__intro">Inherit leaves the preference unset. Auto records an explicit automatic choice. GPU requests require a GPU; availability is checked when a task is submitted.</p>
        {deviceAvailability && !deviceAvailability.gpu.enabled ? (
          <p className="fm-start-compute-settings__notice" role="status">
            GPU is unavailable: {deviceAvailability.gpu.reason}
          </p>
        ) : null}
        <p className="fm-start-compute-settings__intro">Blank values inherit unless an existing explicit reset is retained unchanged. RAM, scratch, and VRAM values are requested per-task limits; actual admission and allocation are resolved when a task starts.</p>
        <p className="fm-start-compute-settings__intro">Other advanced resource settings are retained when creating a new version. Saving a profile does not assign it to a study.</p>
        <div className="fm-start-profiles__actions">
          {pending ? <>
            <Button disabled={busy} onClick={() => void checkPublication()} type="button" size="sm">Check publication</Button>
            <Button disabled={busy || !canPublish} onClick={() => void publish(pending)} type="button" size="sm" variant="secondary">Retry same publication</Button>
          </> : <>
            <Button disabled={!ready || busy || refreshRequired || !canPublish} type="submit" size="sm">Apply profile</Button>
            <Button disabled={busy} onClick={() => { setDraft(null); report(""); }} type="button" size="sm" variant="secondary">Cancel</Button>
          </>}
        </div>
      </form>}
      {!canPublish ? <p className="fm-start-compute-settings__notice">Publishing profiles is available only in the local Fullmag desktop app.</p> : null}
      {message ? <p className={failed ? "fm-start-compute-settings__error" : "fm-start-compute-settings__notice"} role={failed ? "alert" : "status"}>{message}</p> : null}
    </section>
  );
}

function ProfileInspection({ profile }: { readonly profile: ExecutionProfile }) {
  const { defaults } = profile;
  const resources = defaults.resources;
  const cpu = resources?.cpu;
  const gpu = resources?.gpu;
  const target = resources?.target;
  const parallelism = resources?.parallelism;
  const targetValue = target
    ? target.kind === "local"
      ? "Local"
      : `${target.kind}: ${target.id}`
    : "Inherit";
  const parallelismValue = parallelism?.kind === "distributed"
    ? `${parallelism.ranks} ranks · ${parallelism.threads_per_rank} threads/rank · ${parallelism.gpus_per_rank} GPUs/rank`
    : scalarValue(parallelism?.kind === "single_process" ? "Single process" : undefined);
  const gpuSelectorValue = gpu === null
    ? "Reset"
    : gpu?.selector === "any_compatible"
      ? "Any compatible device"
      : gpu?.selector === "allow_list"
        ? "Allowed UUIDs"
        : gpu?.selector === "required"
          ? "Required UUID"
          : scalarValue(gpu?.selector);
  const gpuIdsValue = gpu === null
    ? "Reset"
    : gpu === undefined
      ? "Inherit"
      : gpu.device_uuids?.length
        ? gpu.device_uuids.join(", ")
        : gpu.selector === "any_compatible"
          ? "No UUID restriction"
          : "No UUIDs configured";

  return (
    <details className="fm-start-profiles__inspection">
      <summary>Inspect</summary>
      <dl>
        <ProfileDetail label="Target" value={targetValue} />
        <ProfileDetail label="Backend" value={scalarValue(defaults.backend)} />
        <ProfileDetail label="Device" value={scalarValue(defaults.device)} />
        <ProfileDetail label="Precision" value={scalarValue(defaults.precision)} />
        <ProfileDetail label="Execution mode" value={scalarValue(defaults.mode)} />
        <ProfileDetail label="CPU threads/task" value={scalarValue(cpu?.threads)} />
        <ProfileDetail label="CPU core policy" value={scalarValue(cpu?.core_policy)} />
        <ProfileDetail label="CPU affinity" value={scalarValue(cpu?.affinity)} />
        <ProfileDetail label="Native threads" value={scalarValue(cpu?.native_threads)} />
        <ProfileDetail label="BLAS threads" value={scalarValue(cpu?.blas_threads)} />
        <ProfileDetail label="NUMA node" value={scalarValue(cpu?.numa_node)} />
        <ProfileDetail label="GPU selector" value={gpuSelectorValue} />
        <ProfileDetail label="GPU UUIDs" value={gpuIdsValue} />
        <ProfileDetail label="GPUs/task" value={gpu === null ? "Reset" : scalarValue(gpu?.devices_per_task)} />
        <ProfileDetail label="VRAM/device" value={gpu === null ? "Reset" : memoryValue(gpu?.vram_per_device_bytes)} />
        <ProfileDetail label="RAM/task" value={memoryValue(resources?.ram?.reservation_bytes)} />
        <ProfileDetail label="Scratch/task" value={memoryValue(resources?.scratch?.reservation_bytes)} />
        <ProfileDetail label="Parallelism" value={parallelismValue} />
        <ProfileDetail label="Placement" value={scalarValue(resources?.placement)} />
      </dl>
    </details>
  );
}

function ProfileDetail({ label, value }: { readonly label: string; readonly value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function scalarValue(value: string | number | null | undefined): string {
  if (value === undefined) return "Inherit";
  if (value === null) return "Reset";
  return value === "auto" ? "Auto" : String(value);
}

function memoryValue(bytes: number | null | undefined): string {
  if (bytes === undefined) return "Inherit";
  if (bytes === null) return "Reset";
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "Not safely displayable";
  return `${GIB_FORMAT.format(bytes / 1024 ** 3)} GiB`;
}

function ProfileChoice<T extends string>({ label, value, options, onChange, disabled, disabledOptions }: {
  label: string;
  value?: T;
  options: readonly T[];
  onChange: (value: T | "inherit") => void;
  disabled: boolean;
  disabledOptions?: Partial<Record<T, string>>;
}) {
  return <div className="fm-start-profiles__choice"><span>{label}</span>
    <Select value={value ?? "inherit"} onValueChange={(next) => { if (next === "inherit" || options.includes(next as T)) onChange(next as T | "inherit"); }} disabled={disabled}>
      <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="inherit">Inherit</SelectItem>{options.map((option) => {
        const reason = disabledOptions?.[option];
        return <SelectItem disabled={Boolean(reason)} key={option} title={reason} value={option}>
          {option === "auto" ? "Auto" : option.toUpperCase()}{reason ? " (unavailable)" : ""}
        </SelectItem>;
      })}</SelectContent>
    </Select>
  </div>;
}

function hasExplicitReset(value: { reservation_bytes?: number | null } | null | undefined): boolean {
  return value === null || value?.reservation_bytes === null;
}
