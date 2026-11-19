//! Bounded internal codec for large FEM P1 live support masks.

use super::{read_explicit_runner_artifact, AcceptedLiveMagnetizationRef};
use anyhow::{bail, Context, Result};
use fullmag_quantities::fem_state_field::FemP1MagnetizationFieldSemantics;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

pub(super) const SUPPORT_MASK_ENCODING: &str = "fem_p1_active_node_mask_lsb0.v1";
pub(super) const SUPPORT_MASK_PREFIX: &str = "live_observation_support_";
const SUPPORT_MASK_SUFFIX: &str = ".lsb0";
const INLINE_SUPPORT_MASK_MAX_NODES: u64 = 32_768;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct FemSupportMaskRef {
    pub(super) encoding: String,
    pub(super) node_count: u64,
    pub(super) byte_count: u64,
    pub(super) content_sha256: String,
    pub(super) file_name: String,
}

pub(super) struct PendingSupportMask {
    pub(super) reference: FemSupportMaskRef,
    pub(super) bytes: Vec<u8>,
}

/// Compact only a validated large FEM P1 mask, leaving the producer-owned
/// reference untouched so its canonical layout and fingerprint stay intact.
pub(super) fn compact_reference_for_header(
    reference: &AcceptedLiveMagnetizationRef,
) -> Result<(AcceptedLiveMagnetizationRef, Option<PendingSupportMask>)> {
    if reference.active_support_mask.is_some() {
        bail!("worker magnetization reference is already support-mask compacted");
    }
    let mut compacted = reference.clone();
    if compacted.layout.get("backend").and_then(Value::as_str) != Some("fem")
        || compacted.layout.get("fe_order").and_then(Value::as_u64) != Some(1)
    {
        return Ok((compacted, None));
    }
    let Some(field_semantics) = compacted.layout.get("field_semantics") else {
        return Ok((compacted, None));
    };
    let Some(mask_value) = field_semantics.get("active_node_mask") else {
        return Ok((compacted, None));
    };
    let node_count = compacted
        .layout
        .get("n_nodes")
        .and_then(Value::as_u64)
        .context("large FEM support layout has no node count")?;
    if reference.sample_count != node_count {
        bail!("FEM support layout node count differs from its live sample count");
    }
    if node_count <= INLINE_SUPPORT_MASK_MAX_NODES {
        return Ok((compacted, None));
    }
    let max_nodes = super::ACCEPTED_LIVE_MAX_MAGNETIZATION_SAMPLES as u64;
    if node_count > max_nodes {
        bail!("FEM support mask exceeds the live magnetization node bound");
    }
    let node_count_usize = usize::try_from(node_count)
        .context("FEM support node count does not fit this platform")?;
    let topology_fingerprint = compacted
        .layout
        .get("topology_fingerprint")
        .and_then(Value::as_str)
        .context("large FEM support layout has no topology fingerprint")?;
    let semantics: FemP1MagnetizationFieldSemantics =
        serde_json::from_value(field_semantics.clone())
            .context("decode canonical FEM P1 support semantics")?;
    if mask_value.as_array().is_none_or(|mask| {
        mask.len() != node_count_usize || mask.iter().any(|value| !value.is_boolean())
    }) {
        bail!("FEM support mask does not exactly match its node count");
    }
    semantics
        .validate(topology_fingerprint, node_count_usize)
        .context("validate canonical FEM P1 support semantics")?;
    if fullmag_application::study_state_layout_sha256(&compacted.layout)?
        != compacted.space_fingerprint
    {
        bail!("FEM support layout fingerprint differs from its live reference");
    }

    let active_mask = semantics.active_node_mask;
    let bytes = encode_active_node_mask(&active_mask)?;
    let content_sha256 = fullmag_application::study_artifact_content_sha256(&bytes);
    let mask_reference = FemSupportMaskRef {
        encoding: SUPPORT_MASK_ENCODING.into(),
        node_count,
        byte_count: u64::try_from(bytes.len()).context("FEM support byte count overflow")?,
        file_name: support_mask_file_name(&content_sha256)?,
        content_sha256,
    };
    let semantics_value = compacted
        .layout
        .get_mut("field_semantics")
        .and_then(Value::as_object_mut)
        .context("canonical FEM support semantics are not an object")?;
    if semantics_value.remove("active_node_mask").is_none() {
        bail!("FEM support mask disappeared while compacting its header copy");
    }
    compacted.active_support_mask = Some(mask_reference.clone());
    Ok((
        compacted,
        Some(PendingSupportMask {
            reference: mask_reference,
            bytes,
        }),
    ))
}

/// Reconstruct a large FEM layout before exposing the observation to callers.
/// This intentionally runs even when the caller already has the m payload.
pub(super) fn hydrate_reference_layout(
    attempt_dir: &Path,
    reference: &mut AcceptedLiveMagnetizationRef,
) -> Result<()> {
    let Some(mask_reference) = reference.active_support_mask.as_ref() else {
        return Ok(());
    };
    let layout = &reference.layout;
    if layout.get("backend").and_then(Value::as_str) != Some("fem")
        || layout.get("fe_order").and_then(Value::as_u64) != Some(1)
    {
        bail!("external support mask is valid only for FEM P1 layouts");
    }
    let field_semantics = layout
        .get("field_semantics")
        .and_then(Value::as_object)
        .context("external FEM support layout has no field semantics")?;
    if field_semantics.contains_key("active_node_mask") {
        bail!("FEM support mask is ambiguous with an inline active-node mask");
    }
    let node_count = layout
        .get("n_nodes")
        .and_then(Value::as_u64)
        .context("external FEM support layout has no node count")?;
    if reference.sample_count != node_count {
        bail!("external FEM support layout node count differs from its live sample count");
    }
    if node_count != mask_reference.node_count {
        bail!("FEM support reference node count differs from its layout");
    }
    validate_mask_reference(mask_reference)?;
    let expected_byte_count = support_mask_byte_count(node_count)?;
    let bytes = super::read_explicit_runner_artifact(
        attempt_dir,
        &mask_reference.file_name,
        expected_byte_count,
    )
    .context("read bounded FEM support-mask sidecar")?;
    if u64::try_from(bytes.len()).ok() != Some(expected_byte_count)
        || fullmag_application::study_artifact_content_sha256(&bytes)
            != mask_reference.content_sha256
    {
        bail!("FEM support-mask sidecar length or digest is invalid");
    }
    let active_mask = decode_active_node_mask(&bytes, node_count)?;
    let topology_fingerprint = layout
        .get("topology_fingerprint")
        .and_then(Value::as_str)
        .context("external FEM support layout has no topology fingerprint")?;
    let node_count_usize = usize::try_from(node_count)
        .context("FEM support node count does not fit this platform")?;
    let semantics_value = layout
        .get("field_semantics")
        .cloned()
        .context("external FEM support layout has no field semantics")?;
    let mut semantics_object = semantics_value
        .as_object()
        .cloned()
        .context("external FEM support semantics are not an object")?;
    semantics_object.insert("active_node_mask".into(), json!(active_mask));
    let full_semantics: FemP1MagnetizationFieldSemantics =
        serde_json::from_value(Value::Object(semantics_object.clone()))
            .context("decode hydrated FEM P1 support semantics")?;
    full_semantics
        .validate(topology_fingerprint, node_count_usize)
        .context("validate hydrated FEM P1 support semantics")?;

    let mut hydrated_layout = layout.clone();
    hydrated_layout["field_semantics"] = Value::Object(semantics_object);
    if fullmag_application::study_state_layout_sha256(&hydrated_layout)?
        != reference.space_fingerprint
    {
        bail!("hydrated FEM support layout fingerprint differs from its live reference");
    }
    reference.layout = hydrated_layout;
    reference.active_support_mask = None;
    Ok(())
}

pub(super) fn publish_immutable_mask(
    attempt_dir: &Path,
    reference: &FemSupportMaskRef,
    bytes: &[u8],
) -> Result<()> {
    publish_immutable_mask_with(attempt_dir, reference, bytes, |file, bytes| {
        file.write_all(bytes)?;
        file.sync_all()
    })
}

pub(super) fn publish_immutable_mask_with(
    attempt_dir: &Path,
    reference: &FemSupportMaskRef,
    bytes: &[u8],
    write_complete: impl FnOnce(&mut fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<()> {
    validate_mask_reference(reference)?;
    let expected_byte_count = support_mask_byte_count(reference.node_count)?;
    if u64::try_from(bytes.len()).ok() != Some(expected_byte_count)
        || fullmag_application::study_artifact_content_sha256(bytes) != reference.content_sha256
    {
        bail!("pending FEM support-mask bytes do not match their reference");
    }
    let root_metadata = fs::symlink_metadata(attempt_dir)
        .context("inspect worker attempt directory for FEM support-mask publication")?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        bail!("worker attempt output root must be a real directory");
    }
    let target = attempt_dir.join(&reference.file_name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("existing FEM support-mask sidecar is not a regular file");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // The immutable name becomes visible only after a complete write.
            // NamedTempFile removes our unpublished staging file on any error;
            // hard_link never replaces another publisher's existing target.
            let mut staging = tempfile::NamedTempFile::new_in(attempt_dir)
                .context("create FEM support-mask staging file")?;
            write_complete(staging.as_file_mut(), bytes)
                .context("write immutable FEM support-mask staging file")?;
            match fs::hard_link(staging.path(), &target) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error).context("publish immutable FEM support-mask sidecar"),
            }
            drop(staging);
        }
        Err(error) => return Err(error).context("inspect immutable FEM support-mask sidecar"),
    }
    let existing = read_explicit_runner_artifact(
        attempt_dir, &reference.file_name, expected_byte_count,
    ).context("verify published immutable FEM support-mask sidecar")?;
    if existing != bytes {
        bail!("existing FEM support-mask sidecar has different immutable bytes");
    }
    Ok(())
}

fn encode_active_node_mask(mask: &[bool]) -> Result<Vec<u8>> {
    let node_count = u64::try_from(mask.len()).context("FEM support node count overflow")?;
    let byte_count = support_mask_byte_count(node_count)?;
    let byte_count = usize::try_from(byte_count).context("FEM support byte count overflow")?;
    let mut bytes = vec![0; byte_count];
    for (index, active) in mask.iter().enumerate() {
        if *active {
            bytes[index / 8] |= 1_u8 << (index % 8);
        }
    }
    Ok(bytes)
}

fn decode_active_node_mask(bytes: &[u8], node_count: u64) -> Result<Vec<bool>> {
    let expected_byte_count = support_mask_byte_count(node_count)?;
    if u64::try_from(bytes.len()).ok() != Some(expected_byte_count) {
        bail!("FEM support-mask sidecar byte count is invalid");
    }
    let remainder = (node_count % 8) as u8;
    if remainder != 0 {
        let valid_bits = ((1_u16 << remainder) - 1) as u8;
        if bytes.last().is_none_or(|last| *last & !valid_bits != 0) {
            bail!("FEM support-mask sidecar has nonzero padding bits");
        }
    }
    let node_count = usize::try_from(node_count).context("FEM support node count overflow")?;
    Ok((0..node_count)
        .map(|index| bytes[index / 8] & (1_u8 << (index % 8)) != 0)
        .collect())
}

fn support_mask_byte_count(node_count: u64) -> Result<u64> {
    if node_count == 0 || node_count > super::ACCEPTED_LIVE_MAX_MAGNETIZATION_SAMPLES as u64 {
        bail!("FEM support node count is outside the live magnetization bound");
    }
    (node_count / 8)
        .checked_add(if node_count % 8 != 0 { 1 } else { 0 })
        .context("FEM support-mask byte count overflow")
}

fn support_mask_file_name(content_sha256: &str) -> Result<String> {
    if content_sha256.len() != 64
        || !content_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("FEM support-mask content digest is not canonical SHA-256");
    }
    Ok(format!("{SUPPORT_MASK_PREFIX}{content_sha256}{SUPPORT_MASK_SUFFIX}"))
}

fn validate_mask_reference(reference: &FemSupportMaskRef) -> Result<()> {
    if reference.encoding != SUPPORT_MASK_ENCODING {
        bail!("FEM support-mask encoding is unsupported");
    }
    let expected_byte_count = support_mask_byte_count(reference.node_count)?;
    if reference.node_count <= INLINE_SUPPORT_MASK_MAX_NODES
        || reference.byte_count != expected_byte_count
        || reference.file_name != support_mask_file_name(&reference.content_sha256)?
    {
        bail!("FEM support-mask reference shape or file identity is invalid");
    }
    Ok(())
}
