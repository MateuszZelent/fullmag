use fullmag_ir::{TextureMappingIR, TextureProjectionMode, TextureTransform3DIR};
use fullmag_plan::{sample_preset_texture_versioned, TextureSamplePoint};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const FIXTURE: &str = "tests/fixtures/magnetization_textures_v2_parity.json";
const POINT_COUNT: usize = 1000;

#[derive(Debug, Serialize, Deserialize)]
struct ParityCase {
    preset_kind: String,
    preset_version: u32,
    params: BTreeMap<String, Value>,
    projection: String,
    rotation_quat: Option<[f64; 4]>,
    points: Vec<[f64; 3]>,
    expected: Vec<[f64; 3]>,
}

fn parity_points() -> Vec<[f64; 3]> {
    (0..POINT_COUNT)
        .map(|index| {
            let t = index as f64 + 1.0;
            [
                (t * 0.013).sin() * 2.0e-8,
                (t * 0.017).cos() * 1.5e-8,
                (t * 0.019).sin() * 0.8e-8,
            ]
        })
        .collect()
}

fn point(position: [f64; 3]) -> TextureSamplePoint {
    TextureSamplePoint {
        position_world: position,
        position_object: position,
        active: true,
    }
}

fn mapping(projection: &str) -> TextureMappingIR {
    let projection = match projection {
        "object_local" => TextureProjectionMode::ObjectLocal,
        "planar_xy" => TextureProjectionMode::PlanarXy,
        "planar_xz" => TextureProjectionMode::PlanarXz,
        "planar_yz" => TextureProjectionMode::PlanarYz,
        other => panic!("unsupported fixture projection {other}"),
    };
    TextureMappingIR {
        space: "object".to_string(),
        projection,
        clamp_mode: "none".to_string(),
    }
}

fn rotate(vector: [f64; 3], quaternion: [f64; 4]) -> [f64; 3] {
    let q = [quaternion[0], quaternion[1], quaternion[2]];
    let t = [
        2.0 * (q[1] * vector[2] - q[2] * vector[1]),
        2.0 * (q[2] * vector[0] - q[0] * vector[2]),
        2.0 * (q[0] * vector[1] - q[1] * vector[0]),
    ];
    [
        vector[0] + quaternion[3] * t[0] + q[1] * t[2] - q[2] * t[1],
        vector[1] + quaternion[3] * t[1] + q[2] * t[0] - q[0] * t[2],
        vector[2] + quaternion[3] * t[2] + q[0] * t[1] - q[1] * t[0],
    ]
}

fn make_case(
    preset_kind: &str,
    params: BTreeMap<String, Value>,
    projection: &str,
    rotation_quat: Option<[f64; 4]>,
    points: &[[f64; 3]],
) -> ParityCase {
    let mapping = mapping(projection);
    let sample_points = points.iter().copied().map(point).collect::<Vec<_>>();
    let values = sample_preset_texture_versioned(
        preset_kind,
        2,
        &params,
        &mapping,
        &TextureTransform3DIR::default(),
        &sample_points,
    )
    .unwrap_or_else(|error| panic!("{preset_kind} fixture generation failed: {error}"));
    let expected = match rotation_quat {
        Some(quaternion) => values
            .into_iter()
            .map(|value| rotate(value, quaternion))
            .collect(),
        None => values,
    };
    ParityCase {
        preset_kind: preset_kind.to_string(),
        preset_version: 2,
        params,
        projection: projection.to_string(),
        rotation_quat,
        points: points.to_vec(),
        expected,
    }
}

fn generated_cases() -> Vec<ParityCase> {
    let points = parity_points();
    let quarter_turn = 2.0_f64.sqrt() / 2.0;
    vec![
        make_case(
            "uniform",
            BTreeMap::from([("direction".to_string(), json!([1.0, 2.0, 3.0]))]),
            "object_local",
            Some([0.0, 0.0, quarter_turn, quarter_turn]),
            &points,
        ),
        make_case(
            "random",
            BTreeMap::from([("seed".to_string(), json!(0))]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "vortex",
            BTreeMap::from([
                ("circulation".to_string(), json!(1)),
                ("core_polarity".to_string(), json!(-1)),
                ("core_radius".to_string(), json!(3.0e-9)),
                ("plane".to_string(), json!("xy")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "antivortex",
            BTreeMap::from([
                ("circulation".to_string(), json!(1)),
                ("core_polarity".to_string(), json!(1)),
                ("core_radius".to_string(), json!(3.0e-9)),
                ("plane".to_string(), json!("xz")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "bloch_skyrmion",
            BTreeMap::from([
                ("radius".to_string(), json!(8.0e-9)),
                ("wall_width".to_string(), json!(2.0e-9)),
                ("chirality".to_string(), json!(-1)),
                ("core_polarity".to_string(), json!(1)),
                ("plane".to_string(), json!("xz")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "neel_skyrmion",
            BTreeMap::from([
                ("radius".to_string(), json!(8.0e-9)),
                ("wall_width".to_string(), json!(2.0e-9)),
                ("chirality".to_string(), json!(1)),
                ("core_polarity".to_string(), json!(-1)),
                ("plane".to_string(), json!("yz")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "antiskyrmion",
            BTreeMap::from([
                ("radius".to_string(), json!(8.0e-9)),
                ("wall_width".to_string(), json!(2.0e-9)),
                ("chirality".to_string(), json!(-1)),
                ("core_polarity".to_string(), json!(1)),
                ("plane".to_string(), json!("xy")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "skyrmionium",
            BTreeMap::from([
                ("inner_radius".to_string(), json!(5.0e-9)),
                ("outer_radius".to_string(), json!(12.0e-9)),
                ("wall_width".to_string(), json!(1.5e-9)),
                ("kind".to_string(), json!("bloch")),
                ("chirality".to_string(), json!(-1)),
                ("background_sign".to_string(), json!(1)),
                ("plane".to_string(), json!("xz")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "hopfion",
            BTreeMap::from([
                ("radius".to_string(), json!(10.0e-9)),
                ("hopf_charge".to_string(), json!(-1)),
                ("background_sign".to_string(), json!(1)),
                ("axial_scale".to_string(), json!(1.4)),
                ("phase_rad".to_string(), json!(0.3)),
            ]),
            "object_local",
            Some([0.0, 0.0, quarter_turn, quarter_turn]),
            &points,
        ),
        make_case(
            "bimeron",
            BTreeMap::from([
                ("radius".to_string(), json!(8.0e-9)),
                ("wall_width".to_string(), json!(2.0e-9)),
                ("vorticity".to_string(), json!(-1)),
                ("helicity_rad".to_string(), json!(0.25)),
                ("background_sign".to_string(), json!(1)),
                ("plane".to_string(), json!("xy")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "domain_wall",
            BTreeMap::from([
                ("kind".to_string(), json!("bloch")),
                ("width".to_string(), json!(4.0e-9)),
                ("center_offset".to_string(), json!(0.0)),
                ("normal_axis".to_string(), json!("z")),
                ("left".to_string(), json!([1.0, 0.0, 0.0])),
                ("right".to_string(), json!([-1.0, 0.0, 0.0])),
                ("wall_center_direction".to_string(), json!([0.0, 1.0, 0.0])),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "two_domain",
            BTreeMap::from([
                ("left".to_string(), json!([1.0, 0.0, 0.0])),
                ("right".to_string(), json!([-1.0, 0.0, 0.0])),
                ("wall".to_string(), json!([0.0, 1.0, 0.0])),
                ("normal_axis".to_string(), json!("x")),
                ("wall_width".to_string(), json!(3.0e-9)),
                ("sharp".to_string(), json!(false)),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "helical",
            BTreeMap::from([
                ("wavevector".to_string(), json!([1.1e8, -0.8e8, 0.5e8])),
                ("e1".to_string(), json!([1.0, 0.0, 0.0])),
                ("e2".to_string(), json!([0.0, 1.0, 0.0])),
                ("phase_rad".to_string(), json!(0.3)),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "conical",
            BTreeMap::from([
                ("wavevector".to_string(), json!([0.7e8, 0.4e8, -0.6e8])),
                ("cone_axis".to_string(), json!([0.0, 0.0, 1.0])),
                ("cone_angle_rad".to_string(), json!(0.7)),
                ("phase_rad".to_string(), json!(-0.2)),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "vortex_wall",
            BTreeMap::from([
                ("wall_half_width".to_string(), json!(6.0e-9)),
                ("left_mx".to_string(), json!(1.0e-15)),
                ("right_mx".to_string(), json!(-1.0e-15)),
                ("circulation".to_string(), json!(-1)),
                ("core_polarity".to_string(), json!(1)),
                ("core_radius".to_string(), json!(2.0e-9)),
                ("plane".to_string(), json!("xy")),
            ]),
            "object_local",
            None,
            &points,
        ),
        make_case(
            "hopfion_compact_support",
            BTreeMap::from([
                ("major_radius".to_string(), json!(12.0e-9)),
                ("minor_radius".to_string(), json!(6.0e-9)),
            ]),
            "object_local",
            Some([0.0, 0.0, quarter_turn, quarter_turn]),
            &points,
        ),
    ]
}

#[test]
fn v2_matches_shared_python_parity_fixture_for_all_presets() {
    let fixture_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    if std::env::var_os("FULLMAG_GENERATE_V2_PARITY").is_some() {
        let cases = generated_cases();
        fs::write(
            &fixture_path,
            serde_json::to_string_pretty(&cases).expect("fixture should serialize"),
        )
        .expect("fixture should be writable");
        return;
    }

    let content = fs::read_to_string(&fixture_path)
        .expect("run with FULLMAG_GENERATE_V2_PARITY=1 once to create the fixture");
    let cases: Vec<ParityCase> =
        serde_json::from_str(&content).expect("parity fixture should be valid JSON");
    assert_eq!(cases.len(), 16);
    for case in cases {
        assert_eq!(case.preset_version, 2);
        assert_eq!(case.points.len(), POINT_COUNT);
        let mapping = mapping(&case.projection);
        let points = case.points.iter().copied().map(point).collect::<Vec<_>>();
        let actual = sample_preset_texture_versioned(
            &case.preset_kind,
            case.preset_version,
            &case.params,
            &mapping,
            &TextureTransform3DIR::default(),
            &points,
        )
        .unwrap_or_else(|error| panic!("{} fixture case failed: {error}", case.preset_kind));
        let actual = match case.rotation_quat {
            Some(quaternion) => actual
                .into_iter()
                .map(|value| rotate(value, quaternion))
                .collect::<Vec<_>>(),
            None => actual,
        };
        assert_eq!(actual.len(), case.expected.len());
        for (point_index, (actual, expected)) in actual.iter().zip(case.expected.iter()).enumerate()
        {
            for (component_index, (actual, expected)) in
                actual.iter().zip(expected.iter()).enumerate()
            {
                assert!(
                    (actual - expected).abs() < 1.0e-12,
                    "{} mismatch at point {point_index}:{component_index}: actual={actual} expected={expected}",
                    case.preset_kind
                );
            }
        }
    }
}
