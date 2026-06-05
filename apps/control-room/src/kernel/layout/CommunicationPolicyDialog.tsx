"use client";

import { useEffect, useState } from "react";

import type {
  RealtimeCommunicationPolicy,
  RealtimeCommunicationPolicyPatch,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  COMMUNICATION_POLICY_RESOURCE_KEY,
  useCommunicationPolicyResource,
} from "@/kernel/resources/communicationPolicyResource";
import { updateRealtimeCommunicationPolicy } from "@/kernel/realtime/communicationPolicy";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

interface CommunicationPolicyDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

type BooleanPolicyKey =
  | "resource_batch_changed_enabled"
  | "scalar_sample_enabled"
  | "field_samples_enabled"
  | "scalar_table_rows_enabled"
  | "lifecycle_events_enabled"
  | "diagnostics_enabled"
  | "heartbeat_enabled"
  | "visualization_client_acks_enabled";

type NumberPolicyKey =
  | "ws_replay_capacity"
  | "ws_heartbeat_ms"
  | "ws_reconnect_ms"
  | "lifecycle_coalesce_ms"
  | "table_rows_min_refetch_ms"
  | "field_sample_publish_ms"
  | "scalar_telemetry_publish_ms"
  | "diagnostics_summary_ms"
  | "status_refresh_ms"
  | "error_retry_ms";

const BOOLEAN_FIELDS: Array<{ key: BooleanPolicyKey; label: string }> = [
  { key: "resource_batch_changed_enabled", label: "Resource batch events" },
  { key: "scalar_sample_enabled", label: "Scalar samples" },
  { key: "field_samples_enabled", label: "Field sample invalidations" },
  { key: "scalar_table_rows_enabled", label: "Scalar table rows" },
  { key: "lifecycle_events_enabled", label: "Lifecycle events" },
  { key: "diagnostics_enabled", label: "Diagnostics" },
  { key: "heartbeat_enabled", label: "Heartbeat" },
  { key: "visualization_client_acks_enabled", label: "Visualization ACKs" },
];

const NUMBER_FIELDS: Array<{
  key: NumberPolicyKey;
  label: string;
  min: number;
  step: number;
}> = [
  {
    key: "scalar_telemetry_publish_ms",
    label: "Scalar sample ms",
    min: 50,
    step: 50,
  },
  {
    key: "field_sample_publish_ms",
    label: "Field samples ms",
    min: 250,
    step: 250,
  },
  {
    key: "table_rows_min_refetch_ms",
    label: "Table rows ms",
    min: 100,
    step: 100,
  },
  {
    key: "lifecycle_coalesce_ms",
    label: "Lifecycle window ms",
    min: 0,
    step: 50,
  },
  {
    key: "status_refresh_ms",
    label: "Status refresh ms",
    min: 250,
    step: 250,
  },
  {
    key: "diagnostics_summary_ms",
    label: "Diagnostics ms",
    min: 250,
    step: 250,
  },
  { key: "ws_heartbeat_ms", label: "Heartbeat ms", min: 250, step: 250 },
  { key: "ws_reconnect_ms", label: "Reconnect ms", min: 100, step: 100 },
  { key: "error_retry_ms", label: "Error retry ms", min: 100, step: 100 },
  { key: "ws_replay_capacity", label: "Replay capacity", min: 1, step: 1 },
];

export function CommunicationPolicyDialog({
  onOpenChange,
  open,
}: CommunicationPolicyDialogProps) {
  const { api, resources } = useKernel();
  const resource = useCommunicationPolicyResource({ enabled: open });
  const [draftState, setDraftState] = useState<{
    revision: number | null;
    value: RealtimeCommunicationPolicy;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const resourceRevision = open ? (resource.data?.revision ?? null) : null;
  const draft =
    draftState && draftState.revision === resourceRevision
      ? draftState.value
      : open && resource.data
        ? resource.data.effective
        : null;

  useEffect(() => {
    if (open && resource.data) {
      updateRealtimeCommunicationPolicy(resource.data.effective);
    }
  }, [open, resource.data]);

  const applyPatch = async (patch: RealtimeCommunicationPolicyPatch) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.events.patchCommunicationPolicy(patch);
      updateRealtimeCommunicationPolicy(updated.effective);
      resources.invalidate(COMMUNICATION_POLICY_RESOURCE_KEY, updated.revision);
      setDraftState({
        revision: updated.revision,
        value: { ...updated.effective },
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    void applyPatch(draft);
  };

  const resetDefaults = () => {
    void applyPatch({ reset: true });
  };

  const setBoolean = (key: BooleanPolicyKey, value: boolean) => {
    if (!draft) return;
    setDraftState({
      revision: resourceRevision,
      value: { ...draft, [key]: value },
    });
  };

  const setNumber = (key: NumberPolicyKey, value: number) => {
    if (!Number.isFinite(value)) return;
    if (!draft) return;
    setDraftState({
      revision: resourceRevision,
      value: { ...draft, [key]: value },
    });
  };

  const disabled = saving || resource.status === "loading" || !draft;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-communication-policy">
        <DialogHeader>
          <DialogTitle>Communication</DialogTitle>
          <DialogDescription>
            Backend realtime channels and refresh timings.
          </DialogDescription>
        </DialogHeader>

        <div className="fm-dialog__body">
          {resource.error ? (
            <div className="fm-communication-policy__error" role="alert">
              {resource.error.message}
            </div>
          ) : null}
          {saveError ? (
            <div className="fm-communication-policy__error" role="alert">
              {saveError}
            </div>
          ) : null}

          <section className="fm-communication-policy__section">
            <h3>Channels</h3>
            <div className="fm-communication-policy__toggles">
              {BOOLEAN_FIELDS.map((field) => (
                <label
                  className="fm-communication-policy__toggle"
                  key={field.key}
                >
                  <input
                    checked={Boolean(draft?.[field.key] ?? true)}
                    disabled={!draft || saving}
                    type="checkbox"
                    onChange={(event) =>
                      setBoolean(field.key, event.target.checked)
                    }
                  />
                  <span>{field.label}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="fm-communication-policy__section">
            <h3>Timings</h3>
            <div className="fm-communication-policy__grid">
              {NUMBER_FIELDS.map((field) => (
                <label
                  className="fm-communication-policy__number"
                  key={field.key}
                >
                  <span>{field.label}</span>
                  <input
                    disabled={!draft || saving}
                    min={field.min}
                    step={field.step}
                    type="number"
                    value={draft?.[field.key] ?? ""}
                    onChange={(event) =>
                      setNumber(field.key, Number(event.target.value))
                    }
                  />
                </label>
              ))}
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button
            disabled={saving}
            type="button"
            variant="ghost"
            onClick={resetDefaults}
          >
            Reset defaults
          </Button>
          <Button
            disabled={disabled}
            type="button"
            variant="primary"
            onClick={saveDraft}
          >
            {saving ? "Applying" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
