import type {
  RuntimeCommandPrecondition,
  RuntimeCommandTarget,
  RuntimeStageInitialStateRequest,
  StructuredCommandRequest,
} from "../api/apiTypes";

export type SimpleStudyRuntimeCommandKind =
  | "compute_energies"
  | "compute_fields"
  | "pause"
  | "resume"
  | "save_vtk"
  | "skip"
  | "solve"
  | "stop";

type SimpleStudyRuntimeCommand = Extract<
  StructuredCommandRequest,
  { kind: SimpleStudyRuntimeCommandKind }
>;

interface StudyRuntimeCommandOptions {
  clientIntentId?: string;
  precondition?: RuntimeCommandPrecondition;
  reason?: string;
  requestedAtUnixMs?: number;
  target?: RuntimeCommandTarget;
}

const STUDY_TARGET: RuntimeCommandTarget = { kind: "study" };
const CURRENT_STAGE_TARGET: RuntimeCommandTarget = { kind: "current_stage" };

export function buildStudyRuntimeCommand(
  kind: SimpleStudyRuntimeCommandKind,
  options: StudyRuntimeCommandOptions = {},
): SimpleStudyRuntimeCommand {
  return pruneUndefined({
    client_intent_id:
      options.clientIntentId ?? createRuntimeClientIntentId(kind),
    kind,
    precondition: options.precondition,
    reason: options.reason ?? "user_requested",
    requested_at_unix_ms: options.requestedAtUnixMs ?? Date.now(),
    target: options.target ?? defaultTargetForKind(kind),
  }) as SimpleStudyRuntimeCommand;
}

export type StudyPhysicalStageCommandKind = "run" | "relax";

export function buildAuthoredStudyStageCommand(
  kind: StudyPhysicalStageCommandKind,
  stageId: string,
  options: Omit<StudyRuntimeCommandOptions, "target"> & { initialState?: RuntimeStageInitialStateRequest } = {},
): StructuredCommandRequest {
  const target: Extract<RuntimeCommandTarget, { kind: "stage_id" }> = {
    kind: "stage_id",
    stage_id: stageId,
  };
  const intent = {
    client_intent_id: options.clientIntentId ?? createRuntimeClientIntentId(kind),
    initial_state: options.initialState ?? { kind: "default_for_target" as const },
    precondition: options.precondition,
    reason: options.reason ?? "user_requested",
    requested_at_unix_ms: options.requestedAtUnixMs ?? Date.now(),
    target,
  };
  return kind === "run" ? { ...intent, kind: "run" } : { ...intent, kind: "relax" };
}

function defaultTargetForKind(
  kind: SimpleStudyRuntimeCommandKind,
): RuntimeCommandTarget {
  switch (kind) {
    case "compute_energies":
    case "compute_fields":
    case "solve":
      return STUDY_TARGET;
    case "pause":
    case "resume":
    case "save_vtk":
    case "skip":
    case "stop":
      return CURRENT_STAGE_TARGET;
  }
}

function createRuntimeClientIntentId(kind: SimpleStudyRuntimeCommandKind | StudyPhysicalStageCommandKind): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `study:${kind}:${Date.now()}:${random}`;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
