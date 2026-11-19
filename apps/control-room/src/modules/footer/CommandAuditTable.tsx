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
    <details className="fm-footer-command-audit" aria-label="Command audit">
      <summary>Recent commands <span>{latestEntries.length} of {entries.length}</span></summary>
      <div className="fm-footer-command-audit__table">
        <table aria-label="Recent command audit">
          <thead>
            <tr className="fm-footer-command-audit__row fm-footer-command-audit__row--header">
              <th scope="col">Command</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {latestEntries.map((entry) => (
              <tr className="fm-footer-command-audit__row" key={entry.id}>
                <td title={formatTransportTimestampSignature(entry.timestampMs)}>{entry.commandId}</td>
                <td>{formatCommandSource(entry)}</td>
                <td data-status={entry.status}>{entry.status}</td>
                <td>{entry.disabledReason ?? entry.message ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function formatCommandSource(entry: CommandDiagnosticEntry): string {
  return entry.sourceDetail ? `${entry.source}:${entry.sourceDetail}` : entry.source;
}
