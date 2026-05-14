"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Maximize2,
} from "lucide-react";
import { useState } from "react";

import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
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
  serializeTransportEntry,
  summarizeTransportPath,
} from "./footerModel";

export function TransportLogTable({
  entries,
}: {
  entries: RequestDiagnosticEntry[];
}) {
  const [selectedEntry, setSelectedEntry] =
    useState<RequestDiagnosticEntry | null>(null);

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
          <span role="columnheader">Time</span>
          <span role="columnheader">Message</span>
          <span role="columnheader">Dir</span>
          <span role="columnheader">Channel</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Size</span>
          <span role="columnheader">Latency</span>
        </div>
        {entries.map((entry) => (
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
