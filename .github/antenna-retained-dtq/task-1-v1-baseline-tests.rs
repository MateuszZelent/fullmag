//! Structural fixtures only: no fake evidence is admitted for execution or scientific qualification.
use super::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn cas(n: char, bytes: u64) -> CasObjectRef {
    CasObjectRef {
        object_ref: n.to_string().repeat(64),
        byte_count: bytes,
    }
}
fn owner() -> ParentInspectionOwner {
    ParentInspectionOwner {
        project_id: "project".into(),
        run_id: "parent-run".into(),
        study_step_id: "parent-step".into(),
        native_stage_id: "parent-native".into(),
        task_id: "parent-task".into(),
        attempt_id: "parent-attempt".into(),
        ownership_epoch: "18446744073709551615".into(),
        artifact_id: "parent-artifact".into(),
        package: cas('a', 256),
        package_codec_id: PARENT_CODEC_ID.into(),
        package_codec_version: PARENT_CODEC_VERSION.into(),
        manifest_schema: PARENT_MANIFEST_SCHEMA.into(),
        output_manifest_artifact_id: "parent-manifest".into(),
        output_manifest: cas('b', 512),
    }
}
fn policy() -> Value {
    json!({"policy_version":"caller_supplied_rt0_surface.inspection.v1",
        "limits":{"total":vec![4000000_u64;14],"per_target":vec![40000_u64;14],"maximum_raw_integer_bits":1024,
        "maximum_reduced_fraction_bits":1024,"maximum_lifetime_peak_rss_bytes":1000000,"guard_interval_events":1,
        "maximum_total_seconds":1800.0,"maximum_target_seconds":90.0},
        "tolerances":{"absolute_field_apm":1e-9,"relative_field":1e-5,"cancellation_floor_apm":1e-6,
        "scalar_relative_80":1e-45,"scalar_relative_120":1e-55,"angle_relative_80":1e-45,"angle_relative_120":1e-55,
        "binary_scalar_epsilon_factor":64.0,"binary_roundoff_epsilon_factor":64.0,
        "binary_cancellation_limit":1e8,"highprecision_cancellation_limit":1e40}})
}
fn surface_fixture() -> (RetainedCurrentFieldManifest, BTreeMap<String, Vec<u8>>) {
    let xyz = [[0., 0., 0.], [1e-6, 0., 0.], [0., 1e-6, 0.], [0., 0., 1e-6]]
        .into_iter()
        .flatten()
        .flat_map(f64::to_le_bytes)
        .collect::<Vec<_>>();
    let h = [1_f64; 12]
        .into_iter()
        .flat_map(f64::to_le_bytes)
        .collect::<Vec<_>>();
    let cells = [0_u32, 1, 2, 3]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect::<Vec<_>>();
    let payloads = BTreeMap::from([
        ("sample_xyz".into(), xyz),
        ("sample_cells".into(), cells),
        ("h_raw".into(), h),
        (
            "evidence".into(),
            b"opaque encoding fixture; NOT physical evidence".to_vec(),
        ),
    ]);
    let reference = |key: &str, layout: &str, unit: &str| {
        let bytes = &payloads[key];
        RetainedCurrentPayloadRef {
            sha256: sha256(bytes),
            byte_count: bytes.len() as u64,
            layout: layout.into(),
            unit: unit.into(),
        }
    };
    let source = json!({"kind":"published_inspection","project_id":"project","run_id":"parent-run",
        "task_id":"parent-task","attempt_id":"parent-attempt","ownership_epoch":"18446744073709551615",
        "artifact_id":"parent-artifact","object_ref":"a".repeat(64)});
    let execution = json!({"discretization":"fem","device":"cpu","precision":"double","execution_mode":"strict"});
    let stage = json!({"id":"child","source_object_id":"antenna","current_transport_id":"transport",
        "port_mode_ids":["port"],"retained_current_source":source,"model":"quasistatic_conduction_biot_savart3d",
        "oersted_realization":"analytic_rt0_surface","surface_field_policy":policy(),"conductor_mesh_policy":"retained",
        "field_sampling_domain":{"kind":"global"},"target_refs":[],"solver_policy":"inspection",
        "outputs":[{"id":"field","quantity":"H_ant_basis"}]});
    let dig = format!("sha256:{}", "e".repeat(64));
    let mut manifest = RetainedCurrentFieldManifest {
        schema_version: RETAINED_CURRENT_FIELD_SCHEMA.into(),
        status: "inspection_only".into(),
        qualification: "not_verified".into(),
        content_digest: String::new(),
        stage_id: "child".into(),
        output_id: "field".into(),
        port_mode_id: "port".into(),
        source_object_id: "antenna".into(),
        current_transport_id: "transport".into(),
        parent: RetainedCurrentParent {
            owner: owner(),
            source: ParentCurrentDigests {
                prepared_execution_digest: dig.clone(),
                accepted_charge_field_digest: dig.clone(),
                accepted_source_state_digest: dig.clone(),
                view_identity_digest: dig.clone(),
                current_balance_certificate_digest: dig.clone(),
            },
            evidence_capsule: cas('f', 512),
        },
        sample_carrier: crate::AntennaSampleCarrier {
            domain: fullmag_ir::FieldTargetIR::Global {},
            carrier_kind: "fem_domain_mesh_asset".into(),
            location: "node".into(),
            topology_digest: dig,
        },
        source_vertex_count: 4,
        source_cell_count: 1,
        target_count: 4,
        sample_cell_count: 1,
        requested_intent: serde_json::from_value(stage).unwrap(),
        resolved_execution: RetainedCurrentResolvedExecution {
            requested_execution: serde_json::from_value(execution.clone()).unwrap(),
            execution: serde_json::from_value(execution).unwrap(),
            operator_version: RETAINED_CURRENT_OPERATOR.into(),
            basis_version: RETAINED_CURRENT_BASIS.into(),
            evidence_schema: RETAINED_CURRENT_EVIDENCE_SCHEMA.into(),
        },
        field_policy: serde_json::from_value(policy()).unwrap(),
        payloads: RetainedCurrentPayloads {
            sample_xyz: reference("sample_xyz", "sample_xyz_f64_le", "m"),
            sample_cells: reference("sample_cells", "tet4_u32_le", "1"),
            h_raw: reference("h_raw", "sample_xyz_f64_le", "A/m"),
            evidence: reference("evidence", RETAINED_CURRENT_EVIDENCE_SCHEMA, "1"),
        },
    };
    manifest.content_digest = manifest.expected_content_digest().unwrap();
    (manifest, payloads)
}
#[test]
fn surface_v1_golden_stays_exact() {
    let (m,p) = surface_fixture();
    let raw = serde_json::to_vec(&m).unwrap();
    let bytes = encode_retained_current_field_bundle(&raw,&p,MAX_PACKAGE_BYTES as usize).unwrap();
    let mut expected = b"FMARCF1\0".to_vec();
    expected.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    expected.extend_from_slice(&raw);
    for key in ["sample_xyz","sample_cells","h_raw","evidence"] {
        expected.extend_from_slice(&(p[key].len() as u64).to_le_bytes());
        expected.extend_from_slice(&p[key]);
    }
    assert_eq!(bytes,expected);
    println!("SURFACE_V1_BASELINE_SHA256={}", sha256(&bytes));
    std::fs::write(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("task-1-v1-baseline.bundle"),
        &bytes,
    ).unwrap();
    let decoded = decode_retained_current_field_bundle(&bytes,bytes.len()).unwrap();
    assert_eq!(decoded.manifest_bytes,raw);
    assert_eq!(encode_retained_current_field_bundle(&decoded.manifest_bytes,&decoded.payloads,bytes.len()).unwrap(),bytes);
    assert_eq!(sha256(include_bytes!("manifest.rs")),"3f12a53bdc47ee7e17032ee79af66464d7b9c92686cd283aa5142e73f518e5f8");
    assert_eq!(sha256(include_bytes!("package.rs")),"e73a5c1e4ef314a66961bb6009a15a5339b8b24c24d71842494924a43ca6c45e");
}
