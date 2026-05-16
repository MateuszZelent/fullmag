import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CommandDetailResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

import { CommandCorrelationPanel } from "./TransportLogTable";

describe("TransportLogTable", () => {
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
