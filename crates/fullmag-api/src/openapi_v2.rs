//! Native OpenAPI v2 spec assembly.

use serde_json::{json, Value};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::router_v2::handlers::platform::realtime::get_asyncapi_document,
        crate::router_v2::handlers::platform::realtime::get_asyncapi_docs,
        crate::router_v2::handlers::platform::realtime::get_communication_policy,
        crate::router_v2::handlers::platform::realtime::patch_communication_policy,
        crate::router_v2::handlers::platform::realtime::ws_current_live,
        crate::router_v2::handlers::sessions::status::get_status,
        crate::router_v2::handlers::data::domain::get_domain_meta,
        crate::router_v2::handlers::data::domain::get_domain_topology,
        crate::router_v2::handlers::data::domain::get_domain_slice_mesh_overlay,
        crate::router_v2::handlers::data::material_fields::get_material_field_data_catalog,
        crate::router_v2::handlers::data::material_fields::get_material_field_data,
        crate::router_v2::handlers::data::mesh_region_membership::get_mesh_region_memberships,
        crate::router_v2::handlers::data::mesh_region_membership::get_mesh_region_membership,
        crate::router_v2::handlers::data::fdm_region_membership::get_fdm_region_memberships,
        crate::router_v2::handlers::data::fdm_region_membership::get_fdm_region_membership_binary,
        crate::router_v2::handlers::data::fdm_region_membership::get_fdm_region_membership_binary_scoped,
        crate::router_v2::handlers::data::quantities::get_quantities_catalog,
        crate::router_v2::handlers::data::fields::get_field_catalog,
        crate::router_v2::handlers::data::fields::get_field_meta,
        crate::router_v2::handlers::data::fields::get_field_vector,
        crate::router_v2::handlers::data::fields::get_field_projection_meta,
        crate::router_v2::handlers::data::fields::get_field_projection_scalar,
        crate::router_v2::handlers::data::fields::get_field_projection_matrix_json,
        crate::router_v2::handlers::data::fields::get_field_projection_render_png,
        crate::router_v2::handlers::data::fields::get_field_projection_empty_mask,
        crate::router_v2::handlers::data::fields::get_field_projection_profile,
        crate::router_v2::handlers::data::fields::get_field_slice_meta,
        crate::router_v2::handlers::data::fields::get_field_slice_scalar,
        crate::router_v2::handlers::data::fields::get_field_slice_matrix_json,
        crate::router_v2::handlers::data::fields::get_field_slice_render_png,
        crate::router_v2::handlers::data::fields::get_field_slice_arrows,
        crate::router_v2::handlers::data::scalars::get_scalars,
        crate::router_v2::handlers::data::tables::list_tables,
        crate::router_v2::handlers::data::tables::get_table,
        crate::router_v2::handlers::data::tables::get_table_columns,
        crate::router_v2::handlers::data::tables::get_table_rows,
        crate::router_v2::handlers::data::tables::get_table_rows_binary,
        crate::router_v2::handlers::visualization::display::get_display,
        crate::router_v2::handlers::visualization::display::replace_display,
        crate::router_v2::handlers::visualization::display::patch_display,
        crate::router_v2::handlers::visualization::display::get_visualization_state,
        crate::router_v2::handlers::visualization::display::replace_visualization_state,
        crate::router_v2::handlers::visualization::display::patch_visualization_state,
        crate::router_v2::handlers::visualization::display::get_visualization_client_acks,
        crate::router_v2::handlers::visualization::display::post_visualization_client_ack,
        crate::router_v2::handlers::workspace::workspace::get_workspace_selection,
        crate::router_v2::handlers::workspace::workspace::replace_workspace_selection,
        crate::router_v2::handlers::workspace::workspace::get_workspace_active_node,
        crate::router_v2::handlers::workspace::workspace::replace_workspace_active_node,
        crate::router_v2::handlers::workspace::workspace::get_workspace_ribbon,
        crate::router_v2::handlers::workspace::workspace::replace_workspace_ribbon,
        crate::router_v2::handlers::workspace::workspace::get_workspace_layout,
        crate::router_v2::handlers::workspace::workspace::replace_workspace_layout,
        crate::router_v2::handlers::meshing::mesh::get_mesh_summary,
        crate::router_v2::handlers::meshing::mesh::get_mesh_capabilities,
        crate::router_v2::handlers::meshing::mesh::get_mesh_semantics,
        crate::router_v2::handlers::meshing::mesh::get_mesh_active_build,
        crate::router_v2::handlers::meshing::mesh::get_mesh_build_history,
        crate::router_v2::handlers::meshing::mesh::get_mesh_last_successful_build,
        crate::router_v2::handlers::meshing::mesh::get_mesh_universe_config,
        crate::router_v2::handlers::meshing::mesh::replace_mesh_universe_config,
        crate::router_v2::handlers::meshing::mesh::get_mesh_universe_report,
        crate::router_v2::handlers::meshing::mesh::get_mesh_universe_quality,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_config,
        crate::router_v2::handlers::meshing::mesh::replace_mesh_shared_domain_config,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_report,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_cross_section,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_cross_section_image,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_cross_section_quality,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_quality,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_quality_data,
        crate::router_v2::handlers::meshing::mesh::get_mesh_realized_size_fields,
        crate::router_v2::handlers::meshing::mesh::get_mesh_quality_gates,
        crate::router_v2::handlers::meshing::mesh::get_mesh_periodic_pairs,
        crate::router_v2::handlers::meshing::mesh::get_mesh_periodic_pairs_binary,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_manifest,
        crate::router_v2::handlers::meshing::mesh::get_mesh_shared_domain_topology,
        crate::router_v2::handlers::meshing::mesh::get_mesh_object_config,
        crate::router_v2::handlers::meshing::mesh::replace_mesh_object_config,
        crate::router_v2::handlers::meshing::mesh::get_mesh_object_report,
        crate::router_v2::handlers::meshing::mesh::get_mesh_object_quality,
        crate::router_v2::handlers::meshing::mesh::get_mesh_region_quality,
        crate::router_v2::handlers::meshing::mesh::get_mesh_object_size_field,
        crate::router_v2::handlers::meshing::mesh::get_mesh_object_topology,
        crate::router_v2::handlers::meshing::mesh::get_mesh_part_topology,
        crate::router_v2::handlers::meshing::mesh::get_mesh_histogram_bin_elements,
        crate::router_v2::handlers::meshing::mesh::get_mesh_interface_config,
        crate::router_v2::handlers::meshing::mesh::replace_mesh_interface_config,
        crate::router_v2::handlers::meshing::mesh::get_mesh_interface_report,
        crate::router_v2::handlers::meshing::mesh::get_mesh_interface_quality,
        crate::router_v2::handlers::model::authoring::get_authoring_scene,
        crate::router_v2::handlers::model::authoring::replace_authoring_scene,
        crate::router_v2::handlers::model::authoring::patch_authoring_scene,
        crate::router_v2::handlers::model::authoring::get_current_transports,
        crate::router_v2::handlers::model::authoring::get_current_transport,
        crate::router_v2::handlers::model::authoring::create_current_transport,
        crate::router_v2::handlers::model::authoring::patch_current_transport,
        crate::router_v2::handlers::model::authoring::delete_current_transport,
        crate::router_v2::handlers::model::authoring::get_spin_torques,
        crate::router_v2::handlers::model::authoring::get_spin_torque,
        crate::router_v2::handlers::model::authoring::create_spin_torque,
        crate::router_v2::handlers::model::authoring::patch_spin_torque,
        crate::router_v2::handlers::model::authoring::delete_spin_torque,
        crate::router_v2::handlers::model::authoring::get_oersted_fields,
        crate::router_v2::handlers::model::authoring::get_oersted_field,
        crate::router_v2::handlers::model::authoring::create_oersted_field,
        crate::router_v2::handlers::model::authoring::patch_oersted_field,
        crate::router_v2::handlers::model::authoring::delete_oersted_field,
        crate::router_v2::handlers::model::authoring::get_authoring_geometry_capabilities,
        crate::router_v2::handlers::model::authoring::get_authoring_geometry_validation,
        crate::router_v2::handlers::model::authoring::create_authoring_geometry_realization,
        crate::router_v2::handlers::model::authoring::get_current_authoring_geometry_realization,
        crate::router_v2::handlers::model::authoring::get_authoring_geometry_diagnostics,
        crate::router_v2::handlers::model::authoring::get_authoring_geometry_diagnostic,
        crate::router_v2::handlers::model::authoring::create_authoring_object,
        crate::router_v2::handlers::model::authoring::patch_authoring_object,
        crate::router_v2::handlers::model::authoring::delete_authoring_object,
        crate::router_v2::handlers::model::authoring::create_authoring_object_region,
        crate::router_v2::handlers::model::authoring::patch_authoring_object_region,
        crate::router_v2::handlers::model::authoring::delete_authoring_object_region,
        crate::router_v2::handlers::model::authoring::duplicate_authoring_object_region,
        crate::router_v2::handlers::model::authoring::reorder_authoring_object_regions,
        crate::router_v2::handlers::model::authoring::patch_authoring_object_geometry,
        crate::router_v2::handlers::model::authoring::get_authoring_regions,
        crate::router_v2::handlers::model::authoring::get_authoring_realized_regions,
        crate::router_v2::handlers::model::authoring::get_authoring_region_diagnostics,
        crate::router_v2::handlers::model::authoring::get_authoring_material_fields,
        crate::router_v2::handlers::model::authoring::get_authoring_couplings,
        crate::router_v2::handlers::model::authoring::create_authoring_coupling,
        crate::router_v2::handlers::model::authoring::patch_authoring_coupling,
        crate::router_v2::handlers::model::authoring::delete_authoring_coupling,
        crate::router_v2::handlers::model::authoring::patch_authoring_region,
        crate::router_v2::handlers::model::authoring::commit_authoring_transaction,
        crate::router_v2::handlers::model::authoring::get_authoring_study_runtime,
        crate::router_v2::handlers::model::authoring::patch_authoring_study_runtime,
        crate::router_v2::handlers::model::authoring::get_authoring_universe,
        crate::router_v2::handlers::model::authoring::patch_authoring_universe,
        crate::router_v2::handlers::model::authoring::fit_authoring_universe,
        crate::router_v2::handlers::model::authoring::get_authoring_material,
        crate::router_v2::handlers::model::authoring::patch_authoring_material,
        crate::router_v2::handlers::model::authoring::get_authoring_magnetization_asset,
        crate::router_v2::handlers::model::authoring::patch_authoring_magnetization_asset,
        crate::router_v2::handlers::model::authoring::get_authoring_object_interaction,
        crate::router_v2::handlers::model::authoring::patch_authoring_object_interaction,
        crate::router_v2::handlers::model::authoring::get_authoring_script_source,
        crate::router_v2::handlers::model::authoring::sync_authoring_script,
        crate::router_v2::handlers::simulation::commands::submit_command,
        crate::router_v2::handlers::simulation::runtime::get_command_status,
        crate::router_v2::handlers::simulation::runtime::get_command_detail,
        crate::router_v2::handlers::persistence::assets::import_asset,
        crate::router_v2::handlers::simulation::runtime::get_current_run,
        crate::router_v2::handlers::simulation::runtime::get_run_by_id,
        crate::router_v2::handlers::simulation::runtime::get_stage_execution,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_plan,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_protocol,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_stage_saturation,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_orientation,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_settle_pipeline,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_execution_tree,
        crate::router_v2::handlers::simulation::runtime::get_hysteresis_progress,
        crate::router_v2::handlers::simulation::runtime::get_solver_status,
        crate::router_v2::handlers::simulation::runtime::get_solver_energies_current,
        crate::router_v2::handlers::simulation::runtime::get_solver_energies_history,
        crate::router_v2::handlers::simulation::runtime::get_object_metrics,
        crate::router_v2::handlers::data::artifacts::list_artifacts,
        crate::router_v2::handlers::data::artifacts::get_artifact,
        crate::router_v2::handlers::analysis::eigen::get_spectrum,
        crate::router_v2::handlers::analysis::eigen::get_spectrum_v2,
        crate::router_v2::handlers::analysis::eigen::get_mode,
        crate::router_v2::handlers::analysis::eigen::get_mode_v2,
        crate::router_v2::handlers::analysis::eigen::get_dispersion,
        crate::router_v2::handlers::analysis::eigen::get_dispersion_csv,
        crate::router_v2::handlers::analysis::eigen::get_branches,
        crate::router_v2::handlers::analysis::eigen::get_branches_v2,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_manifest_v1,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_eigen_spectrum_v2,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_eigen_branches_v2,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_eigen_dispersion,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_eigen_diagnostics_v2,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_eigen_mode_field_meta,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_response_magnetic_sweep,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_response_progress_v1,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_response_cancel_requested_v1,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_response_solver_diagnostics_v1,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_response_frequency_point,
        crate::router_v2::handlers::analysis::frequency_domain::get_frequency_domain_response_field_meta,
        crate::router_v2::handlers::analysis::response::get_magnetic_response_sweep_v1,
        crate::router_v2::handlers::analysis::extensions::get_object_topological_charge,
        crate::router_v2::handlers::analysis::hysteresis::get_points,
        crate::router_v2::handlers::analysis::hysteresis::get_metrics,
        crate::router_v2::handlers::analysis::hysteresis::get_saturation,
        crate::router_v2::handlers::analysis::hysteresis::get_adaptive_refinement,
        crate::router_v2::handlers::analysis::hysteresis::get_branches,
        crate::router_v2::handlers::analysis::hysteresis::get_bookmarks,
        crate::router_v2::handlers::analysis::hysteresis::post_bookmark,
        crate::router_v2::handlers::analysis::hysteresis::get_angular_family,
        crate::router_v2::handlers::analysis::hysteresis::get_angular_family_variant_points,
        crate::router_v2::handlers::analysis::hysteresis::get_minor_loops,
        crate::router_v2::handlers::analysis::hysteresis::get_reversal_fields,
        crate::router_v2::handlers::analysis::hysteresis::get_point_by_id,
        crate::router_v2::handlers::analysis::hysteresis::get_stage_settle_trace,
        crate::router_v2::handlers::analysis::hysteresis::get_settle_trace,
        crate::router_v2::handlers::platform::system::get_engine_log,
        crate::router_v2::handlers::platform::system::get_cpu_telemetry,
        crate::router_v2::handlers::platform::system::get_gpu_telemetry,
        crate::router_v2::handlers::platform::system::get_solver_profile,
        crate::router_v2::handlers::persistence::session::export_session,
        crate::router_v2::handlers::persistence::session::inspect_session,
        crate::router_v2::handlers::persistence::session::commit_session,
        crate::router_v2::handlers::persistence::session::list_checkpoints,
        crate::router_v2::handlers::persistence::session::get_checkpoint,
        crate::router_v2::handlers::persistence::session::create_checkpoint,
        crate::router_v2::handlers::persistence::session::restore_checkpoint,
        crate::router_v2::handlers::persistence::session::export_field_state,
        crate::router_v2::handlers::persistence::session::inspect_field_state,
        crate::router_v2::handlers::persistence::session::import_field_state,
        crate::router_v2::handlers::persistence::session::list_recovery,
        crate::router_v2::handlers::persistence::session::clear_recovery,
        crate::router_v2::handlers::platform::system::get_capabilities,
        crate::router_v2::handlers::platform::system::get_health,
    ),
    components(schemas(
        crate::schemas::status::LiveStatus,
        crate::schemas::status::SessionSummary,
        crate::schemas::status::RunSummary,
        crate::schemas::status::SolverSummary,
        crate::schemas::status::DisplaySelection,
        crate::schemas::status::DomainSummary,
        crate::schemas::status::ResourceRevisionMap,
        crate::schemas::status::CapabilityMap,
        crate::schemas::status::EnergySummary,
        crate::schemas::status::MetricsSummary,
        crate::schemas::domain::DomainMeta,
        crate::schemas::domain::Bounds3,
        crate::schemas::domain::Bounds2,
        crate::schemas::domain::DomainCounts,
        crate::schemas::domain::StructuredGridDescriptor,
        crate::schemas::domain::FemCpuRelaxationQualificationMetadata,
        crate::schemas::domain::FemCpuRelaxationDemagPolicyMetadata,
        crate::schemas::domain::FemCpuRelaxationDemagTimingsNs,
        crate::schemas::domain::FemCpuRelaxationEnergyTerms,
        crate::schemas::domain::DomainSliceMeshOverlay,
        crate::schemas::domain::DomainSliceMeshOverlaySegment,
        crate::schemas::quantities::QuantityCatalogResponse,
        crate::schemas::quantities::QuantityCatalogEntry,
        crate::schemas::fields::FieldCatalog,
        crate::schemas::fields::FieldDescriptor,
        crate::schemas::fields::FieldMeta,
        crate::schemas::fields::FieldStats,
        crate::schemas::fields::FieldVectorQuery,
        crate::schemas::fields::FieldSliceMeta,
        crate::schemas::fields::FieldMatrixResponse,
        crate::schemas::fields::FieldProjectionMeta,
        crate::schemas::fields::FieldProjectionMaskDescriptor,
        crate::schemas::fields::FieldSliceGrid,
        crate::schemas::fields::FieldSliceBounds,
        crate::schemas::fields::FieldSliceBinaryDescriptor,
        crate::schemas::logs::EngineLogResource,
        crate::schemas::scalars::ScalarWindow,
        crate::schemas::tables::TableColumnMeta,
        crate::schemas::tables::TableListResource,
        crate::schemas::tables::TableResource,
        crate::schemas::tables::TableRowsResource,
        crate::schemas::tables::TableRowsBinaryDescriptor,
        crate::schemas::tables::TableDecimationMeta,
        crate::schemas::display::DisplayPatch,
        crate::schemas::visualization_state::VisualizationStateResource,
        crate::schemas::visualization_state::VisualizationStatePatch,
        crate::schemas::visualization_state::VisualizationClientAckStatus,
        crate::schemas::visualization_state::VisualizationClientAckRequest,
        crate::schemas::visualization_state::VisualizationClientAckEntry,
        crate::schemas::visualization_state::VisualizationClientAckResource,
        crate::schemas::visualization_state::QuantityVisualizationState,
        crate::schemas::visualization_state::QuantityVisualizationPatch,
        crate::schemas::visualization_state::VisualizationLayerState,
        crate::schemas::visualization_state::VisualizationLayerPatch,
        crate::schemas::visualization_state::BasicLayerState,
        crate::schemas::visualization_state::BasicLayerPatch,
        crate::schemas::visualization_state::VectorLayerState,
        crate::schemas::visualization_state::VectorLayerPatch,
        crate::schemas::visualization_state::VectorLayerDomain,
        crate::schemas::visualization_state::AirboxLayerState,
        crate::schemas::visualization_state::AirboxLayerPatch,
        crate::schemas::visualization_state::DomainVisualizationState,
        crate::schemas::visualization_state::DomainVisualizationPatch,
        crate::schemas::visualization_state::VisualizationScopeKind,
        crate::schemas::visualization_state::SamplingVisualizationState,
        crate::schemas::visualization_state::SamplingVisualizationPatch,
        crate::schemas::visualization_state::SamplingProfile,
        crate::schemas::visualization_state::FdmVisualizationState,
        crate::schemas::visualization_state::FdmVisualizationPatch,
        crate::schemas::visualization_state::FemVisualizationState,
        crate::schemas::visualization_state::FemVisualizationPatch,
        crate::schemas::visualization_state::FemTopologyMode,
        crate::schemas::visualization_state::SliceVisualizationState,
        crate::schemas::visualization_state::SliceVisualizationPatch,
        crate::schemas::visualization_state::SliceVisualizationMode,
        crate::schemas::visualization_state::SliceRenderMode,
        crate::schemas::visualization_state::SliceAirboxRenderMode,
        crate::schemas::visualization_state::TrimVisualizationState,
        crate::schemas::visualization_state::TrimVisualizationPatch,
        crate::schemas::visualization_state::TrimAxisVisualizationAxes,
        crate::schemas::visualization_state::TrimAxisVisualizationAxesPatch,
        crate::schemas::visualization_state::TrimAxisVisualizationState,
        crate::schemas::visualization_state::TrimAxisVisualizationPatch,
        crate::schemas::visualization_state::VisualizationCameraState,
        crate::schemas::visualization_state::VisualizationCameraPatch,
        crate::schemas::visualization_state::VisualizationCameraProjection,
        crate::schemas::visualization_state::ClipVisualizationState,
        crate::schemas::visualization_state::ClipVisualizationPatch,
        crate::schemas::visualization_state::ClipAxis,
        crate::schemas::visualization_state::VectorStyleVisualizationState,
        crate::schemas::visualization_state::VectorStyleVisualizationPatch,
        crate::schemas::visualization_state::VectorColorMode,
        crate::schemas::visualization_state::FerromagnetVisibilityMode,
        crate::schemas::visualization_state::VisualizationOverrideState,
        crate::schemas::visualization_state::VisualizationDiagnostics,
        crate::schemas::workspace::WorkspaceSelectionResource,
        crate::schemas::workspace::WorkspaceSelectionReplaceRequest,
        crate::schemas::workspace::WorkspaceActiveNodeResource,
        crate::schemas::workspace::WorkspaceActiveNodeReplaceRequest,
        crate::schemas::workspace::WorkspaceRibbonResource,
        crate::schemas::workspace::WorkspaceRibbonReplaceRequest,
        crate::schemas::workspace::WorkspaceStageLayout,
        crate::schemas::workspace::WorkspaceLayoutResource,
        crate::schemas::workspace::WorkspaceLayoutReplaceRequest,
        crate::schemas::mesh::MeshSummaryResource,
        crate::schemas::mesh::MeshCapabilitiesResource,
        crate::schemas::mesh::MeshSemanticsResource,
        crate::schemas::mesh::MeshUniverseConfigResource,
        crate::schemas::mesh::MeshUniverseConfigReplaceRequest,
        crate::schemas::mesh::MeshUniverseReportResource,
        crate::schemas::mesh::MeshUniverseQualityResource,
        crate::schemas::mesh::MeshSharedDomainConfigResource,
        crate::schemas::mesh::MeshSharedDomainConfigReplaceRequest,
        crate::schemas::mesh::MeshSharedDomainReportResource,
        crate::schemas::mesh::MeshSharedDomainQualityResource,
        crate::fem_cross_section::CrossSectionQualityMetric,
        crate::fem_cross_section_image::CrossSectionImageColorScale,
        crate::schemas::mesh::MeshRealizedSizeFieldsResource,
        crate::schemas::mesh::MeshQualityGatesResource,
        crate::schemas::mesh::MeshObjectSegmentResource,
        crate::schemas::mesh::MeshPartResource,
        crate::schemas::mesh::MeshRegionMembershipListResource,
        crate::schemas::mesh::MeshRegionMembershipResource,
        crate::schemas::mesh::FdmRegionLegendEntryResource,
        crate::schemas::mesh::FdmRegionMembershipResource,
        crate::schemas::mesh::MeshSharedDomainManifestResource,
        crate::schemas::mesh::MeshObjectConfigResource,
        crate::schemas::mesh::MeshObjectConfigReplaceRequest,
        crate::schemas::mesh::MeshObjectReportResource,
        crate::schemas::mesh::MeshObjectQualityResource,
        crate::schemas::mesh::MeshRegionQualityResource,
        crate::schemas::mesh::MeshObjectSizeFieldResource,
        crate::schemas::mesh::MeshHistogramBinElementsResource,
        crate::schemas::mesh::MeshInterfaceConfigResource,
        crate::schemas::mesh::MeshInterfaceConfigReplaceRequest,
        crate::schemas::mesh::MeshInterfaceReportResource,
        crate::schemas::mesh::MeshInterfaceQualityResource,
        crate::schemas::mesh::MeshActiveBuildResource,
        crate::schemas::mesh::MeshBuildPolicyDiffResource,
        crate::schemas::mesh::MeshBuildProvenanceResource,
        crate::schemas::mesh::MeshBuildPublishedResourcesResource,
        crate::schemas::mesh::MeshBuildHistoryResource,
        crate::schemas::mesh::MeshLastSuccessfulBuildResource,
        crate::schemas::mesh::MeshBuildCommandRequest,
        crate::schemas::commands::StructuredCommandRequest,
        crate::schemas::commands::CommandResponse,
        crate::schemas::relaxation::RelaxationAlgorithm,
        crate::schemas::relaxation::StageStopReason,
        crate::schemas::relaxation::StageMetricKind,
        crate::schemas::relaxation::StageMetricUnit,
        crate::schemas::authoring::SceneResource,
        crate::schemas::authoring::SceneMetadataResource,
        crate::schemas::authoring::SceneObjectResource,
        crate::schemas::authoring::SceneMaterialResource,
        crate::schemas::authoring::ScenePatchRequest,
        crate::schemas::authoring::CurrentTransportListResource,
        crate::schemas::authoring::SpinTorqueListResource,
        crate::schemas::authoring::OerstedFieldListResource,
        crate::schemas::authoring::CurrentTransportMutationRequest,
        crate::schemas::authoring::SpinTorqueMutationRequest,
        crate::schemas::authoring::OerstedFieldMutationRequest,
        crate::schemas::authoring::SpinAuthoringDeleteRequest,
        crate::schemas::authoring::CurrentTransportCommitResource,
        crate::schemas::authoring::SpinTorqueCommitResource,
        crate::schemas::authoring::OerstedFieldCommitResource,
        fullmag_authoring::SceneRegionRef,
        fullmag_authoring::CurrentTransportKind,
        fullmag_authoring::CurrentTransportModel,
        fullmag_authoring::SceneCurrentTransport,
        fullmag_authoring::SlonczewskiFormulaVersion,
        fullmag_authoring::SlonczewskiRealization,
        fullmag_authoring::SlonczewskiRealizationKind,
        fullmag_authoring::SlonczewskiRealizationVersion,
        fullmag_authoring::PrescribedSotSchemaVersion,
        fullmag_authoring::PrescribedSotFormulaVersion,
        fullmag_authoring::SceneTimeEnvelope,
        fullmag_authoring::SceneTimeEnvelopePoint,
        fullmag_authoring::SceneEnvelopeInterpolation,
        fullmag_authoring::SceneEnvelopeExtrapolation,
        fullmag_authoring::ScenePrescribedSotDrive,
        fullmag_authoring::SceneCompatibilityOrigin,
        fullmag_authoring::SceneSpinTorque,
        fullmag_authoring::SceneOerstedTimeDependence,
        fullmag_authoring::OerstedFieldModel,
        fullmag_authoring::SceneOerstedField,
        crate::schemas::authoring::AuthoringTransactionRequest,
        crate::schemas::authoring::AuthoringTransactionResponse,
        crate::schemas::authoring::StudyRuntimeResource,
        crate::schemas::authoring::StudyRuntimePatchRequest,
        crate::schemas::authoring::NullableU32PatchValue,
        crate::schemas::authoring::NullableF64PatchValue,
        crate::schemas::authoring::NullableStringPatchValue,
        crate::schemas::authoring::MaterialPropertiesResource,
        crate::schemas::authoring::MaterialResource,
        crate::schemas::authoring::MagnetizationAssetResource,
        crate::schemas::authoring::MagnetizationAssetPatchRequest,
        crate::schemas::authoring::MaterialPropertiesPatchRequest,
        crate::schemas::authoring::MaterialPatchRequest,
        crate::schemas::authoring::ObjectInteractionResource,
        crate::schemas::authoring::ObjectInteractionPatchRequest,
        crate::schemas::authoring::ObjectGeometryPatchRequest,
        crate::schemas::authoring::ObjectCreateRequest,
        crate::schemas::authoring::ObjectPatchRequest,
        crate::schemas::authoring::ObjectRegionCreateRequest,
        crate::schemas::authoring::ObjectRegionPatchRequest,
        crate::schemas::authoring::SceneObjectRegionPatch,
        crate::schemas::authoring::SceneCouplingPatch,
        crate::schemas::authoring::CouplingCreateRequest,
        crate::schemas::authoring::CouplingPatchRequest,
        crate::schemas::authoring::CouplingDeleteRequest,
        crate::schemas::authoring::ObjectRegionDuplicateRequest,
        crate::schemas::authoring::ObjectRegionReorderRequest,
        crate::schemas::authoring::GeometryRealizationRequest,
        fullmag_authoring::GeometryBackendTarget,
        fullmag_authoring::GeometrySupportStatus,
        fullmag_authoring::GeometryDiagnosticSeverity,
        fullmag_authoring::GeometryDiagnostic,
        fullmag_authoring::PrimitiveGeometryCapability,
        fullmag_authoring::BooleanGeometryCapability,
        fullmag_authoring::GeometryCapabilitiesResource,
        fullmag_authoring::GeometryValidationResource,
        fullmag_authoring::GeometryDiagnosticsResource,
        fullmag_authoring::GeometryRealizationSnapshot,
        fullmag_authoring::RealizedGeometryBody,
        fullmag_authoring::GeometryRegionCandidate,
        fullmag_authoring::GeometryProvenanceEntry,
        crate::schemas::authoring::RegionResource,
        crate::schemas::authoring::RegionListResource,
        crate::schemas::authoring::RegionDiagnosticResource,
        crate::schemas::authoring::RegionDiagnosticsResource,
        crate::schemas::authoring::RegionPatchRequest,
        crate::schemas::authoring::MaterialParameterFieldResource,
        crate::schemas::authoring::MaterialParameterFieldListResource,
        crate::schemas::authoring::MaterialParameterFieldDataSummaryResource,
        crate::schemas::authoring::MaterialParameterFieldDataListResource,
        crate::schemas::authoring::MaterialParameterFieldDataResource,
        crate::schemas::authoring::CouplingEndpointResolutionResource,
        crate::schemas::authoring::CouplingResource,
        crate::schemas::authoring::CouplingListResource,
        crate::schemas::authoring::UniverseResource,
        crate::schemas::authoring::UniversePatchRequest,
        crate::schemas::authoring::UniverseFitRequest,
        crate::schemas::runtime::CurrentRunResource,
        crate::schemas::runtime::ResolvedFallbackResource,
        crate::schemas::runtime::StageExecutionResource,
        crate::schemas::runtime::StageExecutionRecordResource,
        crate::schemas::hysteresis::HysteresisStagePlanSchema,
        crate::schemas::hysteresis::HysteresisStorageEstimateSchema,
        crate::schemas::hysteresis::HysteresisProtocolSchema,
        crate::schemas::hysteresis::HysteresisStageSaturationSchema,
        crate::schemas::hysteresis::HysteresisOrientationSchema,
        crate::schemas::hysteresis::HysteresisSettlePipelineSchema,
        crate::schemas::hysteresis::HysteresisBookmarkPointRequest,
        crate::schemas::hysteresis::HysteresisBookmarkSchema,
        crate::schemas::hysteresis::HysteresisBookmarksResource,
        crate::schemas::hysteresis::HysteresisExecutionTreeResource,
        crate::schemas::hysteresis::HysteresisExecutionTreeNode,
        crate::schemas::hysteresis::HysteresisProgressSchema,
        crate::schemas::runtime::SolverStatusResource,
        crate::schemas::runtime::SolverEnergyCurrentResource,
        crate::schemas::runtime::SolverEnergyHistoryResource,
        crate::schemas::runtime::SolverEnergyRow,
        crate::schemas::runtime::ObjectMetricsResource,
        crate::schemas::runtime::ObjectMagnetizationAverage,
        crate::schemas::runtime::ObjectEnergySummary,
        crate::schemas::runtime::CommandQueueStatusResource,
        crate::schemas::runtime::CommandStatusResource,
        crate::schemas::runtime::CommandDetailResource,
        crate::schemas::common::ApiErrorResponse,
        crate::schemas::common::HealthResponse,
        crate::schemas::common::HostEngineEntry,
        crate::schemas::common::RuntimeCapabilityMatrix,
        crate::types::ArtifactEntry,
        crate::types::RegionOwnedArtifactProvenance,
        crate::field_slice::SlicePlane,
        crate::types::ImportSessionAssetRequest,
        crate::types::SessionAssetImportResponse,
        crate::types::ImportedAssetSummary,
        crate::types::BoundsSummary,
        crate::types::ScriptSyncRequest,
        crate::types::ScriptSyncResponse,
        crate::types::ScriptSourceResponse,
        crate::types::EngineLogEntry,
        crate::types::CpuTelemetryResponse,
        crate::types::GpuTelemetryDevice,
        crate::types::GpuTelemetryResponse,
        crate::session_persistence::SessionExportRequest,
        crate::session_persistence::SessionExportResponse,
        crate::session_persistence::SessionImportInspectRequest,
        crate::session_persistence::SessionImportInspectResponse,
        crate::session_persistence::SessionImportCommitRequest,
        crate::session_persistence::SessionImportCommitResponse,
        crate::session_persistence::CheckpointListResponse,
        crate::session_persistence::CheckpointEntry,
        crate::session_persistence::CheckpointCreateRequest,
        crate::session_persistence::CheckpointCreateResponse,
        crate::session_persistence::CheckpointRestoreRequest,
        crate::session_persistence::CheckpointRestoreResponse,
        crate::session_persistence::FieldStateTargetRef,
        crate::session_persistence::FieldStateExportRequest,
        crate::session_persistence::FieldStateExportResponse,
        crate::session_persistence::FieldStateInspectRequest,
        crate::session_persistence::FieldStateInspectResponse,
        crate::session_persistence::FieldStateImportRequest,
        crate::session_persistence::FieldStateImportResponse,
        crate::session_persistence::RecoveryListResponse,
        crate::session_persistence::RecoveryEntry,
        crate::session_persistence::RecoveryClearResponse,
        fullmag_session::SaveProfile,
        fullmag_session::RestoreClass,
        fullmag_session::CompressionProfile,
        fullmag_session::SessionInspection,
        fullmag_session::CheckpointSummary,
        crate::schemas::hysteresis::HysteresisPointSchema,
        crate::schemas::hysteresis::HysteresisPointsResource,
        crate::schemas::hysteresis::HysteresisBranchSchema,
        crate::schemas::hysteresis::HysteresisBranchesResource,
        crate::schemas::hysteresis::HysteresisAngularFamilyResource,
        crate::schemas::hysteresis::HysteresisAngularFamilySeriesSchema,
        crate::schemas::hysteresis::HysteresisMinorLoopSchema,
        crate::schemas::hysteresis::HysteresisMinorLoopsResource,
        crate::schemas::hysteresis::HysteresisSettleTraceEntrySchema,
        crate::schemas::hysteresis::HysteresisSettleTraceResource,
        crate::schemas::hysteresis::HysteresisMetricsSchema,
        crate::schemas::hysteresis::HysteresisMetricsResource,
        crate::schemas::hysteresis::HysteresisMetricStatusSchema,
        crate::schemas::hysteresis::HysteresisLoopClosureSummarySchema,
        crate::schemas::hysteresis::HysteresisSwitchingFieldCandidateSchema,
        crate::schemas::hysteresis::HysteresisConvergenceQualitySummarySchema,
        crate::schemas::hysteresis::HysteresisSaturationProbePointSchema,
        crate::schemas::hysteresis::HysteresisSaturationResultSchema,
        crate::schemas::hysteresis::HysteresisSaturationResource,
        crate::schemas::hysteresis::HysteresisReversalFieldsResource,
        crate::schemas::hysteresis::HysteresisAdaptiveRefinementResource,
        crate::schemas::analysis_extensions::TopologicalChargePlane,
        crate::schemas::analysis_extensions::TopologicalChargeSupportMode,
        crate::schemas::analysis_extensions::TopologicalChargeProfileSamples,
        crate::schemas::analysis_extensions::TopologicalChargeMethod,
        crate::schemas::analysis_extensions::TopologicalChargeStatus,
        crate::schemas::analysis_extensions::TopologicalChargeTrust,
        crate::schemas::analysis_extensions::TopologicalChargeQueryV2,
        crate::schemas::analysis_extensions::TopologicalChargeRequestEcho,
        crate::schemas::analysis_extensions::TopologicalChargeResolvedSupport,
        crate::schemas::analysis_extensions::TopologicalChargeSupportFrame,
        crate::schemas::analysis_extensions::TopologicalChargeLayerSample,
        crate::schemas::analysis_extensions::TopologicalChargeQuality,
        crate::schemas::analysis_extensions::TopologicalChargeProvenance,
        crate::schemas::analysis_extensions::TopologicalChargeMethodDescriptor,
        crate::schemas::analysis_extensions::TopologicalChargeWarning,
        crate::schemas::analysis_extensions::TopologicalChargeResourceV2,
    )),
    tags(
        (name = "platform", description = "Server-level health, capabilities, and API documents"),
        (name = "sessions", description = "Session discovery, current session summary, status, and realtime events"),
        (name = "model", description = "Canonical simulation model, authoring scene, study, script, and transactions"),
        (name = "meshing", description = "Meshing policies, builds, solver meshes, topology, quality, and reports"),
        (name = "simulation", description = "Commands, runs, stages, solver status, and energy read-models"),
        (name = "data", description = "Quantities, fields, scalar histories, domain data, and artifacts"),
        (name = "visualization", description = "Renderer display selection and presentation state"),
        (name = "workspace", description = "Workspace shell state owned by the frontend"),
        (name = "analysis", description = "Analysis products such as eigenmodes and dispersion"),
        (name = "persistence", description = "Session checkpoints, exports, imports, assets, and recovery"),
        (name = "diagnostics", description = "Runtime diagnostics, GPU telemetry, and engine logs"),
    ),
    info(
        title = "Fullmag API v2",
        version = "2.0.0",
        description = "Professional session-scoped API for Fullmag platform, simulation control, data, visualization, and diagnostics.",
    )
)]
pub struct ApiDoc;

pub fn openapi_json() -> Value {
    let mut doc = serde_json::to_value(ApiDoc::openapi()).expect("OpenAPI v2 should serialize");
    add_platform_document_paths(&mut doc);
    add_session_collection_paths(&mut doc);
    normalize_operation_ids(&mut doc);
    doc
}

fn add_platform_document_paths(doc: &mut Value) {
    let Some(paths) = doc.get_mut("paths").and_then(Value::as_object_mut) else {
        return;
    };
    paths.insert(
        "/v2/".to_string(),
        json!({
            "get": {
                "tags": ["platform"],
                "operationId": "platform_get_v2_index",
                "responses": {"200": {"description": "V2 API discovery index"}}
            }
        }),
    );
    paths.insert(
        "/v2/platform/openapi.json".to_string(),
        json!({
            "get": {
                "tags": ["platform"],
                "operationId": "platform_get_openapi_json",
                "responses": {"200": {"description": "OpenAPI v2 document"}}
            }
        }),
    );
}

fn add_session_collection_paths(doc: &mut Value) {
    let Some(paths) = doc.get_mut("paths").and_then(Value::as_object_mut) else {
        return;
    };
    paths.insert(
        "/v2/sessions".to_string(),
        json!({
            "get": {
                "tags": ["sessions"],
                "operationId": "sessions_list_sessions",
                "responses": {"200": {"description": "Available sessions"}}
            },
            "post": {
                "tags": ["sessions"],
                "operationId": "sessions_create_session",
                "responses": {
                    "200": {"description": "Current session returned"},
                    "400": {"description": "The local runtime only exposes the current session"}
                }
            }
        }),
    );
    paths.insert(
        "/v2/sessions/current".to_string(),
        json!({
            "get": {
                "tags": ["sessions"],
                "operationId": "sessions_get_current_session",
                "responses": {"200": {"description": "Current session summary"}}
            },
            "patch": {
                "tags": ["sessions"],
                "operationId": "sessions_patch_current_session",
                "responses": {
                    "200": {"description": "Current session summary"},
                    "400": {"description": "Session mutation is not yet supported"}
                }
            }
        }),
    );
}

fn normalize_operation_ids(doc: &mut Value) {
    let Some(paths) = doc.get_mut("paths").and_then(Value::as_object_mut) else {
        return;
    };
    for (path, path_item) in paths {
        let Some(path_item) = path_item.as_object_mut() else {
            continue;
        };
        for method in ["get", "post", "put", "patch", "delete"] {
            let Some(operation) = path_item.get_mut(method).and_then(Value::as_object_mut) else {
                continue;
            };
            let tag = operation
                .get("tags")
                .and_then(Value::as_array)
                .and_then(|tags| tags.first())
                .and_then(Value::as_str)
                .unwrap_or("v2");
            operation.insert(
                "operationId".to_string(),
                Value::String(format!(
                    "{}_{}_{}",
                    sanitize_operation_token(tag),
                    method,
                    sanitize_operation_token(path.trim_start_matches("/v2/"))
                )),
            );
        }
    }
}

fn sanitize_operation_token(value: &str) -> String {
    let mut out = String::new();
    let mut previous_was_separator = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            previous_was_separator = false;
        } else if !previous_was_separator {
            out.push('_');
            previous_was_separator = true;
        }
    }
    out.trim_matches('_').to_string()
}

#[cfg(test)]
mod tests {
    use super::openapi_json;

    #[test]
    fn openapi_topological_charge_v2_is_closed_and_versioned() {
        let document = openapi_json();
        let operation = &document["paths"]
            ["/v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge"]
            ["get"];
        let parameters = operation["parameters"]
            .as_array()
            .expect("topological-charge parameters array");
        let plane = parameters
            .iter()
            .find(|parameter| parameter["name"] == "plane")
            .expect("topological-charge plane parameter");

        assert_eq!(
            plane["schema"]["$ref"],
            serde_json::json!("#/components/schemas/TopologicalChargePlane")
        );
        let plane_schema = &document["components"]["schemas"]["TopologicalChargePlane"];
        assert_eq!(
            plane_schema["enum"],
            serde_json::json!(["auto", "xy", "xz", "yz"])
        );
        assert!(
            !parameters
                .iter()
                .any(|parameter| parameter["name"] == "quantity_id"),
            "the production resource is fixed to canonical magnetization m"
        );

        let status_schema = &document["components"]["schemas"]["TopologicalChargeStatus"];
        assert_eq!(
            status_schema["enum"],
            serde_json::json!([
                "ready",
                "no_current_magnetization",
                "empty_support",
                "invalid_magnetization",
                "degenerate_support",
                "under_resolved",
                "unsupported_geometry",
                "unsupported_discretization"
            ])
        );
        assert!(
            !status_schema.to_string().contains("\"stale\""),
            "stale is a frontend resource lifecycle state, not scientific status"
        );

        let resource = &document["components"]["schemas"]["TopologicalChargeResourceV2"];
        assert!(
            resource["properties"].get("polarity").is_none(),
            "charge sign is not core polarity"
        );
        assert_eq!(
            resource["properties"]["schema_version"]["example"],
            serde_json::json!("topological_charge.v2")
        );
    }
}
