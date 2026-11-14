use fullmag_ir::{FemGpuPcgControlExperimentIR, FemPlanIR};
use serde_json::json;

#[test]
fn pcg_control_request_is_closed_and_preserves_legacy_plan_serialization() {
    let legacy = serde_json::to_value(FemPlanIR::default()).unwrap();
    assert!(legacy.get("gpu_pcg_control_experiment").is_none());
    let restored: FemPlanIR = serde_json::from_value(legacy.clone()).unwrap();
    assert!(restored.gpu_pcg_control_experiment.is_none());
    assert_eq!(serde_json::to_value(restored).unwrap(), legacy);

    for stride in [4, 8] {
        let raw = json!({"schema_version": FemGpuPcgControlExperimentIR::SCHEMA_VERSION,
                         "status_batch_stride": stride});
        let request: FemGpuPcgControlExperimentIR = serde_json::from_value(raw.clone()).unwrap();
        request.validate().unwrap();
        assert_eq!(serde_json::to_value(&request).unwrap(), raw);
        let mut plan = FemPlanIR::default();
        plan.gpu_pcg_control_experiment = Some(request);
        let copy: FemPlanIR = serde_json::from_slice(&serde_json::to_vec(&plan).unwrap()).unwrap();
        assert_eq!(
            copy.gpu_pcg_control_experiment,
            plan.gpu_pcg_control_experiment
        );
    }
}

#[test]
fn pcg_control_rejects_malformed_requests_and_out_of_domain_values() {
    let valid = json!({"schema_version": FemGpuPcgControlExperimentIR::SCHEMA_VERSION,
                       "status_batch_stride": 4});
    for value in [
        json!(null),
        json!(true),
        json!(4.0),
        json!("4"),
        json!(-4),
        json!(0),
        json!(5),
        json!(9),
    ] {
        let mut raw = valid.clone();
        raw["status_batch_stride"] = value;
        assert!(serde_json::from_value::<FemGpuPcgControlExperimentIR>(raw)
            .map(|request| request.validate().is_err())
            .unwrap_or(true));
    }
    let mut unknown = valid.clone();
    unknown["allow_cpu_fallback"] = json!(true);
    assert!(serde_json::from_value::<FemGpuPcgControlExperimentIR>(unknown).is_err());
    for key in ["schema_version", "status_batch_stride"] {
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<FemGpuPcgControlExperimentIR>(missing).is_err());
    }
    let mut wrong_schema = valid;
    wrong_schema["schema_version"] = json!("v2");
    assert!(
        serde_json::from_value::<FemGpuPcgControlExperimentIR>(wrong_schema)
            .unwrap()
            .validate()
            .is_err()
    );
}
