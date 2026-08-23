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
fn v2_texture_translation_moves_the_profile_without_translating_spin_vectors() {
    let transform = TextureTransform3DIR {
        translation: [2.0, -1.0, 0.5],
        ..TextureTransform3DIR::default()
    };
    let values = sample_preset_texture_versioned(
        "vortex",
        2,
        &params([
            ("core_radius", json!(0.25)),
            ("core_polarity", json!(1)),
            ("circulation", json!(1)),
            ("plane", json!("xy")),
        ]),
        &TextureMappingIR::default(),
        &transform,
        &[point(2.0, -1.0, 0.5), point(3.0, -1.0, 0.5)],
    )
    .unwrap();

    assert!(values[0][0].abs() < 1.0e-12);
    assert!(values[0][1].abs() < 1.0e-12);
    assert!((values[0][2] - 1.0).abs() < 1.0e-12);
    assert!(values[1][1] > 0.99);
    assert!(values[1][2].abs() < 1.0e-6);
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

#[test]
fn v2_bimeron_uses_exact_meron_core_radius() {
    let radius = 1.0_f64;
    let wall_width = 1.0_f64;
    let exact_core_radius = wall_width * (radius / wall_width).cosh().asinh();
    let preset_params = params([
        ("radius", json!(radius)),
        ("wall_width", json!(wall_width)),
        ("vorticity", json!(1)),
        ("helicity_rad", json!(0.0)),
        ("background_sign", json!(1)),
        ("plane", json!("xy")),
    ]);

    let values = sample_preset_texture_versioned(
        "bimeron",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[
            point(0.0, 0.0, 0.0),
            point(exact_core_radius, 0.0, 0.0),
            point(-exact_core_radius, 0.0, 0.0),
        ],
    )
    .unwrap();

    assert!(exact_core_radius > radius + 0.2);
    assert!((values[0][0] + 1.0).abs() < 1.0e-12);
    assert!(values[0][1].abs() < 1.0e-12);
    assert!(values[0][2].abs() < 1.0e-12);

    assert!(values[1][0].abs() < 1.0e-12);
    assert!(values[1][1].abs() < 1.0e-12);
    assert!((values[1][2] + 1.0).abs() < 1.0e-12);

    assert!(values[2][0].abs() < 1.0e-12);
    assert!(values[2][1].abs() < 1.0e-12);
    assert!((values[2][2] - 1.0).abs() < 1.0e-12);
}

#[test]
fn v2_neel_chirality_reverses_the_radial_wall_direction() {
    let positive = params([
        ("radius", json!(1.0)),
        ("wall_width", json!(0.2)),
        ("chirality", json!(1)),
        ("core_polarity", json!(-1)),
    ]);
    let negative = params([
        ("radius", json!(1.0)),
        ("wall_width", json!(0.2)),
        ("chirality", json!(-1)),
        ("core_polarity", json!(-1)),
    ]);

    let positive_value = sample_preset_texture_versioned(
        "neel_skyrmion",
        2,
        &positive,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(1.0, 0.0, 0.0)],
    )
    .unwrap()[0];
    let negative_value = sample_preset_texture_versioned(
        "neel_skyrmion",
        2,
        &negative,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(1.0, 0.0, 0.0)],
    )
    .unwrap()[0];

    assert!(positive_value[0] > 0.99);
    assert!(negative_value[0] < -0.99);
    assert!(positive_value[1].abs() < 1.0e-12);
    assert!(negative_value[1].abs() < 1.0e-12);
}

#[test]
fn v2_antiskyrmion_reverses_azimuthal_winding() {
    let preset_params = params([
        ("radius", json!(1.0)),
        ("wall_width", json!(0.2)),
        ("chirality", json!(1)),
        ("core_polarity", json!(-1)),
    ]);
    let coordinate = 2.0_f64.sqrt() / 2.0;
    let ordinary = sample_preset_texture_versioned(
        "neel_skyrmion",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(coordinate, coordinate, 0.0)],
    )
    .unwrap()[0];
    let anti = sample_preset_texture_versioned(
        "antiskyrmion",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(coordinate, coordinate, 0.0)],
    )
    .unwrap()[0];

    assert!((ordinary[0] - anti[0]).abs() < 1.0e-12);
    assert!((ordinary[1] + anti[1]).abs() < 1.0e-12);
    assert!(ordinary[1] > 0.0);
    assert!(anti[1] < 0.0);
}

#[test]
fn v2_antivortex_has_opposite_winding_to_vortex() {
    let preset_params = params([
        ("circulation", json!(1)),
        ("core_polarity", json!(1)),
        ("core_radius", json!(0.1)),
    ]);
    let coordinate = 2.0_f64.sqrt() / 2.0;
    let vortex = sample_preset_texture_versioned(
        "vortex",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(coordinate, coordinate, 0.0)],
    )
    .unwrap()[0];
    let antivortex = sample_preset_texture_versioned(
        "antivortex",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(coordinate, coordinate, 0.0)],
    )
    .unwrap()[0];

    assert!(vortex[0] < 0.0 && vortex[1] > 0.0);
    assert!(antivortex[0] > 0.0 && antivortex[1] > 0.0);
}

#[test]
fn v2_skyrmionium_has_equal_center_and_far_backgrounds() {
    let preset_params = params([
        ("inner_radius", json!(1.0)),
        ("outer_radius", json!(2.0)),
        ("wall_width", json!(0.1)),
        ("kind", json!("neel")),
        ("chirality", json!(1)),
        ("background_sign", json!(1)),
    ]);
    let values = sample_preset_texture_versioned(
        "skyrmionium",
        2,
        &preset_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[
            point(0.0, 0.0, 0.0),
            point(1.5, 0.0, 0.0),
            point(8.0, 0.0, 0.0),
        ],
    )
    .unwrap();

    assert!(values[0][2] > 0.999);
    assert!(values[1][2] < -0.999);
    assert!(values[2][2] > 0.999);

    let invalid_params = params([
        ("inner_radius", json!(2.0)),
        ("outer_radius", json!(1.0)),
        ("wall_width", json!(0.1)),
    ]);
    assert!(sample_preset_texture_versioned(
        "skyrmionium",
        2,
        &invalid_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .is_err());
}

#[test]
fn v2_hopfion_is_normalized_and_reverses_orientation_with_charge() {
    let positive = params([
        ("radius", json!(1.0)),
        ("hopf_charge", json!(1)),
        ("background_sign", json!(1)),
        ("axial_scale", json!(1.0)),
        ("phase_rad", json!(0.0)),
    ]);
    let negative = params([
        ("radius", json!(1.0)),
        ("hopf_charge", json!(-1)),
        ("background_sign", json!(1)),
        ("axial_scale", json!(1.0)),
        ("phase_rad", json!(0.0)),
    ]);
    let points = [
        point(0.0, 0.0, 0.0),
        point(1.0, 0.0, 0.0),
        point(0.4, 0.3, 0.2),
        point(100.0, 0.0, 0.0),
    ];
    let positive_values = sample_preset_texture_versioned(
        "hopfion",
        2,
        &positive,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &points,
    )
    .unwrap();
    let negative_values = sample_preset_texture_versioned(
        "hopfion",
        2,
        &negative,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &points,
    )
    .unwrap();

    assert!(positive_values[0][2] > 0.999999);
    assert!(positive_values[1][2] < -0.999999);
    assert!(positive_values[3][2] > 0.999);
    for value in &positive_values {
        let norm = value
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt();
        assert!((norm - 1.0).abs() < 1.0e-12);
    }
    assert!(positive_values[2]
        .iter()
        .zip(negative_values[2])
        .any(|(left, right)| (left - right).abs() > 1.0e-3));

    let planar_mapping = TextureMappingIR {
        projection: fullmag_ir::TextureProjectionMode::PlanarXy,
        ..TextureMappingIR::default()
    };
    assert!(sample_preset_texture_versioned(
        "hopfion",
        2,
        &positive,
        &planar_mapping,
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .is_err());
}
