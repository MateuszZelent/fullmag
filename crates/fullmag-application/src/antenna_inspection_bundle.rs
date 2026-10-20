//! Bounded transport framing; physical verification remains with the runner.
use crate::execution::ExecutionError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const ANTENNA_INSPECTION_BUNDLE_CODEC_ID: &str = "fullmag.antenna.closed_loop_bundle";
pub const ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION: &str = "v1";
pub const ANTENNA_INSPECTION_BUNDLE_MAX_BYTES: usize = 512 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"FMACLB01";
const MANIFEST_MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_PAYLOADS: usize = 256;
const MAX_PATH_BYTES: usize = 1024;

/// Exact retained manifest and payload bytes. Framing validation is not qualification.
#[derive(Clone, Debug, PartialEq)]
pub struct AntennaInspectionBundle {
    pub manifest_bytes: Vec<u8>,
    pub payloads: BTreeMap<String, Vec<u8>>,
}

fn invalid(reason: &str) -> ExecutionError {
    ExecutionError::Invalid(format!("antenna inspection bundle v1: {reason}"))
}

fn checked_size(value: u64) -> Result<usize, ExecutionError> {
    usize::try_from(value).map_err(|_| invalid("length does not fit address space"))
}

fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && path.is_ascii()
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Borrowed closure table: bound manifest before JSON parsing or payload allocation.
fn closure(manifest_bytes: &[u8]) -> Result<BTreeMap<String, (usize, String)>, ExecutionError> {
    if manifest_bytes.is_empty() || manifest_bytes.len() > MANIFEST_MAX_BYTES {
        return Err(invalid("manifest bound"));
    }
    let manifest: Value =
        serde_json::from_slice(manifest_bytes).map_err(|_| invalid("invalid manifest JSON"))?;
    if manifest["schema_version"] != "antenna_field_solution.v2"
        || manifest["status"] != "inspection_only"
    {
        return Err(invalid("unsupported manifest family or status"));
    }
    let output = manifest["solution_id"]
        .as_str()
        .ok_or_else(|| invalid("solution identity"))?;
    if !safe_path(output) || output.contains('/') || output.contains("..") || output.len() > 255 {
        return Err(invalid("solution identity"));
    }
    let fields = manifest["payloads"]
        .as_object()
        .ok_or_else(|| invalid("payload closure"))?;
    if fields.is_empty() || fields.len() > MAX_PAYLOADS {
        return Err(invalid("payload count"));
    }
    let mut result = BTreeMap::new();
    let mut portable_paths = BTreeSet::new();
    for (name, field) in fields {
        if !safe_path(name) || name.contains('/') {
            return Err(invalid("payload name"));
        }
        let path = field["path"]
            .as_str()
            .ok_or_else(|| invalid("payload path"))?;
        if !safe_path(path) || path != format!("antenna/field_solutions/{output}/{name}.bin") {
            return Err(invalid("unsafe or noncanonical payload path"));
        }
        let length = checked_size(
            field["byte_length"]
                .as_u64()
                .ok_or_else(|| invalid("payload length"))?,
        )?;
        let hash = field["sha256"]
            .as_str()
            .ok_or_else(|| invalid("payload digest"))?;
        if length == 0
            || length > ANTENNA_INSPECTION_BUNDLE_MAX_BYTES
            || hash.len() != 64
            || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || !portable_paths.insert(path.to_ascii_lowercase())
            || result
                .insert(path.to_owned(), (length, hash.to_owned()))
                .is_some()
        {
            return Err(invalid("payload length, digest or collision"));
        }
    }
    Ok(result)
}

fn bound(max_bytes: usize) -> usize {
    max_bytes.min(ANTENNA_INSPECTION_BUNDLE_MAX_BYTES)
}

/// One deterministic CAS object; no archive extraction, links or filesystem lookup.
pub fn encode_antenna_inspection_bundle(
    manifest_bytes: &[u8],
    payloads: &BTreeMap<String, Vec<u8>>,
    max_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    if manifest_bytes
        .len()
        .checked_add(20)
        .map_or(true, |n| n > bound(max_bytes))
    {
        return Err(invalid("bundle budget"));
    }
    let expected = closure(manifest_bytes)?;
    if expected.len() != payloads.len() {
        return Err(invalid("payload closure mismatch"));
    }
    let mut size = 20usize
        .checked_add(manifest_bytes.len())
        .ok_or_else(|| invalid("size overflow"))?;
    for (path, bytes) in payloads {
        let (length, hash) = expected
            .get(path)
            .ok_or_else(|| invalid("unexpected payload"))?;
        if bytes.len() != *length || digest(bytes) != *hash {
            return Err(invalid("payload length or digest mismatch"));
        }
        size = size
            .checked_add(10)
            .and_then(|n| n.checked_add(path.len()))
            .and_then(|n| n.checked_add(bytes.len()))
            .ok_or_else(|| invalid("size overflow"))?;
        if size > bound(max_bytes) {
            return Err(invalid("bundle budget"));
        }
    }
    if size > bound(max_bytes) {
        return Err(invalid("bundle budget"));
    }
    let mut result = Vec::new();
    result
        .try_reserve_exact(size)
        .map_err(|_| invalid("encode allocation"))?;
    result.extend_from_slice(MAGIC);
    result.extend_from_slice(&(manifest_bytes.len() as u64).to_le_bytes());
    result.extend_from_slice(&(payloads.len() as u32).to_le_bytes());
    result.extend_from_slice(manifest_bytes);
    for (path, bytes) in payloads {
        result.extend_from_slice(&(path.len() as u16).to_le_bytes());
        result.extend_from_slice(path.as_bytes());
        result.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        result.extend_from_slice(bytes);
    }
    Ok(result)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], ExecutionError> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or_else(|| invalid("offset overflow"))?;
        let result = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid("truncated frame"))?;
        self.offset = end;
        Ok(result)
    }
    fn u64(&mut self) -> Result<u64, ExecutionError> {
        Ok(u64::from_le_bytes(
            self.take(8)?.try_into().map_err(|_| invalid("u64 frame"))?,
        ))
    }
}

fn owned(bytes: &[u8]) -> Result<Vec<u8>, ExecutionError> {
    let mut result = Vec::new();
    result
        .try_reserve_exact(bytes.len())
        .map_err(|_| invalid("decode allocation"))?;
    result.extend_from_slice(bytes);
    Ok(result)
}

/// Validate the complete borrowed frame before allocating owned numerical payloads.
/// The worker must also run the runner's exact neutral verifier before any publication.
pub fn decode_antenna_inspection_bundle(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<AntennaInspectionBundle, ExecutionError> {
    if bytes.len() > bound(max_bytes) {
        return Err(invalid("bundle budget"));
    }
    let mut cursor = Cursor { bytes, offset: 0 };
    if cursor.take(8)? != MAGIC {
        return Err(invalid("magic or version"));
    }
    let manifest_length = checked_size(cursor.u64()?)?;
    if manifest_length == 0 || manifest_length > MANIFEST_MAX_BYTES {
        return Err(invalid("manifest bound"));
    }
    let count = u32::from_le_bytes(
        cursor
            .take(4)?
            .try_into()
            .map_err(|_| invalid("count frame"))?,
    ) as usize;
    if count == 0 || count > MAX_PAYLOADS {
        return Err(invalid("payload count"));
    }
    let manifest_bytes = cursor.take(manifest_length)?;
    let expected = closure(manifest_bytes)?;
    if count != expected.len() {
        return Err(invalid("payload closure mismatch"));
    }
    let mut slices = BTreeMap::new();
    let mut previous: Option<&str> = None;
    for _ in 0..count {
        let path_length = u16::from_le_bytes(
            cursor
                .take(2)?
                .try_into()
                .map_err(|_| invalid("path frame"))?,
        ) as usize;
        if path_length == 0 || path_length > MAX_PATH_BYTES {
            return Err(invalid("path bound"));
        }
        let path =
            std::str::from_utf8(cursor.take(path_length)?).map_err(|_| invalid("path encoding"))?;
        if !safe_path(path) || previous.is_some_and(|p| p >= path) {
            return Err(invalid("unsafe, unordered or duplicate path"));
        }
        let length = checked_size(cursor.u64()?)?;
        let (expected_length, expected_hash) = expected
            .get(path)
            .ok_or_else(|| invalid("unexpected payload"))?;
        if length != *expected_length {
            return Err(invalid("payload length mismatch"));
        }
        let payload = cursor.take(length)?;
        if digest(payload) != *expected_hash {
            return Err(invalid("payload digest mismatch"));
        }
        slices.insert(path, payload);
        previous = Some(path);
    }
    if cursor.offset != bytes.len() {
        return Err(invalid("trailing bytes"));
    }
    let mut payloads = BTreeMap::new();
    for (path, payload) in slices {
        payloads.insert(path.to_owned(), owned(payload)?);
    }
    Ok(AntennaInspectionBundle {
        manifest_bytes: owned(manifest_bytes)?,
        payloads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A framing fixture only: it intentionally does not satisfy the physical verifier.
    fn fixture() -> (Vec<u8>, BTreeMap<String, Vec<u8>>) {
        let mut payloads: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        payloads.insert("antenna/field_solutions/output/a.bin".into(), vec![1, 2, 3]);
        payloads.insert("antenna/field_solutions/output/b.bin".into(), vec![4, 5]);
        let refs: BTreeMap<_, _> = payloads
            .iter()
            .map(|(path, bytes)| {
                let name = path
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .strip_suffix(".bin")
                    .unwrap();
                (
                    name,
                    json!({"path": path, "byte_length": bytes.len(), "sha256": digest(bytes)}),
                )
            })
            .collect();
        (serde_json::to_vec(&json!({"schema_version":"antenna_field_solution.v2", "status":"inspection_only", "solution_id":"output", "payloads":refs})).unwrap(), payloads)
    }

    #[test]
    fn deterministic_roundtrip_preserves_exact_manifest_and_payload_bytes() {
        let (manifest, payloads) = fixture();
        let bytes = encode_antenna_inspection_bundle(&manifest, &payloads, 4096).unwrap();
        assert_eq!(
            bytes,
            encode_antenna_inspection_bundle(&manifest, &payloads, bytes.len()).unwrap()
        );
        assert_eq!(
            decode_antenna_inspection_bundle(&bytes, bytes.len()).unwrap(),
            AntennaInspectionBundle {
                manifest_bytes: manifest,
                payloads
            }
        );
    }

    #[test]
    fn every_truncation_and_trailing_byte_are_rejected() {
        let (manifest, payloads) = fixture();
        let bytes = encode_antenna_inspection_bundle(&manifest, &payloads, 4096).unwrap();
        for length in 0..bytes.len() {
            assert!(decode_antenna_inspection_bundle(&bytes[..length], 4096).is_err());
        }
        let mut extra = bytes;
        extra.push(0);
        assert!(decode_antenna_inspection_bundle(&extra, 4096).is_err());
    }

    #[test]
    fn invalid_lengths_count_magic_and_budget_fail_closed() {
        let (manifest, payloads) = fixture();
        let bytes = encode_antenna_inspection_bundle(&manifest, &payloads, 4096).unwrap();
        assert!(encode_antenna_inspection_bundle(&manifest, &payloads, bytes.len() - 1).is_err());
        assert!(decode_antenna_inspection_bundle(&bytes, bytes.len() - 1).is_err());
        for (start, replacement) in [
            (0, vec![0; 8]),
            (8, u64::MAX.to_le_bytes().to_vec()),
            (16, u32::MAX.to_le_bytes().to_vec()),
        ] {
            let mut changed = bytes.clone();
            changed[start..start + replacement.len()].copy_from_slice(&replacement);
            assert!(decode_antenna_inspection_bundle(&changed, 4096).is_err());
        }
    }

    #[test]
    fn unsafe_manifest_paths_and_portable_collisions_are_rejected() {
        let (manifest, payloads) = fixture();
        for path in ["../a", "/a", "a\\b", "C:/a", "a//b", "a/./b", "a/../b"] {
            let mut value: Value = serde_json::from_slice(&manifest).unwrap();
            value["payloads"]["a"]["path"] = json!(path);
            assert!(encode_antenna_inspection_bundle(
                &serde_json::to_vec(&value).unwrap(),
                &payloads,
                4096
            )
            .is_err());
        }
        let mut value: Value = serde_json::from_slice(&manifest).unwrap();
        value["payloads"]["A"] = value["payloads"]["a"].clone();
        value["payloads"]["A"]["path"] = json!("antenna/field_solutions/output/A.bin");
        assert!(closure(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn duplicate_frame_path_and_unexpected_payload_are_rejected() {
        let (manifest, mut payloads) = fixture();
        let mut bytes = encode_antenna_inspection_bundle(&manifest, &payloads, 4096).unwrap();
        let first = 20 + manifest.len();
        let first_path = payloads.keys().next().unwrap();
        let second = first + 10 + first_path.len() + 3;
        bytes[second + 2..second + 2 + first_path.len()].copy_from_slice(first_path.as_bytes());
        assert!(decode_antenna_inspection_bundle(&bytes, 4096).is_err());
        payloads.insert("antenna/field_solutions/output/extra.bin".into(), vec![9]);
        assert!(encode_antenna_inspection_bundle(&manifest, &payloads, 4096).is_err());
    }

    #[test]
    fn malicious_payload_length_and_frame_path_are_rejected_before_owned_decode() {
        let (manifest, payloads) = fixture();
        let bytes = encode_antenna_inspection_bundle(&manifest, &payloads, 4096).unwrap();
        let first = 20 + manifest.len();
        let path_length = payloads.keys().next().unwrap().len();
        let mut huge = bytes.clone();
        huge[first + 2 + path_length..first + 10 + path_length]
            .copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(decode_antenna_inspection_bundle(&huge, 4096).is_err());
        let mut unsafe_path = bytes;
        unsafe_path[first + 2] = b'\\';
        assert!(decode_antenna_inspection_bundle(&unsafe_path, 4096).is_err());
    }

    #[test]
    fn changed_payload_digest_or_family_are_rejected() {
        let (manifest, mut payloads) = fixture();
        let mut bytes = encode_antenna_inspection_bundle(&manifest, &payloads, 4096).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        assert!(decode_antenna_inspection_bundle(&bytes, 4096).is_err());
        payloads.values_mut().next().unwrap()[0] ^= 1;
        assert!(encode_antenna_inspection_bundle(&manifest, &payloads, 4096).is_err());
        let mut value: Value = serde_json::from_slice(&manifest).unwrap();
        value["schema_version"] = json!("antenna_field_solution.v1");
        assert!(closure(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}
