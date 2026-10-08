use super::*;
use crate::native_fem::accepted_external_lead::inspection_test_bundle;
use fullmag_ir::{
    AntennaFieldSolutionRefIR, AntennaSolutionRefIR, AntennaSpectrumNormalizationIR,
    AntennaSpectrumOutsidePolicyIR, AntennaSpectrumRequestIR, AntennaSpectrumSamplingPlaneIR,
    AntennaSpectrumTransformIR, AntennaSpectrumWindowIR, LinearTransportSolverPolicyIR,
    SolvedAntennaDriveIR,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

#[derive(Clone)]
struct Fixture {
    manifest: AntennaExternalLeadSolutionManifest,
    reference: AntennaExternalLeadSolutionRef,
    payloads: Vec<AuxiliaryArtifact>,
}

impl Fixture {
    fn new() -> Self {
        let raw = inspection_test_bundle();
        let bundle = decode_owned_bundle(raw.clone(), &sha256(&raw)).unwrap();
        let xyz = encode_reals(bundle.field.targets_m.iter().flatten().copied());
        let h = encode_reals(bundle.h_xyz_apm.iter().flatten().copied());
        // Deliberately authored order, not the sorted native partition order.
        let device_ids = (1u64..9).rev().collect::<Vec<_>>();
        let by_id = bundle
            .charge
            .vertices
            .iter()
            .map(|v| (v.id, v.potential_v))
            .collect::<BTreeMap<_, _>>();
        let ids = device_ids
            .iter()
            .copied()
            .flat_map(u64::to_le_bytes)
            .collect::<Vec<_>>();
        let v = encode_reals(device_ids.iter().map(|id| by_id[id]));
        // Shape-valid receipt literals ONLY. They prove neither current model
        // freshness nor the materializer/builder's actual-input binding.
        let pin = format!("sha256:{}", "1".repeat(64));
        let manifest = AntennaExternalLeadSolutionManifest {
            schema_version: ANTENNA_EXTERNAL_LEAD_SOLUTION_SCHEMA.into(),
            status: "inspection_only".into(),
            qualification: "NOT VERIFIED".into(),
            field_scope: "external_electrode_truncation".into(),
            stage_id: "solve-external".into(),
            output_id: "inspection-external".into(),
            source_object_id: "antenna-object".into(),
            current_transport_id: "current-source".into(),
            port_mode_id: "port-mode".into(),
            drive_id: "current-drive".into(),
            closure_revision: bundle.source.closure_revision.clone(),
            input_pins: AntennaCurrentInputPinsIR {
                schema_version: "antenna_current_input_pins.canonical_json.v1".into(),
                authored_source_sha256: pin.clone(),
                device_mesh_ownership_sha256: pin.clone(),
                selected_control_sha256: pin.clone(),
                combined_mesh_material_sha256: pin.clone(),
                solver_sampling_sha256: pin.clone(),
                materialized_input_sha256: pin.clone(),
            },
            requested_execution: RequestedTransportExecutionIR {
                discretization: BackendTarget::Fem,
                device: ExecutionDevice::Cpu,
                precision: ExecutionPrecision::Double,
                execution_mode: ExecutionMode::Strict,
            },
            solver_policy: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1e-12,
                    absolute_tolerance: 0.0,
                    max_iterations: 1000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fem_charge_conforming_h1_p1.transparent.v1".into(),
            },
            resolved_execution: AntennaExternalLeadExecutionReceipt {
                engine: "fem".into(),
                device: "cpu".into(),
                precision: "double".into(),
                operator_version: "fem_accepted_external_lead_bundle.v1".into(),
                adapter_version: ADAPTER_VERSION.into(),
                absolute_jump_tolerance_v: 1e-12,
                relative_jump_tolerance: 1e-12,
            },
            sampling_carrier: AntennaExternalLeadSamplingCarrier {
                domain: FieldTargetIR::Global {},
                carrier_kind: "point_field_sampling".into(),
                location: "node".into(),
                topology_digest: pin,
                sample_count: 1,
            },
            charge_content_sha256: bundle.charge.content_sha256.clone(),
            source_content_sha256: bundle.source_content_sha256.clone(),
            field_content_sha256: bundle.field_content_sha256.clone(),
            bundle: payload_ref(
                BUNDLE_PATH,
                &raw,
                "ordered_binary_v1",
                "accepted_external_lead_bundle.ordered.v1",
                "1",
                raw.len(),
            ),
            sample_positions: payload_ref(
                POSITIONS_PATH,
                &xyz,
                "float64_le",
                "sample_xyz_interleaved",
                "m",
                3,
            ),
            magnetic_field: payload_ref(
                FIELD_PATH,
                &h,
                "float64_le",
                "sample_xyz_interleaved",
                "A/m",
                3,
            ),
            device_vertex_ids: payload_ref(
                DEVICE_IDS_PATH,
                &ids,
                "uint64_le",
                "authored_device_vertex_order",
                "1",
                8,
            ),
            device_potential: payload_ref(
                DEVICE_V_PATH,
                &v,
                "float64_le",
                "authored_device_vertex_order",
                "V",
                8,
            ),
            content_digest: String::new(),
        };
        let mut f = Self {
            manifest,
            reference: AntennaExternalLeadSolutionRef {
                stage_id: String::new(),
                output_id: String::new(),
                content_digest: String::new(),
            },
            payloads: [
                (BUNDLE_PATH, raw),
                (POSITIONS_PATH, xyz),
                (FIELD_PATH, h),
                (DEVICE_IDS_PATH, ids),
                (DEVICE_V_PATH, v),
            ]
            .into_iter()
            .map(|(path, bytes)| AuxiliaryArtifact {
                relative_path: path.into(),
                bytes,
            })
            .collect(),
        };
        f.rehash_manifest();
        assert!(
            f.load().is_ok(),
            "inspection fixture must pass before any corruption"
        );
        f
    }
    fn rehash_manifest(&mut self) {
        self.manifest.content_digest = content_digest(&self.manifest).unwrap();
        self.reference = AntennaExternalLeadSolutionRef {
            stage_id: self.manifest.stage_id.clone(),
            output_id: self.manifest.output_id.clone(),
            content_digest: self.manifest.content_digest.clone(),
        };
    }
    fn bytes(&self) -> Vec<u8> {
        serde_json::to_vec(&self.manifest).unwrap()
    }
    fn artifact(&self) -> AntennaExternalLeadSolutionArtifact {
        AntennaExternalLeadSolutionArtifact {
            reference: self.reference.clone(),
            manifest_bytes: self.bytes(),
            payloads: self.payloads.clone(),
        }
    }
    fn load(&self) -> Result<LoadedAntennaExternalLeadSolution, RunError> {
        load_antenna_external_lead_solution(&self.bytes(), &self.payloads, &self.reference)
    }
    fn payload(&self, path: &str) -> &[u8] {
        &self
            .payloads
            .iter()
            .find(|p| p.relative_path == path)
            .unwrap()
            .bytes
    }
    fn replace_payload(&mut self, path: &str, bytes: Vec<u8>) {
        let reference = match path {
            BUNDLE_PATH => &mut self.manifest.bundle,
            POSITIONS_PATH => &mut self.manifest.sample_positions,
            FIELD_PATH => &mut self.manifest.magnetic_field,
            DEVICE_IDS_PATH => &mut self.manifest.device_vertex_ids,
            DEVICE_V_PATH => &mut self.manifest.device_potential,
            _ => panic!("unknown fixture payload"),
        };
        reference.sha256 = sha256(&bytes);
        reference.byte_count = bytes.len() as u64;
        self.payloads
            .iter_mut()
            .find(|p| p.relative_path == path)
            .unwrap()
            .bytes = bytes;
        self.rehash_manifest();
    }
}

#[test]
fn manifest_only_loader_does_not_claim_payload_integrity() {
    let mut f = Fixture::new();
    assert_eq!(
        load_antenna_external_lead_solution_manifest(&f.bytes(), &f.reference).unwrap(),
        f.manifest
    );
    f.payloads
        .iter_mut()
        .find(|p| p.relative_path == FIELD_PATH)
        .unwrap()
        .bytes[0] ^= 1;
    assert!(load_antenna_external_lead_solution_manifest(&f.bytes(), &f.reference).is_ok());
    assert!(f.load().is_err());
    f.payloads.clear();
    assert!(load_antenna_external_lead_solution_manifest(&f.bytes(), &f.reference).is_ok());
    assert!(f.load().is_err());
}

#[test]
fn manifest_only_loader_refuses_rehashed_descriptor_units_counts_paths_and_sizes() {
    let baseline = Fixture::new();
    for mutate in [
        (|f: &mut Fixture| f.manifest.magnetic_field.unit = "A/m/A".into()) as fn(&mut Fixture),
        |f| f.manifest.sample_positions.value_count += 1,
        |f| f.manifest.device_potential.value_count += 1,
        |f| f.manifest.bundle.byte_count = 0,
        |f| f.manifest.bundle.byte_count = MAX_BINARY_BYTES as u64 + 1,
        |f| f.manifest.device_vertex_ids.value_count = u64::MAX,
        |f| f.manifest.device_potential.path = "../device_V.f64le.bin".into(),
        |f| f.manifest.magnetic_field.sha256 = "A".repeat(64),
    ] {
        let mut f = baseline.clone();
        mutate(&mut f);
        f.rehash_manifest();
        assert!(load_antenna_external_lead_solution_manifest(&f.bytes(), &f.reference).is_err());
    }
}

#[test]
fn inspection_loader_retains_exact_raw_bundle_si_units_device_order_v_and_h() {
    let f = Fixture::new();
    let loaded = f.load().unwrap();
    assert_eq!(loaded.canonical_bundle, f.payload(BUNDLE_PATH));
    assert_eq!(
        loaded.device_vertex_ids,
        (1u64..9).rev().collect::<Vec<_>>()
    );
    assert_eq!(loaded.sample_positions_xyz_m, [[3.0, 0.5, 0.5]]);
    assert_eq!(loaded.magnetic_field_xyz_apm, [[0.0; 3]]);
    let bundle =
        decode_owned_bundle(loaded.canonical_bundle.clone(), &f.manifest.bundle.sha256).unwrap();
    assert!(bundle.charge.rt0_flux_a.iter().any(|q| *q != 0.0));
    assert!(bundle
        .source
        .faces
        .iter()
        .all(|face| face.rt0_to_canonical_weight == 2.0));
    assert_eq!(
        loaded.device_potential_v,
        loaded
            .device_vertex_ids
            .iter()
            .map(|id| bundle
                .charge
                .vertices
                .iter()
                .find(|v| v.id == *id)
                .unwrap()
                .potential_v)
            .collect::<Vec<_>>()
    );
    assert_eq!(loaded.manifest.magnetic_field.unit, "A/m");
    assert_eq!(loaded.manifest.device_potential.unit, "V");
    assert_eq!(loaded.manifest.sample_positions.unit, "m");
    assert_eq!(loaded.manifest.status, "inspection_only");
    assert_eq!(loaded.manifest.qualification, "NOT VERIFIED");
}

#[test]
fn inspection_loader_refuses_fully_rehashed_h_and_xyz_derivative_corruption() {
    let baseline = Fixture::new();
    for path in [FIELD_PATH, POSITIONS_PATH] {
        let mut f = baseline.clone();
        let mut bytes = f.payload(path).to_vec();
        bytes[..8].copy_from_slice(&9f64.to_le_bytes());
        f.replace_payload(path, bytes);
        let error = f.load().err().unwrap();
        assert!(error.message.contains("derived target/H bytes"));
    }
}

#[test]
fn inspection_loader_refuses_device_subset_repetition_foreign_ids_stale_order_and_v() {
    let baseline = Fixture::new();
    let ids = (1u64..9).rev().collect::<Vec<_>>();
    for changed in [
        vec![8, 8, 6, 5, 4, 3, 2, 1],
        vec![101, 7, 6, 5, 4, 3, 2, 1],
        vec![7, 8, 6, 5, 4, 3, 2, 1],
        ids[..7].to_vec(),
    ] {
        let mut f = baseline.clone();
        let bytes = changed.into_iter().flat_map(u64::to_le_bytes).collect();
        f.replace_payload(DEVICE_IDS_PATH, bytes);
        assert!(f.load().is_err());
    }
    let mut f = baseline;
    let mut bytes = f.payload(DEVICE_V_PATH).to_vec();
    bytes[..8].copy_from_slice(&42f64.to_le_bytes());
    f.replace_payload(DEVICE_V_PATH, bytes);
    assert!(f
        .load()
        .err()
        .unwrap()
        .message
        .contains("derived device V bytes"));
}

#[test]
fn inspection_loader_accepts_self_consistent_device_permutation_not_current_input_proof() {
    let mut f = Fixture::new();
    let stale_reference = f.reference.clone();
    let mut ids = f.payload(DEVICE_IDS_PATH).to_vec();
    ids[..16].rotate_left(8);
    f.replace_payload(DEVICE_IDS_PATH, ids);
    let mut v = f.payload(DEVICE_V_PATH).to_vec();
    v[..16].rotate_left(8);
    f.replace_payload(DEVICE_V_PATH, v);
    let loaded = f.load().unwrap();
    assert_eq!(loaded.device_vertex_ids[..2], [7, 8]);
    assert!(
        load_antenna_external_lead_solution(&f.bytes(), &f.payloads, &stale_reference).is_err()
    );
}

#[test]
fn inspection_loader_refuses_stale_digest_malformed_pins_schema_promotion_and_gpu() {
    let baseline = Fixture::new();
    let mut stale = baseline.reference.clone();
    stale.content_digest = format!("sha256:{}", "0".repeat(64));
    assert!(
        load_antenna_external_lead_solution(&baseline.bytes(), &baseline.payloads, &stale).is_err()
    );
    for change in 0..10 {
        let mut f = baseline.clone();
        match change {
            0 => f.manifest.input_pins.authored_source_sha256 = "1".repeat(64),
            1 => f.manifest.input_pins.materialized_input_sha256 = "sha256:invalid".into(),
            2 => f.manifest.schema_version = "antenna_field_solution.v1".into(),
            3 => f.manifest.status = "ready".into(),
            4 => f.manifest.field_scope = "closed_loop".into(),
            5 => f.manifest.requested_execution.device = ExecutionDevice::Gpu,
            6 => f.manifest.magnetic_field.unit = "T".into(),
            7 => {
                f.manifest.sampling_carrier.domain = FieldTargetIR::Object {
                    object_id: String::new(),
                }
            }
            8 => {
                f.manifest.sampling_carrier.domain = FieldTargetIR::Region {
                    object_id: "object".into(),
                    region_id: " ".into(),
                }
            }
            9 => {
                f.manifest.sampling_carrier.domain = FieldTargetIR::Object {
                    object_id: "bad\0id".into(),
                }
            }
            _ => unreachable!(),
        }
        f.rehash_manifest();
        assert!(
            f.load().is_err(),
            "accepted invalid manifest mutation {change}"
        );
    }
}

#[test]
fn inspection_loader_refuses_unknown_root_and_nested_solver_policy_shape() {
    let f = Fixture::new();
    for nested in [false, true] {
        let mut value = serde_json::to_value(&f.manifest).unwrap();
        if nested {
            value["solver_policy"]["linear"]["unknown_field"] = true.into();
        } else {
            value["unknown_field"] = true.into();
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(load_antenna_external_lead_solution(&bytes, &f.payloads, &f.reference).is_err());
    }
}

#[test]
fn inspection_manifest_is_refused_by_legacy_llg_and_source_fft_before_projection() {
    let f = Fixture::new();
    let drive: SolvedAntennaDriveIR = serde_json::from_value(serde_json::json!({
        "id":"drive", "name":"Drive", "projection_ref":"projection", "port_mode_id":"port-mode",
        "peak_current_a":1.0, "waveform":{"kind":"constant"}, "time_origin":"absolute",
        "activation":{"kind":"all_time_evolution"}
    }))
    .unwrap();
    // Empty payload/target arguments would fail later. Qualification must be first.
    let error = crate::antenna_field_solution::load_solved_antenna_drive_basis_projected(
        &f.bytes(),
        &[],
        drive,
        &f.reference.output_id,
        &f.manifest.source_object_id,
        &f.reference.content_digest,
        0,
        &[],
        None,
    )
    .err()
    .unwrap();
    assert!(error.message.contains("source_not_qualified"));
    let request = AntennaSpectrumRequestIR {
        id: "spectrum".into(),
        solution_ref: AntennaSolutionRefIR::Published(AntennaFieldSolutionRefIR {
            stage_id: f.reference.stage_id.clone(),
            output_id: f.reference.output_id.clone(),
            asset_id: "inspection-artifact".into(),
            content_digest: f.reference.content_digest.clone(),
        }),
        port_mode_id: Some("port-mode".into()),
        target: FieldTargetIR::Global {},
        transform: AntennaSpectrumTransformIR::SpatialFft,
        sampling_plane: AntennaSpectrumSamplingPlaneIR {
            origin_m: [0.; 3],
            axis_u: [1., 0., 0.],
            axis_v: [0., 1., 0.],
            extent_u_m: 1.,
            extent_v_m: 1.,
            sample_count_u: 2,
            sample_count_v: 2,
            interpolation: "fem_element".into(),
            outside_policy: AntennaSpectrumOutsidePolicyIR::Error,
        },
        window: AntennaSpectrumWindowIR::Rectangular,
        normalization: AntennaSpectrumNormalizationIR::IntegralSi,
        nonuniform_k_grid: None,
        component: "x".into(),
        equilibrium_ref: None,
        mode_basis_ref: None,
        output_id: "spectrum-output".into(),
    };
    let error = crate::antenna_field_solution::load_antenna_field_solution_samples_for_spectrum(
        &f.bytes(),
        &[],
        &request,
    )
    .err()
    .unwrap();
    assert!(error.message.contains("source_not_qualified"));
}

fn publication_test_root() -> PathBuf {
    // Future execution must provide the operator's resolver-owned storage root.
    let storage = PathBuf::from(
        std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT")
            .expect("publication tests require FULLMAG_PROJECT_STORAGE_ROOT from the resolver"),
    );
    assert!(
        storage.is_absolute(),
        "publication test storage must be absolute"
    );
    let temp = storage.join("tmp");
    fs::create_dir_all(&temp).unwrap();
    let root = temp.join(format!(
        "antenna-external-publication-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&root).unwrap();
    fs::canonicalize(root).unwrap()
}

fn cleanup_publication_test(root: &Path, references: &[AntennaExternalLeadSolutionRef]) {
    let output = root
        .join("antenna")
        .join("external_lead_solutions")
        .join(&references[0].output_id);
    for reference in references {
        assert_eq!(reference.output_id, references[0].output_id);
        let revision = output.join(reference.content_digest.strip_prefix("sha256:").unwrap());
        // Remove only our exact known files; any unexpected entry prevents directory removal.
        for name in [
            BUNDLE_PATH,
            POSITIONS_PATH,
            FIELD_PATH,
            DEVICE_IDS_PATH,
            DEVICE_V_PATH,
            "manifest.v1.json",
        ] {
            fs::remove_file(revision.join(name)).unwrap();
        }
        fs::remove_dir(revision).unwrap();
    }
    fs::remove_dir(output).unwrap();
    fs::remove_dir(root.join("antenna").join("external_lead_solutions")).unwrap();
    fs::remove_dir(root.join("antenna")).unwrap();
    fs::remove_dir(root).unwrap();
}

#[test]
fn atomic_inspection_publication_reuses_exact_revision_and_preserves_old_revision() {
    let f = Fixture::new();
    let root = publication_test_root();
    let artifact = f.artifact();
    let first = publish_antenna_external_lead_solution_atomically(&root, &artifact, None).unwrap();
    assert!(!first.reused_existing);
    let loaded = load_published_antenna_external_lead_solution(&root, &f.reference).unwrap();
    assert_eq!(loaded.canonical_bundle, f.payload(BUNDLE_PATH));
    let revision = first.manifest_path.parent().unwrap();
    let mut old_files = f
        .payloads
        .iter()
        .map(|p| (p.relative_path.clone(), p.bytes.clone()))
        .collect::<Vec<_>>();
    old_files.push(("manifest.v1.json".into(), f.bytes()));
    for (name, bytes) in &old_files {
        assert_eq!(fs::read(revision.join(name)).unwrap(), *bytes);
    }
    let reused = publish_antenna_external_lead_solution_atomically(&root, &artifact, None).unwrap();
    assert!(reused.reused_existing);
    assert_eq!(reused.manifest_path, first.manifest_path);
    let mut changed = f.clone();
    changed.manifest.drive_id.push_str("-revision");
    changed.rehash_manifest();
    assert!(changed.load().is_ok());
    let second =
        publish_antenna_external_lead_solution_atomically(&root, &changed.artifact(), None)
            .unwrap();
    assert!(!second.reused_existing);
    assert_ne!(second.manifest_path, first.manifest_path);
    assert_eq!(
        load_published_antenna_external_lead_solution(&root, &changed.reference)
            .unwrap()
            .manifest
            .drive_id,
        changed.manifest.drive_id
    );
    for (name, bytes) in &old_files {
        assert_eq!(fs::read(revision.join(name)).unwrap(), *bytes);
    }
    assert_eq!(fs::read_dir(revision.parent().unwrap()).unwrap().count(), 2);
    cleanup_publication_test(&root, &[f.reference, changed.reference]);
}

#[test]
fn published_manifest_only_read_survives_missing_payload_without_promoting_it() {
    let f = Fixture::new();
    let root = publication_test_root();
    let published =
        publish_antenna_external_lead_solution_atomically(&root, &f.artifact(), None).unwrap();
    let field_path = published.manifest_path.parent().unwrap().join(FIELD_PATH);
    fs::remove_file(&field_path).unwrap();
    assert_eq!(
        load_published_antenna_external_lead_solution_manifest(&root, &f.reference).unwrap(),
        f.manifest
    );
    assert!(load_published_antenna_external_lead_solution(&root, &f.reference).is_err());
    fs::write(field_path, f.payload(FIELD_PATH)).unwrap();
    cleanup_publication_test(&root, &[f.reference]);
}

#[test]
fn atomic_inspection_publication_cancel_and_corrupt_reuse_fail_without_overwrite() {
    let f = Fixture::new();
    let root = publication_test_root();
    let artifact = f.artifact();
    let cancelled = AtomicBool::new(true);
    let error =
        publish_antenna_external_lead_solution_atomically(&root, &artifact, Some(&cancelled))
            .err()
            .unwrap();
    assert!(error.message.contains("cancelled"));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let first = publish_antenna_external_lead_solution_atomically(&root, &artifact, None).unwrap();
    assert!(!first.reused_existing);
    assert!(load_published_antenna_external_lead_solution(&root, &f.reference).is_ok());
    let revision = first.manifest_path.parent().unwrap();
    let error =
        publish_antenna_external_lead_solution_atomically(&root, &artifact, Some(&cancelled))
            .err()
            .unwrap();
    assert!(error.message.contains("cancelled"));
    assert_eq!(fs::read(&first.manifest_path).unwrap(), f.bytes());
    assert_eq!(
        fs::read(revision.join(FIELD_PATH)).unwrap(),
        f.payload(FIELD_PATH)
    );
    let mut corrupt_h = f.payload(FIELD_PATH).to_vec();
    corrupt_h[..8].copy_from_slice(&1f64.to_le_bytes());
    fs::write(revision.join(FIELD_PATH), &corrupt_h).unwrap();
    assert!(load_published_antenna_external_lead_solution(&root, &f.reference).is_err());
    assert!(publish_antenna_external_lead_solution_atomically(&root, &artifact, None).is_err());
    // Refusal must preserve even the corrupted final revision, not silently repair/replace it.
    assert_eq!(fs::read(revision.join(FIELD_PATH)).unwrap(), corrupt_h);
    assert_eq!(fs::read(&first.manifest_path).unwrap(), f.bytes());
    for payload in f.payloads.iter().filter(|p| p.relative_path != FIELD_PATH) {
        assert_eq!(
            fs::read(revision.join(&payload.relative_path)).unwrap(),
            payload.bytes
        );
    }
    assert_eq!(fs::read_dir(revision.parent().unwrap()).unwrap().count(), 1);
    cleanup_publication_test(&root, &[f.reference]);
}
