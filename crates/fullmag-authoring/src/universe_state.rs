use crate::ScriptBuilderUniverseState;
use serde::Deserialize;

/// The Python scene producer writes both mesh-size names. Resolve equal aliases
/// at input, retaining the existing serialization used by checkpoint identities.
#[derive(Deserialize)]
pub(crate) struct UniverseStateWire {
    mode: String,
    size: Option<[f64; 3]>,
    center: Option<[f64; 3]>,
    padding: Option<[f64; 3]>,
    airbox_hmax: Option<f64>,
    airbox_hmin: Option<f64>,
    maximum_element_size: Option<f64>,
    minimum_element_size: Option<f64>,
    airbox_growth_rate: Option<f64>,
    airbox_grading: Option<String>,
}

fn mesh_size_alias(
    legacy: Option<f64>,
    current: Option<f64>,
    legacy_name: &str,
    current_name: &str,
) -> Result<Option<f64>, String> {
    match (legacy, current) {
        (Some(a), Some(b)) if a != b => Err(format!(
            "universe mesh aliases {legacy_name} and {current_name} must agree"
        )),
        (_, Some(value)) | (Some(value), None) => Ok(Some(value)),
        (None, None) => Ok(None),
    }
}

impl TryFrom<UniverseStateWire> for ScriptBuilderUniverseState {
    type Error = String;

    fn try_from(wire: UniverseStateWire) -> Result<Self, Self::Error> {
        Ok(Self {
            mode: wire.mode,
            size: wire.size,
            center: wire.center,
            padding: wire.padding,
            airbox_hmax: mesh_size_alias(
                wire.airbox_hmax,
                wire.maximum_element_size,
                "airbox_hmax",
                "maximum_element_size",
            )?,
            airbox_hmin: mesh_size_alias(
                wire.airbox_hmin,
                wire.minimum_element_size,
                "airbox_hmin",
                "minimum_element_size",
            )?,
            airbox_growth_rate: wire.airbox_growth_rate,
            airbox_grading: wire.airbox_grading,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn legacy_current_and_equal_aliases_have_the_same_canonical_state() {
        let variants = [
            json!({"mode":"auto","airbox_hmax":5e-7,"airbox_hmin":1.5e-7}),
            json!({"mode":"auto","maximum_element_size":5e-7,"minimum_element_size":1.5e-7}),
            json!({"mode":"auto","airbox_hmax":5e-7,"airbox_hmin":1.5e-7,
                "maximum_element_size":5e-7,"minimum_element_size":1.5e-7}),
        ];
        let states: Vec<ScriptBuilderUniverseState> = variants.into_iter()
            .map(|raw| serde_json::from_value(raw).unwrap()).collect();
        assert!(states.windows(2).all(|pair| pair[0] == pair[1]));
        for state in states {
            let encoded = serde_json::to_value(&state).unwrap();
            assert_eq!(encoded["airbox_hmax"], json!(5e-7));
            assert_eq!(encoded["airbox_hmin"], json!(1.5e-7));
            assert_eq!(encoded, json!({"mode":"auto","airbox_hmax":5e-7,"airbox_hmin":1.5e-7}));
            assert_eq!(serde_json::from_value::<ScriptBuilderUniverseState>(encoded).unwrap(), state);
        }
    }

    #[test]
    fn legacy_checkpoint_serialization_bytes_are_unchanged() {
        let state: ScriptBuilderUniverseState = serde_json::from_value(json!({
            "mode":"auto","airbox_hmax":5e-7,"airbox_hmin":1.5e-7
        })).unwrap();
        assert_eq!(serde_json::to_string(&state).unwrap(),
            r#"{"mode":"auto","airbox_hmax":5e-7,"airbox_hmin":1.5e-7}"#);
    }

    #[test]
    fn contradictory_mesh_aliases_are_rejected_without_a_tolerance() {
        for (legacy, current) in [
            ("airbox_hmax", "maximum_element_size"),
            ("airbox_hmin", "minimum_element_size"),
        ] {
            let raw = json!({"mode":"auto",(legacy):5e-7,(current):5e-7 + 1e-18});
            let error = serde_json::from_value::<ScriptBuilderUniverseState>(raw).unwrap_err();
            assert!(error.to_string().contains("must agree"));
        }
    }

    #[test]
    fn optional_nulls_keep_the_legacy_canonical_serialization() {
        for size in [Value::Null, json!([2e-6, 3e-6, 4e-6])] {
            let raw = json!({"mode":if size.is_null() { "auto" } else { "manual" },"size":size,"center":[0.0,0.0,0.0],"padding":[1e-7,0.0,0.0],
                "airbox_hmax":null,"airbox_hmin":null,"maximum_element_size":null,
                "minimum_element_size":null,"airbox_growth_rate":null,"airbox_grading":null});
            let state: ScriptBuilderUniverseState = serde_json::from_value(raw.clone()).unwrap();
            let encoded = serde_json::to_value(state).unwrap();
            if size.is_null() {
                assert!(encoded.get("size").is_none());
            } else {
                assert_eq!(encoded["size"], raw["size"]);
            }
            assert_eq!(encoded["padding"], raw["padding"]);
            assert!(encoded.get("maximum_element_size").is_none());
        }
    }
}
