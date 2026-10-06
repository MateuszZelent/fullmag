use fullmag_ir::{
    migrate_problem_ir_json_value, migrate_v0_3_problem_ir_to_v0_4, ProblemIR, ProblemIRV04,
};
use serde_json::{json, Value};

fn legacy_problem(version: &str) -> Value {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["ir_version"] = json!(version);
    value["problem_meta"]["script_api_version"] = json!(version);
    value["problem_meta"]["serializer_version"] = json!(version);
    value
}

#[test]
fn public_readers_reject_present_spatial_intent_including_null() {
    for version in ["0.3.0", "0.2.0"] {
        for representation in [
            Value::Null,
            json!({"kind": "full_3d"}),
            json!({"kind": "waveguide_2p5d"}),
            json!("waveguide_2p5d"),
            json!(false),
        ] {
            let mut value = legacy_problem(version);
            value["study"]["spatial_representation"] = representation;
            let error = serde_json::from_value::<ProblemIR>(value).unwrap_err();
            assert!(error.to_string().contains("/study/spatial_representation"));
            assert!(error.to_string().contains("ProblemIRV04"));
        }
    }
}

#[test]
fn explicit_migration_rejects_spatial_intent_before_mutating_input() {
    for version in ["0.1.0", "0.2.0", "0.3.0"] {
        for representation in [Value::Null, json!({"kind": "waveguide_2p5d"})] {
            let mut value = legacy_problem(version);
            value["study"]["spatial_representation"] = representation;
            value["geometry"]["entries"] = json!([{
                "kind": "cylinder", "name": "legacy", "radius": 1.0, "height": 2.0
            }]);
            let original = value.clone();
            let error = migrate_problem_ir_json_value(&mut value).unwrap_err();
            assert!(error.contains("/study/spatial_representation"));
            assert_eq!(value, original);
        }
    }
}

#[test]
fn missing_spatial_intent_preserves_legacy_read_and_explicit_migration() {
    for version in ["0.3.0", "0.2.0"] {
        let value = legacy_problem(version);
        assert!(value["study"].get("spatial_representation").is_none());
        let decoded: ProblemIR = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.ir_version, "0.3.0");
    }
    let mut historical = legacy_problem("0.1.0");
    assert!(migrate_problem_ir_json_value(&mut historical).unwrap());
    let decoded: ProblemIR = serde_json::from_value(historical).unwrap();
    assert_eq!(decoded.ir_version, "0.3.0");
}

#[test]
fn unsupported_version_retains_ordinary_version_error() {
    let mut value = legacy_problem("9.9.9");
    value["study"]["spatial_representation"] = Value::Null;
    let error = serde_json::from_value::<ProblemIR>(value).unwrap_err();
    assert!(error.to_string().contains("not supported for direct read"));
}

#[test]
fn staging_v04_reader_accepts_its_typed_full3d_spatial_representation() {
    let value = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    assert_eq!(value["study"]["spatial_representation"]["kind"], "full_3d");

    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let encoded = serde_json::to_value(decoded).unwrap();
    assert_eq!(
        encoded["study"]["spatial_representation"]["kind"],
        "full_3d"
    );
}

#[test]
fn v03_to_v04_migration_rejects_spatial_intent_atomically() {
    for representation in [Value::Null, json!({"kind": "waveguide_2p5d"})] {
        let mut value = legacy_problem("0.3.0");
        value["study"]["spatial_representation"] = representation;
        let original = value.clone();
        let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap_err();
        assert!(error.contains("/study/spatial_representation"));
        assert_eq!(value, original);
    }
}
