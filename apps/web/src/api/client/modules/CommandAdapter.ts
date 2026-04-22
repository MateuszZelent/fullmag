/**
 * Normalizes loose Control Room command payloads to the structured
 * CommandRequest format
 * expected by CommandsModule.submit().
 */
import type {
  CommandRequest,
} from "../../types";

/**
 * Converts a command payload ({ kind: "pause", ... })
 * into the canonical structured CommandRequest shape.
 */
export function normalizeCommandRequest(
  payload: Record<string, unknown>,
): CommandRequest {
  const command = solverActionToCommand((payload.kind as string) ?? "");
  const params = { ...payload };
  delete params.kind;

  switch (command) {
    case "run":
      return {
        kind: "run",
        until_seconds: numberFromUnknown(params.until_seconds) ?? 0,
        max_steps: integerFromUnknown(params.max_steps),
        integrator: stringFromUnknown(params.integrator),
        fixed_timestep: numberFromUnknown(params.fixed_timestep),
      };
    case "relax":
      return {
        kind: "relax",
        until_seconds: numberFromUnknown(params.until_seconds),
        max_steps: integerFromUnknown(params.max_steps),
        torque_tolerance: numberFromUnknown(params.torque_tolerance),
        energy_tolerance: numberFromUnknown(params.energy_tolerance),
        relax_algorithm: stringFromUnknown(params.relax_algorithm),
        relax_alpha: numberFromUnknown(params.relax_alpha),
        fixed_timestep: numberFromUnknown(params.fixed_timestep),
        max_error: numberFromUnknown(params.max_error),
      };
    case "pause":
      return { kind: "pause" };
    case "resume":
      return { kind: "resume" };
    case "stop":
      return { kind: "stop" };
    case "skip":
      return { kind: "skip" };
    case "save_vtk":
      return { kind: "save_vtk" };
    case "solve":
      return { kind: "solve" };
    case "close":
      return { kind: "close" };
    default:
      throw new Error(`unsupported command kind: ${command}`);
  }
}

/**
 * Maps common solver action names to canonical command strings.
 */
export function solverActionToCommand(action: string): string {
  const mapping: Record<string, string> = {
    compute: "solve",
    run: "run",
    relax: "relax",
    pause: "pause",
    resume: "resume",
    stop: "stop",
    skip: "skip",
    break: "stop",
    skip_stage: "skip",
  };
  return mapping[action] ?? action;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
