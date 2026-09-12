use fullmag_ir::{FemEigenPlanIR, FemPlanIR};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::RunError;

const EQUILIBRIUM_MATERIAL_PREIMAGE_V1: &str = "EquilibriumMaterialSignaturePreimage.v1";
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
    pub(crate) equilibrium_static_physics_signature: String,
    pub(crate) equilibrium_boundary_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModalIdentitySignaturesV1 {
    pub(crate) modal_operator_signature: String,
    pub(crate) modal_dynamic_boundary_signature: String,
}

impl EquilibriumIdentitySignaturesV1 {
    pub(crate) fn from_relax_plan(plan: &FemPlanIR) -> Result<Self, RunError> {
        validate_supported_relax_source(plan)?;
        Self::from_preimages(
            EquilibriumMaterialSignaturePreimageV1 {
                schema_version: EQUILIBRIUM_MATERIAL_PREIMAGE_V1.to_string(),
                saturation_magnetisation_a_per_m: plan.material.saturation_magnetisation,
                exchange_stiffness_j_per_m: plan.material.exchange_stiffness,
                saturation_magnetisation_field_a_per_m: plan.material.ms_field.clone(),
                exchange_stiffness_field_j_per_m: plan.material.a_field.clone(),
            },
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
            EquilibriumMaterialSignaturePreimageV1 {
                schema_version: EQUILIBRIUM_MATERIAL_PREIMAGE_V1.to_string(),
                saturation_magnetisation_a_per_m: plan.material.saturation_magnetisation,
                exchange_stiffness_j_per_m: plan.material.exchange_stiffness,
                saturation_magnetisation_field_a_per_m: plan.material.ms_field.clone(),
                exchange_stiffness_field_j_per_m: plan.material.a_field.clone(),
            },
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
        material: EquilibriumMaterialSignaturePreimageV1,
        static_physics: EquilibriumStaticPhysicsSignaturePreimageV1,
        boundary: EquilibriumBoundarySignaturePreimageV1,
    ) -> Result<Self, RunError> {
        Ok(Self {
            equilibrium_material_signature: signature_digest(
                EQUILIBRIUM_MATERIAL_PREIMAGE_V1,
                &material,
            )?,
            equilibrium_static_physics_signature: signature_digest(
                EQUILIBRIUM_STATIC_PHYSICS_PREIMAGE_V1,
                &static_physics,
            )?,
            equilibrium_boundary_signature: signature_digest(
                EQUILIBRIUM_BOUNDARY_PREIMAGE_V1,
                &boundary,
            )?,
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
        Ok(Self {
            modal_operator_signature: signature_digest(MODAL_OPERATOR_PREIMAGE_V1, &operator)?,
            modal_dynamic_boundary_signature: signature_digest(
                MODAL_DYNAMIC_BOUNDARY_PREIMAGE_V1,
                &dynamic_boundary,
            )?,
        })
    }
}

fn validate_supported_relax_source(plan: &FemPlanIR) -> Result<(), RunError> {
    validate_supported_material(&plan.material, "source relaxation plan")?;
    if plan.anisotropy_axis_field.is_some()
        || plan.ms_element_field.is_some()
        || plan.a_element_field.is_some()
        || !plan.region_materials.is_empty()
        || plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.dind_field.is_some()
        || plan.dbulk_field.is_some()
    {
        return Err(unsupported_source_identity(
            "source relaxation plan contains regional, anisotropy-axis, element-field, or DMI data that the current eigen source identity cannot reproduce",
        ));
    }
    Ok(())
}

fn validate_supported_material(
    material: &fullmag_ir::MaterialIR,
    source: &str,
) -> Result<(), RunError> {
    if material.uniaxial_anisotropy.is_some()
        || material.uniaxial_anisotropy_k2.is_some()
        || material.anisotropy_axis.is_some()
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
            "{source} contains anisotropy or DMI material data outside the supported exchange/demag/Zeeman source identity scope"
        )));
    }
    Ok(())
}

fn unsupported_source_identity(detail: &str) -> RunError {
    RunError {
        message: format!("equilibrium_identity_scope_unsupported: {detail}"),
    }
}

fn signature_digest<T: Serialize>(namespace: &str, value: &T) -> Result<String, RunError> {
    let bytes = serde_json::to_vec(value).map_err(|error| RunError {
        message: format!("equilibrium_identity_serialization_failed: {error}"),
    })?;
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}
