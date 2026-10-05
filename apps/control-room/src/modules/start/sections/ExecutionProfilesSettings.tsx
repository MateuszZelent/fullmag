"use client";

import { useRef, useState } from "react";

import type { ExecutionProfile, PublishExecutionProfileRequest } from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { useExecutionProfilesResource } from "@/kernel/resources/useExecutionProfilesResource";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { newProfileDraft, profileFromDraft, sameProfile, type ExecutionProfileDraft } from "../model/executionProfileDraft";

type Profiles = ReturnType<typeof useExecutionProfilesResource>;
type Defaults = ExecutionProfile["defaults"];
type PublicationRequest = Omit<PublishExecutionProfileRequest, "profile"> & { profile: ExecutionProfile };

export function ExecutionProfilesSettings() {
  const resource = useExecutionProfilesResource();
  return <ProfileEditor key={resource.scope} resource={resource} />;
}

function ProfileEditor({ resource }: { resource: Profiles }) {
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
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setPending(request);
    report("Publishing profile…");
    try {
      const result = await resource.publish(request);
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
    setDraft(newProfileDraft(profile));
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
          <Button disabled={!ready} onClick={() => begin()} size="sm">Create profile</Button>
        </div>
        {resource.data?.entries.length ? <ul className="fm-start-profiles__list">
          {[...resource.data.entries].reverse().map((entry) => <li key={entry.client_intent_id}>
            <div><strong>{entry.profile.profile_id}</strong><span>Version {entry.profile.version}</span>
              {entry.profile.description ? <p>{entry.profile.description}</p> : null}
            </div>
            <Button disabled={!ready} onClick={() => begin(entry.profile)} size="sm" variant="secondary" aria-label={`New version of ${entry.profile.profile_id} ${entry.profile.version}`}>New version</Button>
          </li>)}
        </ul> : ready ? <p className="fm-start-compute-settings__intro">No profiles yet. Create a version to save your preferred solver settings.</p> : null}
      </> : <form onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <fieldset className="fm-start-profiles__fields" disabled={locked}>
          <label>Profile ID<Input value={draft.profile.profile_id} onChange={(event) => update({ profile_id: event.target.value })} placeholder="exec:interactive" /></label>
          <label>Version<Input value={draft.profile.version} onChange={(event) => update({ version: event.target.value })} placeholder="2" /></label>
          <label className="fm-start-profiles__wide">Description<Input value={draft.profile.description} onChange={(event) => update({ description: event.target.value })} /></label>
          <ProfileChoice label="Backend" value={draft.profile.defaults.backend} options={["auto", "fdm", "fem", "hybrid"]} onChange={(value) => updateDefault("backend", value)} disabled={locked} />
          <ProfileChoice label="Device" value={draft.profile.defaults.device} options={["auto", "cpu", "gpu"]} onChange={(value) => updateDefault("device", value)} disabled={locked} />
          <ProfileChoice label="Precision" value={draft.profile.defaults.precision} options={["single", "double"]} onChange={(value) => updateDefault("precision", value)} disabled={locked} />
          <ProfileChoice label="Execution mode" value={draft.profile.defaults.mode} options={["strict", "extended", "hybrid"]} onChange={(value) => updateDefault("mode", value)} disabled={locked} />
          <label>CPU threads per task<Input value={draft.threads} onChange={(event) => setDraft({ ...draft, threads: event.target.value })} placeholder="Inherit · auto · 8" /></label>
        </fieldset>
        <p className="fm-start-compute-settings__intro">Inherit leaves the preference unset. Auto records an explicit automatic choice. GPU requests require a GPU; availability is checked when a task is submitted.</p>
        <p className="fm-start-compute-settings__intro">Other resource settings are retained when creating a new version. Saving a profile does not assign it to a study.</p>
        <div className="fm-start-profiles__actions">
          {pending ? <>
            <Button disabled={busy} onClick={() => void checkPublication()} type="button" size="sm">Check publication</Button>
            <Button disabled={busy} onClick={() => void publish(pending)} type="button" size="sm" variant="secondary">Retry same publication</Button>
          </> : <>
            <Button disabled={!ready || busy || refreshRequired} type="submit" size="sm">Apply profile</Button>
            <Button disabled={busy} onClick={() => { setDraft(null); report(""); }} type="button" size="sm" variant="secondary">Cancel</Button>
          </>}
        </div>
      </form>}
      {message ? <p className={failed ? "fm-start-compute-settings__error" : "fm-start-compute-settings__notice"} role={failed ? "alert" : "status"}>{message}</p> : null}
    </section>
  );
}

function ProfileChoice<T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value?: T; options: readonly T[]; onChange: (value: T | "inherit") => void; disabled: boolean;
}) {
  return <div className="fm-start-profiles__choice"><span>{label}</span>
    <Select value={value ?? "inherit"} onValueChange={(next) => { if (next === "inherit" || options.includes(next as T)) onChange(next as T | "inherit"); }} disabled={disabled}>
      <SelectTrigger aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="inherit">Inherit</SelectItem>{options.map((option) => <SelectItem key={option} value={option}>{option === "auto" ? "Auto" : option.toUpperCase()}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}
