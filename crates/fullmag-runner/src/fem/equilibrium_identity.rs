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

/// Strict replay-only V2 decoder.
///
/// The producer keeps the flattened representation above so the historical
/// byte stream remains unchanged.  Replay uses a separate explicit type:
/// `deny_unknown_fields` and `flatten` are a poor combination for a decoder,
/// while replay must reject a mixed V1/V2 payload before hashing it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct EquilibriumMaterialSignatureReplayV2 {
    schema_version: String,
    saturation_magnetisation_a_per_m: f64,
    exchange_stiffness_j_per_m: f64,
    saturation_magnetisation_field_a_per_m: Option<Vec<f64>>,
    exchange_stiffness_field_j_per_m: Option<Vec<f64>>,
    uniaxial_anisotropy_j_per_m3: f64,
    canonical_uniaxial_axis: [f64; 3],
}

/// One normalization owner for equilibrium identity and native Ku transport.
/// The axis is a rank-one direction: u and -u describe identical energies.
pub(super) fn constant_uniaxial_descriptor(
    material: &fullmag_ir::MaterialIR,
) -> Result<Option<(f64, [f64; 3])>, RunError> {
    let Some(ku) = material.uniaxial_anisotropy else {
        return Ok(None);
    };
    // A zero coefficient has no field and does not require uniform Ms.
    // Retain the historical V2 descriptor for already legal uniform-Ms zero
    // inputs so their published material-signature bytes remain unchanged.
    if ku == 0.0
        && (material.ms_field.is_some()
            || material.anisotropy_axis.is_some_and(|axis| axis.iter().all(|value| *value == 0.0)))
    {
        return Ok(None);
    }
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
    if [
        material.uniaxial_anisotropy_k2,
        material.cubic_anisotropy_kc1,
        material.cubic_anisotropy_kc2,
        material.cubic_anisotropy_kc3,
    ]
    .into_iter()
    .flatten()
    .any(|value| value != 0.0)
        || [
            &material.ku_field,
            &material.ku2_field,
            &material.kc1_field,
            &material.kc2_field,
            &material.kc3_field,
        ]
        .into_iter()
        .flatten()
        .flatten()
        .any(|value| *value != 0.0)
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

/// Replay a published equilibrium material preimage without reserializing it.
///
/// The JSON is decoded only to validate the versioned material contract.  The
/// digest is then calculated from the original UTF-8 bytes, including their
/// exact whitespace and number spellings, using the historical namespace,
/// NUL separator, and little-endian byte length framing.  This keeps a
/// published identity bound to the bytes that were actually emitted while
/// still rejecting malformed, mixed-schema, or physically invalid payloads.
pub(super) fn replay_equilibrium_material_signature(
    preimage_json: &str,
    expected_digest: &str,
) -> Result<(), RunError> {
    let actual_digest = equilibrium_material_signature_digest_from_preimage(preimage_json)?;
    if actual_digest != expected_digest {
        return Err(RunError {
            message: format!(
                "equilibrium_identity_preimage_digest_mismatch: expected {expected_digest}, got {actual_digest}"
            ),
        });
    }
    Ok(())
}

fn equilibrium_material_signature_digest_from_preimage(
    preimage_json: &str,
) -> Result<String, RunError> {
    let envelope: serde_json::Value = serde_json::from_str(preimage_json).map_err(|error| {
        RunError {
            message: format!(
                "equilibrium_identity_preimage_deserialization_failed: {error}"
            ),
        }
    })?;
    let schema_version = envelope
        .as_object()
        .and_then(|object| object.get("schema_version"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| RunError {
            message: "equilibrium_identity_preimage_schema_missing_or_not_string".to_string(),
        })?;

    let namespace = match schema_version {
        EQUILIBRIUM_MATERIAL_PREIMAGE_V1 => {
            let value: EquilibriumMaterialSignaturePreimageV1 =
                serde_json::from_str(preimage_json).map_err(|error| RunError {
                    message: format!(
                        "equilibrium_identity_preimage_v1_validation_failed: {error}"
                    ),
                })?;
            validate_material_preimage_v1(&value)?;
            EQUILIBRIUM_MATERIAL_PREIMAGE_V1
        }
        EQUILIBRIUM_MATERIAL_PREIMAGE_V2 => {
            let value: EquilibriumMaterialSignatureReplayV2 =
                serde_json::from_str(preimage_json).map_err(|error| RunError {
                    message: format!(
                        "equilibrium_identity_preimage_v2_validation_failed: {error}"
                    ),
                })?;
            validate_material_preimage_v2(&value)?;
            EQUILIBRIUM_MATERIAL_PREIMAGE_V2
        }
        other => {
            return Err(RunError {
                message: format!(
                    "equilibrium_identity_preimage_schema_unsupported: {other}"
                ),
            });
        }
    };

    // `&str` is already valid UTF-8.  Hash its untouched bytes instead of a
    // serde_json reserialization so whitespace and lexical number forms stay
    // part of the published identity.
    let bytes = preimage_json.as_bytes();
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update([0]);
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}

fn validate_material_preimage_v1(
    value: &EquilibriumMaterialSignaturePreimageV1,
) -> Result<(), RunError> {
    if value.schema_version != EQUILIBRIUM_MATERIAL_PREIMAGE_V1 {
        return Err(RunError {
            message: format!(
                "equilibrium_identity_preimage_v1_schema_mismatch: {}",
                value.schema_version
            ),
        });
    }
    validate_base_material_values(
        value.saturation_magnetisation_a_per_m,
        value.exchange_stiffness_j_per_m,
        value.saturation_magnetisation_field_a_per_m.as_deref(),
        value.exchange_stiffness_field_j_per_m.as_deref(),
    )
}

fn validate_material_preimage_v2(
    value: &EquilibriumMaterialSignatureReplayV2,
) -> Result<(), RunError> {
    if value.schema_version != EQUILIBRIUM_MATERIAL_PREIMAGE_V2 {
        return Err(RunError {
            message: format!(
                "equilibrium_identity_preimage_v2_schema_mismatch: {}",
                value.schema_version
            ),
        });
    }
    // The constant-Ku source identity is defined only for uniform Ms.  Keep
    // this replay rule aligned with `constant_uniaxial_descriptor`, including
    // the distinction between an absent field and an explicitly empty one.
    if value.saturation_magnetisation_field_a_per_m.is_some() {
        return Err(RunError {
            message:
                "equilibrium_identity_preimage_v2_ms_field_is_not_allowed_for_constant_ku"
                    .to_string(),
        });
    }
    validate_base_material_values(
        value.saturation_magnetisation_a_per_m,
        value.exchange_stiffness_j_per_m,
        value.saturation_magnetisation_field_a_per_m.as_deref(),
        value.exchange_stiffness_field_j_per_m.as_deref(),
    )?;
    if !value.uniaxial_anisotropy_j_per_m3.is_finite()
        || (value.uniaxial_anisotropy_j_per_m3 == 0.0
            && value.uniaxial_anisotropy_j_per_m3.is_sign_negative())
    {
        return Err(RunError {
            message: "equilibrium_identity_preimage_v2_ku_invalid_or_noncanonical".to_string(),
        });
    }
    validate_canonical_uniaxial_axis(&value.canonical_uniaxial_axis)
}

fn validate_base_material_values(
    saturation_magnetisation_a_per_m: f64,
    exchange_stiffness_j_per_m: f64,
    saturation_magnetisation_field_a_per_m: Option<&[f64]>,
    exchange_stiffness_field_j_per_m: Option<&[f64]>,
) -> Result<(), RunError> {
    if !saturation_magnetisation_a_per_m.is_finite()
        || saturation_magnetisation_a_per_m <= 0.0
    {
        return Err(RunError {
            message: "equilibrium_identity_preimage_ms_must_be_finite_and_positive".to_string(),
        });
    }
    if !exchange_stiffness_j_per_m.is_finite() || exchange_stiffness_j_per_m < 0.0 {
        return Err(RunError {
            message: "equilibrium_identity_preimage_aex_must_be_finite_and_nonnegative".to_string(),
        });
    }
    if let Some(values) = saturation_magnetisation_field_a_per_m {
        if values
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(RunError {
                message:
                    "equilibrium_identity_preimage_ms_field_must_be_finite_and_positive"
                        .to_string(),
            });
        }
    }
    if let Some(values) = exchange_stiffness_field_j_per_m {
        if values
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(RunError {
                message:
                    "equilibrium_identity_preimage_aex_field_must_be_finite_and_nonnegative"
                        .to_string(),
            });
        }
    }
    Ok(())
}

fn validate_canonical_uniaxial_axis(axis: &[f64; 3]) -> Result<(), RunError> {
    if axis.iter().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: "equilibrium_identity_preimage_axis_must_be_finite".to_string(),
        });
    }
    if axis
        .iter()
        .any(|value| *value == 0.0 && value.is_sign_negative())
    {
        return Err(RunError {
            message: "equilibrium_identity_preimage_axis_has_noncanonical_negative_zero"
                .to_string(),
        });
    }
    let norm = axis[0].hypot(axis[1]).hypot(axis[2]);
    if !norm.is_finite() || (norm - 1.0).abs() > 1.0e-12 {
        return Err(RunError {
            message: "equilibrium_identity_preimage_axis_must_be_unit_length".to_string(),
        });
    }
    let Some(first_nonzero) = axis.iter().find(|value| **value != 0.0) else {
        return Err(RunError {
            message: "equilibrium_identity_preimage_axis_must_be_nonzero".to_string(),
        });
    };
    if *first_nonzero < 0.0 {
        return Err(RunError {
            message: "equilibrium_identity_preimage_axis_orientation_is_not_canonical"
                .to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod material_identity_tests {
    use super::*;

    #[test]
    fn field_certificate_scope_rejects_unrepresented_contributions() {
        let mut baseline = fullmag_ir::FemPlanIR::default();
        baseline.material.saturation_magnetisation = 800_000.0;
        validate_supported_relax_source(&baseline).unwrap();
        let mut ku = baseline.clone();
        ku.material.uniaxial_anisotropy = Some(0.0);
        ku.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
        ku.material.uniaxial_anisotropy_k2 = Some(0.0);
        ku.material.cubic_anisotropy_kc1 = Some(0.0);
        ku.material.cubic_anisotropy_kc2 = Some(0.0);
        ku.material.cubic_anisotropy_kc3 = Some(0.0);
        ku.material.cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
        ku.material.cubic_anisotropy_axis2 = Some([0.0, 1.0, 0.0]);
        ku.material.ku_field = Some(vec![0.0]);
        ku.material.ku2_field = Some(vec![0.0]);
        ku.material.kc1_field = Some(vec![0.0]);
        ku.material.kc2_field = Some(vec![0.0]);
        ku.material.kc3_field = Some(vec![0.0]);
        validate_supported_relax_source(&ku).unwrap();
        ku.material.ms_field = Some(vec![800_000.0]);
        assert_eq!(constant_uniaxial_descriptor(&ku.material).unwrap(), None);
        validate_supported_relax_source(&ku)
            .expect("zero Ku and zero higher-order fields do not require uniform Ms");
        let mut absent_ku_with_same_ms = ku.material.clone();
        absent_ku_with_same_ms.uniaxial_anisotropy = None;
        absent_ku_with_same_ms.anisotropy_axis = None;
        assert_eq!(
            equilibrium_material_signature(&ku.material).unwrap(),
            equilibrium_material_signature(&absent_ku_with_same_ms).unwrap(),
            "zero Ku with nodal Ms must use the same V1 material identity as absent Ku"
        );
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
        for mutation in 0..8 {
            let mut plan = baseline.clone();
            match mutation {
                0 => plan.material.uniaxial_anisotropy_k2 = Some(1.0e-40),
                1 => plan.material.cubic_anisotropy_kc1 = Some(1.0e-40),
                2 => plan.material.cubic_anisotropy_kc2 = Some(1.0e-40),
                3 => plan.material.cubic_anisotropy_kc3 = Some(1.0e-40),
                4 => plan.material.ku_field = Some(vec![1.0e-40]),
                5 => plan.material.ku2_field = Some(vec![1.0e-40]),
                6 => plan.material.kc1_field = Some(vec![1.0e-40]),
                _ => plan.material.kc2_field = Some(vec![1.0e-40]),
            }
            assert!(
                validate_supported_relax_source(&plan).is_err(),
                "nonzero higher-order or nodal anisotropy contribution {mutation} must remain unsupported"
            );
        }
        let mut nonzero_kc3_field = baseline;
        nonzero_kc3_field.material.kc3_field = Some(vec![1.0e-40]);
        assert!(validate_supported_relax_source(&nonzero_kc3_field).is_err());
    }

    #[test]
    fn zero_ku_with_zero_axis_is_absent_from_material_identity() {
        let mut material = fullmag_ir::MaterialIR {
            saturation_magnetisation: 800_000.0,
            exchange_stiffness: 1.3e-11,
            uniaxial_anisotropy: Some(0.0),
            anisotropy_axis: Some([0.0; 3]),
            ..Default::default()
        };
        assert_eq!(constant_uniaxial_descriptor(&material).unwrap(), None);

        let zero_ku = equilibrium_material_signature(&material).unwrap();
        material.uniaxial_anisotropy = None;
        material.anisotropy_axis = None;
        assert_eq!(
            zero_ku,
            equilibrium_material_signature(&material).unwrap(),
            "an undefined axis cannot add a material identity when Ku is exactly zero"
        );

        let mut plan = fullmag_ir::FemPlanIR::default();
        plan.material.uniaxial_anisotropy = Some(0.0);
        plan.material.anisotropy_axis = Some([0.0; 3]);
        validate_supported_relax_source(&plan)
            .expect("an all-zero Ku descriptor has no physical axis requirement");
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
        assert_eq!(
            original.0,
            "sha256:9b182909389d5b92f6ade8d0267a22e58073755e8a47e3fe04c191b92a6c6cf6",
            "uniform-Ms Ku=0 must retain the historical V2 material identity"
        );
        assert!(constant_uniaxial_descriptor(&material).unwrap().is_some());
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

    #[test]
    fn replay_accepts_published_v1_and_v2_including_explicit_zero_ku() {
        let v1 = r#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v1","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null}"#;
        let v2 = r#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v2","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null,"uniaxial_anisotropy_j_per_m3":0.0,"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,0.0]}"#;
        assert!(replay_equilibrium_material_signature(
            v1,
            "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af",
        )
        .is_ok());
        assert!(replay_equilibrium_material_signature(
            v2,
            "sha256:5aff2c9f1fa917b8f55646cdb181e93feb1d2d8052d265d7256da089944e0f1b",
        )
        .is_ok());
        assert_ne!(
            equilibrium_material_signature_digest_from_preimage(v1).unwrap(),
            equilibrium_material_signature_digest_from_preimage(v2).unwrap(),
            "Ku=0 remains in the V2 namespace"
        );
    }

    #[test]
    fn replay_binds_exact_whitespace_and_number_bytes() {
        let v1 = r#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v1","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null}"#;
        let whitespace = format!("{v1} \n");
        let error = replay_equilibrium_material_signature(
            &whitespace,
            "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af",
        )
        .unwrap_err();
        assert!(error.message.contains("digest_mismatch"));
        let lexical_mutation = v1.replace("800000.0", "8.0e5");
        let error = replay_equilibrium_material_signature(
            &lexical_mutation,
            "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af",
        )
        .unwrap_err();
        assert!(error.message.contains("digest_mismatch"));
    }

    #[test]
    fn replay_rejects_mixed_schema_unknown_fields_and_invalid_values() {
        let v1 = r#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v1","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null}"#;
        let v2 = r#"{"schema_version":"EquilibriumMaterialSignaturePreimage.v2","saturation_magnetisation_a_per_m":800000.0,"exchange_stiffness_j_per_m":1.3e-11,"saturation_magnetisation_field_a_per_m":null,"exchange_stiffness_field_j_per_m":null,"uniaxial_anisotropy_j_per_m3":0.0,"canonical_uniaxial_axis":[0.5547001962252291,0.8320502943378437,0.0]}"#;
        let unknown = v1.replace(
            "}",
            ",\"uniaxial_anisotropy_j_per_m3\":0.0}",
        );
        assert!(equilibrium_material_signature_digest_from_preimage(&unknown).is_err());
        let duplicate = v1.replace(
            "\"schema_version\":\"EquilibriumMaterialSignaturePreimage.v1\",",
            "\"schema_version\":\"EquilibriumMaterialSignaturePreimage.v1\",\"schema_version\":\"EquilibriumMaterialSignaturePreimage.v1\",",
        );
        assert!(equilibrium_material_signature_digest_from_preimage(&duplicate).is_err());
        let mixed_schema = v2.replace(
            "EquilibriumMaterialSignaturePreimage.v2",
            "EquilibriumMaterialSignaturePreimage.v1",
        );
        assert!(equilibrium_material_signature_digest_from_preimage(&mixed_schema).is_err());
        let invalid_ms = v1.replace("800000.0", "0.0");
        assert!(equilibrium_material_signature_digest_from_preimage(&invalid_ms).is_err());
        let invalid_aex = v1.replace("1.3e-11", "-1.3e-11");
        assert!(equilibrium_material_signature_digest_from_preimage(&invalid_aex).is_err());
        let invalid_axis = v2.replace(
            "0.5547001962252291",
            "-0.5547001962252291",
        );
        assert!(equilibrium_material_signature_digest_from_preimage(&invalid_axis).is_err());
        let spatial_ms = v2.replace(
            "\"saturation_magnetisation_field_a_per_m\":null",
            "\"saturation_magnetisation_field_a_per_m\":[]",
        );
        assert!(equilibrium_material_signature_digest_from_preimage(&spatial_ms).is_err());
        let invalid_nonfinite = v1.replace("800000.0", "NaN");
        assert!(equilibrium_material_signature_digest_from_preimage(&invalid_nonfinite).is_err());
    }

}
