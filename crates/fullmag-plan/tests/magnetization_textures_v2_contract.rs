use fullmag_ir::{
    RegionFrameIR, RegionShapeIR, TextureMappingIR, TextureProjectionMode, TextureTransform3DIR,
};
use fullmag_plan::{
    region_shape_bounds_in_object_space, sample_preset_texture_versioned,
    sample_preset_texture_versioned_with_bounds, AffineTransform3, TextureSamplePoint,
};
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
        position_region: None,
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
        position_region: None,
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

#[test]
fn v2_clamp_modes_default_period_and_metric_background_frame_parity() {
    let sk_params = params([
        ("radius", json!(10.0e-9)),
        ("wall_width", json!(3.0e-9)),
        ("core_polarity", json!(-1)),
        ("chirality", json!(1)),
        ("plane", json!("xy")),
    ]);

    // 1. Unified default tile_period uses pre-transform source bbox so scale=0.5 tiles 2x cleanly
    let pts = [
        point(-25.0e-9, -25.0e-9, -5.0e-9),
        point(0.0, 0.0, 0.0),
        point(25.0e-9, 0.0, 0.0),
        point(25.0e-9, 25.0e-9, 5.0e-9),
    ];
    let scale_half = TextureTransform3DIR {
        scale: [0.5, 0.5, 1.0],
        ..TextureTransform3DIR::default()
    };
    let repeat_default = TextureMappingIR {
        clamp_mode: "repeat".to_string(),
        ..TextureMappingIR::default()
    };
    let repeat_explicit = TextureMappingIR {
        clamp_mode: "repeat".to_string(),
        tile_period: Some([50.0e-9, 50.0e-9, 10.0e-9]),
        ..TextureMappingIR::default()
    };
    let vals_default = sample_preset_texture_versioned(
        "bloch_skyrmion",
        2,
        &sk_params,
        &repeat_default,
        &scale_half,
        &pts,
    )
    .unwrap();
    let vals_explicit = sample_preset_texture_versioned(
        "bloch_skyrmion",
        2,
        &sk_params,
        &repeat_explicit,
        &scale_half,
        &pts,
    )
    .unwrap();
    for (a, b) in vals_default.iter().zip(vals_explicit.iter()) {
        for c in 0..3 {
            assert!((a[c] - b[c]).abs() < 1.0e-12);
        }
    }
    assert!(vals_default[1][2] < -0.99);
    assert!(vals_default[2][2] < -0.99);

    // 2. Hard clamp and mirror modes
    let mirror_mapping = TextureMappingIR {
        clamp_mode: "mirror".to_string(),
        tile_period: Some([50.0e-9, 50.0e-9, 10.0e-9]),
        ..TextureMappingIR::default()
    };
    let mirror_vals = sample_preset_texture_versioned(
        "bloch_skyrmion",
        2,
        &sk_params,
        &mirror_mapping,
        &TextureTransform3DIR::default(),
        &[point(10.0e-9, 0.0, 0.0), point(40.0e-9, 0.0, 0.0)],
    )
    .unwrap();
    for c in 0..3 {
        assert!((mirror_vals[0][c] - mirror_vals[1][c]).abs() < 1.0e-12);
    }

    let clamp_mapping = TextureMappingIR {
        clamp_mode: "clamp".to_string(),
        tile_period: Some([50.0e-9, 50.0e-9, 10.0e-9]),
        ..TextureMappingIR::default()
    };
    let clamp_vals = sample_preset_texture_versioned(
        "bloch_skyrmion",
        2,
        &sk_params,
        &clamp_mapping,
        &TextureTransform3DIR::default(),
        &[point(25.0e-9, 0.0, 0.0), point(80.0e-9, 0.0, 0.0)],
    )
    .unwrap();
    for c in 0..3 {
        assert!((clamp_vals[0][c] - clamp_vals[1][c]).abs() < 1.0e-12);
    }

    // 3. Default background vector passes through metric_vector frame on xy/xz/yz
    for (plane, expected_bg) in [
        ("xy", [0.0, 0.0, 1.0]),
        ("xz", [0.0, -1.0, 0.0]),
        ("yz", [1.0, 0.0, 0.0]),
    ] {
        let vortex_params = params([
            ("plane", json!(plane)),
            ("circulation", json!(1)),
            ("core_polarity", json!(1)),
            ("core_radius", json!(4.0e-9)),
        ]);
        let bg_mapping = TextureMappingIR {
            clamp_mode: "background".to_string(),
            tile_period: Some([20.0e-9, 20.0e-9, 20.0e-9]),
            ..TextureMappingIR::default()
        };
        let vals = sample_preset_texture_versioned(
            "vortex",
            2,
            &vortex_params,
            &bg_mapping,
            &TextureTransform3DIR::default(),
            &[point(30.0e-9, 30.0e-9, 30.0e-9)],
        )
        .unwrap();
        for c in 0..3 {
            assert!((vals[0][c] - expected_bg[c]).abs() < 1.0e-12);
        }
    }
}

#[test]
fn v2_rotate_vectors_false_thickness_confinement_and_region_space() {
    // 1. rotate_vectors = false keeps spin vectors fixed while tilting spatial domain wall
    let angle = std::f64::consts::FRAC_PI_4;
    let q_z_45 = [0.0, 0.0, (0.5 * angle).sin(), (0.5 * angle).cos()];
    let wall_params = params([
        ("width", json!(10.0e-9)),
        ("kind", json!("bloch")),
        ("normal_axis", json!("x")),
        ("left", json!([0.0, 0.0, 1.0])),
        ("right", json!([0.0, 0.0, -1.0])),
    ]);
    let t_space_only = TextureTransform3DIR {
        rotation_quat: q_z_45,
        rotate_vectors: false,
        ..TextureTransform3DIR::default()
    };
    let t_coupled = TextureTransform3DIR {
        rotation_quat: q_z_45,
        rotate_vectors: true,
        ..TextureTransform3DIR::default()
    };
    let wall_center_pt = [point(-20.0e-9, 20.0e-9, 0.0)];
    let m_space_only = sample_preset_texture_versioned(
        "domain_wall",
        2,
        &wall_params,
        &TextureMappingIR::default(),
        &t_space_only,
        &wall_center_pt,
    )
    .unwrap()[0];
    let m_coupled = sample_preset_texture_versioned(
        "domain_wall",
        2,
        &wall_params,
        &TextureMappingIR::default(),
        &t_coupled,
        &wall_center_pt,
    )
    .unwrap()[0];
    let inv_sqrt2 = std::f64::consts::FRAC_1_SQRT_2;
    assert!((m_space_only[0]).abs() < 1.0e-12);
    assert!((m_space_only[1] + 1.0).abs() < 1.0e-12);
    assert!((m_coupled[0] - inv_sqrt2).abs() < 1.0e-12);
    assert!((m_coupled[1] + inv_sqrt2).abs() < 1.0e-12);

    // 2. axis_extent_mode = "thickness" confines skyrmion along e_n
    let sk_params = params([
        ("radius", json!(15.0e-9)),
        ("wall_width", json!(4.0e-9)),
        ("core_polarity", json!(-1)),
        ("chirality", json!(1)),
        ("plane", json!("xy")),
    ]);
    let slab_mapping = TextureMappingIR {
        axis_extent_mode: Some("thickness".to_string()),
        axis_thickness_m: Some(1.0e-9),
        ..TextureMappingIR::default()
    };
    let slab_transform = TextureTransform3DIR {
        translation: [0.0, 0.0, 2.0e-9],
        ..TextureTransform3DIR::default()
    };
    let slab_vals = sample_preset_texture_versioned(
        "bloch_skyrmion",
        2,
        &sk_params,
        &slab_mapping,
        &slab_transform,
        &[point(0.0, 0.0, 2.0e-9), point(0.0, 0.0, 3.0e-9)],
    )
    .unwrap();
    assert!(slab_vals[0][2] < -0.99);
    assert!((slab_vals[1][2] - 1.0).abs() < 1.0e-12);

    // 3. Analytic region bounds clipped to object bounds match TS resolveTargetBoundsMeters
    let shape = RegionShapeIR::Box {
        size: [40.0e-9, 20.0e-9, 10.0e-9],
        center: [90.0e-9, 0.0, 0.0],
    };
    let object_bounds = ([-100.0e-9, -50.0e-9, -5.0e-9], [100.0e-9, 50.0e-9, 5.0e-9]);
    let (rmin, rmax) = region_shape_bounds_in_object_space(
        &shape,
        RegionFrameIR::Object,
        AffineTransform3::identity(),
        Some(object_bounds),
    )
    .unwrap();
    // Clipped x range is [70nm, 100nm] -> center 85nm, extent 30nm
    assert!((rmin[0] - 70.0e-9).abs() < 1.0e-15);
    assert!((rmax[0] - 100.0e-9).abs() < 1.0e-15);
    let region_center = [
        0.5 * (rmin[0] + rmax[0]),
        0.5 * (rmin[1] + rmax[1]),
        0.5 * (rmin[2] + rmax[2]),
    ];
    let region_extent = [rmax[0] - rmin[0], rmax[1] - rmin[1], rmax[2] - rmin[2]];
    let vortex_params = params([
        ("circulation", json!(1)),
        ("core_polarity", json!(1)),
        ("core_radius", json!(4.0e-9)),
        ("plane", json!("xy")),
    ]);
    let region_mapping = TextureMappingIR {
        space: "region".to_string(),
        clamp_mode: "clamp".to_string(),
        ..TextureMappingIR::default()
    };
    let region_pt = TextureSamplePoint {
        position_world: [85.0e-9, 0.0, 0.0],
        position_object: [85.0e-9, 0.0, 0.0],
        position_region: Some([
            85.0e-9 - region_center[0],
            -region_center[1],
            -region_center[2],
        ]),
        active: true,
    };
    let region_vals = sample_preset_texture_versioned_with_bounds(
        "vortex",
        2,
        &vortex_params,
        &region_mapping,
        &TextureTransform3DIR::default(),
        &[region_pt],
        Some(region_extent),
    )
    .unwrap();
    assert!((region_vals[0][2] - 1.0).abs() < 1.0e-12);
}

#[test]
fn v2_wave2_presets_evaluate_unit_norm_and_reject_invalid_projection() {
    let sk_lat = params([
        ("lattice", json!("hexagonal")),
        ("lattice_constant", json!(60.0e-9)),
        ("radius", json!(15.0e-9)),
        ("wall_width", json!(4.0e-9)),
        ("kind", json!("bloch")),
        ("core_polarity", json!(-1)),
        ("chirality", json!(1)),
        ("plane", json!("xy")),
    ]);
    let sk_vals = sample_preset_texture_versioned(
        "skyrmion_lattice",
        2,
        &sk_lat,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0), point(60.0e-9, 0.0, 0.0)],
    )
    .unwrap();
    for c in 0..3 {
        assert!((sk_vals[0][c] - sk_vals[1][c]).abs() < 1.0e-12);
    }

    let spiral_params = params([
        ("spiral_kind", json!("cycloidal")),
        ("wavelength", json!(40.0e-9)),
        ("propagation_axis", json!([1.0, 0.0, 0.0])),
        ("chirality", json!(1)),
        ("phase_rad", json!(0.0)),
    ]);
    let sp_vals = sample_preset_texture_versioned(
        "spiral",
        2,
        &spiral_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0), point(40.0e-9, 0.0, 0.0)],
    )
    .unwrap();
    for c in 0..3 {
        assert!((sp_vals[0][c] - sp_vals[1][c]).abs() < 1.0e-12);
    }

    let bp_params = params([
        ("bp_kind", json!("circulating")),
        ("polarity", json!(1)),
        ("twist_rad", json!(std::f64::consts::FRAC_PI_2)),
        ("core_radius", json!(1.0e-9)),
    ]);
    let bp_vals = sample_preset_texture_versioned(
        "bloch_point",
        2,
        &bp_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0), point(10.0e-9, 0.0, 0.0)],
    )
    .unwrap();
    assert!((bp_vals[0][2] - 1.0).abs() < 1.0e-12);
    assert!((bp_vals[1][1] - 1.0).abs() < 1.0e-12);
    let planar = TextureMappingIR {
        projection: TextureProjectionMode::PlanarXy,
        ..TextureMappingIR::default()
    };
    assert!(sample_preset_texture_versioned(
        "bloch_point",
        2,
        &bp_params,
        &planar,
        &TextureTransform3DIR::default(),
        &[point(0.0, 0.0, 0.0)],
    )
    .is_err());

    let asi_params = params([
        ("lattice", json!("square")),
        ("vertex_state", json!("type_i_ground")),
        ("pitch", json!(50.0e-9)),
        ("plane", json!("xy")),
    ]);
    let asi_vals = sample_preset_texture_versioned(
        "artificial_spin_ice",
        2,
        &asi_params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        &[
            point(25.0e-9, 0.0, 0.0),
            point(-25.0e-9, 0.0, 0.0),
            point(0.0, 25.0e-9, 0.0),
            point(0.0, -25.0e-9, 0.0),
        ],
    )
    .unwrap();
    assert!((asi_vals[0][0] - 1.0).abs() < 1.0e-12);
    assert!((asi_vals[1][0] + 1.0).abs() < 1.0e-12);
    assert!((asi_vals[2][1] + 1.0).abs() < 1.0e-12);
    assert!((asi_vals[3][1] - 1.0).abs() < 1.0e-12);
}
