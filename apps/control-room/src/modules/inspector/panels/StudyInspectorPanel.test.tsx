import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CommandDetailResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

vi.mock("@radix-ui/react-dialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@radix-ui/react-dialog")>();

  return {
    ...actual,
    Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

import {
  CommandDetailDialog,
  ImportStateDialog,
  RestoreCheckpointDialog,
  StudyCommandButton,
} from "./StudyInspectorPanel";

describe("StudyInspectorPanel", () => {
  it("renders command detail provenance in the dialog", () => {
    const command: CommandDetailResource = {
      artifact_refs: ["artifact://stage-1"],
      accepted_at_unix_ms: 1_778_780_000_000,
      checkpoint_ref: "checkpoint-1",
      command_id: "cmd-1",
      completed_at_unix_ms: 1_778_780_001_000,
      completion_status: "completed",
      created_at_unix_ms: 1_778_780_000_000,
      diagnostics: [
        {
          message: "Engine log may contain runtime entries for this command.",
          resource_key: "diagnostics/engine-log",
          revision: 3,
          severity: "info",
        },
      ],
      dispatched_at_unix_ms: 1_778_780_000_500,
      kind: "pause",
      reason: "user_requested",
      requested_at_unix_ms: 1_778_779_999_500,
      requested_execution: {
        backend: "cpu-fdm",
        device: "auto",
        mode: "strict",
        precision: "double",
      },
      resolved_execution: {
        backend: "cpu-fdm",
        device: "cpu",
        engine_id: "native-fdm",
        mode: "strict",
        precision: "double",
        runtime_family: "fdm",
      },
      resource_invalidations: [
        {
          reason: "stage lifecycle",
          resource_key: "simulation/stages/execution",
          revision: 7,
          state: "observed",
        },
      ],
      run_id: "run-1",
      seq: 7,
      stage_id: "stage-relax",
      stage_index: 0,
      started_at_unix_ms: 1_778_780_000_500,
      state_transition: "preserved",
      status: "completed",
      terminal_at_unix_ms: 1_778_780_001_000,
      target: {
        kind: "current_stage",
        stage_id: "stage-relax",
      },
    } as CommandDetailResource;
    const detail: ResourceResult<CommandDetailResource | null> = {
      data: command,
      error: null,
      refetch: () => undefined,
      revision: 7,
      status: "ready",
    };

    const html = renderToStaticMarkup(
      <CommandDetailDialog
        commandId="cmd-1"
        detail={detail}
        onOpenChange={() => undefined}
      />,
    );

    expect(html).toContain("pause detail");
    expect(html).toContain("cmd-1");
    expect(html).toContain("run-1");
    expect(html).toContain("cpu-fdm / auto / double / strict");
    expect(html).toContain(
      "cpu-fdm / cpu / double / strict / runtime=fdm / engine=native-fdm",
    );
    expect(html).toContain("completed");
    expect(html).toContain("stage-relax");
    expect(html).toContain("simulation/stages/execution@7 observed");
    expect(html).toContain("diagnostics/engine-log@3");
    expect(html).toContain("checkpoint-1");
    expect(html).toContain("preserved");
    expect(html).toContain("artifact://stage-1");
  });

  it("renders disabled command reasons on inspector command buttons", () => {
    const html = renderToStaticMarkup(
      <StudyCommandButton
        commandId="study.run"
        disabledReason="Build a shared-domain mesh before running FEM runtime commands."
        icon={<span aria-hidden="true">icon</span>}
        label="Compute"
        onRun={() => undefined}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain(
      "Compute: Build a shared-domain mesh before running FEM runtime commands.",
    );
    expect(html).toContain(
      "Build a shared-domain mesh before running FEM runtime commands.",
    );
  });

  it("renders checkpoint restore confirmation details", () => {
    const html = renderToStaticMarkup(
      <RestoreCheckpointDialog
        checkpoints={[
          {
            artifact_ref: "runs/run-1/checkpoints/checkpoint-1.fmstate",
            backend_family: "fdm",
            checkpoint_id: "checkpoint-1",
            checksum: "sha256:abc",
            command_id: "cmd-1",
            coordinate_frame: "mesh_nodes",
            created_at: "2026-05-15T00:00:00Z",
            dt: 1e-13,
            field_revision: 8,
            format: "fmstate",
            mesh_revision: 7,
            resume_class: "logical_resume",
            run_id: "run-1",
            scene_revision: 6,
            source: "manual",
            stage_id: "stage-003",
            step: 42,
            time_s: 1e-9,
            vector_count: 128,
          },
          {
            artifact_ref: "runs/run-1/checkpoints/checkpoint-2.fmstate",
            checkpoint_id: "checkpoint-2",
            coordinate_frame: "mesh_nodes",
            created_at: "2026-05-15T00:01:00Z",
            dt: 1e-13,
            format: "fmstate",
            resume_class: "exact_resume",
            run_id: "run-1",
            source: "pause",
            step: 43,
            time_s: 1.1e-9,
            vector_count: 128,
          },
        ]}
        onConfirm={() => undefined}
        onOpenChange={() => undefined}
        onSelectCheckpoint={() => undefined}
        open
        selectedCheckpointId="checkpoint-1"
      />,
    );

    expect(html).toContain("Restore checkpoint");
    expect(html).toContain("checkpoint-1");
    expect(html).toContain("checkpoint-2");
    expect(html).toContain("logical_resume");
    expect(html).toContain("exact_resume");
    expect(html).toContain("stage-003");
    expect(html).toContain("cmd-1");
    expect(html).toContain("sha256:abc");
    expect(html).toContain("runs/run-1/checkpoints/checkpoint-1.fmstate");
    expect(html).toContain("42");
  });

  it("renders import state inspection before commit", () => {
    const html = renderToStaticMarkup(
      <ImportStateDialog
        error={null}
        fileName="session.fms"
        inspecting={false}
        inspection={{
          created_at: "2026-05-15T00:00:00Z",
          created_by_version: "dev",
          format_version: "fms.v1",
          latest_checkpoint: {
            checkpoint_id: "checkpoint-9",
            step: 99,
            study_kind: "relax",
            time_s: 1e-9,
          },
          name: "Imported session",
          profile: "resume",
          restore_class: "logical_resume",
          run_count: 2,
          saved_at: "2026-05-15T00:01:00Z",
          session_id: "session-imported",
          total_size_bytes: 2048,
          warnings: ["mesh revision differs"],
        }}
        open
        restoreMode="resume"
        onConfirm={() => undefined}
        onFileSelected={() => undefined}
        onOpenChange={() => undefined}
        onRestoreModeChange={() => undefined}
      />,
    );

    expect(html).toContain("Import state");
    expect(html).toContain("session.fms");
    expect(html).toContain("session-imported");
    expect(html).toContain("Imported session");
    expect(html).toContain("logical_resume");
    expect(html).toContain("checkpoint-9");
    expect(html).toContain("mesh revision differs");
    expect(html).toContain("initial_condition");
    expect(html).toContain("config_only");
  });
});
