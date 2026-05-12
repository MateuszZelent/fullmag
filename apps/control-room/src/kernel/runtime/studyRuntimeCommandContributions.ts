import {
  DATA_FIELDS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_RUN_CURRENT_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
} from "../api/apiPaths";
import type { JsonObject, StructuredCommandRequest } from "../api/apiTypes";
import type { CommandContext } from "../commands/commandTypes";
import type { CommandContribution } from "../commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

const DEFAULT_RELAX_STAGE: JsonObject = {
  entrypoint_kind: "relax",
  energy_tolerance: "",
  fixed_timestep: "",
  integrator: "auto",
  kind: "relax",
  max_physical_time_s: "",
  max_pseudotime_s: "",
  max_steps: "10000",
  relax_algorithm: "llg_overdamped",
  torque_tolerance: "1e-4",
};

const DEFAULT_RUN_STAGE: JsonObject = {
  demag_interval_s: "",
  entrypoint_kind: "run",
  fixed_timestep: "",
  integrator: "auto",
  kind: "run",
  until_seconds: "1e-9",
};

function disabledWithoutApi(context: CommandContext): string | null {
  return context.api ? null : "Control-room API is unavailable.";
}

function isApiAvailable(context: CommandContext): boolean {
  return Boolean(context.api);
}

function commandRevision(response: { command_id?: string | null }, fallback: string): string {
  return response.command_id ?? `${fallback}:${Date.now()}`;
}

function invalidateRuntimeResources(
  context: CommandContext,
  revision: string | number,
): void {
  context.resources?.invalidate(SIMULATION_COMMANDS_PATH, revision);
  context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
  context.resources?.invalidate(SIMULATION_RUN_CURRENT_PATH, revision);
  context.resources?.invalidate(SIMULATION_STAGES_EXECUTION_PATH, revision);
  context.resources?.invalidate(SIMULATION_SOLVER_STATUS_PATH, revision);
}

async function submitRuntimeCommand(
  context: CommandContext,
  command: StructuredCommandRequest,
  successMessage: string,
): Promise<{ message: string; status: "completed" | "failed" }> {
  if (!context.api) {
    return { message: "Control-room API is unavailable.", status: "failed" };
  }

  const response = await context.api.commands.submit(command);
  if (!response.accepted) {
    return {
      message: response.error ?? `${successMessage} rejected.`,
      status: "failed",
    };
  }

  invalidateRuntimeResources(
    context,
    commandRevision(response, `study:${command.kind}`),
  );

  return { message: successMessage, status: "completed" };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function studyStages(scene: unknown): JsonObject[] {
  const stages = record(record(scene).study).stages;
  return Array.isArray(stages)
    ? stages.filter((stage): stage is JsonObject =>
        Boolean(stage && typeof stage === "object" && !Array.isArray(stage)),
      )
    : [];
}

function sceneRevision(value: unknown): string | number {
  const revision = record(value).scene_revision ?? record(record(value).committed_scene).revision;
  return typeof revision === "number" || typeof revision === "string"
    ? revision
    : Date.now();
}

function addStageCommand(
  id: string,
  title: string,
  stage: JsonObject,
  successMessage: string,
): CommandContribution {
  return {
    id,
    title,
    category: "Study",
    group: "study-authoring",
    scope: "workspace",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const scene = await context.api.model.scene();
      const nextStages = [...studyStages(scene), stage];
      const response = await context.api.model.commitTransaction({
        kind: "merge_patch",
        merge_patch: {
          study: {
            stages: nextStages,
          },
        },
      });
      const revision = sceneRevision(response);
      context.resources?.invalidate(MODEL_SCENE_PATH, revision);
      context.resources?.invalidate(MODEL_STUDY_PATH, revision);
      context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);

      return { message: successMessage, status: "completed" };
    },
  };
}

function runtimeCommand(
  id: string,
  title: string,
  command: StructuredCommandRequest,
  successMessage: string,
): CommandContribution {
  return {
    id,
    title,
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: (context) => submitRuntimeCommand(context, command, successMessage),
  };
}

export const STUDY_RUNTIME_COMMANDS: CommandContribution[] = [
  addStageCommand(
    "study.add-relax-stage",
    "Add Relax Stage",
    DEFAULT_RELAX_STAGE,
    "Relax stage added.",
  ),
  addStageCommand(
    "study.add-run-stage",
    "Add Run Stage",
    DEFAULT_RUN_STAGE,
    "Run stage added.",
  ),
  runtimeCommand(
    "study.run",
    "Compute Study",
    { kind: "solve" },
    "Study compute command accepted.",
  ),
  runtimeCommand(
    "study.pause",
    "Pause Study",
    { kind: "pause" },
    "Pause command accepted.",
  ),
  runtimeCommand(
    "study.resume",
    "Resume Study",
    { kind: "resume" },
    "Resume command accepted.",
  ),
  runtimeCommand(
    "study.stop",
    "Stop Study",
    { kind: "stop" },
    "Stop command accepted.",
  ),
  runtimeCommand(
    "study.skip",
    "Skip Stage",
    { kind: "skip" },
    "Skip stage command accepted.",
  ),
  {
    id: "study.compute-fields",
    title: "Compute Fields",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: isApiAvailable,
    disabledReason: disabledWithoutApi,
    run: async (context) => {
      if (!context.api) {
        return { message: "Control-room API is unavailable.", status: "failed" };
      }

      const response = await context.api.commands.submit({
        kind: "compute_fields",
      });
      if (!response.accepted) {
        return {
          message: response.error ?? "Compute fields command rejected.",
          status: "failed",
        };
      }

      const revision = commandRevision(response, "compute-fields");
      invalidateRuntimeResources(context, revision);
      context.resources?.invalidate(DATA_FIELDS_PATH, revision);
      context.resources?.invalidatePrefix(DATA_FIELDS_PATH, revision);

      return {
        message: "Compute fields command accepted.",
        status: "completed",
      };
    },
  },
];
