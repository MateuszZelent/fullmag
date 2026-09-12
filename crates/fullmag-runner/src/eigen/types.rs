use fullmag_ir::{FemEigenDispersionValidationIR, FemEigenK0KittelValidationIR};
use num_complex::Complex64;
use std::collections::{BTreeMap, BTreeSet};

pub const MODAL_PARTICIPATION_DEFINITION_ID: &str = "volume_weighted_complex_l2_fraction.v1";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModalParticipationSourceMeshIdentity {
    pub mesh_id: String,
    pub topology_fingerprint: String,
    pub indexing: String,
    pub node_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModalParticipationObjectMarkerMembership {
    pub object_id: String,
    pub markers: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModalParticipationMeshContext {
    pub source_mesh_identity: ModalParticipationSourceMeshIdentity,
    pub nodes_m: Vec<[f64; 3]>,
    pub tet4_elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    pub object_marker_membership: Vec<ModalParticipationObjectMarkerMembership>,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModalParticipationAvailability {
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModalParticipationUnavailableDetail {
    ModeFieldMissing,
    ConsistentMassBasisUnsupported,
    ObjectMembershipMissing,
    ObjectCoverageIncomplete,
    ComponentBasisUnsupported,
    ComponentTotalNonfinite,
    ComponentTotalZero,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModalParticipationUnavailable {
    pub reason_code: String,
    pub detail: ModalParticipationUnavailableDetail,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ModalParticipationFractions {
    pub total: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ModalObjectParticipation {
    pub object_id: String,
    pub total_fraction: f64,
    pub components: ModalParticipationFractions,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ModalParticipationProvenance {
    pub solver_device: String,
    pub observable_lane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_mesh_identity: Option<ModalParticipationSourceMeshIdentity>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct ModalParticipationObservable {
    pub schema_version: String,
    pub definition_id: String,
    pub status: ModalParticipationAvailability,
    pub quantity_id: String,
    pub quantity_symbol: String,
    pub unit: String,
    pub component_basis: String,
    pub integration_method: String,
    pub qualification: String,
    pub provenance: ModalParticipationProvenance,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global: Option<ModalParticipationFractions>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<ModalObjectParticipation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<ModalParticipationUnavailable>,
}

impl ModalParticipationObservable {
    pub fn unavailable_without_context(solver_device: impl Into<String>) -> Self {
        Self::unavailable(
            ModalParticipationUnavailableDetail::ObjectMembershipMissing,
            solver_device,
            None,
        )
    }

    pub fn unavailable(
        detail: ModalParticipationUnavailableDetail,
        solver_device: impl Into<String>,
        source_mesh_identity: Option<ModalParticipationSourceMeshIdentity>,
    ) -> Self {
        Self {
            schema_version: "modal_component_participation.v1".to_string(),
            definition_id: MODAL_PARTICIPATION_DEFINITION_ID.to_string(),
            status: ModalParticipationAvailability::Unavailable,
            quantity_id: "delta_m".to_string(),
            quantity_symbol: "delta_m".to_string(),
            unit: "1".to_string(),
            component_basis: "global_cartesian_xyz".to_string(),
            integration_method: "consistent_mass_p1_tet4".to_string(),
            qualification: "source_implemented_runtime_unqualified".to_string(),
            provenance: ModalParticipationProvenance {
                solver_device: solver_device.into(),
                observable_lane: "postprocess_cpu".to_string(),
                source_mesh_identity,
            },
            global: None,
            objects: Vec::new(),
            unavailable: Some(ModalParticipationUnavailable {
                reason_code: "component_participation_unavailable".to_string(),
                detail,
            }),
        }
    }
}

impl ModalParticipationMeshContext {
    pub fn compute(
        &self,
        real: &[[f64; 3]],
        imag: &[[f64; 3]],
        solver_device: &str,
    ) -> ModalParticipationObservable {
        let unavailable = |detail| {
            ModalParticipationObservable::unavailable(
                detail,
                solver_device,
                Some(self.source_mesh_identity.clone()),
            )
        };
        if real.is_empty()
            || real.len() != imag.len()
            || real.len() != self.nodes_m.len()
            || self.source_mesh_identity.node_count != self.nodes_m.len()
        {
            return unavailable(ModalParticipationUnavailableDetail::ModeFieldMissing);
        }
        if self.tet4_elements.is_empty() || self.tet4_elements.len() != self.element_markers.len() {
            return unavailable(
                ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported,
            );
        }

        let mut marker_to_object = BTreeMap::<u32, &str>::new();
        let mut declared_markers = BTreeSet::new();
        for membership in &self.object_marker_membership {
            if membership.object_id.trim().is_empty() || membership.markers.is_empty() {
                return unavailable(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
            }
            for marker in &membership.markers {
                if *marker == 0
                    || !declared_markers.insert(*marker)
                    || marker_to_object
                        .insert(*marker, membership.object_id.as_str())
                        .is_some()
                {
                    return unavailable(
                        ModalParticipationUnavailableDetail::ObjectMembershipMissing,
                    );
                }
            }
        }
        if marker_to_object.is_empty() {
            return unavailable(ModalParticipationUnavailableDetail::ObjectMembershipMissing);
        }
        let realized_magnetic_markers = self
            .element_markers
            .iter()
            .copied()
            .filter(|marker| *marker != 0)
            .collect::<BTreeSet<_>>();
        if realized_magnetic_markers.is_empty() || realized_magnetic_markers != declared_markers {
            return unavailable(ModalParticipationUnavailableDetail::ObjectCoverageIncomplete);
        }

        let mut energies = self
            .object_marker_membership
            .iter()
            .map(|membership| (membership.object_id.clone(), [0.0_f64; 3]))
            .collect::<BTreeMap<_, _>>();
        for (element, marker) in self.tet4_elements.iter().zip(&self.element_markers) {
            if *marker == 0 {
                continue;
            }
            let Some(object_id) = marker_to_object.get(marker).copied() else {
                return unavailable(ModalParticipationUnavailableDetail::ObjectCoverageIncomplete);
            };
            let mut coordinates = [[0.0; 3]; 4];
            for (local, node) in element.iter().enumerate() {
                let Some(position) = self.nodes_m.get(*node as usize).copied() else {
                    return unavailable(
                        ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported,
                    );
                };
                coordinates[local] = position;
            }
            let volume = tet4_volume(coordinates);
            if !(volume.is_finite() && volume > 0.0) {
                return unavailable(
                    ModalParticipationUnavailableDetail::ConsistentMassBasisUnsupported,
                );
            }
            let object_energy = energies
                .get_mut(object_id)
                .expect("marker membership and energy owners are built together");
            for component in 0..3 {
                let mut real_sum = 0.0;
                let mut real_square_sum = 0.0;
                let mut imag_sum = 0.0;
                let mut imag_square_sum = 0.0;
                for node in element {
                    let real_value = real[*node as usize][component];
                    let imag_value = imag[*node as usize][component];
                    if !real_value.is_finite() || !imag_value.is_finite() {
                        return unavailable(
                            ModalParticipationUnavailableDetail::ComponentTotalNonfinite,
                        );
                    }
                    real_sum += real_value;
                    real_square_sum += real_value * real_value;
                    imag_sum += imag_value;
                    imag_square_sum += imag_value * imag_value;
                }
                object_energy[component] += volume
                    * (real_sum * real_sum
                        + real_square_sum
                        + imag_sum * imag_sum
                        + imag_square_sum)
                    / 20.0;
            }
        }

        let total = energies
            .values()
            .flat_map(|components| components.iter())
            .sum::<f64>();
        if !total.is_finite() {
            return unavailable(ModalParticipationUnavailableDetail::ComponentTotalNonfinite);
        }
        if total <= 0.0 {
            return unavailable(ModalParticipationUnavailableDetail::ComponentTotalZero);
        }

        let objects = energies
            .into_iter()
            .map(|(object_id, energy)| {
                let x = energy[0] / total;
                let y = energy[1] / total;
                let z = energy[2] / total;
                ModalObjectParticipation {
                    object_id,
                    total_fraction: x + y + z,
                    components: ModalParticipationFractions {
                        total: x + y + z,
                        x,
                        y,
                        z,
                    },
                }
            })
            .collect::<Vec<_>>();
        let global_x = objects
            .iter()
            .map(|object| object.components.x)
            .sum::<f64>();
        let global_y = objects
            .iter()
            .map(|object| object.components.y)
            .sum::<f64>();
        let global_z = objects
            .iter()
            .map(|object| object.components.z)
            .sum::<f64>();
        let global_component_sum = global_x + global_y + global_z;
        let object_total_sum = objects
            .iter()
            .map(|object| object.total_fraction)
            .sum::<f64>();
        let sum_tolerance =
            128.0 * f64::EPSILON * (3_usize.saturating_mul(objects.len())).max(1) as f64;
        if !global_component_sum.is_finite()
            || !object_total_sum.is_finite()
            || (global_component_sum - 1.0).abs() > sum_tolerance
            || (object_total_sum - 1.0).abs() > sum_tolerance
        {
            return unavailable(ModalParticipationUnavailableDetail::ComponentTotalNonfinite);
        }

        ModalParticipationObservable {
            schema_version: "modal_component_participation.v1".to_string(),
            definition_id: MODAL_PARTICIPATION_DEFINITION_ID.to_string(),
            status: ModalParticipationAvailability::Ready,
            quantity_id: "delta_m".to_string(),
            quantity_symbol: "delta_m".to_string(),
            unit: "1".to_string(),
            component_basis: "global_cartesian_xyz".to_string(),
            integration_method: "consistent_mass_p1_tet4".to_string(),
            qualification: "source_implemented_runtime_unqualified".to_string(),
            provenance: ModalParticipationProvenance {
                solver_device: solver_device.to_string(),
                observable_lane: "postprocess_cpu".to_string(),
                source_mesh_identity: Some(self.source_mesh_identity.clone()),
            },
            global: Some(ModalParticipationFractions {
                total: 1.0,
                x: global_x,
                y: global_y,
                z: global_z,
            }),
            objects,
            unavailable: None,
        }
    }
}

fn tet4_volume(nodes: [[f64; 3]; 4]) -> f64 {
    let a = [
        nodes[1][0] - nodes[0][0],
        nodes[1][1] - nodes[0][1],
        nodes[1][2] - nodes[0][2],
    ];
    let b = [
        nodes[2][0] - nodes[0][0],
        nodes[2][1] - nodes[0][1],
        nodes[2][2] - nodes[0][2],
    ];
    let c = [
        nodes[3][0] - nodes[0][0],
        nodes[3][1] - nodes[0][1],
        nodes[3][2] - nodes[0][2],
    ];
    (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0]))
        .abs()
        / 6.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EigenSolverModel {
    ReferenceScalarTangent,
    ReferenceFull2x2Tangent,
    ReferenceThinFilmDeBvKalinikosN0,
    ReferenceK0KittelSyntheticDemagFactor,
    LinearizedLlgTangentPlane,
    ProductionCpuShiftInvert,
    ProductionGpuDenseK0Macrospin,
    ProductionGpuModalDeviceKrylov,
}

impl EigenSolverModel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReferenceScalarTangent => "reference_scalar_tangent",
            Self::ReferenceFull2x2Tangent => "reference_full_2x2_tangent",
            Self::ReferenceThinFilmDeBvKalinikosN0 => "reference_thin_film_de_bv_kalinikos_n0",
            Self::ReferenceK0KittelSyntheticDemagFactor => {
                "reference_k0_kittel_synthetic_demag_factor"
            }
            Self::LinearizedLlgTangentPlane => "linearized_llg_tangent_plane",
            Self::ProductionCpuShiftInvert => "slepc_multi_shift_invert_production_cpu_dense",
            Self::ProductionGpuDenseK0Macrospin => "gpu_dense_k0_macrospin_modal_eigen",
            Self::ProductionGpuModalDeviceKrylov => "gpu_modal_device_krylov",
        }
    }
}

#[derive(Debug, Clone)]
pub struct KSampleDescriptor {
    pub sample_index: usize,
    pub label: Option<String>,
    pub segment_index: Option<usize>,
    pub path_s: f64,
    pub t_in_segment: f64,
    pub k_vector: [f64; 3],
}

#[derive(Debug, Clone)]
pub struct SingleKModeResult {
    pub raw_mode_index: usize,
    pub branch_id: Option<usize>,
    pub frequency_real_hz: f64,
    pub frequency_imag_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub eigenvalue_real: f64,
    pub eigenvalue_imag: f64,
    pub norm: f64,
    pub mass_norm: Option<f64>,
    pub max_amplitude: f64,
    pub residual_norm: Option<f64>,
    pub residual_linf: Option<f64>,
    pub tangent_leakage_mean_abs: Option<f64>,
    pub tangent_leakage_max_abs: Option<f64>,
    pub tangent_leakage_weighted_relative_l2: Option<f64>,
    pub dominant_polarization: String,
    pub reduced_vector: Option<Vec<Complex64>>,
    pub lifted_real: Option<Vec<[f64; 3]>>,
    pub lifted_imag: Option<Vec<[f64; 3]>>,
    pub amplitude: Option<Vec<f64>>,
    pub phase: Option<Vec<f64>>,
    pub node_mass_weights: Option<Vec<f64>>,
    pub component_participation: ModalParticipationObservable,
}

impl SingleKModeResult {
    pub fn frequency_hz(&self) -> f64 {
        self.frequency_real_hz
    }
}

#[derive(Debug, Clone)]
pub struct SingleKSolveResult {
    pub sample: KSampleDescriptor,
    pub modes: Vec<SingleKModeResult>,
    pub relaxation_steps: u64,
    pub solver_model: EigenSolverModel,
    pub solver_notes: Vec<String>,
    pub solver_diagnostics: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct TrackedBranchPoint {
    pub sample_index: usize,
    pub raw_mode_index: usize,
    pub frequency_real_hz: f64,
    pub frequency_imag_hz: f64,
    pub tracking_confidence: f64,
    pub overlap_prev: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct TrackedBranch {
    pub branch_id: usize,
    pub label: Option<String>,
    pub points: Vec<TrackedBranchPoint>,
}

#[derive(Debug, Clone)]
pub struct DispersionAnalyticReferenceContext {
    pub external_field: [f64; 3],
    pub exchange_stiffness: f64,
    pub saturation_magnetisation: f64,
    pub gyromagnetic_ratio: f64,
}

#[derive(Debug, Clone)]
pub struct K0KittelPeriodicAirboxDemagMetrics {
    pub mesh_resolution_m: f64,
    pub airbox_size_m: f64,
    pub phi_dof_count: u64,
    pub augmented_phi_dof_count: u64,
    pub poisson_constraint_relative_residual: f64,
    pub magnetic_pair_count: u64,
    pub airbox_pair_count: u64,
    pub effective_magnetisation_a_per_m: f64,
    pub relative_kittel_frequency_error: f64,
}

#[derive(Debug, Clone)]
pub struct PathSolveResult {
    pub samples: Vec<SingleKSolveResult>,
    pub branches: Vec<TrackedBranch>,
    pub solver_model: EigenSolverModel,
    pub notes: Vec<String>,
    pub include_demag: bool,
    pub dispersion_validation: Option<FemEigenDispersionValidationIR>,
    pub k0_kittel_validation: Option<FemEigenK0KittelValidationIR>,
    pub dispersion_analytic_reference: Option<DispersionAnalyticReferenceContext>,
    pub k0_kittel_periodic_airbox_demag: Option<K0KittelPeriodicAirboxDemagMetrics>,
}

#[cfg(test)]
mod tests {
    use super::{
        ModalParticipationAvailability, ModalParticipationMeshContext,
        ModalParticipationObjectMarkerMembership, ModalParticipationSourceMeshIdentity,
        ModalParticipationUnavailableDetail,
    };

    fn two_object_context() -> ModalParticipationMeshContext {
        ModalParticipationMeshContext {
            source_mesh_identity: ModalParticipationSourceMeshIdentity {
                mesh_id: "mesh:two-object".to_string(),
                topology_fingerprint:
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_string(),
                indexing: "full_domain_node_order".to_string(),
                node_count: 8,
            },
            nodes_m: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [3.0, 0.0, 0.0],
                [4.0, 0.0, 0.0],
                [3.0, 1.0, 0.0],
                [3.0, 0.0, 2.0],
            ],
            tet4_elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
            element_markers: vec![1, 2],
            object_marker_membership: vec![
                ModalParticipationObjectMarkerMembership {
                    object_id: "object-a".to_string(),
                    markers: vec![1],
                },
                ModalParticipationObjectMarkerMembership {
                    object_id: "object-b".to_string(),
                    markers: vec![2],
                },
            ],
        }
    }

    fn two_object_mode(scale_re: f64, scale_im: f64) -> (Vec<[f64; 3]>, Vec<[f64; 3]>) {
        let base = [
            ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            ([1.0, 0.0, 0.0], [1.0, 0.0, 0.0]),
            ([0.0, 2.0, 0.0], [0.0, 0.0, 0.0]),
            ([0.0, 2.0, 0.0], [0.0, 0.0, 0.0]),
            ([0.0, 2.0, 0.0], [0.0, 0.0, 0.0]),
            ([0.0, 2.0, 0.0], [0.0, 0.0, 0.0]),
        ];
        base.into_iter()
            .map(|(real, imag)| {
                let mut scaled_real = [0.0; 3];
                let mut scaled_imag = [0.0; 3];
                for component in 0..3 {
                    scaled_real[component] =
                        scale_re * real[component] - scale_im * imag[component];
                    scaled_imag[component] =
                        scale_im * real[component] + scale_re * imag[component];
                }
                (scaled_real, scaled_imag)
            })
            .unzip()
    }

    #[test]
    fn complex_two_object_participation_uses_consistent_tet4_mass_and_is_scale_invariant() {
        let context = two_object_context();
        let (real, imag) = two_object_mode(1.0, 0.0);
        let observable = context.compute(&real, &imag, "gpu");
        let (scaled_real, scaled_imag) = two_object_mode(3.0, -4.0);
        let scaled = context.compute(&scaled_real, &scaled_imag, "gpu");

        assert_eq!(observable.status, ModalParticipationAvailability::Ready);
        assert_eq!(
            observable.definition_id,
            "volume_weighted_complex_l2_fraction.v1"
        );
        assert_eq!(observable.integration_method, "consistent_mass_p1_tet4");
        assert_eq!(observable.unit, "1");
        assert_eq!(observable.provenance.solver_device, "gpu");
        assert_eq!(observable.provenance.observable_lane, "postprocess_cpu");
        let global = observable.global.as_ref().expect("global participation");
        assert!((global.total - 1.0).abs() <= 1.0e-14);
        assert!((global.x - 0.2).abs() <= 1.0e-14);
        assert!((global.y - 0.8).abs() <= 1.0e-14);
        assert!(global.z.abs() <= 1.0e-14);
        assert_eq!(observable.objects.len(), 2);
        assert_eq!(observable.objects[0].object_id, "object-a");
        assert!((observable.objects[0].total_fraction - 0.2).abs() <= 1.0e-14);
        assert_eq!(observable.objects[1].object_id, "object-b");
        assert!((observable.objects[1].total_fraction - 0.8).abs() <= 1.0e-14);
        assert_eq!(observable.global, scaled.global);
        assert_eq!(observable.objects, scaled.objects);
    }

    #[test]
    fn participation_is_typed_unavailable_for_incomplete_object_membership() {
        let mut context = two_object_context();
        context.object_marker_membership.pop();
        let (real, imag) = two_object_mode(1.0, 0.0);

        let observable = context.compute(&real, &imag, "cpu");

        assert_eq!(
            observable.status,
            ModalParticipationAvailability::Unavailable
        );
        assert_eq!(
            observable
                .unavailable
                .as_ref()
                .expect("typed unavailable")
                .detail,
            ModalParticipationUnavailableDetail::ObjectCoverageIncomplete
        );
        assert!(observable.global.is_none());
        assert!(observable.objects.is_empty());
    }
}
