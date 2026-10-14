//! Self-contained retained inspection bytes; no paths, solver or filesystem.
//!
//! V1: 8-byte magic, u64le manifest length, exact manifest bytes, then for
//! each schema-defined payload in descriptor order: u64le length and bytes.
//! The caller must supply the pinned solution identity and verify the outer
//! CAS digest separately. This package is not an authenticated source basis.

use crate::solution::{
    load_antenna_external_lead_solution, load_antenna_external_lead_solution_manifest, require,
    AntennaExternalLeadPayloadRef, AntennaExternalLeadSolutionArtifact,
    AntennaExternalLeadSolutionManifest, AntennaExternalLeadSolutionRef, AntennaPayloadView,
    OwnedAntennaPayload, MAX_BINARY_BYTES, MAX_MANIFEST_BYTES,
};
use crate::ArtifactError;

const MAGIC: &[u8; 8] = b"FMANTPK1";
/// Derived from the existing six-payload and manifest bounds, plus framing.
/// Worker/CAS resource budgets remain a separate, potentially stricter gate.
pub const ANTENNA_INSPECTION_PACKAGE_MAX_BYTES: usize =
    16 + MAX_MANIFEST_BYTES + 6 * (8 + MAX_BINARY_BYTES);

fn descriptors(
    manifest: &AntennaExternalLeadSolutionManifest,
) -> Vec<&AntennaExternalLeadPayloadRef> {
    let mut references = vec![
        &manifest.bundle,
        &manifest.sample_positions,
        &manifest.magnetic_field,
        &manifest.device_vertex_ids,
        &manifest.device_potential,
    ];
    if let Some(current) = &manifest.current_display {
        references.push(&current.payload);
    }
    references
}

pub fn encode_antenna_inspection_package(
    manifest_bytes: &[u8],
    payloads: &[AntennaPayloadView<'_>],
    reference: &AntennaExternalLeadSolutionRef,
) -> Result<Vec<u8>, ArtifactError> {
    require(
        (5..=6).contains(&payloads.len())
            && !manifest_bytes.is_empty()
            && manifest_bytes.len() <= MAX_MANIFEST_BYTES,
        "inspection package manifest/payload count exceeds bounds",
    )?;
    let size = payloads
        .iter()
        .try_fold(16 + manifest_bytes.len(), |size, payload| {
            size.checked_add(8)?.checked_add(payload.bytes.len())
        })
        .ok_or_else(|| ArtifactError {
            message: "inspection package size overflows".into(),
        })?;
    require(
        size <= ANTENNA_INSPECTION_PACKAGE_MAX_BYTES,
        "inspection package exceeds aggregate byte bound",
    )?;
    // Validate every hash and the retained V/RT0/H consistency before encoding.
    // Move out only the manifest so decoded field arrays are dropped here.
    let manifest =
        load_antenna_external_lead_solution(manifest_bytes, payloads, reference)?.manifest;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|error| ArtifactError {
            message: format!("allocate inspection package: {error}"),
        })?;
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(manifest_bytes.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&manifest_bytes);
    for reference in descriptors(&manifest) {
        let payload = payloads
            .iter()
            .find(|payload| payload.path == reference.path)
            .ok_or_else(|| ArtifactError {
                message: "inspection package payload is missing".into(),
            })?;
        bytes.extend_from_slice(&reference.byte_count.to_le_bytes());
        bytes.extend_from_slice(&payload.bytes);
    }
    Ok(bytes)
}

pub fn decode_antenna_inspection_package(
    bytes: &[u8],
    expected: &AntennaExternalLeadSolutionRef,
) -> Result<AntennaExternalLeadSolutionArtifact, ArtifactError> {
    let (manifest_bytes, mut remaining) = read_manifest_frame(bytes)?;
    let manifest = load_antenna_external_lead_solution_manifest(manifest_bytes, expected)?;
    let mut payloads = Vec::with_capacity(6);
    for reference in descriptors(&manifest) {
        let size = take_length(&mut remaining)?;
        require(
            size as u64 == reference.byte_count,
            "inspection package payload length differs from manifest",
        )?;
        payloads.push(OwnedAntennaPayload {
            path: reference.path.clone(),
            bytes: copy_bytes(take(&mut remaining, size)?)?,
        });
    }
    require(
        remaining.is_empty(),
        "inspection package has trailing bytes",
    )?;
    let views = payloads
        .iter()
        .map(|payload| AntennaPayloadView {
            path: &payload.path,
            bytes: &payload.bytes,
        })
        .collect::<Vec<_>>();
    load_antenna_external_lead_solution(manifest_bytes, &views, expected)?;
    Ok(AntennaExternalLeadSolutionArtifact {
        reference: expected.clone(),
        manifest_bytes: copy_bytes(manifest_bytes)?,
        payloads,
    })
}

/// Decode self-described content only after the caller verifies its outer CAS byte integrity.
/// This establishes internal consistency, never freshness or request authenticity.
pub fn decode_self_describing_antenna_inspection_package(
    bytes: &[u8],
) -> Result<AntennaExternalLeadSolutionArtifact, ArtifactError> {
    let (manifest_bytes, _) = read_manifest_frame(bytes)?;
    let manifest = crate::solution::parse_manifest(manifest_bytes)?;
    let expected = AntennaExternalLeadSolutionRef {
        stage_id: manifest.stage_id,
        output_id: manifest.output_id,
        content_digest: manifest.content_digest,
    };
    decode_antenna_inspection_package(bytes, &expected)
}

fn read_manifest_frame(bytes: &[u8]) -> Result<(&[u8], &[u8]), ArtifactError> {
    require(
        bytes.len() <= ANTENNA_INSPECTION_PACKAGE_MAX_BYTES,
        "inspection package exceeds aggregate byte bound",
    )?;
    let mut remaining = bytes;
    require(
        take(&mut remaining, MAGIC.len())? == MAGIC,
        "unknown inspection package version",
    )?;
    let manifest_size = take_length(&mut remaining)?;
    require(
        manifest_size > 0 && manifest_size <= MAX_MANIFEST_BYTES,
        "inspection package manifest exceeds bounds",
    )?;
    let manifest_bytes = take(&mut remaining, manifest_size)?;
    Ok((manifest_bytes, remaining))
}

pub fn copy_bytes(source: &[u8]) -> Result<Vec<u8>, ArtifactError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(source.len())
        .map_err(|error| ArtifactError {
            message: format!("allocate inspection package payload: {error}"),
        })?;
    bytes.extend_from_slice(source);
    Ok(bytes)
}

fn take<'a>(remaining: &mut &'a [u8], size: usize) -> Result<&'a [u8], ArtifactError> {
    require(size <= remaining.len(), "inspection package is truncated")?;
    let (value, rest) = (*remaining).split_at(size);
    *remaining = rest;
    Ok(value)
}

fn take_length(remaining: &mut &[u8]) -> Result<usize, ArtifactError> {
    let bytes: [u8; 8] = take(remaining, 8)?.try_into().map_err(|_| ArtifactError {
        message: "inspection package length is truncated".into(),
    })?;
    usize::try_from(u64::from_le_bytes(bytes)).map_err(|_| ArtifactError {
        message: "inspection package length is not representable".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(manifest: &[u8]) -> Vec<u8> {
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&(manifest.len() as u64).to_le_bytes());
        bytes.extend_from_slice(manifest);
        bytes
    }

    #[test]
    fn self_description_uses_bounded_versioned_manifest_framing() {
        for bytes in [Vec::new(), MAGIC.to_vec(), frame(b""), frame(b"{")] {
            assert!(decode_self_describing_antenna_inspection_package(&bytes).is_err());
        }
        let mut unknown = frame(b"{}");
        unknown[7] = b'2';
        assert!(decode_self_describing_antenna_inspection_package(&unknown)
            .unwrap_err()
            .message
            .contains("unknown inspection package version"));
        let mut oversized = MAGIC.to_vec();
        oversized.extend_from_slice(&((MAX_MANIFEST_BYTES + 1) as u64).to_le_bytes());
        assert!(
            decode_self_describing_antenna_inspection_package(&oversized)
                .unwrap_err()
                .message
                .contains("inspection package manifest exceeds bounds")
        );
    }

    #[test]
    fn self_description_rejects_duplicate_keys_before_identity_extraction() {
        for manifest in [
            br#"{"stage_id":"a","stage_id":"b"}"#.as_slice(),
            br#"{"nested":{"content_digest":"a","content_digest":"b"}}"#.as_slice(),
        ] {
            let error =
                decode_self_describing_antenna_inspection_package(&frame(manifest)).unwrap_err();
            assert!(error.message.contains("duplicate"), "{}", error.message);
        }
    }
}
