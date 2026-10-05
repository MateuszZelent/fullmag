import { describe, expect, it } from "vitest";

import {
  DEFAULT_RUN_OPTIONS,
  isRunBusy,
  parseInterpreter,
  parsePreflightFacts,
  parseScriptHandle,
  parseScriptPick,
  parseScriptPreflight,
  parseScriptRunResult,
  parseScriptRunStatus,
  preflightLines,
  receiptText,
  reduceRun,
  refusalMessage,
  runRequestWire,
  startingStatus,
  stateLabel,
  type RunPhase,
  type ScriptHandle,
  type ScriptPreflight,
  type ScriptRunStatus,
} from "./scriptRun";
import { WorkspaceHostError } from "./workspaceItems";

const RAW_HANDLE = {
  ticket: "t0",
  item_id: 7,
  name: "sp4.py",
  display_path: "C:\\work\\sp4.py",
  bytes: 2048,
  lines: 80,
  sha256: "ab".repeat(32),
  modified_at: "2026-10-05T10:00:00.000Z",
  encoding: "utf-8",
};

const RAW_INSPECT = {
  schema: "fullmag.script_inspect.v1",
  syntax: { ok: true },
  imports: { fullmag: true, unresolved: ["scipy"] },
  env_reads: ["FULLMAG_SP5_DEVICE"],
  summary: "Standard problem 4",
  interpreter: {
    status: "resolved",
    path: "C:/py/python.exe",
    version: "3.12.2",
    source: "env",
    isolated: false,
    notes: [],
  },
};

const handle: ScriptHandle = parseScriptHandle(RAW_HANDLE);
const preflight: ScriptPreflight = parseScriptPreflight({
  ticket: "t0",
  inspect: RAW_INSPECT,
  cli_found: true,
  active_runs: 0,
  max_runs: 2,
});

describe("host answers are validated", () => {
  it("parses a script handle and keeps the item id optional", () => {
    expect(handle).toMatchObject({ ticket: "t0", itemId: 7, displayPath: "C:\\work\\sp4.py", encoding: "utf-8" });
    expect(parseScriptHandle({ ...RAW_HANDLE, item_id: null }).itemId).toBeNull();
    expect(parseScriptPick(null)).toBeNull();
    expect(parseScriptPick(RAW_HANDLE)?.name).toBe("sp4.py");
  });

  it("rejects an answer that is not the documented shape, with a typed error", () => {
    for (const bad of [null, "x", { ...RAW_HANDLE, encoding: "latin-1" }, { ...RAW_HANDLE, ticket: "" }]) {
      expect(() => parseScriptHandle(bad)).toThrow(WorkspaceHostError);
    }
    expect(() => parseScriptRunResult({ status: "maybe" })).toThrow(WorkspaceHostError);
    expect(() => parseScriptRunResult({ status: "refused", code: "nope" })).toThrow(WorkspaceHostError);
    expect(() => parseScriptRunStatus({ run_handle: "r", state: "paused" })).toThrow(WorkspaceHostError);
    expect(() => parseScriptPreflight({})).toThrow(WorkspaceHostError);
  });

  it("parses the three run results", () => {
    expect(
      parseScriptRunResult({ status: "started", run_handle: "r1", pid: 42, interpreter: RAW_INSPECT.interpreter, warning: null }),
    ).toMatchObject({ status: "started", runHandle: "r1", pid: 42 });
    expect(parseScriptRunResult({ status: "declined" })).toEqual({ status: "declined" });
    expect(parseScriptRunResult({ status: "refused", code: "changed", detail: "x" })).toEqual({
      status: "refused",
      code: "changed",
      detail: "x",
    });
  });

  it("parses interpreter errors and preflight facts without guessing", () => {
    expect(parseInterpreter({ status: "error", kind: "not_found", message: "none" })).toEqual({
      status: "error",
      kind: "not_found",
      message: "none",
    });
    expect(parseInterpreter({ status: "weird" })).toBeNull();
    const degraded = parsePreflightFacts({
      degraded: true,
      degraded_reason: "helper failed",
      syntax: { checked: false },
      imports: null,
      env_reads: null,
    });
    expect(degraded).toMatchObject({
      syntax: { state: "unchecked" },
      unresolvedImports: null,
      envReads: null,
      degraded: true,
    });
  });

  it("parses a status with its receipt", () => {
    const status = parseScriptRunStatus({
      run_handle: "r1",
      state: "exited",
      exit_code: 0,
      window_open: false,
      receipt: {
        outcome: { status: "completed", exit_code: 0, duration_seconds: 12.5, error: null },
        requested: { device: "auto" },
        resolved: { device: "cpu" },
        results: { dir: "C:/state/r1/results" },
      },
    });
    expect(status.receipt).toEqual({
      outcome: "completed",
      exitCode: 0,
      durationSeconds: 12.5,
      error: null,
      requestedDevice: "auto",
      resolvedDevice: "cpu",
      resultsDir: "C:/state/r1/results",
    });
  });
});

describe("the run request", () => {
  it("names a ticket and choices, never a path", () => {
    const wire = runRequestWire("t0", DEFAULT_RUN_OPTIONS);
    expect(wire).toEqual({ ticket: "t0", requested: {}, wait_for_solve: true, results: "managed" });
    expect(JSON.stringify(wire)).not.toMatch(/path|\.py/i);
  });

  it("sends a device only when the person chose one, and the overwrite confirmation only next to the script", () => {
    const wire = runRequestWire("t0", {
      device: "gpu",
      waitForSolve: false,
      results: "next_to_script",
      confirmOverwrite: true,
    });
    expect(wire).toEqual({
      ticket: "t0",
      requested: { device: "gpu" },
      wait_for_solve: false,
      results: "next_to_script",
      confirm_overwrite: true,
    });
    expect(runRequestWire("t0", { ...DEFAULT_RUN_OPTIONS, device: "auto" }).requested).toEqual({ device: "auto" });
  });
});

describe("facts shown before consent", () => {
  it("lists syntax, imports, environment reads and the interpreter", () => {
    const facts = parsePreflightFacts(RAW_INSPECT);
    expect(facts).not.toBeNull();
    const lines = preflightLines(facts!);
    expect(lines.map((line) => line.label)).toEqual(["Syntax", "Imports", "Environment", "Python"]);
    expect(lines[0]).toMatchObject({ value: "OK", tone: "ok" });
    expect(lines[1]?.value).toContain("scipy");
    expect(lines[1]?.tone).toBe("warning");
    expect(lines[2]?.value).toContain("FULLMAG_SP5_DEVICE");
    expect(lines[3]?.value).toContain("3.12.2");
  });

  it("never renders an unchecked fact as clean", () => {
    const lines = preflightLines(
      parsePreflightFacts({ degraded: true, syntax: { checked: false }, imports: null, env_reads: null })!,
    );
    expect(lines.filter((line) => line.value === "Not checked")).toHaveLength(3);
    expect(lines.find((line) => line.label === "Python")?.tone).toBe("warning");
  });

  it("states a syntax error with its position and an interpreter error as a danger", () => {
    const lines = preflightLines(
      parsePreflightFacts({
        syntax: { ok: false, line: 3, column: 5, message: "invalid syntax" },
        imports: { unresolved: [] },
        env_reads: [],
        interpreter: { status: "error", kind: "not_found", message: "No Python found" },
      })!,
    );
    expect(lines[0]).toMatchObject({ tone: "danger" });
    expect(lines[0]?.value).toContain("line 3, column 5");
    expect(lines.at(-1)).toMatchObject({ value: "No Python found", tone: "danger" });
  });
});

describe("messages", () => {
  it("explains every refusal and says nothing was run for the ones that stop it", () => {
    expect(refusalMessage("changed", "")).toContain("nothing was run");
    expect(refusalMessage("syntax", "syntax error at line 3")).toContain("syntax error at line 3");
    expect(refusalMessage("encoding", "")).toContain("UTF-8");
    expect(refusalMessage("confirm_required", "")).toContain("next to the script");
    expect(refusalMessage("cli_missing", "")).toContain("command line");
    for (const code of ["interpreter", "ticket", "busy", "storage"] as const) {
      expect(refusalMessage(code, "detail").length).toBeGreaterThan(10);
    }
  });

  it("labels the run states and the outcome, including a GPU that did not fall back", () => {
    expect(stateLabel("waiting_for_solve")).toContain("COMPUTE");
    expect(stateLabel("exited")).toBe("Finished");
    const base = { exitCode: 1, durationSeconds: 2.5, error: "boom", requestedDevice: "gpu", resolvedDevice: null, resultsDir: null };
    expect(receiptText({ ...base, outcome: "failed" })).toContain("no CPU fallback");
    expect(receiptText({ ...base, outcome: "cancelled" })).toBe("Stopped after 2.5 s.");
    expect(receiptText({ ...base, outcome: "completed" })).toBe("Finished after 2.5 s.");
    expect(receiptText({ ...base, outcome: "not_started", error: null })).toContain("Not started");
  });
});

describe("the run phase machine", () => {
  const idle: RunPhase = { kind: "idle" };
  const status = (state: ScriptRunStatus["state"], runHandle = "r1"): ScriptRunStatus => ({
    ...startingStatus(runHandle),
    state,
  });
  const ready = reduceRun(reduceRun(idle, { type: "prepare" }), { type: "prepared", handle, preflight });

  it("moves from idle through preparing to ready with the facts", () => {
    expect(reduceRun(idle, { type: "prepare" })).toEqual({ kind: "preparing" });
    expect(ready).toMatchObject({ kind: "ready", handle, preflight });
    expect(isRunBusy({ kind: "preparing" })).toBe(true);
    expect(isRunBusy(ready)).toBe(false);
  });

  it("ignores a result that no prompt asked for", () => {
    const stray = reduceRun(ready, { type: "result", result: { status: "started", runHandle: "r1", pid: 1, interpreter: null, warning: null } });
    expect(stray).toBe(ready);
  });

  it("starts, follows the host and finishes with the receipt", () => {
    const asking = reduceRun(ready, { type: "ask" });
    expect(asking.kind).toBe("asking");
    expect(isRunBusy(asking)).toBe(true);
    const active = reduceRun(asking, {
      type: "result",
      result: { status: "started", runHandle: "r1", pid: 9, interpreter: null, warning: "one run is active" },
    });
    expect(active).toMatchObject({ kind: "active", warning: "one run is active" });
    const waiting = reduceRun(active, { type: "status", status: status("waiting_for_solve") });
    expect(waiting).toMatchObject({ kind: "active", status: { state: "waiting_for_solve" } });
    expect(reduceRun(waiting, { type: "status", status: status("running", "other-run") })).toBe(waiting);
    const done = reduceRun(waiting, { type: "status", status: status("exited") });
    expect(done.kind).toBe("finished");
    expect(reduceRun(done, { type: "reset" })).toEqual({ kind: "idle" });
  });

  it("returns to ready when the person declines the native prompt", () => {
    const asking = reduceRun(ready, { type: "ask" });
    expect(reduceRun(asking, { type: "result", result: { status: "declined" } })).toMatchObject({ kind: "ready" });
  });

  it("turns a refusal into a message and keeps an active run through a reset", () => {
    const asking = reduceRun(ready, { type: "ask" });
    const refused = reduceRun(asking, { type: "result", result: { status: "refused", code: "changed", detail: "" } });
    expect(refused).toMatchObject({ kind: "failed" });
    expect((refused as { message: string }).message).toContain("changed");
    const active = reduceRun(asking, {
      type: "result",
      result: { status: "started", runHandle: "r1", pid: 1, interpreter: null, warning: null },
    });
    expect(reduceRun(active, { type: "reset" })).toBe(active);
    expect(reduceRun(active, { type: "prepare" })).toBe(active);
    expect(reduceRun(active, { type: "error", message: "x" })).toMatchObject({ kind: "failed" });
  });
});
