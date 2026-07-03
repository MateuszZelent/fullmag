import type {
  RuntimeCommandPrecondition,
  RuntimeCommandTarget,
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

function createRuntimeClientIntentId(kind: SimpleStudyRuntimeCommandKind): string {
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
