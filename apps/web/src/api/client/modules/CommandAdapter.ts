/**
 * Adapts legacy command payloads to the new CommandRequest format
 * expected by CommandsModule.submit().
 */
import type { CommandRequest } from "../../types";

/**
 * Converts a legacy command payload ({ kind: "pause", ... })
 * into the canonical CommandRequest shape ({ command, params }).
 */
export function adaptLegacyCommand(
  payload: Record<string, unknown>,
): CommandRequest {
  const command = solverActionToCommand((payload.kind as string) ?? "");
  const params = { ...payload };
  delete params.kind;

  return {
    command,
    params: Object.keys(params).length > 0 ? params : undefined,
  };
}

/**
 * Maps common solver action names to canonical command strings.
 */
export function solverActionToCommand(action: string): string {
  const mapping: Record<string, string> = {
    compute: "run",
    run: "run",
    relax: "relax",
    pause: "pause",
    resume: "resume",
    stop: "stop",
    skip: "skip",
  };
  return mapping[action] ?? action;
}
