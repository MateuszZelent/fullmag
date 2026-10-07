use crate::model::MaterialIR;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// Strict 0.4-only deserialization for the shared material model.
///
/// Keep this complete mirror aligned with MaterialIR; Serde's remote derive
/// checks that each current field matches the shared type.
#[derive(Deserialize)]
#[serde(remote = "MaterialIR", deny_unknown_fields)]
struct MaterialIRV04Def {
    name: String,
    saturation_magnetisation: f64,
    exchange_stiffness: f64,
    damping: f64,
    uniaxial_anisotropy: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uniaxial_anisotropy_k2: Option<f64>,
    anisotropy_axis: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cubic_anisotropy_kc1: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cubic_anisotropy_kc2: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cubic_anisotropy_kc3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cubic_anisotropy_axis1: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cubic_anisotropy_axis2: Option<[f64; 3]>,
    // Per-node spatially varying fields (when Some, override the scalar)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ms_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    a_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    alpha_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ku_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ku2_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kc1_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kc2_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    kc3_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    interfacial_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bulk_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dind_field: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dbulk_field: Option<Vec<f64>>,
}

/// Decode the V04 material array through the strict remote mirror while
/// preserving the legacy public MaterialIR deserializer.
pub(crate) fn deserialize_materials<'de, D>(deserializer: D) -> Result<Vec<MaterialIR>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<Value>::deserialize(deserializer)?;
    values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            MaterialIRV04Def::deserialize(value).map_err(|error| {
                <D::Error as serde::de::Error>::custom(format!("/materials/{index}: {error}"))
            })
        })
        .collect()
}
