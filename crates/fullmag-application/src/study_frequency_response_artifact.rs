//! Bounded, immutable transport for accepted driven-response outputs.
//!
//! This framing proves the retained byte closure and identity. Native operator
//! validation and device qualification remain the producer's responsibility.

use crate::execution::ExecutionError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const FREQUENCY_RESPONSE_INDEX_CODEC_ID: &str = "fullmag.fem.driven_response_index";
pub const FREQUENCY_RESPONSE_POINT_CODEC_ID: &str = "fullmag.fem.driven_response_point";
pub const FREQUENCY_RESPONSE_CODEC_VERSION: &str = "v1";
pub const FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES: usize = 256 * 1024 * 1024;
pub const FREQUENCY_RESPONSE_MANIFEST_MAX_BYTES: usize = 1024 * 1024;
const MAGIC: &[u8; 8] = b"FMFRB001";
const HEADER_BYTES: usize = 20;
const MAX_PAYLOADS: usize = 256;
const MAX_PATH_BYTES: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyResponseBundleIdentity {
    pub session_id: String,
    pub run_id: String,
    pub task_id: String,
    pub stage_id: String,
    pub scope_id: String,
    pub runtime_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub case_id: String,
    pub plan_fingerprint: String,
    pub topology_fingerprint: String,
    pub equilibrium_sha256: String,
    pub equilibrium_verified: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyResponsePointMetadata {
    pub index: u64,
    pub frequency_hz: f64,
    pub port_id: String,
    pub converged: bool,
    pub relative_residual_l2: f64,
    pub solver_relative_tolerance: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyResponsePointReference {
    pub index: u64,
    pub frequency_hz: f64,
    pub port_id: String,
    pub bundle_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyResponsePayloadReference {
    pub byte_length: u64,
    pub sha256: String,
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyResponseBundleManifest {
    pub schema_version: String,
    pub status: String,
    pub study_product: String,
    pub identity: FrequencyResponseBundleIdentity,
    pub frequency_count: u64,
    pub payloads: BTreeMap<String, FrequencyResponsePayloadReference>,
    pub native_metadata: Value,
    pub point: Option<FrequencyResponsePointMetadata>,
    pub points: Vec<FrequencyResponsePointReference>,
}

/// Exact framing bytes and decoded bounded metadata; no filesystem lookup.
#[derive(Clone, Debug, PartialEq)]
pub struct FrequencyResponseBundle {
    manifest_bytes: Vec<u8>,
    manifest: FrequencyResponseBundleManifest,
    payloads: BTreeMap<String, Vec<u8>>,
    content_sha256: String,
    byte_length: usize,
}
impl FrequencyResponseBundle {
    pub fn manifest_bytes(&self) -> &[u8] {
        &self.manifest_bytes
    }
    pub fn manifest(&self) -> &FrequencyResponseBundleManifest {
        &self.manifest
    }
    pub fn payloads(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.payloads
    }
    pub fn content_sha256(&self) -> &str {
        &self.content_sha256
    }
    pub fn byte_length(&self) -> usize {
        self.byte_length
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BundleKind {
    Index,
    Point,
}
impl BundleKind {
    fn schema(self) -> &'static str {
        match self {
            Self::Index => "fullmag.fem.driven_response_index.v1",
            Self::Point => "fullmag.fem.driven_response_point.v1",
        }
    }
}
fn invalid(reason: impl std::fmt::Display) -> ExecutionError {
    ExecutionError::Invalid(format!("FEM driven-response bundle v1: {reason}"))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
fn fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(sha256)
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-:@".contains(&b))
        && !matches!(
            value,
            "current" | "run:current" | "runtime:not_provided" | "native-validation"
        )
}
fn safe_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PATH_BYTES
        && value.is_ascii()
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        })
}
/// Reserve an exact, portable output-tree member, including file/directory conflicts.
fn reserve_output_path(paths: &mut BTreeSet<String>, path: &str) -> Result<(), ExecutionError> {
    if !safe_path(path) {
        return Err(invalid("unsafe payload destination"));
    }
    let folded = path.to_ascii_lowercase();
    if paths.contains(&folded) {
        return Err(invalid("duplicate payload destination"));
    }
    let mut ancestor = folded.as_str();
    while let Some((parent, _)) = ancestor.rsplit_once('/') {
        if paths.contains(parent) {
            return Err(invalid("payload destination descends from a file"));
        }
        ancestor = parent;
    }
    let prefix = format!("{folded}/");
    if paths
        .range(prefix.clone()..)
        .next()
        .is_some_and(|candidate| candidate.starts_with(&prefix))
    {
        return Err(invalid(
            "payload destination would replace an existing directory",
        ));
    }
    paths.insert(folded);
    Ok(())
}
fn port(index: u64) -> String {
    format!("response-frequency-{index:06}")
}
fn frequency(value: f64) -> bool {
    value.is_finite() && value > 0.0
}
fn validate_identity(value: &FrequencyResponseBundleIdentity) -> Result<(), ExecutionError> {
    if [
        &value.session_id,
        &value.run_id,
        &value.task_id,
        &value.stage_id,
        &value.scope_id,
        &value.runtime_id,
        &value.attempt_id,
        &value.case_id,
    ]
    .iter()
    .any(|id| !safe_id(id))
        || value.ownership_epoch == 0
        || !fingerprint(&value.plan_fingerprint)
        || !fingerprint(&value.topology_fingerprint)
        || !sha256(&value.equilibrium_sha256)
    {
        return Err(invalid("invalid exact owner/input identity"));
    }
    Ok(())
}
fn parse_manifest(
    bytes: &[u8],
    kind: BundleKind,
) -> Result<FrequencyResponseBundleManifest, ExecutionError> {
    if bytes.is_empty() || bytes.len() > FREQUENCY_RESPONSE_MANIFEST_MAX_BYTES {
        return Err(invalid("manifest byte bound"));
    }
    let fullmag_antenna_artifacts::artifact_json::UnambiguousJson(_) =
        serde_json::from_slice(bytes)
            .map_err(|e| invalid(format!("ambiguous manifest JSON: {e}")))?;
    let m: FrequencyResponseBundleManifest =
        serde_json::from_slice(bytes).map_err(|e| invalid(format!("manifest schema: {e}")))?;
    if m.schema_version != kind.schema()
        || m.status != "complete"
        || m.study_product != "driven_response"
        || !m.native_metadata.is_object()
        || m.frequency_count == 0
    {
        return Err(invalid(
            "unsupported schema, product, completeness or frequency count",
        ));
    }
    validate_identity(&m.identity)?;
    if m.payloads.is_empty() || m.payloads.len() > MAX_PAYLOADS {
        return Err(invalid("payload count bound"));
    }
    let mut paths = BTreeSet::new();
    for (path, entry) in &m.payloads {
        reserve_output_path(&mut paths, path)?;
        if !sha256(&entry.sha256)
            || entry.byte_length == 0
            || entry.byte_length > FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES as u64
            || !matches!(
                entry.role.as_str(),
                "native_metadata"
                    | "field_metadata"
                    | "field_values"
                    | "input_asset"
                    | "table"
                    | "diagnostics"
            )
        {
            return Err(invalid(
                "payload path, role, length, digest or case collision",
            ));
        }
    }
    match kind {
        BundleKind::Index => {
            if m.point.is_some() || u64::try_from(m.points.len()).ok() != Some(m.frequency_count) {
                return Err(invalid("index frequency closure"));
            }
            for (index, point) in m.points.iter().enumerate() {
                if point.index != index as u64
                    || point.port_id != port(point.index)
                    || !frequency(point.frequency_hz)
                    || !sha256(&point.bundle_sha256)
                {
                    return Err(invalid("index point order, port, frequency or digest"));
                }
            }
        }
        BundleKind::Point => {
            let point = m
                .point
                .as_ref()
                .ok_or_else(|| invalid("missing point metadata"))?;
            if !m.points.is_empty()
                || point.index >= m.frequency_count
                || point.port_id != port(point.index)
                || !frequency(point.frequency_hz)
                || !point.converged
                || !point.relative_residual_l2.is_finite()
                || point.relative_residual_l2 < 0.0
                || !point.solver_relative_tolerance.is_finite()
                || point.solver_relative_tolerance <= 0.0
                || point.solver_relative_tolerance > 1.0
                || point.relative_residual_l2 > point.solver_relative_tolerance
            {
                return Err(invalid(
                    "incomplete, nonconverged or inconsistent response point",
                ));
            }
        }
    }
    Ok(m)
}
fn bounded(max_bytes: usize) -> usize {
    max_bytes.min(FREQUENCY_RESPONSE_BUNDLE_MAX_BYTES)
}
fn encode(
    kind: BundleKind,
    manifest_bytes: &[u8],
    payloads: &BTreeMap<String, Vec<u8>>,
    max_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    let m = parse_manifest(manifest_bytes, kind)?;
    if m.payloads.len() != payloads.len() {
        return Err(invalid("payload closure mismatch"));
    }
    let mut size = HEADER_BYTES
        .checked_add(manifest_bytes.len())
        .ok_or_else(|| invalid("size overflow"))?;
    for (path, bytes) in payloads {
        let expected = m
            .payloads
            .get(path)
            .ok_or_else(|| invalid("unexpected payload"))?;
        if u64::try_from(bytes.len()).ok() != Some(expected.byte_length)
            || digest(bytes) != expected.sha256
        {
            return Err(invalid("payload length or SHA256 mismatch"));
        }
        size = size
            .checked_add(10)
            .and_then(|n| n.checked_add(path.len()))
            .and_then(|n| n.checked_add(bytes.len()))
            .ok_or_else(|| invalid("size overflow"))?;
        if size > bounded(max_bytes) {
            return Err(invalid("bundle byte budget"));
        }
    }
    if size > bounded(max_bytes) {
        return Err(invalid("bundle byte budget"));
    }
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|_| invalid("bundle allocation failed"))?;
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(manifest_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&(payloads.len() as u32).to_le_bytes());
    out.extend_from_slice(manifest_bytes);
    for (path, bytes) in payloads {
        out.extend_from_slice(&(path.len() as u16).to_le_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], ExecutionError> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| invalid("framing length overflow"))?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| invalid("truncated framing"))?;
        self.position = end;
        Ok(value)
    }
    fn length(&mut self) -> Result<usize, ExecutionError> {
        let raw: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| invalid("invalid length"))?;
        usize::try_from(u64::from_le_bytes(raw))
            .map_err(|_| invalid("length exceeds address space"))
    }
}
fn decode(
    kind: BundleKind,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<FrequencyResponseBundle, ExecutionError> {
    if bytes.len() < HEADER_BYTES || bytes.len() > bounded(max_bytes) {
        return Err(invalid("bundle byte budget or header"));
    }
    let mut reader = Reader { bytes, position: 0 };
    if reader.take(8)? != MAGIC {
        return Err(invalid("framing magic"));
    }
    let manifest_len = reader.length()?;
    if manifest_len == 0 || manifest_len > FREQUENCY_RESPONSE_MANIFEST_MAX_BYTES {
        return Err(invalid("manifest byte bound"));
    }
    let raw: [u8; 4] = reader
        .take(4)?
        .try_into()
        .map_err(|_| invalid("payload count"))?;
    let count = u32::from_le_bytes(raw) as usize;
    if count == 0 || count > MAX_PAYLOADS {
        return Err(invalid("payload count bound"));
    }
    let manifest_bytes = reader.take(manifest_len)?;
    let manifest = parse_manifest(manifest_bytes, kind)?;
    if manifest.payloads.len() != count {
        return Err(invalid("payload closure mismatch"));
    }
    let mut payloads = BTreeMap::new();
    for (expected_path, expected) in &manifest.payloads {
        let raw: [u8; 2] = reader
            .take(2)?
            .try_into()
            .map_err(|_| invalid("path length"))?;
        let path_len = u16::from_le_bytes(raw) as usize;
        if path_len == 0 || path_len > MAX_PATH_BYTES {
            return Err(invalid("path byte bound"));
        }
        let path =
            std::str::from_utf8(reader.take(path_len)?).map_err(|_| invalid("path encoding"))?;
        if path != expected_path {
            return Err(invalid("payload path differs from canonical closure order"));
        }
        let length = reader.length()?;
        if u64::try_from(length).ok() != Some(expected.byte_length) {
            return Err(invalid("payload length mismatch"));
        }
        let data = reader.take(length)?;
        if digest(data) != expected.sha256 {
            return Err(invalid("payload SHA256 mismatch"));
        }
        payloads.insert(path.to_owned(), data.to_vec());
    }
    if reader.position != bytes.len() {
        return Err(invalid("trailing framing bytes"));
    }
    Ok(FrequencyResponseBundle {
        manifest_bytes: manifest_bytes.to_vec(),
        manifest,
        payloads,
        content_sha256: digest(bytes),
        byte_length: bytes.len(),
    })
}

pub fn encode_frequency_response_index_bundle(
    manifest_bytes: &[u8],
    payloads: &BTreeMap<String, Vec<u8>>,
    max_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    encode(BundleKind::Index, manifest_bytes, payloads, max_bytes)
}
pub fn encode_frequency_response_point_bundle(
    manifest_bytes: &[u8],
    payloads: &BTreeMap<String, Vec<u8>>,
    max_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    encode(BundleKind::Point, manifest_bytes, payloads, max_bytes)
}
pub fn decode_frequency_response_index_bundle(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<FrequencyResponseBundle, ExecutionError> {
    decode(BundleKind::Index, bytes, max_bytes)
}
pub fn decode_frequency_response_point_bundle(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<FrequencyResponseBundle, ExecutionError> {
    decode(BundleKind::Point, bytes, max_bytes)
}

/// Verify the entire declared sweep closure before publication or recovery.
/// Per-bundle budgets cannot substitute for this aggregate result-byte bound.
pub fn validate_frequency_response_sweep_bundles(
    index: &FrequencyResponseBundle,
    points: &[FrequencyResponseBundle],
    expected_frequencies: &[f64],
    max_total_bytes: u64,
) -> Result<(), ExecutionError> {
    if index.manifest.schema_version != BundleKind::Index.schema()
        || points.len() != expected_frequencies.len()
        || index.manifest.points.len() != points.len()
    {
        return Err(invalid("sweep point closure differs from accepted grid"));
    }
    let mut total =
        u64::try_from(index.byte_length).map_err(|_| invalid("aggregate byte overflow"))?;
    if total > max_total_bytes {
        return Err(invalid("aggregate result byte budget"));
    }
    let mut output_paths = BTreeSet::new();
    for path in index.manifest.payloads.keys() {
        reserve_output_path(&mut output_paths, path)?;
    }
    for ((reference, point), &expected_frequency) in index
        .manifest
        .points
        .iter()
        .zip(points)
        .zip(expected_frequencies)
    {
        let metadata = point
            .manifest
            .point
            .as_ref()
            .ok_or_else(|| invalid("sweep member is not a point"))?;
        if point.manifest.schema_version != BundleKind::Point.schema()
            || point.manifest.identity != index.manifest.identity
            || point.manifest.frequency_count != index.manifest.frequency_count
            || metadata.index != reference.index
            || metadata.port_id != reference.port_id
            || metadata.frequency_hz.to_bits() != expected_frequency.to_bits()
            || metadata.frequency_hz.to_bits() != reference.frequency_hz.to_bits()
            || point.content_sha256 != reference.bundle_sha256
        {
            return Err(invalid(
                "sweep member identity, grid, port or SHA256 mismatch",
            ));
        }
        for path in point.manifest.payloads.keys() {
            reserve_output_path(&mut output_paths, path)?;
        }
        total = total
            .checked_add(
                u64::try_from(point.byte_length).map_err(|_| invalid("aggregate byte overflow"))?,
            )
            .ok_or_else(|| invalid("aggregate byte overflow"))?;
        if total > max_total_bytes {
            return Err(invalid("aggregate result byte budget"));
        }
    }
    if total > max_total_bytes {
        return Err(invalid("aggregate result byte budget"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;

    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn identity() -> Value {
        json!({"session_id":"session-one","run_id":"run-one","task_id":"task-one",
               "stage_id":"frequency_response-1","scope_id":"magnetic","runtime_id":"runtime-one",
               "attempt_id":"attempt-one","ownership_epoch":1,"case_id":"default",
               "plan_fingerprint":format!("sha256:{}", "1".repeat(64)),
               "topology_fingerprint":format!("sha256:{}", "2".repeat(64)),
               "equilibrium_sha256":"3".repeat(64),"equilibrium_verified":false})
    }
    fn files() -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([(
            "response/point.zarr/0.0.0".into(),
            [1.0_f64, -0.0, f64::from_bits(1)]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect(),
        )])
    }
    fn manifest(index: Option<usize>, files: &BTreeMap<String, Vec<u8>>) -> Value {
        let payloads: serde_json::Map<String, Value> = files
            .iter()
            .map(|(path, bytes)| {
                (
                    path.clone(),
                    json!({"byte_length":bytes.len(),"sha256":hash(bytes),
                                 "role":"field_values"}),
                )
            })
            .collect();
        json!({"schema_version":if index.is_some() {"fullmag.fem.driven_response_point.v1"}
                    else {"fullmag.fem.driven_response_index.v1"},
               "status":"complete","study_product":"driven_response",
               "identity":identity(),"frequency_count":2,"payloads":payloads,
               "native_metadata":{"solver_method":"gpu_operator_host_krylov",
                                  "requested_device":"gpu"},
               "point":index.map(|i| json!({"index":i,"frequency_hz":(i+1) as f64*1e9,
                    "port_id":format!("response-frequency-{i:06}"),"converged":true,
                    "relative_residual_l2":1e-10,"solver_relative_tolerance":1e-8})),
               "points":if index.is_some() {vec![]} else {(0..2).map(|i|
                    json!({"index":i,"frequency_hz":(i+1) as f64*1e9,
                           "port_id":format!("response-frequency-{i:06}"),
                           "bundle_sha256":"4".repeat(64)})).collect::<Vec<_>>()}})
    }
    fn bytes(v: &Value) -> Vec<u8> {
        serde_json::to_vec(v).unwrap()
    }

    #[test]
    fn study_registry_accepts_only_exact_driven_response_artifact_codec_tuples() {
        let f=files();
        for (is_point,codec) in [(false,FREQUENCY_RESPONSE_INDEX_CODEC_ID),
                                (true,FREQUENCY_RESPONSE_POINT_CODEC_ID)] {
            let m=bytes(&manifest(is_point.then_some(0),&f));
            let raw=if is_point {encode_frequency_response_point_bundle(&m,&f,1_000_000)}
                    else {encode_frequency_response_index_bundle(&m,&f,1_000_000)}.unwrap();
            assert!(crate::decode_study_artifact_bytes("artifact",codec,"v1",&raw).is_ok());
            assert!(crate::decode_study_artifact_bytes("state",codec,"v1",&raw).is_err());
            assert!(crate::decode_study_artifact_bytes("artifact",codec,"v2",&raw).is_err());
            let opposite=if is_point {FREQUENCY_RESPONSE_INDEX_CODEC_ID} else {FREQUENCY_RESPONSE_POINT_CODEC_ID};
            assert!(crate::decode_study_artifact_bytes("artifact",opposite,"v1",&raw).is_err());
        }
    }

    #[test]
    fn index_and_point_roundtrip_preserve_exact_bytes_and_approximate_hybrid_provenance() {
        let f = files();
        for is_point in [false, true] {
            let m = bytes(&manifest(is_point.then_some(0), &f));
            let raw = if is_point {
                encode_frequency_response_point_bundle(&m, &f, 1_000_000)
            } else {
                encode_frequency_response_index_bundle(&m, &f, 1_000_000)
            }
            .unwrap();
            let decoded = if is_point {
                decode_frequency_response_point_bundle(&raw, 1_000_000)
            } else {
                decode_frequency_response_index_bundle(&raw, 1_000_000)
            }
            .unwrap();
            assert_eq!(decoded.manifest_bytes, m);
            assert_eq!(decoded.payloads, f);
            let j: Value = serde_json::from_slice(&decoded.manifest_bytes).unwrap();
            assert_eq!(j["identity"]["equilibrium_verified"], false);
            assert_eq!(
                j["native_metadata"]["solver_method"],
                "gpu_operator_host_krylov"
            );
        }
    }
    #[test]
    fn partial_nonconverged_and_wrong_kind_do_not_decode_as_complete_response() {
        let f = files();
        let base = manifest(Some(0), &f);
        for (pointer, value) in [
            ("/status", json!("partial")),
            ("/point/converged", json!(false)),
            ("/point/relative_residual_l2", json!(1e-3)),
            ("/identity/runtime_id", json!("runtime:not_provided")),
            ("/identity/run_id", json!("run:current")),
            ("/identity/ownership_epoch", json!(0)),
        ] {
            let mut m = base.clone();
            *m.pointer_mut(pointer).unwrap() = value;
            assert!(
                encode_frequency_response_point_bundle(&bytes(&m), &f, 1_000_000).is_err(),
                "{pointer}"
            );
        }
        let raw = encode_frequency_response_point_bundle(&bytes(&base), &f, 1_000_000).unwrap();
        assert!(decode_frequency_response_index_bundle(&raw, 1_000_000).is_err());
    }
    #[test]
    fn unsafe_and_case_colliding_payload_paths_are_rejected() {
        for path in ["../outside", "/absolute", "a//b", "a/./b", "a/../b", "a\\b"] {
            let f = BTreeMap::from([(path.into(), vec![1])]);
            let m = manifest(Some(0), &f);
            assert!(
                encode_frequency_response_point_bundle(&bytes(&m), &f, 1_000_000).is_err(),
                "{path}"
            );
        }
        let f = BTreeMap::from([
            ("field/X.bin".into(), vec![1]),
            ("field/x.bin".into(), vec![2]),
        ]);
        assert!(encode_frequency_response_point_bundle(
            &bytes(&manifest(Some(0), &f)),
            &f,
            1_000_000
        )
        .is_err());
    }
    #[test]
    fn corruption_truncation_oversized_lengths_and_extra_files_fail_closed() {
        let f = files();
        let m = manifest(Some(0), &f);
        let raw = encode_frequency_response_point_bundle(&bytes(&m), &f, 1_000_000).unwrap();
        for cut in [0, 7, 19, raw.len() - 1] {
            assert!(decode_frequency_response_point_bundle(&raw[..cut], 1_000_000).is_err());
        }
        let mut corrupt = raw.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(decode_frequency_response_point_bundle(&corrupt, 1_000_000).is_err());
        let mut forged = raw.clone();
        forged[8..16].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(decode_frequency_response_point_bundle(&forged, 1_000_000).is_err());
        let mut extra = raw.clone();
        extra.push(0);
        assert!(decode_frequency_response_point_bundle(&extra, 1_000_000).is_err());
        let mut bad_hash = m.clone();
        bad_hash["payloads"]["response/point.zarr/0.0.0"]["sha256"] = json!("0".repeat(64));
        assert!(encode_frequency_response_point_bundle(&bytes(&bad_hash), &f, 1_000_000).is_err());
    }
    #[test]
    fn byte_budget_includes_header_manifest_and_all_payloads() {
        let f = files();
        let m = bytes(&manifest(Some(0), &f));
        let raw = encode_frequency_response_point_bundle(&m, &f, 1_000_000).unwrap();
        assert!(encode_frequency_response_point_bundle(&m, &f, raw.len() - 1).is_err());
        assert!(decode_frequency_response_point_bundle(&raw, raw.len() - 1).is_err());
        assert!(encode_frequency_response_point_bundle(&m, &f, raw.len()).is_ok());
    }
    #[test]
    fn duplicate_manifest_keys_and_duplicate_or_inconsistent_point_ports_are_rejected() {
        let f = files();
        let base = manifest(None, &f);
        for pointer in ["/points/1/index", "/points/1/port_id"] {
            let mut m = base.clone();
            let value = if pointer.ends_with("index") {
                json!(0)
            } else {
                json!("response-frequency-000000")
            };
            *m.pointer_mut(pointer).unwrap() = value;
            assert!(encode_frequency_response_index_bundle(&bytes(&m), &f, 1_000_000).is_err());
        }
        let mut m = String::from_utf8(bytes(&base)).unwrap();
        m.insert_str(1, "\"status\":\"complete\",");
        assert!(encode_frequency_response_index_bundle(m.as_bytes(), &f, 1_000_000).is_err());
    }
    #[test]
    fn file_directory_collisions_are_rejected_with_case_folding() {
        for (parent, child) in [
            ("field", "field/chunk.bin"),
            ("FIELD", "field/chunk.bin"),
            ("field", "FIELD/chunk.bin"),
        ] {
            let f = BTreeMap::from([(parent.into(), vec![1]), (child.into(), vec![2])]);
            assert!(encode_frequency_response_point_bundle(
                &bytes(&manifest(Some(0), &f)),
                &f,
                1_000_000
            )
            .is_err());
        }
    }
    fn encoded_sweep_with_paths(
        paths: [&str; 3],
    ) -> (FrequencyResponseBundle, Vec<FrequencyResponseBundle>) {
        let global = BTreeMap::from([(paths[0].to_owned(), vec![5])]);
        let mut index = manifest(None, &global);
        let mut points = Vec::new();
        for n in 0..2 {
            let f = BTreeMap::from([(paths[n + 1].to_owned(), vec![n as u8 + 1])]);
            let raw = encode_frequency_response_point_bundle(
                &bytes(&manifest(Some(n), &f)),
                &f,
                1_000_000,
            )
            .unwrap();
            index["points"][n]["bundle_sha256"] = json!(hash(&raw));
            points.push(decode_frequency_response_point_bundle(&raw, 1_000_000).unwrap());
        }
        let raw =
            encode_frequency_response_index_bundle(&bytes(&index), &global, 1_000_000).unwrap();
        (
            decode_frequency_response_index_bundle(&raw, 1_000_000).unwrap(),
            points,
        )
    }
    #[test]
    fn sweep_closure_rejects_file_aliases_and_file_directory_collisions() {
        for paths in [
            [
                "response/global.json",
                "response/shared.bin",
                "response/shared.bin",
            ],
            [
                "response/shared.bin",
                "response/p0.bin",
                "response/shared.bin",
            ],
            [
                "response/global",
                "response/global/p0.bin",
                "response/p1.bin",
            ],
            [
                "response/global.json",
                "response/tree/p0.bin",
                "response/tree",
            ],
            [
                "response/SHARED.bin",
                "response/p0.bin",
                "response/shared.bin",
            ],
        ] {
            let (index, points) = encoded_sweep_with_paths(paths);
            assert!(
                validate_frequency_response_sweep_bundles(&index, &points, &[1e9, 2e9], u64::MAX)
                    .is_err(),
                "{paths:?}"
            );
        }
    }

    #[test]
    fn sweep_verifies_all_point_hashes_exact_grid_case_and_aggregate_budget() {
        let f = files();
        let mut i = manifest(None, &f);
        let mut points = Vec::new();
        let mut total = 0;
        for n in 0..2 {
            let pf =
                BTreeMap::from([(format!("response/points/{n}/values.bin"), vec![n as u8 + 1])]);
            let raw = encode_frequency_response_point_bundle(
                &bytes(&manifest(Some(n), &pf)),
                &pf,
                1_000_000,
            )
            .unwrap();
            i["points"][n]["bundle_sha256"] = json!(hash(&raw));
            total += raw.len() as u64;
            points.push(decode_frequency_response_point_bundle(&raw, 1_000_000).unwrap());
        }
        let raw = encode_frequency_response_index_bundle(&bytes(&i), &f, 1_000_000).unwrap();
        total += raw.len() as u64;
        let index = decode_frequency_response_index_bundle(&raw, 1_000_000).unwrap();
        assert!(
            validate_frequency_response_sweep_bundles(&index, &points, &[1e9, 2e9], total).is_ok()
        );
        assert!(
            validate_frequency_response_sweep_bundles(&index, &points, &[1e9, 2e9], total - 1)
                .is_err()
        );
        assert!(validate_frequency_response_sweep_bundles(
            &index,
            &points[..1],
            &[1e9, 2e9],
            total
        )
        .is_err());
        assert!(
            validate_frequency_response_sweep_bundles(&index, &points, &[2e9, 1e9], total).is_err()
        );
        let mut wrong_hash = i.clone();
        wrong_hash["points"][1]["bundle_sha256"] = json!("0".repeat(64));
        let wrong_hash_raw =
            encode_frequency_response_index_bundle(&bytes(&wrong_hash), &f, 1_000_000).unwrap();
        let wrong_hash_index =
            decode_frequency_response_index_bundle(&wrong_hash_raw, 1_000_000).unwrap();
        assert!(validate_frequency_response_sweep_bundles(
            &wrong_hash_index,
            &points,
            &[1e9, 2e9],
            u64::MAX
        )
        .is_err());
        let pf = BTreeMap::from([("response/points/1/values.bin".into(), vec![2])]);
        let mut alien_scope = manifest(Some(1), &pf);
        alien_scope["identity"]["scope_id"] = json!("foreign-scope");
        let scope_raw =
            encode_frequency_response_point_bundle(&bytes(&alien_scope), &pf, 1_000_000).unwrap();
        let mut scope_index_manifest = i.clone();
        scope_index_manifest["points"][1]["bundle_sha256"] = json!(hash(&scope_raw));
        let scope_index_raw =
            encode_frequency_response_index_bundle(&bytes(&scope_index_manifest), &f, 1_000_000)
                .unwrap();
        let scope_index =
            decode_frequency_response_index_bundle(&scope_index_raw, 1_000_000).unwrap();
        let mut scope_points = points.clone();
        scope_points[1] = decode_frequency_response_point_bundle(&scope_raw, 1_000_000).unwrap();
        assert!(validate_frequency_response_sweep_bundles(
            &scope_index,
            &scope_points,
            &[1e9, 2e9],
            u64::MAX
        )
        .is_err());
        let mut alien = manifest(Some(1), &pf);
        alien["identity"]["case_id"] = json!("foreign-case");
        let raw = encode_frequency_response_point_bundle(&bytes(&alien), &pf, 1_000_000).unwrap();
        i["points"][1]["bundle_sha256"] = json!(hash(&raw));
        let index_raw = encode_frequency_response_index_bundle(&bytes(&i), &f, 1_000_000).unwrap();
        let alien_index = decode_frequency_response_index_bundle(&index_raw, 1_000_000).unwrap();
        points[1] = decode_frequency_response_point_bundle(&raw, 1_000_000).unwrap();
        assert!(validate_frequency_response_sweep_bundles(
            &alien_index,
            &points,
            &[1e9, 2e9],
            u64::MAX
        )
        .is_err());
    }
}
