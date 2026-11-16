"use client";

import type { CheckpointEntry, SessionImportInspectResponse } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

export function RestoreCheckpointDialog({
  checkpoints,
  onConfirm,
  onOpenChange,
  onSelectCheckpoint,
  open,
  selectedCheckpointId,
}: {
  checkpoints: CheckpointEntry[];
  onConfirm: (checkpointId: string) => void;
  onOpenChange: (open: boolean) => void;
  onSelectCheckpoint: (checkpointId: string) => void;
  open: boolean;
  selectedCheckpointId: string | null;
}) {
  const checkpoint =
    checkpoints.find((entry) => entry.checkpoint_id === selectedCheckpointId) ??
    checkpoints[0] ??
    null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-study-command-dialog" aria-describedby="fm-restore-checkpoint-description">
        <DialogHeader>
          <DialogTitle>Restore checkpoint</DialogTitle>
          <DialogDescription id="fm-restore-checkpoint-description">
            {checkpoint
              ? `${checkpoint.resume_class} resume from ${checkpoint.checkpoint_id}`
              : "No checkpoint selected."}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          {checkpoints.length > 0 ? (
            <div className="fm-study-checkpoint-list" role="listbox">
              {checkpoints.map((entry) => (
                <button
                  key={entry.checkpoint_id}
                  className="fm-study-checkpoint-list__item"
                  data-selected={
                    entry.checkpoint_id === checkpoint?.checkpoint_id
                      ? "true"
                      : undefined
                  }
                  type="button"
                  role="option"
                  aria-selected={entry.checkpoint_id === checkpoint?.checkpoint_id}
                  onClick={() => onSelectCheckpoint(entry.checkpoint_id)}
                >
                  <span>{entry.checkpoint_id}</span>
                  <small>
                    {entry.resume_class} · step {entry.step}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
          <dl className="fm-dialog__details">
            <CommandDetailRow
              label="Checkpoint"
              value={checkpoint?.checkpoint_id ?? "—"}
            />
            <CommandDetailRow
              label="Resume class"
              value={checkpoint?.resume_class ?? "—"}
            />
            <CommandDetailRow label="Source" value={checkpoint?.source ?? "—"} />
            <CommandDetailRow
              label="Step"
              value={
                checkpoint?.step === null || checkpoint?.step === undefined
                  ? "—"
                  : String(checkpoint.step)
              }
            />
            <CommandDetailRow
              label="Stage ID"
              value={checkpoint?.stage_id ?? "—"}
            />
            <CommandDetailRow
              label="Command ID"
              value={checkpoint?.command_id ?? "—"}
            />
            <CommandDetailRow label="Run ID" value={checkpoint?.run_id ?? "—"} />
            <CommandDetailRow
              label="Backend"
              value={checkpoint?.backend_family ?? "—"}
            />
            <CommandDetailRow
              label="Mesh revision"
              value={
                checkpoint?.mesh_revision == null
                  ? "—"
                  : String(checkpoint.mesh_revision)
              }
            />
            <CommandDetailRow
              label="Field revision"
              value={
                checkpoint?.field_revision == null
                  ? "—"
                  : String(checkpoint.field_revision)
              }
            />
            <CommandDetailRow
              label="Scene revision"
              value={
                checkpoint?.scene_revision == null
                  ? "—"
                  : String(checkpoint.scene_revision)
              }
            />
            <CommandDetailRow
              label="Vector count"
              value={checkpoint ? String(checkpoint.vector_count) : "—"}
            />
            <CommandDetailRow
              label="Artifact"
              value={checkpoint?.artifact_ref ?? "—"}
            />
            <CommandDetailRow
              label="Checksum"
              value={checkpoint?.checksum ?? "—"}
            />
          </dl>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!checkpoint}
            onClick={() => {
              if (checkpoint) onConfirm(checkpoint.checkpoint_id);
            }}
          >
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImportStateDialog({
  error,
  fileName,
  inspection,
  inspecting,
  onConfirm,
  onFileSelected,
  onOpenChange,
  onRestoreModeChange,
  open,
  restoreMode,
}: {
  error: string | null;
  fileName: string | null;
  inspection: SessionImportInspectResponse["inspection"] | null;
  inspecting: boolean;
  onConfirm: () => void;
  onFileSelected: (file: File | null) => void;
  onOpenChange: (open: boolean) => void;
  onRestoreModeChange: (mode: string) => void;
  open: boolean;
  restoreMode: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="fm-study-command-dialog" aria-describedby="fm-import-state-description">
        <DialogHeader>
          <DialogTitle>Import state</DialogTitle>
          <DialogDescription id="fm-import-state-description">
            {fileName ?? "Choose a .fms file before committing import."}
          </DialogDescription>
        </DialogHeader>
        <div className="fm-dialog__body">
          <input
            aria-label="FMS file"
            accept=".fms,application/octet-stream"
            className="fm-study-file-input"
            type="file"
            onChange={(event) => {
              onFileSelected(event.currentTarget.files?.[0] ?? null);
            }}
          />
          {inspecting ? (
            <p className="fm-dialog__description">Inspecting .fms file…</p>
          ) : null}
          {error ? <pre className="fm-dialog__error">{error}</pre> : null}
          {inspection ? (
            <>
              <dl className="fm-dialog__details">
                <CommandDetailRow label="Session" value={inspection.session_id} />
                <CommandDetailRow label="Name" value={inspection.name} />
                <CommandDetailRow
                  label="Restore class"
                  value={inspection.restore_class}
                />
                <CommandDetailRow label="Profile" value={inspection.profile} />
                <CommandDetailRow
                  label="Runs"
                  value={String(inspection.run_count)}
                />
                <CommandDetailRow
                  label="Size"
                  value={`${inspection.total_size_bytes} bytes`}
                />
                <CommandDetailRow label="Saved" value={inspection.saved_at} />
                <CommandDetailRow
                  label="Latest checkpoint"
                  value={inspection.latest_checkpoint?.checkpoint_id ?? "—"}
                />
                <CommandDetailRow
                  label="Checkpoint step"
                  value={
                    inspection.latest_checkpoint?.step == null
                      ? "—"
                      : String(inspection.latest_checkpoint.step)
                  }
                />
                <CommandDetailRow
                  label="Warnings"
                  value={
                    inspection.warnings.length > 0
                      ? inspection.warnings.join("; ")
                      : "—"
                  }
                />
              </dl>
              <label className="fm-study-select">
                <span>Restore mode</span>
                <select
                  value={restoreMode}
                  onChange={(event) => onRestoreModeChange(event.target.value)}
                >
                  <option value="resume">resume</option>
                  <option value="initial_condition">initial_condition</option>
                  <option value="config_only">config_only</option>
                </select>
              </label>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!inspection || inspecting}
            onClick={onConfirm}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommandDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fm-dialog__details-row">
      <dt className="fm-dialog__details-label">{label}</dt>
      <dd className="fm-dialog__details-value">{value}</dd>
    </div>
  );
}

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read file."));
    };
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string") {
        reject(new Error("Failed to read file as base64."));
        return;
      }
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
}
