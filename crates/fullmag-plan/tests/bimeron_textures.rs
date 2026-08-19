use fullmag_ir::{TextureMappingIR, TextureTransform3DIR};
use fullmag_plan::{sample_preset_texture, TextureSamplePoint};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;

fn params(radius: f64, wall_width: f64, plane: &str) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("radius".to_string(), Value::from(radius)),
        ("wall_width".to_string(), Value::from(wall_width)),
        ("vorticity".to_string(), Value::from(1)),
        ("helicity_rad".to_string(), Value::from(0.0)),
        ("background_sign".to_string(), Value::from(1)),
        ("plane".to_string(), Value::from(plane)),
    ])
}

fn point(position: [f64; 3]) -> TextureSamplePoint {
    TextureSamplePoint {
        position_world: position,
        position_object: position,
        active: true,
    }
}

#[test]
fn bimeron_has_in_plane_background_and_opposite_meron_cores() {
    let radius = 20e-9;
    let wall_width = 2e-9;
    let params = params(radius, wall_width, "xy");
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let points = [
        point([0.0, 0.0, 0.0]),
        point([radius + 20.0 * wall_width, 0.0, 0.0]),
        point([radius, 0.0, 0.0]),
        point([-radius, 0.0, 0.0]),
    ];

    let values = sample_preset_texture("bimeron", &params, &mapping, &transform, &points)
        .expect("bimeron sampling should succeed");

    assert!(values[0][0] < -0.999, "centre: {:?}", values[0]);
    assert!(values[1][0] > 0.999, "far field: {:?}", values[1]);
    assert!(values[2][2] < -0.99, "+radius core: {:?}", values[2]);
    assert!(values[3][2] > 0.99, "-radius core: {:?}", values[3]);
    for value in values {
        let norm = (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt();
        assert!((norm - 1.0).abs() < 1e-12, "not normalized: {:?}", value);
    }
}

#[test]
fn bimeron_rejects_invalid_parameters_and_handles_tiny_wall_width() {
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let points = [point([0.0, 0.0, 0.0])];
    let base = params(20e-9, 2e-9, "xy");

    for (key, value) in [
        ("radius", Value::from(0.0)),
        ("wall_width", Value::from(0.0)),
        ("vorticity", Value::from(0)),
        ("background_sign", Value::from(2)),
        ("plane", Value::from("invalid")),
    ] {
        let mut invalid = base.clone();
        invalid.insert(key.to_string(), value);
        assert!(
            sample_preset_texture("bimeron", &invalid, &mapping, &transform, &points).is_err(),
            "invalid {key} should be rejected"
        );
    }

    let mut tiny = base;
    tiny.insert("wall_width".to_string(), Value::from(1e-300));
    let value = sample_preset_texture("bimeron", &tiny, &mapping, &transform, &points)
        .expect("stable profile should handle tiny wall width")[0];
    assert!(value.iter().all(|component| component.is_finite()));

    let skyrmion = BTreeMap::from([
        ("plane".to_string(), Value::from("xy")),
        ("radius".to_string(), Value::from(20e-9)),
        ("wall_width".to_string(), Value::from(1e-300)),
        ("core_polarity".to_string(), Value::from(-1)),
    ]);
    let value = sample_preset_texture("neel_skyrmion", &skyrmion, &mapping, &transform, &points)
        .expect("stable skyrmion profile should handle tiny wall width")[0];
    assert!(value.iter().all(|component| component.is_finite()));
}

#[test]
fn bimeron_vorticity_flips_azimuthal_winding() {
    let radius = 20e-9;
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let points = [point([0.0, radius, 0.0])];
    let positive = params(radius, 2e-9, "xy");
    let mut negative = positive.clone();
    negative.insert("vorticity".to_string(), Value::from(-1));

    let plus = sample_preset_texture("bimeron", &positive, &mapping, &transform, &points)
        .expect("positive vorticity should succeed")[0];
    let minus = sample_preset_texture("bimeron", &negative, &mapping, &transform, &points)
        .expect("negative vorticity should succeed")[0];
    assert!(plus[1] < -0.99, "+1 winding: {:?}", plus);
    assert!(minus[1] > 0.99, "-1 winding: {:?}", minus);
}

#[test]
fn xz_plane_uses_right_handed_normal_for_all_plane_aware_textures() {
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    let centre = [point([0.0, 0.0, 0.0])];

    let mut vortex = BTreeMap::new();
    vortex.insert("plane".to_string(), Value::from("xz"));
    vortex.insert("core_polarity".to_string(), Value::from(1));
    vortex.insert("core_radius".to_string(), Value::from(2e-9));
    let vortex_value = sample_preset_texture("vortex", &vortex, &mapping, &transform, &centre)
        .expect("xz vortex should succeed")[0];
    assert!(
        vortex_value[1] < -0.6,
        "xz vortex normal: {:?}",
        vortex_value
    );

    let mut skyrmion = BTreeMap::new();
    skyrmion.insert("plane".to_string(), Value::from("xz"));
    skyrmion.insert("radius".to_string(), Value::from(20e-9));
    skyrmion.insert("wall_width".to_string(), Value::from(2e-9));
    skyrmion.insert("core_polarity".to_string(), Value::from(-1));
    let skyrmion_value =
        sample_preset_texture("bloch_skyrmion", &skyrmion, &mapping, &transform, &centre)
            .expect("xz skyrmion should succeed")[0];
    assert!(
        skyrmion_value[1] < -0.99,
        "xz skyrmion normal: {:?}",
        skyrmion_value
    );

    let bimeron = params(20e-9, 2e-9, "xz");
    let meron = [point([20e-9, 0.0, 0.0])];
    let bimeron_value = sample_preset_texture("bimeron", &bimeron, &mapping, &transform, &meron)
        .expect("xz bimeron should succeed")[0];
    assert!(
        bimeron_value[1] > 0.99,
        "xz bimeron normal: {:?}",
        bimeron_value
    );
}

#[test]
fn bimeron_matches_shared_rust_python_parity_fixture() {
    #[derive(Deserialize)]
    struct Case {
        params: BTreeMap<String, Value>,
        points: Vec<[f64; 3]>,
        expected: Vec<[f64; 3]>,
    }

    let cases: Vec<Case> = serde_json::from_str(include_str!("fixtures/bimeron_parity.json"))
        .expect("parity fixture should be valid JSON");
    let mapping = TextureMappingIR::default();
    let transform = TextureTransform3DIR::default();
    for case in cases {
        let points = case.points.iter().copied().map(point).collect::<Vec<_>>();
        let values = sample_preset_texture("bimeron", &case.params, &mapping, &transform, &points)
            .expect("bimeron parity case should sample");
        assert_eq!(values.len(), case.expected.len());
        for (index, (actual, expected)) in values.iter().zip(case.expected.iter()).enumerate() {
            for (component, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
                assert!(
                    (actual - expected).abs() < 1e-12,
                    "fixture mismatch at point {index}:{component}: actual={actual:?} expected={expected:?}"
                );
            }
        }
    }
}
