import {
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "../api/apiPaths";
import type { CommandQueueStatusResource, LiveStatusResource, SceneResource } from "../api/apiTypes";
import { awaitMeshCommandTerminal } from "../authoring/geometryLifecycleCommands";
import { resumeMeshBuildObservation } from "../authoring/geometryLifecycleCommandContributions";
import { studyComputeDraftBlockedReason } from "../authoring/studyComputeDraftGuard";
import { studyComputeConfirmationBlockedReason } from "./studyComputeConfirmation";
import type { CommandRegistry } from "../commands/CommandRegistry";
import { obsoleteSessionResult } from "../commands/commandSessionScope";
import type { CommandContext, CommandContribution, CommandResult } from "../commands/commandTypes";
import { resolveSessionAuthoringDiscretization } from "../resources/sessionDiscretization";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

type BuildCommand = "mesh.build-shared-domain" | "grid.build-fdm";
type BuildPin = NonNullable<CommandContext["meshBuildPin"]>;
type Phase = "building" | "verifying" | "starting" | "checking-start";

interface BuildStudyOperation {
  pin: BuildPin;
  buildCommand: BuildCommand;
  phase: Phase;
  busy: boolean;
  cancelled: boolean;
  build?: CommandResult;
  solve?: CommandResult;
}

const PHASE_LABELS: Record<Phase, string> = {
  building: "Saved model pinned. Building the Study domain…",
  verifying: "Domain built. Verifying the published domain and model readiness…",
  starting: "Domain verified. Requesting Study preparation and Compute…",
  "checking-start": "Checking the existing Study submission…",
};

const fail = (message: string): CommandResult => ({ status: "failed", message });
const pending = (message: string): CommandResult => ({ status: "pending", observation: "publication-unconfirmed", message });
const cancelled = (): CommandResult => ({
  status: "cancelled", message: "Build + Study was cancelled before Compute.",
});

function statusFrom(context: CommandContext) {
  return context.resourceData?.[SESSION_STATUS_RESOURCE_KEY] as LiveStatusResource | undefined;
}

function buildFor(status: LiveStatusResource | undefined): BuildCommand | null {
  const method = resolveSessionAuthoringDiscretization(status);
  return method === "fem" ? "mesh.build-shared-domain" : method === "fdm" ? "grid.build-fdm" : null;
}

function runPin(status: LiveStatusResource): NonNullable<BuildPin["current_run"]> {
  return status.run ? { kind: "run", run_id: status.run.run_id } : { kind: "none" };
}

function sameRun(left: BuildPin["current_run"], right: BuildPin["current_run"]): boolean {
  return left?.kind === right?.kind &&
    (left?.kind !== "run" || (right?.kind === "run" && left.run_id === right.run_id));
}

function buildPin(context: CommandContext): BuildPin | null {
  const status = statusFrom(context);
  if (!status) return null;
  const { scene_revision, mesh_revision } = status.resources;
  const displayed = context.resourceData?.[MODEL_SCENE_PATH] as SceneResource | null | undefined;
  if (typeof scene_revision !== "number" || !Number.isSafeInteger(scene_revision) ||
      !Number.isSafeInteger(mesh_revision) ||
      (displayed?.revision != null && displayed.revision !== scene_revision)) return null;
  return { scene_revision, mesh_revision, current_run: runPin(status) };
}

function hasCompetingCompute(queue: CommandQueueStatusResource | undefined) {
  return queue?.commands.some((command) =>
    ["solve", "run", "relax", "mesh_build", "remesh", "fdm_grid_refresh"].includes(command.kind) &&
    ["accepted", "dispatched", "pending", "queued", "running"].includes(command.status),
  ) ?? false;
}

async function resolveBuildResult(
  registry: CommandRegistry,
  context: CommandContext,
  operation: BuildStudyOperation,
): Promise<CommandResult> {
  const buildContext = { ...context, meshBuildPin: operation.pin, feedback: "local" as const, input: undefined };
  if (!operation.build) return registry.execute(operation.buildCommand, buildContext);
  if (operation.build.status !== "pending") return operation.build;
  const resumed = await resumeMeshBuildObservation(buildContext, operation.build.clientIntentId);
  if (resumed.status !== "cancelled" || !operation.build.commandId) return resumed;
  // A separate observation may have completed the same build after we paused.
  // Re-read that command's proof instead of invoking Build again.
  const terminal = await awaitMeshCommandTerminal(context.api!.commands, operation.build.commandId, {
    requestOptions: { sessionScopeKey: context.sessionScopeKey ?? undefined },
    baseMeshRevision: operation.pin.mesh_revision,
    allowSameMeshRevision: true,
    pollDelaysMs: [0],
  });
  return { ...operation.build, status: terminal.status, message: terminal.message, observation: terminal.observation };
}

async function verifyBuiltDomain(context: CommandContext, operation: BuildStudyOperation) {
  const api = context.api!;
  const build = operation.build!;
  const options = { sessionScopeKey: context.sessionScopeKey ?? undefined };
  const fem = operation.buildCommand === "mesh.build-shared-domain";
  const [detail, status, scene, readiness, currentBuild, queue, solver, stages, manifest, preparation] =
    await Promise.all([
      api.commands.detail(build.commandId!, options),
      api.sessions.current.status(options),
      api.model.scene(options),
      api.model.readiness(options),
      api.meshing.builds.current(options),
      api.commands.list(options),
      api.simulation.solver.status(options),
      api.simulation.stages.execution(options),
      fem ? api.meshing.sharedDomainManifest(options) : null,
      fem ? null : api.simulation.preparation(options),
    ]);
  const sceneRevision = operation.pin.scene_revision;
  const meshRevision = status.resources.mesh_revision;
  const provenance = currentBuild.provenance;
  const original = detail.precondition;
  const expectedKind = fem ? ["mesh_build", "remesh"] : ["fdm_grid_refresh"];
  if (detail.command_id !== build.commandId || detail.client_intent_id !== build.clientIntentId ||
      !expectedKind.includes(detail.kind) || detail.status !== "completed" ||
      (detail.completion_status != null && detail.completion_status !== "completed") ||
      original?.scene_revision !== sceneRevision || original?.mesh_revision !== operation.pin.mesh_revision ||
      !sameRun(original?.current_run, operation.pin.current_run) ||
      (fem && detail.mesh_target?.kind !== "study_domain")) {
    return { result: fail("The build command does not match the original Build + Study request.") };
  }
  if (status.resources.scene_revision !== sceneRevision || scene.revision !== sceneRevision ||
      readiness.scene_revision !== sceneRevision || buildFor(status) !== operation.buildCommand) {
    return { result: fail("The saved model changed while the domain was building. Review it before starting Study.") };
  }
  const domain = status.resources.domain_generation_id;
  if (provenance?.command_id !== build.commandId || !provenance.build_id ||
      provenance.source_scene_revision !== sceneRevision || provenance.mesh_revision !== meshRevision ||
      !domain || meshRevision < (operation.pin.mesh_revision ?? 0) ||
      queue.commands.some((entry) => entry.seq > detail.seq &&
        ["remesh", "mesh_build", "fdm_grid_refresh", "solve", "run", "relax"].includes(entry.kind))) {
    return { result: fail("The published domain no longer belongs to this build. Review the current mesh before starting Study.") };
  }
  if (fem) {
    if (!sameRun(runPin(status), operation.pin.current_run) ||
        !manifest || manifest.source_scene_revision !== sceneRevision || manifest.revision !== meshRevision ||
        manifest.generation_id !== domain || !manifest.topology_fingerprint) {
      return { result: fail("The built FEM domain or current run changed before Study.") };
    }
  } else {
    const run = detail.target?.kind === "run" ? detail.target.run_id : null;
    if (!run || run !== status.run?.run_id || preparation?.status !== "ready" ||
        preparation.receipt?.run_id !== run || preparation.receipt.preparation_id !== preparation.preparation_id ||
        !preparation.receipt.plan_fingerprint || !preparation.receipt.payload_sha256) {
      return { result: fail("The FDM build did not publish a ready preparation for its held Study.") };
    }
  }
  if (!readiness.ready_to_run) {
    return { result: fail(`Domain built. ${readiness.blockers[0] ?? "Complete the model checklist before starting Study."}`) };
  }
  return { resources: {
    ...context.resourceData,
    [SESSION_STATUS_RESOURCE_KEY]: status,
    [MODEL_SCENE_PATH]: scene,
    [MODEL_READINESS_PATH]: readiness,
    [MESHING_BUILDS_CURRENT_PATH]: currentBuild,
    [MESHING_SHARED_DOMAIN_MANIFEST_PATH]: manifest,
    [SIMULATION_COMMANDS_PATH]: queue,
    [SIMULATION_SOLVER_STATUS_PATH]: solver,
    [SIMULATION_STAGES_EXECUTION_PATH]: stages,
  } };
}

export function createBuildStudyCommands(registry: CommandRegistry): CommandContribution[] {
  const operations = new Map<string, BuildStudyOperation>();
  const operationFor = (context: CommandContext) => {
    const operation = operations.get(context.sessionScopeKey ?? "");
    const solve = operation?.solve;
    // The observation owner resolves the original intent. An empty queue alone
    // cannot retire this continuation or authorize another Compute submission.
    if (operation && !operation.busy && solve?.studyComputeObservationStarted &&
        solve.clientIntentId && context.sessionScopeKey && context.commandFeedback &&
        !context.commandFeedback.hasUnresolvedStudyCompute(context.sessionScopeKey, solve.clientIntentId)) {
      return undefined;
    }
    return operation;
  };
  const reason = (context: CommandContext): string | null => {
    if (!context.api || !context.sessionScopeKey) return "Open a current workspace before building and running Study.";
    const operation = operationFor(context);
    if (operation?.busy) return PHASE_LABELS[operation.phase];
    if (operation) return null;
    const confirmation = studyComputeConfirmationBlockedReason(context);
    if (confirmation) return confirmation;
    const draft = studyComputeDraftBlockedReason(context);
    if (draft) return draft;
    const build = buildFor(statusFrom(context));
    if (!build || !buildPin(context)) return "Wait for the saved scene and mesh status before building and running Study.";
    const queue = context.resourceData?.[SIMULATION_COMMANDS_PATH] as CommandQueueStatusResource | undefined;
    if (hasCompetingCompute(queue)) return "Wait for the active Build or Study command.";
    return registry.isEnabled(build, context)
      ? null : registry.get(build)?.disabledReason?.(context) ?? "Domain build is unavailable.";
  };
  const canCancel = (context: CommandContext) => {
    const operation = operationFor(context);
    return Boolean(operation && !operation.cancelled && !operation.solve && operation.phase !== "starting");
  };
  return [{
    id: "study.build-and-run",
    title: "Build + Study",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) => reason(context) === null,
    disabledReason: reason,
    isActive: (context) => operationFor(context) !== undefined,
    run: async (context) => {
      const blocked = reason(context);
      if (blocked) return fail(blocked);
      const scope = context.sessionScopeKey!;
      const operation: BuildStudyOperation = operationFor(context) ?? {
        pin: buildPin(context)!, buildCommand: buildFor(statusFrom(context))!,
        phase: "building" as const, busy: false, cancelled: false,
      };
      operations.set(scope, operation);
      operation.busy = true;
      registry.refresh();
      let retain = false;
      try {
        const abandoned = () => operation.cancelled ? cancelled() : obsoleteSessionResult(context);
        if (operation.solve) {
          operation.phase = "checking-start";
          const queue = await context.api!.commands.list({ sessionScopeKey: scope });
          const stopped = abandoned();
          if (stopped) return stopped;
          const matching = queue.commands.filter((entry) => entry.kind === "solve" &&
            entry.client_intent_id === operation.solve?.clientIntentId);
          if (matching.length === 1) return {
            ...operation.solve, commandId: matching[0].command_id,
            message: "Found the original Study submission. Tracking its backend outcome.",
          };
          retain = true;
          return operation.solve;
        }
        operation.phase = "building";
        registry.refresh();
        const buildContext = {
          ...context,
          isCurrentSessionScope: () => abandoned() === null,
        };
        operation.build = await resolveBuildResult(registry, buildContext, operation);
        const stopped = abandoned();
        if (stopped) return stopped;
        if (operation.build.status === "pending") {
          retain = Boolean(operation.build.clientIntentId);
          return pending(operation.build.message ?? "Build is pending. Check this operation again to continue Study.");
        }
        if (operation.build.status !== "completed") return operation.build;
        if (!operation.build.commandId || !operation.build.clientIntentId) {
          return fail("Build completed without a matching command receipt. Study was not submitted.");
        }

        operation.phase = "verifying";
        registry.refresh();
        const proof = await verifyBuiltDomain(context, operation);
        const cancelledBeforeStudy = abandoned();
        if (cancelledBeforeStudy) return cancelledBeforeStudy;
        if (proof.result) return proof.result;
        const draft = studyComputeDraftBlockedReason(context);
        if (draft) return fail(`Domain built. ${draft}`);
        operation.phase = "starting";
        registry.refresh();
        const result = await registry.execute("study.run", {
          ...context, input: undefined, feedback: "local", resourceData: proof.resources,
          sourceDetail: "build-and-study",
        });
        if (result.status === "pending" && !result.commandId && result.clientIntentId) {
          operation.solve = result;
          retain = true;
        }
        return result.status === "pending" ? {
          ...result, message: result.commandId
            ? "Domain built. Study Compute was accepted. Check the runtime for preparation and execution."
            : "Domain built. Study submission confirmation is pending.",
        } : { ...result, message: `Domain built. ${result.message ?? "Study did not start."}` };
      } catch (error) {
        const obsolete = obsoleteSessionResult(context);
        if (obsolete) return obsolete;
        if (operation.cancelled) return cancelled();
        retain = Boolean(operation.build || operation.solve);
        return pending(error instanceof Error ? error.message : "Could not confirm Build + Study. Check this operation again.");
      } finally {
        operation.busy = false;
        if (!retain || operation.cancelled) operations.delete(scope);
        registry.refresh();
      }
    },
  }, {
    id: "study.cancel-build-and-run",
    title: "Cancel Build + Study",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: canCancel,
    disabledReason: () => "No Build + Study operation can be cancelled before Compute.",
    run: (context) => {
      const operation = operationFor(context);
      if (!operation || !canCancel(context)) return fail("Build + Study has no cancellable continuation.");
      operation.cancelled = true;
      if (!operation.busy) operations.delete(context.sessionScopeKey!);
      registry.refresh();
      return cancelled();
    },
  }];
}
