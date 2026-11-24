//! Bounded child-field framing; parent objects remain external immutable references.
use super::*;
use std::collections::BTreeMap;

const MAGIC: &[u8; 8] = b"FMARCF1\0";

/// Inspect only the fixed framing header before a bounded manifest range read.
/// The caller must hash-verify the entire outer CAS object while retaining only
/// the requested range; this does not validate payloads or grant source authority.
pub fn retained_current_field_manifest_length(header: &[u8], package_byte_count: u64)
    -> Result<usize, ArtifactError> {
    require(header.len() == 16, "retained field fixed header length")?;
    require_package_bound(usize::try_from(package_byte_count).map_err(|_| ArtifactError {
        message: "retained field package size exceeds usize".into(),
    })?, MAX_PACKAGE_BYTES as usize)?;
    let mut remaining = header;
    require(take(&mut remaining, 8)? == MAGIC, "unknown retained field package version")?;
    let size = length(&mut remaining)?;
    require_manifest_bound(size, MAX_METADATA_BYTES as usize)?;
    let minimum = 16_u64.checked_add(size as u64).and_then(|n| n.checked_add(4 * 8))
        .ok_or_else(|| ArtifactError { message: "retained field framed size overflow".into() })?;
    require(minimum <= package_byte_count, "retained field manifest exceeds package framing")?;
    Ok(size)
}

/// Internally consistent child bytes, not source authentication or qualification.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedCurrentFieldBundle {
    pub manifest_bytes: Vec<u8>,
    pub manifest: RetainedCurrentFieldManifest,
    pub payloads: BTreeMap<String, Vec<u8>>,
}

pub fn encode_retained_current_field_bundle(
    manifest_bytes: &[u8],
    payloads: &BTreeMap<String, Vec<u8>>,
    maximum: usize,
) -> Result<Vec<u8>, ArtifactError> {
    require_manifest_bound(manifest_bytes.len(), maximum)?;
    let size = payloads
        .values()
        .try_fold(16usize, |size, bytes| {
            size.checked_add(8)?.checked_add(bytes.len())
        })
        .and_then(|size| size.checked_add(manifest_bytes.len()))
        .ok_or_else(|| ArtifactError {
            message: "retained field package length overflow".into(),
        })?;
    require_package_bound(size, maximum)?;
    let manifest = parse_retained_current_manifest(manifest_bytes)?;
    validate_payloads(&manifest, payloads)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|error| ArtifactError {
            message: format!("allocate retained field package: {error}"),
        })?;
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(manifest_bytes.len() as u64).to_le_bytes());
    bytes.extend_from_slice(manifest_bytes);
    for (key, descriptor) in manifest.payloads.entries() {
        bytes.extend_from_slice(&descriptor.byte_count.to_le_bytes());
        bytes.extend_from_slice(&payloads[key]);
    }
    Ok(bytes)
}

/// Caller must authenticate the exact owner and outer CAS before using this content.
pub fn decode_retained_current_field_bundle(
    bytes: &[u8],
    maximum: usize,
) -> Result<RetainedCurrentFieldBundle, ArtifactError> {
    require_package_bound(bytes.len(), maximum)?;
    let mut remaining = bytes;
    require(
        take(&mut remaining, 8)? == MAGIC,
        "unknown retained field package version",
    )?;
    let manifest_size = length(&mut remaining)?;
    require_manifest_bound(manifest_size, maximum)?;
    let manifest_bytes = take(&mut remaining, manifest_size)?;
    let manifest = parse_retained_current_manifest(manifest_bytes)?;
    // Verify the complete frame before allocating owned payload copies.
    let mut frames = Vec::with_capacity(4);
    for (key, descriptor) in manifest.payloads.entries() {
        let size = length(&mut remaining)?;
        require(
            size as u64 == descriptor.byte_count,
            "retained field framed payload length differs",
        )?;
        frames.push((key, take(&mut remaining, size)?));
    }
    require(
        remaining.is_empty(),
        "retained field package has trailing bytes",
    )?;
    let mut payloads = BTreeMap::new();
    for (key, frame) in frames {
        payloads.insert(key.to_owned(), crate::package::copy_bytes(frame)?);
    }
    validate_payloads(&manifest, &payloads)?;
    Ok(RetainedCurrentFieldBundle {
        manifest_bytes: crate::package::copy_bytes(manifest_bytes)?,
        manifest,
        payloads,
    })
}

fn require_package_bound(size: usize, maximum: usize) -> Result<(), ArtifactError> {
    require(
        size <= maximum && size as u64 <= MAX_PACKAGE_BYTES,
        "retained field package byte budget",
    )
}
fn require_manifest_bound(size: usize, maximum: usize) -> Result<(), ArtifactError> {
    require(
        size > 0 && size <= maximum && size as u64 <= MAX_METADATA_BYTES,
        "retained field manifest byte budget",
    )
}
fn take<'a>(remaining: &mut &'a [u8], size: usize) -> Result<&'a [u8], ArtifactError> {
    require(
        size <= remaining.len(),
        "retained field package is truncated",
    )?;
    let (value, rest) = (*remaining).split_at(size);
    *remaining = rest;
    Ok(value)
}
fn length(remaining: &mut &[u8]) -> Result<usize, ArtifactError> {
    let bytes: [u8; 8] = take(remaining, 8)?.try_into().map_err(|_| ArtifactError {
        message: "retained field package length truncated".into(),
    })?;
    usize::try_from(u64::from_le_bytes(bytes)).map_err(|_| ArtifactError {
        message: "retained field package length is not representable".into(),
    })
}
