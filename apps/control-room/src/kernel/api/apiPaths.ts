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

export const DATA_DOMAIN_META_PATH = openApiV2Path(
  "/v2/sessions/current/data/domain/meta",
);

export const DATA_DOMAIN_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/data/domain/topology",
);

export const DATA_FIELD_VECTOR_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/samples/vector",
);

export const MESHING_SHARED_DOMAIN_MANIFEST_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
);

export const MESHING_SHARED_DOMAIN_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/topology",
);

export const MESHING_OBJECT_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/objects/{object_id}/topology",
);

export const MESHING_PART_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/parts/{part_id}/topology",
);

export const MODEL_UNIVERSE_PATH = openApiV2Path(
  "/v2/sessions/current/model/universe",
);

export const MODEL_SCENE_PATH = openApiV2Path(
  "/v2/sessions/current/model/scene",
);

export const VISUALIZATION_STATE_PATH = openApiV2Path(
  "/v2/sessions/current/visualization/state",
);

export const SIMULATION_COMMANDS_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/commands",
);

export const SIMULATION_COMMAND_DETAIL_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/commands/{command_id}",
);
