use fullmag_ir::{FemEigenPlanIR, FemPlanIR};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::RunError;

const EQUILIBRIUM_MATERIAL_PREIMAGE_V1: &str = "EquilibriumMaterialSignaturePreimage.v1";
const EQUILIBRIUM_MATERIAL_PREIMAGE_V2: &str = "EquilibriumMaterialSignaturePreimage.v2";
const EQUILIBRIUM_STATIC_PHYSICS_PREIMAGE_V1: &str = "EquilibriumStaticPhysicsSignaturePreimage.v1";
const EQUILIBRIUM_BOUNDARY_PREIMAGE_V1: &str = "EquilibriumBoundarySignaturePreimage.v1";
const MODAL_OPERATOR_PREIMAGE_V1: &str = "ModalOperatorSignaturePreimage.v1";
const MODAL_DYNAMIC_BOUNDARY_PREIMAGE_V1: &str = "ModalDynamicBoundarySignaturePreimage.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct EquilibriumMaterialSignaturePreimageV1 {
    schema_version: String,
    saturation_magnetisation_a_per_m: f64,
    exchange_stiffness_j_per_m: f64,
    saturation_magnetisation_field_a_per_m: Option<Vec<f64>>,
    exchange_stiffness_field_j_per_m: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct EquilibriumMaterialSignaturePreimageV2 {
    #[serde(flatten)]
    material: EquilibriumMaterialSignaturePreimageV1,
    uniaxial_anisotropy_j_per_m3: f64,
    canonical_uniaxial_axis: [f64; 3],
}

/// One normalization owner for equilibrium identity and native Ku transport.
/// The axis is a rank-one direction: u and -u describe identical energies.
pub(super) fn constant_uniaxial_descriptor(
    material: &fullmag_ir::MaterialIR,
) -> Result<Option<(f64, [f64; 3])>, RunError> {
    let Some(ku) = material.uniaxial_anisotropy else {
        if material.anisotropy_axis.is_some() {
            return Err(unsupported_source_identity(
                "uniaxial axis supplied without Ku",
            ));
        }
        return Ok(None);
    };
    if !ku.is_finite() || !material.saturation_magnetisation.is_finite()
        || material.saturation_magnetisation <= 0.0 || material.ms_field.is_some()
    {
        return Err(unsupported_source_identity(
            "constant Ku requires finite Ku and uniform positive Ms",
        ));
    }
    let axis = material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]);
    if axis.iter().any(|value| !value.is_finite()) {
        return Err(unsupported_source_identity("uniaxial axis must be finite"));
    }
    // Scale before normalization to avoid overflow and underflow for finite axes.
    let scale = axis.iter().fold(0.0_f64, |value, component| value.max(component.abs()));
    if scale == 0.0 {
        return Err(unsupported_source_identity("uniaxial axis must be nonzero"));
    }
    let scaled = axis.map(|component| component / scale);
    let norm = scaled[0].hypot(scaled[1]).hypot(scaled[2]);
    let orientation = scaled.iter().find(|component| **component != 0.0).unwrap().signum();
    let canonical_axis = scaled.map(|component| {
        let value = orientation * component / norm;
        if value == 0.0 { 0.0 } else { value }
    });
    Ok(Some((if ku == 0.0 { 0.0 } else { ku }, canonical_axis)))
}

pub(super) fn equilibrium_material_signature(
    material: &fullmag_ir::MaterialIR,
) -> Result<String, RunError> {
    equilibrium_material_signature_and_preimage(material).map(|(digest, _)| digest)
}

fn equilibrium_material_signature_and_preimage(
    material: &fullmag_ir::MaterialIR,
) -> Result<(String, String), RunError> {
    let uniaxial = constant_uniaxial_descriptor(material)?;
    let mut preimage = EquilibriumMaterialSignaturePreimageV1 {
        schema_version: EQUILIBRIUM_MATERIAL_PREIMAGE_V1.to_string(),
        saturation_magnetisation_a_per_m: material.saturation_magnetisation,
        exchange_stiffness_j_per_m: material.exchange_stiffness,
        saturation_magnetisation_field_a_per_m: material.ms_field.clone(),
        exchange_stiffness_field_j_per_m: material.a_field.clone(),
    };
    if let Some((ku, axis)) = uniaxial {
        preimage.schema_version = EQUILIBRIUM_MATERIAL_PREIMAGE_V2.to_string();
        signature_digest_and_preimage(
            EQUILIBRIUM_MATERIAL_PREIMAGE_V2,
            &EquilibriumMaterialSignaturePreimageV2 {
                material: preimage,
                uniaxial_anisotropy_j_per_m3: ku,
                canonical_uniaxial_axis: axis,
            },
        )
    } else {
        signature_digest_and_preimage(EQUILIBRIUM_MATERIAL_PREIMAGE_V1, &preimage)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct EquilibriumStaticPhysicsSignaturePreimageV1 {
    schema_version: String,
    enable_exchange: bool,
    enable_demag: bool,
    external_field_a_per_m: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct EquilibriumBoundarySignaturePreimageV1 {
    schema_version: String,
    exchange_bc: fullmag_ir::ExchangeBoundaryCondition,
    demag_realization: Option<fullmag_ir::ResolvedFemDemagIR>,
    air_box_config: Option<fullmag_ir::AirBoxConfigIR>,
    periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModalOperatorSignaturePreimageV1 {
    schema_version: String,
    operator: fullmag_ir::EigenOperatorConfigIR,
    gyromagnetic_ratio_m_per_a_s: f64,
    damping_policy: fullmag_ir::EigenDampingPolicyIR,
    damping: f64,
    damping_field: Option<Vec<f64>>,
    enable_exchange: bool,
    enable_demag: bool,
    interfacial_dmi_j_per_m2: Option<f64>,
    dmi_interface_normal: Option<[f64; 3]>,
    bulk_dmi_j_per_m2: Option<f64>,
    demag_realization: Option<fullmag_ir::ResolvedFemDemagIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModalDynamicBoundarySignaturePreimageV1 {
    schema_version: String,
    spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR,
    k_sampling: Option<fullmag_ir::KSamplingIR>,
    periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    demag_realization: Option<fullmag_ir::ResolvedFemDemagIR>,
    air_box_config: Option<fullmag_ir::AirBoxConfigIR>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EquilibriumIdentitySignaturesV1 {
    pub(crate) equilibrium_material_signature: String,
    pub(crate) equilibrium_material_preimage_json: String,
    pub(crate) equilibrium_static_physics_signature: String,
    pub(crate) equilibrium_static_physics_preimage_json: String,
    pub(crate) equilibrium_boundary_signature: String,
    pub(crate) equilibrium_boundary_preimage_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModalIdentitySignaturesV1 {
    pub(crate) modal_operator_signature: String,
    pub(crate) modal_operator_preimage_json: String,
    pub(crate) modal_dynamic_boundary_signature: String,
    pub(crate) modal_dynamic_boundary_preimage_json: String,
}

impl EquilibriumIdentitySignaturesV1 {
    pub(crate) fn from_relax_plan(plan: &FemPlanIR) -> Result<Self, RunError> {
        validate_supported_relax_source(plan)?;
        Self::from_preimages(
            equilibrium_material_signature_and_preimage(&plan.material)?,
            EquilibriumStaticPhysicsSignaturePreimageV1 {
                schema_version: EQUILIBRIUM_STATIC_PHYSICS_PREIMAGE_V1.to_string(),
                enable_exchange: plan.enable_exchange,
                enable_demag: plan.enable_demag,
                external_field_a_per_m: plan.external_field,
            },
            EquilibriumBoundarySignaturePreimageV1 {
                schema_version: EQUILIBRIUM_BOUNDARY_PREIMAGE_V1.to_string(),
                exchange_bc: plan.exchange_bc,
                demag_realization: plan.demag_realization,
                air_box_config: plan.air_box_config.clone(),
                periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
                periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            },
        )
    }

    pub(crate) fn from_eigen_plan(plan: &FemEigenPlanIR) -> Result<Self, RunError> {
        validate_supported_material(&plan.material, "target eigen plan")?;
        if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
            return Err(unsupported_source_identity(
                "target eigen plan contains DMI outside the supported exchange/demag/Zeeman source identity scope",
            ));
        }
        Self::from_preimages(
            equilibrium_material_signature_and_preimage(&plan.material)?,
            EquilibriumStaticPhysicsSignaturePreimageV1 {
                schema_version: EQUILIBRIUM_STATIC_PHYSICS_PREIMAGE_V1.to_string(),
                enable_exchange: plan.enable_exchange,
                enable_demag: plan.enable_demag,
                external_field_a_per_m: plan.external_field,
            },
            EquilibriumBoundarySignaturePreimageV1 {
                schema_version: EQUILIBRIUM_BOUNDARY_PREIMAGE_V1.to_string(),
                exchange_bc: plan.exchange_bc,
                demag_realization: plan.demag_realization,
                air_box_config: plan.air_box_config.clone(),
                periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
                periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            },
        )
    }

    fn from_preimages(
        material_identity: (String, String),
        static_physics: EquilibriumStaticPhysicsSignaturePreimageV1,
        boundary: EquilibriumBoundarySignaturePreimageV1,
    ) -> Result<Self, RunError> {
        let (equilibrium_material_signature, equilibrium_material_preimage_json) =
            material_identity;
        let (equilibrium_static_physics_signature, equilibrium_static_physics_preimage_json) =
            signature_digest_and_preimage(EQUILIBRIUM_STATIC_PHYSICS_PREIMAGE_V1, &static_physics)?;
        let (equilibrium_boundary_signature, equilibrium_boundary_preimage_json) =
            signature_digest_and_preimage(EQUILIBRIUM_BOUNDARY_PREIMAGE_V1, &boundary)?;
        Ok(Self {
            equilibrium_material_signature,
            equilibrium_material_preimage_json,
            equilibrium_static_physics_signature,
            equilibrium_static_physics_preimage_json,
            equilibrium_boundary_signature,
            equilibrium_boundary_preimage_json,
        })
    }
}

impl ModalIdentitySignaturesV1 {
    pub(crate) fn from_eigen_plan(plan: &FemEigenPlanIR) -> Result<Self, RunError> {
        let operator = ModalOperatorSignaturePreimageV1 {
            schema_version: MODAL_OPERATOR_PREIMAGE_V1.to_string(),
            operator: plan.operator.clone(),
            gyromagnetic_ratio_m_per_a_s: plan.gyromagnetic_ratio,
            damping_policy: plan.damping_policy,
            damping: plan.material.damping,
            damping_field: plan.material.alpha_field.clone(),
            enable_exchange: plan.enable_exchange,
            enable_demag: plan.enable_demag,
            interfacial_dmi_j_per_m2: plan.interfacial_dmi,
            dmi_interface_normal: plan.dmi_interface_normal,
            bulk_dmi_j_per_m2: plan.bulk_dmi,
            demag_realization: plan.demag_realization,
        };
        let dynamic_boundary = ModalDynamicBoundarySignaturePreimageV1 {
            schema_version: MODAL_DYNAMIC_BOUNDARY_PREIMAGE_V1.to_string(),
            spin_wave_bc: plan.spin_wave_bc.clone(),
            k_sampling: plan.k_sampling.clone(),
            periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
            periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            demag_realization: plan.demag_realization,
            air_box_config: plan.air_box_config.clone(),
        };
        let (modal_operator_signature, modal_operator_preimage_json) =
            signature_digest_and_preimage(MODAL_OPERATOR_PREIMAGE_V1, &operator)?;
        let (modal_dynamic_boundary_signature, modal_dynamic_boundary_preimage_json) =
            signature_digest_and_preimage(MODAL_DYNAMIC_BOUNDARY_PREIMAGE_V1, &dynamic_boundary)?;
        Ok(Self {
            modal_operator_signature,
            modal_operator_preimage_json,
            modal_dynamic_boundary_signature,
            modal_dynamic_boundary_preimage_json,
        })
    }
}

pub(crate) fn validate_supported_relax_source(plan: &FemPlanIR) -> Result<(), RunError> {
    validate_supported_material(&plan.material, "source relaxation plan")?;
    if plan.anisotropy_axis_field.is_some()
        || plan.ms_element_field.is_some()
        || plan.a_element_field.is_some()
        || !plan.region_materials.is_empty()
        || plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.dind_field.is_some()
        || plan.dbulk_field.is_some()
        || plan.rotated_interfacial_dmi.is_some()
        || !plan.antenna_zeeman_masks.is_empty()
        || !plan.field_drives.is_empty()
        || !plan.field_drive_geometry_masks.is_empty()
        || !plan.current_modules.is_empty()
        || !plan.spin_transport_plans.is_empty()
        || plan.current_density.is_some()
        || plan.spin_torque_contract.is_some()
        || plan.stt_degree.is_some()
        || plan.stt_beta.is_some()
        || plan.stt_spin_polarization.is_some()
        || plan.stt_lambda.is_some()
        || plan.stt_epsilon_prime.is_some()
        || plan.stt_thickness.is_some()
        || plan.stt_fixed_layer_position.is_some()
        || plan.has_oersted_cylinder
        || plan.oersted_current.is_some()
        || plan.oersted_radius.is_some()
        || plan.oersted_center.is_some()
        || plan.oersted_axis.is_some()
        || plan.oersted_field_xyz.is_some()
        || plan.oersted_realization.is_some()
        || plan.temperature.is_some()
        || plan.thermal_seed_config.is_some()
        || plan.mechanics.is_some()
    {
        return Err(unsupported_source_identity(
            "source relaxation plan contains spatial, higher-order, driven, current, stochastic, mechanical, or DMI physics outside the certified exchange/demag/Zeeman/constant-Ku scope",
        ));
    }
    Ok(())
}

fn validate_supported_material(
    material: &fullmag_ir::MaterialIR,
    source: &str,
) -> Result<(), RunError> {
    constant_uniaxial_descriptor(material)?;
    if material.uniaxial_anisotropy_k2.is_some()
        || material.cubic_anisotropy_kc1.is_some()
        || material.cubic_anisotropy_kc2.is_some()
        || material.cubic_anisotropy_kc3.is_some()
        || material.cubic_anisotropy_axis1.is_some()
        || material.cubic_anisotropy_axis2.is_some()
        || material.ku_field.is_some()
        || material.ku2_field.is_some()
        || material.kc1_field.is_some()
        || material.kc2_field.is_some()
        || material.kc3_field.is_some()
        || material.interfacial_dmi.is_some()
        || material.bulk_dmi.is_some()
        || material.dind_field.is_some()
        || material.dbulk_field.is_some()
    {
        return Err(unsupported_source_identity(&format!(
            "{source} contains spatial, higher-order anisotropy or DMI outside the supported constant-Ku source identity scope"
        )));
    }
    Ok(())
}

fn unsupported_source_identity(detail: &str) -> RunError {
    RunError {
        message: format!("equilibrium_identity_scope_unsupported: {detail}"),
    }
}

fn signature_digest_and_preimage<T: Serialize>(
    namespace: &str,
    value: &T,
) -> Result<(String, String), RunError> {
    let bytes = serde_json::to_vec(value).map_err(|error| RunError {
        message: format!("equilibrium_identity_serialization_failed: {error}"),
    })?;
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(&bytes);
    let preimage_json = String::from_utf8(bytes).map_err(|error| RunError {
        message: format!("equilibrium_identity_preimage_not_utf8: {error}"),
    })?;
    Ok((format!("sha256:{:x}", hash.finalize()), preimage_json))
}

#[cfg(test)]
mod material_identity_tests {
    use super::*;

    #[test]
    fn field_certificate_scope_rejects_unrepresented_contributions() {
        let baseline = fullmag_ir::FemPlanIR::default();
        validate_supported_relax_source(&baseline).unwrap();
        let mut ku = baseline.clone();
        ku.material.uniaxial_anisotropy = Some(0.0);
        validate_supported_relax_source(&ku).unwrap();
        ku.material.ms_field = Some(vec![800_000.0]);
        assert!(validate_supported_relax_source(&ku).is_err());
        for mutation in 0..5 {
            let mut plan = baseline.clone();
            match mutation {
                0 => plan.temperature = Some(300.0),
                1 => plan.has_oersted_cylinder = true,
                2 => plan.current_density = Some([1.0, 0.0, 0.0]),
                3 => plan.interfacial_dmi = Some(1.0e-3),
                _ => plan.material.cubic_anisotropy_kc1 = Some(1.0),
            }
            assert!(validate_supported_relax_source(&plan).is_err());
        }
    }

    #[test]
    fn ku_free_material_preserves_legacy_v1_bytes_and_digest() {
        let material = fullmag_ir::MaterialIR {
            saturation_magnetisation: 800_000.0,
            exchange_stiffness: 1.3e-11,
            ..Default::default()
        };
        let preimage = EquilibriumMaterialSignaturePreimageV1 {
            schema_version: EQUILIBRIUM_MATERIAL_PREIMAGE_V1.to_string(),
            saturation_magnetisation_a_per_m: material.saturation_magnetisation,
            exchange_stiffness_j_per_m: material.exchange_stiffness,
            saturation_magnetisation_field_a_per_m: None,
            exchange_stiffness_field_j_per_m: None,
        };
        let golden_bytes = br#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v1","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null}"#;
        assert_eq!(serde_json::to_vec(&preimage).unwrap(), golden_bytes.as_slice());
        assert_eq!(equilibrium_material_signature(&material).unwrap(),
            "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af");
    }

    #[test]
    fn material_preimage_replays_exact_legacy_digest() {
        let material = fullmag_ir::MaterialIR {
            saturation_magnetisation: 800_000.0,
            exchange_stiffness: 1.3e-11,
            ..Default::default()
        };
        let (digest, preimage) = equilibrium_material_signature_and_preimage(&material).unwrap();
        let expected = r#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v1","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null}"#;
        assert_eq!(preimage, expected);
        assert_eq!(digest, "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af");
        // Replay from emitted bytes rather than serializing the same Rust struct again.
        let mut replay = Sha256::new();
        replay.update(EQUILIBRIUM_MATERIAL_PREIMAGE_V1.as_bytes());
        replay.update([0]);
        replay.update((preimage.len() as u64).to_le_bytes());
        replay.update(preimage.as_bytes());
        assert_eq!(digest, format!("sha256:{:x}", replay.finalize()));
    }

    #[test]
    fn ku_preimage_preserves_canonical_axis_and_v2_scope() {
        let mut material = fullmag_ir::MaterialIR {
            saturation_magnetisation: 800_000.0,
            exchange_stiffness: 1.3e-11,
            uniaxial_anisotropy: Some(-0.0),
            anisotropy_axis: Some([2.0, 3.0, 0.0]),
            ..Default::default()
        };
        let original = equilibrium_material_signature_and_preimage(&material).unwrap();
        material.uniaxial_anisotropy = Some(0.0);
        material.anisotropy_axis = Some([-4.0, -6.0, -0.0]);
        assert_eq!(original, equilibrium_material_signature_and_preimage(&material).unwrap());
        let decoded: serde_json::Value = serde_json::from_str(&original.1).unwrap();
        assert_eq!(decoded["schema_version"], EQUILIBRIUM_MATERIAL_PREIMAGE_V2);
        assert_eq!(decoded["uniaxial_anisotropy_j_per_m3"], 0.0);
        material.uniaxial_anisotropy = Some(1.0);
        assert_ne!(original, equilibrium_material_signature_and_preimage(&material).unwrap());
        material.uniaxial_anisotropy = None;
        material.anisotropy_axis = None;
        assert_ne!(original, equilibrium_material_signature_and_preimage(&material).unwrap());
    }

}
