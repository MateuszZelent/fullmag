import { openApiV2Path } from "./generated/openapi-v2-paths";

export const API_CONTRACT_VERSION_HEADER = "x-api-contract-version";
export const EXPECTED_API_CONTRACT_VERSION = "1.0.0";

export const SESSION_EVENTS_WS_PATH = openApiV2Path(
  "/v2/sessions/current/events/ws",
);

export const SESSION_STATUS_PATH = openApiV2Path(
  "/v2/sessions/current/status",
);

export const ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1",
);

export const DATA_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields",
);

export const DATA_SCALARS_PATH = openApiV2Path(
  "/v2/sessions/current/data/scalars",
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

export const DIAGNOSTICS_ENGINE_LOG_PATH = openApiV2Path(
  "/v2/sessions/current/diagnostics/engine-log",
);

export const DIAGNOSTICS_CPU_PATH = openApiV2Path(
  "/v2/sessions/current/diagnostics/cpu",
);

export const DIAGNOSTICS_GPU_PATH = openApiV2Path(
  "/v2/sessions/current/diagnostics/gpu",
);

export const DIAGNOSTICS_SOLVER_PROFILE_PATH = openApiV2Path(
  "/v2/sessions/current/diagnostics/solver-profile",
);

export const MESHING_SHARED_DOMAIN_MANIFEST_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/manifest",
);

export const MESHING_SHARED_DOMAIN_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/topology",
);

export const MESHING_SUMMARY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/summary",
);

export const MESHING_CAPABILITIES_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/capabilities",
);

export const MESHING_SEMANTICS_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/semantics",
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

export const MESHING_UNIVERSE_REPORT_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/universe/report",
);

export const MESHING_UNIVERSE_QUALITY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/universe/quality",
);

export const MESHING_SHARED_DOMAIN_REPORT_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/report",
);

export const MESHING_SHARED_DOMAIN_QUALITY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/quality",
);

export const MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element",
);

export const MESHING_SHARED_DOMAIN_QUALITY_GATES_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/quality-gates",
);

export const MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields",
);

export const MESHING_OBJECT_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/policies/objects/{object_id}",
);

export const MESHING_UNIVERSE_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/policies/universe",
);

export const MESHING_SHARED_DOMAIN_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/policies/shared-domain",
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

export const MODEL_STUDY_PATH = openApiV2Path(
  "/v2/sessions/current/model/study",
);

export const MODEL_TRANSACTIONS_PATH = openApiV2Path(
  "/v2/sessions/current/model/transactions",
);

export const MODEL_SYNCS_PATH = openApiV2Path(
  "/v2/sessions/current/model/syncs",
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

export const MODEL_MAGNETIZATION_ASSET_PATH = openApiV2Path(
  "/v2/sessions/current/model/magnetization-assets/{asset_id}",
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

export const VISUALIZATION_CLIENT_ACKS_PATH = openApiV2Path(
  "/v2/sessions/current/visualization/client-acks",
);

export const SIMULATION_COMMANDS_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/commands",
);

export const SIMULATION_COMMAND_DETAIL_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/commands/{command_id}",
);

export const SIMULATION_OBJECT_METRICS_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/objects/{object_id}/metrics",
);

export const SIMULATION_RUN_CURRENT_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/runs/current",
);

export const SIMULATION_RUN_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/runs/{run_id}",
);

export const SIMULATION_STAGES_EXECUTION_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/execution",
);

export const SIMULATION_SOLVER_STATUS_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/solver/status",
);

export const SIMULATION_SOLVER_ENERGIES_CURRENT_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/solver/energies/current",
);

export const SIMULATION_SOLVER_ENERGIES_HISTORY_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/solver/energies/history",
);

export const PERSISTENCE_CHECKPOINTS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/checkpoints",
);

export const PERSISTENCE_CHECKPOINT_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/checkpoints/{checkpoint_id}",
);

export const PERSISTENCE_CHECKPOINT_RESTORE_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/checkpoints/{checkpoint_id}/restore",
);

export const PERSISTENCE_EXPORTS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/exports",
);

export const PERSISTENCE_IMPORTS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/imports",
);

export const PERSISTENCE_IMPORT_INSPECTIONS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/imports/inspections",
);
