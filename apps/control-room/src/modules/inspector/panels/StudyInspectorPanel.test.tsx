import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Accordion } from "@/shared/ui/Accordion";

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
  deriveK0ModalExecutionReadiness,
  ImportStateDialog,
  RestoreCheckpointDialog,
  StudyBoundarySection,
  StudyCommandButton,
  StudyRuntimeSection,
  StudySelectedStageSection,
  studyInspectorRuntimeStatusEquals,
} from "./StudyInspectorPanel";
import {
  StudyPipelineSection,
  StudySolverPolicyFields,
  StudyStageDraftEditor,
} from "./StudyPipelineSection";
import { createStudyGlobalDraft } from "./StudyGlobalAuthoringModel";
import { createDefaultStudyStageDraft } from "./StudyStageAuthoringModel";

function testBoundary(overrides: Record<string, string> = {}) {
  return {
    demagEnabled: "enabled",
    demagRealization: "default",
    exchangeEnabled: "enabled",
    externalField: "0, 0, 0 T",
    femDemagSolverPolicy: "default",
    solver: "default",
    ...overrides,
  };
}

function testRequested(overrides: Record<string, string> = {}) {
  return {
    backend: "auto",
    cpuThreads: "auto",
    device: "auto",
    mode: "strict",
    precision: "double",
    ...overrides,
  };
}

describe("StudyInspectorPanel", () => {
  it("rerenders when the runtime advertises a new relaxation algorithm", () => {
    const previous = {
      capabilities: {
        algorithms_available: ["llg_overdamped"],
        binary_fields: true,
        explicit_topology: true,
      },
      domain: { discretization: "fem" },
      resources: {
        mesh_build_revision: 1,
        mesh_revision: 1,
        commands_revision: 1,
        scalars_revision: 1,
        scene_revision: 1,
        stages_revision: 1,
      },
      run: null,
    } as NonNullable<Parameters<typeof studyInspectorRuntimeStatusEquals>[0]>;
    const next = {
      ...previous,
      capabilities: {
        ...previous.capabilities,
        algorithms_available: [
          "llg_overdamped",
          "projected_gradient_bb",
        ],
      },
    };

    expect(studyInspectorRuntimeStatusEquals(previous, next)).toBe(false);
  });

  it("derives K0 production readiness by selected equilibrium provenance", () => {
    const resources = {
        checkpoints: [
          { artifact_ref: "artifact://provided", mesh_revision: 42 },
        ] as never,
        frequencyManifest: {
          capabilities: { modal: { production_gpu: { reason: "not qualified", status: "contract_only" } } },
        } as never,
        meshManifest: { mesh_id: "shared", revision: 42 } as never,
        periodicPairs: {
          pairs: [{ paired_node_count: 8, status: "certified", unpaired_destination_node_count: 0, unpaired_source_node_count: 0 }],
          revision: 42,
        } as never,
        solverStatus: {
          converged: true,
          is_busy: false,
          revision: 42,
        } as never,
        stageExecution: {
          stages: [{ converged: true, kind: "relax", status: "completed" }],
          revision: 8,
        } as never,
    };
    expect(deriveK0ModalExecutionReadiness({
      ...resources,
      equilibriumArtifact: "",
      equilibriumSource: "relax",
    })).toEqual({
      acceptedEquilibriumReady: true,
      periodicCertificateReady: true,
      sharedDomainMeshReady: true,
      strictGpuReady: false,
    });
    expect(deriveK0ModalExecutionReadiness({
      ...resources,
      equilibriumArtifact: "",
      equilibriumSource: "provided",
    }).acceptedEquilibriumReady).toBe(true);
    expect(deriveK0ModalExecutionReadiness({
      ...resources,
      equilibriumArtifact: "artifact://provided",
      equilibriumSource: "artifact",
    }).acceptedEquilibriumReady).toBe(true);
    expect(deriveK0ModalExecutionReadiness({
      ...resources,
      equilibriumArtifact: "artifact://missing",
      equilibriumSource: "artifact",
    }).acceptedEquilibriumReady).toBe(false);
  });

  it("renders unavailable K0 modal prerequisites in the study pipeline", () => {
    const draft = {
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      bc: "periodic",
      dampingPolicy: "ignore",
      deviceTarget: "gpu",
      includeDemag: true,
      kVector: "0,0,0",
      magnetostaticBc: "periodic_airbox_k0",
    };
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <StudyPipelineSection
          activeStageIndex={null}
          authoringBusy={false}
          authoringFeedback={null}
          commandDisabledReason={() => null}
          demagEnabled
          draft={draft}
          draftIndex={0}
          drafts={[draft]}
          k0ModalReadinessFor={() => ({
            acceptedEquilibriumReady: false,
            periodicCertificateReady: false,
            sharedDomainMeshReady: false,
            strictGpuReady: false,
          })}
          model={{
            boundary: testBoundary(),
            requested: testRequested({ backend: "fem", device: "gpu" }),
            runtime: {
              activeStageLabel: "none",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No active command",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "none",
              state: "idle",
            },
            selectedStage: null,
            stages: [],
          }}
          onAddStage={() => undefined}
          onCommit={() => undefined}
          onDuplicateStage={() => undefined}
          onMoveStage={() => undefined}
          onRemoveStage={() => undefined}
          onSelectDraft={() => undefined}
          onUpdateDraft={() => undefined}
          runCommand={() => undefined}
        />
      </Accordion>,
    );
    expect(html).toContain("periodic_airbox_k0 requires a shared-domain mesh.");
    expect(html).toContain("periodic_airbox_k0 requires a periodic certificate.");
    expect(html).toContain("periodic_airbox_k0 requires an accepted equilibrium.");
    expect(html).toContain("Strict GPU K0 modal demag prerequisites are unavailable.");
  });

  it("renders requested, resolved, and fallback runtime provenance rows", () => {
    const html = renderToStaticMarkup(
      <StudyRuntimeSection
        commandDisabledReason={() => null}
        model={{
          runtime: {
            activeStageLabel: "Relax 1",
            commandBadge: "running",
            commandError: null,
            commandId: null,
            commandLabel: "No queued commands",
            maxTorque: "unavailable",
            progressPercent: 10,
            relaxEnergyStop: null,
            relaxTimeStop: null,
            relaxTorqueStop: null,
            runId: "run-fdm",
            runtimeProvenance: {
              authored: {
                backend: "fdm",
                device: "cpu",
                mode: "strict",
                precision: "double",
              },
              effective: {
                backend: "fdm",
                device: "gpu",
                mode: "strict",
                precision: "double",
              },
              resolved: {
                backend: "fdm",
                device: "gpu",
                mode: "strict",
                precision: "double",
                runtimeFamily: "fdm-cuda",
                engine: "fdm_cuda",
              },
              fallback: {
                status: "occurred",
                originalEngine: "fdm_cuda",
                fallbackEngine: "fdm_cpu_reference",
                reason: "cuda_unavailable",
                message: "CUDA device unavailable; using the reference CPU engine.",
              },
              sources: {
                authored: "problem_ir.runtime_selection",
                effective: "session.runtime_resolution",
              },
            },
            state: "running",
          },
        } as never}
        onOpenCommand={() => undefined}
        runCommand={() => undefined}
        stepValue={4}
      />,
    );

    expect(html).toContain("Authored intent backend");
    expect(html).toContain("fdm");
    expect(html).toContain("Authored intent device");
    expect(html).toContain("Effective request backend");
    expect(html).toContain("Effective request device");
    expect(html).toContain("problem_ir.runtime_selection");
    expect(html).toContain("session.runtime_resolution");
    expect(html).toContain("Resolved runtime family");
    expect(html).toContain("fdm-cuda");
    expect(html).toContain("Resolved engine");
    expect(html).toContain("fdm_cuda");
    expect(html).toContain("Fallback status");
    expect(html).toContain("occurred");
    expect(html).toContain("cuda_unavailable");
    expect(html).toContain("CUDA device unavailable; using the reference CPU engine.");
  });

  it("renders global advanced adaptive guard controls", () => {
    const html = renderToStaticMarkup(
      <StudySolverPolicyFields
        algorithmsAvailable={["llg_overdamped"]}
        draft={{
          adaptiveTimestep: {
            atol: "1e-8",
            dtInitial: "",
            dtMax: "1e-13",
            dtMin: "1e-16",
            growthLimit: "2",
            maxSpinRotation: "0.15",
            normTolerance: "2e-6",
            rtol: "1e-5",
            safety: "0.9",
            shrinkLimit: "0.2",
          },
          demagInterval: "",
          dtInitial: "",
          dtMax: "",
          dtMin: "",
          energyTolerance: "",
          fixDt: "",
          integrator: "rk45",
          maxErr: "",
          maxRelaxSteps: "",
          relaxAlgorithm: "llg_overdamped",
          timestepMode: "adaptive_advanced",
          torqueTolerance: "",
        }}
        onUpdate={() => undefined}
        requestedBackend="fdm"
        requestedDevice="cpu"
        requestedPrecision="double"
      />,
    );

    expect(html).toContain("Max spin rotation");
    expect(html).toContain("Norm tolerance");
    expect(html).toContain('value="0.15"');
    expect(html).toContain('value="2e-6"');
  });

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

  it("renders terminal selected relaxation details", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["selected-stage"]}>
        <StudySelectedStageSection
          stageExecutionRevision={13}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "No active stage",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No queued commands",
              maxTorque: "9.425e-5 T",
              progressPercent: 100,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "run-1",
              state: "completed",
            },
            selectedStage: {
              artifactRefs: ["runs/run-1/stages/stage-relax"],
              checkpointRef: "cp-relaxed",
              commandId: "cmd-relax",
              completedAtIso: "2023-11-14T22:13:30.000Z",
              completedAtUnixMs: 1_700_000_010_000,
              energyTolerance: null,
              index: 0,
              kind: "relax",
              label: "Relax 1",
              maxSteps: "1000",
              meshGenerationId: "mesh-generation-7",
              meshRevision: 19,
              meshTopologyFingerprint: "sha256:stage-topology-7",
              progressPercent: 100,
              runtimeMetric: {
                name: "max_torque_apm",
                threshold: "1.005e-4 T / 8.000e1 A/m",
                value: "9.425e-5 T / 7.500e1 A/m",
              },
              stageId: "stage-relax",
              status: "completed",
              stopReason: "torque",
              timeBudgetKind: "physical",
              torqueTolerance: "80",
              torqueToleranceFormatted: "1.005e-4 T / 8.000e1 A/m",
              torqueToleranceShortFormatted: "1.005e-4 T",
              transition: null,
              untilSeconds: null,
              algorithm: null,
            },
            stages: [],
          }}
        />
      </Accordion>,
    );

    expect(html).toContain("completed");
    expect(html).toContain("torque");
    expect(html).toContain("cmd-relax");
    expect(html).toContain("cp-relaxed");
    expect(html).toContain("max_torque_apm");
    expect(html).toContain("simulation/stages/execution@13");
    expect(html).toContain("runs/run-1/stages/stage-relax");
    expect(html).toContain("Mesh generation");
    expect(html).toContain("mesh-generation-7");
    expect(html).toContain("Mesh revision");
    expect(html).toContain("19");
    expect(html).toContain("Topology fingerprint");
    expect(html).toContain("sha256:stage-topology-7");
  });

  it("renders selected stage transition metadata", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["selected-stage"]}>
        <StudySelectedStageSection
          stageExecutionRevision={16}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Run 2",
              commandBadge: "running",
              commandError: null,
              commandId: "cmd-run",
              commandLabel: "Run running",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "run-2",
              state: "running",
            },
            selectedStage: {
              algorithm: null,
              artifactRefs: [],
              checkpointRef: null,
              commandId: "cmd-run",
              completedAtIso: null,
              completedAtUnixMs: null,
              energyTolerance: null,
              index: 1,
              kind: "run",
              label: "Run 2",
              maxSteps: null,
              meshGenerationId: null,
              meshRevision: null,
              meshTopologyFingerprint: null,
              progressPercent: 0,
              runtimeMetric: null,
              stageId: "stage-run",
              status: "running",
              stopReason: null,
              timeBudgetKind: "physical",
              torqueTolerance: null,
              torqueToleranceFormatted: null,
              torqueToleranceShortFormatted: null,
              transition: {
                kind: "backend_transfer",
                label: "Change device",
                reason: "backend_change",
                transferOperator: "identity_copy",
                uiPresentation: "boundary_bar",
              },
              untilSeconds: null,
            },
            stages: [],
          }}
        />
      </Accordion>,
    );

    expect(html).toContain("State transition");
    expect(html).toContain("Change device");
    expect(html).toContain("backend_transfer");
    expect(html).toContain("identity_copy");
    expect(html).toContain("Mesh generation");
    expect(html).toContain(">unknown<");
    expect(html).toContain("simulation/stages/execution@16");
  });

  it("renders indeterminate progress for active eigenmode solves", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["selected-stage"]}>
        <StudySelectedStageSection
          stageExecutionRevision={17}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Eigenmodes 2",
              commandBadge: "running",
              commandError: null,
              commandId: "cmd-eigen",
              commandLabel: "Run running",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "run-eigen",
              state: "running",
            },
            selectedStage: {
              algorithm: null,
              artifactRefs: [],
              checkpointRef: null,
              commandId: "cmd-eigen",
              completedAtIso: null,
              completedAtUnixMs: null,
              energyTolerance: null,
              index: 1,
              kind: "eigenmodes",
              label: "Eigenmodes 2",
              lastProgressUnixMs: 1_781_445_105_275,
              maxSteps: null,
              meshGenerationId: null,
              meshRevision: null,
              meshTopologyFingerprint: null,
              progressDetail: "heartbeat 8.5s since last solver update",
              progressLabel: "solving",
              progressPercent: 35,
              runtimeMetric: null,
              stageId: "stage-eigen",
              status: "running",
              stopReason: null,
              timeBudgetKind: "physical",
              torqueTolerance: null,
              torqueToleranceFormatted: null,
              torqueToleranceShortFormatted: null,
              transition: null,
              untilSeconds: null,
            },
            stages: [],
          }}
        />
      </Accordion>,
    );

    expect(html).toContain("Eigenmode solve progress");
    expect(html).toContain("solving");
    expect(html).toContain("heartbeat 8.5s since last solver update");
    expect(html).not.toContain("fm-study-progress--indeterminate");
    expect(html).toContain("aria-valuenow=\"35\"");
  });

  it("renders editable stage pipeline controls for relaxation authoring", () => {
    const draft = createDefaultStudyStageDraft("relax", 0);
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <StudyPipelineSection
          activeStageIndex={0}
          authoringBusy={false}
          authoringFeedback={null}
          commandDisabledReason={() => null}
          draft={draft}
          draftIndex={0}
          drafts={[draft]}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Relax 1",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No queued commands",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "none",
              state: "idle",
            },
            selectedStage: null,
            stages: [
              {
                algorithm: "llg_overdamped",
                artifactRefs: [],
                checkpointRef: null,
                commandId: null,
                completedAtIso: null,
                completedAtUnixMs: null,
                energyTolerance: null,
                index: 0,
                kind: "relax",
                label: "Relax 1",
                maxSteps: "50000",
                meshGenerationId: null,
                meshRevision: null,
                meshTopologyFingerprint: null,
                progressPercent: 0,
                runtimeMetric: null,
                stageId: "relax-1",
                status: "queued",
                stopReason: null,
                timeBudgetKind: "physical",
                torqueTolerance: "1e-6",
                torqueToleranceFormatted: null,
                torqueToleranceShortFormatted: null,
                transition: null,
                untilSeconds: null,
              },
            ],
          }}
          onAddStage={() => undefined}
          onCommit={() => undefined}
          onDuplicateStage={() => undefined}
          onMoveStage={() => undefined}
          onRemoveStage={() => undefined}
          onSelectDraft={() => undefined}
          onUpdateDraft={() => undefined}
          runCommand={() => undefined}
        />
      </Accordion>,
    );

    expect(html).toContain("Stage Pipeline");
    expect(html).toContain("Save stages");
    expect(html).toContain("Duplicate");
    expect(html).toContain("Remove");
    expect(html).toContain("Eigenmodes");
    expect(html).toContain("Frequency");
    expect(html).toContain("Save");
    expect(html).toContain("Torque tol");
    expect(html).toContain("A/m");
    expect(html).toContain("max |m × H_eff|");
    expect(html).toContain("Max steps");
    expect(html).toContain("Field every");
    expect(html).toContain("RK45");
    expect(html).toContain("Timestep mode");
    expect(html).toContain(
      "LLG relaxation requires an explicit fixed or adaptive timestep policy.",
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="Fix stage validation errors before saving\."[^>]*>.*Save stages<\/button>/,
    );
    expect(html).not.toContain("Fixed dt");
    expect(html).not.toContain("Initial dt");
    expect(html).not.toContain("Adaptive dt min");
    expect(html).toContain("Nonlinear CG");
    expect(html).not.toContain("Tangent-plane implicit");
  });

  it("renders FEM demag projected-gradient BB as disabled with its reason", () => {
    const draft = {
      ...createDefaultStudyStageDraft("relax", 0),
      algorithm: "projected_gradient_bb",
    };
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        algorithmsAvailable={[
          "llg_overdamped",
          "projected_gradient_bb",
          "nonlinear_cg",
          "tangent_plane_implicit",
        ]}
        demagEnabled
        draft={draft}
        index={0}
        onUpdate={() => undefined}
        requestedBackend="fem"
        requestedDevice="gpu"
        requestedMode="strict"
        validation={[]}
      />,
    );

    expect(html).toContain('value="projected_gradient_bb"');
    expect(html).not.toContain('value="projected_gradient_bb" disabled=""');
  });

  it("shows runtime progress labels on stage pipeline progress bars", () => {
    const draft = createDefaultStudyStageDraft("frequency_response", 0);
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <StudyPipelineSection
          activeStageIndex={0}
          authoringBusy={false}
          authoringFeedback={null}
          commandDisabledReason={() => null}
          draft={draft}
          draftIndex={0}
          drafts={[draft]}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Frequency response 1",
              commandBadge: "running",
              commandError: null,
              commandId: "cmd-frequency",
              commandLabel: "Run running",
              maxTorque: "unavailable",
              progressPercent: 14,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "run-frequency",
              state: "running",
            },
            selectedStage: null,
            stages: [
              {
                algorithm: null,
                artifactRefs: [],
                checkpointRef: null,
                commandId: "cmd-frequency",
                completedAtIso: null,
                completedAtUnixMs: null,
                energyTolerance: null,
                index: 0,
                kind: "frequency_response",
                label: "Frequency response 1",
                lastProgressUnixMs: 1_781_467_092_000,
                maxSteps: null,
                meshGenerationId: null,
                meshRevision: null,
                meshTopologyFingerprint: null,
                progressDetail:
                  "demag=periodic_airbox_k0; range=2.000000-5.000000 GHz; frequency point 2/7",
                progressLabel: "solving frequency point",
                progressPercent: 14,
                runtimeMetric: null,
                stageId: "stage-frequency",
                status: "running",
                stopReason: null,
                timeBudgetKind: "physical",
                torqueTolerance: null,
                torqueToleranceFormatted: null,
                torqueToleranceShortFormatted: null,
                transition: null,
                untilSeconds: null,
              },
            ],
          }}
          onAddStage={() => undefined}
          onCommit={() => undefined}
          onDuplicateStage={() => undefined}
          onMoveStage={() => undefined}
          onRemoveStage={() => undefined}
          onSelectDraft={() => undefined}
          onUpdateDraft={() => undefined}
          runCommand={() => undefined}
        />
      </Accordion>,
    );

    expect(html).toContain("Frequency response 1");
    expect(html).toContain("solving frequency point");
    expect(html).toContain("aria-valuenow=\"14\"");
  });

  it("renders spectral authoring selects with Python DSL option values", () => {
    const draft = createDefaultStudyStageDraft("eigenmodes", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={draft}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain('value="unit_max_amplitude"');
    expect(html).toContain('value="include"');
    expect(html).toContain('value="artifact"');
    expect(html).not.toContain('value="max_component"');
    expect(html).not.toContain('value="linearized"');
    expect(html).not.toContain('value="current_state"');
  });

  it("renders expanded hysteresis authoring controls", () => {
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={{
          ...draft,
          fieldScheduleMode: "piecewise",
          saturationMode: "auto",
          settlePipelineMode: "tree",
          settleSteps: JSON.stringify([
            {
              alpha: 1,
              kind: "relax",
              max_steps: 100,
              method: "llg_overdamped",
              on_non_convergence: "continue_with_warning",
              torque_tolerance: 1e-6,
            },
            {
              energy_tolerance: 1e-20,
              kind: "minimize",
              max_steps: 100,
              method: "projected_gradient_bb",
              on_non_convergence: "continue_with_warning",
              torque_tolerance: 1e-6,
            },
            {
              damping: 1,
              kind: "dynamics_settle",
              max_steps: 100,
              method: "heun_dynamics_settle",
              on_non_convergence: "continue_with_warning",
            },
          ]),
        }}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("Protocol");
    expect(html).toContain("Virgin then major loop");
    expect(html).toContain("Major with minor loops");
    expect(html).toContain("Initial state");
    expect(html).toContain("Positive saturation");
    expect(html).toContain("Checkpoint");
    expect(html).toContain("Orientation mode");
    expect(html).toContain("OOP +z");
    expect(html).toContain("Measurement axis");
    expect(html).toContain("Schedule mode");
    expect(html).toContain("Field segments");
    expect(html).toContain("Dense windows");
    expect(html).toContain("Saturation mode");
    expect(html).toContain("Max probe field");
    expect(html).toContain("Saturation thresholds");
    expect(html).toContain("Settle pipeline");
    expect(html).toContain("Settle algorithms");
    expect(html).toContain("Algorithm 1");
    expect(html).toContain("Add relax");
    expect(html).toContain("Add minimize");
    expect(html).toContain("Add dynamics");
    expect(html).toContain("Move algorithm up");
    expect(html).toContain("Move algorithm down");
    expect(html).toContain("Step ID");
    expect(html).toContain("Applies to");
    expect(html).toContain("Damping");
    expect(html).toContain("Retry scale");
    expect(html).toContain("Retry attempts");
    expect(html).toContain("On non-convergence");
    expect(html).toContain("Projected gradient BB");
    expect(html).toContain("Settle steps");
    expect(html).toContain("Settle branches");
    expect(html).toContain("Minor loops");
    expect(html).toContain("Storage policy");
  });

  it("renders checkpoint initial state ref when checkpoint start is selected", () => {
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={{
          ...draft,
          initialStatePolicy: "checkpoint",
          initialStateRef: "hysteresis_snapshots/hysteresis_point_003/m.json",
        }}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("Initial state ref");
    expect(html).toContain("hysteresis_snapshots/hysteresis_point_003/m.json");
  });

  it("renders a structured piecewise field segment editor for hysteresis authoring", () => {
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={{
          ...draft,
          fieldScheduleMode: "piecewise",
          fieldSegments: JSON.stringify([
            {
              endpointPolicy: "skip_start",
              label: "Dense after remanence",
              reason: "dense_after_remanence",
              segmentId: "dense_after_remanence",
              startField: 200,
              step: 5,
              stopField: -50,
              unit: "mT",
            },
          ]),
        }}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("Piecewise field segments");
    expect(html).toContain("Segment 1");
    expect(html).toContain("Segment ID");
    expect(html).toContain("Start field");
    expect(html).toContain("Stop field");
    expect(html).toContain("Endpoint policy");
    expect(html).toContain("Dense after remanence");
    expect(html).toContain("Add segment");
  });

  it("renders a structured dense-window editor for hysteresis authoring", () => {
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={{
          ...draft,
          denseWindows: JSON.stringify([
            {
              center_mT: 0,
              half_width_mT: 25,
              priority: 10,
              reason: "remanence",
              step_mT: 1,
            },
          ]),
        }}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("Dense refinement windows");
    expect(html).toContain("Window 1");
    expect(html).toContain("Center field");
    expect(html).toContain("Half width");
    expect(html).toContain("Priority");
    expect(html).toContain("remanence");
    expect(html).toContain("Add window");
  });

  it("renders a structured minor-loop editor for hysteresis authoring", () => {
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={{
          ...draft,
          minorLoops: JSON.stringify([
            {
              closure_policy: "branch_only",
              parent_branch: "descending",
              return_mT: -25,
              reversal_mT: 25,
            },
          ]),
          protocolKind: "major_with_minor_loops",
        }}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("Minor loops");
    expect(html).toContain("Loop 1");
    expect(html).toContain("Reversal field");
    expect(html).toContain("Return field");
    expect(html).toContain("Parent branch");
    expect(html).toContain("Closure policy");
    expect(html).toContain("Branch only");
    expect(html).toContain("Add minor loop");
  });

  it("renders a structured settle-branch editor for hysteresis tree authoring", () => {
    const draft = createDefaultStudyStageDraft("hysteresis", 0);
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={{
          ...draft,
          settleBranches: JSON.stringify([
            {
              branch_id: "non_converged_fallback",
              run: {
                alpha: 1,
                kind: "relax",
                max_steps: 100,
                method: "llg_overdamped",
                on_non_convergence: "continue_with_warning",
                torque_tolerance: 1e-5,
              },
              when: "non_converged",
            },
          ]),
          settlePipelineMode: "tree",
        }}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("Settle branches");
    expect(html).toContain("Branch 1");
    expect(html).toContain("Branch ID");
    expect(html).toContain("Trigger");
    expect(html).toContain("Non-converged fallback");
    expect(html).toContain("Run step JSON");
    expect(html).toContain("non_converged_fallback");
    expect(html).toContain("Add branch");
  });

  it("keeps root pipeline validation visible when stage editor is hidden", () => {
    const draft = { ...createDefaultStudyStageDraft("relax", 0), stageId: "" };
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <StudyPipelineSection
          activeStageIndex={0}
          authoringBusy={false}
          authoringFeedback={null}
          commandDisabledReason={() => null}
          draft={draft}
          draftIndex={0}
          drafts={[draft]}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Relax 1",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No queued commands",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "none",
              state: "idle",
            },
            selectedStage: null,
            stages: [
              {
                algorithm: "llg_overdamped",
                artifactRefs: [],
                checkpointRef: null,
                commandId: null,
                completedAtIso: null,
                completedAtUnixMs: null,
                energyTolerance: null,
                index: 0,
                kind: "relax",
                label: "Relax 1",
                maxSteps: "50000",
                meshGenerationId: null,
                meshRevision: null,
                meshTopologyFingerprint: null,
                progressPercent: 0,
                runtimeMetric: null,
                stageId: "relax-1",
                status: "queued",
                stopReason: null,
                timeBudgetKind: "physical",
                torqueTolerance: "1e-6",
                torqueToleranceFormatted: null,
                torqueToleranceShortFormatted: null,
                transition: null,
                untilSeconds: null,
              },
            ],
          }}
          showDraftEditor={false}
          onAddStage={() => undefined}
          onCommit={() => undefined}
          onDuplicateStage={() => undefined}
          onMoveStage={() => undefined}
          onRemoveStage={() => undefined}
          onSelectDraft={() => undefined}
          onUpdateDraft={() => undefined}
          runCommand={() => undefined}
        />
      </Accordion>,
    );

    expect(html).toContain("Selected stage has validation errors");
    expect(html).not.toContain("Stage ID is required.");
    expect(html).not.toContain('data-testid="study-stage-authoring-toolbar"');
  });

  it("renders editable global settings and applies production capability validation", () => {
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["boundary"]}>
        <StudyBoundarySection
          algorithmsAvailable={[]}
          authoringBusy={false}
          authoringFeedback={null}
          draft={{
            demagEnabled: true,
            demagRealization: "multilayer_convolution",
            exchangeEnabled: true,
            externalField: "1e-3, 0, 0",
            femDemagSolverPolicy: '{"linear_solver":"cg"}',
            requestedBackend: "fem",
            requestedCpuThreads: "8",
            requestedDevice: "gpu",
            requestedMode: "strict",
            requestedPrecision: "single",
            solver: {
              adaptiveTimestep: null,
              demagInterval: "",
              dtInitial: "",
              dtMax: "1e-14",
              dtMin: "1e-16",
              energyTolerance: "",
              fixDt: "",
              integrator: "rk45",
              maxErr: "1e-6",
              maxRelaxSteps: "",
              relaxAlgorithm: "",
              timestepMode: "adaptive_max_error",
              torqueTolerance: "",
            },
          }}
          model={{
            boundary: testBoundary({
              demagRealization: "poisson_robin",
              externalField: "0.001, 0, 0 T",
              femDemagSolverPolicy: '{"linear_solver":"cg"}',
              solver: '{"integrator":"rk45"}',
            }),
            requested: testRequested({
              backend: "fem",
              cpuThreads: "8",
              device: "gpu",
            }),
            runtime: {
              activeStageLabel: "No active stage",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No queued commands",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "none",
              state: "idle",
            },
            selectedStage: null,
            stages: [],
          }}
          snapshot={{
            boundary: testBoundary({
              demagRealization: "poisson_robin",
              externalField: "0.001, 0, 0 T",
              femDemagSolverPolicy: '{"linear_solver":"cg"}',
              solver: '{"integrator":"rk45"}',
            }),
            requested: testRequested({
              backend: "fem",
              cpuThreads: "8",
              device: "gpu",
            }),
            stages: [],
          }}
          onCommit={() => undefined}
          onUpdate={() => undefined}
        />
      </Accordion>,
    );

    expect(html).toContain("Global Study Settings");
    expect(html).toContain("Backend");
    expect(html).toContain("CPU threads");
    expect(html).toContain("Exchange enabled");
    expect(html).toContain("Demag enabled");
    expect(html).toContain("Poisson Robin");
    const demagSelect = html.match(
      /<select[^>]*aria-label="Demag"[^>]*>[\s\S]*?<\/select>/,
    )?.[0];
    expect(demagSelect).toContain('<option value="auto" selected="">Auto</option>');
    expect(demagSelect).not.toContain("FDM multilayer convolution");
    expect(html).toContain("External field");
    expect(html).toContain("Timestep policy");
    expect(html).toContain("Maximum embedded vector error");
    expect(html).not.toContain("Study solver override JSON object");
    expect(html).toContain("FEM demag policy");
    expect(html).toContain("Current CPU threads");
    expect(html).toContain("LLG is not advertised by the active session.");
    expect(html).toContain(
      "Adaptive execution is qualified only for double precision.",
    );
    expect(html).toContain("Save globals");
  });

  it("renders FDM demag controls and makes FEM policy read-only for an FDM session", () => {
    const html = renderToStaticMarkup(
      <StudyBoundarySection
        algorithmsAvailable={[]}
        authoringBusy={false}
        authoringFeedback={null}
        draft={{
          demagEnabled: true,
          demagRealization: "multilayer_convolution",
          exchangeEnabled: true,
          externalField: "",
          femDemagSolverPolicy: '{"solver":"CG"}',
          requestedBackend: "auto",
          requestedCpuThreads: "",
          requestedDevice: "auto",
          requestedMode: "strict",
          requestedPrecision: "double",
          solver: {
            adaptiveTimestep: null,
            demagInterval: "",
            dtInitial: "",
            dtMax: "",
            dtMin: "",
            energyTolerance: "",
            fixDt: "",
            integrator: "",
            maxErr: "",
            maxRelaxSteps: "",
            relaxAlgorithm: "",
            timestepMode: "auto",
            torqueTolerance: "",
          },
        }}
        model={{
          boundary: testBoundary({
            demagRealization: "multilayer_convolution",
            femDemagSolverPolicy: '{"solver":"CG"}',
          }),
          requested: testRequested(),
          runtime: {
            activeStageLabel: "No active stage",
            commandBadge: "idle",
            commandError: null,
            commandId: null,
            commandLabel: "No queued commands",
            maxTorque: "unavailable",
            progressPercent: 0,
            relaxEnergyStop: null,
            relaxTimeStop: null,
            relaxTorqueStop: null,
            runId: "none",
            state: "idle",
          },
          selectedStage: null,
          stages: [],
        }}
        sessionDiscretization="fdm"
        snapshot={{
          boundary: testBoundary({
            demagRealization: "multilayer_convolution",
            femDemagSolverPolicy: '{"solver":"CG"}',
          }),
          requested: testRequested(),
          stages: [],
        }}
        onCommit={() => undefined}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain("FDM demag");
    expect(html).toContain("FDM multilayer convolution");
    expect(html).toContain("Not applicable for an explicit FDM lane");
    expect(html).not.toContain("FEM demag policy JSON object");
    expect(html).not.toContain("Poisson Robin");
  });

  it("marks FDM single grid unsupported for a multi-magnet draft without hiding auto or multilayer", () => {
    const html = renderToStaticMarkup(
      <StudyBoundarySection
        algorithmsAvailable={[]}
        authoringBusy={false}
        authoringFeedback={null}
        draft={{
          ...createStudyGlobalDraft({
            study: {
              requested_backend: "fdm",
              fdm: {
                default_cell: [2e-9, 2e-9, 1e-9],
                demag: { strategy: "single_grid", mode: "auto" },
              },
            },
          }),
          demagRealization: "single_grid",
        }}
        magneticObjectCount={2}
        model={{
          boundary: testBoundary({ demagRealization: "single_grid" }),
          requested: testRequested({ backend: "fdm" }),
          runtime: {
            activeStageLabel: "No active stage",
            commandBadge: "idle",
            commandError: null,
            commandId: null,
            commandLabel: "No queued commands",
            maxTorque: "unavailable",
            progressPercent: 0,
            relaxEnergyStop: null,
            relaxTimeStop: null,
            relaxTorqueStop: null,
            runId: "none",
            state: "idle",
          },
          selectedStage: null,
          stages: [],
        }}
        sessionDiscretization="fdm"
        snapshot={{
          boundary: testBoundary({ demagRealization: "single_grid" }),
          requested: testRequested({ backend: "fdm" }),
          stages: [],
        }}
        onCommit={() => undefined}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toMatch(
      /<option disabled="" value="single_grid" selected="">FDM single grid \(unsupported for multiple magnets\)<\/option>/,
    );
    expect(html).toContain(
      "multi-body FDM currently supports only the multilayer_convolution strategy",
    );
    expect(html).toContain('<option value="auto">Auto</option>');
    expect(html).toContain('<option value="multilayer_convolution">FDM multilayer convolution</option>');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Save globals<\/button>/);
  });

  it("renders spectral stage authoring fields", () => {
    const draft = createDefaultStudyStageDraft("frequency_response", 0);
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <StudyPipelineSection
          activeStageIndex={0}
          authoringBusy={false}
          authoringFeedback={null}
          commandDisabledReason={() => null}
          draft={draft}
          draftIndex={0}
          drafts={[draft]}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Frequency 1",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No queued commands",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "none",
              state: "idle",
            },
            selectedStage: null,
            stages: [],
          }}
          onAddStage={() => undefined}
          onCommit={() => undefined}
          onDuplicateStage={() => undefined}
          onMoveStage={() => undefined}
          onRemoveStage={() => undefined}
          onSelectDraft={() => undefined}
          onUpdateDraft={() => undefined}
          runCommand={() => undefined}
        />
      </Accordion>,
    );

    expect(html).toContain("Frequency Response");
    expect(html).toContain("Frequencies");
    expect(html).toContain("Excitation");
    expect(html).toContain("Include demag");
    expect(html).toContain(
      "Solver implementation is resolved from device, precision, certificates, and active capabilities.",
    );
    expect(html).not.toContain("Solver method");
    expect(html).not.toContain("GPU operator host Krylov");
    expect(html).toContain("k sampling");
    expect(html).toContain("BC");
  });

  it("shows auto-scaled frequency previews while storing spectral draft values in Hz", () => {
    const responseDraft = {
      ...createDefaultStudyStageDraft("frequency_response", 0),
      frequenciesHz: "9500000000 12000000000",
    };
    const eigenDraft = {
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      target: "nearest",
      targetFrequency: "750000000",
    };
    const windowDraft = {
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      frequencyMax: "2500000000",
      frequencyMin: "1500000000",
      target: "frequency_window",
    };

    const responseHtml = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={responseDraft}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );
    const eigenHtml = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={eigenDraft}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );
    const windowHtml = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={windowDraft}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(responseHtml).toContain("Stored as Hz; preview 9.5 GHz, 12 GHz");
    expect(responseHtml).toContain('value="9500000000 12000000000"');
    expect(eigenHtml).toContain("Stored as Hz; preview 750 MHz");
    expect(eigenHtml).toContain('value="750000000"');
    expect(windowHtml).toContain('value="frequency_window"');
    expect(windowHtml).toContain('aria-label="Frequency min"');
    expect(windowHtml).toContain('aria-label="Frequency max"');
    expect(windowHtml).toContain('value="1500000000"');
    expect(windowHtml).toContain('value="2500000000"');
  });

  it("renders canonical frequency-window controls for K0 modal authoring", () => {
    const draft = {
      ...createDefaultStudyStageDraft("eigenmodes", 0),
      frequencyMax: "2e9",
      frequencyMin: "1e9",
      target: "frequency_window",
    };
    const html = renderToStaticMarkup(
      <StudyStageDraftEditor
        draft={draft}
        index={0}
        validation={[]}
        onUpdate={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Frequency min"');
    expect(html).toContain('aria-label="Frequency max"');
    expect(html).toContain('value="1e9"');
    expect(html).toContain('value="2e9"');
    expect(html).toContain('value="frequency_window"');
  });

  it("renders change-device stage authoring controls", () => {
    const draft = createDefaultStudyStageDraft("change_device", 0);
    const html = renderToStaticMarkup(
      <Accordion type="multiple" defaultValue={["pipeline"]}>
        <StudyPipelineSection
          activeStageIndex={0}
          authoringBusy={false}
          authoringFeedback={null}
          commandDisabledReason={() => null}
          draft={draft}
          draftIndex={0}
          drafts={[draft]}
          model={{
            boundary: testBoundary(),
            requested: testRequested(),
            runtime: {
              activeStageLabel: "Change Device 1",
              commandBadge: "idle",
              commandError: null,
              commandId: null,
              commandLabel: "No queued commands",
              maxTorque: "unavailable",
              progressPercent: 0,
              relaxEnergyStop: null,
              relaxTimeStop: null,
              relaxTorqueStop: null,
              runId: "none",
              state: "idle",
            },
            selectedStage: null,
            stages: [],
          }}
          onAddStage={() => undefined}
          onCommit={() => undefined}
          onDuplicateStage={() => undefined}
          onMoveStage={() => undefined}
          onRemoveStage={() => undefined}
          onSelectDraft={() => undefined}
          onUpdateDraft={() => undefined}
          runCommand={() => undefined}
        />
      </Accordion>,
    );

    expect(html).toContain("Change Device");
    expect(html).toContain("Device");
    expect(html).toContain("CPU");
    expect(html).toContain("CUDA");
  });
});
