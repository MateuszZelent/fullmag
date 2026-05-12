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

export const MESHING_BUILDS_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/builds",
);

export const MESHING_BUILDS_CURRENT_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/builds/current",
);

export const MESHING_BUILDS_LATEST_SUCCESSFUL_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/builds/latest-successful",
);

export const MESHING_OBJECT_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/objects/{object_id}/topology",
);

export const MESHING_OBJECT_REPORT_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/objects/{object_id}/report",
);

export const MESHING_OBJECT_QUALITY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/objects/{object_id}/quality",
);

export const MESHING_OBJECT_SIZE_FIELD_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/objects/{object_id}/size-field",
);

export const MESHING_OBJECT_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/policies/objects/{object_id}",
);

export const MESHING_UNIVERSE_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/policies/universe",
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

export const MODEL_TRANSACTIONS_PATH = openApiV2Path(
  "/v2/sessions/current/model/transactions",
);

export const MODEL_OBJECTS_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects",
);

export const MODEL_OBJECT_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}",
);

export const MODEL_OBJECT_GEOMETRY_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}/geometry",
);

export const MODEL_OBJECT_INTERACTION_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}",
);

export const MODEL_MATERIAL_PATH = openApiV2Path(
  "/v2/sessions/current/model/materials/{material_id}",
);

export const MODEL_REGIONS_PATH = openApiV2Path(
  "/v2/sessions/current/model/regions",
);

export const MODEL_REGION_PATH = openApiV2Path(
  "/v2/sessions/current/model/regions/{region_id}",
);

export const MODEL_GEOMETRY_CAPABILITIES_PATH = openApiV2Path(
  "/v2/sessions/current/model/geometry/capabilities",
);

export const MODEL_GEOMETRY_VALIDATION_PATH = openApiV2Path(
  "/v2/sessions/current/model/geometry/validation",
);

export const MODEL_GEOMETRY_DIAGNOSTICS_PATH = openApiV2Path(
  "/v2/sessions/current/model/geometry/diagnostics",
);

export const MODEL_GEOMETRY_DIAGNOSTIC_PATH = openApiV2Path(
  "/v2/sessions/current/model/geometry/diagnostics/{diagnostic_id}",
);

export const MODEL_GEOMETRY_REALIZATIONS_PATH = openApiV2Path(
  "/v2/sessions/current/model/geometry/realizations",
);

export const MODEL_GEOMETRY_REALIZATION_CURRENT_PATH = openApiV2Path(
  "/v2/sessions/current/model/geometry/realizations/current",
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
