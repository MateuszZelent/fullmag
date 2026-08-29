#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
use fullmag_fem_sys as ffi;

use std::ffi::c_void;
#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
use std::ffi::{c_char, CStr, CString};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use super::availability::FrequencyDomainPhaseConvention;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeFrequencyDomainStatus {
    Ok,
    Unavailable,
    ValidationError,
    OperatorError,
    SolveError,
    ArtifactError,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeFrequencyDomainExecutionLane {
    Validation,
    ProductionCpu,
    ProductionGpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeModalExecutionTarget {
    Auto,
    ProductionCpu,
    ProductionGpu,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub(crate) struct NativeFrequencyDomainProgress {
    pub frequency_index: u64,
    pub completed_frequency_count: u64,
    pub total_frequency_count: u64,
    pub iteration_count: u64,
    pub frequency_hz: f64,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
    pub converged: bool,
}

pub(crate) type NativeFrequencyDomainProgressCallback<'a> =
    dyn Fn(NativeFrequencyDomainProgress) + 'a;
pub(crate) type NativeFrequencyDomainCancelCallback<'a> = dyn Fn() -> bool + 'a;
pub(crate) type NativeModalEigenProgressCallback<'a> = dyn Fn(&str) + 'a;
#[cfg(feature = "fem-gpu")]
pub(crate) type NativeFrequencyDomainApplyCallback =
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_: *const f64,
        out: *mut f64,
        error_message: *mut c_char,
    ) -> ffi::fullmag_fem_frequency_domain_status;
#[cfg(feature = "fem-gpu")]
pub(crate) type NativeFrequencyDomainComplexApplyCallback =
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_real: *const f64,
        in_imag: *const f64,
        out_real: *mut f64,
        out_imag: *mut f64,
        error_message: *mut c_char,
    ) -> ffi::fullmag_fem_frequency_domain_status;
#[cfg(feature = "fem-gpu")]
pub(crate) type NativeFrequencyDomainApplyWithPotentialCallback =
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_: *const f64,
        out: *mut f64,
        out_phi: *mut f64,
        out_phi_len: u64,
        error_message: *mut c_char,
    ) -> ffi::fullmag_fem_frequency_domain_status;

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseRequest<'a> {
    pub node_count: u64,
    pub tangent_dof_count: u64,
    pub alpha: f64,
    pub gamma0: f64,
    pub execution_lane: NativeFrequencyDomainExecutionLane,
    pub frequencies_hz: &'a [f64],
    pub output_directory: &'a Path,
    pub write_response_fields: bool,
    pub write_partial_artifacts: bool,
    pub operator_diagnostics_json: Option<&'a str>,
    pub interrupt_requested: Option<&'a AtomicBool>,
    pub cancel_requested: Option<&'a NativeFrequencyDomainCancelCallback<'a>>,
    pub progress_callback: Option<&'a NativeFrequencyDomainProgressCallback<'a>>,
    pub requires_periodic_airbox_dynamic_demag: bool,
    pub requires_floquet_airbox_dynamic_demag: bool,
    pub magnetic_periodic_constraint_set_count: u64,
    pub magnetostatic_periodic_constraint_set_count: u64,
    pub periodic_airbox_delta_m_tangent_dof_count: u64,
    pub periodic_airbox_delta_phi_dof_count: u64,
    pub periodic_airbox_magnetostatic_periodic_node_pairs:
        &'a [NativeDrivenFrequencyResponsePeriodicNodePair],
    pub periodic_airbox_coupled_block_problem:
        Option<NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem<'a>>,
    pub tiny_validation_problem: Option<NativeDrivenFrequencyResponseTinyValidationProblem<'a>>,
    pub mfem_operator_problem: Option<NativeDrivenFrequencyResponseMfemOperatorProblem<'a>>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem<'a> {
    pub delta_m_tangent_dof_count: u64,
    pub delta_phi_dof_count: u64,
    pub stiffness_matrix_row_major: &'a [f64],
    pub mass_matrix_row_major: &'a [f64],
    #[cfg(feature = "fem-gpu")]
    pub apply_stiffness: Option<NativeFrequencyDomainApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_mass: Option<NativeFrequencyDomainApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_complex_stiffness: Option<NativeFrequencyDomainComplexApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_complex_mass: Option<NativeFrequencyDomainComplexApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub operator_user_data: *mut c_void,
    pub drive_real: &'a [f64],
    pub drive_imag: Option<&'a [f64]>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseTinyValidationProblem<'a> {
    pub tangent_dof_count: u64,
    pub stiffness_matrix_row_major: Option<&'a [f64]>,
    pub mass_matrix_row_major: Option<&'a [f64]>,
    pub stiffness_diagonal: Option<&'a [f64]>,
    pub mass_diagonal: Option<&'a [f64]>,
    pub drive_real: &'a [f64],
    pub drive_imag: Option<&'a [f64]>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseMfemOperatorProblem<'a> {
    pub equilibrium_m: &'a [[f64; 3]],
    pub h_ext_a_per_m: &'a [f64; 3],
    pub uniaxial_anisotropy_axis: Option<&'a [f64; 3]>,
    pub uniaxial_anisotropy_field_a_per_m: f64,
    pub alpha_per_node: Option<&'a [f64]>,
    pub drive_real: &'a [f64],
    pub drive_imag: Option<&'a [f64]>,
    pub exchange_edges: &'a [NativeDrivenFrequencyResponseExchangeEdge],
    pub dmi_elements: &'a [NativeDrivenFrequencyResponseDmiElement],
    pub dmi_lumped_mass: Option<&'a [f64]>,
    pub dmi_ms_field: Option<&'a [f64]>,
    pub dmi_uniform_ms: f64,
    pub observable_ms_field: Option<&'a [f64]>,
    pub observable_uniform_ms: f64,
    pub include_zeeman: bool,
    pub static_periodic_node_pairs: &'a [NativeDrivenFrequencyResponsePeriodicNodePair],
    pub floquet_k_vector_rad_per_m: Option<[f64; 3]>,
    pub phase_convention: FrequencyDomainPhaseConvention,
    pub floquet_periodic_pairs: &'a [NativeDrivenFrequencyResponseFloquetPeriodicPair<'a>],
    #[cfg(feature = "fem-gpu")]
    pub apply_demag_tangent: Option<NativeFrequencyDomainApplyCallback>,
    #[cfg(feature = "fem-gpu")]
    pub apply_demag_tangent_with_potential: Option<NativeFrequencyDomainApplyWithPotentialCallback>,
    pub demag_tangent_user_data: *mut c_void,
    pub demag_tangent_matrix_row_major: Option<&'a [f64]>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseExchangeEdge {
    pub node_i: u64,
    pub node_j: u64,
    pub stiffness: f64,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponsePeriodicNodePair {
    pub node_a: u64,
    pub node_b: u64,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseFloquetPeriodicPair<'a> {
    pub pair_id: Option<&'a str>,
    pub node_a: u64,
    pub node_b: u64,
    pub translation_m: Option<[f64; 3]>,
    pub phase_rad: Option<f64>,
}

pub(crate) type NativeModalEigenFloquetPeriodicPair<'a> =
    NativeDrivenFrequencyResponseFloquetPeriodicPair<'a>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) enum NativeDrivenFrequencyResponseDmiKind {
    Interfacial,
    Bulk,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseDmiElement {
    pub kind: NativeDrivenFrequencyResponseDmiKind,
    pub node_indices: [u32; 4],
    pub shape: [f64; 4],
    pub grad_shape: [f64; 12],
    pub weight: f64,
    pub d: f64,
    pub normal: [f64; 3],
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenFrequencyResponseResult {
    pub status: NativeFrequencyDomainStatus,
    pub total_frequency_count: u64,
    pub completed_frequency_count: u64,
    pub written_frequency_point_artifacts: u64,
    pub error_message: String,
    pub diagnostics_json: String,
    pub result_json: String,
    pub artifact_manifest_path: String,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenRequest<'a> {
    pub mesh_asset_id: &'a str,
    pub equilibrium_source_kind: &'a str,
    pub gamma_rad_s_t: f64,
    pub mu0_t_m_a: f64,
    pub alpha: f64,
    pub include_exchange: bool,
    pub include_demag: bool,
    pub demag_realization: Option<&'a str>,
    pub damping_policy: &'a str,
    pub spin_wave_bc_kind: &'a str,
    pub k_vector_rad_m: Option<&'a [f64]>,
    pub operator_diagnostics_json: Option<&'a str>,
    pub requested_mode_count: i32,
    pub target_kind: &'a str,
    pub target_frequency_hz: f64,
    pub frequency_min_hz: f64,
    pub frequency_max_hz: f64,
    pub residual_tolerance: f64,
    pub max_outer_iterations: i32,
    pub max_linear_iterations: i32,
    pub output_directory: Option<&'a Path>,
    pub write_partial_artifacts: bool,
    pub completeness_policy: i32,
    pub eigensolver_family: i32,
    pub spectral_transform_kind: i32,
    pub execution_target: NativeModalExecutionTarget,
    pub cancel_requested: Option<&'a NativeFrequencyDomainCancelCallback<'a>>,
    pub progress_callback: Option<&'a NativeModalEigenProgressCallback<'a>>,
    pub tiny_validation_problem: Option<NativeModalEigenTinyValidationProblem<'a>>,
    pub mfem_operator_problem: Option<NativeModalEigenMfemOperatorProblem<'a>>,
    pub mfem_sparse_operator_problem: Option<NativeModalEigenSparseOperatorProblem<'a>>,
    pub poisson_airbox_block_problem: Option<NativeModalEigenPoissonAirboxBlockProblem<'a>>,
    pub shared_domain_problem: Option<NativeModalEigenSharedDomainProblem<'a>>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenSharedDomainProblem<'a> {
    pub mesh: &'a fullmag_ir::MeshIR,
    pub equilibrium_m0_xyz: Vec<f64>,
    pub linearization_m0_xyz: Vec<f64>,
    pub linearization_h_eff0_xyz: Vec<f64>,
    pub linearization_h_demag0_xyz: Vec<f64>,
    pub linearization_phi0: Vec<f64>,
    pub equilibrium_id: String,
    pub mesh_snapshot_id: String,
    pub material_snapshot_id: String,
    pub physics_snapshot_id: String,
    pub boundary_snapshot_id: String,
    pub producer_run_id: String,
    pub equilibrium_content_sha256: String,
    pub demag_model: String,
    pub m0_norm_tolerance: f64,
    pub acceptance_criterion: String,
    pub acceptance_metric_kind: String,
    pub acceptance_unit: String,
    pub acceptance_metric_value: f64,
    pub acceptance_threshold: f64,
    pub acceptance_certificate_sha256: String,
    pub saturation_magnetisation_a_per_m: Vec<f64>,
    pub uniform_saturation_magnetisation_a_per_m: f64,
    pub gamma0_m_per_a_s: f64,
    pub tangent_frame_xyz: Vec<f64>,
    pub external_field_h_ext0_xyz: Vec<f64>,
    pub alpha_per_node: Vec<f64>,
    pub term_presence_mask: u32,
    pub exchange_term_digest: Option<String>,
    pub field_term_digest: Option<String>,
    pub demag_term_digest: Option<String>,
    pub operator_input_digest: String,
    pub demag_provider_signature: Option<String>,
    pub exchange_stiffness_j_per_m: Option<f64>,
    pub scalar_reduced_node: Vec<u32>,
    pub scalar_reduced_node_count: u64,
    pub magnetic_reduced_node: Vec<u32>,
    pub magnetic_reduced_node_count: u64,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub boundary_kind: String,
    pub robin_beta: f64,
    pub boundary_marker: u32,
    pub equilibrium_digest: String,
    pub mesh_certificate_digest: String,
    pub mesh_certificate_schema: String,
    pub mesh_certificate_map_binding_digest: String,
    pub linearization_state_digest: String,
    pub mesh_generation_identity: String,
    pub canonical_preimage: String,
    pub canonical_preimage_sha256: String,
    pub magnetic_class_digest_sha256: String,
    pub scalar_class_digest_sha256: String,
    pub certificate_binding_status: u32,
    pub certificate_binding_reason: String,
    pub certificate_binding_v6: crate::fem_eigen::OwnedModalCertificateV6Binding,
    pub(crate) _marker: std::marker::PhantomData<&'a fullmag_ir::MeshIR>,
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
struct NativeModalCertificateV6FfiView {
    view_kind: u32,
    part_role: u32,
    part_identity: CString,
    topology_fingerprint: CString,
    region_ids: Vec<u32>,
    boundary_axis_masks: Vec<u32>,
    region_roles: Vec<ffi::FullmagFemModalCertificateV6RegionRole>,
    generator_relations: Vec<ffi::FullmagFemModalCertificateV6Relation>,
    closure_relations: Vec<ffi::FullmagFemModalCertificateV6Relation>,
    expected_class_ids: Vec<u64>,
    expected_class_digest_strings: Vec<CString>,
    expected_class_digests: Vec<ffi::FullmagFemModalCertificateV6ClassDigest>,
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl NativeModalCertificateV6FfiView {
    fn new(view: &crate::fem_eigen::OwnedModalCertificateV6View) -> Result<Self, String> {
        let part_identity = CString::new(view.part_identity.as_bytes())
            .map_err(|_| "native FEM modal certificate part identity contains NUL".to_string())?;
        let topology_fingerprint =
            CString::new(view.topology_fingerprint.as_bytes()).map_err(|_| {
                "native FEM modal certificate topology fingerprint contains NUL".to_string()
            })?;
        let expected_class_digest_strings = view
            .expected_class_digests
            .iter()
            .map(|digest| CString::new(digest.sha256.as_bytes()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "native FEM modal certificate class digest contains NUL".to_string())?;
        let expected_class_digests = view
            .expected_class_digests
            .iter()
            .zip(&expected_class_digest_strings)
            .map(
                |(digest, text)| ffi::FullmagFemModalCertificateV6ClassDigest {
                    canonical_class_id: digest.canonical_class_id,
                    member_count: digest.member_count,
                    sha256: text.as_ptr(),
                },
            )
            .collect();
        let convert_relation = |relation: &crate::fem_eigen::OwnedModalCertificateV6Relation| {
            ffi::FullmagFemModalCertificateV6Relation {
                source_node: relation.source_node,
                destination_node: relation.destination_node,
                axis_mask: relation.axis_mask,
                kind: relation.kind,
            }
        };
        Ok(Self {
            view_kind: view.view_kind,
            part_role: view.part_role,
            part_identity,
            topology_fingerprint,
            region_ids: view.region_ids.clone(),
            boundary_axis_masks: view.boundary_axis_masks.clone(),
            region_roles: view
                .region_roles
                .iter()
                .map(|role| ffi::FullmagFemModalCertificateV6RegionRole {
                    region_id: role.region_id,
                    part_role: role.part_role,
                })
                .collect(),
            generator_relations: view
                .generator_relations
                .iter()
                .map(convert_relation)
                .collect(),
            closure_relations: view
                .closure_relations
                .iter()
                .map(convert_relation)
                .collect(),
            expected_class_ids: view.expected_class_ids.clone(),
            expected_class_digest_strings,
            expected_class_digests,
        })
    }

    fn as_ffi(&self) -> ffi::FullmagFemModalCertificateV6View {
        debug_assert_eq!(
            self.expected_class_digest_strings.len(),
            self.expected_class_digests.len()
        );
        ffi::FullmagFemModalCertificateV6View {
            view_kind: self.view_kind,
            part_role: self.part_role,
            part_identity: self.part_identity.as_ptr(),
            topology_fingerprint: self.topology_fingerprint.as_ptr(),
            node_count: self.region_ids.len() as u64,
            region_ids: self.region_ids.as_ptr(),
            boundary_axis_masks: self.boundary_axis_masks.as_ptr(),
            region_roles: self.region_roles.as_ptr(),
            region_role_count: self.region_roles.len() as u64,
            generator_relations: self.generator_relations.as_ptr(),
            generator_relation_count: self.generator_relations.len() as u64,
            closure_relations: self.closure_relations.as_ptr(),
            closure_relation_count: self.closure_relations.len() as u64,
            require_complete_closure: 1,
            expected_class_ids: self.expected_class_ids.as_ptr(),
            expected_class_id_count: self.expected_class_ids.len() as u64,
            expected_class_digests: self.expected_class_digests.as_ptr(),
            expected_class_digest_count: self.expected_class_digests.len() as u64,
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
struct NativeModalCertificateV6FfiBinding {
    schema_version: CString,
    mesh_magnetic: NativeModalCertificateV6FfiView,
    payload_magnetic: NativeModalCertificateV6FfiView,
    mesh_scalar: NativeModalCertificateV6FfiView,
    payload_scalar: NativeModalCertificateV6FfiView,
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl NativeModalCertificateV6FfiBinding {
    fn new(binding: &crate::fem_eigen::OwnedModalCertificateV6Binding) -> Result<Self, String> {
        Ok(Self {
            schema_version: CString::new("periodic_mesh_certificate.v6").unwrap(),
            mesh_magnetic: NativeModalCertificateV6FfiView::new(&binding.mesh_magnetic)?,
            payload_magnetic: NativeModalCertificateV6FfiView::new(&binding.payload_magnetic)?,
            mesh_scalar: NativeModalCertificateV6FfiView::new(&binding.mesh_scalar)?,
            payload_scalar: NativeModalCertificateV6FfiView::new(&binding.payload_scalar)?,
        })
    }

    fn as_request(&self) -> ffi::FullmagFemModalCertificateV6BindingRequest {
        ffi::FullmagFemModalCertificateV6BindingRequest {
            schema_version: self.schema_version.as_ptr(),
            mesh_magnetic: self.mesh_magnetic.as_ffi(),
            payload_magnetic: self.payload_magnetic.as_ffi(),
            mesh_scalar: self.mesh_scalar.as_ffi(),
            payload_scalar: self.payload_scalar.as_ffi(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct NativeModalSharedDomainFfiEnvelopeContract {
    descriptor_required: bool,
    node_count: u64,
    tangent_frame_count: u64,
    equilibrium_m0_count: u64,
    effective_field_count: u64,
    external_field_count: u64,
    alpha_count: u64,
    legacy_a_qq_is_null: bool,
    term_presence_mask: u32,
    exchange_material_view_present: bool,
    demag_provider_bound_to_operator_input: bool,
    acceptance_criterion: String,
    acceptance_metric_kind: String,
    acceptance_unit: String,
    acceptance_metric_value: f64,
    acceptance_threshold: f64,
    acceptance_certificate_sha256: String,
}

impl<'a> NativeModalEigenSharedDomainProblem<'a> {
    fn ffi_envelope_contract(&self) -> Result<NativeModalSharedDomainFfiEnvelopeContract, String> {
        const TERM_EXCHANGE: u32 = 1 << 0;
        const TERM_FIELD: u32 = 1 << 1;
        const TERM_DEMAG: u32 = 1 << 4;
        let node_count = self.mesh.nodes.len();
        let digest_valid = |value: &str| {
            value.len() == 71
                && value.starts_with("sha256:")
                && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
        };
        let finite = |values: &[f64]| values.iter().all(|value| value.is_finite());
        let expected = [
            (
                "equilibrium_m0_xyz",
                self.equilibrium_m0_xyz.len(),
                3 * node_count,
            ),
            (
                "linearization_m0_xyz",
                self.linearization_m0_xyz.len(),
                3 * node_count,
            ),
            (
                "linearization_h_eff0_xyz",
                self.linearization_h_eff0_xyz.len(),
                3 * node_count,
            ),
            (
                "linearization_h_demag0_xyz",
                self.linearization_h_demag0_xyz.len(),
                3 * node_count,
            ),
            (
                "tangent_frame_xyz",
                self.tangent_frame_xyz.len(),
                6 * node_count,
            ),
            (
                "external_field_h_ext0_xyz",
                self.external_field_h_ext0_xyz.len(),
                3 * node_count,
            ),
            ("alpha_per_node", self.alpha_per_node.len(), node_count),
        ];
        if let Some((name, actual, wanted)) = expected
            .into_iter()
            .find(|(_, actual, wanted)| actual != wanted)
        {
            return Err(format!(
                "native FEM modal_eigen descriptor {name} count {actual} does not match {wanted}"
            ));
        }
        if self.equilibrium_m0_xyz != self.linearization_m0_xyz {
            return Err(
                "native FEM modal_eigen descriptor equilibrium does not match accepted m0"
                    .to_string(),
            );
        }
        if !finite(&self.tangent_frame_xyz)
            || !finite(&self.linearization_m0_xyz)
            || !finite(&self.linearization_h_eff0_xyz)
            || !finite(&self.linearization_h_demag0_xyz)
            || !finite(&self.external_field_h_ext0_xyz)
            || !finite(&self.alpha_per_node)
        {
            return Err(
                "native FEM modal_eigen descriptor contains non-finite nodal data".to_string(),
            );
        }
        for node in 0..node_count {
            let m = &self.linearization_m0_xyz[3 * node..3 * node + 3];
            let e1 = &self.tangent_frame_xyz[6 * node..6 * node + 3];
            let e2 = &self.tangent_frame_xyz[6 * node + 3..6 * node + 6];
            let dot = |left: &[f64], right: &[f64]| {
                left.iter()
                    .zip(right)
                    .map(|(left, right)| left * right)
                    .sum::<f64>()
            };
            let unit_error = |value: &[f64]| (dot(value, value) - 1.0).abs();
            if unit_error(m) > 1.0e-8
                || unit_error(e1) > 1.0e-8
                || unit_error(e2) > 1.0e-8
                || dot(m, e1).abs() > 1.0e-8
                || dot(m, e2).abs() > 1.0e-8
                || dot(e1, e2).abs() > 1.0e-8
            {
                return Err(format!(
                    "native FEM modal_eigen descriptor tangent frame is invalid at node {node}"
                ));
            }
        }
        if !digest_valid(&self.linearization_state_digest)
            || !digest_valid(&self.equilibrium_digest)
            || !digest_valid(&self.operator_input_digest)
        {
            return Err(
                "native FEM modal_eigen descriptor requires canonical sha256 identities"
                    .to_string(),
            );
        }
        if !digest_valid(&self.acceptance_certificate_sha256) {
            return Err(
                "native FEM modal_eigen requires a canonical accepted-equilibrium certificate digest"
                    .to_string(),
            );
        }
        if !self.acceptance_metric_value.is_finite()
            || self.acceptance_metric_value < 0.0
            || !self.acceptance_threshold.is_finite()
            || self.acceptance_threshold < 0.0
            || self.acceptance_metric_value > self.acceptance_threshold
        {
            return Err(
                "native FEM modal_eigen accepted-equilibrium metric is invalid or unsatisfied"
                    .to_string(),
            );
        }
        let coherent_acceptance = matches!(
            (
                self.acceptance_criterion.as_str(),
                self.acceptance_metric_kind.as_str(),
                self.acceptance_unit.as_str(),
            ),
            ("torque", "max_torque_apm", "A/m") | ("energy", "total_energy_plateau_range_j", "J")
        );
        if !coherent_acceptance {
            return Err(
                "native FEM modal_eigen accepted-equilibrium criterion tuple is incoherent"
                    .to_string(),
            );
        }
        let term_digest_matches = |term: u32, digest: Option<&String>| {
            if self.term_presence_mask & term != 0 {
                digest.is_some_and(|value| digest_valid(value))
            } else {
                digest.is_none()
            }
        };
        if !term_digest_matches(TERM_EXCHANGE, self.exchange_term_digest.as_ref())
            || !term_digest_matches(TERM_FIELD, self.field_term_digest.as_ref())
            || !term_digest_matches(TERM_DEMAG, self.demag_term_digest.as_ref())
        {
            return Err(
                "native FEM modal_eigen descriptor term mask and digests disagree".to_string(),
            );
        }
        if self.term_presence_mask & TERM_EXCHANGE != 0
            && !self
                .exchange_stiffness_j_per_m
                .is_some_and(|value| value.is_finite() && value > 0.0)
        {
            return Err(
                "native FEM modal_eigen exchange descriptor requires positive Aex".to_string(),
            );
        }
        if self.term_presence_mask & TERM_DEMAG != 0
            && self.demag_provider_signature.as_deref() != Some(&self.operator_input_digest)
        {
            return Err(
                "native FEM modal_eigen demag provider signature does not bind operator input"
                    .to_string(),
            );
        }
        Ok(NativeModalSharedDomainFfiEnvelopeContract {
            descriptor_required: true,
            node_count: node_count as u64,
            tangent_frame_count: self.tangent_frame_xyz.len() as u64,
            equilibrium_m0_count: self.linearization_m0_xyz.len() as u64,
            effective_field_count: self.linearization_h_eff0_xyz.len() as u64,
            external_field_count: self.external_field_h_ext0_xyz.len() as u64,
            alpha_count: self.alpha_per_node.len() as u64,
            legacy_a_qq_is_null: true,
            term_presence_mask: self.term_presence_mask,
            exchange_material_view_present: self.exchange_stiffness_j_per_m.is_some(),
            demag_provider_bound_to_operator_input: self.demag_provider_signature.as_deref()
                == Some(&self.operator_input_digest),
            acceptance_criterion: self.acceptance_criterion.clone(),
            acceptance_metric_kind: self.acceptance_metric_kind.clone(),
            acceptance_unit: self.acceptance_unit.clone(),
            acceptance_metric_value: self.acceptance_metric_value,
            acceptance_threshold: self.acceptance_threshold,
            acceptance_certificate_sha256: self.acceptance_certificate_sha256.clone(),
        })
    }

    fn ffi_envelope_contract_for_target(
        &self,
        execution_target: NativeModalExecutionTarget,
    ) -> Result<NativeModalSharedDomainFfiEnvelopeContract, String> {
        match execution_target {
            NativeModalExecutionTarget::Auto
            | NativeModalExecutionTarget::ProductionCpu
            | NativeModalExecutionTarget::ProductionGpu => self.ffi_envelope_contract(),
        }
    }

    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn ffi_payload<'b>(
        &'b self,
        mesh_descriptor: &'b ffi::fullmag_fem_mesh_desc,
        boundary_kind: &'b CString,
        equilibrium_digest: &'b CString,
        mesh_certificate_digest: &'b CString,
        mesh_certificate_schema: &'b CString,
        mesh_certificate_map_binding_digest: &'b CString,
        linearization_state_digest: &'b CString,
        mesh_generation_identity: &'b CString,
        canonical_preimage: &'b CString,
        canonical_preimage_sha256: &'b CString,
        magnetic_class_digest_sha256: &'b CString,
        scalar_class_digest_sha256: &'b CString,
        certificate_binding_reason: &'b CString,
        boundary_gauge_digest: &'b CString,
        bias_field_sample_id: &'b CString,
        bias_field_sample_signature: &'b CString,
        magnetic_part_identity: &'b CString,
        airbox_part_identity: &'b CString,
        certificate_binding_v6: &'b ffi::FullmagFemModalCertificateV6BindingRequest,
        equilibrium_id: &'b CString,
        mesh_snapshot_id: &'b CString,
        material_snapshot_id: &'b CString,
        physics_snapshot_id: &'b CString,
        boundary_snapshot_id: &'b CString,
        producer_run_id: &'b CString,
        equilibrium_content_sha256: &'b CString,
        demag_model: &'b CString,
        acceptance_criterion: &'b CString,
        acceptance_metric_kind: &'b CString,
        acceptance_unit: &'b CString,
        acceptance_certificate_sha256: &'b CString,
        linearization_descriptor: &'b ffi::FullmagFemModalLinearizationDescriptor,
        exchange_material_view: Option<&'b ffi::FullmagFemModalExchangeMaterialView>,
        envelope: &'b NativeModalSharedDomainFfiEnvelopeContract,
    ) -> ffi::FullmagFemModalSharedDomainPayload {
        debug_assert!(envelope.descriptor_required);
        debug_assert!(envelope.legacy_a_qq_is_null);
        debug_assert_eq!(
            envelope.exchange_material_view_present,
            exchange_material_view.is_some()
        );
        debug_assert!(envelope.demag_provider_bound_to_operator_input);
        ffi::FullmagFemModalSharedDomainPayload {
            abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::FullmagFemModalSharedDomainPayload>() as u32,
            mesh: mesh_descriptor,
            equilibrium_m0_xyz: self.equilibrium_m0_xyz.as_ptr(),
            equilibrium_m0_xyz_count: self.equilibrium_m0_xyz.len() as u64,
            linearization_m0_xyz: self.linearization_m0_xyz.as_ptr(),
            linearization_m0_xyz_count: self.linearization_m0_xyz.len() as u64,
            linearization_h_eff0_xyz: self.linearization_h_eff0_xyz.as_ptr(),
            linearization_h_eff0_xyz_count: self.linearization_h_eff0_xyz.len() as u64,
            linearization_h_demag0_xyz: self.linearization_h_demag0_xyz.as_ptr(),
            linearization_h_demag0_xyz_count: self.linearization_h_demag0_xyz.len() as u64,
            linearization_phi0: self.linearization_phi0.as_ptr(),
            linearization_phi0_count: self.linearization_phi0.len() as u64,
            saturation_magnetisation_a_per_m: if self.saturation_magnetisation_a_per_m.is_empty() {
                std::ptr::null()
            } else {
                self.saturation_magnetisation_a_per_m.as_ptr()
            },
            saturation_magnetisation_count: self.saturation_magnetisation_a_per_m.len() as u64,
            uniform_saturation_magnetisation_a_per_m: self.uniform_saturation_magnetisation_a_per_m,
            gamma0_m_per_a_s: self.gamma0_m_per_a_s,
            // ABI v19 forbids the legacy runner-owned magnetic A_qq CSR.
            // Native MFEM assembles A_qq from the physical descriptor below.
            magnetic_a_qq_csr: ffi::FullmagFemCsrMatrixView {
                row_count: 0,
                column_count: 0,
                row_offsets: std::ptr::null(),
                row_offsets_len: 0,
                column_indices: std::ptr::null(),
                column_indices_len: 0,
                values: std::ptr::null(),
                values_len: 0,
            },
            scalar_reduced_node: self.scalar_reduced_node.as_ptr(),
            scalar_reduced_node_count: self.scalar_reduced_node_count,
            magnetic_reduced_node: self.magnetic_reduced_node.as_ptr(),
            magnetic_reduced_node_count: self.magnetic_reduced_node_count,
            magnetic_pair_count: self.magnetic_pair_count,
            airbox_pair_count: self.airbox_pair_count,
            boundary_kind: boundary_kind.as_ptr(),
            robin_beta: self.robin_beta,
            boundary_marker: self.boundary_marker,
            equilibrium_digest: equilibrium_digest.as_ptr(),
            mesh_certificate_digest: mesh_certificate_digest.as_ptr(),
            mesh_certificate_schema: mesh_certificate_schema.as_ptr(),
            mesh_certificate_map_binding_digest: mesh_certificate_map_binding_digest.as_ptr(),
            boundary_gauge_digest: boundary_gauge_digest.as_ptr(),
            bias_field_sample_index: self.certificate_binding_v6.bias_field_sample_index,
            bias_field_sample_id: bias_field_sample_id.as_ptr(),
            bias_field_sample_signature: bias_field_sample_signature.as_ptr(),
            magnetic_part_identity: magnetic_part_identity.as_ptr(),
            airbox_part_identity: airbox_part_identity.as_ptr(),
            linearization_state_digest: linearization_state_digest.as_ptr(),
            equilibrium_id: equilibrium_id.as_ptr(),
            mesh_snapshot_id: mesh_snapshot_id.as_ptr(),
            material_snapshot_id: material_snapshot_id.as_ptr(),
            physics_snapshot_id: physics_snapshot_id.as_ptr(),
            boundary_snapshot_id: boundary_snapshot_id.as_ptr(),
            producer_run_id: producer_run_id.as_ptr(),
            equilibrium_content_sha256: equilibrium_content_sha256.as_ptr(),
            demag_model: demag_model.as_ptr(),
            m0_norm_tolerance: self.m0_norm_tolerance,
            equilibrium_torque_relative_tolerance: 0.0,
            mesh_generation_identity: mesh_generation_identity.as_ptr(),
            canonical_preimage: canonical_preimage.as_ptr(),
            canonical_preimage_len: self.canonical_preimage.as_bytes().len() as u64,
            canonical_preimage_sha256: canonical_preimage_sha256.as_ptr(),
            magnetic_class_digest_sha256: magnetic_class_digest_sha256.as_ptr(),
            scalar_class_digest_sha256: scalar_class_digest_sha256.as_ptr(),
            certificate_binding_status: self.certificate_binding_status,
            certificate_binding_reason: certificate_binding_reason.as_ptr(),
            certificate_binding_v6,
            linearization_descriptor,
            exchange_material_view: exchange_material_view
                .map_or(std::ptr::null(), |value| value as *const _),
            acceptance_criterion: acceptance_criterion.as_ptr(),
            acceptance_metric_kind: acceptance_metric_kind.as_ptr(),
            acceptance_unit: acceptance_unit.as_ptr(),
            acceptance_metric_value: self.acceptance_metric_value,
            acceptance_threshold: self.acceptance_threshold,
            acceptance_certificate_sha256: acceptance_certificate_sha256.as_ptr(),
        }
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenTinyValidationProblem<'a> {
    pub tangent_dof_count: u64,
    pub stiffness_matrix_row_major: Option<&'a [f64]>,
    pub mass_matrix_row_major: Option<&'a [f64]>,
    pub stiffness_diagonal: Option<&'a [f64]>,
    pub mass_diagonal: Option<&'a [f64]>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenMfemOperatorProblem<'a> {
    pub tangent_dof_count: u64,
    pub stiffness_matrix_row_major: Option<&'a [f64]>,
    pub gyrotropic_matrix_row_major: Option<&'a [f64]>,
    pub mass_matrix_row_major: Option<&'a [f64]>,
    pub linearized_pencil_dependency_digest: Option<&'a str>,
    pub linearized_pencil_gamma0_m_per_a_s: f64,
    pub phase_convention: FrequencyDomainPhaseConvention,
    pub floquet_periodic_pairs: &'a [NativeModalEigenFloquetPeriodicPair<'a>],
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenCsrMatrixView<'a> {
    pub row_count: u64,
    pub column_count: u64,
    pub row_offsets: &'a [u32],
    pub column_indices: &'a [u32],
    pub values: &'a [f64],
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenSparseOperatorProblem<'a> {
    pub stiffness_csr: NativeModalEigenCsrMatrixView<'a>,
    pub gyrotropic_csr: NativeModalEigenCsrMatrixView<'a>,
    pub mass_csr: NativeModalEigenCsrMatrixView<'a>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenPoissonAirboxBlockProblem<'a> {
    pub q_dof_count: u64,
    pub phi_dof_count: u64,
    pub a_qq_csr: NativeModalEigenCsrMatrixView<'a>,
    pub a_qphi_csr: NativeModalEigenCsrMatrixView<'a>,
    pub a_phiq_csr: NativeModalEigenCsrMatrixView<'a>,
    pub a_phiphi_csr: NativeModalEigenCsrMatrixView<'a>,
    pub b_qq_csr: NativeModalEigenCsrMatrixView<'a>,
    pub phi_mean_weights: &'a [f64],
    pub target_frequency_hz: f64,
    pub expected_reference_frequency_hz: f64,
    pub periodic_mesh_certificate_schema: &'a str,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub outer_boundary_kind: &'a str,
    pub robin_beta: f64,
    pub gauge_policy: &'a str,
    pub gauge_reason: &'a str,
    pub assembly_kind: &'a str,
    pub shift_invert_action: Option<NativeModalEigenPoissonAirboxShiftInvertAction<'a>>,
}

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenPoissonAirboxShiftInvertAction<'a> {
    pub sigma_real: f64,
    pub sigma_imag: f64,
    pub vector_real: &'a [f64],
    pub vector_imag: Option<&'a [f64]>,
    pub use_gpu_hidden_action: bool,
}

#[derive(Clone)]
#[allow(dead_code)]
pub(crate) struct NativeDrivenResponseContractRequest<'a> {
    pub mesh_asset_id: &'a str,
    pub equilibrium_source_kind: &'a str,
    pub gamma_rad_s_t: f64,
    pub mu0_t_m_a: f64,
    pub alpha: f64,
    pub include_exchange: bool,
    pub include_demag: bool,
    pub demag_realization: Option<&'a str>,
    pub damping_policy: &'a str,
    pub spin_wave_bc_kind: &'a str,
    pub k_vector_rad_m: Option<&'a [f64]>,
    pub operator_diagnostics_json: Option<&'a str>,
    pub frequencies_hz: &'a [f64],
    pub excitation_field_a_m: &'a [f64],
    pub excitation_phase_rad: f64,
    pub residual_tolerance: f64,
    pub max_linear_iterations: i32,
    pub output_directory: Option<&'a Path>,
    pub write_partial_artifacts: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalComplex64 {
    pub real: f64,
    pub imag: f64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeModalEigenTypedResult {
    pub q_dof_count: u64,
    pub phi_dof_count: u64,
    pub mode_lambda: Vec<NativeModalComplex64>,
    pub mode_q_complex: Vec<NativeModalComplex64>,
    pub mode_phi_complex: Vec<NativeModalComplex64>,
    pub mode_delta_m_xyz_complex: Vec<NativeModalComplex64>,
    pub mode_residuals: Vec<f64>,
    pub mode_cluster_ids: Vec<u64>,
    pub resolved_execution_target: u32,
    pub resolved_scalar_representation: u32,
    pub resolved_spectral_transform_kind: u32,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeFrequencyDomainContractResult {
    pub status: NativeFrequencyDomainStatus,
    pub error_message: String,
    pub diagnostics_json: String,
    pub result_json: String,
    pub artifact_manifest_path: String,
    pub modal_eigen: Option<NativeModalEigenTypedResult>,
    pub modal_gpu_attestation: Option<NativeModalGpuAttestation>,
    pub resolved_fallback_state: u32,
    pub resolved_engine_id: String,
    pub resolved_fallback_reason: String,
    pub resolved_canonical_preimage_sha256: String,
    pub resolved_certificate_binding_status: u32,
    pub resolved_certificate_binding_reason: String,
}

#[allow(dead_code)]
pub(crate) fn solve_native_driven_frequency_response(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    #[cfg(feature = "fem-gpu")]
    super::configure_managed_openmpi_environment();
    solve_native_driven_frequency_response_impl(request)
}

#[allow(dead_code)]
pub(crate) fn solve_native_modal_eigen(
    request: NativeModalEigenRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let production_shared_domain_required = matches!(
        request.execution_target,
        NativeModalExecutionTarget::ProductionCpu | NativeModalExecutionTarget::ProductionGpu
    ) && request.include_demag
        && request.spin_wave_bc_kind == "periodic"
        && request
            .k_vector_rad_m
            .is_none_or(|values| values.iter().all(|value| value.abs() <= f64::EPSILON));
    validate_native_modal_request_payload_ownership(
        request.execution_target,
        production_shared_domain_required,
        request.shared_domain_problem.is_some(),
        request.mfem_operator_problem.is_some(),
        request.mfem_sparse_operator_problem.is_some(),
        request.poisson_airbox_block_problem.is_some(),
        request.tiny_validation_problem.is_some(),
    )?;
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    super::configure_managed_openmpi_environment();
    // The native GPU adapter owns a process-local PETSc/SLEPc context and
    // registers an atexit cleanup handler.  Do not finalize it after every
    // request: doing so destroys the cached Schur/PETSc CUDA context and makes
    // a second request indistinguishable from a cold start.  The explicit FFI
    // finalizer remains available to controlled shutdowns and native contract
    // tests; normal runner requests must preserve context reuse/invalidation.
    solve_native_modal_eigen_impl(request)
}

fn validate_native_modal_request_payload_ownership(
    execution_target: NativeModalExecutionTarget,
    production_shared_domain_required: bool,
    has_shared_domain_problem: bool,
    has_mfem_operator_problem: bool,
    has_mfem_sparse_operator_problem: bool,
    has_poisson_airbox_block_problem: bool,
    has_tiny_validation_problem: bool,
) -> Result<(), String> {
    let production = matches!(
        execution_target,
        NativeModalExecutionTarget::ProductionCpu | NativeModalExecutionTarget::ProductionGpu
    );
    if production_shared_domain_required && production && !has_shared_domain_problem {
        return Err(
            "native FEM production K0 demag requires a certified shared-domain payload".to_string(),
        );
    }
    if production
        && has_shared_domain_problem
        && (has_mfem_operator_problem
            || has_mfem_sparse_operator_problem
            || has_poisson_airbox_block_problem
            || has_tiny_validation_problem)
    {
        return Err(
            "native FEM shared-domain production must not transport a runner-assembled operator or validation pencil"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn validate_planned_modal_execution_attestation(
    planned_engine: fullmag_ir::FemEigenEngineIR,
    requested_target: NativeModalExecutionTarget,
    resolved_target: Option<u32>,
    resolved_fallback_state: u32,
    resolved_engine_id: &str,
) -> Result<(), String> {
    let (expected_target, accepted_engine_ids): (u32, &[&str]) = match planned_engine {
        fullmag_ir::FemEigenEngineIR::Auto => {
            return Err("native_modal_engine_mismatch: planned engine cannot be auto".to_string());
        }
        fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc => {
            (1, &["k0_poisson_airbox_cpu_schur_slepc"])
        }
        fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov => (
            2,
            &[
                "gpu_modal_device_krylov",
                "k0_poisson_airbox_gpu_petsc_slepc",
            ],
        ),
    };
    let requested_target_value = match requested_target {
        NativeModalExecutionTarget::Auto => 0,
        NativeModalExecutionTarget::ProductionCpu => 1,
        NativeModalExecutionTarget::ProductionGpu => 2,
    };
    if requested_target_value != expected_target || resolved_target != Some(expected_target) {
        return Err(format!(
            "native_modal_execution_target_mismatch: planned_engine={planned_engine:?} requested_target={requested_target_value} resolved_target={resolved_target:?}"
        ));
    }
    if resolved_fallback_state != 0 {
        return Err(format!(
            "native_modal_runtime_fallback_forbidden: resolved_fallback_state={resolved_fallback_state}"
        ));
    }
    if !accepted_engine_ids.contains(&resolved_engine_id) {
        return Err(format!(
            "native_modal_engine_mismatch: planned_engine={planned_engine:?} resolved_engine_id={resolved_engine_id:?}"
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn solve_native_driven_response_contract(
    request: NativeDrivenResponseContractRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    #[cfg(feature = "fem-gpu")]
    super::configure_managed_openmpi_environment();
    solve_native_driven_response_contract_impl(request)
}

#[cfg(feature = "fem-gpu")]
fn positive_env_f64(primary: &str, alias: &str) -> f64 {
    std::env::var(primary)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| {
            std::env::var(alias)
                .ok()
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0)
        })
        .unwrap_or(0.0)
}

#[cfg(feature = "fem-gpu")]
fn positive_env_u64(primary: &str, alias: &str) -> u64 {
    std::env::var(primary)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .or_else(|| {
            std::env::var(alias)
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
        })
        .unwrap_or(0)
}

#[cfg(feature = "fem-gpu")]
fn solve_native_driven_frequency_response_impl(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    let output_directory = CString::new(request.output_directory.to_string_lossy().as_bytes())
        .map_err(|_| "native FEM frequency response output path contains NUL".to_string())?;
    let operator_diagnostics_json = request
        .operator_diagnostics_json
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM frequency response operator_diagnostics_json contains NUL".to_string()
        })?;
    let cancel_callback = request.cancel_requested;
    let (cancel_requested, cancel_user_data) = if cancel_callback.is_some() {
        (
            Some(
                dispatch_native_frequency_domain_cancel as unsafe extern "C" fn(*mut c_void) -> i32,
            ),
            (&cancel_callback as *const Option<&NativeFrequencyDomainCancelCallback<'_>>)
                as *mut c_void,
        )
    } else {
        request
            .interrupt_requested
            .map_or((None, std::ptr::null_mut()), |flag| {
                (
                    Some(poll_atomic_interrupt_flag as unsafe extern "C" fn(*mut c_void) -> i32),
                    flag as *const AtomicBool as *mut c_void,
                )
            })
    };
    let progress_callback = request.progress_callback;
    let (progress_callback_fn, progress_user_data) = if progress_callback.is_some() {
        (
            Some(
                dispatch_native_frequency_domain_progress
                    as unsafe extern "C" fn(
                        *mut c_void,
                        *const ffi::fullmag_fem_frequency_domain_progress,
                    ),
            ),
            (&progress_callback as *const Option<&NativeFrequencyDomainProgressCallback<'_>>)
                as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };
    let tiny_validation = request.tiny_validation_problem.as_ref();
    let mfem_operator = request.mfem_operator_problem.as_ref();
    let periodic_airbox_coupled_block = request.periodic_airbox_coupled_block_problem.as_ref();
    let exchange_edges = mfem_operator
        .map(|problem| {
            problem
                .exchange_edges
                .iter()
                .map(|edge| ffi::fullmag_fem_frequency_domain_exchange_edge {
                    node_i: edge.node_i,
                    node_j: edge.node_j,
                    stiffness: edge.stiffness,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let dmi_elements = mfem_operator
        .map(|problem| {
            problem
                .dmi_elements
                .iter()
                .map(|element| ffi::fullmag_fem_frequency_domain_dmi_element {
                    kind: map_dmi_kind(element.kind),
                    node_indices: element.node_indices,
                    shape: element.shape,
                    grad_shape: element.grad_shape,
                    weight: element.weight,
                    d: element.d,
                    normal: element.normal,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let static_periodic_node_pairs = mfem_operator
        .map(|problem| {
            problem
                .static_periodic_node_pairs
                .iter()
                .map(
                    |pair| ffi::fullmag_fem_frequency_domain_periodic_node_pair {
                        node_a: pair.node_a,
                        node_b: pair.node_b,
                    },
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let periodic_airbox_magnetostatic_periodic_node_pairs = request
        .periodic_airbox_magnetostatic_periodic_node_pairs
        .iter()
        .map(
            |pair| ffi::fullmag_fem_frequency_domain_periodic_node_pair {
                node_a: pair.node_a,
                node_b: pair.node_b,
            },
        )
        .collect::<Vec<_>>();
    let floquet_pair_ids = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .map(|pair| {
                    pair.pair_id
                        .map(|pair_id| {
                            CString::new(pair_id.as_bytes()).map_err(|_| {
                                "native FEM frequency response Floquet pair id contains NUL"
                                    .to_string()
                            })
                        })
                        .transpose()
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let floquet_periodic_pairs = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .zip(floquet_pair_ids.iter())
                .map(
                    |(pair, pair_id)| ffi::fullmag_fem_frequency_domain_floquet_periodic_pair {
                        pair_id: pair_id
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                        node_a: pair.node_a,
                        node_b: pair.node_b,
                        has_translation: pair.translation_m.is_some() as i32,
                        translation_m: pair.translation_m.unwrap_or([0.0; 3]),
                        has_phase: pair.phase_rad.is_some() as i32,
                        phase_rad: pair.phase_rad.unwrap_or(0.0),
                    },
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(problem) = mfem_operator {
        validate_floquet_pair_phase_metadata(
            problem.floquet_k_vector_rad_per_m,
            problem.floquet_periodic_pairs,
        )?;
    }
    let ffi_request = ffi::fullmag_fem_frequency_domain_driven_response_request {
        node_count: request.node_count,
        tangent_dof_count: request.tangent_dof_count,
        alpha: request.alpha,
        gamma0: request.gamma0,
        requested_execution_lane: map_execution_lane(request.execution_lane),
        frequencies_hz: if request.frequencies_hz.is_empty() {
            std::ptr::null()
        } else {
            request.frequencies_hz.as_ptr()
        },
        frequency_count: request.frequencies_hz.len() as u64,
        output_directory: output_directory.as_ptr(),
        write_response_fields: request.write_response_fields as i32,
        write_partial_artifacts: request.write_partial_artifacts as i32,
        operator_diagnostics_json: optional_str_ptr(operator_diagnostics_json.as_ref()),
        cancel_requested,
        cancel_user_data,
        progress_callback: progress_callback_fn,
        progress_user_data,
        tiny_validation_enabled: tiny_validation.is_some() as i32,
        tiny_validation_tangent_dof_count: tiny_validation
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        tiny_validation_stiffness_matrix_row_major: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_matrix_row_major: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_stiffness_diagonal: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_diagonal: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_drive_real: tiny_validation.map_or(std::ptr::null(), |problem| {
            slice_ptr_or_null(problem.drive_real)
        }),
        mfem_operator_enabled: mfem_operator.is_some() as i32,
        mfem_include_zeeman: mfem_operator.is_some_and(|problem| problem.include_zeeman) as i32,
        mfem_equilibrium_m: mfem_operator.map_or(std::ptr::null(), |problem| {
            if problem.equilibrium_m.is_empty() {
                std::ptr::null()
            } else {
                problem.equilibrium_m.as_ptr().cast::<f64>()
            }
        }),
        mfem_h_ext_a_per_m: mfem_operator
            .map_or(std::ptr::null(), |problem| problem.h_ext_a_per_m.as_ptr()),
        mfem_uniaxial_anisotropy_axis: mfem_operator
            .and_then(|problem| problem.uniaxial_anisotropy_axis)
            .map_or(std::ptr::null(), |axis| axis.as_ptr()),
        mfem_uniaxial_anisotropy_field_a_per_m: mfem_operator
            .map_or(0.0, |problem| problem.uniaxial_anisotropy_field_a_per_m),
        mfem_alpha_per_node: mfem_operator
            .and_then(|problem| problem.alpha_per_node)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_drive_real: mfem_operator.map_or(std::ptr::null(), |problem| {
            slice_ptr_or_null(problem.drive_real)
        }),
        mfem_exchange_edges: if exchange_edges.is_empty() {
            std::ptr::null()
        } else {
            exchange_edges.as_ptr()
        },
        mfem_exchange_edge_count: exchange_edges.len() as u64,
        mfem_dmi_elements: if dmi_elements.is_empty() {
            std::ptr::null()
        } else {
            dmi_elements.as_ptr()
        },
        mfem_dmi_element_count: dmi_elements.len() as u64,
        mfem_dmi_lumped_mass: mfem_operator
            .and_then(|problem| problem.dmi_lumped_mass)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_dmi_ms_field: mfem_operator
            .and_then(|problem| problem.dmi_ms_field)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_dmi_uniform_ms: mfem_operator.map_or(0.0, |problem| problem.dmi_uniform_ms),
        tiny_validation_drive_imag: tiny_validation
            .and_then(|problem| problem.drive_imag)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_drive_imag: mfem_operator
            .and_then(|problem| problem.drive_imag)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_static_periodic_node_pairs: if static_periodic_node_pairs.is_empty() {
            std::ptr::null()
        } else {
            static_periodic_node_pairs.as_ptr()
        },
        mfem_static_periodic_node_pair_count: static_periodic_node_pairs.len() as u64,
        has_floquet_k_vector: mfem_operator
            .and_then(|problem| problem.floquet_k_vector_rad_per_m)
            .is_some() as i32,
        floquet_k_vector_rad_per_m: mfem_operator
            .and_then(|problem| problem.floquet_k_vector_rad_per_m)
            .unwrap_or([0.0; 3]),
        phase_convention: map_phase_convention(
            mfem_operator
                .map(|problem| problem.phase_convention)
                .unwrap_or(FrequencyDomainPhaseConvention::ExpIOmegaT),
        ),
        drive_kind:
            ffi::fullmag_fem_frequency_domain_drive_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED,
        require_nonzero_rhs: 0,
        mfem_floquet_periodic_pairs: if floquet_periodic_pairs.is_empty() {
            std::ptr::null()
        } else {
            floquet_periodic_pairs.as_ptr()
        },
        mfem_floquet_periodic_pair_count: floquet_periodic_pairs.len() as u64,
        requires_periodic_airbox_dynamic_demag: request.requires_periodic_airbox_dynamic_demag
            as i32,
        requires_floquet_airbox_dynamic_demag: request.requires_floquet_airbox_dynamic_demag as i32,
        magnetic_periodic_constraint_set_count: request.magnetic_periodic_constraint_set_count,
        magnetostatic_periodic_constraint_set_count: request
            .magnetostatic_periodic_constraint_set_count,
        periodic_airbox_delta_m_tangent_dof_count: request
            .periodic_airbox_delta_m_tangent_dof_count,
        periodic_airbox_delta_phi_dof_count: request.periodic_airbox_delta_phi_dof_count,
        periodic_airbox_magnetostatic_periodic_node_pairs:
            if periodic_airbox_magnetostatic_periodic_node_pairs.is_empty() {
                std::ptr::null()
            } else {
                periodic_airbox_magnetostatic_periodic_node_pairs.as_ptr()
            },
        periodic_airbox_magnetostatic_periodic_node_pair_count:
            periodic_airbox_magnetostatic_periodic_node_pairs.len() as u64,
        periodic_airbox_coupled_block_enabled: periodic_airbox_coupled_block.is_some() as i32,
        periodic_airbox_coupled_block_delta_m_tangent_dof_count: periodic_airbox_coupled_block
            .map(|problem| problem.delta_m_tangent_dof_count)
            .unwrap_or(0),
        periodic_airbox_coupled_block_delta_phi_dof_count: periodic_airbox_coupled_block
            .map(|problem| problem.delta_phi_dof_count)
            .unwrap_or(0),
        periodic_airbox_coupled_block_stiffness_matrix_row_major: periodic_airbox_coupled_block
            .map_or(std::ptr::null(), |problem| {
                slice_ptr_or_null(problem.stiffness_matrix_row_major)
            }),
        periodic_airbox_coupled_block_mass_matrix_row_major: periodic_airbox_coupled_block
            .map_or(std::ptr::null(), |problem| {
                slice_ptr_or_null(problem.mass_matrix_row_major)
            }),
        periodic_airbox_coupled_block_apply_stiffness: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_stiffness),
        periodic_airbox_coupled_block_apply_mass: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_mass),
        periodic_airbox_coupled_block_apply_complex_stiffness: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_complex_stiffness),
        periodic_airbox_coupled_block_apply_complex_mass: periodic_airbox_coupled_block
            .and_then(|problem| problem.apply_complex_mass),
        periodic_airbox_coupled_block_operator_user_data: periodic_airbox_coupled_block
            .map_or(std::ptr::null_mut(), |problem| problem.operator_user_data),
        periodic_airbox_coupled_block_drive_real: periodic_airbox_coupled_block
            .map_or(std::ptr::null(), |problem| {
                slice_ptr_or_null(problem.drive_real)
            }),
        periodic_airbox_coupled_block_drive_imag: periodic_airbox_coupled_block
            .and_then(|problem| problem.drive_imag)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_apply_demag_tangent: mfem_operator.and_then(|problem| problem.apply_demag_tangent),
        mfem_demag_tangent_user_data: mfem_operator.map_or(std::ptr::null_mut(), |problem| {
            problem.demag_tangent_user_data
        }),
        mfem_demag_tangent_matrix_row_major: mfem_operator
            .and_then(|problem| problem.demag_tangent_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_observable_ms_field: mfem_operator
            .and_then(|problem| problem.observable_ms_field)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_observable_ms_field_len: mfem_operator
            .and_then(|problem| problem.observable_ms_field)
            .map_or(0, |values| values.len() as u64),
        mfem_observable_uniform_ms: mfem_operator
            .map_or(0.0, |problem| problem.observable_uniform_ms),
        abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
        reserved_contract_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_frequency_domain_driven_response_request>(
        ) as u64,
        solver_relative_tolerance: positive_env_f64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_RTOL",
            "FULLMAG_FMR_RESPONSE_RTOL",
        ),
        solver_absolute_tolerance: positive_env_f64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_ATOL",
            "FULLMAG_FMR_RESPONSE_ATOL",
        ),
        solver_max_iterations: positive_env_u64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_MAX_ITERATIONS",
            "FULLMAG_FMR_RESPONSE_MAX_ITERATIONS",
        ),
        solver_restart_iterations: positive_env_u64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_RESTART_ITERATIONS",
            "FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS",
        ),
        solver_progress_interval_iterations: positive_env_u64(
            "FULLMAG_FEM_FREQUENCY_RESPONSE_PROGRESS_INTERVAL",
            "FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL",
        ),
        tiny_validation_stiffness_matrix_value_count: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_mass_matrix_value_count: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_stiffness_diagonal_value_count: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_mass_diagonal_value_count: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(0, |values| values.len() as u64),
        tiny_validation_drive_real_value_count: tiny_validation
            .map_or(0, |problem| problem.drive_real.len() as u64),
        tiny_validation_drive_imag_value_count: tiny_validation
            .and_then(|problem| problem.drive_imag)
            .map_or(0, |values| values.len() as u64),
        mfem_equilibrium_m_value_count: mfem_operator
            .map_or(0, |problem| (problem.equilibrium_m.len() * 3) as u64),
        mfem_h_ext_value_count: mfem_operator
            .map_or(0, |problem| problem.h_ext_a_per_m.len() as u64),
        mfem_uniaxial_anisotropy_axis_value_count: mfem_operator
            .and_then(|problem| problem.uniaxial_anisotropy_axis)
            .map_or(0, |values| values.len() as u64),
        mfem_alpha_value_count: mfem_operator
            .and_then(|problem| problem.alpha_per_node)
            .map_or(0, |values| values.len() as u64),
        mfem_drive_real_value_count: mfem_operator
            .map_or(0, |problem| problem.drive_real.len() as u64),
        mfem_drive_imag_value_count: mfem_operator
            .and_then(|problem| problem.drive_imag)
            .map_or(0, |values| values.len() as u64),
        mfem_dmi_lumped_mass_value_count: mfem_operator
            .and_then(|problem| problem.dmi_lumped_mass)
            .map_or(0, |values| values.len() as u64),
        mfem_dmi_ms_field_value_count: mfem_operator
            .and_then(|problem| problem.dmi_ms_field)
            .map_or(0, |values| values.len() as u64),
        mfem_demag_tangent_matrix_value_count: mfem_operator
            .and_then(|problem| problem.demag_tangent_matrix_row_major)
            .map_or(0, |values| values.len() as u64),
        periodic_airbox_coupled_block_stiffness_matrix_value_count: periodic_airbox_coupled_block
            .map_or(0, |problem| problem.stiffness_matrix_row_major.len() as u64),
        periodic_airbox_coupled_block_mass_matrix_value_count: periodic_airbox_coupled_block
            .map_or(0, |problem| problem.mass_matrix_row_major.len() as u64),
        periodic_airbox_coupled_block_drive_real_value_count: periodic_airbox_coupled_block
            .map_or(0, |problem| problem.drive_real.len() as u64),
        periodic_airbox_coupled_block_drive_imag_value_count: periodic_airbox_coupled_block
            .and_then(|problem| problem.drive_imag)
            .map_or(0, |values| values.len() as u64),
    };
    let mfem_apply_demag_tangent_with_potential =
        mfem_operator.and_then(|problem| problem.apply_demag_tangent_with_potential);
    let mut ffi_result = NativeDrivenFrequencyResponseFfiResult::default();
    let rc = unsafe {
        if mfem_apply_demag_tangent_with_potential.is_some() {
            ffi::fullmag_fem_frequency_domain_solve_driven_response_v10(
                &ffi_request,
                mfem_apply_demag_tangent_with_potential,
                &mut ffi_result.inner,
            )
        } else {
            ffi::fullmag_fem_frequency_domain_solve_driven_response(
                &ffi_request,
                &mut ffi_result.inner,
            )
        }
    };
    if rc != ffi::FULLMAG_FEM_OK {
        return Err(format!(
            "native FEM frequency response solve failed before result ownership transfer (rc={rc})"
        ));
    }
    Ok(ffi_result.to_owned_result())
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
fn validate_floquet_pair_phase_metadata(
    k_vector_rad_per_m: Option<[f64; 3]>,
    pairs: &[NativeDrivenFrequencyResponseFloquetPeriodicPair<'_>],
) -> Result<(), String> {
    if pairs.is_empty() {
        return Ok(());
    }
    let Some(k_vector_rad_per_m) = k_vector_rad_per_m else {
        return Err("Floquet periodic pairs require a single k-vector".to_string());
    };
    if !k_vector_rad_per_m.iter().all(|value| value.is_finite()) {
        return Err("Floquet k-vector contains a non-finite value".to_string());
    }
    for pair in pairs {
        let pair_label = pair.pair_id.unwrap_or("<unnamed>");
        let Some(translation_m) = pair.translation_m else {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' requires a boundary translation"
            ));
        };
        if !translation_m.iter().all(|value| value.is_finite()) {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' contains a non-finite translation"
            ));
        }
        let Some(phase_rad) = pair.phase_rad else {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' requires phase_rad"
            ));
        };
        if !phase_rad.is_finite() {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' contains a non-finite phase"
            ));
        }
        let expected_phase_rad = -(k_vector_rad_per_m[0] * translation_m[0]
            + k_vector_rad_per_m[1] * translation_m[1]
            + k_vector_rad_per_m[2] * translation_m[2]);
        let residual_rad = canonical_phase_residual_rad(phase_rad - expected_phase_rad);
        if residual_rad.abs() > 1.0e-9 {
            return Err(format!(
                "Floquet phase metadata for pair '{pair_label}' is inconsistent with -k dot translation: expected phase_rad equivalent to {expected_phase_rad}, got {phase_rad}, residual {residual_rad}"
            ));
        }
    }
    Ok(())
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native", test))]
fn canonical_phase_residual_rad(phase_rad: f64) -> f64 {
    let two_pi = 2.0 * std::f64::consts::PI;
    let mut value = (phase_rad + std::f64::consts::PI).rem_euclid(two_pi) - std::f64::consts::PI;
    if value <= -std::f64::consts::PI {
        value += two_pi;
    }
    value
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn slice_ptr_or_null<T>(values: &[T]) -> *const T {
    if values.is_empty() {
        std::ptr::null()
    } else {
        values.as_ptr()
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn csr_matrix_view_or_zero(
    value: Option<&NativeModalEigenCsrMatrixView<'_>>,
) -> ffi::FullmagFemCsrMatrixView {
    value.map_or(
        ffi::FullmagFemCsrMatrixView {
            row_count: 0,
            column_count: 0,
            row_offsets: std::ptr::null(),
            row_offsets_len: 0,
            column_indices: std::ptr::null(),
            column_indices_len: 0,
            values: std::ptr::null(),
            values_len: 0,
        },
        |view| ffi::FullmagFemCsrMatrixView {
            row_count: view.row_count,
            column_count: view.column_count,
            row_offsets: slice_ptr_or_null(view.row_offsets),
            row_offsets_len: view.row_offsets.len() as u64,
            column_indices: slice_ptr_or_null(view.column_indices),
            column_indices_len: view.column_indices.len() as u64,
            values: slice_ptr_or_null(view.values),
            values_len: view.values.len() as u64,
        },
    )
}

#[cfg(not(feature = "fem-gpu"))]
fn solve_native_driven_frequency_response_impl(
    request: NativeDrivenFrequencyResponseRequest<'_>,
) -> Result<NativeDrivenFrequencyResponseResult, String> {
    let _ = request;
    Err("native FEM frequency response requires the fem-gpu feature".to_string())
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn solve_native_modal_eigen_impl(
    request: NativeModalEigenRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let mesh_asset_id = CString::new(request.mesh_asset_id.as_bytes())
        .map_err(|_| "native FEM modal_eigen mesh_asset_id contains NUL".to_string())?;
    let equilibrium_source_kind = CString::new(request.equilibrium_source_kind.as_bytes())
        .map_err(|_| "native FEM modal_eigen equilibrium_source_kind contains NUL".to_string())?;
    let damping_policy = CString::new(request.damping_policy.as_bytes())
        .map_err(|_| "native FEM modal_eigen damping_policy contains NUL".to_string())?;
    let spin_wave_bc_kind = CString::new(request.spin_wave_bc_kind.as_bytes())
        .map_err(|_| "native FEM modal_eigen spin_wave_bc_kind contains NUL".to_string())?;
    let target_kind = CString::new(request.target_kind.as_bytes())
        .map_err(|_| "native FEM modal_eigen target_kind contains NUL".to_string())?;
    let demag_realization = request
        .demag_realization
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen demag_realization contains NUL".to_string())?;
    let operator_diagnostics_json = request
        .operator_diagnostics_json
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen operator_diagnostics_json contains NUL".to_string())?;
    let output_directory = request
        .output_directory
        .map(|path| CString::new(path.to_string_lossy().as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen output_directory contains NUL".to_string())?;
    let cancel_callback = request.cancel_requested;
    let (cancel_requested, cancel_user_data) = if cancel_callback.is_some() {
        (
            Some(
                dispatch_native_frequency_domain_cancel as unsafe extern "C" fn(*mut c_void) -> i32,
            ),
            (&cancel_callback as *const Option<&NativeFrequencyDomainCancelCallback<'_>>)
                as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };
    let progress_callback = request.progress_callback;
    let (progress_callback_fn, progress_user_data) = if progress_callback.is_some() {
        (
            Some(
                dispatch_native_modal_eigen_progress_json
                    as unsafe extern "C" fn(*mut c_void, *const c_char),
            ),
            (&progress_callback as *const Option<&NativeModalEigenProgressCallback<'_>>)
                as *mut c_void,
        )
    } else {
        (None, std::ptr::null_mut())
    };
    let tiny_validation = request.tiny_validation_problem.as_ref();
    let mfem_operator = request.mfem_operator_problem.as_ref();
    // Keep the CString alive until the native modal FFI call returns below.
    let mfem_linearized_pencil_dependency_digest = mfem_operator
        .and_then(|problem| problem.linearized_pencil_dependency_digest)
        .map(CString::new)
        .transpose()
        .map_err(|_| "native FEM modal_eigen MFEM dependency digest contains NUL".to_string())?;
    let mfem_sparse_operator = request.mfem_sparse_operator_problem.as_ref();
    let poisson_airbox_block = request.poisson_airbox_block_problem.as_ref();
    let poisson_airbox_shift_invert_action =
        poisson_airbox_block.and_then(|problem| problem.shift_invert_action.as_ref());
    let poisson_airbox_periodic_mesh_certificate_schema = poisson_airbox_block
        .map(|problem| CString::new(problem.periodic_mesh_certificate_schema.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen Poisson-airbox certificate schema contains NUL".to_string()
        })?;
    let poisson_airbox_outer_boundary_kind = poisson_airbox_block
        .map(|problem| CString::new(problem.outer_boundary_kind.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen Poisson-airbox outer boundary kind contains NUL".to_string()
        })?;
    let poisson_airbox_gauge_policy = poisson_airbox_block
        .map(|problem| CString::new(problem.gauge_policy.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen Poisson-airbox gauge policy contains NUL".to_string()
        })?;
    let poisson_airbox_gauge_reason = poisson_airbox_block
        .map(|problem| CString::new(problem.gauge_reason.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen Poisson-airbox gauge reason contains NUL".to_string()
        })?;
    let poisson_airbox_assembly_kind = poisson_airbox_block
        .map(|problem| CString::new(problem.assembly_kind.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen Poisson-airbox assembly kind contains NUL".to_string()
        })?;
    let shared_domain = request.shared_domain_problem.as_ref();
    let shared_ffi_envelope = shared_domain
        .map(|problem| problem.ffi_envelope_contract_for_target(request.execution_target))
        .transpose()?;
    let shared_packed_mesh = shared_domain.map(|problem| {
        let mut packed = super::PackedNativeMesh::new(problem.mesh);
        packed.replace_cell_markers(problem.certificate_binding_v6.cell_markers());
        packed
    });
    let shared_mesh_descriptor = shared_domain
        .zip(shared_packed_mesh.as_ref())
        .map(|(problem, packed)| packed.descriptor(problem.mesh));
    let shared_boundary_kind = shared_domain
        .map(|problem| CString::new(problem.boundary_kind.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen shared-domain boundary kind contains NUL".to_string()
        })?;
    let shared_equilibrium_digest = shared_domain
        .map(|problem| CString::new(problem.equilibrium_digest.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen equilibrium digest contains NUL".to_string())?;
    let shared_mesh_certificate_digest = shared_domain
        .map(|problem| CString::new(problem.mesh_certificate_digest.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen mesh certificate digest contains NUL".to_string())?;
    let shared_mesh_certificate_schema = shared_domain
        .map(|problem| CString::new(problem.mesh_certificate_schema.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen mesh certificate schema contains NUL".to_string())?;
    let shared_mesh_certificate_map_binding_digest = shared_domain
        .map(|problem| CString::new(problem.mesh_certificate_map_binding_digest.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen mesh certificate map binding digest contains NUL".to_string()
        })?;
    let shared_linearization_state_digest = shared_domain
        .map(|problem| CString::new(problem.linearization_state_digest.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen linearization state digest contains NUL".to_string()
        })?;
    let shared_mesh_generation_identity = shared_domain
        .map(|problem| CString::new(problem.mesh_generation_identity.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen mesh generation identity contains NUL".to_string())?;
    let shared_canonical_preimage = shared_domain
        .map(|problem| CString::new(problem.canonical_preimage.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen canonical preimage contains NUL".to_string())?;
    let shared_canonical_preimage_sha256 = shared_domain
        .map(|problem| CString::new(problem.canonical_preimage_sha256.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen canonical preimage digest contains NUL".to_string())?;
    let shared_magnetic_class_digest_sha256 = shared_domain
        .map(|problem| CString::new(problem.magnetic_class_digest_sha256.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen magnetic class digest contains NUL".to_string())?;
    let shared_scalar_class_digest_sha256 = shared_domain
        .map(|problem| CString::new(problem.scalar_class_digest_sha256.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen scalar class digest contains NUL".to_string())?;
    let shared_certificate_binding_reason = shared_domain
        .map(|problem| CString::new(problem.certificate_binding_reason.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen certificate binding reason contains NUL".to_string()
        })?;
    let shared_boundary_gauge_digest = shared_domain
        .map(|problem| {
            CString::new(
                problem
                    .certificate_binding_v6
                    .boundary_gauge_digest
                    .as_bytes(),
            )
        })
        .transpose()
        .map_err(|_| "native FEM modal_eigen boundary gauge digest contains NUL".to_string())?;
    let shared_bias_field_sample_id = shared_domain
        .map(|problem| {
            CString::new(
                problem
                    .certificate_binding_v6
                    .bias_field_sample_id
                    .as_bytes(),
            )
        })
        .transpose()
        .map_err(|_| "native FEM modal_eigen bias field sample id contains NUL".to_string())?;
    let shared_bias_field_sample_signature = shared_domain
        .map(|problem| {
            CString::new(
                problem
                    .certificate_binding_v6
                    .bias_field_sample_signature
                    .as_bytes(),
            )
        })
        .transpose()
        .map_err(|_| "native FEM modal_eigen bias field signature contains NUL".to_string())?;
    let shared_magnetic_part_identity = shared_domain
        .map(|problem| {
            CString::new(
                problem
                    .certificate_binding_v6
                    .mesh_magnetic
                    .part_identity
                    .as_bytes(),
            )
        })
        .transpose()
        .map_err(|_| "native FEM modal_eigen magnetic part identity contains NUL".to_string())?;
    let shared_airbox_part_identity = shared_domain
        .map(|problem| {
            CString::new(
                problem
                    .certificate_binding_v6
                    .mesh_scalar
                    .part_identity
                    .as_bytes(),
            )
        })
        .transpose()
        .map_err(|_| "native FEM modal_eigen airbox part identity contains NUL".to_string())?;
    let shared_certificate_binding_ffi = shared_domain
        .map(|problem| NativeModalCertificateV6FfiBinding::new(&problem.certificate_binding_v6))
        .transpose()?;
    let shared_certificate_binding_request = shared_certificate_binding_ffi
        .as_ref()
        .map(NativeModalCertificateV6FfiBinding::as_request);
    let shared_equilibrium_id = shared_domain
        .map(|problem| CString::new(problem.equilibrium_id.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen equilibrium id contains NUL".to_string())?;
    let shared_mesh_snapshot_id = shared_domain
        .map(|problem| CString::new(problem.mesh_snapshot_id.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen mesh snapshot id contains NUL".to_string())?;
    let shared_material_snapshot_id = shared_domain
        .map(|problem| CString::new(problem.material_snapshot_id.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen material snapshot id contains NUL".to_string())?;
    let shared_physics_snapshot_id = shared_domain
        .map(|problem| CString::new(problem.physics_snapshot_id.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen physics snapshot id contains NUL".to_string())?;
    let shared_boundary_snapshot_id = shared_domain
        .map(|problem| CString::new(problem.boundary_snapshot_id.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen boundary snapshot id contains NUL".to_string())?;
    let shared_producer_run_id = shared_domain
        .map(|problem| CString::new(problem.producer_run_id.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen producer run id contains NUL".to_string())?;
    let shared_equilibrium_content_sha256 = shared_domain
        .map(|problem| CString::new(problem.equilibrium_content_sha256.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen equilibrium content hash contains NUL".to_string())?;
    let shared_demag_model = shared_domain
        .map(|problem| CString::new(problem.demag_model.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen demag model contains NUL".to_string())?;
    let shared_acceptance_criterion = shared_domain
        .map(|problem| CString::new(problem.acceptance_criterion.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen acceptance criterion contains NUL".to_string())?;
    let shared_acceptance_metric_kind = shared_domain
        .map(|problem| CString::new(problem.acceptance_metric_kind.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen acceptance metric contains NUL".to_string())?;
    let shared_acceptance_unit = shared_domain
        .map(|problem| CString::new(problem.acceptance_unit.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen acceptance unit contains NUL".to_string())?;
    let shared_acceptance_certificate_sha256 = shared_domain
        .map(|problem| CString::new(problem.acceptance_certificate_sha256.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM modal_eigen acceptance certificate digest contains NUL".to_string()
        })?;
    let shared_exchange_term_digest = shared_domain
        .and_then(|problem| problem.exchange_term_digest.as_deref())
        .map(CString::new)
        .transpose()
        .map_err(|_| "native FEM modal_eigen exchange term digest contains NUL".to_string())?;
    let shared_field_term_digest = shared_domain
        .and_then(|problem| problem.field_term_digest.as_deref())
        .map(CString::new)
        .transpose()
        .map_err(|_| "native FEM modal_eigen field term digest contains NUL".to_string())?;
    let shared_demag_term_digest = shared_domain
        .and_then(|problem| problem.demag_term_digest.as_deref())
        .map(CString::new)
        .transpose()
        .map_err(|_| "native FEM modal_eigen demag term digest contains NUL".to_string())?;
    let shared_operator_input_digest = shared_domain
        .map(|problem| CString::new(problem.operator_input_digest.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM modal_eigen operator input digest contains NUL".to_string())?;
    let shared_demag_provider_signature = shared_domain
        .and_then(|problem| problem.demag_provider_signature.as_deref())
        .map(CString::new)
        .transpose()
        .map_err(|_| "native FEM modal_eigen demag provider signature contains NUL".to_string())?;
    // All backing vectors and C strings are owned above this point and remain
    // alive until fullmag_fem_modal_eigen_solve() returns.
    let shared_linearization_descriptor =
        shared_domain
            .zip(shared_ffi_envelope.as_ref())
            .map(|(problem, envelope)| {
                debug_assert!(envelope.descriptor_required);
                ffi::FullmagFemModalLinearizationDescriptor {
                    abi_version: ffi::FULLMAG_FEM_MODAL_LINEARIZATION_DESCRIPTOR_V1_ABI_VERSION,
                    reserved0: 0,
                    struct_size: std::mem::size_of::<ffi::FullmagFemModalLinearizationDescriptor>()
                        as u64,
                    schema_version: c"modal_linearization_descriptor.v1".as_ptr(),
                    node_count: envelope.node_count,
                    tangent_dof_count: envelope.node_count * 2,
                    coordinate_unit: c"m".as_ptr(),
                    magnetisation_unit: c"A/m".as_ptr(),
                    time_unit: c"s".as_ptr(),
                    frequency_unit: c"Hz".as_ptr(),
                    angular_frequency_unit: c"rad/s".as_ptr(),
                    linearization_state_digest: shared_linearization_state_digest
                        .as_ref()
                        .expect("shared-domain state CString must exist")
                        .as_ptr(),
                    equilibrium_digest: shared_equilibrium_digest
                        .as_ref()
                        .expect("shared-domain equilibrium CString must exist")
                        .as_ptr(),
                    exchange_term_digest: optional_str_ptr(shared_exchange_term_digest.as_ref()),
                    field_term_digest: optional_str_ptr(shared_field_term_digest.as_ref()),
                    anisotropy_term_digest: std::ptr::null(),
                    dmi_term_digest: std::ptr::null(),
                    demag_term_digest: optional_str_ptr(shared_demag_term_digest.as_ref()),
                    operator_input_digest: shared_operator_input_digest
                        .as_ref()
                        .expect("shared-domain operator digest CString must exist")
                        .as_ptr(),
                    demag_provider_signature: optional_str_ptr(
                        shared_demag_provider_signature.as_ref(),
                    ),
                    term_presence_mask: envelope.term_presence_mask,
                    reserved_contract_flags: 0,
                    tangent_frame_xyz: problem.tangent_frame_xyz.as_ptr(),
                    tangent_frame_xyz_count: envelope.tangent_frame_count,
                    equilibrium_m0_xyz: problem.linearization_m0_xyz.as_ptr(),
                    equilibrium_m0_xyz_count: envelope.equilibrium_m0_count,
                    effective_field_h_eff0_xyz: problem.linearization_h_eff0_xyz.as_ptr(),
                    effective_field_h_eff0_xyz_count: envelope.effective_field_count,
                    external_field_h_ext0_xyz: problem.external_field_h_ext0_xyz.as_ptr(),
                    external_field_h_ext0_xyz_count: envelope.external_field_count,
                    alpha_per_node: problem.alpha_per_node.as_ptr(),
                    alpha_per_node_count: envelope.alpha_count,
                    uniaxial_axis_xyz: std::ptr::null(),
                    uniaxial_axis_xyz_count: 0,
                    uniaxial_anisotropy_field_a_per_m: std::ptr::null(),
                    uniaxial_anisotropy_field_count: 0,
                    saturation_magnetisation_a_per_m: if problem
                        .saturation_magnetisation_a_per_m
                        .is_empty()
                    {
                        std::ptr::null()
                    } else {
                        problem.saturation_magnetisation_a_per_m.as_ptr()
                    },
                    saturation_magnetisation_count: problem.saturation_magnetisation_a_per_m.len()
                        as u64,
                    uniform_saturation_magnetisation_a_per_m: problem
                        .uniform_saturation_magnetisation_a_per_m,
                    exchange_edges: std::ptr::null(),
                    exchange_edge_count: 0,
                    dmi_elements: std::ptr::null(),
                    dmi_element_count: 0,
                    dmi_lumped_mass: std::ptr::null(),
                    dmi_lumped_mass_count: 0,
                    dmi_ms_field: std::ptr::null(),
                    dmi_ms_field_count: 0,
                    dmi_uniform_ms: 0.0,
                }
            });
    let shared_exchange_material_view =
        shared_domain
            .zip(shared_ffi_envelope.as_ref())
            .and_then(|(problem, envelope)| {
                debug_assert_eq!(
                    envelope.exchange_material_view_present,
                    problem.exchange_stiffness_j_per_m.is_some()
                );
                problem.exchange_stiffness_j_per_m.map(|exchange_stiffness_j_per_m| {
            ffi::FullmagFemModalExchangeMaterialView {
                abi_version: ffi::FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_VIEW_V1_ABI_VERSION,
                reserved0: 0,
                struct_size: std::mem::size_of::<ffi::FullmagFemModalExchangeMaterialView>() as u64,
                schema_version: c"modal_exchange_material_view.v1".as_ptr(),
                material_kind: ffi::FULLMAG_FEM_MODAL_EXCHANGE_MATERIAL_KIND_AEX,
                reserved1: 0,
                exchange_stiffness_j_per_m,
            }
        })
            });
    let shared_payload = match (
        shared_domain,
        shared_mesh_descriptor.as_ref(),
        shared_boundary_kind.as_ref(),
        shared_equilibrium_digest.as_ref(),
        shared_mesh_certificate_digest.as_ref(),
        shared_mesh_certificate_schema.as_ref(),
        shared_mesh_certificate_map_binding_digest.as_ref(),
        shared_linearization_state_digest.as_ref(),
        shared_mesh_generation_identity.as_ref(),
        shared_canonical_preimage.as_ref(),
        shared_canonical_preimage_sha256.as_ref(),
        shared_magnetic_class_digest_sha256.as_ref(),
        shared_scalar_class_digest_sha256.as_ref(),
        shared_certificate_binding_reason.as_ref(),
        shared_boundary_gauge_digest.as_ref(),
        shared_bias_field_sample_id.as_ref(),
        shared_bias_field_sample_signature.as_ref(),
        shared_magnetic_part_identity.as_ref(),
        shared_airbox_part_identity.as_ref(),
        shared_certificate_binding_request.as_ref(),
        shared_equilibrium_id.as_ref(),
        shared_mesh_snapshot_id.as_ref(),
        shared_material_snapshot_id.as_ref(),
        shared_physics_snapshot_id.as_ref(),
        shared_boundary_snapshot_id.as_ref(),
        shared_producer_run_id.as_ref(),
        shared_equilibrium_content_sha256.as_ref(),
        shared_demag_model.as_ref(),
        shared_acceptance_criterion.as_ref(),
        shared_acceptance_metric_kind.as_ref(),
        shared_acceptance_unit.as_ref(),
        shared_acceptance_certificate_sha256.as_ref(),
    ) {
        (
            Some(problem),
            Some(mesh_descriptor),
            Some(boundary_kind),
            Some(equilibrium_digest),
            Some(mesh_certificate_digest),
            Some(mesh_certificate_schema),
            Some(mesh_certificate_map_binding_digest),
            Some(linearization_state_digest),
            Some(mesh_generation_identity),
            Some(canonical_preimage),
            Some(canonical_preimage_sha256),
            Some(magnetic_class_digest_sha256),
            Some(scalar_class_digest_sha256),
            Some(certificate_binding_reason),
            Some(boundary_gauge_digest),
            Some(bias_field_sample_id),
            Some(bias_field_sample_signature),
            Some(magnetic_part_identity),
            Some(airbox_part_identity),
            Some(certificate_binding_v6),
            Some(equilibrium_id),
            Some(mesh_snapshot_id),
            Some(material_snapshot_id),
            Some(physics_snapshot_id),
            Some(boundary_snapshot_id),
            Some(producer_run_id),
            Some(equilibrium_content_sha256),
            Some(demag_model),
            Some(acceptance_criterion),
            Some(acceptance_metric_kind),
            Some(acceptance_unit),
            Some(acceptance_certificate_sha256),
        ) => Some(
            problem.ffi_payload(
                mesh_descriptor,
                boundary_kind,
                equilibrium_digest,
                mesh_certificate_digest,
                mesh_certificate_schema,
                mesh_certificate_map_binding_digest,
                linearization_state_digest,
                mesh_generation_identity,
                canonical_preimage,
                canonical_preimage_sha256,
                magnetic_class_digest_sha256,
                scalar_class_digest_sha256,
                certificate_binding_reason,
                boundary_gauge_digest,
                bias_field_sample_id,
                bias_field_sample_signature,
                magnetic_part_identity,
                airbox_part_identity,
                certificate_binding_v6,
                equilibrium_id,
                mesh_snapshot_id,
                material_snapshot_id,
                physics_snapshot_id,
                boundary_snapshot_id,
                producer_run_id,
                equilibrium_content_sha256,
                demag_model,
                acceptance_criterion,
                acceptance_metric_kind,
                acceptance_unit,
                acceptance_certificate_sha256,
                shared_linearization_descriptor
                    .as_ref()
                    .expect("shared-domain descriptor must exist"),
                shared_exchange_material_view.as_ref(),
                shared_ffi_envelope
                    .as_ref()
                    .expect("shared-domain envelope must exist"),
            ),
        ),
        _ => None,
    };
    let floquet_k_vector_rad_per_m = request.k_vector_rad_m.and_then(|values| {
        if values.len() == 3 {
            Some([values[0], values[1], values[2]])
        } else {
            None
        }
    });
    let has_floquet_k_vector =
        request.spin_wave_bc_kind == "floquet" && floquet_k_vector_rad_per_m.is_some();
    let floquet_pair_ids = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .map(|pair| {
                    pair.pair_id
                        .map(|pair_id| {
                            CString::new(pair_id.as_bytes()).map_err(|_| {
                                "native FEM modal_eigen Floquet pair id contains NUL".to_string()
                            })
                        })
                        .transpose()
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let floquet_periodic_pairs = mfem_operator
        .map(|problem| {
            problem
                .floquet_periodic_pairs
                .iter()
                .zip(floquet_pair_ids.iter())
                .map(
                    |(pair, pair_id)| ffi::fullmag_fem_frequency_domain_floquet_periodic_pair {
                        pair_id: pair_id
                            .as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                        node_a: pair.node_a,
                        node_b: pair.node_b,
                        has_translation: pair.translation_m.is_some() as i32,
                        translation_m: pair.translation_m.unwrap_or([0.0; 3]),
                        has_phase: pair.phase_rad.is_some() as i32,
                        phase_rad: pair.phase_rad.unwrap_or(0.0),
                    },
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(problem) = mfem_operator {
        validate_floquet_pair_phase_metadata(
            floquet_k_vector_rad_per_m,
            problem.floquet_periodic_pairs,
        )?;
    }

    let ffi_request = ffi::FullmagFemModalEigenRequest {
        abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
        operator_request: ffi::FullmagFemLinearizedOperatorRequest {
            abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
            mesh_asset_id: mesh_asset_id.as_ptr(),
            equilibrium_source_kind: equilibrium_source_kind.as_ptr(),
            gamma_rad_s_T: request.gamma_rad_s_t,
            mu0_T_m_A: request.mu0_t_m_a,
            alpha: request.alpha,
            include_exchange: i32::from(request.include_exchange),
            include_demag: i32::from(request.include_demag),
            demag_realization: optional_str_ptr(demag_realization.as_ref()),
            damping_policy: damping_policy.as_ptr(),
            spin_wave_bc_kind: spin_wave_bc_kind.as_ptr(),
            k_vector_rad_m: request
                .k_vector_rad_m
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            k_vector_len: request
                .k_vector_rad_m
                .map_or(0, |values| values.len() as i32),
            operator_diagnostics_json: optional_str_ptr(operator_diagnostics_json.as_ref()),
        },
        requested_mode_count: request.requested_mode_count,
        target_kind: target_kind.as_ptr(),
        target_frequency_hz: request.target_frequency_hz,
        frequency_min_hz: request.frequency_min_hz,
        frequency_max_hz: request.frequency_max_hz,
        residual_tolerance: request.residual_tolerance,
        max_outer_iterations: request.max_outer_iterations,
        max_linear_iterations: request.max_linear_iterations,
        output_directory: optional_str_ptr(output_directory.as_ref()),
        write_partial_artifacts: i32::from(request.write_partial_artifacts),
        completeness_policy: request.completeness_policy,
        eigensolver_family: request.eigensolver_family,
        spectral_transform_kind: match request.spectral_transform_kind {
            0 => ffi::fullmag_fem_modal_spectral_transform_kind::
                FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO,
            1 => ffi::fullmag_fem_modal_spectral_transform_kind::
                FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_SHIFT_INVERT,
            other => {
                return Err(format!(
                    "native FEM modal_eigen request uses an unknown spectral transform kind: {other}"
                ));
            }
        },
        cancel_user_data,
        cancel_requested,
        progress_user_data,
        progress_callback: progress_callback_fn,
        tiny_validation_enabled: tiny_validation.is_some() as i32,
        tiny_validation_tangent_dof_count: tiny_validation
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        tiny_validation_stiffness_matrix_row_major: tiny_validation
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_matrix_row_major: tiny_validation
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_stiffness_diagonal: tiny_validation
            .and_then(|problem| problem.stiffness_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        tiny_validation_mass_diagonal: tiny_validation
            .and_then(|problem| problem.mass_diagonal)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_operator_enabled: mfem_operator.is_some() as i32,
        mfem_tangent_dof_count: mfem_operator
            .map(|problem| problem.tangent_dof_count)
            .unwrap_or(0),
        mfem_stiffness_matrix_row_major: mfem_operator
            .and_then(|problem| problem.stiffness_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_gyrotropic_matrix_row_major: mfem_operator
            .and_then(|problem| problem.gyrotropic_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_mass_matrix_row_major: mfem_operator
            .and_then(|problem| problem.mass_matrix_row_major)
            .map_or(std::ptr::null(), slice_ptr_or_null),
        mfem_linearized_pencil_dependency_digest: mfem_linearized_pencil_dependency_digest
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr()),
        mfem_linearized_pencil_gamma0_m_per_a_s: mfem_operator
            .map(|problem| problem.linearized_pencil_gamma0_m_per_a_s)
            .unwrap_or(0.0),
        mfem_sparse_operator_enabled: mfem_sparse_operator.is_some() as i32,
        mfem_sparse_stiffness_csr: csr_matrix_view_or_zero(
            mfem_sparse_operator.map(|problem| &problem.stiffness_csr),
        ),
        mfem_sparse_gyrotropic_csr: csr_matrix_view_or_zero(
            mfem_sparse_operator.map(|problem| &problem.gyrotropic_csr),
        ),
        mfem_sparse_mass_csr: csr_matrix_view_or_zero(
            mfem_sparse_operator.map(|problem| &problem.mass_csr),
        ),
        has_floquet_k_vector: i32::from(has_floquet_k_vector),
        floquet_k_vector_rad_per_m: floquet_k_vector_rad_per_m.unwrap_or([0.0; 3]),
        phase_convention: map_phase_convention(
            mfem_operator
                .map(|problem| problem.phase_convention)
                .unwrap_or(FrequencyDomainPhaseConvention::ExpIOmegaT),
        ),
        mfem_floquet_periodic_pairs: if floquet_periodic_pairs.is_empty() {
            std::ptr::null()
        } else {
            floquet_periodic_pairs.as_ptr()
        },
        mfem_floquet_periodic_pair_count: floquet_periodic_pairs.len() as u64,
        poisson_airbox_block_enabled: poisson_airbox_block.is_some() as i32,
        poisson_airbox_q_dof_count: poisson_airbox_block
            .map(|problem| problem.q_dof_count)
            .unwrap_or(0),
        poisson_airbox_phi_dof_count: poisson_airbox_block
            .map(|problem| problem.phi_dof_count)
            .unwrap_or(0),
        poisson_airbox_a_qq_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_qq_csr),
        ),
        poisson_airbox_a_qphi_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_qphi_csr),
        ),
        poisson_airbox_a_phiq_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_phiq_csr),
        ),
        poisson_airbox_a_phiphi_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.a_phiphi_csr),
        ),
        poisson_airbox_b_qq_csr: csr_matrix_view_or_zero(
            poisson_airbox_block.map(|problem| &problem.b_qq_csr),
        ),
        poisson_airbox_phi_mean_weights: poisson_airbox_block
            .map(|problem| slice_ptr_or_null(problem.phi_mean_weights))
            .unwrap_or(std::ptr::null()),
        poisson_airbox_phi_mean_weights_count: poisson_airbox_block
            .map(|problem| problem.phi_mean_weights.len() as u64)
            .unwrap_or(0),
        poisson_airbox_target_frequency_hz: poisson_airbox_block
            .map(|problem| problem.target_frequency_hz)
            .unwrap_or(0.0),
        poisson_airbox_expected_reference_frequency_hz: poisson_airbox_block
            .map(|problem| problem.expected_reference_frequency_hz)
            .unwrap_or(0.0),
        poisson_airbox_periodic_mesh_certificate_schema:
            poisson_airbox_periodic_mesh_certificate_schema
                .as_ref()
                .map(|value| value.as_ptr())
                .unwrap_or(std::ptr::null()),
        poisson_airbox_magnetic_pair_count: poisson_airbox_block
            .map(|problem| problem.magnetic_pair_count)
            .unwrap_or(0),
        poisson_airbox_airbox_pair_count: poisson_airbox_block
            .map(|problem| problem.airbox_pair_count)
            .unwrap_or(0),
        poisson_airbox_shift_invert_action_enabled: poisson_airbox_shift_invert_action.is_some()
            as i32,
        poisson_airbox_shift_invert_action_device: poisson_airbox_shift_invert_action
            .map(|action| i32::from(action.use_gpu_hidden_action))
            .unwrap_or(0),
        poisson_airbox_shift_sigma_real: poisson_airbox_shift_invert_action
            .map(|action| action.sigma_real)
            .unwrap_or(0.0),
        poisson_airbox_shift_sigma_imag: poisson_airbox_shift_invert_action
            .map(|action| action.sigma_imag)
            .unwrap_or(0.0),
        poisson_airbox_shift_action_vector_real: poisson_airbox_shift_invert_action
            .map(|action| slice_ptr_or_null(action.vector_real))
            .unwrap_or(std::ptr::null()),
        poisson_airbox_shift_action_vector_imag: poisson_airbox_shift_invert_action
            .and_then(|action| action.vector_imag.map(slice_ptr_or_null))
            .unwrap_or(std::ptr::null()),
        poisson_airbox_shift_action_vector_count: poisson_airbox_shift_invert_action
            .map(|action| action.vector_real.len() as u64)
            .unwrap_or(0),
        poisson_airbox_outer_boundary_kind: poisson_airbox_outer_boundary_kind
            .as_ref()
            .map(|value| value.as_ptr())
            .unwrap_or(std::ptr::null()),
        poisson_airbox_robin_beta: poisson_airbox_block
            .map(|problem| problem.robin_beta)
            .unwrap_or(0.0),
        poisson_airbox_gauge_policy: poisson_airbox_gauge_policy
            .as_ref()
            .map(|value| value.as_ptr())
            .unwrap_or(std::ptr::null()),
        poisson_airbox_gauge_reason: poisson_airbox_gauge_reason
            .as_ref()
            .map(|value| value.as_ptr())
            .unwrap_or(std::ptr::null()),
        poisson_airbox_assembly_kind: poisson_airbox_assembly_kind
            .as_ref()
            .map(|value| value.as_ptr())
            .unwrap_or(std::ptr::null()),
        dynamic_demag_k_tangent_matrix_row_major: std::ptr::null(),
        dynamic_demag_k_tangent_matrix_value_count: 0,
        struct_size: std::mem::size_of::<ffi::FullmagFemModalEigenRequest>() as u64,
        execution_target: match request.execution_target {
            NativeModalExecutionTarget::Auto => {
                ffi::fullmag_fem_modal_execution_target::FULLMAG_FEM_MODAL_EXECUTION_AUTO
            }
            NativeModalExecutionTarget::ProductionCpu => {
                ffi::fullmag_fem_modal_execution_target::FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_CPU
            }
            NativeModalExecutionTarget::ProductionGpu => {
                ffi::fullmag_fem_modal_execution_target::FULLMAG_FEM_MODAL_EXECUTION_PRODUCTION_GPU
            }
        },
        scalar_representation:
            ffi::fullmag_fem_modal_scalar_representation::FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE,
        result_field_representation:
            ffi::fullmag_fem_modal_result_field_representation::FULLMAG_FEM_MODAL_RESULT_TANGENT_Q,
        reserved_modal_contract_flags: 0,
        shared_domain_payload: shared_payload
            .as_ref()
            .map_or(std::ptr::null(), |value| value as *const _),
        mesh_generation_identity: shared_mesh_generation_identity
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr()),
        canonical_preimage_sha256: shared_canonical_preimage_sha256
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr()),
    };

    let (mut ffi_result, modal_gpu_attestation) = if request.execution_target
        == NativeModalExecutionTarget::ProductionGpu
    {
        let mut result_v20 = ffi::FullmagFemFrequencyDomainResultV20 {
            abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V20_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::FullmagFemFrequencyDomainResultV20>() as u32,
            scientific_result_v18: NativeFrequencyDomainContractFfiResult::default().inner,
            gpu_attestation: std::ptr::null_mut(),
        };
        let status =
            unsafe { ffi::fullmag_fem_modal_eigen_solve_v20(&ffi_request, &mut result_v20) };
        if status != 0 {
            unsafe { ffi::fullmag_fem_frequency_domain_result_v20_destroy(&mut result_v20) };
            return Err(format!(
                "native FEM modal_eigen v20 boundary rejected caller envelope with status {status}"
            ));
        }
        let attestation = match unsafe {
            validate_modal_gpu_attestation_v1(result_v20.gpu_attestation)
        } {
            Ok(attestation) => attestation,
            Err(error) => {
                unsafe { ffi::fullmag_fem_frequency_domain_result_v20_destroy(&mut result_v20) };
                return Err(error);
            }
        };
        let inner = result_v20.scientific_result_v18;
        result_v20.scientific_result_v18 = NativeFrequencyDomainContractFfiResult::default().inner;
        unsafe { ffi::fullmag_fem_frequency_domain_result_v20_destroy(&mut result_v20) };
        (
            NativeFrequencyDomainContractFfiResult { inner },
            Some(attestation),
        )
    } else {
        (
            NativeFrequencyDomainContractFfiResult {
                inner: unsafe { ffi::fullmag_fem_modal_eigen_solve(&ffi_request) },
            },
            None,
        )
    };
    let mut owned = ffi_result.to_owned_result();
    owned.modal_gpu_attestation = modal_gpu_attestation;
    if request.execution_target == NativeModalExecutionTarget::ProductionGpu
        && owned.resolved_fallback_state != MODAL_GPU_FALLBACK_NONE
    {
        return Err("k0_poisson_airbox_gpu_attestation_fallback_forbidden".to_string());
    }
    if ffi_result.inner.error_message.is_null() {
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    } else {
        ffi_result.inner.error_message = std::ptr::null_mut();
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    }
    Ok(owned)
}

#[cfg(feature = "fem-gpu")]
fn solve_native_driven_response_contract_impl(
    request: NativeDrivenResponseContractRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let mesh_asset_id = CString::new(request.mesh_asset_id.as_bytes())
        .map_err(|_| "native FEM driven_response mesh_asset_id contains NUL".to_string())?;
    let equilibrium_source_kind = CString::new(request.equilibrium_source_kind.as_bytes())
        .map_err(|_| {
            "native FEM driven_response equilibrium_source_kind contains NUL".to_string()
        })?;
    let damping_policy = CString::new(request.damping_policy.as_bytes())
        .map_err(|_| "native FEM driven_response damping_policy contains NUL".to_string())?;
    let spin_wave_bc_kind = CString::new(request.spin_wave_bc_kind.as_bytes())
        .map_err(|_| "native FEM driven_response spin_wave_bc_kind contains NUL".to_string())?;
    let demag_realization = request
        .demag_realization
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| "native FEM driven_response demag_realization contains NUL".to_string())?;
    let operator_diagnostics_json = request
        .operator_diagnostics_json
        .map(|value| CString::new(value.as_bytes()))
        .transpose()
        .map_err(|_| {
            "native FEM driven_response operator_diagnostics_json contains NUL".to_string()
        })?;
    let output_directory = request
        .output_directory
        .map(|path| CString::new(path.to_string_lossy().as_bytes()))
        .transpose()
        .map_err(|_| "native FEM driven_response output_directory contains NUL".to_string())?;

    let ffi_request = ffi::FullmagFemDrivenResponseRequest {
        abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
        operator_request: ffi::FullmagFemLinearizedOperatorRequest {
            abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
            mesh_asset_id: mesh_asset_id.as_ptr(),
            equilibrium_source_kind: equilibrium_source_kind.as_ptr(),
            gamma_rad_s_T: request.gamma_rad_s_t,
            mu0_T_m_A: request.mu0_t_m_a,
            alpha: request.alpha,
            include_exchange: i32::from(request.include_exchange),
            include_demag: i32::from(request.include_demag),
            demag_realization: optional_str_ptr(demag_realization.as_ref()),
            damping_policy: damping_policy.as_ptr(),
            spin_wave_bc_kind: spin_wave_bc_kind.as_ptr(),
            k_vector_rad_m: request
                .k_vector_rad_m
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            k_vector_len: request
                .k_vector_rad_m
                .map_or(0, |values| values.len() as i32),
            operator_diagnostics_json: optional_str_ptr(operator_diagnostics_json.as_ref()),
        },
        frequencies_hz: request.frequencies_hz.as_ptr(),
        frequency_count: request.frequencies_hz.len() as i32,
        excitation_field_A_m: request.excitation_field_a_m.as_ptr(),
        excitation_field_len: request.excitation_field_a_m.len() as i32,
        excitation_phase_rad: request.excitation_phase_rad,
        residual_tolerance: request.residual_tolerance,
        max_linear_iterations: request.max_linear_iterations,
        output_directory: optional_str_ptr(output_directory.as_ref()),
        write_partial_artifacts: i32::from(request.write_partial_artifacts),
        cancel_user_data: std::ptr::null_mut(),
        cancel_requested: None,
        progress_user_data: std::ptr::null_mut(),
        progress_callback: None,
    };

    let mut ffi_result = NativeFrequencyDomainContractFfiResult {
        inner: unsafe { ffi::fullmag_fem_driven_response_solve(&ffi_request) },
    };
    let owned = ffi_result.to_owned_result();
    if ffi_result.inner.error_message.is_null() {
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    } else {
        ffi_result.inner.error_message = std::ptr::null_mut();
        ffi_result.inner.diagnostics_json = std::ptr::null_mut();
        ffi_result.inner.result_json = std::ptr::null_mut();
        ffi_result.inner.artifact_manifest_path = std::ptr::null_mut();
    }
    Ok(owned)
}

#[cfg(not(any(feature = "fem-gpu", feature = "fem-native")))]
fn solve_native_modal_eigen_impl(
    request: NativeModalEigenRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let _ = request;
    Err("native FEM modal eigen solve requires the fem-native feature".to_string())
}

#[cfg(not(feature = "fem-gpu"))]
fn solve_native_driven_response_contract_impl(
    request: NativeDrivenResponseContractRequest<'_>,
) -> Result<NativeFrequencyDomainContractResult, String> {
    let _ = request;
    Err("native FEM driven response solve requires the fem-gpu feature".to_string())
}

#[cfg(feature = "fem-gpu")]
fn map_dmi_kind(
    kind: NativeDrivenFrequencyResponseDmiKind,
) -> ffi::fullmag_fem_frequency_domain_dmi_kind {
    match kind {
        NativeDrivenFrequencyResponseDmiKind::Interfacial => {
            ffi::fullmag_fem_frequency_domain_dmi_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_INTERFACIAL
        }
        NativeDrivenFrequencyResponseDmiKind::Bulk => {
            ffi::fullmag_fem_frequency_domain_dmi_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn optional_str_ptr(value: Option<&CString>) -> *const std::os::raw::c_char {
    value.map_or(std::ptr::null(), |value| value.as_ptr())
}

#[cfg(feature = "fem-gpu")]
fn map_execution_lane(
    execution_lane: NativeFrequencyDomainExecutionLane,
) -> ffi::fullmag_fem_frequency_domain_execution_lane {
    match execution_lane {
        NativeFrequencyDomainExecutionLane::Validation => {
            ffi::fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION
        }
        NativeFrequencyDomainExecutionLane::ProductionCpu => {
            ffi::fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU
        }
        NativeFrequencyDomainExecutionLane::ProductionGpu => {
            ffi::fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn map_phase_convention(
    phase_convention: FrequencyDomainPhaseConvention,
) -> ffi::fullmag_fem_frequency_domain_phase_convention {
    match phase_convention {
        FrequencyDomainPhaseConvention::ExpIOmegaT => {
            ffi::fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
        }
        FrequencyDomainPhaseConvention::ExpMinusIOmegaT => {
            ffi::fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T
        }
    }
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn poll_atomic_interrupt_flag(user_data: *mut c_void) -> i32 {
    let flag = user_data.cast::<AtomicBool>();
    if flag.is_null() {
        return 0;
    }
    if unsafe { (*flag).load(std::sync::atomic::Ordering::Relaxed) } {
        1
    } else {
        0
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
unsafe extern "C" fn dispatch_native_frequency_domain_cancel(user_data: *mut c_void) -> i32 {
    if user_data.is_null() {
        return 0;
    }
    let callback =
        unsafe { &*user_data.cast::<Option<&NativeFrequencyDomainCancelCallback<'_>>>() };
    if callback.is_some_and(|callback| callback()) {
        1
    } else {
        0
    }
}

#[cfg(feature = "fem-gpu")]
unsafe extern "C" fn dispatch_native_frequency_domain_progress(
    user_data: *mut c_void,
    progress: *const ffi::fullmag_fem_frequency_domain_progress,
) {
    if user_data.is_null() || progress.is_null() {
        return;
    }
    let callback =
        unsafe { &*user_data.cast::<Option<&NativeFrequencyDomainProgressCallback<'_>>>() };
    if let Some(callback) = callback {
        let progress = unsafe { *progress };
        callback(NativeFrequencyDomainProgress {
            frequency_index: progress.frequency_index,
            completed_frequency_count: progress.completed_frequency_count,
            total_frequency_count: progress.total_frequency_count,
            iteration_count: progress.iteration_count,
            frequency_hz: progress.frequency_hz,
            residual_l2_norm: progress.residual_l2_norm,
            relative_residual_l2_norm: progress.relative_residual_l2_norm,
            converged: progress.converged != 0,
        });
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
unsafe extern "C" fn dispatch_native_modal_eigen_progress_json(
    user_data: *mut c_void,
    progress_json: *const c_char,
) {
    if user_data.is_null() || progress_json.is_null() {
        return;
    }
    let callback = unsafe { &*user_data.cast::<Option<&NativeModalEigenProgressCallback<'_>>>() };
    if let Some(callback) = callback {
        let progress_json = unsafe { CStr::from_ptr(progress_json) }.to_string_lossy();
        callback(progress_json.as_ref());
    }
}

#[cfg(feature = "fem-gpu")]
struct NativeDrivenFrequencyResponseFfiResult {
    inner: ffi::fullmag_fem_frequency_domain_solve_result,
}

#[cfg(feature = "fem-gpu")]
impl Default for NativeDrivenFrequencyResponseFfiResult {
    fn default() -> Self {
        Self {
            inner: ffi::fullmag_fem_frequency_domain_solve_result {
                status:
                    ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK,
                total_frequency_count: 0,
                completed_frequency_count: 0,
                written_frequency_point_artifacts: 0,
                error_message: std::ptr::null_mut(),
                diagnostics_json: std::ptr::null_mut(),
                result_json: std::ptr::null_mut(),
                artifact_manifest_path: std::ptr::null_mut(),
            },
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeDrivenFrequencyResponseFfiResult {
    fn to_owned_result(&self) -> NativeDrivenFrequencyResponseResult {
        NativeDrivenFrequencyResponseResult {
            status: map_status(self.inner.status),
            total_frequency_count: self.inner.total_frequency_count,
            completed_frequency_count: self.inner.completed_frequency_count,
            written_frequency_point_artifacts: self.inner.written_frequency_point_artifacts,
            error_message: ffi_string(self.inner.error_message),
            diagnostics_json: ffi_string(self.inner.diagnostics_json),
            result_json: ffi_string(self.inner.result_json),
            artifact_manifest_path: ffi_string(self.inner.artifact_manifest_path),
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeDrivenFrequencyResponseFfiResult {
    fn drop(&mut self) {
        unsafe {
            ffi::fullmag_fem_frequency_domain_solve_result_release(&mut self.inner);
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
struct NativeFrequencyDomainContractFfiResult {
    inner: ffi::FullmagFemFrequencyDomainResult,
}

const MODAL_GPU_MEASUREMENT_MEASURED: u32 = 1;
const MODAL_GPU_MEASUREMENT_UNAVAILABLE: u32 = 2;
const MODAL_GPU_MEASUREMENT_FAILED: u32 = 3;
const MODAL_GPU_FALLBACK_NONE: u32 = 1;
const MODAL_GPU_OPERATOR_MATRIX_FREE_SCHUR_CUDA: u32 = 1;
const MODAL_GPU_HYPRE_MEMORY_DEVICE: u32 = 2;
const MODAL_GPU_HYPRE_EXECUTION_DEVICE: u32 = 2;
const MODAL_GPU_COVERAGE_SETUP: u64 = 1;
const MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP: u64 = 2;
const MODAL_GPU_COVERAGE_OBJECT_GRAPH: u64 = 4;
const MODAL_GPU_COVERAGE_SCALAR_TELEMETRY: u64 = 8;
const MODAL_GPU_COVERAGE_EXPORT: u64 = 16;
const MODAL_GPU_REQUIRED_COVERAGE: u64 = MODAL_GPU_COVERAGE_SETUP
    | MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP
    | MODAL_GPU_COVERAGE_OBJECT_GRAPH
    | MODAL_GPU_COVERAGE_SCALAR_TELEMETRY
    | MODAL_GPU_COVERAGE_EXPORT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeModalGpuMeasurementState {
    Measured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeModalGpuFallbackState {
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeModalGpuOperatorKind {
    MatrixFreeSchurCuda,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeModalGpuHypreMemoryLocation {
    Device,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeModalGpuHypreExecutionPolicy {
    Device,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeModalGpuAttestation {
    pub(crate) measurement_state: NativeModalGpuMeasurementState,
    pub(crate) measurement_coverage_flags: u64,
    pub(crate) device_residency_verified: bool,
    pub(crate) production_shared_domain: bool,
    pub(crate) validation_only: bool,
    pub(crate) fallback_state: NativeModalGpuFallbackState,
    pub(crate) operator_kind: NativeModalGpuOperatorKind,
    pub(crate) hypre_memory_location: NativeModalGpuHypreMemoryLocation,
    pub(crate) hypre_execution_policy: NativeModalGpuHypreExecutionPolicy,
    pub(crate) compute_capability_major: u32,
    pub(crate) compute_capability_minor: u32,
    pub(crate) cuda_driver_version: u32,
    pub(crate) cuda_runtime_version: u32,
    pub(crate) device_name: String,
    pub(crate) mfem_version: String,
    pub(crate) hypre_version: String,
    pub(crate) petsc_version: String,
    pub(crate) slepc_version: String,
    pub(crate) petsc_vec_type: String,
    pub(crate) petsc_matrix_type: String,
    pub(crate) matshell_vec_type: String,
    pub(crate) slepc_bv_type: String,
    pub(crate) eps_type: String,
    pub(crate) st_type: String,
    pub(crate) ksp_type: String,
    pub(crate) poisson_pc_type: String,
    pub(crate) shift_pc_type: String,
    pub(crate) last_invalidation_reason: String,
    pub(crate) device_uuid: [u8; 16],
    pub(crate) object_graph_sha256: [u8; 32],
    pub(crate) native_trace_sha256: [u8; 32],
    pub(crate) source_snapshot_sha256: [u8; 32],
    pub(crate) runtime_manifest_sha256: [u8; 32],
    pub(crate) mesh_identity_sha256: [u8; 32],
    pub(crate) equilibrium_sha256: [u8; 32],
    pub(crate) certificate_sha256: [u8; 32],
    pub(crate) linearization_sha256: [u8; 32],
    pub(crate) material_sha256: [u8; 32],
    pub(crate) physics_sha256: [u8; 32],
    pub(crate) boundary_sha256: [u8; 32],
    pub(crate) gauge_sha256: [u8; 32],
    pub(crate) operator_terms_sha256: [u8; 32],
    pub(crate) solver_policy_sha256: [u8; 32],
    pub(crate) operator_key_sha256: [u8; 32],
    pub(crate) target_key_sha256: [u8; 32],
    pub(crate) session_context_sha256: [u8; 32],
    pub(crate) setup_h2d_count: u64,
    pub(crate) setup_h2d_bytes: u64,
    pub(crate) hot_loop_computational_h2d_count: u64,
    pub(crate) hot_loop_computational_h2d_bytes: u64,
    pub(crate) hot_loop_computational_d2h_count: u64,
    pub(crate) hot_loop_computational_d2h_bytes: u64,
    pub(crate) hot_loop_scalar_telemetry_d2h_count: u64,
    pub(crate) hot_loop_scalar_telemetry_d2h_bytes: u64,
    pub(crate) hot_loop_full_vector_crossings: u64,
    pub(crate) hot_loop_computational_host_syncs: u64,
    pub(crate) hot_loop_scalar_telemetry_syncs: u64,
    pub(crate) hot_loop_allocations: u64,
    pub(crate) export_d2h_count: u64,
    pub(crate) export_d2h_bytes: u64,
    pub(crate) device_memory_baseline_bytes: u64,
    pub(crate) device_memory_peak_bytes: u64,
    pub(crate) device_memory_final_bytes: u64,
    pub(crate) operator_dimension: u64,
    pub(crate) operator_apply_count: u64,
    pub(crate) poisson_solve_count: u64,
    pub(crate) poisson_iteration_count: u64,
    pub(crate) eps_iteration_count: u64,
    pub(crate) eps_restart_count: u64,
    pub(crate) eps_converged_reason: i64,
    pub(crate) operator_state_generation: u64,
    pub(crate) target_state_generation: u64,
    pub(crate) operator_reuse_count: u64,
    pub(crate) target_rebuild_count: u64,
    pub(crate) invalidation_flags: u64,
}

#[derive(Debug, Clone)]
struct NativeModalGpuAttestationSnapshot {
    measurement_state: u32,
    fallback_state: u32,
    measurement_coverage_flags: u64,
    device_residency_verified: u32,
    production_shared_domain: u32,
    validation_only: u32,
    operator_kind: u32,
    hypre_memory_location: u32,
    hypre_execution_policy: u32,
    compute_capability_major: u32,
    compute_capability_minor: u32,
    cuda_driver_version: u32,
    cuda_runtime_version: u32,
    device_name: String,
    mfem_version: String,
    hypre_version: String,
    petsc_version: String,
    slepc_version: String,
    petsc_vec_type: String,
    petsc_matrix_type: String,
    matshell_vec_type: String,
    slepc_bv_type: String,
    eps_type: String,
    st_type: String,
    ksp_type: String,
    poisson_pc_type: String,
    shift_pc_type: String,
    last_invalidation_reason: String,
    device_uuid: [u8; 16],
    object_graph_sha256: [u8; 32],
    native_trace_sha256: [u8; 32],
    source_snapshot_sha256: [u8; 32],
    runtime_manifest_sha256: [u8; 32],
    mesh_identity_sha256: [u8; 32],
    equilibrium_sha256: [u8; 32],
    certificate_sha256: [u8; 32],
    linearization_sha256: [u8; 32],
    material_sha256: [u8; 32],
    physics_sha256: [u8; 32],
    boundary_sha256: [u8; 32],
    gauge_sha256: [u8; 32],
    operator_terms_sha256: [u8; 32],
    solver_policy_sha256: [u8; 32],
    operator_key_sha256: [u8; 32],
    target_key_sha256: [u8; 32],
    session_context_sha256: [u8; 32],
    setup_h2d_count: u64,
    setup_h2d_bytes: u64,
    hot_loop_computational_h2d_count: u64,
    hot_loop_computational_h2d_bytes: u64,
    hot_loop_computational_d2h_count: u64,
    hot_loop_computational_d2h_bytes: u64,
    hot_loop_scalar_telemetry_d2h_count: u64,
    hot_loop_scalar_telemetry_d2h_bytes: u64,
    hot_loop_full_vector_crossings: u64,
    hot_loop_computational_host_syncs: u64,
    hot_loop_scalar_telemetry_syncs: u64,
    hot_loop_allocations: u64,
    export_d2h_count: u64,
    export_d2h_bytes: u64,
    device_memory_baseline_bytes: u64,
    device_memory_peak_bytes: u64,
    device_memory_final_bytes: u64,
    operator_dimension: u64,
    operator_apply_count: u64,
    poisson_solve_count: u64,
    poisson_iteration_count: u64,
    eps_iteration_count: u64,
    eps_restart_count: u64,
    eps_converged_reason: i64,
    operator_state_generation: u64,
    target_state_generation: u64,
    operator_reuse_count: u64,
    target_rebuild_count: u64,
    invalidation_flags: u64,
}

fn digest_is_missing(digest: &[u8; 32]) -> bool {
    digest.iter().all(|byte| *byte == 0)
}

fn prefixed_hex(bytes: &[u8]) -> String {
    let mut value = String::with_capacity(7 + bytes.len() * 2);
    value.push_str("sha256:");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    value
}

impl NativeModalGpuAttestation {
    pub(crate) fn artifact_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema_version": "fem_modal_gpu_attestation.v1",
            "measurement_state": "measured",
            "measurement_coverage_flags": self.measurement_coverage_flags,
            "device_residency_verified": self.device_residency_verified,
            "production_shared_domain": self.production_shared_domain,
            "validation_only": self.validation_only,
            "fallback_state": "none",
            "operator_kind": "matrix_free_schur_cuda",
            "hypre_memory_location": "device",
            "hypre_execution_policy": "device",
            "device": {
                "uuid": prefixed_hex(&self.device_uuid),
                "name": self.device_name,
                "compute_capability_major": self.compute_capability_major,
                "compute_capability_minor": self.compute_capability_minor,
                "cuda_driver_version": self.cuda_driver_version,
                "cuda_runtime_version": self.cuda_runtime_version,
            },
            "runtime": {
                "mfem_version": self.mfem_version,
                "hypre_version": self.hypre_version,
                "petsc_version": self.petsc_version,
                "slepc_version": self.slepc_version,
            },
            "object_graph": {
                "petsc_vec_type": self.petsc_vec_type,
                "petsc_matrix_type": self.petsc_matrix_type,
                "matshell_vec_type": self.matshell_vec_type,
                "slepc_bv_type": self.slepc_bv_type,
                "eps_type": self.eps_type,
                "st_type": self.st_type,
                "ksp_type": self.ksp_type,
                "poisson_pc_type": self.poisson_pc_type,
                "shift_pc_type": self.shift_pc_type,
                "sha256": prefixed_hex(&self.object_graph_sha256),
            },
            "bindings": {
                "native_trace_sha256": prefixed_hex(&self.native_trace_sha256),
                "source_snapshot_sha256": prefixed_hex(&self.source_snapshot_sha256),
                "runtime_manifest_sha256": prefixed_hex(&self.runtime_manifest_sha256),
                "mesh_identity_sha256": prefixed_hex(&self.mesh_identity_sha256),
                "equilibrium_sha256": prefixed_hex(&self.equilibrium_sha256),
                "certificate_sha256": prefixed_hex(&self.certificate_sha256),
                "linearization_sha256": prefixed_hex(&self.linearization_sha256),
                "material_sha256": prefixed_hex(&self.material_sha256),
                "physics_sha256": prefixed_hex(&self.physics_sha256),
                "boundary_sha256": prefixed_hex(&self.boundary_sha256),
                "gauge_sha256": prefixed_hex(&self.gauge_sha256),
                "operator_terms_sha256": prefixed_hex(&self.operator_terms_sha256),
                "solver_policy_sha256": prefixed_hex(&self.solver_policy_sha256),
                "operator_key_sha256": prefixed_hex(&self.operator_key_sha256),
                "target_key_sha256": prefixed_hex(&self.target_key_sha256),
                "session_context_sha256": prefixed_hex(&self.session_context_sha256),
            },
            "transfers": {
                "setup_h2d_count": self.setup_h2d_count,
                "setup_h2d_bytes": self.setup_h2d_bytes,
                "hot_loop_computational_h2d_count": self.hot_loop_computational_h2d_count,
                "hot_loop_computational_h2d_bytes": self.hot_loop_computational_h2d_bytes,
                "hot_loop_computational_d2h_count": self.hot_loop_computational_d2h_count,
                "hot_loop_computational_d2h_bytes": self.hot_loop_computational_d2h_bytes,
                "hot_loop_scalar_telemetry_d2h_count": self.hot_loop_scalar_telemetry_d2h_count,
                "hot_loop_scalar_telemetry_d2h_bytes": self.hot_loop_scalar_telemetry_d2h_bytes,
                "hot_loop_full_vector_crossings": self.hot_loop_full_vector_crossings,
                "hot_loop_computational_host_syncs": self.hot_loop_computational_host_syncs,
                "hot_loop_scalar_telemetry_syncs": self.hot_loop_scalar_telemetry_syncs,
                "hot_loop_allocations": self.hot_loop_allocations,
                "export_d2h_count": self.export_d2h_count,
                "export_d2h_bytes": self.export_d2h_bytes,
            },
            "memory": {
                "device_baseline_bytes": self.device_memory_baseline_bytes,
                "device_peak_bytes": self.device_memory_peak_bytes,
                "device_final_bytes": self.device_memory_final_bytes,
            },
            "solver": {
                "operator_dimension": self.operator_dimension,
                "operator_apply_count": self.operator_apply_count,
                "poisson_solve_count": self.poisson_solve_count,
                "poisson_iteration_count": self.poisson_iteration_count,
                "eps_iteration_count": self.eps_iteration_count,
                "eps_restart_count": self.eps_restart_count,
                "eps_converged_reason": self.eps_converged_reason,
            },
            "state": {
                "operator_generation": self.operator_state_generation,
                "target_generation": self.target_state_generation,
                "operator_reuse_count": self.operator_reuse_count,
                "target_rebuild_count": self.target_rebuild_count,
                "invalidation_flags": self.invalidation_flags,
                "last_invalidation_reason": self.last_invalidation_reason,
            },
        })
    }
}

#[cfg(test)]
pub(crate) fn measured_modal_gpu_attestation_fixture() -> NativeModalGpuAttestation {
    NativeModalGpuAttestation {
        measurement_state: NativeModalGpuMeasurementState::Measured,
        measurement_coverage_flags: MODAL_GPU_REQUIRED_COVERAGE,
        device_residency_verified: true,
        production_shared_domain: true,
        validation_only: false,
        fallback_state: NativeModalGpuFallbackState::None,
        operator_kind: NativeModalGpuOperatorKind::MatrixFreeSchurCuda,
        hypre_memory_location: NativeModalGpuHypreMemoryLocation::Device,
        hypre_execution_policy: NativeModalGpuHypreExecutionPolicy::Device,
        compute_capability_major: 8,
        compute_capability_minor: 6,
        cuda_driver_version: 12_060,
        cuda_runtime_version: 12_060,
        device_name: "NVIDIA test device".to_string(),
        mfem_version: "4.8".to_string(),
        hypre_version: "2.32.0".to_string(),
        petsc_version: "3.23.0".to_string(),
        slepc_version: "3.23.0".to_string(),
        petsc_vec_type: "seqcuda".to_string(),
        petsc_matrix_type: "shell".to_string(),
        matshell_vec_type: "seqcuda".to_string(),
        slepc_bv_type: "vecs".to_string(),
        eps_type: "krylovschur".to_string(),
        st_type: "sinvert".to_string(),
        ksp_type: "gmres".to_string(),
        poisson_pc_type: "hypre".to_string(),
        shift_pc_type: "shell".to_string(),
        last_invalidation_reason: "initial_setup".to_string(),
        device_uuid: [1; 16],
        object_graph_sha256: [2; 32],
        native_trace_sha256: [3; 32],
        source_snapshot_sha256: [4; 32],
        runtime_manifest_sha256: [5; 32],
        mesh_identity_sha256: [6; 32],
        equilibrium_sha256: [7; 32],
        certificate_sha256: [8; 32],
        linearization_sha256: [9; 32],
        material_sha256: [10; 32],
        physics_sha256: [11; 32],
        boundary_sha256: [12; 32],
        gauge_sha256: [13; 32],
        operator_terms_sha256: [14; 32],
        solver_policy_sha256: [15; 32],
        operator_key_sha256: [16; 32],
        target_key_sha256: [17; 32],
        session_context_sha256: [18; 32],
        setup_h2d_count: 4,
        setup_h2d_bytes: 4096,
        hot_loop_computational_h2d_count: 0,
        hot_loop_computational_h2d_bytes: 0,
        hot_loop_computational_d2h_count: 0,
        hot_loop_computational_d2h_bytes: 0,
        hot_loop_scalar_telemetry_d2h_count: 2,
        hot_loop_scalar_telemetry_d2h_bytes: 32,
        hot_loop_full_vector_crossings: 0,
        hot_loop_computational_host_syncs: 0,
        hot_loop_scalar_telemetry_syncs: 2,
        hot_loop_allocations: 0,
        export_d2h_count: 1,
        export_d2h_bytes: 8192,
        device_memory_baseline_bytes: 1024,
        device_memory_peak_bytes: 8192,
        device_memory_final_bytes: 2048,
        operator_dimension: 2048,
        operator_apply_count: 41,
        poisson_solve_count: 43,
        poisson_iteration_count: 47,
        eps_iteration_count: 53,
        eps_restart_count: 2,
        eps_converged_reason: 1,
        operator_state_generation: 19,
        target_state_generation: 23,
        operator_reuse_count: 29,
        target_rebuild_count: 31,
        invalidation_flags: 37,
    }
}

fn parse_modal_gpu_attestation_snapshot(
    snapshot: NativeModalGpuAttestationSnapshot,
) -> Result<NativeModalGpuAttestation, String> {
    match snapshot.measurement_state {
        MODAL_GPU_MEASUREMENT_MEASURED => {}
        MODAL_GPU_MEASUREMENT_UNAVAILABLE => {
            return Err("k0_poisson_airbox_gpu_attestation_unavailable".to_string());
        }
        MODAL_GPU_MEASUREMENT_FAILED => {
            return Err("k0_poisson_airbox_gpu_attestation_failed".to_string());
        }
        _ => {
            return Err("k0_poisson_airbox_gpu_attestation_measurement_unknown".to_string());
        }
    }
    if snapshot.measurement_coverage_flags & MODAL_GPU_REQUIRED_COVERAGE
        != MODAL_GPU_REQUIRED_COVERAGE
    {
        return Err("k0_poisson_airbox_gpu_attestation_coverage_incomplete".to_string());
    }
    if snapshot.device_residency_verified != 1 {
        return Err("k0_poisson_airbox_gpu_attestation_residency_not_verified".to_string());
    }
    if snapshot.production_shared_domain != 1 {
        return Err(
            "k0_poisson_airbox_gpu_attestation_production_shared_domain_required".to_string(),
        );
    }
    if snapshot.validation_only != 0 {
        return Err("k0_poisson_airbox_gpu_attestation_validation_only_forbidden".to_string());
    }
    if snapshot.fallback_state != MODAL_GPU_FALLBACK_NONE {
        return Err("k0_poisson_airbox_gpu_attestation_fallback_forbidden".to_string());
    }
    if snapshot.operator_kind != MODAL_GPU_OPERATOR_MATRIX_FREE_SCHUR_CUDA {
        return Err("k0_poisson_airbox_gpu_attestation_operator_kind_invalid".to_string());
    }
    if snapshot.operator_dimension == 0 {
        return Err("k0_poisson_airbox_gpu_attestation_operator_dimension_invalid".to_string());
    }
    if snapshot.hypre_memory_location != MODAL_GPU_HYPRE_MEMORY_DEVICE {
        return Err("k0_poisson_airbox_gpu_attestation_hypre_memory_not_device".to_string());
    }
    if snapshot.hypre_execution_policy != MODAL_GPU_HYPRE_EXECUTION_DEVICE {
        return Err("k0_poisson_airbox_gpu_attestation_hypre_execution_not_device".to_string());
    }
    let required_identity_strings = [
        snapshot.device_name.as_str(),
        snapshot.mfem_version.as_str(),
        snapshot.hypre_version.as_str(),
        snapshot.petsc_version.as_str(),
        snapshot.slepc_version.as_str(),
        snapshot.petsc_vec_type.as_str(),
        snapshot.petsc_matrix_type.as_str(),
        snapshot.matshell_vec_type.as_str(),
        snapshot.slepc_bv_type.as_str(),
        snapshot.eps_type.as_str(),
        snapshot.st_type.as_str(),
        snapshot.ksp_type.as_str(),
        snapshot.poisson_pc_type.as_str(),
        snapshot.shift_pc_type.as_str(),
    ];
    if snapshot.compute_capability_major == 0
        || snapshot.cuda_driver_version == 0
        || snapshot.cuda_runtime_version == 0
        || required_identity_strings
            .iter()
            .any(|value| value.is_empty())
    {
        return Err("k0_poisson_airbox_gpu_attestation_device_identity_missing".to_string());
    }
    if snapshot.device_uuid.iter().all(|byte| *byte == 0) {
        return Err("k0_poisson_airbox_gpu_attestation_device_identity_missing".to_string());
    }
    let required_input_digests = [
        &snapshot.object_graph_sha256,
        &snapshot.native_trace_sha256,
        &snapshot.source_snapshot_sha256,
        &snapshot.runtime_manifest_sha256,
        &snapshot.mesh_identity_sha256,
        &snapshot.equilibrium_sha256,
        &snapshot.certificate_sha256,
        &snapshot.linearization_sha256,
        &snapshot.material_sha256,
        &snapshot.physics_sha256,
        &snapshot.boundary_sha256,
        &snapshot.gauge_sha256,
        &snapshot.operator_terms_sha256,
        &snapshot.solver_policy_sha256,
    ];
    if required_input_digests
        .iter()
        .any(|digest| digest_is_missing(digest))
    {
        return Err("k0_poisson_airbox_gpu_attestation_digest_missing".to_string());
    }
    if digest_is_missing(&snapshot.operator_key_sha256)
        || digest_is_missing(&snapshot.target_key_sha256)
        || digest_is_missing(&snapshot.session_context_sha256)
        || snapshot.operator_state_generation == 0
        || snapshot.target_state_generation == 0
    {
        return Err("k0_poisson_airbox_gpu_attestation_state_identity_incomplete".to_string());
    }
    if snapshot.hot_loop_computational_h2d_count != 0
        || snapshot.hot_loop_computational_h2d_bytes != 0
        || snapshot.hot_loop_computational_d2h_count != 0
        || snapshot.hot_loop_computational_d2h_bytes != 0
        || snapshot.hot_loop_full_vector_crossings != 0
        || snapshot.hot_loop_computational_host_syncs != 0
        || snapshot.hot_loop_allocations != 0
    {
        return Err("k0_poisson_airbox_gpu_transfer_audit_failed".to_string());
    }
    let scalar_telemetry_limit = snapshot
        .hot_loop_scalar_telemetry_d2h_count
        .checked_mul(256)
        .ok_or_else(|| "k0_poisson_airbox_gpu_transfer_audit_failed".to_string())?;
    if snapshot.hot_loop_scalar_telemetry_d2h_bytes > scalar_telemetry_limit
        || (snapshot.hot_loop_scalar_telemetry_d2h_count == 0
            && (snapshot.hot_loop_scalar_telemetry_d2h_bytes != 0
                || snapshot.hot_loop_scalar_telemetry_syncs != 0))
        || snapshot.device_memory_peak_bytes < snapshot.device_memory_baseline_bytes
        || snapshot.device_memory_peak_bytes < snapshot.device_memory_final_bytes
    {
        return Err("k0_poisson_airbox_gpu_transfer_audit_failed".to_string());
    }

    let device_residency_verified = snapshot.device_residency_verified == 1;
    let production_shared_domain = snapshot.production_shared_domain == 1;
    let validation_only = snapshot.validation_only != 0;
    let fallback_state = NativeModalGpuFallbackState::None;
    let operator_kind = NativeModalGpuOperatorKind::MatrixFreeSchurCuda;
    let hypre_memory_location = NativeModalGpuHypreMemoryLocation::Device;
    let hypre_execution_policy = NativeModalGpuHypreExecutionPolicy::Device;

    Ok(NativeModalGpuAttestation {
        measurement_state: NativeModalGpuMeasurementState::Measured,
        measurement_coverage_flags: snapshot.measurement_coverage_flags,
        device_residency_verified,
        production_shared_domain,
        validation_only,
        fallback_state,
        operator_kind,
        hypre_memory_location,
        hypre_execution_policy,
        compute_capability_major: snapshot.compute_capability_major,
        compute_capability_minor: snapshot.compute_capability_minor,
        cuda_driver_version: snapshot.cuda_driver_version,
        cuda_runtime_version: snapshot.cuda_runtime_version,
        device_name: snapshot.device_name,
        mfem_version: snapshot.mfem_version,
        hypre_version: snapshot.hypre_version,
        petsc_version: snapshot.petsc_version,
        slepc_version: snapshot.slepc_version,
        petsc_vec_type: snapshot.petsc_vec_type,
        petsc_matrix_type: snapshot.petsc_matrix_type,
        matshell_vec_type: snapshot.matshell_vec_type,
        slepc_bv_type: snapshot.slepc_bv_type,
        eps_type: snapshot.eps_type,
        st_type: snapshot.st_type,
        ksp_type: snapshot.ksp_type,
        poisson_pc_type: snapshot.poisson_pc_type,
        shift_pc_type: snapshot.shift_pc_type,
        last_invalidation_reason: snapshot.last_invalidation_reason,
        device_uuid: snapshot.device_uuid,
        object_graph_sha256: snapshot.object_graph_sha256,
        native_trace_sha256: snapshot.native_trace_sha256,
        source_snapshot_sha256: snapshot.source_snapshot_sha256,
        runtime_manifest_sha256: snapshot.runtime_manifest_sha256,
        mesh_identity_sha256: snapshot.mesh_identity_sha256,
        equilibrium_sha256: snapshot.equilibrium_sha256,
        certificate_sha256: snapshot.certificate_sha256,
        linearization_sha256: snapshot.linearization_sha256,
        material_sha256: snapshot.material_sha256,
        physics_sha256: snapshot.physics_sha256,
        boundary_sha256: snapshot.boundary_sha256,
        gauge_sha256: snapshot.gauge_sha256,
        operator_terms_sha256: snapshot.operator_terms_sha256,
        solver_policy_sha256: snapshot.solver_policy_sha256,
        operator_key_sha256: snapshot.operator_key_sha256,
        target_key_sha256: snapshot.target_key_sha256,
        session_context_sha256: snapshot.session_context_sha256,
        setup_h2d_count: snapshot.setup_h2d_count,
        setup_h2d_bytes: snapshot.setup_h2d_bytes,
        hot_loop_computational_h2d_count: snapshot.hot_loop_computational_h2d_count,
        hot_loop_computational_h2d_bytes: snapshot.hot_loop_computational_h2d_bytes,
        hot_loop_computational_d2h_count: snapshot.hot_loop_computational_d2h_count,
        hot_loop_computational_d2h_bytes: snapshot.hot_loop_computational_d2h_bytes,
        hot_loop_scalar_telemetry_d2h_count: snapshot.hot_loop_scalar_telemetry_d2h_count,
        hot_loop_scalar_telemetry_d2h_bytes: snapshot.hot_loop_scalar_telemetry_d2h_bytes,
        hot_loop_full_vector_crossings: snapshot.hot_loop_full_vector_crossings,
        hot_loop_computational_host_syncs: snapshot.hot_loop_computational_host_syncs,
        hot_loop_scalar_telemetry_syncs: snapshot.hot_loop_scalar_telemetry_syncs,
        hot_loop_allocations: snapshot.hot_loop_allocations,
        export_d2h_count: snapshot.export_d2h_count,
        export_d2h_bytes: snapshot.export_d2h_bytes,
        device_memory_baseline_bytes: snapshot.device_memory_baseline_bytes,
        device_memory_peak_bytes: snapshot.device_memory_peak_bytes,
        device_memory_final_bytes: snapshot.device_memory_final_bytes,
        operator_dimension: snapshot.operator_dimension,
        operator_apply_count: snapshot.operator_apply_count,
        poisson_solve_count: snapshot.poisson_solve_count,
        poisson_iteration_count: snapshot.poisson_iteration_count,
        eps_iteration_count: snapshot.eps_iteration_count,
        eps_restart_count: snapshot.eps_restart_count,
        eps_converged_reason: snapshot.eps_converged_reason,
        operator_state_generation: snapshot.operator_state_generation,
        target_state_generation: snapshot.target_state_generation,
        operator_reuse_count: snapshot.operator_reuse_count,
        target_rebuild_count: snapshot.target_rebuild_count,
        invalidation_flags: snapshot.invalidation_flags,
    })
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
unsafe fn validate_modal_gpu_attestation_v1(
    attestation: *const ffi::FullmagFemModalGpuAttestationV1,
) -> Result<NativeModalGpuAttestation, String> {
    if attestation.is_null() {
        return Err("k0_poisson_airbox_gpu_attestation_missing".to_string());
    }
    let abi_version =
        unsafe { std::ptr::read_unaligned(std::ptr::addr_of!((*attestation).abi_version)) };
    let struct_size =
        unsafe { std::ptr::read_unaligned(std::ptr::addr_of!((*attestation).struct_size)) };
    if abi_version != ffi::FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_ABI_VERSION
        || (struct_size as usize) < std::mem::size_of::<ffi::FullmagFemModalGpuAttestationV1>()
    {
        return Err("k0_poisson_airbox_gpu_attestation_abi_mismatch".to_string());
    }
    let attestation = unsafe { std::ptr::read_unaligned(attestation) };
    parse_modal_gpu_attestation_snapshot(NativeModalGpuAttestationSnapshot {
        measurement_state: attestation.measurement_state,
        fallback_state: attestation.fallback_state,
        measurement_coverage_flags: attestation.measurement_coverage_flags,
        device_residency_verified: attestation.device_residency_verified,
        production_shared_domain: attestation.production_shared_domain,
        validation_only: attestation.validation_only,
        operator_kind: attestation.operator_kind,
        hypre_memory_location: attestation.hypre_memory_location,
        hypre_execution_policy: attestation.hypre_execution_policy,
        compute_capability_major: attestation.compute_capability_major,
        compute_capability_minor: attestation.compute_capability_minor,
        cuda_driver_version: attestation.cuda_driver_version,
        cuda_runtime_version: attestation.cuda_runtime_version,
        device_name: ffi_string(attestation.device_name),
        mfem_version: ffi_string(attestation.mfem_version),
        hypre_version: ffi_string(attestation.hypre_version),
        petsc_version: ffi_string(attestation.petsc_version),
        slepc_version: ffi_string(attestation.slepc_version),
        petsc_vec_type: ffi_string(attestation.petsc_vec_type),
        petsc_matrix_type: ffi_string(attestation.petsc_matrix_type),
        matshell_vec_type: ffi_string(attestation.matshell_vec_type),
        slepc_bv_type: ffi_string(attestation.slepc_bv_type),
        eps_type: ffi_string(attestation.eps_type),
        st_type: ffi_string(attestation.st_type),
        ksp_type: ffi_string(attestation.ksp_type),
        poisson_pc_type: ffi_string(attestation.poisson_pc_type),
        shift_pc_type: ffi_string(attestation.shift_pc_type),
        last_invalidation_reason: ffi_string(attestation.last_invalidation_reason),
        device_uuid: attestation.device_uuid,
        object_graph_sha256: attestation.object_graph_sha256,
        native_trace_sha256: attestation.native_trace_sha256,
        source_snapshot_sha256: attestation.source_snapshot_sha256,
        runtime_manifest_sha256: attestation.runtime_manifest_sha256,
        mesh_identity_sha256: attestation.mesh_identity_sha256,
        equilibrium_sha256: attestation.equilibrium_sha256,
        certificate_sha256: attestation.certificate_sha256,
        linearization_sha256: attestation.linearization_sha256,
        material_sha256: attestation.material_sha256,
        physics_sha256: attestation.physics_sha256,
        boundary_sha256: attestation.boundary_sha256,
        gauge_sha256: attestation.gauge_sha256,
        operator_terms_sha256: attestation.operator_terms_sha256,
        solver_policy_sha256: attestation.solver_policy_sha256,
        operator_key_sha256: attestation.operator_key_sha256,
        target_key_sha256: attestation.target_key_sha256,
        session_context_sha256: attestation.session_context_sha256,
        setup_h2d_count: attestation.setup_h2d_count,
        setup_h2d_bytes: attestation.setup_h2d_bytes,
        hot_loop_computational_h2d_count: attestation.hot_loop_computational_h2d_count,
        hot_loop_computational_h2d_bytes: attestation.hot_loop_computational_h2d_bytes,
        hot_loop_computational_d2h_count: attestation.hot_loop_computational_d2h_count,
        hot_loop_computational_d2h_bytes: attestation.hot_loop_computational_d2h_bytes,
        hot_loop_scalar_telemetry_d2h_count: attestation.hot_loop_scalar_telemetry_d2h_count,
        hot_loop_scalar_telemetry_d2h_bytes: attestation.hot_loop_scalar_telemetry_d2h_bytes,
        hot_loop_full_vector_crossings: attestation.hot_loop_full_vector_crossings,
        hot_loop_computational_host_syncs: attestation.hot_loop_computational_host_syncs,
        hot_loop_scalar_telemetry_syncs: attestation.hot_loop_scalar_telemetry_syncs,
        hot_loop_allocations: attestation.hot_loop_allocations,
        export_d2h_count: attestation.export_d2h_count,
        export_d2h_bytes: attestation.export_d2h_bytes,
        device_memory_baseline_bytes: attestation.device_memory_baseline_bytes,
        device_memory_peak_bytes: attestation.device_memory_peak_bytes,
        device_memory_final_bytes: attestation.device_memory_final_bytes,
        operator_dimension: attestation.operator_dimension,
        operator_apply_count: attestation.operator_apply_count,
        poisson_solve_count: attestation.poisson_solve_count,
        poisson_iteration_count: attestation.poisson_iteration_count,
        eps_iteration_count: attestation.eps_iteration_count,
        eps_restart_count: attestation.eps_restart_count,
        eps_converged_reason: attestation.eps_converged_reason,
        operator_state_generation: attestation.operator_state_generation,
        target_state_generation: attestation.target_state_generation,
        operator_reuse_count: attestation.operator_reuse_count,
        target_rebuild_count: attestation.target_rebuild_count,
        invalidation_flags: attestation.invalidation_flags,
    })
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl Default for NativeFrequencyDomainContractFfiResult {
    fn default() -> Self {
        Self {
            inner: ffi::FullmagFemFrequencyDomainResult {
                abi_version: ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION,
                status: ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_UNAVAILABLE,
                error_message: std::ptr::null_mut(),
                diagnostics_json: std::ptr::null_mut(),
                result_json: std::ptr::null_mut(),
                artifact_manifest_path: std::ptr::null_mut(),
                mode_count: 0,
                q_dof_count: 0,
                phi_dof_count: 0,
                mode_lambda_count: 0,
                mode_q_complex_count: 0,
                mode_phi_complex_count: 0,
                mode_delta_m_xyz_complex_count: 0,
                mode_residual_count: 0,
                mode_cluster_id_count: 0,
                mode_lambda: std::ptr::null_mut(),
                mode_q_complex: std::ptr::null_mut(),
                mode_phi_complex: std::ptr::null_mut(),
                mode_delta_m_xyz_complex: std::ptr::null_mut(),
                mode_residuals: std::ptr::null_mut(),
                mode_cluster_ids: std::ptr::null_mut(),
                resolved_execution_target:
                    ffi::fullmag_fem_modal_execution_target::FULLMAG_FEM_MODAL_EXECUTION_AUTO,
                resolved_scalar_representation:
                    ffi::fullmag_fem_modal_scalar_representation::FULLMAG_FEM_MODAL_SCALAR_COMPLEX_DOUBLE,
                resolved_spectral_transform_kind:
                    ffi::fullmag_fem_modal_spectral_transform_kind::
                        FULLMAG_FEM_MODAL_SPECTRAL_TRANSFORM_AUTO,
                result_flags: 0,
                struct_size: std::mem::size_of::<ffi::FullmagFemFrequencyDomainResult>() as u64,
                resolved_fallback_state: 0,
                resolved_engine_id: std::ptr::null_mut(),
                resolved_fallback_reason: std::ptr::null_mut(),
                resolved_canonical_preimage_sha256: std::ptr::null_mut(),
                resolved_certificate_binding_status:
                    ffi::FULLMAG_FEM_MODAL_CERTIFICATE_BINDING_UNSPECIFIED,
                resolved_certificate_binding_reason: std::ptr::null_mut(),
            },
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl NativeFrequencyDomainContractFfiResult {
    fn to_owned_result(&self) -> NativeFrequencyDomainContractResult {
        let modal_eigen = if self.inner.mode_count == 0 {
            None
        } else {
            Some(NativeModalEigenTypedResult {
                q_dof_count: self.inner.q_dof_count,
                phi_dof_count: self.inner.phi_dof_count,
                mode_lambda: copy_ffi_complex(self.inner.mode_lambda, self.inner.mode_lambda_count),
                mode_q_complex: copy_ffi_complex(
                    self.inner.mode_q_complex,
                    self.inner.mode_q_complex_count,
                ),
                mode_phi_complex: copy_ffi_complex(
                    self.inner.mode_phi_complex,
                    self.inner.mode_phi_complex_count,
                ),
                mode_delta_m_xyz_complex: copy_ffi_complex(
                    self.inner.mode_delta_m_xyz_complex,
                    self.inner.mode_delta_m_xyz_complex_count,
                ),
                mode_residuals: copy_ffi_values(
                    self.inner.mode_residuals,
                    self.inner.mode_residual_count,
                ),
                mode_cluster_ids: copy_ffi_values(
                    self.inner.mode_cluster_ids,
                    self.inner.mode_cluster_id_count,
                ),
                resolved_execution_target: self.inner.resolved_execution_target as u32,
                resolved_scalar_representation: self.inner.resolved_scalar_representation as u32,
                resolved_spectral_transform_kind: self.inner.resolved_spectral_transform_kind
                    as u32,
            })
        };
        NativeFrequencyDomainContractResult {
            status: map_contract_status(self.inner.status),
            error_message: ffi_string(self.inner.error_message),
            diagnostics_json: ffi_string(self.inner.diagnostics_json),
            result_json: ffi_string(self.inner.result_json),
            artifact_manifest_path: ffi_string(self.inner.artifact_manifest_path),
            modal_eigen,
            modal_gpu_attestation: None,
            resolved_fallback_state: self.inner.resolved_fallback_state,
            resolved_engine_id: ffi_string(self.inner.resolved_engine_id),
            resolved_fallback_reason: ffi_string(self.inner.resolved_fallback_reason),
            resolved_canonical_preimage_sha256: ffi_string(
                self.inner.resolved_canonical_preimage_sha256,
            ),
            resolved_certificate_binding_status: self.inner.resolved_certificate_binding_status,
            resolved_certificate_binding_reason: ffi_string(
                self.inner.resolved_certificate_binding_reason,
            ),
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn copy_ffi_complex(
    pointer: *const ffi::FullmagFemComplex64,
    count: u64,
) -> Vec<NativeModalComplex64> {
    if count == 0 || pointer.is_null() || count > usize::MAX as u64 {
        return Vec::new();
    }
    unsafe {
        std::slice::from_raw_parts(pointer, count as usize)
            .iter()
            .map(|value| NativeModalComplex64 {
                real: value.real,
                imag: value.imag,
            })
            .collect()
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn copy_ffi_values<T: Copy>(pointer: *const T, count: u64) -> Vec<T> {
    if count == 0 || pointer.is_null() || count > usize::MAX as u64 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(pointer, count as usize).to_vec() }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl Drop for NativeFrequencyDomainContractFfiResult {
    fn drop(&mut self) {
        unsafe {
            ffi::fullmag_fem_frequency_domain_result_destroy(&mut self.inner);
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn ffi_string(value: *const std::os::raw::c_char) -> String {
    if value.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .to_string()
    }
}

#[cfg(feature = "fem-gpu")]
fn map_status(status: ffi::fullmag_fem_frequency_domain_status) -> NativeFrequencyDomainStatus {
    match status {
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK => {
            NativeFrequencyDomainStatus::Ok
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE => {
            NativeFrequencyDomainStatus::Unavailable
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR => {
            NativeFrequencyDomainStatus::ValidationError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR => {
            NativeFrequencyDomainStatus::OperatorError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR => {
            NativeFrequencyDomainStatus::SolveError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR => {
            NativeFrequencyDomainStatus::ArtifactError
        }
        ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED => {
            NativeFrequencyDomainStatus::Interrupted
        }
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn map_contract_status(
    status: ffi::FullmagFemFrequencyDomainStatus,
) -> NativeFrequencyDomainStatus {
    match status {
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_OK => NativeFrequencyDomainStatus::Ok,
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_UNAVAILABLE => {
            NativeFrequencyDomainStatus::Unavailable
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_VALIDATION_ERROR => {
            NativeFrequencyDomainStatus::ValidationError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_OPERATOR_ERROR => {
            NativeFrequencyDomainStatus::OperatorError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_SOLVE_ERROR => {
            NativeFrequencyDomainStatus::SolveError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_ARTIFACT_ERROR => {
            NativeFrequencyDomainStatus::ArtifactError
        }
        ffi::FullmagFemFrequencyDomainStatus::FULLMAG_FEM_FD_INTERRUPTED => {
            NativeFrequencyDomainStatus::Interrupted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete_measured_gpu_attestation_snapshot() -> NativeModalGpuAttestationSnapshot {
        NativeModalGpuAttestationSnapshot {
            measurement_state: MODAL_GPU_MEASUREMENT_MEASURED,
            fallback_state: MODAL_GPU_FALLBACK_NONE,
            measurement_coverage_flags: MODAL_GPU_REQUIRED_COVERAGE,
            device_residency_verified: 1,
            production_shared_domain: 1,
            validation_only: 0,
            operator_kind: MODAL_GPU_OPERATOR_MATRIX_FREE_SCHUR_CUDA,
            hypre_memory_location: MODAL_GPU_HYPRE_MEMORY_DEVICE,
            hypre_execution_policy: MODAL_GPU_HYPRE_EXECUTION_DEVICE,
            compute_capability_major: 8,
            compute_capability_minor: 6,
            cuda_driver_version: 12_060,
            cuda_runtime_version: 12_060,
            device_name: "NVIDIA test device".to_string(),
            mfem_version: "4.8".to_string(),
            hypre_version: "2.32.0".to_string(),
            petsc_version: "3.23.0".to_string(),
            slepc_version: "3.23.0".to_string(),
            petsc_vec_type: "seqcuda".to_string(),
            petsc_matrix_type: "shell".to_string(),
            matshell_vec_type: "seqcuda".to_string(),
            slepc_bv_type: "vecs".to_string(),
            eps_type: "krylovschur".to_string(),
            st_type: "sinvert".to_string(),
            ksp_type: "gmres".to_string(),
            poisson_pc_type: "hypre".to_string(),
            shift_pc_type: "shell".to_string(),
            last_invalidation_reason: "initial_setup".to_string(),
            device_uuid: [1; 16],
            object_graph_sha256: [2; 32],
            native_trace_sha256: [3; 32],
            source_snapshot_sha256: [4; 32],
            runtime_manifest_sha256: [5; 32],
            mesh_identity_sha256: [6; 32],
            equilibrium_sha256: [7; 32],
            certificate_sha256: [8; 32],
            linearization_sha256: [9; 32],
            material_sha256: [10; 32],
            physics_sha256: [11; 32],
            boundary_sha256: [12; 32],
            gauge_sha256: [13; 32],
            operator_terms_sha256: [14; 32],
            solver_policy_sha256: [15; 32],
            operator_key_sha256: [16; 32],
            target_key_sha256: [17; 32],
            session_context_sha256: [18; 32],
            setup_h2d_count: 4,
            setup_h2d_bytes: 4096,
            hot_loop_computational_h2d_count: 0,
            hot_loop_computational_h2d_bytes: 0,
            hot_loop_computational_d2h_count: 0,
            hot_loop_computational_d2h_bytes: 0,
            hot_loop_scalar_telemetry_d2h_count: 2,
            hot_loop_scalar_telemetry_d2h_bytes: 32,
            hot_loop_full_vector_crossings: 0,
            hot_loop_computational_host_syncs: 0,
            hot_loop_scalar_telemetry_syncs: 2,
            hot_loop_allocations: 0,
            export_d2h_count: 1,
            export_d2h_bytes: 8192,
            device_memory_baseline_bytes: 1024,
            device_memory_peak_bytes: 8192,
            device_memory_final_bytes: 2048,
            operator_dimension: 2048,
            operator_apply_count: 41,
            poisson_solve_count: 43,
            poisson_iteration_count: 47,
            eps_iteration_count: 53,
            eps_restart_count: 2,
            eps_converged_reason: 1,
            operator_state_generation: 19,
            target_state_generation: 23,
            operator_reuse_count: 29,
            target_rebuild_count: 31,
            invalidation_flags: 37,
        }
    }

    #[test]
    fn measured_gpu_attestation_snapshot_is_fail_closed_and_owned() {
        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.measurement_coverage_flags &= !MODAL_GPU_COVERAGE_EXPORT;
        assert_eq!(
            parse_modal_gpu_attestation_snapshot(snapshot).unwrap_err(),
            "k0_poisson_airbox_gpu_attestation_coverage_incomplete"
        );

        let snapshot = complete_measured_gpu_attestation_snapshot();
        let parsed = parse_modal_gpu_attestation_snapshot(snapshot).unwrap();
        assert_eq!(
            parsed.measurement_state,
            NativeModalGpuMeasurementState::Measured
        );
        assert_eq!(
            parsed.measurement_coverage_flags,
            MODAL_GPU_REQUIRED_COVERAGE
        );
        assert!(parsed.device_residency_verified);
        assert!(parsed.production_shared_domain);
        assert!(!parsed.validation_only);
        assert_eq!(parsed.fallback_state, NativeModalGpuFallbackState::None);
        assert_eq!(
            parsed.operator_kind,
            NativeModalGpuOperatorKind::MatrixFreeSchurCuda
        );
        assert_eq!(
            parsed.hypre_memory_location,
            NativeModalGpuHypreMemoryLocation::Device
        );
        assert_eq!(
            parsed.hypre_execution_policy,
            NativeModalGpuHypreExecutionPolicy::Device
        );
        assert_eq!(parsed.device_uuid, [1; 16]);
        assert_eq!(parsed.mesh_identity_sha256, [6; 32]);
        assert_eq!(parsed.solver_policy_sha256, [15; 32]);
        assert_eq!(parsed.operator_dimension, 2048);
        assert_eq!(parsed.operator_state_generation, 19);
        assert_eq!(parsed.target_state_generation, 23);
        assert_eq!(parsed.operator_reuse_count, 29);
        assert_eq!(parsed.target_rebuild_count, 31);
        assert_eq!(parsed.invalidation_flags, 37);
        assert_eq!(parsed.operator_key_sha256, [16; 32]);
        assert_eq!(parsed.target_key_sha256, [17; 32]);
        assert_eq!(parsed.session_context_sha256, [18; 32]);
    }

    #[test]
    fn measured_gpu_attestation_serializes_owned_values_without_synthetic_defaults() {
        let parsed =
            parse_modal_gpu_attestation_snapshot(complete_measured_gpu_attestation_snapshot())
                .unwrap();
        let artifact = parsed.artifact_json();

        assert_eq!(artifact["measurement_state"], "measured");
        assert_eq!(artifact["device"]["name"], "NVIDIA test device");
        assert_eq!(artifact["device"]["compute_capability_major"], 8);
        assert_eq!(artifact["runtime"]["mfem_version"], "4.8");
        assert_eq!(artifact["object_graph"]["petsc_vec_type"], "seqcuda");
        assert_eq!(
            artifact["bindings"]["runtime_manifest_sha256"],
            format!("sha256:{}", "05".repeat(32))
        );
        assert_eq!(artifact["transfers"]["setup_h2d_bytes"], 4096);
        assert_eq!(
            artifact["transfers"]["hot_loop_scalar_telemetry_d2h_bytes"],
            32
        );
        assert_eq!(artifact["solver"]["operator_apply_count"], 41);
        assert_eq!(artifact["state"]["operator_generation"], 19);
        assert_eq!(
            artifact["state"]["last_invalidation_reason"],
            "initial_setup"
        );
    }

    #[test]
    fn measured_gpu_attestation_rejects_hot_loop_compute_transfers_and_allows_bounded_telemetry() {
        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.hot_loop_computational_d2h_bytes = 8;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_transfer_audit_failed",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.hot_loop_computational_host_syncs = 1;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_transfer_audit_failed",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.hot_loop_scalar_telemetry_d2h_count = 1;
        snapshot.hot_loop_scalar_telemetry_d2h_bytes = 257;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_transfer_audit_failed",
        );

        let parsed =
            parse_modal_gpu_attestation_snapshot(complete_measured_gpu_attestation_snapshot())
                .expect("bounded scalar telemetry must remain legal");
        assert_eq!(parsed.hot_loop_scalar_telemetry_d2h_count, 2);
        assert_eq!(parsed.hot_loop_scalar_telemetry_d2h_bytes, 32);
    }

    fn assert_gpu_attestation_snapshot_rejected(
        snapshot: NativeModalGpuAttestationSnapshot,
        token: &str,
    ) {
        assert_eq!(
            parse_modal_gpu_attestation_snapshot(snapshot).unwrap_err(),
            token
        );
    }

    #[test]
    fn measured_gpu_attestation_snapshot_validates_production_execution_contract() {
        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.device_residency_verified = 0;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_residency_not_verified",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.production_shared_domain = 0;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_production_shared_domain_required",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.validation_only = 1;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_validation_only_forbidden",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.fallback_state = 2;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_fallback_forbidden",
        );
    }

    #[test]
    fn measured_gpu_attestation_snapshot_validates_operator_and_hypre_policy() {
        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.operator_kind = 2;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_operator_kind_invalid",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.operator_dimension = 0;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_operator_dimension_invalid",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.hypre_memory_location = 1;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_hypre_memory_not_device",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.hypre_execution_policy = 1;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_hypre_execution_not_device",
        );
    }

    #[test]
    fn measured_gpu_attestation_snapshot_validates_identity_digests_and_generations() {
        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.device_uuid = [0; 16];
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_device_identity_missing",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.mesh_identity_sha256 = [0; 32];
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_digest_missing",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.operator_key_sha256 = [0; 32];
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_state_identity_incomplete",
        );

        let mut snapshot = complete_measured_gpu_attestation_snapshot();
        snapshot.target_state_generation = 0;
        assert_gpu_attestation_snapshot_rejected(
            snapshot,
            "k0_poisson_airbox_gpu_attestation_state_identity_incomplete",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn legacy_frequency_domain_result_uses_frozen_result_abi_v18() {
        let result = NativeFrequencyDomainContractFfiResult::default();
        assert_eq!(
            result.inner.abi_version,
            ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_ABI_VERSION
        );
        assert_eq!(result.inner.abi_version, 18);
        assert_ne!(
            result.inner.abi_version,
            ffi::FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION,
            "request/shared-payload v19 must not leak into the frozen by-value result"
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_complete_identity_and_state_prefix() {
        let mut attestation: ffi::FullmagFemModalGpuAttestationV1 = unsafe { std::mem::zeroed() };
        attestation.abi_version = ffi::FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_ABI_VERSION;
        attestation.struct_size =
            std::mem::size_of::<ffi::FullmagFemModalGpuAttestationV1>() as u32;
        attestation.measurement_state = ffi::FULLMAG_FEM_MODAL_GPU_MEASUREMENT_MEASURED;

        assert_eq!(
            unsafe { validate_modal_gpu_attestation_v1(&attestation) }.unwrap_err(),
            "k0_poisson_airbox_gpu_attestation_coverage_incomplete"
        );

        attestation.measurement_state = ffi::FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE;
        assert_eq!(
            unsafe { validate_modal_gpu_attestation_v1(&attestation) }.unwrap_err(),
            "k0_poisson_airbox_gpu_attestation_unavailable"
        );

        attestation.measurement_state = u32::MAX;
        assert_eq!(
            unsafe { validate_modal_gpu_attestation_v1(&attestation) }.unwrap_err(),
            "k0_poisson_airbox_gpu_attestation_measurement_unknown"
        );
    }

    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn complete_measured_gpu_attestation() -> ffi::FullmagFemModalGpuAttestationV1 {
        let mut attestation: ffi::FullmagFemModalGpuAttestationV1 = unsafe { std::mem::zeroed() };
        attestation.abi_version = ffi::FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1_ABI_VERSION;
        attestation.struct_size =
            std::mem::size_of::<ffi::FullmagFemModalGpuAttestationV1>() as u32;
        attestation.measurement_state = ffi::FULLMAG_FEM_MODAL_GPU_MEASUREMENT_MEASURED;
        attestation.fallback_state = 1;
        attestation.measurement_coverage_flags = ffi::FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP
            | ffi::FULLMAG_FEM_MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP
            | ffi::FULLMAG_FEM_MODAL_GPU_COVERAGE_OBJECT_GRAPH
            | ffi::FULLMAG_FEM_MODAL_GPU_COVERAGE_SCALAR_TELEMETRY
            | ffi::FULLMAG_FEM_MODAL_GPU_COVERAGE_EXPORT;
        attestation.device_residency_verified = 1;
        attestation.production_shared_domain = 1;
        attestation.validation_only = 0;
        attestation.operator_kind = 1;
        attestation.hypre_memory_location = 2;
        attestation.hypre_execution_policy = 2;
        attestation.compute_capability_major = 8;
        attestation.compute_capability_minor = 6;
        attestation.cuda_driver_version = 12_060;
        attestation.cuda_runtime_version = 12_060;
        let string_pointer = b"measured\0".as_ptr().cast_mut().cast();
        attestation.device_name = string_pointer;
        attestation.mfem_version = string_pointer;
        attestation.hypre_version = string_pointer;
        attestation.petsc_version = string_pointer;
        attestation.slepc_version = string_pointer;
        attestation.petsc_vec_type = string_pointer;
        attestation.petsc_matrix_type = string_pointer;
        attestation.matshell_vec_type = string_pointer;
        attestation.slepc_bv_type = string_pointer;
        attestation.eps_type = string_pointer;
        attestation.st_type = string_pointer;
        attestation.ksp_type = string_pointer;
        attestation.poisson_pc_type = string_pointer;
        attestation.shift_pc_type = string_pointer;
        attestation.device_uuid = [1; 16];
        attestation.object_graph_sha256 = [2; 32];
        attestation.native_trace_sha256 = [3; 32];
        attestation.source_snapshot_sha256 = [4; 32];
        attestation.runtime_manifest_sha256 = [5; 32];
        attestation.mesh_identity_sha256 = [6; 32];
        attestation.equilibrium_sha256 = [7; 32];
        attestation.certificate_sha256 = [8; 32];
        attestation.linearization_sha256 = [9; 32];
        attestation.material_sha256 = [10; 32];
        attestation.physics_sha256 = [11; 32];
        attestation.boundary_sha256 = [12; 32];
        attestation.gauge_sha256 = [13; 32];
        attestation.operator_terms_sha256 = [14; 32];
        attestation.solver_policy_sha256 = [15; 32];
        attestation.operator_key_sha256 = [16; 32];
        attestation.target_key_sha256 = [17; 32];
        attestation.session_context_sha256 = [18; 32];
        attestation.setup_h2d_count = 4;
        attestation.setup_h2d_bytes = 4096;
        attestation.hot_loop_scalar_telemetry_d2h_count = 2;
        attestation.hot_loop_scalar_telemetry_d2h_bytes = 32;
        attestation.hot_loop_scalar_telemetry_syncs = 2;
        attestation.export_d2h_count = 1;
        attestation.export_d2h_bytes = 8192;
        attestation.device_memory_baseline_bytes = 1024;
        attestation.device_memory_peak_bytes = 8192;
        attestation.device_memory_final_bytes = 2048;
        attestation.operator_dimension = 2048;
        attestation.operator_apply_count = 41;
        attestation.poisson_solve_count = 43;
        attestation.poisson_iteration_count = 47;
        attestation.eps_iteration_count = 53;
        attestation.eps_restart_count = 2;
        attestation.eps_converged_reason = 1;
        attestation.operator_state_generation = 19;
        attestation.target_state_generation = 23;
        attestation.operator_reuse_count = 29;
        attestation.target_rebuild_count = 31;
        attestation.invalidation_flags = 37;
        attestation
    }

    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn assert_gpu_attestation_rejected(
        attestation: &ffi::FullmagFemModalGpuAttestationV1,
        token: &str,
    ) {
        assert_eq!(
            unsafe { validate_modal_gpu_attestation_v1(attestation) }.unwrap_err(),
            token
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_complete_measurement_coverage() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.measurement_coverage_flags &= !ffi::FULLMAG_FEM_MODAL_GPU_COVERAGE_EXPORT;

        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_coverage_incomplete",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_verified_device_residency() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.device_residency_verified = 0;

        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_residency_not_verified",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_production_shared_domain_not_validation() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.production_shared_domain = 0;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_production_shared_domain_required",
        );

        let mut attestation = complete_measured_gpu_attestation();
        attestation.validation_only = 1;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_validation_only_forbidden",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_matrix_free_operator_and_nonzero_dimension() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.operator_kind = 2;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_operator_kind_invalid",
        );

        let mut attestation = complete_measured_gpu_attestation();
        attestation.operator_dimension = 0;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_operator_dimension_invalid",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_hypre_device_policy() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.hypre_memory_location = 1;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_hypre_memory_not_device",
        );

        let mut attestation = complete_measured_gpu_attestation();
        attestation.hypre_execution_policy = 1;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_hypre_execution_not_device",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_forbids_fallback() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.fallback_state = 2;

        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_fallback_forbidden",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_uuid_and_every_input_digest() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.device_uuid = [0; 16];
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_device_identity_missing",
        );

        let mut attestation = complete_measured_gpu_attestation();
        attestation.mesh_identity_sha256 = [0; 32];
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_digest_missing",
        );

        let mut attestation = complete_measured_gpu_attestation();
        attestation.solver_policy_sha256 = [0; 32];
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_digest_missing",
        );
    }

    #[test]
    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    fn measured_gpu_attestation_requires_state_generations_and_keys() {
        let mut attestation = complete_measured_gpu_attestation();
        attestation.operator_state_generation = 0;
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_state_identity_incomplete",
        );

        let mut attestation = complete_measured_gpu_attestation();
        attestation.target_key_sha256 = [0; 32];
        assert_gpu_attestation_rejected(
            &attestation,
            "k0_poisson_airbox_gpu_attestation_state_identity_incomplete",
        );
    }

    fn shared_domain_mesh_with_air_only_node() -> fullmag_ir::MeshIR {
        fullmag_ir::MeshIR {
            mesh_name: "runner-ffi-film-airbox".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, -1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 1, 2, 4]]),
            element_markers: vec![1, 0],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        }
    }

    fn shared_domain_ffi_problem(
        mesh: &fullmag_ir::MeshIR,
    ) -> NativeModalEigenSharedDomainProblem<'_> {
        let digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
        let node_count = mesh.nodes.len();
        let mut frames = vec![0.0; 6 * node_count];
        for node in 0..node_count {
            frames[6 * node] = 1.0;
            frames[6 * node + 4] = 1.0;
        }
        let m0 = vec![0.0, 0.0, 1.0]
            .into_iter()
            .cycle()
            .take(3 * node_count)
            .collect::<Vec<_>>();
        let view =
            |view_kind, part_role, identity: &str| crate::fem_eigen::OwnedModalCertificateV6View {
                view_kind,
                part_role,
                part_identity: identity.to_string(),
                topology_fingerprint: digest.to_string(),
                region_ids: vec![part_role, part_role],
                boundary_axis_masks: vec![0, 1],
                region_roles: vec![crate::fem_eigen::OwnedModalCertificateV6RegionRole {
                    region_id: part_role,
                    part_role,
                }],
                generator_relations: vec![crate::fem_eigen::OwnedModalCertificateV6Relation {
                    source_node: 0,
                    destination_node: 1,
                    axis_mask: 1,
                    kind: 1,
                }],
                closure_relations: vec![crate::fem_eigen::OwnedModalCertificateV6Relation {
                    source_node: 0,
                    destination_node: 1,
                    axis_mask: 1,
                    kind: 1,
                }],
                expected_class_ids: vec![0, 0],
                expected_class_digests: vec![
                    crate::fem_eigen::OwnedModalCertificateV6ClassDigest {
                        canonical_class_id: 0,
                        member_count: 2,
                        sha256: digest.to_string(),
                    },
                ],
            };
        let certificate_binding_v6 = crate::fem_eigen::OwnedModalCertificateV6Binding::test_fixture(
            digest,
            view(1, 1, "magnetic:fixture"),
            view(2, 1, "magnetic:fixture"),
            view(1, 2, "airbox:fixture"),
            view(2, 2, "airbox:fixture"),
        );
        NativeModalEigenSharedDomainProblem {
            mesh,
            equilibrium_m0_xyz: m0.clone(),
            linearization_m0_xyz: m0.clone(),
            linearization_h_eff0_xyz: m0,
            linearization_h_demag0_xyz: vec![0.0; 3 * node_count],
            linearization_phi0: vec![0.0; node_count],
            equilibrium_id: "equilibrium:accepted".to_string(),
            mesh_snapshot_id: "mesh:accepted".to_string(),
            material_snapshot_id: "material:accepted".to_string(),
            physics_snapshot_id: "physics:accepted".to_string(),
            boundary_snapshot_id: "boundary:accepted".to_string(),
            producer_run_id: "run:accepted".to_string(),
            equilibrium_content_sha256: digest.to_string(),
            demag_model: "poisson_robin".to_string(),
            m0_norm_tolerance: 1.0e-8,
            acceptance_criterion: "energy".to_string(),
            acceptance_metric_kind: "total_energy_plateau_range_j".to_string(),
            acceptance_unit: "J".to_string(),
            acceptance_metric_value: 2.5e-19,
            acceptance_threshold: 1.0e-18,
            acceptance_certificate_sha256: digest.to_string(),
            saturation_magnetisation_a_per_m: Vec::new(),
            uniform_saturation_magnetisation_a_per_m: 8.0e5,
            gamma0_m_per_a_s: 2.211e5,
            tangent_frame_xyz: frames,
            external_field_h_ext0_xyz: vec![0.0; 3 * node_count],
            alpha_per_node: vec![0.01; node_count],
            term_presence_mask: (1 << 0) | (1 << 1) | (1 << 4),
            exchange_term_digest: Some(digest.to_string()),
            field_term_digest: Some(digest.to_string()),
            demag_term_digest: Some(digest.to_string()),
            operator_input_digest: digest.to_string(),
            demag_provider_signature: Some(digest.to_string()),
            exchange_stiffness_j_per_m: Some(1.3e-11),
            scalar_reduced_node: vec![0, 0, 0, 0, 1],
            scalar_reduced_node_count: 2,
            magnetic_reduced_node: vec![0, 0, 0, 0, u32::MAX],
            magnetic_reduced_node_count: 1,
            magnetic_pair_count: 1,
            airbox_pair_count: 1,
            boundary_kind: "robin".to_string(),
            robin_beta: 1.0,
            boundary_marker: 1,
            equilibrium_digest: digest.to_string(),
            mesh_certificate_digest: digest.to_string(),
            mesh_certificate_schema: "periodic_mesh_certificate.v6".to_string(),
            mesh_certificate_map_binding_digest: digest.to_string(),
            linearization_state_digest: digest.to_string(),
            mesh_generation_identity: certificate_binding_v6.mesh_generation_identity.clone(),
            canonical_preimage: certificate_binding_v6.canonical_preimage.clone(),
            canonical_preimage_sha256: certificate_binding_v6.canonical_preimage_sha256.clone(),
            magnetic_class_digest_sha256: certificate_binding_v6
                .magnetic_class_digest_sha256
                .clone(),
            scalar_class_digest_sha256: certificate_binding_v6.scalar_class_digest_sha256.clone(),
            certificate_binding_status: 1,
            certificate_binding_reason: "none".to_string(),
            certificate_binding_v6,
            _marker: std::marker::PhantomData,
        }
    }

    #[test]
    fn shared_domain_ffi_envelope_covers_full_global_descriptor_contract() {
        let mesh = shared_domain_mesh_with_air_only_node();
        let problem = shared_domain_ffi_problem(&mesh);

        assert_eq!(problem.acceptance_criterion, "energy");
        assert_eq!(
            problem.acceptance_metric_kind,
            "total_energy_plateau_range_j"
        );
        assert_eq!(problem.acceptance_unit, "J");
        assert_eq!(problem.acceptance_metric_value, 2.5e-19);
        assert_eq!(problem.acceptance_threshold, 1.0e-18);
        assert!(problem.acceptance_certificate_sha256.starts_with("sha256:"));

        let cpu_envelope = problem
            .ffi_envelope_contract_for_target(NativeModalExecutionTarget::ProductionCpu)
            .expect("complete full-node descriptor must validate");
        let gpu_envelope = problem
            .ffi_envelope_contract_for_target(NativeModalExecutionTarget::ProductionGpu)
            .expect("the same complete certificate must validate for GPU");
        assert_eq!(cpu_envelope, gpu_envelope);
        let envelope = cpu_envelope;

        let mut torque_problem = shared_domain_ffi_problem(&mesh);
        torque_problem.acceptance_criterion = "torque".to_string();
        torque_problem.acceptance_metric_kind = "max_torque_apm".to_string();
        torque_problem.acceptance_unit = "A/m".to_string();
        torque_problem.acceptance_metric_value = 0.25;
        torque_problem.acceptance_threshold = 0.5;
        let torque_cpu = torque_problem
            .ffi_envelope_contract_for_target(NativeModalExecutionTarget::ProductionCpu)
            .expect("torque certificate must validate for CPU");
        let torque_gpu = torque_problem
            .ffi_envelope_contract_for_target(NativeModalExecutionTarget::ProductionGpu)
            .expect("torque certificate must validate for GPU");
        assert_eq!(torque_cpu, torque_gpu);

        assert!(envelope.descriptor_required);
        assert_eq!(envelope.node_count, 5);
        assert_eq!(envelope.tangent_frame_count, 30);
        assert_eq!(envelope.equilibrium_m0_count, 15);
        assert_eq!(envelope.effective_field_count, 15);
        assert_eq!(envelope.external_field_count, 15);
        assert_eq!(envelope.alpha_count, 5);
        assert!(envelope.legacy_a_qq_is_null);
        assert_eq!(envelope.term_presence_mask, 0b1_0011);
        assert!(envelope.exchange_material_view_present);
        assert!(envelope.demag_provider_bound_to_operator_input);
    }

    #[test]
    fn production_shared_domain_request_accepts_only_the_certified_payload() {
        validate_native_modal_request_payload_ownership(
            NativeModalExecutionTarget::ProductionCpu,
            true,
            true,
            false,
            false,
            false,
            false,
        )
        .expect("certified shared-domain payload without a runner pencil must be accepted");

        let error = validate_native_modal_request_payload_ownership(
            NativeModalExecutionTarget::ProductionCpu,
            true,
            true,
            true,
            false,
            false,
            false,
        )
        .expect_err("shared-domain production must reject the runner MFEM pencil");
        assert!(error.contains("must not transport a runner-assembled operator"));
    }

    #[test]
    fn production_demag_request_without_shared_domain_payload_fails_closed() {
        let error = validate_native_modal_request_payload_ownership(
            NativeModalExecutionTarget::ProductionGpu,
            true,
            false,
            false,
            false,
            false,
            false,
        )
        .expect_err("production demag without the certified shared-domain payload must fail");
        assert!(error.contains("requires a certified shared-domain payload"));
    }

    #[test]
    fn planned_modal_attestation_rejects_cpu_gpu_target_mismatch() {
        let cpu_error = validate_planned_modal_execution_attestation(
            fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            NativeModalExecutionTarget::ProductionCpu,
            Some(2),
            0,
            "k0_poisson_airbox_cpu_schur_slepc",
        )
        .expect_err("CPU request returning GPU target must fail closed");
        assert!(cpu_error.contains("native_modal_execution_target_mismatch"));

        let gpu_error = validate_planned_modal_execution_attestation(
            fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
            NativeModalExecutionTarget::ProductionGpu,
            Some(1),
            0,
            "gpu_modal_device_krylov",
        )
        .expect_err("GPU request returning CPU target must fail closed");
        assert!(gpu_error.contains("native_modal_execution_target_mismatch"));
    }

    #[test]
    fn planned_modal_attestation_rejects_fallback_and_unknown_engine_response() {
        let fallback_error = validate_planned_modal_execution_attestation(
            fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            NativeModalExecutionTarget::ProductionCpu,
            Some(1),
            1,
            "k0_poisson_airbox_cpu_schur_slepc",
        )
        .expect_err("runtime fallback is forbidden after planning");
        assert!(fallback_error.contains("native_modal_runtime_fallback_forbidden"));

        let engine_error = validate_planned_modal_execution_attestation(
            fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
            NativeModalExecutionTarget::ProductionGpu,
            Some(2),
            0,
            "",
        )
        .expect_err("empty native engine response must fail closed");
        assert!(engine_error.contains("native_modal_engine_mismatch"));
    }

    #[test]
    fn planned_gpu_modal_attestation_accepts_only_canonical_or_adapter_engine_id() {
        for engine_id in [
            "gpu_modal_device_krylov",
            "k0_poisson_airbox_gpu_petsc_slepc",
        ] {
            validate_planned_modal_execution_attestation(
                fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
                NativeModalExecutionTarget::ProductionGpu,
                Some(2),
                0,
                engine_id,
            )
            .expect("canonical GPU engine and its explicit native adapter alias are accepted");
        }

        let error = validate_planned_modal_execution_attestation(
            fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
            NativeModalExecutionTarget::ProductionGpu,
            Some(2),
            0,
            "fem_eigen_native_gpu",
        )
        .expect_err("broad legacy engine id must not attest the exact GPU lane");
        assert!(error.contains("native_modal_engine_mismatch"));
    }

    #[test]
    fn validation_oracle_may_keep_its_explicit_runner_pencil() {
        validate_native_modal_request_payload_ownership(
            NativeModalExecutionTarget::Auto,
            false,
            true,
            true,
            false,
            false,
            true,
        )
        .expect("the validation-only oracle remains separate from production ownership rules");
    }

    #[test]
    fn shared_domain_ffi_envelope_rejects_state_frame_and_provider_mutations() {
        let mesh = shared_domain_mesh_with_air_only_node();
        let mut state_mutation = shared_domain_ffi_problem(&mesh);
        state_mutation.equilibrium_m0_xyz[0] = 0.5;
        assert!(state_mutation
            .ffi_envelope_contract()
            .expect_err("payload state mutation must fail")
            .contains("equilibrium does not match accepted m0"));

        let mut frame_mutation = shared_domain_ffi_problem(&mesh);
        frame_mutation.tangent_frame_xyz[0] = 0.0;
        assert!(frame_mutation
            .ffi_envelope_contract()
            .expect_err("frame mutation must fail")
            .contains("tangent frame is invalid"));

        let mut provider_mutation = shared_domain_ffi_problem(&mesh);
        provider_mutation.demag_provider_signature = Some(
            "sha256:2222222222222222222222222222222222222222222222222222222222222222".to_string(),
        );
        assert!(provider_mutation
            .ffi_envelope_contract()
            .expect_err("provider mutation must fail")
            .contains("does not bind operator input"));

        let mut missing_acceptance = shared_domain_ffi_problem(&mesh);
        missing_acceptance.acceptance_certificate_sha256.clear();
        assert!(missing_acceptance
            .ffi_envelope_contract()
            .expect_err("missing acceptance certificate must fail")
            .contains("certificate digest"));

        let mut unsatisfied_acceptance = shared_domain_ffi_problem(&mesh);
        unsatisfied_acceptance.acceptance_metric_value = 2.0e-18;
        assert!(unsatisfied_acceptance
            .ffi_envelope_contract()
            .expect_err("unsatisfied acceptance metric must fail")
            .contains("invalid or unsatisfied"));

        let mut incoherent_acceptance = shared_domain_ffi_problem(&mesh);
        incoherent_acceptance.acceptance_unit = "A/m".to_string();
        assert!(incoherent_acceptance
            .ffi_envelope_contract()
            .expect_err("incoherent acceptance tuple must fail")
            .contains("tuple is incoherent"));
    }

    #[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
    #[test]
    fn shared_domain_ffi_payload_uses_descriptor_and_null_legacy_csr() {
        let mesh = shared_domain_mesh_with_air_only_node();
        let problem = shared_domain_ffi_problem(&mesh);
        let envelope = problem.ffi_envelope_contract().unwrap();
        let mesh_descriptor = unsafe { std::mem::zeroed::<ffi::fullmag_fem_mesh_desc>() };
        let descriptor =
            unsafe { std::mem::zeroed::<ffi::FullmagFemModalLinearizationDescriptor>() };
        let material = unsafe { std::mem::zeroed::<ffi::FullmagFemModalExchangeMaterialView>() };
        let value = std::ffi::CString::new("fixture").unwrap();
        let acceptance_criterion = std::ffi::CString::new("energy").unwrap();
        let acceptance_metric_kind =
            std::ffi::CString::new("total_energy_plateau_range_j").unwrap();
        let acceptance_unit = std::ffi::CString::new("J").unwrap();
        let acceptance_digest = std::ffi::CString::new(
            "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        )
        .unwrap();
        let certificate_ffi =
            NativeModalCertificateV6FfiBinding::new(&problem.certificate_binding_v6).unwrap();
        let certificate_request = certificate_ffi.as_request();
        let payload = problem.ffi_payload(
            &mesh_descriptor,
            &value, // boundary kind
            &value, // equilibrium digest
            &value, // certificate digest
            &value, // certificate schema
            &value, // map-binding digest
            &value, // linearization state digest
            &value, // mesh generation identity
            &value, // canonical preimage
            &value, // canonical preimage digest
            &value, // magnetic class digest
            &value, // scalar class digest
            &value, // accepted reason
            &value, // boundary/gauge digest
            &value, // bias sample id
            &value, // bias sample signature
            &value, // magnetic part identity
            &value, // airbox part identity
            &certificate_request,
            &value, // equilibrium id
            &value, // mesh snapshot id
            &value, // material snapshot id
            &value, // physics snapshot id
            &value, // boundary snapshot id
            &value, // producer run id
            &value, // equilibrium content digest
            &value, // demag model
            &acceptance_criterion,
            &acceptance_metric_kind,
            &acceptance_unit,
            &acceptance_digest,
            &descriptor,
            Some(&material),
            &envelope,
        );

        assert_eq!(payload.linearization_descriptor, &descriptor);
        assert_eq!(payload.exchange_material_view, &material);
        assert_eq!(payload.linearization_m0_xyz_count, 15);
        assert_eq!(payload.linearization_h_eff0_xyz_count, 15);
        assert_eq!(payload.linearization_h_demag0_xyz_count, 15);
        assert_eq!(payload.magnetic_a_qq_csr.row_count, 0);
        assert_eq!(payload.magnetic_a_qq_csr.row_offsets_len, 0);
        assert!(payload.magnetic_a_qq_csr.row_offsets.is_null());
        assert!(payload.magnetic_a_qq_csr.column_indices.is_null());
        assert!(payload.magnetic_a_qq_csr.values.is_null());
        assert_eq!(payload.certificate_binding_status, 1);
        assert_eq!(payload.certificate_binding_v6, &certificate_request);
        assert!(!payload.boundary_gauge_digest.is_null());
        assert!(!payload.bias_field_sample_id.is_null());
        assert!(!payload.bias_field_sample_signature.is_null());
        assert!(!payload.magnetic_part_identity.is_null());
        assert!(!payload.airbox_part_identity.is_null());
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(payload.acceptance_criterion) }
                .to_str()
                .unwrap(),
            "energy"
        );
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(payload.acceptance_metric_kind) }
                .to_str()
                .unwrap(),
            "total_energy_plateau_range_j"
        );
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(payload.acceptance_unit) }
                .to_str()
                .unwrap(),
            "J"
        );
        assert_eq!(payload.acceptance_metric_value, 2.5e-19);
        assert_eq!(payload.acceptance_threshold, 1.0e-18);
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(payload.acceptance_certificate_sha256) }
                .to_str()
                .unwrap(),
            acceptance_digest.to_str().unwrap()
        );
        assert_eq!(certificate_request.mesh_magnetic.node_count, 2);
        assert_eq!(certificate_request.payload_magnetic.view_kind, 2);
        assert_eq!(certificate_request.mesh_scalar.part_role, 2);
        assert_eq!(
            certificate_request.payload_scalar.require_complete_closure,
            1
        );

        let nested_request = unsafe {
            payload
                .certificate_binding_v6
                .as_ref()
                .expect("outer request must retain the v6 certificate binding")
        };
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(nested_request.schema_version) }
                .to_str()
                .unwrap(),
            "periodic_mesh_certificate.v6"
        );
        for (ffi_view, owned_view) in [
            (
                &nested_request.mesh_magnetic,
                &problem.certificate_binding_v6.mesh_magnetic,
            ),
            (
                &nested_request.payload_magnetic,
                &problem.certificate_binding_v6.payload_magnetic,
            ),
            (
                &nested_request.mesh_scalar,
                &problem.certificate_binding_v6.mesh_scalar,
            ),
            (
                &nested_request.payload_scalar,
                &problem.certificate_binding_v6.payload_scalar,
            ),
        ] {
            assert_eq!(ffi_view.view_kind, owned_view.view_kind);
            assert_eq!(ffi_view.part_role, owned_view.part_role);
            assert_eq!(ffi_view.node_count as usize, owned_view.region_ids.len());
            assert_eq!(
                unsafe { std::ffi::CStr::from_ptr(ffi_view.part_identity) }
                    .to_str()
                    .unwrap(),
                owned_view.part_identity
            );
            assert_eq!(
                unsafe { std::ffi::CStr::from_ptr(ffi_view.topology_fingerprint) }
                    .to_str()
                    .unwrap(),
                owned_view.topology_fingerprint
            );
            assert_eq!(
                unsafe {
                    std::slice::from_raw_parts(ffi_view.region_ids, ffi_view.node_count as usize)
                },
                owned_view.region_ids
            );
            assert_eq!(
                unsafe {
                    std::slice::from_raw_parts(
                        ffi_view.boundary_axis_masks,
                        ffi_view.node_count as usize,
                    )
                },
                owned_view.boundary_axis_masks
            );
            let ffi_roles = unsafe {
                std::slice::from_raw_parts(
                    ffi_view.region_roles,
                    ffi_view.region_role_count as usize,
                )
            };
            assert_eq!(ffi_roles.len(), owned_view.region_roles.len());
            for (actual, expected) in ffi_roles.iter().zip(&owned_view.region_roles) {
                assert_eq!(actual.region_id, expected.region_id);
                assert_eq!(actual.part_role, expected.part_role);
            }
            for (actual, expected) in unsafe {
                std::slice::from_raw_parts(
                    ffi_view.generator_relations,
                    ffi_view.generator_relation_count as usize,
                )
            }
            .iter()
            .zip(&owned_view.generator_relations)
            {
                assert_eq!(actual.source_node, expected.source_node);
                assert_eq!(actual.destination_node, expected.destination_node);
                assert_eq!(actual.axis_mask, expected.axis_mask);
                assert_eq!(actual.kind, expected.kind);
            }
            assert_eq!(
                ffi_view.generator_relation_count as usize,
                owned_view.generator_relations.len()
            );
            for (actual, expected) in unsafe {
                std::slice::from_raw_parts(
                    ffi_view.closure_relations,
                    ffi_view.closure_relation_count as usize,
                )
            }
            .iter()
            .zip(&owned_view.closure_relations)
            {
                assert_eq!(actual.source_node, expected.source_node);
                assert_eq!(actual.destination_node, expected.destination_node);
                assert_eq!(actual.axis_mask, expected.axis_mask);
                assert_eq!(actual.kind, expected.kind);
            }
            assert_eq!(
                ffi_view.closure_relation_count as usize,
                owned_view.closure_relations.len()
            );
            assert_eq!(ffi_view.require_complete_closure, 1);
            assert_eq!(
                unsafe {
                    std::slice::from_raw_parts(
                        ffi_view.expected_class_ids,
                        ffi_view.expected_class_id_count as usize,
                    )
                },
                owned_view.expected_class_ids
            );
            let ffi_digests = unsafe {
                std::slice::from_raw_parts(
                    ffi_view.expected_class_digests,
                    ffi_view.expected_class_digest_count as usize,
                )
            };
            assert_eq!(ffi_digests.len(), owned_view.expected_class_digests.len());
            for (actual, expected) in ffi_digests.iter().zip(&owned_view.expected_class_digests) {
                assert_eq!(actual.canonical_class_id, expected.canonical_class_id);
                assert_eq!(actual.member_count, expected.member_count);
                assert_eq!(
                    unsafe { std::ffi::CStr::from_ptr(actual.sha256) }
                        .to_str()
                        .unwrap(),
                    expected.sha256
                );
            }
        }
    }

    #[test]
    fn native_frequency_response_reports_unavailable_without_fem_gpu_feature() {
        #[cfg(not(feature = "fem-gpu"))]
        {
            let frequencies_hz = [1.0e9];
            let err =
                solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
                    node_count: 2,
                    tangent_dof_count: 4,
                    alpha: 0.01,
                    gamma0: 2.211e5,
                    execution_lane: NativeFrequencyDomainExecutionLane::Validation,
                    frequencies_hz: &frequencies_hz,
                    output_directory: Path::new(""),
                    write_response_fields: false,
                    write_partial_artifacts: false,
                    operator_diagnostics_json: None,
                    interrupt_requested: None,
                    cancel_requested: None,
                    progress_callback: None,
                    requires_periodic_airbox_dynamic_demag: false,
                    requires_floquet_airbox_dynamic_demag: false,
                    magnetic_periodic_constraint_set_count: 0,
                    magnetostatic_periodic_constraint_set_count: 0,
                    periodic_airbox_delta_m_tangent_dof_count: 0,
                    periodic_airbox_delta_phi_dof_count: 0,
                    periodic_airbox_magnetostatic_periodic_node_pairs: &[],
                    periodic_airbox_coupled_block_problem: None,
                    tiny_validation_problem: None,
                    mfem_operator_problem: None,
                })
                .expect_err("native solve should require fem-gpu feature");
            assert!(err.contains("fem-gpu"));
        }
    }

    #[test]
    fn native_frequency_domain_unavailable_modal_contract_is_structured() {
        #[cfg(not(any(feature = "fem-gpu", feature = "fem-native")))]
        {
            let err = solve_native_modal_eigen(NativeModalEigenRequest {
                mesh_asset_id: "mesh",
                equilibrium_source_kind: "relax",
                gamma_rad_s_t: 1.760859e11,
                mu0_t_m_a: 1.25663706212e-6,
                alpha: 0.01,
                include_exchange: true,
                include_demag: false,
                demag_realization: None,
                damping_policy: "include",
                spin_wave_bc_kind: "free",
                k_vector_rad_m: None,
                operator_diagnostics_json: None,
                requested_mode_count: 8,
                target_kind: "frequency_window",
                target_frequency_hz: 0.0,
                frequency_min_hz: 1.0e8,
                frequency_max_hz: 5.0e9,
                residual_tolerance: 1.0e-8,
                max_outer_iterations: 32,
                max_linear_iterations: 128,
                output_directory: None,
                write_partial_artifacts: false,
                completeness_policy: 0,
                eigensolver_family: 0,
                spectral_transform_kind: 0,
                execution_target: NativeModalExecutionTarget::Auto,
                cancel_requested: None,
                progress_callback: None,
                tiny_validation_problem: None,
                mfem_operator_problem: None,
                mfem_sparse_operator_problem: None,
                poisson_airbox_block_problem: None,
                shared_domain_problem: None,
            })
            .expect_err("native modal contract should require fem-native feature");
            assert!(err.contains("fem-native"));
        }

        #[cfg(feature = "fem-gpu")]
        {
            let result = solve_native_modal_eigen(NativeModalEigenRequest {
                mesh_asset_id: "mesh",
                equilibrium_source_kind: "relax",
                gamma_rad_s_t: 1.760859e11,
                mu0_t_m_a: 1.25663706212e-6,
                alpha: 0.01,
                include_exchange: true,
                include_demag: false,
                demag_realization: None,
                damping_policy: "include",
                spin_wave_bc_kind: "free",
                k_vector_rad_m: None,
                operator_diagnostics_json: None,
                requested_mode_count: 8,
                target_kind: "frequency_window",
                target_frequency_hz: 0.0,
                frequency_min_hz: 1.0e8,
                frequency_max_hz: 5.0e9,
                residual_tolerance: 1.0e-8,
                max_outer_iterations: 32,
                max_linear_iterations: 128,
                output_directory: None,
                write_partial_artifacts: false,
                completeness_policy: 0,
                eigensolver_family: 0,
                spectral_transform_kind: 0,
                execution_target: NativeModalExecutionTarget::Auto,
                cancel_requested: None,
                progress_callback: None,
                tiny_validation_problem: None,
                mfem_operator_problem: None,
                mfem_sparse_operator_problem: None,
                poisson_airbox_block_problem: None,
                shared_domain_problem: None,
            })
            .expect("native modal contract should return a structured unavailable result");
            assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
            assert!(result.error_message.contains("modal_eigen"));
            assert!(result
                .diagnostics_json
                .contains("\"study_product\":\"modal_eigen\""));
            assert!(result
                .diagnostics_json
                .contains("\"unsupported_reason\":\"modal_solver_not_implemented\""));
            assert!(result.result_json.contains("\"status\":\"unavailable\""));
        }
    }

    #[test]
    fn native_floquet_pair_phase_metadata_rejects_inconsistent_phase() {
        let pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-6, 0.0, 0.0]),
            phase_rad: Some(-0.5),
        }];

        let err = validate_floquet_pair_phase_metadata(Some([1.0e6, 0.0, 0.0]), &pairs)
            .expect_err("inconsistent Floquet phase metadata should reject");

        assert!(err.contains("Floquet phase"), "{err}");
        assert!(err.contains("x_faces"), "{err}");
        assert!(err.contains("-1"), "{err}");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_domain_operator_diagnostics_are_embedded_in_modal_contract_results() {
        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mesh",
            equilibrium_source_kind: "relax",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.01,
            include_exchange: true,
            include_demag: false,
            demag_realization: None,
            damping_policy: "include",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"active_node_count\":4,\"tangent_dof_count\":8}",
            ),
            requested_mode_count: 8,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
            residual_tolerance: 1.0e-8,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: None,
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
        })
        .expect("native modal contract should return a structured unavailable result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
        assert!(result
            .diagnostics_json
            .contains("\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""), "{}", result.diagnostics_json);
        assert!(
            result.diagnostics_json.contains("\"active_node_count\":4"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"tangent_dof_count\":8"),
            "{}",
            result.diagnostics_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn modal_shift_invert_progress_reports_validation_solve() {
        use std::cell::RefCell;

        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];
        let progress_events = RefCell::new(Vec::<String>::new());
        let progress_callback = |progress_json: &str| {
            progress_events.borrow_mut().push(progress_json.to_string());
        };

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "macrospin_validation",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: None,
            requested_mode_count: 1,
            target_kind: "nearest_frequency",
            target_frequency_hz: 0.16,
            frequency_min_hz: 0.0,
            frequency_max_hz: 1.0,
            residual_tolerance: 1.0e-12,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: None,
            progress_callback: Some(&progress_callback),
            tiny_validation_problem: Some(NativeModalEigenTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                mass_matrix_row_major: Some(&gyrotropic_mass_row_major),
                stiffness_diagonal: None,
                mass_diagonal: None,
            }),
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
            shared_domain_problem: None,
        })
        .expect("native modal validation solve should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        let progress_events = progress_events.into_inner();
        assert_eq!(progress_events.len(), 1);
        assert!(progress_events[0].contains("\"solver_phase\":\"solving_shift_invert\""));
        assert!(progress_events[0].contains("\"outer_iteration\":1"));
        assert!(progress_events[0].contains("\"linear_iteration\":1"));
        assert!(progress_events[0].contains("\"accepted_mode_count\":1"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn modal_shift_invert_progress_cancel_returns_interrupted() {
        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];
        let cancel_callback = || true;

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "macrospin_validation",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: None,
            requested_mode_count: 1,
            target_kind: "nearest_frequency",
            target_frequency_hz: 0.16,
            frequency_min_hz: 0.0,
            frequency_max_hz: 1.0,
            residual_tolerance: 1.0e-12,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: Some(&cancel_callback),
            progress_callback: None,
            tiny_validation_problem: Some(NativeModalEigenTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                mass_matrix_row_major: Some(&gyrotropic_mass_row_major),
                stiffness_diagonal: None,
                mass_diagonal: None,
            }),
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
            shared_domain_problem: None,
        })
        .expect("native modal validation cancel should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Interrupted);
        assert!(result
            .diagnostics_json
            .contains("\"status\":\"interrupted\""));
        assert!(result
            .diagnostics_json
            .contains("\"stop_reason\":\"cancel_requested\""));
        assert!(result.result_json.contains("\"status\":\"interrupted\""));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_window_reports_window_diagnostics() {
        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "macrospin_validation",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: None,
            requested_mode_count: 1,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-12,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 0,
            eigensolver_family: 0,
            spectral_transform_kind: 0,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: Some(NativeModalEigenTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                mass_matrix_row_major: Some(&gyrotropic_mass_row_major),
                stiffness_diagonal: None,
                mass_diagonal: None,
            }),
            mfem_operator_problem: None,
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
            shared_domain_problem: None,
        })
        .expect("native modal frequency-window validation solve should return a result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(
            result.diagnostics_json.contains("\"requested_window_hz\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"resolved_search_window_hz\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"window_completeness\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"policy\":\"best_effort\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"status\":\"not_certified\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"subwindows\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .result_json
                .contains("\"window_completeness\":\"not_certified\""),
            "{}",
            result.result_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_window_mfem_payload_passes_dependency_digest_and_gamma_through_ffi() {
        use std::cell::RefCell;

        let stiffness_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 2.0, 0.0, //
            0.0, 0.0, 0.0, 2.0,
        ];
        let gyrotropic_mass_row_major = [
            0.0, -1.0, 0.0, 0.0, //
            1.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 0.0, -1.0, //
            0.0, 0.0, 1.0, 0.0,
        ];
        let mass_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ];
        let progress_events = RefCell::new(Vec::<String>::new());
        let progress_callback = |progress_json: &str| {
            progress_events.borrow_mut().push(progress_json.to_string());
        };

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mfem_dense_payload",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"payload_kind\":\"dense_linearized_mfem_operator\"}",
            ),
            requested_mode_count: 4,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-10,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 1,
            eigensolver_family: 2,
            spectral_transform_kind: 0,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: None,
            progress_callback: Some(&progress_callback),
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeModalEigenMfemOperatorProblem {
                tangent_dof_count: 4,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                gyrotropic_matrix_row_major: Some(&gyrotropic_mass_row_major),
                mass_matrix_row_major: Some(&mass_matrix_row_major),
                linearized_pencil_dependency_digest: Some("modal-payload-dependency-v1"),
                linearized_pencil_gamma0_m_per_a_s: 1.0,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
            }),
            mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
        })
        .expect("native modal production payload should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(
            result
                .diagnostics_json
                .contains("\"execution_lane\":\"production_cpu\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"mfem_operator_payload\":\"dense_gyrotropic_matrix\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains(
                "\"linearized_dynamic_pencil_dependency_digest\":\"modal-payload-dependency-v1\""
            ),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"linearized_dynamic_pencil_gamma0_m_per_a_s\":1"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"resolved_solver_family\":\"contour_interval\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"solver_model\":\"contour_interval_production_cpu_dense\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains(
                "\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""
            ),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .result_json
                .contains("\"window_completeness\":\"certified\""),
            "{}",
            result.result_json
        );
        assert!(
            result.result_json.contains("\"accepted_mode_count\":2"),
            "{}",
            result.result_json
        );
        assert_eq!(progress_events.into_inner().len(), 16);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_window_mfem_payload_uses_production_shift_invert_when_requested() {
        let stiffness_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 2.0, 0.0, //
            0.0, 0.0, 0.0, 2.0,
        ];
        let gyrotropic_mass_row_major = [
            0.0, -1.0, 0.0, 0.0, //
            1.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 0.0, -1.0, //
            0.0, 0.0, 1.0, 0.0,
        ];
        let mass_matrix_row_major = [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ];

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mfem_dense_shift_invert_payload",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: false,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"payload_kind\":\"dense_linearized_mfem_operator\"}",
            ),
            requested_mode_count: 2,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-10,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 1,
            eigensolver_family: 1,
            spectral_transform_kind: 1,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeModalEigenMfemOperatorProblem {
                tangent_dof_count: 4,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                gyrotropic_matrix_row_major: Some(&gyrotropic_mass_row_major),
                mass_matrix_row_major: Some(&mass_matrix_row_major),
                linearized_pencil_dependency_digest: None,
                linearized_pencil_gamma0_m_per_a_s: 0.0,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
            }),
            mfem_sparse_operator_problem: None,
        poisson_airbox_block_problem: None,
        shared_domain_problem: None,
        })
        .expect("native modal shift-invert payload should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert!(
            result
                .diagnostics_json
                .contains("\"resolved_solver_family\":\"shift_invert\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"solver_model\":\"slepc_multi_shift_invert_production_cpu_dense\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.result_json.contains("\"accepted_mode_count\":2"),
            "{}",
            result.result_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn modal_floquet_periodic_pairs_are_forwarded_to_native_diagnostics() {
        let stiffness_matrix_row_major = [1.0, 0.0, 0.0, 1.0];
        let gyrotropic_mass_row_major = [0.0, -1.0, 1.0, 0.0];
        let k_vector_rad_m = [1.0e6, 0.0, 0.0];
        let floquet_pairs = [NativeModalEigenFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-6, 0.0, 0.0]),
            phase_rad: Some(-1.0),
        }];

        let result = solve_native_modal_eigen(NativeModalEigenRequest {
            mesh_asset_id: "mfem_modal_floquet_payload",
            equilibrium_source_kind: "provided",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.0,
            include_exchange: true,
            include_demag: false,
            demag_realization: None,
            damping_policy: "ignore",
            spin_wave_bc_kind: "floquet",
            k_vector_rad_m: Some(&k_vector_rad_m),
            operator_diagnostics_json: None,
            requested_mode_count: 2,
            target_kind: "frequency_window",
            target_frequency_hz: 0.0,
            frequency_min_hz: 0.1,
            frequency_max_hz: 0.5,
            residual_tolerance: 1.0e-10,
            max_outer_iterations: 32,
            max_linear_iterations: 128,
            output_directory: None,
            write_partial_artifacts: false,
            completeness_policy: 1,
            eigensolver_family: 1,
            spectral_transform_kind: 1,
            execution_target: NativeModalExecutionTarget::Auto,
            cancel_requested: None,
            progress_callback: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeModalEigenMfemOperatorProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: Some(&stiffness_matrix_row_major),
                gyrotropic_matrix_row_major: Some(&gyrotropic_mass_row_major),
                mass_matrix_row_major: None,
                linearized_pencil_dependency_digest: None,
                linearized_pencil_gamma0_m_per_a_s: 0.0,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
            }),
            mfem_sparse_operator_problem: None,
            poisson_airbox_block_problem: None,
            shared_domain_problem: None,
        })
        .expect("native modal Floquet payload should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
        assert!(
            result
                .diagnostics_json
                .contains("\"production_cpu_rejection_reason\":\"production_cpu_modal_nonzero_k_floquet_operator_missing\""),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"floquet_periodic_pair_count\":1"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result
                .diagnostics_json
                .contains("\"modal_periodic_pair_contract_available\":true"),
            "{}",
            result.diagnostics_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn frequency_domain_operator_diagnostics_are_embedded_in_driven_contract_results() {
        let frequencies_hz = [1.0e9];
        let excitation_field_a_m = [0.0, 0.0, 1.0];
        let result = solve_native_driven_response_contract(NativeDrivenResponseContractRequest {
            mesh_asset_id: "mesh",
            equilibrium_source_kind: "relax",
            gamma_rad_s_t: 1.760859e11,
            mu0_t_m_a: 1.25663706212e-6,
            alpha: 0.01,
            include_exchange: true,
            include_demag: false,
            demag_realization: None,
            damping_policy: "include",
            spin_wave_bc_kind: "free",
            k_vector_rad_m: None,
            operator_diagnostics_json: Some(
                "{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\",\"active_node_count\":6,\"tangent_dof_count\":12}",
            ),
            frequencies_hz: &frequencies_hz,
            excitation_field_a_m: &excitation_field_a_m,
            excitation_phase_rad: 0.0,
            residual_tolerance: 1.0e-8,
            max_linear_iterations: 64,
            output_directory: None,
            write_partial_artifacts: false,
        })
        .expect("native driven contract should return a structured validation result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::ValidationError);
        assert!(result
            .diagnostics_json
            .contains("\"operator_diagnostics\":{\"schema_version\":\"frequency_domain_operator_diagnostics.v1\""), "{}", result.diagnostics_json);
        assert!(
            result.diagnostics_json.contains("\"active_node_count\":6"),
            "{}",
            result.diagnostics_json
        );
        assert!(
            result.diagnostics_json.contains("\"tangent_dof_count\":12"),
            "{}",
            result.diagnostics_json
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_rejects_invalid_floquet_pair_id_before_ffi() {
        let frequencies_hz = [1.0e9];
        let equilibrium_m = [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [0.0, 1.0, 0.0, 1.0];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("bad\0pair"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-9, 0.0, 0.0]),
            phase_rad: Some(0.25),
        }];

        let err = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new("/tmp"),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.0e7, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect_err("invalid Floquet pair id should reject before C ABI call");

        assert!(err.contains("Floquet pair id contains NUL"), "{err}");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_rejects_nonperiodic_floquet_drive_through_native_call() {
        let frequencies_hz = [1.0e9];
        let equilibrium_m = [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [0.0, 1.0, 0.0, 1.0];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-9, 0.0, 0.0]),
            phase_rad: Some(-0.01),
        }];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new("/tmp"),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.0e7, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::ValidationError);
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result
            .error_message
            .contains("Floquet-periodic tangent drive"));
        assert!(result
            .diagnostics_json
            .contains("frequency_domain_response_diagnostics.v1"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(!result
            .diagnostics_json
            .contains("\"unsupported_reason\":\"floquet_bloch_nonzero_k\""));
        assert!(result
            .result_json
            .contains("\"status\":\"validation_error\""));
        assert_eq!(result.artifact_manifest_path, "");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_floquet_drive_validation_writes_partial_artifacts() {
        let frequencies_hz = [1.0e9, 2.0e9];
        let equilibrium_m = [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [0.0, 1.0, 0.0, 1.0];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-9, 0.0, 0.0]),
            phase_rad: Some(-0.01),
        }];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-floquet-unavailable-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: false,
            write_partial_artifacts: true,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.0e7, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::ValidationError);
        assert_eq!(result.total_frequency_count, 2);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result
            .diagnostics_json
            .contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(result
            .artifact_manifest_path
            .ends_with("frequency_domain/manifest.v1.json"));
        let manifest = std::fs::read_to_string(&result.artifact_manifest_path)
            .expect("Floquet drive-validation manifest should be readable");
        assert!(manifest.contains("\"status\":\"validation_error\""));
        assert!(manifest.contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(!manifest.contains("response/magnetic_response_sweep.v1.json"));
        let diagnostics =
            std::fs::read_to_string(output_dir.join("response/diagnostics/solver.v1.json"))
                .expect("Floquet drive-validation diagnostics should be readable");
        assert!(diagnostics.contains("\"validation_error\":\"floquet_drive_phase_mismatch\""));
        assert!(!diagnostics.contains("\"unsupported_reason\":\"floquet_bloch_nonzero_k\""));
        let progress = std::fs::read_to_string(output_dir.join("response/progress.v1.json"))
            .expect("Floquet drive-validation progress should be readable");
        assert!(progress.contains("\"total_frequency_points\":2"));
        assert!(progress.contains("\"completed_frequency_points\":0"));
        assert!(progress.contains("\"status\":\"validation_error\""));
        assert!(!output_dir
            .join("response/magnetic_response_sweep.v1.json")
            .exists());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_production_gpu_runs_floquet_exchange_no_demag() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [1.0, 0.0, 0.0, 0.0];
        let drive_imag = [0.0, 0.0, -1.0, 0.0];
        let exchange_edges = [NativeDrivenFrequencyResponseExchangeEdge {
            node_i: 0,
            node_j: 1,
            stiffness: 0.25,
        }];
        let floquet_pairs = [NativeDrivenFrequencyResponseFloquetPeriodicPair {
            pair_id: Some("x_faces"),
            node_a: 0,
            node_b: 1,
            translation_m: Some([1.0e-6, 0.0, 0.0]),
            phase_rad: Some(-std::f64::consts::FRAC_PI_2),
        }];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-gpu-floquet-exchange-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 2,
            tangent_dof_count: 4,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionGpu,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: true,
            write_partial_artifacts: true,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: Some(&drive_imag),
                exchange_edges: &exchange_edges,
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: Some([1.5707963267948966e6, 0.0, 0.0]),
                phase_convention: FrequencyDomainPhaseConvention::ExpMinusIOmegaT,
                floquet_periodic_pairs: &floquet_pairs,
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_gpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"resolved_execution_lane\":\"production_gpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"floquet_phase_projection\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(result
            .diagnostics_json
            .contains("\"operator_terms_included\":[\"exchange\",\"zeeman\"]"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(output_dir
            .join("frequency_domain/manifest.v1.json")
            .exists());
        assert!(output_dir
            .join("response/frequency_points/frequency_0000.json")
            .exists());

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_runs_tiny_validation_and_releases_ffi_strings() {
        let frequencies_hz = [1.0e9];
        let stiffness_diagonal = [2.0, 4.0];
        let mass_diagonal = [1.0, 2.0];
        let drive_real = [1.0, 2.0];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::Validation,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            mfem_operator_problem: None,
            tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: None,
                mass_matrix_row_major: None,
                stiffness_diagonal: Some(&stiffness_diagonal),
                mass_diagonal: Some(&mass_diagonal),
                drive_real: &drive_real,
                drive_imag: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Ok);
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result
            .diagnostics_json
            .contains("frequency_domain_response_diagnostics.v1"));
        assert!(result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(result.result_json.contains("\"max_abs_response\""));
        assert_eq!(result.artifact_manifest_path, "");
        assert!(!output_dir
            .join("frequency_domain/manifest.v1.json")
            .exists());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_preserves_tiny_validation_solve_error() {
        let frequencies_hz = [0.15915494309189535];
        let stiffness_diagonal = [0.0, 0.0];
        let mass_diagonal = [0.0, 0.0];
        let drive_real = [1.0, 0.0];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::Validation,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            mfem_operator_problem: None,
            tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: None,
                mass_matrix_row_major: None,
                stiffness_diagonal: Some(&stiffness_diagonal),
                mass_diagonal: Some(&mass_diagonal),
                drive_real: &drive_real,
                drive_imag: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::SolveError);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result.error_message.contains("singular"));
        assert!(result.result_json.contains("\"status\":\"solve_error\""));
        assert!(result
            .diagnostics_json
            .contains("\"schema_version\":\"frequency_domain_response_diagnostics.v1\""));
        assert!(result
            .diagnostics_json
            .contains("\"status\":\"solve_error\""));
        assert!(!result.result_json.contains("\"status\":\"artifact_error\""));
        assert!(!result
            .diagnostics_json
            .contains("\"status\":\"artifact_error\""));
        assert_eq!(result.artifact_manifest_path, "");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_production_cpu_does_not_fallback_to_validation() {
        let frequencies_hz = [1.0e9];
        let stiffness_diagonal = [2.0, 4.0];
        let mass_diagonal = [1.0, 2.0];
        let drive_real = [1.0, 2.0];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            mfem_operator_problem: None,
            tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                tangent_dof_count: 2,
                stiffness_matrix_row_major: None,
                mass_matrix_row_major: None,
                stiffness_diagonal: Some(&stiffness_diagonal),
                mass_diagonal: Some(&mass_diagonal),
                drive_real: &drive_real,
                drive_imag: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(result.status, NativeFrequencyDomainStatus::Unavailable);
        assert_eq!(result.completed_frequency_count, 0);
        assert!(result.error_message.contains("production CPU"));
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_cpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(!result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));

        let gpu_result =
            solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
                node_count: 1,
                tangent_dof_count: 2,
                alpha: 0.01,
                gamma0: 2.211e5,
                execution_lane: NativeFrequencyDomainExecutionLane::ProductionGpu,
                frequencies_hz: &frequencies_hz,
                output_directory: Path::new(""),
                write_response_fields: false,
                write_partial_artifacts: false,
                operator_diagnostics_json: None,
                interrupt_requested: None,
                cancel_requested: None,
                progress_callback: None,
                requires_periodic_airbox_dynamic_demag: false,
                requires_floquet_airbox_dynamic_demag: false,
                magnetic_periodic_constraint_set_count: 0,
                magnetostatic_periodic_constraint_set_count: 0,
                periodic_airbox_delta_m_tangent_dof_count: 0,
                periodic_airbox_delta_phi_dof_count: 0,
                periodic_airbox_magnetostatic_periodic_node_pairs: &[],
                periodic_airbox_coupled_block_problem: None,
                mfem_operator_problem: None,
                tiny_validation_problem: Some(NativeDrivenFrequencyResponseTinyValidationProblem {
                    tangent_dof_count: 2,
                    stiffness_matrix_row_major: None,
                    mass_matrix_row_major: None,
                    stiffness_diagonal: Some(&stiffness_diagonal),
                    mass_diagonal: Some(&mass_diagonal),
                    drive_real: &drive_real,
                    drive_imag: None,
                }),
            })
            .expect("native frequency response boundary should return a structured result");

        assert_eq!(gpu_result.status, NativeFrequencyDomainStatus::Unavailable);
        assert_eq!(gpu_result.completed_frequency_count, 0);
        assert!(gpu_result.error_message.contains("production GPU"));
        assert!(gpu_result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_gpu\""));
        assert!(gpu_result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(!gpu_result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_domain_status_bridge_maps_all_c_abi_statuses() {
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK
            ),
            NativeFrequencyDomainStatus::Ok
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE
            ),
            NativeFrequencyDomainStatus::Unavailable
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR
            ),
            NativeFrequencyDomainStatus::ValidationError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR
            ),
            NativeFrequencyDomainStatus::OperatorError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR
            ),
            NativeFrequencyDomainStatus::SolveError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR
            ),
            NativeFrequencyDomainStatus::ArtifactError
        );
        assert_eq!(
            map_status(
                ffi::fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED
            ),
            NativeFrequencyDomainStatus::Interrupted
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_progress_callback_bridge_maps_c_abi_progress() {
        use std::cell::RefCell;

        let observed = RefCell::new(Vec::new());
        let callback = |progress: NativeFrequencyDomainProgress| {
            observed.borrow_mut().push(progress);
        };
        let callback_ref: Option<&NativeFrequencyDomainProgressCallback<'_>> = Some(&callback);
        let ffi_progress = ffi::fullmag_fem_frequency_domain_progress {
            frequency_index: 2,
            completed_frequency_count: 3,
            total_frequency_count: 5,
            iteration_count: 13,
            frequency_hz: 4.25e9,
            residual_l2_norm: 1.0e-8,
            relative_residual_l2_norm: 2.5e-9,
            converged: 1,
        };

        unsafe {
            dispatch_native_frequency_domain_progress(
                (&callback_ref as *const Option<&NativeFrequencyDomainProgressCallback<'_>>)
                    as *mut c_void,
                &ffi_progress,
            );
        }

        let observed = observed.borrow();
        assert_eq!(
            observed.as_slice(),
            &[NativeFrequencyDomainProgress {
                frequency_index: 2,
                completed_frequency_count: 3,
                total_frequency_count: 5,
                iteration_count: 13,
                frequency_hz: 4.25e9,
                residual_l2_norm: 1.0e-8,
                relative_residual_l2_norm: 2.5e-9,
                converged: true,
            }]
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_frequency_response_cancel_callback_bridge_maps_rust_callback() {
        let cancel_requested = || true;
        let cancel_ref: Option<&NativeFrequencyDomainCancelCallback<'_>> = Some(&cancel_requested);

        let cancelled = unsafe {
            dispatch_native_frequency_domain_cancel(
                (&cancel_ref as *const Option<&NativeFrequencyDomainCancelCallback<'_>>)
                    as *mut c_void,
            )
        };

        assert_eq!(cancelled, 1);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU MFEM-operator support"]
    fn native_frequency_response_production_cpu_runs_mfem_operator_and_writes_artifacts() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [[0.0, 0.0, 1.0]];
        let h_ext_a_per_m = [0.0, 0.0, 2.0];
        let drive_real = [1.0, 0.0];
        let exchange_edges = [];
        let unique_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-native-frequency-response-production-cpu-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: &output_dir,
            write_response_fields: true,
            write_partial_artifacts: true,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &exchange_edges,
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response boundary should return a structured result");

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.total_frequency_count, 1);
        assert_eq!(result.completed_frequency_count, 1);
        assert_eq!(result.written_frequency_point_artifacts, 1);
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_cpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"matrix_free_solver\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(!result
            .diagnostics_json
            .contains("\"tiny_validation_solver\":true"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
        assert!(result.result_json.contains("\"max_abs_response\""));
        assert!(output_dir
            .join("frequency_domain/manifest.v1.json")
            .exists());
        assert!(output_dir
            .join("response/magnetic_response_sweep.v2.json")
            .exists());
        assert!(output_dir
            .join("response/field_payloads/frequency_0000/vector.bin")
            .exists());

        let _ = std::fs::remove_dir_all(output_dir);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU MFEM-operator support"]
    fn native_frequency_response_production_cpu_passes_explicit_demag_tangent_matrix() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [[0.0, 0.0, 1.0]];
        let h_ext_a_per_m = [0.0, 0.0, 1.0];
        let drive_real = [1.0, 0.0];
        let demag_tangent_matrix = [0.5, 0.0, 0.0, 0.25];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 1,
            tangent_dof_count: 2,
            alpha: 0.01,
            gamma0: 2.211e5,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &[],
                dmi_elements: &[],
                dmi_lumped_mass: None,
                dmi_ms_field: None,
                dmi_uniform_ms: 0.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: true,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: Some(&demag_tangent_matrix),
            }),
        })
        .expect(
            "native frequency response explicit demag matrix should return a structured result",
        );

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.completed_frequency_count, 1);
        assert!(result
            .diagnostics_json
            .contains("\"matrix_free_solver\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
        assert!(result.result_json.contains("\"status\":\"ok\""));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU MFEM-operator support"]
    fn native_frequency_response_production_cpu_runs_mfem_dmi_operator() {
        let frequencies_hz = [0.15915494309189535];
        let equilibrium_m = [
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 1.0],
        ];
        let h_ext_a_per_m = [0.0, 0.0, 0.0];
        let drive_real = [1.0, 0.0, 0.5, 0.0, -0.25, 0.0, 0.125, 0.0];
        let exchange_edges = [];
        let volume = 1.0 / 6.0;
        let lumped_mass = volume * 0.25;
        let dmi_lumped_mass = [lumped_mass, lumped_mass, lumped_mass, lumped_mass];
        let dmi_elements = [NativeDrivenFrequencyResponseDmiElement {
            kind: NativeDrivenFrequencyResponseDmiKind::Bulk,
            node_indices: [0, 1, 2, 3],
            shape: [0.25, 0.25, 0.25, 0.25],
            grad_shape: [
                -1.0, -1.0, -1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0,
            ],
            weight: volume,
            d: 2.0e-3,
            normal: [0.0, 0.0, 1.0],
        }];

        let result = solve_native_driven_frequency_response(NativeDrivenFrequencyResponseRequest {
            node_count: 4,
            tangent_dof_count: 8,
            alpha: 0.01,
            gamma0: 1.0,
            execution_lane: NativeFrequencyDomainExecutionLane::ProductionCpu,
            frequencies_hz: &frequencies_hz,
            output_directory: Path::new(""),
            write_response_fields: false,
            write_partial_artifacts: false,
            operator_diagnostics_json: None,
            interrupt_requested: None,
            cancel_requested: None,
            progress_callback: None,
            requires_periodic_airbox_dynamic_demag: false,
            requires_floquet_airbox_dynamic_demag: false,
            magnetic_periodic_constraint_set_count: 0,
            magnetostatic_periodic_constraint_set_count: 0,
            periodic_airbox_delta_m_tangent_dof_count: 0,
            periodic_airbox_delta_phi_dof_count: 0,
            periodic_airbox_magnetostatic_periodic_node_pairs: &[],
            periodic_airbox_coupled_block_problem: None,
            tiny_validation_problem: None,
            mfem_operator_problem: Some(NativeDrivenFrequencyResponseMfemOperatorProblem {
                equilibrium_m: &equilibrium_m,
                h_ext_a_per_m: &h_ext_a_per_m,
                uniaxial_anisotropy_axis: None,
                uniaxial_anisotropy_field_a_per_m: 0.0,
                alpha_per_node: None,
                drive_real: &drive_real,
                drive_imag: None,
                exchange_edges: &exchange_edges,
                dmi_elements: &dmi_elements,
                dmi_lumped_mass: Some(&dmi_lumped_mass),
                dmi_ms_field: None,
                dmi_uniform_ms: 800000.0,
                observable_ms_field: None,
                observable_uniform_ms: 0.0,
                include_zeeman: false,
                static_periodic_node_pairs: &[],
                floquet_k_vector_rad_per_m: None,
                phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
                floquet_periodic_pairs: &[],
                #[cfg(feature = "fem-gpu")]
                apply_demag_tangent: None,
                apply_demag_tangent_with_potential: None,
                demag_tangent_user_data: std::ptr::null_mut(),
                demag_tangent_matrix_row_major: None,
            }),
        })
        .expect("native frequency response DMI boundary should return a structured result");

        assert_eq!(
            result.status,
            NativeFrequencyDomainStatus::Ok,
            "error_message={}, diagnostics_json={}",
            result.error_message,
            result.diagnostics_json
        );
        assert_eq!(result.completed_frequency_count, 1);
        assert!(result
            .diagnostics_json
            .contains("\"requested_execution_lane\":\"production_cpu\""));
        assert!(result
            .diagnostics_json
            .contains("\"matrix_free_solver\":true"));
        assert!(result
            .diagnostics_json
            .contains("\"validation_fallback_used\":false"));
    }
}
