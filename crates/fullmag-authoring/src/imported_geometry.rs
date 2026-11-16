//! Shared authoring normalization for executable local STL imports.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedStlParameters {
    pub source: String,
    /// Effective multiplier from source coordinates to SI metres.
    pub scale: [f64; 3],
    pub surface_only: bool,
}

pub fn imported_stl_parameters(params: &Value) -> Result<ImportedStlParameters, String> {
    let source = params
        .get("source")
        .and_then(Value::as_str)
        .filter(|source| !source.trim().is_empty() && !source.chars().any(char::is_control))
        .ok_or_else(|| "ImportedGeometry.source must be a nonempty local STL path".to_string())?;
    if source.contains("://") || !source.to_ascii_lowercase().ends_with(".stl") {
        return Err(
            "The FEM source-surface importer currently supports local .stl files".to_string(),
        );
    }
    if let Some(format) = params.get("format").filter(|value| !value.is_null()) {
        if !format
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case("stl"))
        {
            return Err("ImportedGeometry.format must be stl for this importer".to_string());
        }
    }
    let unit = match params.get("units").filter(|value| !value.is_null()) {
        None => 1.0,
        Some(value) => match value
            .as_str()
            .map(|value| value.trim().to_lowercase())
            .as_deref()
        {
            Some("m") => 1.0,
            Some("cm") => 1e-2,
            Some("mm") => 1e-3,
            Some("um" | "µm" | "μm") => 1e-6,
            Some("nm") => 1e-9,
            Some("pm") => 1e-12,
            _ => return Err("ImportedGeometry.units is not a recognized length unit".to_string()),
        },
    };
    let mut scale = match params.get("scale") {
        None => [1.0; 3],
        Some(value) if value.is_number() => [value.as_f64().unwrap_or(f64::NAN); 3],
        Some(Value::Array(values)) if values.len() == 3 => {
            std::array::from_fn(|axis| values[axis].as_f64().unwrap_or(f64::NAN))
        }
        _ => {
            return Err("ImportedGeometry.scale must be a positive scalar or 3-vector".to_string())
        }
    };
    for component in &mut scale {
        *component *= unit;
        if !component.is_finite() || *component <= 0.0 {
            return Err(
                "ImportedGeometry.scale must resolve to positive finite SI multipliers".to_string(),
            );
        }
    }
    let surface_only = match params.get("volume") {
        None => false,
        Some(Value::String(value)) if value == "full" => false,
        Some(Value::String(value)) if value == "surface" => true,
        _ => return Err("ImportedGeometry.volume must be full or surface".to_string()),
    };
    Ok(ImportedStlParameters {
        source: source.to_string(),
        scale,
        surface_only,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalized_scale_and_legacy_units_have_identical_si_meaning() {
        let normalized =
            imported_stl_parameters(&json!({"source": "body.stl", "scale": [1e-9, 2e-9, 3e-9]}))
                .unwrap();
        let legacy = imported_stl_parameters(
            &json!({"source": "body.stl", "units": "nm", "scale": [1, 2, 3]}),
        )
        .unwrap();
        assert_eq!(normalized.source, legacy.source);
        assert_eq!(normalized.surface_only, legacy.surface_only);
        for (expected, actual) in normalized.scale.into_iter().zip(legacy.scale) {
            assert!((expected - actual).abs() <= 2.0 * f64::EPSILON * expected.abs());
        }
        assert!(
            imported_stl_parameters(&json!({"source": "body.stl", "volume": "surface"}))
                .unwrap()
                .surface_only
        );
    }

    #[test]
    fn invalid_import_parameters_are_not_silently_defaulted() {
        for value in [
            json!({"source": ""}),
            json!({"source": "body.step"}),
            json!({"source": "https://remote/body.stl"}),
            json!({"source": "body.stl", "scale": null}),
            json!({"source": "body.stl", "scale": false}),
            json!({"source": "body.stl", "scale": 0}),
            json!({"source": "body.stl", "scale": [1, -1, 1]}),
            json!({"source": "body.stl", "scale": [1, 2]}),
            json!({"source": "body.stl", "units": "guess"}),
            json!({"source": "body.stl", "volume": "unknown"}),
        ] {
            assert!(imported_stl_parameters(&value).is_err(), "accepted {value}");
        }
    }
}
