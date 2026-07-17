"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronsUpDown,
  Maximize2,
} from "lucide-react";
import { useMemo, useState, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  buildTransportTrafficSummary,
  formatTransportByteSize,
  formatTransportDuration,
  formatTransportRate,
  formatTransportTimestamp,
  formatTransportTimestampSignature,
  formatTransportWindow,
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
  const trafficSummary = useMemo(
    () => buildTransportTrafficSummary(entries),
    [entries],
  );
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 10,
  });

  if (entries.length === 0) {
    return (
      <div className="fm-footer__empty" role="status">
        No transport events captured yet.
      </div>
    );
  }

  return (
    <>
      <div className="fm-footer-traffic" aria-label="Transport traffic summary">
        <div className="fm-footer-traffic__metric">
          <span>Window</span>
          <strong>{formatTransportWindow(trafficSummary.windowMs)}</strong>
        </div>
        <div className="fm-footer-traffic__metric">
          <span>Events</span>
          <strong>{trafficSummary.totalCount}</strong>
        </div>
        <div className="fm-footer-traffic__metric">
          <span>Rate</span>
          <strong>
            {formatTransportRate(trafficSummary.estimatedEventsPerMinute)}
          </strong>
        </div>
        <div className="fm-footer-traffic__metric">
          <span>TX / RX</span>
          <strong>
            {trafficSummary.txCount} / {trafficSummary.rxCount}
          </strong>
        </div>
        <div className="fm-footer-traffic__metric">
          <span>HTTP / WS / Perf</span>
          <strong>
            {trafficSummary.httpCount} / {trafficSummary.websocketCount} /{" "}
            {trafficSummary.performanceCount}
          </strong>
        </div>
        <div className="fm-footer-traffic__metric">
          <span>Payload</span>
          <strong>{formatTransportByteSize(trafficSummary.byteLength)}</strong>
        </div>
        {trafficSummary.topEndpoints.length > 0 ? (
          <ol className="fm-footer-traffic__top" aria-label="Top transport targets">
            {trafficSummary.topEndpoints.map((endpoint) => (
              <li key={endpoint.label}>
                <span title={endpoint.label}>{endpoint.label}</span>
                <strong>
                  {endpoint.count}x · {formatTransportByteSize(endpoint.byteLength)}
                </strong>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <div className="fm-footer-log" ref={parentRef} role="table" aria-label="Transport logs">
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
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const entry = sortedEntries[virtualRow.index];
            if (!entry) return null;
            return (
              <div
                className="fm-footer-log__row"
                role="row"
                key={entry.id}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
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
            );
          })}
        </div>
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
  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      {entry ? (
        <TransportLogDetailsDialogContent
          entry={entry}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function TransportLogDetailsDialogContent({
  entry,
  onClose,
}: {
  entry: RequestDiagnosticEntry;
  onClose: () => void;
}) {
  const correlation = resolveTransportCorrelation(entry);
  const commandDetail = useCommandDetailResource(correlation.commandId);

  return (
    <DialogContent
      className="fm-footer-log-dialog"
      aria-describedby="fm-transport-log-dialog-description"
    >
      <DialogHeader>
        <DialogTitle>{buildTransportMessagePreview(entry)}</DialogTitle>
        <DialogDescription id="fm-transport-log-dialog-description">
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
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
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
