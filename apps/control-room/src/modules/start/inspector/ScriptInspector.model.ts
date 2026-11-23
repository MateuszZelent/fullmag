import type { WorkspaceItem } from "../model/workspaceItems";
import type { ScriptDetail } from "../model/workspaceApiTypes";
import { kvRowOrUnavailable, type KvRow } from "./KeyValueGroup.model";
import { formatLines } from "../model/scriptRowModel";
import { formatBytes, formatOpened } from "../model/recentIndex";

/** Facts from the list row plus, when the backend read the file, its own. */
export function scriptFacts(item: WorkspaceItem, script: ScriptDetail | undefined): KvRow[] {
  const rows: KvRow[] = [];
  const lines =
    formatLines(item) ??
    (script?.lines !== undefined ? `${script.lines.toLocaleString("en-US")} lines` : undefined);
  if (lines) rows.push({ label: "Lines", value: lines });
  const size = item.sizeBytes ?? script?.bytes;
  if (size !== undefined) rows.push({ label: "Size", value: formatBytes(size) });
  if (item.modifiedAt) rows.push({ label: "Modified", value: formatOpened(item.modifiedAt) });
  if (item.firstSeenAt) rows.push({ label: "First seen", value: formatOpened(item.firstSeenAt) });
  rows.push({
    label: "Used",
    value: item.useCount === 1 ? "1 time" : `${item.useCount.toLocaleString("en-US")} times`,
  });
  const usesFullmag = item.meta.usesFullmag ?? script?.usesFullmag;
  if (usesFullmag !== undefined) {
    rows.push({
      label: "Uses fullmag",
      value: usesFullmag ? "Yes" : "No",
    });
  }
  if (script) {
    rows.push(...kvRowOrUnavailable("Encoding", script.encoding));
    rows.push(...kvRowOrUnavailable("SHA-256", script.sha256 ? script.sha256.slice(0, 12) : undefined));
  }
  return rows;
}
