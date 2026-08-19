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
fn v2_skyrmion_polarity_is_the_actual_core_sign() {
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let positive = params([
        ("radius", json!(1.0)),
        ("wall_width", json!(0.2)),
        ("core_polarity", json!(1)),
    ]);
    let negative = params([
        ("radius", json!(1.0)),
        ("wall_width", json!(0.2)),
        ("core_polarity", json!(-1)),
    ]);

    let positive_value = sample_preset_texture_versioned(
        "neel_skyrmion",
        2,
        &positive,
        &mapping,
        &transform,
        &[point(0.0, 0.0, 0.0)],
    )
    .unwrap()[0];
    let negative_value = sample_preset_texture_versioned(
        "neel_skyrmion",
        2,
        &negative,
        &mapping,
        &transform,
        &[point(0.0, 0.0, 0.0)],
    )
    .unwrap()[0];

    assert!((positive_value[2] - 1.0).abs() < 1.0e-12);
    assert!((negative_value[2] + 1.0).abs() < 1.0e-12);
}

#[test]
fn v2_xz_frame_keeps_core_normal_right_handed() {
    let preset_params = params([("plane", json!("xz")), ("core_radius", json!(1.0e-9))]);
    let values = sample_preset_texture_versioned(
        "vortex",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .unwrap();

    assert_eq!(values[0], [0.0, -1.0, 0.0]);
}

#[test]
fn v2_texture_rotation_rotates_the_output_vector() {
    let quarter_turn = 2.0_f64.sqrt() / 2.0;
    let transform = TextureTransform3DIR {
        rotation_quat: [0.0, 0.0, quarter_turn, quarter_turn],
        ..TextureTransform3DIR::default()
    };
    let values = sample_preset_texture_versioned(
        "uniform",
        2,
        &params([("direction", json!([1.0, 0.0, 0.0]))]),
        &TextureMappingIR::default(),
        &transform,
        &[point(0.0, 0.0, 0.0)],
    )
    .unwrap();

    assert!((values[0][0]).abs() < 1.0e-12);
    assert!((values[0][1] - 1.0).abs() < 1.0e-12);
}

#[test]
fn v2_rejects_degenerate_domain_wall_and_projection_conflict() {
    let domain_wall = params([
        ("kind", json!("neel")),
        ("width", json!(1.0)),
        ("left", json!([1.0, 0.0, 0.0])),
        ("right", json!([-1.0, 0.0, 0.0])),
        ("normal_axis", json!("x")),
        ("wall_center_direction", json!([1.0, 0.0, 0.0])),
    ]);
    assert!(sample_preset_texture_versioned(
        "domain_wall",
        2,
        &domain_wall,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .is_err());

    let vortex = params([("plane", json!("xy"))]);
    let mapping = TextureMappingIR {
        projection: fullmag_ir::TextureProjectionMode::PlanarXz,
        ..TextureMappingIR::default()
    };
    assert!(sample_preset_texture_versioned(
        "vortex",
        2,
        &vortex,
        &mapping,
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .is_err());
}

#[test]
fn v2_validates_parameters_before_empty_or_inactive_sampling() {
    let invalid = params([("core_radius", json!(0.0))]);
    assert!(sample_preset_texture_versioned(
        "vortex",
        2,
        &invalid,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[],
    )
    .is_err());

    let inactive = TextureSamplePoint {
        position_world: [0.0, 0.0, 0.0],
        position_object: [0.0, 0.0, 0.0],
        active: false,
    };
    assert!(sample_preset_texture_versioned(
        "vortex",
        2,
        &invalid,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[inactive],
    )
    .is_err());

    let uniform = params([("direction", json!([1.0, 0.0, 0.0]))]);
    assert!(sample_preset_texture_versioned(
        "uniform",
        2,
        &uniform,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(f64::NAN, 0.0, 0.0)],
    )
    .is_err());
}

#[test]
fn v2_derives_distinct_bloch_and_neel_wall_directions() {
    let base = [
        ("width", json!(1.0)),
        ("left", json!([1.0, 0.0, 0.0])),
        ("right", json!([-1.0, 0.0, 0.0])),
        ("normal_axis", json!("x")),
    ];
    let neel = params(base);
    let mut bloch = neel.clone();
    bloch.insert("kind".to_string(), json!("bloch"));
    let mut neel = neel;
    neel.insert("kind".to_string(), json!("neel"));

    let neel_value = sample_preset_texture_versioned(
        "domain_wall",
        2,
        &neel,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .unwrap()[0];
    let bloch_value = sample_preset_texture_versioned(
        "domain_wall",
        2,
        &bloch,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .unwrap()[0];

    assert!(neel_value[1].abs() > 0.99);
    assert!(bloch_value[2].abs() > 0.99);
    assert!(neel_value
        .iter()
        .zip(bloch_value)
        .any(|(left, right)| (left - right).abs() > 0.5));
}
