"use client";

import * as Dialog from "@radix-ui/react-dialog";

import type { CommandDetailResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

export function CommandDetailDialog({
  commandId,
  detail,
  onOpenChange,
}: {
  commandId: string | null;
  detail: ResourceResult<CommandDetailResource | null>;
  onOpenChange: (open: boolean) => void;
}) {
  const command = detail.data;

  return (
    <Dialog.Root open={commandId !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        {commandId ? (
          <>
            <Dialog.Overlay className="fm-dialog__overlay" />
            <Dialog.Content className="fm-dialog" aria-label="Command detail">
              <Dialog.Title className="fm-dialog__title">
                {command?.kind ?? "Command"} detail
              </Dialog.Title>
              <Dialog.Description className="fm-dialog__description">
                {commandId}
              </Dialog.Description>
              {detail.status === "loading" ? (
                <p className="fm-dialog__description">Loading command detail…</p>
              ) : null}
              {detail.status === "error" ? (
                <p className="fm-dialog__description">
                  {detail.error instanceof Error
                    ? detail.error.message
                    : "Command detail unavailable."}
                </p>
              ) : null}
              {command ? <CommandDetailBody command={command} /> : null}
              {detail.status !== "loading" && !detail.error && !command ? (
                <p className="fm-dialog__description">
                  Command detail unavailable.
                </p>
              ) : null}
              <div className="fm-dialog__actions">
                <Dialog.Close asChild>
                  <button className="fm-button fm-button--secondary" type="button">
                    Close
                  </button>
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </>
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CommandDetailBody({
  command,
}: {
  command: CommandDetailResource;
}) {
  return (
    <>
      <dl className="fm-dialog__details">
        <CommandDetailRow label="Status" value={command.status} />
        <CommandDetailRow label="Kind" value={command.kind} />
        <CommandDetailRow label="Seq" value={String(command.seq)} />
        <CommandDetailRow label="Run ID" value={command.run_id ?? "—"} />
        <CommandDetailRow
          label="Requested execution"
          value={formatExecutionReadback(command.requested_execution)}
        />
        <CommandDetailRow
          label="Resolved execution"
          value={formatExecutionReadback(command.resolved_execution)}
        />
        <CommandDetailRow label="Reason" value={command.reason ?? "—"} />
        <CommandDetailRow
          label="Completion"
          value={command.completion_status ?? "—"}
        />
        <CommandDetailRow
          label="Accepted"
          value={formatCommandTimestamp(command.accepted_at_unix_ms)}
        />
        <CommandDetailRow
          label="Requested"
          value={formatCommandTimestamp(command.requested_at_unix_ms)}
        />
        <CommandDetailRow
          label="Created"
          value={formatCommandTimestamp(command.created_at_unix_ms)}
        />
        <CommandDetailRow
          label="Dispatched"
          value={formatCommandTimestamp(command.dispatched_at_unix_ms)}
        />
        <CommandDetailRow
          label="Started"
          value={formatCommandTimestamp(command.started_at_unix_ms)}
        />
        <CommandDetailRow
          label="Completed"
          value={formatCommandTimestamp(command.completed_at_unix_ms)}
        />
        <CommandDetailRow
          label="Terminal"
          value={formatCommandTimestamp(command.terminal_at_unix_ms)}
        />
        <CommandDetailRow label="Stage ID" value={command.stage_id ?? "—"} />
        <CommandDetailRow
          label="Stage index"
          value={command.stage_index == null ? "—" : String(command.stage_index)}
        />
        <CommandDetailRow
          label="Resource invalidations"
          value={formatResourceInvalidations(command.resource_invalidations)}
        />
        <CommandDetailRow
          label="Diagnostics"
          value={formatDiagnosticReferences(command.diagnostics)}
        />
        <CommandDetailRow
          label="Checkpoint"
          value={command.checkpoint_ref ?? "—"}
        />
        <CommandDetailRow
          label="Loaded state"
          value={command.loaded_state_ref ?? "—"}
        />
        <CommandDetailRow
          label="Resume from"
          value={command.resume_from_checkpoint_ref ?? "—"}
        />
        <CommandDetailRow
          label="State transition"
          value={command.state_transition ?? "—"}
        />
        <CommandDetailRow label="Error" value={command.error ?? "—"} />
      </dl>
      <pre className="fm-dialog__mesh-log">
        {JSON.stringify(
          {
            artifact_refs: command.artifact_refs ?? [],
            diagnostics: command.diagnostics ?? [],
            mesh_reason: command.mesh_reason ?? null,
            mesh_target: command.mesh_target ?? null,
            precondition: command.precondition ?? null,
            resource_invalidations: command.resource_invalidations ?? [],
            target: command.target ?? null,
          },
          null,
          2,
        )}
      </pre>
    </>
  );
}

export function formatCommandTimestamp(
  value: number | null | undefined,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : "—";
}

export function formatExecutionReadback(
  value: CommandDetailResource["requested_execution"] | null | undefined,
): string {
  if (!value) return "—";
  const primary = [value.backend, value.device, value.precision, value.mode].filter(
    Boolean,
  );
  const detail = [
    value.runtime_family ? `runtime=${value.runtime_family}` : null,
    value.engine_id ? `engine=${value.engine_id}` : null,
    value.worker ? `worker=${value.worker}` : null,
  ].filter(Boolean);
  const parts = [...primary, ...detail];
  return parts.length > 0 ? parts.join(" / ") : "—";
}

function formatResourceInvalidations(
  invalidations: CommandDetailResource["resource_invalidations"] | null | undefined,
): string {
  if (!invalidations?.length) return "—";
  return invalidations
    .map(
      (entry) =>
        `${entry.resource_key}@${entry.revision} ${entry.state}: ${entry.reason}`,
    )
    .join("; ");
}

function formatDiagnosticReferences(
  diagnostics: CommandDetailResource["diagnostics"] | null | undefined,
): string {
  if (!diagnostics?.length) return "—";
  return diagnostics
    .map(
      (entry) =>
        `${entry.severity}: ${entry.resource_key}@${entry.revision} ${entry.message}`,
    )
    .join("; ");
}

function CommandDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fm-dialog__details-row">
      <dt className="fm-dialog__details-label">{label}</dt>
      <dd className="fm-dialog__details-value">{value}</dd>
    </div>
  );
}
