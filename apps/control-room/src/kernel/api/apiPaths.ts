import { openApiV2Path } from "./generated/openapi-v2-paths";

export const API_CONTRACT_VERSION_HEADER = "x-api-contract-version";
export const EXPECTED_API_CONTRACT_VERSION = "1.0.0";

export const SESSION_EVENTS_WS_PATH = openApiV2Path(
  "/v2/sessions/current/events/ws",
);

export const SESSION_STATUS_PATH = openApiV2Path(
  "/v2/sessions/current/status",
);

export const DATA_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields",
);

export const SIMULATION_COMMANDS_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/commands",
);

export const SIMULATION_COMMAND_DETAIL_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/commands/{command_id}",
);
