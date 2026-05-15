"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronsUpDown,
  Maximize2,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { CommandDetailResource } from "@/kernel/api/apiTypes";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import { useCommandDetailResource } from "@/kernel/resources/studyRuntimeResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  buildTransportMessagePreview,
  formatTransportByteSize,
  formatTransportDuration,
  formatTransportTimestamp,
  formatTransportTimestampSignature,
  type FooterLogSort,
  type FooterLogSortKey,
  serializeTransportEntry,
  sortTransportEntries,
  summarizeTransportPath,
  resolveTransportCorrelation,
} from "./footerModel";

export function TransportLogTable({
  entries,
}: {
  entries: RequestDiagnosticEntry[];
}) {
  const [selectedEntry, setSelectedEntry] =
    useState<RequestDiagnosticEntry | null>(null);
  const [sort, setSort] = useState<FooterLogSort>({
    direction: "desc",
    key: "time",
  });
  const sortedEntries = useMemo(
    () => sortTransportEntries(entries, sort),
    [entries, sort],
  );

  if (entries.length === 0) {
    return (
      <div className="fm-footer__empty" role="status">
        No transport events captured yet.
      </div>
    );
  }

  return (
    <>
      <div className="fm-footer-log" role="table" aria-label="Transport logs">
        <div
          className="fm-footer-log__row fm-footer-log__row--header"
          role="row"
        >
          <SortableHeader
            label="Time"
            sort={sort}
            sortKey="time"
            onSort={setSort}
          />
          <span role="columnheader">Message</span>
          <SortableHeader
            label="Dir"
            sort={sort}
            sortKey="direction"
            onSort={setSort}
          />
          <SortableHeader
            label="Channel"
            sort={sort}
            sortKey="channel"
            onSort={setSort}
          />
          <SortableHeader
            label="Status"
            sort={sort}
            sortKey="status"
            onSort={setSort}
          />
          <SortableHeader
            label="Size"
            sort={sort}
            sortKey="size"
            onSort={setSort}
          />
          <SortableHeader
            label="Latency"
            sort={sort}
            sortKey="latency"
            onSort={setSort}
          />
        </div>
        {sortedEntries.map((entry) => (
          <div className="fm-footer-log__row" role="row" key={entry.id}>
            <time
              role="cell"
              dateTime={formatTransportTimestampSignature(entry.timestampMs)}
              title={formatTransportTimestampSignature(entry.timestampMs)}
            >
              {formatTransportTimestamp(entry.timestampMs)}
            </time>
            <span role="cell" className="fm-footer-log__message-cell">
              <button
                type="button"
                className="fm-footer-log__message"
                onClick={() => setSelectedEntry(entry)}
                title={summarizeTransportPath(entry)}
              >
                <span>{buildTransportMessagePreview(entry)}</span>
                <Maximize2 size={12} aria-hidden="true" />
              </button>
            </span>
            <span role="cell">
              <DirectionBadge entry={entry} />
            </span>
            <span role="cell">{entry.channel.toUpperCase()}</span>
            <span role="cell">{formatStatus(entry)}</span>
            <span role="cell">{formatTransportByteSize(entry.byteLength)}</span>
            <span role="cell">{formatTransportDuration(entry.durationMs)}</span>
          </div>
        ))}
      </div>

      <TransportLogDetailsDialog
        entry={selectedEntry}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedEntry(null);
          }
        }}
      />
    </>
  );
}

function SortableHeader({
  label,
  onSort,
  sort,
  sortKey,
}: {
  label: string;
  onSort: (sort: FooterLogSort) => void;
  sort: FooterLogSort;
  sortKey: FooterLogSortKey;
}) {
  const active = sort.key === sortKey;
  const Icon = active
    ? sort.direction === "asc"
      ? ArrowUpNarrowWide
      : ArrowDownWideNarrow
    : ChevronsUpDown;

  return (
    <span
      role="columnheader"
      aria-sort={
        active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        className="fm-footer-log__sort"
        data-active={active}
        onClick={() =>
          onSort({
            direction:
              active && sort.direction === "asc" ? "desc" : "asc",
            key: sortKey,
          })
        }
      >
        <span>{label}</span>
        <Icon size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

function DirectionBadge({ entry }: { entry: RequestDiagnosticEntry }) {
  const Icon = entry.direction === "rx" ? ArrowDownToLine : ArrowUpFromLine;

  return (
    <span className="fm-footer-log__direction" data-direction={entry.direction}>
      <Icon size={13} aria-hidden="true" />
      {entry.direction.toUpperCase()}
    </span>
  );
}

function TransportLogDetailsDialog({
  entry,
  onOpenChange,
}: {
  entry: RequestDiagnosticEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const correlation = entry ? resolveTransportCorrelation(entry) : null;
  const commandDetail = useCommandDetailResource(correlation?.commandId);

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      {entry && correlation ? (
        <DialogContent className="fm-footer-log-dialog">
          <DialogHeader>
            <DialogTitle>{buildTransportMessagePreview(entry)}</DialogTitle>
            <DialogDescription>
              {formatTransportTimestampSignature(entry.timestampMs)}
            </DialogDescription>
          </DialogHeader>
          <div className="fm-dialog__body">
            <dl className="fm-dialog__details">
              <DetailRow label="Request ID" value={entry.requestId} />
              <DetailRow label="Resource" value={correlation.resourceKey} />
              <DetailRow label="Command ID" value={correlation.commandId ?? "—"} />
              <DetailRow label="Stage ID" value={correlation.stageId ?? "—"} />
              <DetailRow label="Channel" value={entry.channel.toUpperCase()} />
              <DetailRow label="Direction" value={entry.direction.toUpperCase()} />
              <DetailRow label="Method" value={entry.method} />
              <DetailRow label="Target" value={summarizeTransportPath(entry)} />
              <DetailRow label="Status" value={formatStatus(entry)} />
              <DetailRow
                label="Payload"
                value={formatTransportByteSize(entry.byteLength)}
              />
              <DetailRow
                label="Latency"
                value={formatTransportDuration(entry.durationMs)}
              />
              <DetailRow label="Content Type" value={entry.contentType ?? "—"} />
              <DetailRow label="Detail" value={entry.detail ?? "—"} />
            </dl>
            <pre className="fm-footer-log-dialog__raw">
              {serializeTransportEntry(entry)}
            </pre>
            <CommandCorrelationPanel
              commandId={correlation.commandId}
              detail={commandDetail}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function CommandCorrelationPanel({
  commandId,
  detail,
}: {
  commandId: string | null;
  detail: ResourceResult<CommandDetailResource | null>;
}) {
  const command = detail.data;
  if (!commandId) return null;

  if (detail.status === "loading") {
    return (
      <p className="fm-dialog__description">
        Loading correlated command detail.
      </p>
    );
  }

  if (detail.error) {
    return <pre className="fm-dialog__error">{String(detail.error)}</pre>;
  }

  if (!command) {
    return (
      <p className="fm-dialog__description">
        Correlated command detail unavailable.
      </p>
    );
  }

  return (
    <dl className="fm-dialog__details" aria-label="Correlated command detail">
      <DetailRow label="Command status" value={command.status} />
      <DetailRow label="Command kind" value={command.kind} />
      <DetailRow label="Command seq" value={String(command.seq)} />
      <DetailRow label="Command run" value={command.run_id ?? "—"} />
      <DetailRow
        label="Requested execution"
        value={formatExecutionReadback(command.requested_execution)}
      />
      <DetailRow
        label="Resolved execution"
        value={formatExecutionReadback(command.resolved_execution)}
      />
      <DetailRow label="Command reason" value={command.reason ?? "—"} />
      <DetailRow label="Completion" value={command.completion_status ?? "—"} />
      <DetailRow
        label="Accepted"
        value={formatCommandTimestamp(command.accepted_at_unix_ms)}
      />
      <DetailRow
        label="Started"
        value={formatCommandTimestamp(command.started_at_unix_ms)}
      />
      <DetailRow
        label="Terminal"
        value={formatCommandTimestamp(command.terminal_at_unix_ms)}
      />
      <DetailRow label="Stage ID" value={command.stage_id ?? "—"} />
      <DetailRow
        label="Stage index"
        value={command.stage_index == null ? "—" : String(command.stage_index)}
      />
      <DetailRow
        label="Resource invalidations"
        value={formatResourceInvalidations(command.resource_invalidations)}
      />
      <DetailRow
        label="Diagnostics"
        value={formatDiagnosticReferences(command.diagnostics)}
      />
      <DetailRow label="Checkpoint" value={command.checkpoint_ref ?? "—"} />
      <DetailRow label="Loaded state" value={command.loaded_state_ref ?? "—"} />
      <DetailRow
        label="Resume from"
        value={command.resume_from_checkpoint_ref ?? "—"}
      />
      <DetailRow
        label="State transition"
        value={command.state_transition ?? "—"}
      />
      <DetailRow label="Command error" value={command.error ?? "—"} />
    </dl>
  );
}

function formatCommandTimestamp(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : "—";
}

function formatExecutionReadback(
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="fm-dialog__details-row">
      <dt className="fm-dialog__details-label">{label}</dt>
      <dd className="fm-dialog__details-value">{value}</dd>
    </div>
  );
}

function formatStatus(entry: RequestDiagnosticEntry): string {
  if (entry.status !== null) {
    return `${entry.status} ${entry.outcome}`;
  }

  return entry.outcome;
}
