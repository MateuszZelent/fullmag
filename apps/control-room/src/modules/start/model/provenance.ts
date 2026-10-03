import { tauriInvoke } from "@/kernel/persistence/ProjectDocumentController";

import type { Author, AuthorRole } from "./types";

export type HistoryKind = "edit" | "run" | "migrate" | "import" | "restore";
export type RunStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

export interface HistoryEntry {
  readonly revision: number;
  readonly at: string;
  readonly by?: string;
  readonly kind: HistoryKind;
  readonly summary: string;
  readonly changes?: readonly string[];
  readonly runId?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly revision?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly durationSeconds?: number;
  readonly status: RunStatus;
  readonly device?: string;
  readonly backend?: string;
  readonly outputBytes?: number;
  readonly frames?: number;
  readonly error?: string;
}

export interface Citation {
  readonly doi?: string;
  readonly url?: string;
  readonly preferredBibtex?: string;
  readonly license?: string;
}

export interface Provenance {
  /** False for a project with no provenance document: it predates tracking. */
  readonly recorded: boolean;
  readonly authors: readonly Author[];
  readonly citation: Citation;
  /** Newest first. */
  readonly history: readonly HistoryEntry[];
  /** Newest first. */
  readonly runs: readonly RunRecord[];
}

export type ProvenanceState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly provenance: Provenance }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error"; readonly message: string };

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const ROLES: readonly AuthorRole[] = ["creator", "contributor", "maintainer"];
const KINDS: readonly HistoryKind[] = ["edit", "run", "migrate", "import", "restore"];
const STATUSES: readonly RunStatus[] = ["queued", "running", "ready", "failed", "cancelled"];

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

function toAuthor(value: unknown): Author | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  if (!name) return null;
  return {
    name,
    email: str(value.email),
    affiliation: str(value.affiliation),
    orcid: str(value.orcid),
    role: ROLES.find((r) => r === value.role) ?? "contributor",
  };
}

function toHistory(value: unknown): HistoryEntry | null {
  if (!isRecord(value)) return null;
  const revision = num(value.revision);
  const at = str(value.at);
  const summary = str(value.summary);
  const kind = KINDS.find((k) => k === value.kind);
  if (revision === undefined || !at || !summary || !kind) return null;
  const changes = Array.isArray(value.changes)
    ? value.changes.filter((c): c is string => typeof c === "string")
    : undefined;
  return {
    revision,
    at,
    kind,
    summary,
    by: str(value.by),
    runId: str(value.run_id),
    changes: changes && changes.length > 0 ? changes : undefined,
  };
}

function toRun(value: unknown): RunRecord | null {
  if (!isRecord(value)) return null;
  const runId = str(value.run_id);
  const startedAt = str(value.started_at);
  const status = STATUSES.find((s) => s === value.status);
  if (!runId || !startedAt || !status) return null;
  return {
    runId,
    startedAt,
    status,
    revision: num(value.revision),
    finishedAt: str(value.finished_at),
    durationSeconds: num(value.duration_seconds),
    device: str(value.device),
    backend: str(value.backend),
    outputBytes: num(value.output_bytes),
    frames: num(value.frames),
    error: str(value.error),
  };
}

function list<T>(value: unknown, convert: (item: unknown) => T | null): T[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const converted = convert(item);
        return converted ? [converted] : [];
      })
    : [];
}

/** Normalise the host's answer; unusable input is `null`, never an empty record. */
export function parseProvenance(raw: unknown): Provenance | null {
  if (!isRecord(raw)) return null;
  const citation = isRecord(raw.citation) ? raw.citation : {};
  return {
    recorded: raw.recorded !== false,
    authors: list(raw.authors, toAuthor),
    citation: {
      doi: str(citation.doi),
      url: str(citation.url),
      preferredBibtex: str(citation.preferred_bibtex),
      license: str(citation.license),
    },
    history: list(raw.history, toHistory).sort((a, b) => time(b.at) - time(a.at) || b.revision - a.revision),
    runs: list(raw.runs, toRun).sort((a, b) => time(b.startedAt) - time(a.startedAt)),
  };
}

const bibtexSafe = (text: string) => text.replace(/[{}\\]/g, "");

function citationKey(authors: readonly Author[], name: string, year: number): string {
  const first = authors[0]?.name.trim().split(/\s+/).pop() ?? "fullmag";
  const word = name.split(/\s+/)[0] ?? "project";
  const ascii = (s: string) => s.normalize("NFD").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return `${ascii(first) || "fullmag"}${year}${ascii(word)}`;
}

export interface BibtexInput {
  readonly name: string;
  readonly authors: readonly Author[];
  readonly revision?: number;
  readonly year: number;
  readonly citation: Citation;
}

/**
 * BibTeX for the project, generated from authors, name and revision so a group
 * can cite a model the way it cites a dataset. A project tied to a published
 * dataset overrides it verbatim with `preferred_bibtex`.
 */
export function generateBibtex(input: BibtexInput): string {
  if (input.citation.preferredBibtex) return input.citation.preferredBibtex;
  const fields: [string, string][] = [];
  if (input.authors.length > 0) {
    fields.push(["author", input.authors.map((a) => bibtexSafe(a.name)).join(" and ")]);
  }
  fields.push(["title", bibtexSafe(input.name)]);
  fields.push(["year", String(input.year)]);
  fields.push([
    "note",
    `Fullmag project${input.revision !== undefined ? `, revision ${input.revision}` : ""}`,
  ]);
  if (input.citation.doi) fields.push(["doi", input.citation.doi]);
  if (input.citation.url) fields.push(["url", input.citation.url]);
  const key = citationKey(input.authors, input.name, input.year);
  return `@misc{${key},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
}

/** Ask the desktop host. `unavailable` is a host without the command, not a failure. */
export async function readProvenance(path: string): Promise<ProvenanceState> {
  const invoke = tauriInvoke();
  if (!invoke) return { kind: "unavailable" };
  try {
    const parsed = parseProvenance(await invoke<unknown>("project_provenance_read", { path }));
    return parsed ? { kind: "ready", provenance: parsed } : { kind: "error", message: "The host returned an unreadable record." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /not found|unknown command|not allowed/i.test(message)
      ? { kind: "unavailable" }
      : { kind: "error", message };
  }
}

/** Who the user is, for the greeting. `null` leaves the greeting generic. */
export async function readAuthorName(): Promise<string | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  try {
    const raw = await invoke<unknown>("author_identity");
    return isRecord(raw) ? (str(raw.name) ?? null) : null;
  } catch {
    return null;
  }
}
