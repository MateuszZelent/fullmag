import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SESSION_STATUS_PATH } from "@/kernel/api/apiPaths";
import type { CommandDetailResource } from "@/kernel/api/apiTypes";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

import { CommandCorrelationPanel, TransportLogTable } from "./TransportLogTable";

describe("TransportLogTable", () => {
  it("renders a compact traffic summary above transport rows", () => {
    const entries: RequestDiagnosticEntry[] = [
      {
        byteLength: 128,
        channel: "http",
        contentType: "application/json",
        detail: null,
        direction: "tx",
        durationMs: 8,
        id: "status-tx-1",
        messageType: null,
        method: "GET",
        outcome: "ok",
        path: SESSION_STATUS_PATH,
        requestId: "req-1",
        status: 200,
        timestampMs: 0,
      },
      {
        byteLength: 256,
        channel: "http",
        contentType: "application/json",
        detail: null,
        direction: "tx",
        durationMs: 9,
        id: "status-tx-2",
        messageType: null,
        method: "GET",
        outcome: "ok",
        path: SESSION_STATUS_PATH,
        requestId: "req-2",
        status: 200,
        timestampMs: 10_000,
      },
    ];

    const html = renderToStaticMarkup(<TransportLogTable entries={entries} />);

    expect(html).toContain("Transport traffic summary");
    expect(html).toContain("2x");
    expect(html).toContain(SESSION_STATUS_PATH);
    expect(html).toContain("384 B");
  });

  it("renders correlated command detail in the transport log dialog", () => {
    const command: CommandDetailResource = {
      accepted_at_unix_ms: 1_778_780_000_000,
      checkpoint_ref: "checkpoint-1",
      command_id: "cmd-42",
      completion_status: "completed",
      created_at_unix_ms: 1,
      diagnostics: [
        {
          message: "Command produced stage artifacts.",
          resource_key: "data/artifacts",
          revision: 2,
          severity: "info",
        },
      ],
      kind: "compute_energies",
      reason: "user_requested",
      resource_invalidations: [
        {
          reason: "energy history",
          resource_key: "simulation/solver/energies/history",
          revision: 12,
          state: "observed",
        },
      ],
      requested_execution: {
        backend: "fem",
        device: "gpu",
        mode: "strict",
        precision: "double",
      },
      resolved_execution: {
        backend: "mfem",
        device: "gpu",
        mode: "strict",
        precision: "double",
        worker: "local-gpu-0",
      },
      resume_from_checkpoint_ref: "checkpoint-0",
      run_id: "run-1",
      seq: 42,
      stage_id: "stage-003",
      stage_index: 3,
      started_at_unix_ms: 1_778_780_000_500,
      state_transition: "restored",
      status: "completed",
      terminal_at_unix_ms: 1_778_780_001_000,
    } as CommandDetailResource;
    const detail: ResourceResult<CommandDetailResource | null> = {
      data: command,
      error: null,
      refetch: () => undefined,
      revision: 42,
      status: "ready",
    };

    const html = renderToStaticMarkup(
      <CommandCorrelationPanel commandId="cmd-42" detail={detail} />,
    );

    expect(html).toContain("Correlated command detail");
    expect(html).toContain("compute_energies");
    expect(html).toContain("run-1");
    expect(html).toContain("fem / gpu / double / strict");
    expect(html).toContain("mfem / gpu / double / strict / worker=local-gpu-0");
    expect(html).toContain("stage-003");
    expect(html).toContain("simulation/solver/energies/history@12 observed");
    expect(html).toContain("data/artifacts@2");
    expect(html).toContain("checkpoint-1");
    expect(html).toContain("restored");
  });
});
