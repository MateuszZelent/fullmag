/**
 * Shapes, parsers, messages and the small state machine of "Run in new window"
 * (docs/design/start-screen/docs/08-script-open.md 6.1).
 *
 * Pure and free of the host bridge: the adapter feeds raw `invoke` results
 * through these parsers, so a host that answers with something unexpected is
 * rejected with a typed error. The renderer never holds a path it can run:
 * it holds a ticket, and the host re-reads and re-hashes the file itself.
 */

import { WorkspaceHostError } from "./workspaceItems";

export type ScriptEncoding = "utf-8" | "utf-8-bom" | "other";

export interface ScriptHandle {
  readonly ticket: string;
  readonly itemId: number | null;
  readonly name: string;
  readonly displayPath: string;
  readonly bytes: number;
  readonly lines: number;
  readonly sha256: string;
  readonly modifiedAt: string;
  readonly encoding: ScriptEncoding;
}

export type InterpreterInfo =
  | {
      readonly status: "resolved";
      readonly path: string;
      readonly version: string;
      readonly source: string;
      readonly isolated: boolean;
      readonly notes: readonly string[];
    }
  | { readonly status: "error"; readonly kind: string; readonly message: string };

export type SyntaxFact =
  | { readonly state: "ok" }
  | { readonly state: "error"; readonly line: number; readonly column: number; readonly message: string }
  | { readonly state: "unchecked" };

/** What `fullmag script inspect` found without executing the file. */
export interface PreflightFacts {
  readonly syntax: SyntaxFact;
  /** Top-level imports that do not resolve in the interpreter; null = not checked. */
  readonly unresolvedImports: readonly string[] | null;
  readonly envReads: readonly string[] | null;
  readonly summary: string | null;
  readonly interpreter: InterpreterInfo | null;
  /** The helper could not run: every Python fact is "not checked". */
  readonly degraded: boolean;
  readonly degradedReason: string | null;
}

export type RefusalCode =
  | "changed"
  | "syntax"
  | "interpreter"
  | "encoding"
  | "cli_missing"
  | "ticket"
  | "busy"
  | "confirm_required"
  | "storage";

export interface Refusal {
  readonly code: RefusalCode;
  readonly detail: string;
}

export interface ScriptPreflight {
  readonly ticket: string;
  readonly hashChanged: boolean;
  readonly facts: PreflightFacts | null;
  readonly refusal: Refusal | null;
  readonly cliFound: boolean;
  readonly activeRuns: number;
  readonly maxRuns: number;
  readonly warning: string | null;
}

export type RunState = "starting" | "materializing" | "waiting_for_solve" | "running" | "exited";

export type ReceiptOutcome = "completed" | "failed" | "cancelled" | "not_started";

export interface ReceiptSummary {
  readonly outcome: ReceiptOutcome;
  readonly exitCode: number | null;
  readonly durationSeconds: number | null;
  readonly error: string | null;
  readonly requestedDevice: string | null;
  readonly resolvedDevice: string | null;
  readonly resultsDir: string | null;
}

export interface ScriptRunStatus {
  readonly runHandle: string;
  readonly state: RunState;
  readonly exitCode: number | null;
  readonly receipt: ReceiptSummary | null;
  readonly windowOpen: boolean;
  readonly error: string | null;
}

export type ScriptRunResult =
  | {
      readonly status: "started";
      readonly runHandle: string;
      readonly pid: number;
      readonly interpreter: InterpreterInfo | null;
      readonly warning: string | null;
    }
  | { readonly status: "declined" }
  | { readonly status: "refused"; readonly code: RefusalCode; readonly detail: string };

export interface ScriptRunOptions {
  readonly device: "as_authored" | "auto" | "cpu" | "gpu";
  readonly waitForSolve: boolean;
  readonly results: "managed" | "next_to_script";
  readonly confirmOverwrite: boolean;
}

export const DEFAULT_RUN_OPTIONS: ScriptRunOptions = {
  device: "as_authored",
  waitForSolve: true,
  results: "managed",
  confirmOverwrite: false,
};

// ── parsers ─────────────────────────────────────────────────────────────

type Raw = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const strings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : null;

const invalid = (what: string): WorkspaceHostError =>
  new WorkspaceHostError("invalid_response", `The host returned an unexpected ${what}.`);

const ENCODINGS: readonly ScriptEncoding[] = ["utf-8", "utf-8-bom", "other"];
const REFUSAL_CODES: readonly RefusalCode[] = [
  "changed",
  "syntax",
  "interpreter",
  "encoding",
  "cli_missing",
  "ticket",
  "busy",
  "confirm_required",
  "storage",
];
const RUN_STATES: readonly RunState[] = [
  "starting",
  "materializing",
  "waiting_for_solve",
  "running",
  "exited",
];
const OUTCOMES: readonly ReceiptOutcome[] = ["completed", "failed", "cancelled", "not_started"];

export function parseScriptHandle(raw: unknown): ScriptHandle {
  if (!isRecord(raw)) throw invalid("script handle");
  const encoding = ENCODINGS.find((entry) => entry === raw.encoding);
  const ticket = str(raw.ticket);
  const name = str(raw.name);
  const displayPath = str(raw.display_path);
  const sha256 = str(raw.sha256);
  if (!ticket || !name || displayPath === null || !sha256 || !encoding) throw invalid("script handle");
  const itemId = num(raw.item_id);
  return {
    ticket,
    itemId: itemId !== null && Number.isInteger(itemId) ? itemId : null,
    name,
    displayPath,
    bytes: num(raw.bytes) ?? 0,
    lines: num(raw.lines) ?? 0,
    sha256,
    modifiedAt: str(raw.modified_at) ?? "",
    encoding,
  };
}

export function parseScriptPick(raw: unknown): ScriptHandle | null {
  return raw === null || raw === undefined ? null : parseScriptHandle(raw);
}

export function parseInterpreter(raw: unknown): InterpreterInfo | null {
  if (!isRecord(raw)) return null;
  if (raw.status === "resolved") {
    return {
      status: "resolved",
      path: str(raw.path) ?? "",
      version: str(raw.version) ?? "unknown",
      source: str(raw.source) ?? "unknown",
      isolated: raw.isolated === true,
      notes: strings(raw.notes) ?? [],
    };
  }
  if (raw.status === "error") {
    return {
      status: "error",
      kind: str(raw.kind) ?? "unknown",
      message: str(raw.message) ?? "No usable Python interpreter.",
    };
  }
  return null;
}

function parseSyntax(raw: unknown): SyntaxFact {
  if (!isRecord(raw)) return { state: "unchecked" };
  if (raw.ok === true) return { state: "ok" };
  if (raw.ok === false) {
    return {
      state: "error",
      line: num(raw.line) ?? 0,
      column: num(raw.column) ?? 0,
      message: str(raw.message) ?? "invalid syntax",
    };
  }
  return { state: "unchecked" };
}

export function parsePreflightFacts(raw: unknown): PreflightFacts | null {
  if (!isRecord(raw)) return null;
  const imports = isRecord(raw.imports) ? raw.imports : null;
  return {
    syntax: parseSyntax(raw.syntax),
    unresolvedImports: imports ? strings(imports.unresolved) : null,
    envReads: strings(raw.env_reads),
    summary: str(raw.summary),
    interpreter: parseInterpreter(raw.interpreter),
    degraded: raw.degraded === true,
    degradedReason: str(raw.degraded_reason),
  };
}

function parseRefusal(raw: unknown): Refusal | null {
  if (!isRecord(raw)) return null;
  const code = REFUSAL_CODES.find((entry) => entry === raw.code);
  return code ? { code, detail: str(raw.detail) ?? "" } : null;
}

export function parseScriptPreflight(raw: unknown): ScriptPreflight {
  if (!isRecord(raw)) throw invalid("preflight");
  const ticket = str(raw.ticket);
  if (!ticket) throw invalid("preflight");
  return {
    ticket,
    hashChanged: raw.hash_changed === true,
    facts: parsePreflightFacts(raw.inspect),
    refusal: parseRefusal(raw.refusal),
    cliFound: raw.cli_found !== false,
    activeRuns: Math.max(0, Math.trunc(num(raw.active_runs) ?? 0)),
    maxRuns: Math.max(1, Math.trunc(num(raw.max_runs) ?? 2)),
    warning: str(raw.warning),
  };
}

export function parseScriptRunResult(raw: unknown): ScriptRunResult {
  if (!isRecord(raw)) throw invalid("run result");
  switch (raw.status) {
    case "started": {
      const runHandle = str(raw.run_handle);
      if (!runHandle) throw invalid("run result");
      return {
        status: "started",
        runHandle,
        pid: num(raw.pid) ?? 0,
        interpreter: parseInterpreter(raw.interpreter),
        warning: str(raw.warning),
      };
    }
    case "declined":
      return { status: "declined" };
    case "refused": {
      const code = REFUSAL_CODES.find((entry) => entry === raw.code);
      if (!code) throw invalid("run result");
      return { status: "refused", code, detail: str(raw.detail) ?? "" };
    }
    default:
      throw invalid("run result");
  }
}

function parseReceipt(raw: unknown): ReceiptSummary | null {
  if (!isRecord(raw)) return null;
  const result = raw.outcome;
  if (!isRecord(result)) return null;
  const outcome = OUTCOMES.find((entry) => entry === result.status);
  if (!outcome) return null;
  const requested = isRecord(raw.requested) ? raw.requested : null;
  const resolved = isRecord(raw.resolved) ? raw.resolved : null;
  const results = isRecord(raw.results) ? raw.results : null;
  return {
    outcome,
    exitCode: num(result.exit_code),
    durationSeconds: num(result.duration_seconds),
    error: str(result.error),
    requestedDevice: requested ? str(requested.device) : null,
    resolvedDevice: resolved ? str(resolved.device) : null,
    resultsDir: results ? str(results.dir) : null,
  };
}

export function parseScriptRunStatus(raw: unknown): ScriptRunStatus {
  if (!isRecord(raw)) throw invalid("run status");
  const runHandle = str(raw.run_handle);
  const state = RUN_STATES.find((entry) => entry === raw.state);
  if (!runHandle || !state) throw invalid("run status");
  return {
    runHandle,
    state,
    exitCode: num(raw.exit_code),
    receipt: parseReceipt(raw.receipt),
    windowOpen: raw.window_open === true,
    error: str(raw.error),
  };
}

// ── wire request ────────────────────────────────────────────────────────

/** The `request` argument of `script_run`: a ticket and choices, never a path. */
export function runRequestWire(ticket: string, options: ScriptRunOptions): Record<string, unknown> {
  const requested: Record<string, unknown> = {};
  if (options.device !== "as_authored") requested.device = options.device;
  const request: Record<string, unknown> = {
    ticket,
    requested,
    wait_for_solve: options.waitForSolve,
    results: options.results,
  };
  if (options.results === "next_to_script") request.confirm_overwrite = options.confirmOverwrite;
  return request;
}

// ── wording ─────────────────────────────────────────────────────────────

export const RUN_NEEDS_DESKTOP = "Running a script needs the Fullmag desktop app";

const STATE_LABEL: Readonly<Record<RunState, string>> = {
  starting: "Starting",
  materializing: "Building the model",
  waiting_for_solve: "Model ready, waiting for COMPUTE",
  running: "Computing",
  exited: "Finished",
};

export const stateLabel = (state: RunState): string => STATE_LABEL[state];

export function refusalMessage(code: RefusalCode, detail: string): string {
  const tail = detail ? ` ${detail}` : "";
  switch (code) {
    case "changed":
      return "The file changed after it was opened, so nothing was run. Open it again to review the new content.";
    case "syntax":
      return `The script has a ${detail || "syntax error"}. Nothing was run.`;
    case "interpreter":
      return `Fullmag found no usable Python interpreter.${tail}`;
    case "encoding":
      return "The script is not UTF-8 text, so nothing was run. Save it as UTF-8 (a byte order mark is accepted).";
    case "cli_missing":
      return `The fullmag command line was not found next to this app.${tail}`;
    case "ticket":
      return "This script is no longer open in the app. Open it again.";
    case "busy":
      return `Too many script runs are active.${tail}`;
    case "confirm_required":
      return "Writing results next to the script needs your confirmation. Tick the box and try again.";
    case "storage":
      return `Fullmag could not prepare the run folder.${tail}`;
  }
}

export interface FactLine {
  readonly label: string;
  readonly value: string;
  readonly tone: "ok" | "warning" | "danger" | "neutral";
}

/** The facts shown before consent. "Not checked" is never rendered as "clean". */
export function preflightLines(facts: PreflightFacts): readonly FactLine[] {
  const lines: FactLine[] = [];
  switch (facts.syntax.state) {
    case "ok":
      lines.push({ label: "Syntax", value: "OK", tone: "ok" });
      break;
    case "error":
      lines.push({
        label: "Syntax",
        value: `Error at line ${facts.syntax.line}, column ${facts.syntax.column}: ${facts.syntax.message}`,
        tone: "danger",
      });
      break;
    case "unchecked":
      lines.push({ label: "Syntax", value: "Not checked", tone: "warning" });
      break;
  }
  if (facts.unresolvedImports === null) {
    lines.push({ label: "Imports", value: "Not checked", tone: "warning" });
  } else if (facts.unresolvedImports.length === 0) {
    lines.push({ label: "Imports", value: "All resolve", tone: "ok" });
  } else {
    lines.push({
      label: "Imports",
      value: `Not installed for this Python: ${facts.unresolvedImports.join(", ")}`,
      tone: "warning",
    });
  }
  if (facts.envReads === null) {
    lines.push({ label: "Environment", value: "Not checked", tone: "warning" });
  } else if (facts.envReads.length === 0) {
    lines.push({ label: "Environment", value: "No variables read", tone: "neutral" });
  } else {
    lines.push({
      label: "Environment",
      value: `Reads ${facts.envReads.join(", ")}`,
      tone: "neutral",
    });
  }
  const interpreter = facts.interpreter;
  if (!interpreter) {
    lines.push({ label: "Python", value: "Not resolved", tone: "warning" });
  } else if (interpreter.status === "resolved") {
    lines.push({
      label: "Python",
      value: `${interpreter.version} · ${interpreter.path}${interpreter.isolated ? " (bundled)" : ""}`,
      tone: "ok",
    });
  } else {
    lines.push({ label: "Python", value: interpreter.message, tone: "danger" });
  }
  return lines;
}

export function receiptText(receipt: ReceiptSummary): string {
  const seconds =
    receipt.durationSeconds === null ? "" : ` after ${receipt.durationSeconds.toFixed(1)} s`;
  switch (receipt.outcome) {
    case "completed":
      return `Finished${seconds}.`;
    case "cancelled":
      return `Stopped${seconds}.`;
    case "not_started":
      return `Not started: ${receipt.error ?? "the run was refused before it began"}.`;
    case "failed": {
      const fallback =
        receipt.requestedDevice === "gpu" && receipt.resolvedDevice !== "gpu"
          ? " GPU was requested and no CPU fallback was used."
          : "";
      return `Failed${seconds}: ${receipt.error ?? "see the run window for the log"}.${fallback}`;
    }
  }
}

// ── the run state machine ───────────────────────────────────────────────

export type RunPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing" }
  | { readonly kind: "ready"; readonly handle: ScriptHandle; readonly preflight: ScriptPreflight }
  /** The host-native consent prompt is open; only the person can answer it. */
  | { readonly kind: "asking"; readonly handle: ScriptHandle; readonly preflight: ScriptPreflight }
  | {
      readonly kind: "active";
      readonly handle: ScriptHandle;
      readonly status: ScriptRunStatus;
      readonly warning: string | null;
    }
  | { readonly kind: "finished"; readonly handle: ScriptHandle; readonly status: ScriptRunStatus }
  | { readonly kind: "failed"; readonly message: string };

export type RunEvent =
  | { readonly type: "prepare" }
  | { readonly type: "prepared"; readonly handle: ScriptHandle; readonly preflight: ScriptPreflight }
  | { readonly type: "ask" }
  | { readonly type: "result"; readonly result: ScriptRunResult }
  | { readonly type: "status"; readonly status: ScriptRunStatus }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "reset" };

export function startingStatus(runHandle: string): ScriptRunStatus {
  return { runHandle, state: "starting", exitCode: null, receipt: null, windowOpen: false, error: null };
}

export function reduceRun(phase: RunPhase, event: RunEvent): RunPhase {
  switch (event.type) {
    case "prepare":
      return phase.kind === "active" || phase.kind === "asking" ? phase : { kind: "preparing" };
    case "prepared":
      return phase.kind === "preparing" || phase.kind === "ready"
        ? { kind: "ready", handle: event.handle, preflight: event.preflight }
        : phase;
    case "ask":
      return phase.kind === "ready" ? { kind: "asking", handle: phase.handle, preflight: phase.preflight } : phase;
    case "result": {
      if (phase.kind !== "asking") return phase;
      const { result } = event;
      if (result.status === "started") {
        return {
          kind: "active",
          handle: phase.handle,
          status: startingStatus(result.runHandle),
          warning: result.warning,
        };
      }
      if (result.status === "declined") {
        return { kind: "ready", handle: phase.handle, preflight: phase.preflight };
      }
      return { kind: "failed", message: refusalMessage(result.code, result.detail) };
    }
    case "status": {
      if (phase.kind !== "active") return phase;
      if (event.status.runHandle !== phase.status.runHandle) return phase;
      return event.status.state === "exited"
        ? { kind: "finished", handle: phase.handle, status: event.status }
        : { ...phase, status: event.status };
    }
    case "error":
      return { kind: "failed", message: event.message };
    case "reset":
      return phase.kind === "active" || phase.kind === "asking" ? phase : { kind: "idle" };
  }
}

/** True while the person must not start another run from this panel. */
export const isRunBusy = (phase: RunPhase): boolean =>
  phase.kind === "preparing" || phase.kind === "asking" || phase.kind === "active";
