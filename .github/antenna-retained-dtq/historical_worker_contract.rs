use sha2::{Digest, Sha256};

#[test]
fn historical_worker_parser_rejects_real_direct_plan_before_execution() {
    let path = std::env::var("FULLMAG_CI_DTQ_FIXTURE_PATH").unwrap();
    let bytes = std::fs::read(path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["kind"], "antenna_retained_direct_field_inspection");
    let error = serde_json::from_slice::<fullmag_ir::BackendPlanIR>(&bytes).unwrap_err().to_string();
    assert!(error.contains("unknown variant"), "{error}");
    assert!(error.contains("antenna_retained_direct_field_inspection"), "{error}");
    println!("DTQ_OLD_REAL_PARSER_REJECTED_SHA256={:x}", Sha256::digest(&bytes));
}
