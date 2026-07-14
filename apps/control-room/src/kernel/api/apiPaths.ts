import { openApiV2Path } from "./generated/openapi-v2-paths";

export const API_CONTRACT_VERSION_HEADER = "x-api-contract-version";
export const EXPECTED_API_CONTRACT_VERSION = "1.0.0";

export const PLATFORM_INDEX_PATH = openApiV2Path(
  "/v2/",
);

export const PLATFORM_ASYNCAPI_PATH = openApiV2Path(
  "/v2/platform/asyncapi.json",
);

export const PLATFORM_ASYNCAPI_DOCS_PATH = openApiV2Path(
  "/v2/platform/docs/asyncapi",
);

export const PLATFORM_CAPABILITIES_PATH = openApiV2Path(
  "/v2/platform/capabilities",
);

export const PLATFORM_HEALTH_PATH = openApiV2Path(
  "/v2/platform/health",
);

export const PLATFORM_OPENAPI_PATH = openApiV2Path(
  "/v2/platform/openapi.json",
);

export const SESSIONS_PATH = openApiV2Path(
  "/v2/sessions",
);

export const SESSION_EVENTS_WS_PATH = openApiV2Path(
  "/v2/sessions/current/events/ws",
);

export const SESSION_EVENTS_COMMUNICATION_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/events/communication-policy",
);

export const SESSION_CURRENT_PATH = openApiV2Path(
  "/v2/sessions/current",
);

export const SESSION_STATUS_PATH = openApiV2Path(
  "/v2/sessions/current/status",
);

export const ANALYSIS_FREQUENCY_RESPONSE_MAGNETIC_SWEEP_V1_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1",
);

export const ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge",
);

export const ANALYSIS_FREQUENCY_DOMAIN_MANIFEST_V1_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
);

export const ANALYSIS_FREQUENCY_DOMAIN_EIGEN_SPECTRUM_V2_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
);

export const ANALYSIS_FREQUENCY_DOMAIN_EIGEN_BRANCHES_V2_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
);

export const ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DISPERSION_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
);

export const ANALYSIS_FREQUENCY_DOMAIN_EIGEN_DIAGNOSTICS_V2_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
);

export const ANALYSIS_FREQUENCY_DOMAIN_EIGEN_MODE_FIELD_META_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{mode_index}/meta",
);

export const ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_MAGNETIC_SWEEP_PATH =
  openApiV2Path(
    "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
  );

export const ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_PROGRESS_V1_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
);

export const ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_CANCEL_REQUESTED_V1_PATH =
  openApiV2Path(
    "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1",
  );

export const ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_DIAGNOSTICS_V1_PATH =
  openApiV2Path(
    "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
  );

export const ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FREQUENCY_POINT_PATH =
  openApiV2Path(
    "/v2/sessions/current/analysis/frequency-domain/response/frequency-points/{frequency_index}",
  );

export const ANALYSIS_FREQUENCY_DOMAIN_RESPONSE_FIELD_META_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/frequency-domain/response/field/{frequency_index}/meta",
);

export const ANALYSIS_HYSTERESIS_POINTS_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/points",
);

export const ANALYSIS_HYSTERESIS_METRICS_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/metrics",
);

export const ANALYSIS_HYSTERESIS_SATURATION_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/saturation",
);

export const ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/adaptive-refinement",
);

export const ANALYSIS_HYSTERESIS_BRANCHES_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/branches",
);

export const ANALYSIS_HYSTERESIS_BOOKMARKS_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/bookmarks",
);

export const ANALYSIS_HYSTERESIS_FAMILY_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis-family/{stage_id}",
);

export const ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis-family/{stage_id}/variants/{variant_id}/points",
);

export const ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/minor-loops",
);

export const ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/reversal-fields",
);

export const ANALYSIS_HYSTERESIS_POINT_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}",
);

export const ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/settle-trace",
);

export const ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}/settle-trace",
);

export const ANALYSIS_EIGEN_BRANCHES_V2_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigen/branches.v2",
);

export const ANALYSIS_EIGEN_DISPERSION_CSV_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigen/dispersion.csv",
);

export const ANALYSIS_EIGEN_MODE_V2_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigen/modes/{sample_index}/{mode_index}",
);

export const ANALYSIS_EIGEN_SPECTRUM_V2_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigen/spectrum.v2",
);

export const ANALYSIS_EIGENMODES_BRANCHES_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigenmodes/branches",
);

export const ANALYSIS_EIGENMODES_DISPERSION_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigenmodes/dispersion",
);

export const ANALYSIS_EIGENMODE_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigenmodes/modes/{mode_id}",
);

export const ANALYSIS_EIGENMODES_SPECTRUM_PATH = openApiV2Path(
  "/v2/sessions/current/analysis/eigenmodes/spectrum",
);

export const DATA_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields",
);

export const DATA_QUANTITIES_PATH = openApiV2Path(
  "/v2/sessions/current/data/quantities",
);

export const DATA_ARTIFACTS_PATH = openApiV2Path(
  "/v2/sessions/current/data/artifacts",
);

export const DATA_ARTIFACT_PATH = openApiV2Path(
  "/v2/sessions/current/data/artifacts/{artifact_id}",
);

export const DATA_SCALARS_PATH = openApiV2Path(
  "/v2/sessions/current/data/scalars",
);

export const DATA_TABLE_ROWS_PATH = openApiV2Path(
  "/v2/sessions/current/data/tables/{table_id}/rows",
);

export const DATA_TABLES_PATH = openApiV2Path(
  "/v2/sessions/current/data/tables",
);

export const DATA_TABLE_PATH = openApiV2Path(
  "/v2/sessions/current/data/tables/{table_id}",
);

export const DATA_TABLE_COLUMNS_PATH = openApiV2Path(
  "/v2/sessions/current/data/tables/{table_id}/columns",
);

export const DATA_TABLE_ROWS_BINARY_PATH = openApiV2Path(
  "/v2/sessions/current/data/tables/{table_id}/rows.bin",
);

export const DATA_DOMAIN_META_PATH = openApiV2Path(
  "/v2/sessions/current/data/domain/meta",
);

export const DATA_DOMAIN_TOPOLOGY_PATH = openApiV2Path(
  "/v2/sessions/current/data/domain/topology",
);

export const DATA_DOMAIN_SLICE_MESH_OVERLAY_PATH = openApiV2Path(
  "/v2/sessions/current/data/domain/slice/mesh-overlay",
);

export const DATA_MATERIAL_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/data/material-fields",
);

export const DATA_MATERIAL_FIELD_PATH = openApiV2Path(
  "/v2/sessions/current/data/material-fields/{field_id}",
);

export const DATA_MESH_REGION_MEMBERSHIP_PATH = openApiV2Path(
  "/v2/sessions/current/data/mesh-region-membership/{region_id}",
);

export const DATA_MESH_REGION_MEMBERSHIPS_PATH = openApiV2Path(
  "/v2/sessions/current/data/mesh-region-memberships",
);

export const DATA_FDM_REGION_MEMBERSHIPS_PATH = openApiV2Path(
  "/v2/sessions/current/data/fdm-region-memberships",
);

export const DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH = openApiV2Path(
  "/v2/sessions/current/data/fdm-region-membership",
);

export const DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH = openApiV2Path(
  "/v2/sessions/current/data/fdm-region-membership/{region_id}",
);

export const DATA_FIELD_META_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/meta",
);

export const DATA_FIELD_PROJECTION_META_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/projection/meta",
);

export const DATA_FIELD_PROJECTION_SCALAR_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/projection/scalar",
);

export const DATA_FIELD_PROJECTION_MATRIX_JSON_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/projection/matrix.json",
);

export const DATA_FIELD_PROJECTION_RENDER_PNG_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/projection/render.png",
);

export const DATA_FIELD_PROJECTION_EMPTY_MASK_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/projection/empty-mask",
);

export const DATA_FIELD_PROJECTION_PROFILE_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/projection/profile",
);

export const DATA_FIELD_SLICE_META_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta",
);

export const DATA_FIELD_SLICE_SCALAR_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/scalar",
);

export const DATA_FIELD_SLICE_MATRIX_JSON_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/matrix.json",
);

export const DATA_FIELD_SLICE_RENDER_PNG_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/render.png",
);

export const DATA_FIELD_SLICE_ARROWS_PATH = openApiV2Path(
  "/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows",
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

export const MESHING_SHARED_DOMAIN_CROSS_SECTION_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section",
);

export const MESHING_SHARED_DOMAIN_CROSS_SECTION_IMAGE_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image",
);

export const MESHING_SHARED_DOMAIN_CROSS_SECTION_QUALITY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality",
);

export const MESHING_SUMMARY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/summary",
);

export const MESHING_CAPABILITIES_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/capabilities",
);

export const MESHING_PERIODIC_PAIRS_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/mesh/periodic_pairs.v1",
);

export const MESHING_PERIODIC_PAIRS_BINARY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/mesh/periodic_pairs.v1.bin",
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

export const MESHING_REGION_QUALITY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/regions/{region_id}/quality",
);

export const MESHING_OBJECT_SIZE_FIELD_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/objects/{object_id}/size-field",
);

export const MESHING_INTERFACE_REPORT_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/interfaces/{interface_id}/report",
);

export const MESHING_INTERFACE_QUALITY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/interfaces/{interface_id}/quality",
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

export const MESHING_INTERFACE_POLICY_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/policies/interfaces/{interface_id}",
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

export const MESHING_HISTOGRAM_BIN_ELEMENTS_PATH = openApiV2Path(
  "/v2/sessions/current/meshing/meshes/{mesh_id}/parts/{part_id}/histogram-bins/{metric}/{bin_index}/elements",
);

export const MODEL_UNIVERSE_PATH = openApiV2Path(
  "/v2/sessions/current/model/universe",
);

export const MODEL_UNIVERSE_FIT_PATH = openApiV2Path(
  "/v2/sessions/current/model/universe/fit",
);

export const MODEL_SCENE_PATH = openApiV2Path(
  "/v2/sessions/current/model/scene",
);

export const MODEL_STUDY_PATH = openApiV2Path(
  "/v2/sessions/current/model/study",
);

export const MODEL_SCRIPT_PATH = openApiV2Path(
  "/v2/sessions/current/model/script",
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

export const MODEL_OBJECT_REGIONS_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}/regions",
);

export const MODEL_OBJECT_REGIONS_REORDER_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}/regions/reorder",
);

export const MODEL_OBJECT_REGION_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}/regions/{region_id}",
);

export const MODEL_OBJECT_REGION_DUPLICATE_PATH = openApiV2Path(
  "/v2/sessions/current/model/objects/{object_id}/regions/{region_id}/duplicate",
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

export const MODEL_REALIZED_REGIONS_PATH = openApiV2Path(
  "/v2/sessions/current/model/realized-regions",
);

export const MODEL_REGION_DIAGNOSTICS_PATH = openApiV2Path(
  "/v2/sessions/current/model/region-diagnostics",
);

export const MODEL_MATERIAL_FIELDS_PATH = openApiV2Path(
  "/v2/sessions/current/model/material-fields",
);

export const MODEL_COUPLINGS_PATH = openApiV2Path(
  "/v2/sessions/current/model/couplings",
);

export const MODEL_COUPLING_PATH = openApiV2Path(
  "/v2/sessions/current/model/couplings/{coupling_id}",
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

export const VISUALIZATION_DISPLAY_PATH = openApiV2Path(
  "/v2/sessions/current/visualization/display",
);

export const VISUALIZATION_CLIENT_ACKS_PATH = openApiV2Path(
  "/v2/sessions/current/visualization/client-acks",
);

export const WORKSPACE_LAYOUT_PATH = openApiV2Path(
  "/v2/sessions/current/workspace/layout",
);

export const WORKSPACE_RIBBON_PATH = openApiV2Path(
  "/v2/sessions/current/workspace/ribbon",
);

export const WORKSPACE_SELECTION_PATH = openApiV2Path(
  "/v2/sessions/current/workspace/selection",
);

export const WORKSPACE_TREE_ACTIVE_NODE_PATH = openApiV2Path(
  "/v2/sessions/current/workspace/tree/active-node",
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

export const SIMULATION_STAGE_HYSTERESIS_PLAN_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/plan",
);

export const SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/protocol",
);

export const SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/saturation",
);

export const SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/orientation",
);

export const SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/settle-pipeline",
);

export const SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/execution-tree",
);

export const SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH = openApiV2Path(
  "/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/progress",
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

export const PERSISTENCE_FIELD_STATE_EXPORTS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/field-states/exports",
);

export const PERSISTENCE_FIELD_STATE_IMPORTS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/field-states/imports",
);

export const PERSISTENCE_FIELD_STATE_IMPORT_INSPECTIONS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/field-states/imports/inspections",
);

export const PERSISTENCE_IMPORTS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/imports",
);

export const PERSISTENCE_IMPORT_INSPECTIONS_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/imports/inspections",
);

export const PERSISTENCE_ASSET_IMPORT_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/assets/import",
);

export const PERSISTENCE_RECOVERY_PATH = openApiV2Path(
  "/v2/sessions/current/persistence/recovery",
);
