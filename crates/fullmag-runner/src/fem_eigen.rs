//! Compatibility facade for the mechanically split FEM eigen runner workflow.

#![allow(unused_imports)]

pub(crate) use crate::fem::eigen_capability::{
    insert_native_cpu_modal_window_rejection_contract, native_cpu_modal_window_rejection_reason,
    native_cpu_modal_window_rejection_scope,
};
pub(crate) use crate::fem::eigen_certificate::{
    OwnedModalCertificateV6Binding, OwnedModalCertificateV6ClassDigest,
    OwnedModalCertificateV6RegionRole, OwnedModalCertificateV6Relation,
    OwnedModalCertificateV6View,
};
pub(crate) use crate::fem::eigen_constants::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON;
pub use crate::fem::eigen_equilibrium_contract::AcceptedFemRelaxStageHandoff;
pub(crate) use crate::fem::eigen_equilibrium_contract::{
    accepted_relax_to_eigen_handoff_from_run, AcceptedFemEigenEquilibriumHandoff,
};
pub(crate) use crate::fem::eigen_execution::{
    execute_baseline_fem_eigen, execute_baseline_fem_eigen_with_progress, execute_cpu_fem_eigen,
    execute_cpu_fem_eigen_with_handoff, execute_cpu_fem_eigen_with_progress,
    execute_cpu_fem_eigen_with_progress_and_stage_handoff, execute_gpu_fem_eigen,
    execute_gpu_fem_eigen_with_handoff, execute_gpu_fem_eigen_with_progress_and_stage_handoff,
    execute_planned_fem_eigen, execute_planned_fem_eigen_with_handoff,
    execute_planned_fem_eigen_with_progress,
    execute_planned_fem_eigen_with_progress_and_stage_handoff,
    reject_unsupported_floquet_dynamic_demag,
};
pub(crate) use crate::fem::eigen_execution_resolution::{
    resolve_fem_eigen_execution_resolution, resolve_planned_fem_eigen_execution,
    validate_bias_field_sample_execution_resolutions, FemEigenExecutionLane,
    PlannedFemEigenExecution,
};
pub(crate) use crate::fem::eigen_native_result::{
    native_poisson_airbox_k0_metrics_from_result_json, NativePoissonAirboxK0MetricsInput,
};
pub(crate) use crate::fem::eigen_output::modal_tangent_transport_diagnostics;
pub(crate) use crate::fem::eigen_progress::{FemEigenProgress, FemEigenProgressCallback};
pub(crate) use crate::fem::eigen_shared_domain::native_shared_domain_magnetic_assembly_available;
