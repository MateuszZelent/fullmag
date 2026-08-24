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

fn sample(
    kind: &str,
    params: BTreeMap<String, serde_json::Value>,
    points: &[TextureSamplePoint],
) -> Vec<[f64; 3]> {
    sample_preset_texture_versioned(
        kind,
        2,
        &params,
        &TextureMappingIR::default(),
        &TextureTransform3DIR::default(),
        points,
    )
    .unwrap()
}

#[test]
fn mumax_vortex_wall_has_domains_and_vortex_core() {
    let values = sample(
        "vortex_wall",
        params([
            ("wall_half_width", json!(2.0)),
            ("left_mx", json!(1.0)),
            ("right_mx", json!(-1.0)),
            ("circulation", json!(1)),
            ("core_polarity", json!(1)),
            ("core_radius", json!(0.5)),
            ("plane", json!("xy")),
        ]),
        &[
            point(-3.0, 0.0, 0.0),
            point(0.0, 0.0, 0.0),
            point(3.0, 0.0, 0.0),
        ],
    );

    assert_eq!(values[0], [1.0, 0.0, 0.0]);
    assert!((values[1][2] - 1.0).abs() < 1.0e-12);
    assert_eq!(values[2], [-1.0, 0.0, 0.0]);
}

#[test]
fn mumax_compact_hopfion_is_exactly_uniform_outside_support() {
    let values = sample(
        "hopfion_compact_support",
        params([("major_radius", json!(2.0)), ("minor_radius", json!(0.5))]),
        &[
            point(2.0, 0.0, 0.0),
            point(2.5, 0.0, 0.0),
            point(4.0, 0.0, 0.0),
            point(2.25, 0.0, 0.0),
        ],
    );

    assert!((values[0][2] + 1.0).abs() < 1.0e-12);
    assert_eq!(values[1], [0.0, 0.0, 1.0]);
    assert_eq!(values[2], [0.0, 0.0, 1.0]);
    for value in values {
        let norm = value
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt();
        assert!((norm - 1.0).abs() < 1.0e-12);
    }
}
