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
fn fixture() -> (RetainedCurrentFieldManifest, BTreeMap<String, Vec<u8>>) {
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
fn resign(m: &mut RetainedCurrentFieldManifest) {
    m.content_digest = m.expected_content_digest().unwrap();
}

#[test]
fn metadata_and_raw_bytes_do_not_claim_evidence_physics_or_execution_authority() {
    let (m, p) = fixture();
    m.validate_metadata().unwrap();
    validate_payloads(&m, &p).unwrap();
    let decoded = parse_retained_current_manifest(&serde_json::to_vec(&m).unwrap()).unwrap();
    assert_eq!(decoded, m);
    assert_eq!(decoded.qualification, "not_verified");
    assert_eq!(m.metadata_dependencies().unwrap().len(), 3);
    let c = capsule();
    c.validate_parent(&m.parent.owner).unwrap();
    assert_eq!(c.metadata_dependencies().unwrap().len(), 2);
}
#[test]
fn duplicate_unknown_keys_and_self_package_field_are_refused() {
    let (m, _) = fixture();
    let mut value = serde_json::to_value(m).unwrap();
    value["package_object_ref"] = json!("a".repeat(64));
    assert!(parse_retained_current_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
    for bytes in [
        br#"{"schema_version":"a","schema_version":"b"}"#.as_slice(),
        br#"{"nested":{"x":1,"x":2}}"#.as_slice(),
    ] {
        assert!(parse_retained_current_manifest(bytes).is_err());
        assert!(parse_parent_evidence_capsule(bytes).is_err());
    }
    assert!(parse_parent_evidence_capsule(&vec![b' '; MAX_METADATA_BYTES as usize + 1]).is_err());
}
#[test]
fn parent_codec_epoch_hash_and_exact_owner_are_fenced() {
    for epoch in ["0", "01", "+1", "18446744073709551616", "-1"] {
        let mut o = owner();
        o.ownership_epoch = epoch.into();
        assert!(o.validate_metadata().is_err());
    }
    let mut c = capsule();
    c.parent_owner.package_codec_id = RETAINED_CURRENT_FIELD_CODEC_ID.into();
    assert!(c.validate_metadata().is_err());
    let mut c = capsule();
    c.parent_owner.package.object_ref = "A".repeat(64);
    assert!(c.validate_metadata().is_err());
    let mut c = capsule();
    c.parent_owner.package.byte_count = MAX_PACKAGE_BYTES + 1;
    assert!(c.validate_metadata().is_err());
    let mut o = owner();
    o.artifact_id = "different".into();
    assert!(capsule().validate_parent(&o).is_err());
    let (mut m, _) = fixture();
    m.parent.owner.attempt_id = "different".into();
    resign(&mut m);
    assert!(m.validate_metadata().is_err());
}
#[test]
fn capsule_refuses_unsafe_paths_duplicates_roles_and_record_budget() {
    for path in [
        "/absolute",
        "accepted_provenance/../x",
        "accepted_provenance//x",
        "accepted_provenance/./x",
        "accepted_provenance/escape\\x",
    ] {
        let mut c = capsule();
        c.record_objects[0].archive_path = path.into();
        assert!(c.validate_metadata().is_err());
    }
    let mut c = capsule();
    c.record_objects.push(c.record_objects[0].clone());
    assert!(c.validate_metadata().is_err());
    let mut c = capsule();
    c.role = "execute".into();
    assert!(c.validate_metadata().is_err());
    let mut c = capsule();
    c.record_objects = (0..5)
        .map(|i| ParentEvidenceRecordObject {
            archive_path: format!("accepted_provenance/runs/parent-run/{i}.json"),
            object: cas('d', MAX_METADATA_BYTES),
        })
        .collect();
    assert!(c.validate_metadata().is_err());
    let mut c = capsule();
    c.record_objects.clear();
    assert!(c.validate_metadata().is_err());
}
#[test]
fn signature_binds_parent_targets_operator_policy_and_ordered_field() {
    let (m, _) = fixture();
    for field in ["parent", "carrier", "policy", "operator", "payload"] {
        let mut next = m.clone();
        match field {
            "parent" => {
                next.parent.source.accepted_source_state_digest =
                    format!("sha256:{}", "9".repeat(64))
            }
            "carrier" => next.sample_carrier.topology_digest = format!("sha256:{}", "8".repeat(64)),
            "policy" => next.field_policy.limits.maximum_total_seconds -= 1.0,
            "operator" => next.resolved_execution.operator_version.push('x'),
            _ => next.payloads.h_raw.sha256 = "7".repeat(64),
        }
        assert_ne!(next.expected_content_digest().unwrap(), m.content_digest);
        assert!(next.validate_metadata().is_err());
    }
}
#[test]
fn lengths_counts_units_nonfinite_and_connectivity_have_independent_checks() {
    let (m, p) = fixture();
    let mut n = m.clone();
    n.target_count = u64::MAX;
    resign(&mut n);
    assert!(n.validate_metadata().is_err());
    let mut n = m.clone();
    n.payloads.h_raw.unit = "T".into();
    resign(&mut n);
    assert!(n.validate_metadata().is_err());
    let mut bad = p.clone();
    bad.get_mut("h_raw").unwrap()[0] ^= 1;
    assert!(validate_payloads(&m, &bad).is_err());
    let mut n = m.clone();
    bad = p.clone();
    bad.get_mut("h_raw").unwrap()[0..8].copy_from_slice(&f64::NAN.to_le_bytes());
    n.payloads.h_raw.sha256 = sha256(&bad["h_raw"]);
    resign(&mut n);
    assert!(validate_payloads(&n, &bad).is_err());
    for ids in [[0_u32, 1, 2, 4], [0, 1, 1, 3]] {
        let mut n = m.clone();
        let mut bad = p.clone();
        bad.insert(
            "sample_cells".into(),
            ids.into_iter().flat_map(u32::to_le_bytes).collect(),
        );
        n.payloads.sample_cells.sha256 = sha256(&bad["sample_cells"]);
        resign(&mut n);
        assert!(validate_payloads(&n, &bad).is_err());
    }
    let mut bad = p.clone();
    bad.insert("v_raw".into(), vec![0; 8]);
    assert!(validate_payloads(&m, &bad).is_err());
}

#[test]
fn capsule_bytes_and_external_child_hash_are_pinned_without_source_authority() {
    let (mut m, _) = fixture();
    let c = capsule();
    let bytes = serde_json::to_vec(&c).unwrap();
    m.parent.evidence_capsule = CasObjectRef {
        object_ref: sha256(&bytes),
        byte_count: bytes.len() as u64,
    };
    resign(&mut m);
    validate_parent_evidence_bytes(&m.parent, &bytes).unwrap();
    validate_no_child_cycle(&"1".repeat(64), &m, &bytes).unwrap();
    assert!(validate_no_child_cycle(&m.parent.owner.package.object_ref, &m, &bytes).is_err());
    assert!(validate_no_child_cycle(&c.record_objects[0].object.object_ref, &m, &bytes).is_err());
    let mut corrupt = bytes.clone();
    corrupt[0] ^= 1;
    assert!(validate_parent_evidence_bytes(&m.parent, &corrupt).is_err());
}

#[test]
fn cycle_check_refuses_unpinned_capsule_with_the_same_owner() {
    let (mut m, _) = fixture();
    let child = "1".repeat(64);
    let mut pinned = capsule();
    pinned.record_objects[0].object.object_ref = child.clone();
    let pinned_bytes = serde_json::to_vec(&pinned).unwrap();
    m.parent.evidence_capsule = CasObjectRef {
        object_ref: sha256(&pinned_bytes),
        byte_count: pinned_bytes.len() as u64,
    };
    resign(&mut m);
    let mut substitute = pinned.clone();
    substitute.record_objects[0].object.object_ref = "2".repeat(64);
    substitute.validate_parent(&m.parent.owner).unwrap();
    let substitute_bytes = serde_json::to_vec(&substitute).unwrap();
    assert_ne!(
        sha256(&substitute_bytes),
        m.parent.evidence_capsule.object_ref
    );
    assert!(validate_no_child_cycle(&child, &m, &pinned_bytes).is_err());
    assert!(validate_no_child_cycle(&child, &m, &substitute_bytes).is_err());
}

#[test]
fn all_seven_authored_pins_and_unsupported_modes_are_checked_even_after_resigning() {
    let (m, _) = fixture();
    for key in [
        "project_id",
        "run_id",
        "task_id",
        "attempt_id",
        "ownership_epoch",
        "artifact_id",
        "object_ref",
    ] {
        let mut value = serde_json::to_value(&m).unwrap();
        value["requested_intent"]["retained_current_source"][key] = if key == "ownership_epoch" {
            json!("1")
        } else if key == "object_ref" {
            json!("1".repeat(64))
        } else {
            json!("other")
        };
        let mut next: RetainedCurrentFieldManifest = serde_json::from_value(value).unwrap();
        resign(&mut next);
        assert!(next.validate_metadata().is_err(), "{key}");
    }
    let mut next = m.clone();
    next.requested_intent.conservative_current_view_ref = Some("legacy".into());
    resign(&mut next);
    assert!(next.validate_metadata().is_err());
    let mut next = m.clone();
    next.sample_carrier.carrier_kind = "magnetic_mesh".into();
    resign(&mut next);
    assert!(next.validate_metadata().is_err());
    let mut next = m.clone();
    next.resolved_execution.execution.device = fullmag_ir::ExecutionDevice::Gpu;
    resign(&mut next);
    assert!(next.validate_metadata().is_err());
    let mut next = m.clone();
    next.qualification = "qualified".into();
    resign(&mut next);
    assert!(next.validate_metadata().is_err());
}

#[test]
fn child_bundle_roundtrip_preserves_exact_bytes_and_inspection_status() {
    let (manifest, payloads) = fixture();
    let raw = serde_json::to_vec(&manifest).unwrap();
    let bytes =
        encode_retained_current_field_bundle(&raw, &payloads, MAX_PACKAGE_BYTES as usize).unwrap();
    assert_eq!(&bytes[..8], b"FMARCF1\0");
    let loaded = decode_retained_current_field_bundle(&bytes, bytes.len()).unwrap();
    assert_eq!(loaded.manifest_bytes, raw);
    assert_eq!(loaded.manifest, manifest);
    assert_eq!(loaded.payloads, payloads);
    assert_eq!(loaded.manifest.status, "inspection_only");
    assert_eq!(loaded.manifest.qualification, "not_verified");
    assert!(decode_retained_current_field_bundle(&bytes, bytes.len() - 1).is_err());
    assert!(encode_retained_current_field_bundle(&raw, &payloads, bytes.len() - 1).is_err());
}

#[test]
fn child_bundle_refuses_corrupt_framing_unknown_version_and_extra_payload() {
    let (manifest, payloads) = fixture();
    let raw = serde_json::to_vec(&manifest).unwrap();
    let maximum = MAX_PACKAGE_BYTES as usize;
    let bytes = encode_retained_current_field_bundle(&raw, &payloads, maximum).unwrap();
    let first = 16 + raw.len();
    for cut in [
        0,
        7,
        8,
        15,
        16,
        first - 1,
        first,
        first + 7,
        bytes.len() - 1,
    ] {
        assert!(
            decode_retained_current_field_bundle(&bytes[..cut], maximum).is_err(),
            "cut {cut}"
        );
    }
    let mut bad = bytes.clone();
    bad[6] = b'2';
    assert!(decode_retained_current_field_bundle(&bad, maximum).is_err());
    for declared in [u64::MAX, MAX_METADATA_BYTES + 1, 0] {
        let mut bad = bytes.clone();
        bad[8..16].copy_from_slice(&declared.to_le_bytes());
        assert!(decode_retained_current_field_bundle(&bad, maximum).is_err());
    }
    let mut bad = bytes.clone();
    bad[first..first + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    assert!(decode_retained_current_field_bundle(&bad, maximum).is_err());
    let mut bad = bytes.clone();
    bad.push(0);
    assert!(decode_retained_current_field_bundle(&bad, maximum).is_err());
    let mut bad = bytes.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert!(decode_retained_current_field_bundle(&bad, maximum).is_err());
    let mut unknown = payloads.clone();
    unknown.insert("parent_bytes".into(), vec![1]);
    assert!(encode_retained_current_field_bundle(&raw, &unknown, maximum).is_err());
    let mut missing = payloads;
    missing.remove("evidence");
    assert!(encode_retained_current_field_bundle(&raw, &missing, maximum).is_err());
}

#[test]
fn child_bundle_refuses_duplicate_or_unknown_manifest_keys_before_payload_copy() {
    let (manifest, payloads) = fixture();
    let raw = serde_json::to_vec(&manifest).unwrap();
    let maximum = MAX_PACKAGE_BYTES as usize;
    let bytes = encode_retained_current_field_bundle(&raw, &payloads, maximum).unwrap();
    let mut duplicate = b"{\"schema_version\":\"duplicate\",".to_vec();
    duplicate.extend_from_slice(&raw[1..]);
    let mut value = serde_json::to_value(&manifest).unwrap();
    value["parent_bytes"] = json!([]);
    for bad in [duplicate, serde_json::to_vec(&value).unwrap()] {
        assert!(encode_retained_current_field_bundle(&bad, &payloads, maximum).is_err());
        let mut framed = b"FMARCF1\0".to_vec();
        framed.extend_from_slice(&(bad.len() as u64).to_le_bytes());
        framed.extend_from_slice(&bad);
        framed.extend_from_slice(&bytes[16 + raw.len()..]);
        assert!(decode_retained_current_field_bundle(&framed, maximum).is_err());
    }
}

#[test]
fn retained_pair_budget_is_checked_per_target_even_when_total_fits() {
    let (mut manifest, _) = fixture();
    manifest.source_cell_count = 2;
    manifest.field_policy.limits.per_target[0] = 1;
    manifest.requested_intent.surface_field_policy = Some(manifest.field_policy.clone());
    resign(&mut manifest);
    assert!(manifest.field_policy.validation_errors("policy").is_empty());
    assert!(
        manifest.source_cell_count * manifest.target_count <= manifest.field_policy.limits.total[0]
    );
    assert!(manifest.validate_metadata().is_err());
}

#[test]
fn prefix_reader_bounds_manifest_before_payload_allocation() {
    let (manifest, payloads) = fixture();
    let raw = serde_json::to_vec(&manifest).unwrap();
    let package = encode_retained_current_field_bundle(&raw, &payloads, MAX_PACKAGE_BYTES as usize).unwrap();
    assert_eq!(retained_current_field_manifest_length(&package[..16], package.len() as u64).unwrap(), raw.len());
    assert!(retained_current_field_manifest_length(&package[..15], package.len() as u64).is_err());
    assert!(retained_current_field_manifest_length(&package[..16], 16).is_err());
    assert!(retained_current_field_manifest_length(&package[..16], MAX_PACKAGE_BYTES + 1).is_err());
    let mut bad = package[..16].to_vec();bad[0] ^= 1;
    assert!(retained_current_field_manifest_length(&bad, package.len() as u64).is_err());
    bad[..8].copy_from_slice(&package[..8]);bad[8..16].copy_from_slice(&(MAX_METADATA_BYTES + 1).to_le_bytes());
    assert!(retained_current_field_manifest_length(&bad, MAX_PACKAGE_BYTES).is_err());
}
