"use client";

import { useMemo, useReducer } from "react";

import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import { Input } from "@/shared/ui/Input";
import { Switch } from "@/shared/ui/Switch";

import {
  buildComputeNodePolicyUpdate,
  createComputeNodePolicyDraft,
  type ComputeNodePolicyFormDraft,
} from "./model/computeNodePolicyDraft";
import type {
  ComputeNodePolicySummary,
  ComputeNodeSnapshotSummary,
  ComputeProbeController,
} from "./model/types";

type UpdatePolicy = ComputeProbeController["updateNodePolicy"];

interface PolicyEditorState {
  baseline: ComputeNodePolicyFormDraft | null;
  baseRevision: number | null;
  conflict: boolean;
  draft: ComputeNodePolicyFormDraft | null;
  editing: boolean;
  error: string | null;
  notice: string | null;
  saving: boolean;
}

function policyDraftSnapshot(policy: ComputeNodePolicySummary | null) {
  const draft = policy ? createComputeNodePolicyDraft(policy) : null;
  return { baseline: draft, baseRevision: policy?.revision ?? null, draft };
}

function initialPolicyEditor(policy: ComputeNodePolicySummary | null): PolicyEditorState {
  return {
    ...policyDraftSnapshot(policy), conflict: false, editing: false,
    error: null, notice: null, saving: false,
  };
}

type PolicyEditorUpdate = Partial<PolicyEditorState> | ((state: PolicyEditorState) => Partial<PolicyEditorState>);

function updatePolicyEditor(state: PolicyEditorState, update: PolicyEditorUpdate): PolicyEditorState {
  return { ...state, ...(typeof update === "function" ? update(state) : update) };
}

export function ComputeNodePolicyEditor({
  nodeId,
  policy,
  snapshot,
  canEdit,
  onUpdate,
}: {
  readonly nodeId: string;
  readonly policy: ComputeNodePolicySummary | null;
  readonly snapshot: ComputeNodeSnapshotSummary;
  readonly canEdit: boolean;
  readonly onUpdate?: UpdatePolicy;
}) {
  const [{ baseline, baseRevision, conflict, draft, editing, error, notice, saving }, updateEditor] =
    useReducer(updatePolicyEditor, policy, initialPolicyEditor);
  const allowedGpuUuids = new Set(draft?.allowedGpuUuids);

  const deviceOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const gpu of snapshot.gpus.value ?? []) names.set(gpu.uuid, gpu.name.value ?? "GPU name unavailable");
    for (const uuid of policy?.allowedGpuUuids ?? []) if (!names.has(uuid)) names.set(uuid, "Not present in the latest inventory");
    for (const uuid of Object.keys(policy?.gpuVramReserves ?? {})) if (!names.has(uuid)) names.set(uuid, "Not present in the latest inventory");
    return [...names].sort(([left], [right]) => left.localeCompare(right));
  }, [policy, snapshot.gpus.value]);

  const dirty = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline);
  const revisionChanged = editing && policy !== null && baseRevision !== null && policy.revision !== baseRevision;
  const needsRebase = conflict || revisionChanged;

  const updateDraft = <K extends keyof ComputeNodePolicyFormDraft>(
    key: K,
    value: ComputeNodePolicyFormDraft[K],
  ) => updateEditor((current) => current.draft ? { draft: { ...current.draft, [key]: value } } : {});

  const startEditing = () => {
    if (!policy) return;
    updateEditor({ ...initialPolicyEditor(policy), editing: true });
  };

  const cancelEditing = () => {
    updateEditor(initialPolicyEditor(policy));
  };

  const rebaseDraft = () => {
    if (!policy) return;
    // Preserve the operator's form values. The next Apply will use this
    // explicitly selected server revision as its If-Match precondition.
    updateEditor({
      baseline: createComputeNodePolicyDraft(policy), baseRevision: policy.revision,
      conflict: false, error: null,
      notice: `Draft retained against policy revision ${policy.revision}. Review the saved values above, then apply when ready.`,
    });
  };

  const save = async () => {
    if (!draft || !policy || !onUpdate || baseRevision === null || needsRebase) return;
    const result = buildComputeNodePolicyUpdate(draft);
    if (!result.ok) {
      updateEditor({ error: result.error, notice: null });
      return;
    }
    updateEditor({ saving: true, error: null, notice: null });
    try {
      const saved = await onUpdate(nodeId, baseRevision, { policy: result.policy });
      updateEditor({
        ...policyDraftSnapshot(saved), conflict: false, editing: false,
        notice: `Policy saved as revision ${saved.revision}. Existing reservations were not changed.`,
      });
    } catch (cause) {
      if (cause instanceof ControlRoomApiError && (cause.status === 409 || cause.status === 412)) {
        updateEditor({
          conflict: true,
          error: "The saved policy changed while you were editing. Your draft is preserved; refresh and compare the saved values before rebasing it.",
        });
      } else {
        updateEditor({ error: cause instanceof Error ? cause.message : "The host policy could not be saved." });
      }
    } finally {
      updateEditor({ saving: false });
    }
  };

  return (
    <div className="fm-start-compute-settings__policy-editor">
      <div className="fm-start-compute-settings__policy-editor-head">
        <div>
          <h5>Host admission policy</h5>
          <p>Changes affect future admissions. Running reservations keep their existing allocation.</p>
        </div>
        {policy ? <span className="fm-start-compute-settings__status" data-state={policy.overBudget || policy.blockingReasons.length > 0 ? "unavailable" : policy.draining ? "unknown" : "ready"}>
          {policy.overBudget ? "Existing work exceeds policy" : policy.draining ? "Draining" : policy.blockingReasons.length > 0 ? "Existing policy conflict" : policy.activeWorkers >= policy.maxParallelWorkers ? "Worker limit reached" : "Accepting new work"}
        </span> : null}
      </div>

      {!policy ? (
        <p className="fm-start-compute-settings__reason">No host admission policy is configured for this node, so there is nothing to edit.</p>
      ) : !canEdit || !onUpdate ? (
        <p className="fm-start-compute-settings__reason">Policy editing is available in the local Fullmag desktop app. This browser view is read-only.</p>
      ) : !editing ? (
        <Button onClick={startEditing} size="sm" type="button" variant="secondary">Edit policy</Button>
      ) : draft ? (
        <div className="fm-start-compute-settings__policy-form">
          {needsRebase ? (
            <div className="fm-start-compute-settings__policy-conflict" role="alert">
              <p>Policy revision {baseRevision} is no longer current. The saved policy is now revision {policy.revision}; your draft is still intact.</p>
              <dl>
                <div><dt>Saved allowed CPUs</dt><dd>{policy.allowedCpuIds.length ? policy.allowedCpuIds.join(", ") : "None"}</dd></div>
                <div><dt>Draft allowed CPUs</dt><dd>{draft.allowedCpuIds || "None"}</dd></div>
                <div><dt>Saved allowed GPUs</dt><dd>{policy.allowedGpuUuids.join(", ") || "None"}</dd></div>
                <div><dt>Draft allowed GPUs</dt><dd>{draft.allowedGpuUuids.join(", ") || "None"}</dd></div>
                <div><dt>Saved CPU reserve</dt><dd>{policy.cpuReserveMillis / 1000}</dd></div>
                <div><dt>Draft CPU reserve</dt><dd>{draft.cpuReserve}</dd></div>
                <div><dt>Saved RAM reserve</dt><dd>{bytesToGiB(policy.memoryReserveBytes)} GiB</dd></div>
                <div><dt>Draft RAM reserve</dt><dd>{draft.memoryReserveGiB} GiB</dd></div>
                <div><dt>Saved scratch reserve</dt><dd>{bytesToGiB(policy.scratchReserveBytes)} GiB</dd></div>
                <div><dt>Draft scratch reserve</dt><dd>{draft.scratchReserveGiB} GiB</dd></div>
                <div><dt>Saved max workers</dt><dd>{policy.maxParallelWorkers}</dd></div>
                <div><dt>Draft max workers</dt><dd>{draft.maxParallelWorkers}</dd></div>
                <div><dt>Saved admission</dt><dd>{policy.draining ? "Draining" : "Accepting"}</dd></div>
                <div><dt>Draft admission</dt><dd>{draft.draining ? "Draining" : "Accepting"}</dd></div>
              </dl>
              {policy.revision !== baseRevision ? (
                <Button disabled={saving} onClick={rebaseDraft} size="sm" type="button" variant="secondary">
                  Keep draft and use revision {policy.revision}
                </Button>
              ) : null}
            </div>
          ) : null}

          <label className="fm-start-compute-settings__policy-field">
            <span>Allowed logical CPU IDs</span>
            <Input
              autoComplete="off"
              disabled={saving}
              onChange={(event) => updateDraft("allowedCpuIds", event.currentTarget.value)}
              spellCheck={false}
              value={draft.allowedCpuIds}
            />
            <small>Enter IDs or ascending ranges, for example 0-7, 12. The host validates IDs and configured capacity.</small>
          </label>

          <fieldset className="fm-start-compute-settings__policy-fieldset">
            <legend>Allowed GPU devices</legend>
            {deviceOptions.length ? deviceOptions.map(([uuid, name]) => (
              <label className="fm-start-compute-settings__policy-check" key={uuid}>
                <Checkbox
                  checked={allowedGpuUuids.has(uuid)}
                  disabled={saving}
                  onChange={(event) => {
                    const selected = new Set(draft.allowedGpuUuids);
                    if (event.currentTarget.checked) selected.add(uuid);
                    else selected.delete(uuid);
                    updateDraft("allowedGpuUuids", [...selected].sort());
                  }}
                />
                <span>{name} · {uuid}</span>
              </label>
            )) : <p className="fm-start-compute-settings__reason">No GPU UUIDs were reported by this snapshot. The saved allowlist remains empty.</p>}
          </fieldset>

          <div className="fm-start-compute-settings__policy-fields">
            <NumberField disabled={saving} label="CPU reserve (CPU equivalents)" onChange={(value) => updateDraft("cpuReserve", value)} step="0.001" value={draft.cpuReserve} />
            <NumberField disabled={saving} label="RAM reserve (GiB)" onChange={(value) => updateDraft("memoryReserveGiB", value)} step="0.1" value={draft.memoryReserveGiB} />
            <NumberField disabled={saving} label="Scratch reserve (GiB)" onChange={(value) => updateDraft("scratchReserveGiB", value)} step="0.1" value={draft.scratchReserveGiB} />
            <NumberField disabled={saving} label="Maximum active workers" onChange={(value) => updateDraft("maxParallelWorkers", value)} step="1" value={draft.maxParallelWorkers} />
          </div>

          {deviceOptions.length ? (
            <fieldset className="fm-start-compute-settings__policy-fieldset">
              <legend>Per-device VRAM reserve</legend>
              <div className="fm-start-compute-settings__policy-fields">
                {deviceOptions.map(([uuid, name]) => (
                  <NumberField
                    disabled={saving}
                    key={uuid}
                    label={`${name} · ${uuid} (GiB)`}
                    onChange={(value) => updateDraft("gpuVramReserveGiB", { ...draft.gpuVramReserveGiB, [uuid]: value })}
                    step="0.1"
                    value={draft.gpuVramReserveGiB[uuid] ?? "0"}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}

          <div className="fm-start-compute-settings__policy-check">
            <Switch
              aria-label="Drain this node: block new admissions while existing work finishes"
              checked={draft.draining}
              disabled={saving}
              onCheckedChange={(checked) => updateDraft("draining", checked)}
            />
            <span>Drain this node: block new admissions while existing work finishes</span>
          </div>

          <p className="fm-start-compute-settings__reason">Priority order and allowed parallelism patterns are preserved from the current policy. The host validates reserves against configured capacity before saving. GPU sharing stays exclusive; OutputStorage remains a separate setting.</p>
          {error ? <p className="fm-start-compute-settings__error" role="alert">{error}</p> : null}
          {notice ? <p className="fm-start-compute-settings__notice" role="status">{notice}</p> : null}
          <div className="fm-start-compute-settings__policy-actions">
            <Button disabled={saving || !dirty || needsRebase} onClick={() => void save()} size="sm" type="button" variant="primary">
              {saving ? "Saving…" : "Apply policy"}
            </Button>
            <Button disabled={saving} onClick={cancelEditing} size="sm" type="button" variant="secondary">Revert</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly step: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="fm-start-compute-settings__policy-field">
      <span>{label}</span>
      <Input
        disabled={disabled}
        min="0"
        onChange={(event) => onChange(event.currentTarget.value)}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

function bytesToGiB(bytes: number): string {
  return Number.isSafeInteger(bytes) && bytes >= 0
    ? (bytes / (1024 ** 3)).toString()
    : "Unavailable";
}
