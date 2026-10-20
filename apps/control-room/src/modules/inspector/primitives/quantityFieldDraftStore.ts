/**
 * Raw-text drafts for Inspector quantity fields.
 *
 * A field writes here as soon as its text diverges from the committed value
 * and removes its entry once the text is committed or reverted. The owning
 * panel folds the summary into its Inspector edit session, so an unresolved
 * (incomplete/invalid) entry makes the session dirty and invalid and the
 * selection guard sees it. Raw text therefore never silently falls back to the
 * previous number.
 */

export type QuantityFieldDraftStatus = "incomplete" | "invalid" | "valid";

export interface QuantityFieldDraftEntry {
  readonly label: string;
  readonly message: string | null;
  readonly rawText: string;
  readonly status: QuantityFieldDraftStatus;
}

export interface QuantityFieldDraftSummary {
  /** Entries whose text differs from the committed value. */
  readonly pendingCount: number;
  /** Labels of entries that cannot be committed as typed. */
  readonly invalidLabels: readonly string[];
  /** Draft keys of those entries, for field-scoped blockers. */
  readonly invalidKeys: readonly string[];
}

export interface QuantityFieldDraftStore {
  clear: () => void;
  get: (key: string) => QuantityFieldDraftEntry | undefined;
  getSummary: () => QuantityFieldDraftSummary;
  getVersion: () => number;
  remove: (key: string) => void;
  report: (key: string, entry: QuantityFieldDraftEntry) => void;
  subscribe: (listener: () => void) => () => void;
}

export const EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY: QuantityFieldDraftSummary = Object.freeze({
  invalidKeys: Object.freeze([]) as readonly string[],
  invalidLabels: Object.freeze([]) as readonly string[],
  pendingCount: 0,
});

function sameEntry(left: QuantityFieldDraftEntry | undefined, right: QuantityFieldDraftEntry): boolean {
  return left !== undefined &&
    left.rawText === right.rawText &&
    left.status === right.status &&
    left.message === right.message &&
    left.label === right.label;
}

export function createQuantityFieldDraftStore(): QuantityFieldDraftStore {
  const entries = new Map<string, QuantityFieldDraftEntry>();
  const listeners = new Set<() => void>();
  let version = 0;
  let summary: QuantityFieldDraftSummary = EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY;

  function publish(): void {
    version += 1;
    const invalidKeys: string[] = [];
    const invalidLabels: string[] = [];
    for (const [key, entry] of entries) {
      if (entry.status === "valid") continue;
      invalidKeys.push(key);
      invalidLabels.push(entry.label);
    }
    summary = entries.size === 0
      ? EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY
      : Object.freeze({
          invalidKeys: Object.freeze(invalidKeys),
          invalidLabels: Object.freeze(invalidLabels),
          pendingCount: entries.size,
        });
    for (const listener of listeners) listener();
  }

  return Object.freeze({
    clear: () => {
      if (entries.size === 0) return;
      entries.clear();
      publish();
    },
    get: (key: string) => entries.get(key),
    getSummary: () => summary,
    getVersion: () => version,
    remove: (key: string) => {
      if (entries.delete(key)) publish();
    },
    report: (key: string, entry: QuantityFieldDraftEntry) => {
      if (sameEntry(entries.get(key), entry)) return;
      entries.set(key, entry);
      publish();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

/** User-facing apply-block text for unresolved quantity drafts, or undefined. */
export function quantityFieldDraftBlockReason(
  summary: QuantityFieldDraftSummary,
): string | undefined {
  if (summary.invalidLabels.length === 0) return undefined;
  const [first, ...rest] = summary.invalidLabels;
  return rest.length === 0
    ? `Correct ${first} before applying.`
    : `Correct ${first} and ${rest.length} more field${rest.length === 1 ? "" : "s"} before applying.`;
}
