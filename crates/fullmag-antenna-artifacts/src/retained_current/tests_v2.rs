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
fn capsule() -> ParentEvidenceCapsule {
    ParentEvidenceCapsule {
        schema_version: PARENT_EVIDENCE_SCHEMA.into(),
        role: "evidence_only".into(),
        parent_owner: owner(),
        accepted_provenance_manifest: cas('c', 512),
        record_objects: vec![ParentEvidenceRecordObject {
            archive_path: "accepted_provenance/runs/parent-run/run_intent.json".into(),
            object: cas('d', 256),
        }],
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
fn dtq_fixture() -> (RetainedCurrentFieldManifestV2, BTreeMap<String, Vec<u8>>) {
    let (surface, mut payloads) = surface_fixture();
    let mut value = serde_json::to_value(surface).unwrap();
    value["schema_version"] = json!(RETAINED_CURRENT_FIELD_SCHEMA_V2);
    value.as_object_mut().unwrap().remove("field_policy");
    value["direct_field_policy"] = serde_json::to_value(
        RetainedCurrentDirectFieldPolicyV2::for_solver_policy("volume_inspection_v1").unwrap(),
    )
    .unwrap();
    value["requested_intent"]["oersted_realization"] = json!("direct_tetra_quadrature");
    value["requested_intent"]
        .as_object_mut()
        .unwrap()
        .remove("surface_field_policy");
    value["requested_intent"]["solver_policy"] = json!("volume_inspection_v1");
    value["requested_intent"]["retained_source_preparation"] = json!({
        "asset_id":format!("script-file-{}", "1".repeat(64)), "content_sha256":"2".repeat(64)});
    value["resolved_execution"]["operator_version"] = json!(RETAINED_CURRENT_OPERATOR_V2);
    value["resolved_execution"]["evidence_schema"] = json!(RETAINED_CURRENT_EVIDENCE_SCHEMA_V2);
    let mut evidence = b"FM-OEF1-Q3-V2\0\0\0".to_vec();
    evidence.extend_from_slice("e".repeat(64).as_bytes());
    evidence.extend_from_slice("e".repeat(64).as_bytes());
    for x in [
        4_u64,
        4,
        0,
        0,
        4,
        4,
        4,
        6,
        4_000_000,
        1_000_000,
        500_000_000,
        500_000_000,
    ] {
        evidence.extend_from_slice(&x.to_le_bytes());
    }
    for x in [0_f64, 1e-9, 1e-5, 0., -3., -1. / 3., 3.] {
        evidence.extend_from_slice(&x.to_le_bytes());
    }
    for xyz in payloads["sample_xyz"].chunks_exact(24) {
        evidence.extend_from_slice(xyz);
        evidence.extend_from_slice(&payloads["h_raw"][..24]);
        for x in [0_f64, 1e-5_f64.mul_add(1_f64.hypot(1.).hypot(1.), 1e-9), 0.] {
            evidence.extend_from_slice(&x.to_le_bytes());
        }
        for x in [1_u64; 3] {
            evidence.extend_from_slice(&x.to_le_bytes());
        }
    }
    payloads.insert("evidence".into(), evidence);
    value["payloads"]["evidence"]["layout"] = json!(RETAINED_CURRENT_EVIDENCE_SCHEMA_V2);
    value["payloads"]["evidence"]["sha256"] = json!(sha256(&payloads["evidence"]));
    value["payloads"]["evidence"]["byte_count"] = json!(payloads["evidence"].len());
    let mut m: RetainedCurrentFieldManifestV2 = serde_json::from_value(value).unwrap();
    m.content_digest = m.expected_content_digest().unwrap();
    (m, payloads)
}
fn resign_v2(m: &mut RetainedCurrentFieldManifestV2) {
    m.content_digest = m.expected_content_digest().unwrap();
}
#[test]
fn surface_v1_golden_stays_exact() {
    let (m, p) = surface_fixture();
    let raw = serde_json::to_vec(&m).unwrap();
    let bytes = encode_retained_current_field_bundle(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
    let mut expected = b"FMARCF1\0".to_vec();
    expected.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    expected.extend_from_slice(&raw);
    for key in ["sample_xyz", "sample_cells", "h_raw", "evidence"] {
        expected.extend_from_slice(&(p[key].len() as u64).to_le_bytes());
        expected.extend_from_slice(&p[key]);
    }
    assert_eq!(bytes, expected);
    // Frozen from the pre-implementation RED snapshot; independently hashed from its CI artifact.
    assert_eq!(
        sha256(&bytes),
        "c44dff40b7682ef9be41775cb32b6279abd488c3a3990f8d2f8f98ab0096a090"
    );
    let decoded = decode_retained_current_field_bundle(&bytes, bytes.len()).unwrap();
    assert_eq!(decoded.manifest_bytes, raw);
    assert_eq!(
        encode_retained_current_field_bundle(
            &decoded.manifest_bytes,
            &decoded.payloads,
            bytes.len()
        )
        .unwrap(),
        bytes
    );
    assert_eq!(
        sha256(include_bytes!("manifest.rs")),
        "3f12a53bdc47ee7e17032ee79af66464d7b9c92686cd283aa5142e73f518e5f8"
    );
    assert_eq!(
        sha256(include_bytes!("package.rs")),
        "e73a5c1e4ef314a66961bb6009a15a5339b8b24c24d71842494924a43ca6c45e"
    );
}
#[test]
fn dtq_v2_roundtrip_four_payloads() {
    let (m, p) = dtq_fixture();
    let raw = serde_json::to_vec(&m).unwrap();
    let bytes =
        encode_retained_current_field_bundle_v2(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
    assert_eq!(&bytes[..8], b"FMARCF2\0");
    let decoded = decode_retained_current_field_bundle_v2(&bytes, bytes.len()).unwrap();
    assert_eq!(decoded.manifest, m);
    assert_eq!(decoded.manifest_bytes, raw);
    assert_eq!(decoded.payloads, p);
    assert_eq!(decoded.payloads.len(), 4);
    assert_eq!(decoded.manifest.payloads.h_raw.unit, "A/m");
    assert_eq!(decoded.manifest.status, "inspection_only");
    assert_eq!(decoded.manifest.qualification, "not_verified");
    assert_ne!(
        decoded.manifest.content_digest,
        surface_fixture().0.content_digest
    );
    assert!(decode_retained_current_field_bundle_v2(&bytes, bytes.len() - 1).is_err());
    assert_eq!(
        retained_current_field_manifest_length_v2(&bytes[..16], bytes.len() as u64).unwrap(),
        raw.len()
    );
    assert_eq!(
        decode_retained_current_field_bundle_any(&bytes, bytes.len())
            .unwrap()
            .manifest()
            .content_digest(),
        m.content_digest
    );
}
#[test]
fn v1_refuses_dtq_and_mixed_headers() {
    let (m, p) = dtq_fixture();
    let raw = serde_json::to_vec(&m).unwrap();
    assert!(parse_retained_current_manifest(&raw).is_err());
    let bytes =
        encode_retained_current_field_bundle_v2(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
    assert!(decode_retained_current_field_bundle(&bytes, bytes.len()).is_err());
    let mut mixed = bytes.clone();
    mixed[..8].copy_from_slice(b"FMARCF1\0");
    assert!(decode_retained_current_field_bundle_any(&mixed, mixed.len()).is_err());
    let (surface, p) = surface_fixture();
    let raw = serde_json::to_vec(&surface).unwrap();
    assert!(parse_retained_current_manifest_v2(&raw).is_err());
    let mut bytes =
        encode_retained_current_field_bundle(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
    bytes[..8].copy_from_slice(b"FMARCF2\0");
    assert!(decode_retained_current_field_bundle_any(&bytes, bytes.len()).is_err());
}
#[test]
fn dtq_v2_rejects_surface_policy_unknown_duplicate_nonfinite() {
    let (m, p) = dtq_fixture();
    for case in [
        "surface",
        "unknown",
        "operator",
        "evidence",
        "profile",
        "budget",
        "preparation",
        "device",
        "unit",
    ] {
        let mut value = serde_json::to_value(&m).unwrap();
        match case {
            "surface" => value["requested_intent"]["surface_field_policy"] = policy(),
            "unknown" => value["surprise"] = json!(true),
            "operator" => {
                value["resolved_execution"]["operator_version"] = json!(RETAINED_CURRENT_OPERATOR)
            }
            "evidence" => {
                value["resolved_execution"]["evidence_schema"] =
                    json!(RETAINED_CURRENT_EVIDENCE_SCHEMA)
            }
            "profile" => value["requested_intent"]["solver_policy"] = json!("unknown"),
            "budget" => {
                value["direct_field_policy"]["maximum_kernel_evaluations"] = json!(100_000_000)
            }
            "preparation" => {
                value["requested_intent"]
                    .as_object_mut()
                    .unwrap()
                    .remove("retained_source_preparation");
            }
            "device" => value["resolved_execution"]["execution"]["device"] = json!("gpu"),
            _ => value["payloads"]["h_raw"]["unit"] = json!("T"),
        }
        if let Ok(mut next) =
            serde_json::from_value::<RetainedCurrentFieldManifestV2>(value.clone())
        {
            resign_v2(&mut next);
            assert!(next.validate_metadata().is_err(), "{case}");
        } else {
            assert!(
                parse_retained_current_manifest_v2(&serde_json::to_vec(&value).unwrap()).is_err()
            );
        }
    }
    let raw = serde_json::to_vec(&m).unwrap();
    let mut duplicate = b"{\"schema_version\":\"duplicate\",".to_vec();
    duplicate.extend_from_slice(&raw[1..]);
    assert!(parse_retained_current_manifest_v2(&duplicate).is_err());
    for key in ["sample_xyz", "h_raw"] {
        let mut next = m.clone();
        let mut bad = p.clone();
        bad.get_mut(key).unwrap()[..8].copy_from_slice(&f64::NAN.to_le_bytes());
        if key == "sample_xyz" {
            next.payloads.sample_xyz.sha256 = sha256(&bad[key]);
        } else {
            next.payloads.h_raw.sha256 = sha256(&bad[key]);
        }
        resign_v2(&mut next);
        assert!(validate_payloads_v2(&next, &bad).is_err());
    }
}
#[test]
fn dtq_v2_refuses_framing_corruption_and_rehashed_mixed_evidence() {
    let (m, p) = dtq_fixture();
    let raw = serde_json::to_vec(&m).unwrap();
    let bytes =
        encode_retained_current_field_bundle_v2(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
    for cut in [0, 7, 8, 15, 16, 16 + raw.len(), bytes.len() - 1] {
        assert!(decode_retained_current_field_bundle_v2(&bytes[..cut], bytes.len()).is_err());
    }
    for offset in [0, 8, 16 + raw.len(), bytes.len() - 1] {
        let mut bad = bytes.clone();
        bad[offset] ^= 1;
        assert!(decode_retained_current_field_bundle_v2(&bad, bytes.len()).is_err());
    }
    let mut extra = bytes.clone();
    extra.push(0);
    assert!(decode_retained_current_field_bundle_v2(&extra, extra.len()).is_err());
    for offset in [0, 16, 80, 144, 208, 224, 240, 272, 296] {
        let mut next = m.clone();
        let mut bad = p.clone();
        if offset == 240 {
            bad.get_mut("evidence").unwrap()[240..248].copy_from_slice(&f64::NAN.to_le_bytes());
        } else {
            bad.get_mut("evidence").unwrap()[offset] ^= 1;
        }
        next.payloads.evidence.sha256 = sha256(&bad["evidence"]);
        resign_v2(&mut next);
        assert!(
            validate_payloads_v2(&next, &bad).is_err(),
            "offset {offset}"
        );
    }
    for key in ["evidence", "sample_xyz", "h_raw", "sample_cells"] {
        let mut bad = p.clone();
        bad.remove(key);
        assert!(validate_payloads_v2(&m, &bad).is_err());
    }
    let mut bad = p;
    bad.insert("extra".into(), vec![1]);
    assert!(validate_payloads_v2(&m, &bad).is_err());
}

#[test]
fn dtq_v2_both_canonical_profiles_bind_all_limits_and_signed_raw_bits() {
    for name in ["production_default", "volume_inspection_v1"] {
        let (mut m, mut p) = dtq_fixture();
        m.requested_intent.solver_policy = name.into();
        m.direct_field_policy =
            RetainedCurrentDirectFieldPolicyV2::for_solver_policy(name).unwrap();
        let policy = &m.direct_field_policy;
        for (offset, value) in [
            (208, policy.maximum_source_target_pairs),
            (216, policy.maximum_final_leaves_per_target),
            (224, policy.maximum_kernel_evaluations),
            (232, policy.maximum_ledger_leaf_visits),
        ] {
            p.get_mut("evidence").unwrap()[offset..offset + 8]
                .copy_from_slice(&value.to_le_bytes());
        }
        // Signed zero is data: preserve it in raw H and the matching evidence record.
        p.get_mut("h_raw").unwrap()[8..16].copy_from_slice(&(-0.0_f64).to_le_bytes());
        p.get_mut("evidence").unwrap()[328..336].copy_from_slice(&(-0.0_f64).to_le_bytes());
        let tolerance = 1e-5_f64.mul_add(1_f64.hypot(0.).hypot(1.), 1e-9);
        p.get_mut("evidence").unwrap()[352..360].copy_from_slice(&tolerance.to_le_bytes());
        m.payloads.h_raw.sha256 = sha256(&p["h_raw"]);
        m.payloads.evidence.sha256 = sha256(&p["evidence"]);
        resign_v2(&mut m);
        let raw = serde_json::to_vec(&m).unwrap();
        let bytes =
            encode_retained_current_field_bundle_v2(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
        let restored = decode_retained_current_field_bundle_any(&bytes, bytes.len()).unwrap();
        assert_eq!(restored.payloads()["h_raw"], p["h_raw"]);
        assert_eq!(
            restored.manifest().direct_policy(),
            Some(&m.direct_field_policy)
        );
        assert!(restored.manifest().surface_policy().is_none());
        let value = serde_json::to_value(&m.direct_field_policy).unwrap();
        for key in value.as_object().unwrap().keys() {
            let mut next = serde_json::to_value(&m).unwrap();
            let target = &mut next["direct_field_policy"][key];
            *target = match target {
                Value::String(_) => json!("unknown"),
                Value::Number(n) if n.is_u64() => json!(n.as_u64().unwrap() + 1),
                Value::Number(n) => json!(n.as_f64().unwrap() + 1.),
                _ => unreachable!(),
            };
            let mut next: RetainedCurrentFieldManifestV2 = serde_json::from_value(next).unwrap();
            resign_v2(&mut next);
            assert!(next.validate_metadata().is_err(), "{name}:{key}");
        }
    }
}
#[test]
fn dtq_v2_refuses_resigned_parent_carrier_connectivity_and_count_mismatches() {
    let (m, p) = dtq_fixture();
    for case in ["parent", "carrier", "source", "target", "sample", "epoch"] {
        let mut next = m.clone();
        match case {
            "parent" => next.parent.owner.attempt_id = "foreign".into(),
            "carrier" => next.sample_carrier.carrier_kind = "magnetic_mesh".into(),
            "source" => next.source_cell_count = u64::MAX,
            "target" => next.target_count = u64::MAX,
            "sample" => next.sample_cell_count = u64::MAX,
            _ => next.parent.owner.ownership_epoch = "01".into(),
        }
        resign_v2(&mut next);
        assert!(next.validate_metadata().is_err(), "{case}");
    }
    for ids in [[0_u32, 1, 2, 4], [0, 1, 1, 3]] {
        let mut next = m.clone();
        let mut bad = p.clone();
        bad.insert(
            "sample_cells".into(),
            ids.into_iter().flat_map(u32::to_le_bytes).collect(),
        );
        next.payloads.sample_cells.sha256 = sha256(&bad["sample_cells"]);
        resign_v2(&mut next);
        assert!(validate_payloads_v2(&next, &bad).is_err());
    }
    let raw = serde_json::to_vec(&m).unwrap();
    let bytes =
        encode_retained_current_field_bundle_v2(&raw, &p, MAX_PACKAGE_BYTES as usize).unwrap();
    assert!(retained_current_field_manifest_length_v2(&bytes[..15], bytes.len() as u64).is_err());
    assert!(
        retained_current_field_manifest_length_any(&bytes[..16], MAX_PACKAGE_BYTES + 1).is_err()
    );
    for length in [0_u64, u64::MAX, MAX_METADATA_BYTES + 1] {
        let mut bad = bytes.clone();
        bad[8..16].copy_from_slice(&length.to_le_bytes());
        assert!(decode_retained_current_field_bundle_any(&bad, bad.len()).is_err());
    }
}
#[test]
fn dtq_v2_parent_capsule_cycles_and_v1_method_rejection_remain_explicit() {
    let (mut m, _) = dtq_fixture();
    let capsule = capsule();
    let raw = serde_json::to_vec(&capsule).unwrap();
    m.parent.evidence_capsule = CasObjectRef {
        object_ref: sha256(&raw),
        byte_count: raw.len() as u64,
    };
    resign_v2(&mut m);
    validate_no_child_cycle_v2(&"1".repeat(64), &m, &raw).unwrap();
    let any = parse_retained_current_manifest_any(&serde_json::to_vec(&m).unwrap()).unwrap();
    assert_eq!(any.as_ref().metadata_dependencies().unwrap().len(), 3);
    assert!(
        validate_no_child_cycle_any(&m.parent.owner.package.object_ref, any.as_ref(), &raw)
            .is_err()
    );
    assert!(
        validate_no_child_cycle_v2(&capsule.record_objects[0].object.object_ref, &m, &raw).is_err()
    );
    let (mut surface, _) = surface_fixture();
    surface.requested_intent.oersted_realization =
        fullmag_ir::AntennaOerstedRealizationIR::DirectTetraQuadrature;
    surface.content_digest = surface.expected_content_digest().unwrap();
    assert!(surface.validate_metadata().is_err());
    let (mut surface, _) = surface_fixture();
    surface.resolved_execution.evidence_schema = RETAINED_CURRENT_EVIDENCE_SCHEMA_V2.into();
    surface.content_digest = surface.expected_content_digest().unwrap();
    assert!(surface.validate_metadata().is_err());
}
