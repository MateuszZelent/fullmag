import {
  DATA_FIELDS_PATH,
  SIMULATION_COMMANDS_PATH,
} from "../api/apiPaths";
import type { CommandContribution } from "../commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";

export const STUDY_RUNTIME_COMMANDS: CommandContribution[] = [
  {
    id: "study.compute-fields",
    title: "Compute Fields",
    category: "Study",
    group: "study-runtime",
    scope: "runtime",
    isEnabled: (context) => Boolean(context.api),
    disabledReason: (context) =>
      context.api ? null : "Control-room API is unavailable.",
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

      const revision = response.command_id ?? `compute-fields:${Date.now()}`;
      context.resources?.invalidate(SIMULATION_COMMANDS_PATH, revision);
      context.resources?.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      context.resources?.invalidate(DATA_FIELDS_PATH, revision);
      context.resources?.invalidatePrefix(DATA_FIELDS_PATH, revision);

      return {
        message: "Compute fields command accepted.",
        status: "completed",
      };
    },
  },
];
