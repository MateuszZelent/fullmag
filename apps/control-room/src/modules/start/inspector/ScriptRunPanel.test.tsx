import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  parseScriptHandle,
  parseScriptPreflight,
  startingStatus,
  type RunPhase,
  type ScriptRunStatus,
} from "../model/scriptRun";
import type { ScriptRunController } from "../model/useScriptRun";

import { ScriptRunPanel } from "./ScriptRunPanel";

const handle = parseScriptHandle({
  ticket: "t0",
  item_id: 1,
  name: "sp4.py",
  display_path: "C:\\w\\sp4.py",
  bytes: 10,
  lines: 2,
  sha256: "ab".repeat(32),
  modified_at: "",
  encoding: "utf-8",
});

const preflight = (over: Record<string, unknown> = {}) =>
  parseScriptPreflight({
    ticket: "t0",
    cli_found: true,
    active_runs: 0,
    max_runs: 2,
    inspect: {
      syntax: { ok: true },
      imports: { unresolved: ["scipy"] },
      env_reads: ["FULLMAG_SP5_DEVICE"],
      interpreter: { status: "resolved", path: "C:/py/python.exe", version: "3.12.2", source: "env" },
    },
    ...over,
  });

const controller = (phase: RunPhase): ScriptRunController => ({
  phase,
  hostAvailable: true,
  prepare: vi.fn(async () => {}),
  run: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  dismiss: vi.fn(),
  forgetTrust: vi.fn(async () => null),
});

const render = (phase: RunPhase) => renderToStaticMarkup(<ScriptRunPanel controller={controller(phase)} />);

describe("ScriptRunPanel", () => {
  it("renders nothing while idle", () => {
    expect(render({ kind: "idle" })).toBe("");
  });

  it("says nothing is executed while the file is read", () => {
    expect(render({ kind: "preparing" })).toContain("Nothing is executed");
  });

  it("shows the preflight facts before any consent, with the native-prompt notice", () => {
    const html = render({ kind: "ready", handle, preflight: preflight() });
    for (const needle of ["Syntax", "OK", "scipy", "FULLMAG_SP5_DEVICE", "3.12.2", "user permissions", "separate window"]) {
      expect(html).toContain(needle);
    }
    expect(html).toContain("Review and run");
    // Managed results are the default; next to the script needs its own confirmation.
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*\/><span>In a Fullmag run folder/);
    expect(html).not.toContain("Write results into a folder beside the script");
  });

  it("disables the run button and explains a refusal", () => {
    const html = render({
      kind: "ready",
      handle,
      preflight: preflight({ refusal: { code: "syntax", detail: "syntax error at line 3 column 5: invalid syntax" } }),
    });
    expect(html).toMatch(/<button[^>]*data-action="confirm-run"[^>]*disabled=""/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Nothing was run");
  });

  it("warns about other active runs and blocks at the cap", () => {
    const warned = render({
      kind: "ready",
      handle,
      preflight: preflight({ active_runs: 1, warning: "1 script run is already active." }),
    });
    expect(warned).toContain("already active");
    expect(warned).not.toMatch(/<button[^>]*data-action="confirm-run"[^>]*disabled=""/);
    const capped = render({ kind: "ready", handle, preflight: preflight({ active_runs: 2 }) });
    expect(capped).toMatch(/<button[^>]*data-action="confirm-run"[^>]*disabled=""/);
  });

  it("marks facts that were not checked instead of showing them as clean", () => {
    const html = render({
      kind: "ready",
      handle,
      preflight: preflight({ inspect: { degraded: true, degraded_reason: "helper failed", syntax: { checked: false } } }),
    });
    expect(html).toContain("not checked");
    expect(html).toContain("Not checked");
  });

  it("waits for the native prompt without offering a way to answer it", () => {
    const html = render({ kind: "asking", handle, preflight: preflight() });
    expect(html).toContain("confirmation window");
    expect(html).toContain("Nothing has run yet");
    expect(html).not.toContain("<button");
  });

  it("shows the live state with a stop action", () => {
    const status: ScriptRunStatus = { ...startingStatus("r1"), state: "waiting_for_solve", windowOpen: true };
    const html = render({ kind: "active", handle, status, warning: null });
    expect(html).toContain("waiting for COMPUTE");
    expect(html).toContain("opened in its own window");
    expect(html).toContain('data-action="stop-run"');
  });

  it("reports the outcome from the receipt", () => {
    const status: ScriptRunStatus = {
      ...startingStatus("r1"),
      state: "exited",
      receipt: {
        outcome: "failed",
        exitCode: 14,
        durationSeconds: 1,
        error: "GPU requested but unavailable",
        requestedDevice: "gpu",
        resolvedDevice: null,
        resultsDir: "C:/state/r1/results",
      },
    };
    const html = render({ kind: "finished", handle, status });
    expect(html).toContain("no CPU fallback");
    expect(html).toContain("C:/state/r1/results");
    expect(html).toContain('role="alert"');
  });

  it("shows a refusal message as an alert", () => {
    const html = render({ kind: "failed", message: "The file changed after it was opened, so nothing was run." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("nothing was run");
  });
});
