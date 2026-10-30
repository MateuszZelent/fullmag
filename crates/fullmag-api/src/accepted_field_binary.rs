//! Read-only access to accepted field payloads stored as verified CAS chunks.

use crate::error::ApiError;
use fullmag_session::store::SessionStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::PathBuf;

pub(crate) const ACCEPTED_FIELD_BINARY_SCHEMA: &str = "fullmag.accepted_field.f64le.v1";
const MAX_VALUES_PER_CHUNK: usize = 65_536;
const BYTES_PER_VALUE: usize = std::mem::size_of::<f64>();
/// Decoded, digest-verified field values kept for repeated reads (field vector,
/// meta, slices of one accepted field). Keyed by the verified values digest,
/// so an entry is immutable and independent of the store that served it.
const DECODED_FIELD_CACHE_BYTES: usize = 256 * 1024 * 1024;

struct DecodedFieldCache {
    entries: std::collections::HashMap<String, std::sync::Arc<[f64]>>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}

static DECODED_FIELD_CACHE: std::sync::Mutex<Option<DecodedFieldCache>> =
    std::sync::Mutex::new(None);

fn cached_decoded_values(reference: &BinaryFieldRef) -> Option<Vec<f64>> {
    let cache = DECODED_FIELD_CACHE.lock().ok()?;
    let values = cache.as_ref()?.entries.get(&reference.values_sha256)?;
    (values.len() == reference.value_count).then(|| values.to_vec())
}

fn remember_decoded_values(reference: &BinaryFieldRef, values: &[f64]) {
    let bytes = values.len().saturating_mul(BYTES_PER_VALUE);
    if bytes > DECODED_FIELD_CACHE_BYTES / 2 {
        return;
    }
    let Ok(mut guard) = DECODED_FIELD_CACHE.lock() else {
        return;
    };
    let cache = guard.get_or_insert_with(|| DecodedFieldCache {
        entries: std::collections::HashMap::new(),
        order: std::collections::VecDeque::new(),
        bytes: 0,
    });
    if cache.entries.contains_key(&reference.values_sha256) {
        return;
    }
    while cache.bytes + bytes > DECODED_FIELD_CACHE_BYTES {
        let Some(oldest) = cache.order.pop_front() else {
            break;
        };
        if let Some(evicted) = cache.entries.remove(&oldest) {
            cache.bytes -= evicted.len() * BYTES_PER_VALUE;
        }
    }
    cache
        .entries
        .insert(reference.values_sha256.clone(), std::sync::Arc::from(values));
    cache.order.push_back(reference.values_sha256.clone());
    cache.bytes += bytes;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BinaryFieldRef {
    pub(crate) schema_version: String,
    pub(crate) value_count: usize,
    pub(crate) values_sha256: String,
    pub(crate) max_read_bytes: u64,
    pub(crate) chunks: Vec<BinaryFieldChunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BinaryFieldChunk {
    pub(crate) object_ref: String,
    pub(crate) value_offset: usize,
    pub(crate) value_count: usize,
}

impl BinaryFieldRef {
    pub(crate) fn validate(&self) -> Result<(), ApiError> {
        if self.schema_version != ACCEPTED_FIELD_BINARY_SCHEMA {
            return Err(ApiError::conflict(
                "accepted field binary schema version is unsupported",
            ));
        }
        if self.value_count == 0 || self.chunks.is_empty() {
            return Err(ApiError::conflict(
                "accepted field binary reference must contain values and chunks",
            ));
        }
        validate_raw_sha256(&self.values_sha256)?;

        let expected_bytes = self
            .value_count
            .checked_mul(BYTES_PER_VALUE)
            .ok_or_else(|| ApiError::conflict("accepted field value byte count overflowed"))?;
        let expected_bytes_u64 = u64::try_from(expected_bytes)
            .map_err(|_| ApiError::conflict("accepted field value byte count exceeds u64"))?;
        if expected_bytes_u64 > self.max_read_bytes || self.max_read_bytes == 0 {
            return Err(ApiError::conflict(
                "accepted field value bytes exceed the verified read budget",
            ));
        }

        let mut next_offset = 0usize;
        for chunk in &self.chunks {
            validate_raw_sha256(&chunk.object_ref)?;
            if chunk.value_count == 0 || chunk.value_count > MAX_VALUES_PER_CHUNK {
                return Err(ApiError::conflict(
                    "accepted field chunk has an invalid value count",
                ));
            }
            if chunk.value_offset != next_offset {
                return Err(ApiError::conflict(
                    "accepted field chunks are not contiguous",
                ));
            }
            next_offset = next_offset
                .checked_add(chunk.value_count)
                .ok_or_else(|| ApiError::conflict("accepted field chunk offsets overflowed"))?;
        }
        if next_offset != self.value_count {
            return Err(ApiError::conflict(
                "accepted field chunks do not cover the declared values",
            ));
        }
        Ok(())
    }
}

pub(crate) struct AcceptedFieldReader {
    store: SessionStore,
    reference: BinaryFieldRef,
}

impl fmt::Debug for AcceptedFieldReader {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AcceptedFieldReader")
            .field("reference", &self.reference)
            .finish_non_exhaustive()
    }
}

impl AcceptedFieldReader {
    /// Open an existing session CAS using a trusted store root. The root is
    /// never read from the serialized field reference.
    pub(crate) fn new(
        store_root: PathBuf,
        reference: BinaryFieldRef,
    ) -> Result<Self, ApiError> {
        reference.validate()?;
        let store = SessionStore::open_existing(store_root).map_err(|error| {
            ApiError::internal(format!("opening accepted field CAS store: {error:#}"))
        })?;
        Ok(Self { store, reference })
    }

    pub(crate) fn reference(&self) -> &BinaryFieldRef {
        &self.reference
    }

    /// Read exactly one selected field, verifying each CAS object, canonical
    /// little-endian finite f64 values, and the digest of the complete stream.
    pub(crate) fn read_values(&self) -> Result<Vec<f64>, ApiError> {
        self.read_referenced_values(&self.reference)
    }

    /// Target-only fields share this trusted store owner, while retaining
    /// their own validated descriptor and chunk identities.
    pub(crate) fn read_referenced_values(&self, reference: &BinaryFieldRef) -> Result<Vec<f64>, ApiError> {
        reference.validate()?;
        if let Some(values) = cached_decoded_values(reference) {
            return Ok(values);
        }
        let mut values = Vec::with_capacity(reference.value_count);
        let mut hasher = Sha256::new();
        for chunk in &reference.chunks {
            let chunk_bytes = chunk
                .value_count
                .checked_mul(BYTES_PER_VALUE)
                .ok_or_else(|| ApiError::conflict("accepted field chunk byte count overflowed"))?;
            let chunk_budget = u64::try_from(chunk_bytes)
                .map_err(|_| ApiError::conflict("accepted field chunk exceeds u64"))?;
            let bytes = self
                .store
                .cas()
                .get_bounded(&chunk.object_ref, chunk_budget)
                .map_err(|error| {
                    ApiError::internal(format!(
                        "reading accepted field CAS chunk {}: {error:#}",
                        chunk.object_ref
                    ))
                })?
                .ok_or_else(|| {
                    ApiError::internal(format!(
                        "accepted field CAS chunk {} is missing",
                        chunk.object_ref
                    ))
                })?;
            if bytes.len() != chunk_bytes {
                return Err(ApiError::conflict(format!(
                    "accepted field CAS chunk {} has an unexpected byte length",
                    chunk.object_ref
                )));
            }
            hasher.update(&bytes);
            for value_bytes in bytes.chunks_exact(BYTES_PER_VALUE) {
                let value = f64::from_le_bytes(value_bytes.try_into().map_err(|_| {
                    ApiError::conflict("accepted field chunk contains an incomplete f64")
                })?);
                if !value.is_finite() {
                    return Err(ApiError::conflict(
                        "accepted field chunk contains a non-finite f64",
                    ));
                }
                values.push(value);
            }
        }
        if values.len() != reference.value_count {
            return Err(ApiError::conflict(
                "accepted field chunks returned an unexpected number of values",
            ));
        }
        let digest = hasher.finalize();
        if sha256_hex(&digest) != reference.values_sha256 {
            return Err(ApiError::conflict(
                "accepted field values do not match their declared SHA-256 digest",
            ));
        }
        remember_decoded_values(reference, &values);
        Ok(values)
    }

    /// Read another bounded accepted artifact through this already trusted
    /// store handle. Callers supply the byte budget from the verified owner.
    pub(crate) fn read_artifact_bytes(
        &self,
        object_ref: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>, ApiError> {
        validate_raw_sha256(object_ref)?;
        if max_bytes == 0 {
            return Err(ApiError::conflict(
                "accepted artifact read budget must be positive",
            ));
        }
        self.store
            .cas()
            .get_bounded(object_ref, max_bytes)
            .map_err(|error| {
                ApiError::internal(format!(
                    "reading accepted artifact CAS object {object_ref}: {error:#}"
                ))
            })?
            .ok_or_else(|| {
                ApiError::internal(format!(
                    "accepted artifact CAS object {object_ref} is missing"
                ))
            })
    }
}

pub(crate) fn binary_field_ref_from_metadata(
    raw: &serde_json::Value,
) -> Option<BinaryFieldRef> {
    let reference: BinaryFieldRef = serde_json::from_value(raw.get("accepted_binary_field")?.clone()).ok()?;
    reference.validate().ok()?;
    Some(reference)
}

fn validate_raw_sha256(value: &str) -> Result<(), ApiError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ApiError::conflict(
            "accepted field reference contains an invalid SHA-256 object reference",
        ));
    }
    Ok(())
}

fn sha256_hex(digest: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let byte = *byte;
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
