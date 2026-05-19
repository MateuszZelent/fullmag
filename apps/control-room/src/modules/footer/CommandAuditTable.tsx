import type { CommandDiagnosticEntry } from "@/kernel/commands/CommandDiagnosticsController";

import { formatTransportTimestampSignature } from "./footerModel";

export function CommandAuditTable({
  entries,
}: {
  entries: CommandDiagnosticEntry[];
}) {
  const latestEntries = entries.slice(0, 5);
  if (latestEntries.length === 0) {
    return null;
  }

  return (
    <section className="fm-footer-command-audit" aria-label="Command audit">
      <div
        className="fm-footer-command-audit__row fm-footer-command-audit__row--header"
        role="row"
      >
        <span role="columnheader">Command</span>
        <span role="columnheader">Source</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Detail</span>
      </div>
      {latestEntries.map((entry) => (
        <div className="fm-footer-command-audit__row" role="row" key={entry.id}>
          <span role="cell" title={formatTransportTimestampSignature(entry.timestampMs)}>
            {entry.commandId}
          </span>
          <span role="cell">{formatCommandSource(entry)}</span>
          <span role="cell" data-status={entry.status}>
            {entry.status}
          </span>
          <span role="cell">{entry.disabledReason ?? entry.message ?? "-"}</span>
        </div>
      ))}
    </section>
  );
}

function formatCommandSource(entry: CommandDiagnosticEntry): string {
  return entry.sourceDetail ? `${entry.source}:${entry.sourceDetail}` : entry.source;
}
