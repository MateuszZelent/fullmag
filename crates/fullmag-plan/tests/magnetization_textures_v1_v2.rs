use fullmag_ir::{TextureMappingIR, TextureTransform3DIR};
use fullmag_plan::{sample_preset_texture_versioned, TextureSamplePoint};
use serde_json::json;
use std::collections::BTreeMap;

fn params(
    entries: impl IntoIterator<Item = (&'static str, serde_json::Value)>,
) -> BTreeMap<String, serde_json::Value> {
    entries
        .into_iter()
        .map(|(key, value)| (key.to_string(), value))
        .collect()
}

fn point(x: f64, y: f64, z: f64) -> TextureSamplePoint {
    TextureSamplePoint {
        position_world: [x, y, z],
        position_object: [x, y, z],
        active: true,
    }
}

#[test]
fn versioned_sampler_accepts_v1_and_v2_without_changing_mapping_contract() {
    let mapping = TextureMappingIR {
        space: "object".to_string(),
        projection: fullmag_ir::TextureProjectionMode::ObjectLocal,
        clamp_mode: "none".to_string(),
    };
    let transform = TextureTransform3DIR::default();
    let preset_params = params([("direction", json!([1.0, 0.0, 0.0]))]);

    for version in [1, 2] {
        let values = sample_preset_texture_versioned(
            "uniform",
            version,
            &preset_params,
            &mapping,
            &transform,
            &[point(0.0, 0.0, 0.0)],
        )
        .unwrap();

        assert_eq!(values, vec![[1.0, 0.0, 0.0]]);
    }
}

#[test]
fn v2_vortex_has_a_polarized_regular_core() {
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let preset_params = params([
        ("circulation", json!(1)),
        ("core_polarity", json!(-1)),
        ("core_radius", json!(2.0e-9)),
        ("plane", json!("xy")),
    ]);

    let values = sample_preset_texture_versioned(
        "vortex",
        2,
        &preset_params,
        &mapping,
        &transform,
        &[point(0.0, 0.0, 0.0), point(1.0e-12, 0.0, 0.0)],
    )
    .unwrap();

    assert!((values[0][2] + 1.0).abs() < 1.0e-12);
    assert!(values[1][0].hypot(values[1][1]) < 1.0e-3);
}

#[test]
fn v2_antivortex_has_negative_winding() {
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let preset_params = params([
        ("circulation", json!(1)),
        ("core_polarity", json!(1)),
        ("core_radius", json!(1.0e-9)),
        ("plane", json!("xy")),
    ]);
    let radius = 5.0e-9;
    let points: Vec<_> = (0..64)
        .map(|index| {
            let phi = std::f64::consts::TAU * (index as f64) / 64.0;
            point(radius * phi.cos(), radius * phi.sin(), 0.0)
        })
        .collect();
    let values = sample_preset_texture_versioned(
        "antivortex",
        2,
        &preset_params,
        &mapping,
        &transform,
        &points,
    )
    .unwrap();

    let mut winding = 0.0;
    for index in 0..values.len() {
        let previous = values[index];
        let current = values[(index + 1) % values.len()];
        let previous_phi = previous[1].atan2(previous[0]);
        let current_phi = current[1].atan2(current[0]);
        let mut delta = current_phi - previous_phi;
        if delta > std::f64::consts::PI {
            delta -= std::f64::consts::TAU;
        }
        if delta < -std::f64::consts::PI {
            delta += std::f64::consts::TAU;
        }
        winding += delta;
    }
    assert!((winding / std::f64::consts::TAU + 1.0).abs() < 1.0e-6);
}

#[test]
fn v2_helical_preserves_physical_wavevector_period() {
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let q = 2.0e7;
    let preset_params = params([
        ("wavevector", json!([q, 0.0, 0.0])),
        ("e1", json!([1.0, 0.0, 0.0])),
        ("e2", json!([0.0, 1.0, 0.0])),
        ("phase_rad", json!(0.3)),
    ]);
    let period = std::f64::consts::TAU / q;
    let values = sample_preset_texture_versioned(
        "helical",
        2,
        &preset_params,
        &mapping,
        &transform,
        &[point(0.0, 0.0, 0.0), point(period, 0.0, 0.0)],
    )
    .unwrap();

    for component in 0..3 {
        assert!((values[0][component] - values[1][component]).abs() < 1.0e-12);
    }
}
