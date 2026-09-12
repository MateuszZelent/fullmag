use fullmag_engine::Vector3;
use nalgebra::DMatrix;
use num_complex::Complex64;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub(super) struct AcceptedEquilibriumCriterion {
    pub(super) criterion: String,
    pub(super) metric_kind: fullmag_ir::StageMetricKind,
    pub(super) metric_value: f64,
    pub(super) threshold: f64,
    pub(super) unit: String,
    pub(super) status: String,
    pub(super) converged: bool,
    pub(super) stop_reason: fullmag_ir::StageStopReason,
}

#[derive(Debug, Clone)]
pub(super) struct SharedDomainLinearizationState {
    pub(super) equilibrium_artifact: serde_json::Value,
    pub(super) linearization_state: serde_json::Value,
    pub(super) equilibrium_m0: Vec<Vector3>,
    pub(super) h_eff0: Vec<Vector3>,
    pub(super) h_demag0: Vec<Vector3>,
    pub(super) phi0: Vec<f64>,
    pub(super) equilibrium_id: String,
    pub(super) mesh_snapshot_id: String,
    pub(super) material_snapshot_id: String,
    pub(super) physics_snapshot_id: String,
    pub(super) boundary_snapshot_id: String,
    pub(super) producer_run_id: String,
    pub(super) equilibrium_content_sha256: String,
    pub(super) demag_model: String,
    pub(super) m0_norm_tolerance: f64,
    pub(super) acceptance_certificate: AcceptedEquilibriumCriterion,
    pub(super) acceptance_certificate_sha256: String,
    pub(super) equilibrium_artifact_digest: String,
    pub(super) linearization_state_digest: String,
    pub(super) periodic_mesh_certificate_digest: String,
    pub(super) periodic_mesh_certificate_map_binding_digest: String,
}

pub(super) struct SharedDomainModeContext<'a> {
    pub(super) reduced_tangent_mass: &'a DMatrix<f64>,
    pub(super) active_nodes: &'a [usize],
    pub(super) magnetic_classes: &'a [u32],
    pub(super) magnetic_class_count: usize,
}

#[derive(Debug, Clone)]
pub(super) struct NativeBlochFloquetDensePayload {
    pub(super) physical_complex_dof: usize,
    pub(super) stiffness: DMatrix<f64>,
    pub(super) gyrotropic_row_major: Vec<f64>,
    pub(super) tangent_mass: DMatrix<f64>,
    pub(super) physical_mass: Vec<Vec<Complex64>>,
}
