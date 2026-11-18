use anyhow::Context;
use super::{
    write_live_file_atomically, AcceptedLiveMagnetizationRef, AcceptedLiveObservation,
    AcceptedLiveObservationWriter, ACCEPTED_LIVE_HEADER_MAX_BYTES,
    ACCEPTED_LIVE_MAGNETIZATION_PREFIX, ACCEPTED_LIVE_MAGNETIZATION_SUFFIX,
    ACCEPTED_LIVE_OBSERVATION_FILE,
};
use super::accepted_live_layout_mask::{
    SUPPORT_MASK_ENCODING, SUPPORT_MASK_PREFIX,
};
use fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics;
use fullmag_runner::{LiveFemLocalNodeMapIdentity, StepStats, StepUpdate};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use tempfile::TempDir;

const RUN_ID: &str = "run-large-live-layout";
const TASK_ID: &str = "task-large-live-layout";
const STEP_ID: &str = "step-large-live-layout";
const ATTEMPT_ID: &str = "attempt-large-live-layout";
const NODE_COUNT: usize = 60_000;

struct LiveFixture {
    root: TempDir,
    attempt_dir: PathBuf,
    layout: Value,
    space_fingerprint: String,
    active_mask: Option<Vec<bool>>,
    magnetization: Vec<[f64; 3]>,
    stats: StepStats,
    writer: AcceptedLiveObservationWriter,
}

impl LiveFixture {
    fn fem(active_mask: Vec<bool>) -> Self {
        let (layout, space_fingerprint) = canonical_fem_layout(&active_mask);
        Self::with_layout(
            layout,
            space_fingerprint,
            active_mask.len(),
            "fem_gpu",
            Some(active_mask),
        )
    }

    fn with_layout(
        layout: Value,
        space_fingerprint: String,
        node_count: usize,
        realization: &str,
        active_mask: Option<Vec<bool>>,
    ) -> Self {
        let root = tempfile::tempdir().unwrap();
        let attempt_dir = root
            .path()
            .join("runs")
            .join(RUN_ID)
            .join("worker-attempts")
            .join(TASK_ID)
            .join(ATTEMPT_ID)
            .join("epoch-1");
        std::fs::create_dir_all(&attempt_dir).unwrap();

        let magnetization: Vec<[f64; 3]> = (0..node_count)
            .map(|index| [index as f64 / 10.0, -0.5, 1.0])
            .collect();
        let magnetization_bytes = encode_magnetization(&magnetization);
        let file_name = format!(
            "{ACCEPTED_LIVE_MAGNETIZATION_PREFIX}1{ACCEPTED_LIVE_MAGNETIZATION_SUFFIX}"
        );
        write_live_file_atomically(&attempt_dir, &file_name, &magnetization_bytes).unwrap();
        let stats = StepStats {
            step: 42,
            time: 4.2e-12,
            dt: 1.0e-13,
            ..StepStats::default()
        };
        let fem_local_node_map = (realization == "fem_cpu" || realization == "fem_gpu")
            .then(|| LiveFemLocalNodeMapIdentity {
                mesh_generation_id: "mesh-generation-large-support".into(),
                local_node_index_map_sha256: "b".repeat(64),
                node_count,
            });
        let reference = AcceptedLiveMagnetizationRef {
            sequence: 1,
            source_step: stats.step,
            source_time_s: stats.time,
            solver_dt_s: stats.dt,
            sample_count: node_count as u64,
            file_name,
            content_sha256: fullmag_application::study_artifact_content_sha256(
                &magnetization_bytes,
            ),
            layout: layout.clone(),
            space_fingerprint: space_fingerprint.clone(),
            active_support_mask: None,
            fem_local_node_map,
            fields: Vec::new(),
        };
        let live_demand =
            crate::accepted_live_demand::AcceptedLiveDemandReader::new(&attempt_dir, RUN_ID);
        let writer = AcceptedLiveObservationWriter {
            attempt_output_dir: attempt_dir.clone(),
            run_id: RUN_ID.into(),
            task_id: TASK_ID.into(),
            step_id: STEP_ID.into(),
            attempt_id: ATTEMPT_ID.into(),
            ownership_epoch: 1,
            realization: realization.into(),
            magnetization_domain: None,
            max_magnetization_bytes: magnetization_bytes.len() as u64,
            sequence: 0,
            magnetization_sequence: 1,
            last_scalar_write: None,
            current_magnetization: Some(reference),
            recent_clock: VecDeque::new(),
            reported_failure: false,
            terminal_spool: None,
            terminal_storage_budget: 0,
            terminal_field_budget: 0,
            live_demand,
            last_stats: None,
        };
        Self {
            root,
            attempt_dir,
            layout,
            space_fingerprint,
            active_mask,
            magnetization,
            stats,
            writer,
        }
    }

    fn read(&self, known_magnetization_sequence: Option<u64>) -> anyhow::Result<AcceptedLiveObservation> {
        super::read_accepted_live_observation(
            self.root.path(),
            RUN_ID,
            TASK_ID,
            STEP_ID,
            ATTEMPT_ID,
            1,
            known_magnetization_sequence,
        )?
        .context("published live observation is readable")
    }

    fn raw_header(&self) -> Value {
        serde_json::from_slice(
            &std::fs::read(self.attempt_dir.join(ACCEPTED_LIVE_OBSERVATION_FILE)).unwrap(),
        )
        .unwrap()
    }

    fn write_raw_header(&self, header: &Value) {
        write_live_file_atomically(
            &self.attempt_dir,
            ACCEPTED_LIVE_OBSERVATION_FILE,
            &serde_json::to_vec(header).unwrap(),
        )
        .unwrap();
    }
}

fn canonical_fem_layout(active_mask: &[bool]) -> (Value, String) {
    let topology_fingerprint = format!("sha256:{}", "a".repeat(64));
    let semantics = FemP1MagnetizationFieldSemantics::new(
        &topology_fingerprint,
        active_mask.len(),
        active_mask.to_vec(),
    )
    .expect("synthetic FEM support produces a valid P1 descriptor");
    let layout = json!({
        "backend": "fem",
        "mesh_name": "large-support-fixture",
        "mesh_source": null,
        "fe_order": 1,
        "hmax": 0.4,
        "topology_fingerprint": topology_fingerprint,
        "n_nodes": active_mask.len(),
        "n_elements": active_mask.len() / 4,
        "field_semantics": semantics,
    });
    let fingerprint = fullmag_application::study_state_layout_sha256(&layout)
        .expect("canonical FEM layout fingerprint");
    (layout, fingerprint)
}

fn encode_magnetization(values: &[[f64; 3]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 3 * 8);
    for value in values {
        for component in value {
            bytes.extend_from_slice(&component.to_le_bytes());
        }
    }
    bytes
}

fn encode_mask_lsb0(mask: &[bool]) -> Vec<u8> {
    let byte_count = mask.len() / 8 + if mask.len() % 8 == 0 { 0 } else { 1 };
    let mut bytes = vec![0; byte_count];
    for (index, active) in mask.iter().enumerate() {
        if *active {
            bytes[index / 8] |= 1_u8 << (index % 8);
        }
    }
    bytes
}

fn observation_step(stats: StepStats) -> StepUpdate {
    StepUpdate {
        stats,
        coupled_checkpoint: None,
        grid: [0; 3],
        fem_mesh_generation_id: None,
        magnetization: None,
        magnetization_carrier: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        terminal_field_snapshot: false,
        finished: false,
    }
}

fn rewrite_header_for_read_failure(fixture: &LiveFixture, update: impl FnOnce(&mut Value)) {
    let mut header = fixture.raw_header();
    update(&mut header);
    fixture.write_raw_header(&header);
}

#[test]
fn fem_large_active_support_round_trips_bounded_header_layout_and_m() {
    let mut fixture = LiveFixture::fem(vec![true; NODE_COUNT]);
    assert!(
        serde_json::to_vec(&fixture.layout).unwrap().len() as u64
            > ACCEPTED_LIVE_HEADER_MAX_BYTES,
        "fixture must exceed the bounded JSON header through FEM support metadata"
    );

    fixture.writer.write_header(&fixture.stats).unwrap();
    let wire = fixture.raw_header();
    let wire_reference = &wire["magnetization"];
    assert!(wire_reference["layout"]["field_semantics"]
        .get("active_node_mask")
        .is_none());
    assert_eq!(
        wire_reference["active_support_mask"]["encoding"],
        SUPPORT_MASK_ENCODING
    );
    let mask_reference = wire_reference["active_support_mask"].clone();
    let mask_file = fixture.attempt_dir.join(mask_reference["file_name"].as_str().unwrap());
    let mask_bytes = std::fs::read(mask_file).unwrap();
    assert_eq!(mask_bytes, encode_mask_lsb0(fixture.active_mask.as_ref().unwrap()));

    let observation = fixture.read(None).unwrap();
    let read_reference = observation.header.magnetization.as_ref().unwrap();
    assert_eq!(read_reference.layout, fixture.layout);
    assert_eq!(read_reference.space_fingerprint, fixture.space_fingerprint);
    assert_eq!(
        fullmag_application::study_state_layout_sha256(&read_reference.layout).unwrap(),
        read_reference.space_fingerprint,
        "round-trip must preserve the exact canonical layout identity"
    );
    assert!(read_reference.active_support_mask.is_none());
    assert_eq!(
        read_reference.layout["field_semantics"]["active_node_mask"]
            .as_array()
            .unwrap()
            .len(),
        NODE_COUNT
    );
    assert_eq!(observation.magnetization_values, Some(fixture.magnetization.clone()));

    let cached = fixture.read(Some(read_reference.sequence)).unwrap();
    let cached_reference = cached.header.magnetization.as_ref().unwrap();
    assert_eq!(cached_reference.layout, fixture.layout);
    assert_eq!(cached_reference.space_fingerprint, fixture.space_fingerprint);
    assert!(cached.magnetization_values.is_none());
    assert!(cached.fields.is_empty());
}

#[test]
fn fem_mixed_non_byte_aligned_support_round_trips_exact_lsb0_bits() {
    let mut active_mask: Vec<bool> = (0..32_769).map(|index| index % 3 == 0).collect();
    *active_mask.last_mut().unwrap() = true;
    let mut fixture = LiveFixture::fem(active_mask.clone());
    fixture.writer.write_header(&fixture.stats).unwrap();

    let wire = fixture.raw_header();
    let wire_reference = &wire["magnetization"];
    let file_name = wire_reference["active_support_mask"]["file_name"]
        .as_str()
        .unwrap();
    let mask_bytes = std::fs::read(fixture.attempt_dir.join(file_name)).unwrap();
    assert_eq!(mask_bytes, encode_mask_lsb0(&active_mask));
    assert_eq!(mask_bytes.len(), (active_mask.len() + 7) / 8);
    assert_eq!(*mask_bytes.last().unwrap() & !1_u8, 0, "unused pad bits must be zero");

    let observation = fixture.read(None).unwrap();
    let read_reference = observation.header.magnetization.as_ref().unwrap();
    assert_eq!(
        read_reference.layout["field_semantics"]["active_node_mask"],
        json!(active_mask)
    );
    assert_eq!(read_reference.space_fingerprint, fixture.space_fingerprint);
    assert_eq!(observation.magnetization_values, Some(fixture.magnetization.clone()));
}

#[test]
fn small_fem_and_legacy_fdm_inline_layouts_remain_unchanged() {
    let mut small_fem = LiveFixture::fem(vec![true, false, true, true]);
    small_fem.writer.write_header(&small_fem.stats).unwrap();
    let raw_fem = small_fem.raw_header();
    assert!(raw_fem["magnetization"].get("active_support_mask").is_none());
    assert!(raw_fem["magnetization"]["layout"]["field_semantics"]
        .get("active_node_mask")
        .is_some());
    let fem_read = small_fem.read(None).unwrap();
    assert_eq!(
        fem_read.header.magnetization.as_ref().unwrap().layout,
        small_fem.layout
    );
    assert_eq!(fem_read.magnetization_values, Some(small_fem.magnetization));

    let fdm_layout = json!({
        "backend": "fdm",
        "origin_m": [0.0, 0.0, 0.0],
        "grid_cells": [2, 2, 1],
    });
    let fdm_fingerprint = fullmag_application::study_state_layout_sha256(&fdm_layout).unwrap();
    let mut fdm = LiveFixture::with_layout(fdm_layout.clone(), fdm_fingerprint.clone(), 4, "fdm_gpu", None);
    fdm.writer.write_header(&fdm.stats).unwrap();
    let raw_fdm = fdm.raw_header();
    assert!(raw_fdm["magnetization"].get("active_support_mask").is_none());
    let fdm_read = fdm.read(None).unwrap();
    let fdm_reference = fdm_read.header.magnetization.as_ref().unwrap();
    assert_eq!(fdm_reference.layout, fdm_layout);
    assert_eq!(fdm_reference.space_fingerprint, fdm_fingerprint);
    assert_eq!(fdm_read.magnetization_values, Some(fdm.magnetization));
}

#[test]
fn reader_rejects_bad_mask_hash_length_path_and_ambiguous_inline_support() {
    let mut fixture = LiveFixture::fem(vec![true; 32_769]);
    fixture.writer.write_header(&fixture.stats).unwrap();
    let original_header = fixture.raw_header();

    rewrite_header_for_read_failure(&fixture, |header| {
        header["magnetization"]["active_support_mask"]["byte_count"] =
            json!(fixture.active_mask.as_ref().unwrap().len() / 8);
    });
    assert!(fixture.read(None).is_err(), "wrong byte count must fail closed");
    fixture.write_raw_header(&original_header);

    rewrite_header_for_read_failure(&fixture, |header| {
        header["magnetization"]["active_support_mask"]["file_name"] = json!("../outside.lsb0");
    });
    assert!(fixture.read(None).is_err(), "path substitution must fail closed");
    fixture.write_raw_header(&original_header);

    rewrite_header_for_read_failure(&fixture, |header| {
        header["magnetization"]["layout"]["field_semantics"]["active_node_mask"] =
            json!(fixture.active_mask.as_ref().unwrap());
    });
    assert!(fixture.read(None).is_err(), "inline plus external support is ambiguous");
    fixture.write_raw_header(&original_header);

    let file_name = original_header["magnetization"]["active_support_mask"]["file_name"]
        .as_str()
        .unwrap();
    let path = fixture.attempt_dir.join(file_name);
    let mut corrupted = std::fs::read(&path).unwrap();
    corrupted[0] ^= 0x80;
    std::fs::write(path, corrupted).unwrap();
    assert!(fixture.read(None).is_err(), "content hash mismatch must fail closed");
}

#[test]
fn reader_rejects_nonzero_padding_bits_even_when_digest_and_name_match() {
    let active_mask: Vec<bool> = (0..32_769).map(|index| index % 2 == 0).collect();
    let mut fixture = LiveFixture::fem(active_mask);
    fixture.writer.write_header(&fixture.stats).unwrap();
    let mut header = fixture.raw_header();
    let old_name = header["magnetization"]["active_support_mask"]["file_name"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut bytes = std::fs::read(fixture.attempt_dir.join(&old_name)).unwrap();
    *bytes.last_mut().unwrap() |= 0x80;
    let digest = fullmag_application::study_artifact_content_sha256(&bytes);
    let new_name = format!("{SUPPORT_MASK_PREFIX}{digest}.lsb0");
    write_live_file_atomically(&fixture.attempt_dir, &new_name, &bytes).unwrap();
    header["magnetization"]["active_support_mask"]["content_sha256"] = json!(digest);
    header["magnetization"]["active_support_mask"]["file_name"] = json!(new_name);
    fixture.write_raw_header(&header);
    assert!(fixture.read(None).is_err(), "nonzero padding bits must fail closed");
}

#[cfg(unix)]
#[test]
fn reader_rejects_symlinked_support_mask_sidecar() {
    use std::os::unix::fs::symlink;

    let mut fixture = LiveFixture::fem(vec![true; 32_769]);
    fixture.writer.write_header(&fixture.stats).unwrap();
    let header = fixture.raw_header();
    let file_name = header["magnetization"]["active_support_mask"]["file_name"]
        .as_str()
        .unwrap();
    let sidecar = fixture.attempt_dir.join(file_name);
    let outside = fixture.root.path().join("outside.lsb0");
    std::fs::write(&outside, std::fs::read(&sidecar).unwrap()).unwrap();
    std::fs::remove_file(&sidecar).unwrap();
    symlink(outside, sidecar).unwrap();
    assert!(fixture.read(None).is_err(), "symlinked support mask must fail closed");
}

#[test]
fn corrupted_existing_mask_drops_field_but_keeps_scalar_progress() {
    let mut fixture = LiveFixture::fem(vec![true; 32_769]);
    fixture.writer.write_header(&fixture.stats).unwrap();
    let header = fixture.raw_header();
    let file_name = header["magnetization"]["active_support_mask"]["file_name"]
        .as_str()
        .unwrap();
    let sidecar = fixture.attempt_dir.join(file_name);
    let mut corrupted = std::fs::read(&sidecar).unwrap();
    corrupted[0] ^= 1;
    std::fs::write(sidecar, corrupted).unwrap();

    let next_stats = StepStats {
        step: 43,
        time: 4.3e-12,
        dt: 1.0e-13,
        ..fixture.stats.clone()
    };
    fixture.writer.observe(&observation_step(next_stats.clone()));

    let observation = fixture.read(None).unwrap();
    assert_eq!(observation.header.stats.as_ref().unwrap().step, next_stats.step);
    assert!(observation.header.magnetization.is_none());
    assert!(observation.magnetization_values.is_none());
    assert_eq!(fixture.writer.sequence, 2);
}

#[test]
fn fem_support_node_count_must_match_live_sample_count() {
    let mut fixture = LiveFixture::fem(vec![true; 32_769]);
    fixture.writer.current_magnetization.as_mut().unwrap().sample_count -= 1;
    assert!(fixture.writer.write_header(&fixture.stats).is_err());
    fixture.writer.current_magnetization.as_mut().unwrap().sample_count += 1;
    fixture.writer.write_header(&fixture.stats).unwrap();
    rewrite_header_for_read_failure(&fixture, |header| {
        header["magnetization"]["sample_count"] = json!(32_768);
    });
    assert!(fixture.read(None).is_err());
}

#[test]
fn partial_first_mask_write_is_unpublished_and_retry_recovers_fields() {
    use std::io::Write;
    let mut fixture = LiveFixture::fem(vec![true; 32_769]);
    let (_, pending) = super::accepted_live_layout_mask::compact_reference_for_header(
        fixture.writer.current_magnetization.as_ref().unwrap(),
    ).unwrap();
    let pending = pending.unwrap();
    let target = fixture.attempt_dir.join(&pending.reference.file_name);
    let entries = |dir: &std::path::Path| {
        let mut names = std::fs::read_dir(dir).unwrap()
            .map(|entry| entry.unwrap().file_name()).collect::<Vec<_>>();
        names.sort();
        names
    };
    let before = entries(&fixture.attempt_dir);
    let error = super::accepted_live_layout_mask::publish_immutable_mask_with(
        &fixture.attempt_dir, &pending.reference, &pending.bytes,
        |file, bytes| {
            file.write_all(&bytes[..bytes.len() / 2])?;
            Err(std::io::Error::new(std::io::ErrorKind::Other, "injected partial disk write"))
        },
    );
    assert!(error.is_err());
    assert!(!target.exists(), "partial bytes must never occupy the immutable mask name");
    assert_eq!(entries(&fixture.attempt_dir), before, "failed writes leave no staging files");
    fixture.writer.write_header(&fixture.stats).unwrap();
    let recovered = fixture.read(None).unwrap();
    assert_eq!(recovered.magnetization_values, Some(fixture.magnetization));
}
