//! Bounded transport of one immutable, owner-bound modal generation.
//! This validates byte closure and ownership, not physical convergence.
use crate::execution::ExecutionError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

pub const MODAL_EIGEN_BUNDLE_CODEC_ID: &str = "fullmag.study.modal_eigen_bundle";
pub const MODAL_EIGEN_BUNDLE_CODEC_VERSION: &str = "v1";
pub const MODAL_EIGEN_OUTPUT_PORT: &str = "modal_artifacts";
pub const MODAL_EIGEN_BUNDLE_MAX_BYTES: usize = 512 * 1024 * 1024;
const MAGIC: &[u8; 8] = b"FMMODB01";
const MAX_COMMIT_BYTES: usize = 4 * 1024 * 1024;
const MAX_MEMBERS: usize = 65_536;
const MANIFEST_MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 1024;

// The frozen v2 generation wire shape and field order are also consumed by
// fullmag-session::frequency_domain_artifact_generation. Keep the API-side
// parity test against the authoritative capture when changing this codec.
// This codec validates transport closure and owner identity only; the runner
// must still validate the manifest's semantic/Zarr references before use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    run_id: String,
    stage_id: String,
    stage_kind: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Member {
    byte_length: u64,
    sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    schema_version: String,
    producer: Option<Owner>,
    members: BTreeMap<String, Member>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    generation_id: String,
    content: Body,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModalEigenBundle {
    pub commit_bytes: Vec<u8>,
    pub generation_id: String,
    pub run_id: String,
    pub stage_id: String,
    pub payloads: BTreeMap<String, Vec<u8>>,
}
fn invalid(reason: impl Into<String>) -> ExecutionError {
    ExecutionError::Invalid(format!("modal eigen bundle v1: {}", reason.into()))
}
fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && Path::new(path).to_string_lossy() == path
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn commit(bytes: &[u8]) -> Result<Commit, ExecutionError> {
    if bytes.is_empty() || bytes.len() > MAX_COMMIT_BYTES {
        return Err(invalid("commit budget"));
    }
    let c: Commit = serde_json::from_slice(bytes).map_err(|e| invalid(e.to_string()))?;
    if serde_json::to_vec_pretty(&c).map_err(|e| invalid(e.to_string()))? != bytes
        || c.content.schema_version != "frequency_domain_artifact_generation.v2"
        || c.generation_id
            != digest(&serde_json::to_vec(&c.content).map_err(|e| invalid(e.to_string()))?)
        || c.content.members.is_empty()
        || c.content.members.len() > MAX_MEMBERS
    {
        return Err(invalid("noncanonical or invalid immutable generation"));
    }
    let owner = c
        .content
        .producer
        .as_ref()
        .ok_or_else(|| invalid("missing generation owner"))?;
    if ![&owner.run_id, &owner.stage_id].into_iter().all(|id| {
        !id.trim().is_empty()
            && id.trim() == id
            && !id.chars().any(char::is_control)
            && !matches!(id.as_str(), "current" | "run:current")
            && !id.ends_with(":current")
    }) || !matches!(owner.stage_kind.as_str(), "eigenmodes" | "flat_eigenmodes")
    {
        return Err(invalid("invalid modal generation owner"));
    }
    let mut portable = BTreeSet::new();
    for (path, member) in &c.content.members {
        if !safe_path(path)
            || !portable.insert(path.to_lowercase())
            || member.byte_length > MODAL_EIGEN_BUNDLE_MAX_BYTES as u64
            || member.sha256.len() != 71
            || !member.sha256.starts_with("sha256:")
            || !member.sha256[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid generation member"));
        }
    }
    if !c
        .content
        .members
        .contains_key("frequency_domain/manifest.v1.json")
        || !c.content.members.contains_key("eigen/spectrum.v2.json")
    {
        return Err(invalid("missing modal manifest or spectrum"));
    }
    Ok(c)
}
fn validate_manifest(
    c: &Commit,
    payloads: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ExecutionError> {
    let bytes = payloads
        .get("frequency_domain/manifest.v1.json")
        .ok_or_else(|| invalid("missing modal manifest"))?;
    validate_manifest_bytes(c, bytes)
}
fn validate_manifest_bytes(c: &Commit, bytes: &[u8]) -> Result<(), ExecutionError> {
    if bytes.is_empty() || bytes.len() > MANIFEST_MAX_BYTES {
        return Err(invalid("modal manifest budget"));
    }
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| invalid(e.to_string()))?;
    let owner = c
        .content
        .producer
        .as_ref()
        .ok_or_else(|| invalid("missing owner"))?;
    if v["schema_version"] != "frequency_domain_manifest.v1"
        || v["study_product"] != "modal_eigen"
        || v["run_id"].as_str() != Some(&owner.run_id)
        || v["stage_id"].as_str() != Some(&owner.stage_id)
    {
        return Err(invalid(
            "modal manifest owner or product differs from generation",
        ));
    }
    if let Some(stage_kind) = v.get("stage_kind") {
        if !matches!(stage_kind.as_str(), Some("eigenmodes" | "flat_eigenmodes")) {
            return Err(invalid("invalid modal manifest stage kind"));
        }
    }
    Ok(())
}
/// Encode exactly the captured members, in canonical order and under the caller's budget.
pub fn encode_modal_eigen_bundle(
    commit_bytes: &[u8],
    payloads: &BTreeMap<String, Vec<u8>>,
    max_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    let c = commit(commit_bytes)?;
    let limit = max_bytes.min(MODAL_EIGEN_BUNDLE_MAX_BYTES);
    let mut size = 20usize
        .checked_add(commit_bytes.len())
        .ok_or_else(|| invalid("size overflow"))?;
    if payloads.len() != c.content.members.len() {
        return Err(invalid("incomplete member closure"));
    }
    for (path, expected) in &c.content.members {
        let bytes = payloads
            .get(path)
            .ok_or_else(|| invalid("missing member"))?;
        if bytes.len() as u64 != expected.byte_length || digest(bytes) != expected.sha256 {
            return Err(invalid("member digest or length mismatch"));
        }
        size = size
            .checked_add(10)
            .and_then(|n| n.checked_add(path.len()))
            .and_then(|n| n.checked_add(bytes.len()))
            .ok_or_else(|| invalid("size overflow"))?;
    }
    if size > limit {
        return Err(invalid("bundle budget"));
    }
    validate_manifest(&c, payloads)?;
    let mut out = Vec::new();
    out.try_reserve_exact(size)
        .map_err(|_| invalid("bundle allocation"))?;
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(commit_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(&(payloads.len() as u32).to_le_bytes());
    out.extend_from_slice(commit_bytes);
    for (path, bytes) in payloads {
        out.extend_from_slice(&(path.len() as u16).to_le_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    Ok(out)
}
struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ExecutionError> {
        let end = self
            .offset
            .checked_add(n)
            .ok_or_else(|| invalid("frame overflow"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid("truncated frame"))?;
        self.offset = end;
        Ok(bytes)
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
/// Decode before CAS publication or recovery; no paths are extracted to disk.
pub fn decode_modal_eigen_bundle(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<ModalEigenBundle, ExecutionError> {
    if bytes.len() > max_bytes.min(MODAL_EIGEN_BUNDLE_MAX_BYTES) {
        return Err(invalid("bundle budget"));
    }
    let mut cursor = Cursor { bytes, offset: 0 };
    if cursor.take(8)? != MAGIC {
        return Err(invalid("magic or version"));
    }
    let length = usize::try_from(cursor.u64()?).map_err(|_| invalid("commit length"))?;
    if length == 0 || length > MAX_COMMIT_BYTES {
        return Err(invalid("commit budget"));
    }
    let count =
        u32::from_le_bytes(cursor.take(4)?.try_into().map_err(|_| invalid("count"))?) as usize;
    if count == 0 || count > MAX_MEMBERS {
        return Err(invalid("member count"));
    }
    let commit_bytes = cursor.take(length)?;
    let c = commit(commit_bytes)?;
    if count != c.content.members.len() {
        return Err(invalid("member count mismatch"));
    }
    let mut frames: Vec<(&str, &[u8])> = Vec::new();
    frames
        .try_reserve_exact(count)
        .map_err(|_| invalid("decode allocation"))?;
    for (expected_path, expected) in &c.content.members {
        let path_len = u16::from_le_bytes(
            cursor
                .take(2)?
                .try_into()
                .map_err(|_| invalid("path length"))?,
        ) as usize;
        let path =
            std::str::from_utf8(cursor.take(path_len)?).map_err(|_| invalid("path encoding"))?;
        if path != expected_path {
            return Err(invalid("unordered, duplicate or unexpected member"));
        }
        let length = cursor.u64()?;
        if length != expected.byte_length {
            return Err(invalid("member length mismatch"));
        }
        let data = cursor.take(usize::try_from(length).map_err(|_| invalid("member length"))?)?;
        if digest(data) != expected.sha256 {
            return Err(invalid("member digest mismatch"));
        }
        frames.push((path, data));
    }
    if cursor.offset != bytes.len() {
        return Err(invalid("trailing bytes"));
    }
    let manifest = frames
        .iter()
        .find_map(|(path, data)| (*path == "frequency_domain/manifest.v1.json").then_some(*data))
        .ok_or_else(|| invalid("missing modal manifest"))?;
    validate_manifest_bytes(&c, manifest)?;
    let owner = c
        .content
        .producer
        .as_ref()
        .ok_or_else(|| invalid("missing owner"))?;
    let mut payloads = BTreeMap::new();
    for (path, data) in frames {
        let key =
            String::from_utf8(owned(path.as_bytes())?).map_err(|_| invalid("path encoding"))?;
        payloads.insert(key, owned(data)?);
    }
    Ok(ModalEigenBundle {
        commit_bytes: owned(commit_bytes)?,
        generation_id: c.generation_id.clone(),
        run_id: owner.run_id.clone(),
        stage_id: owner.stage_id.clone(),
        payloads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Vec<u8>, BTreeMap<String, Vec<u8>>) {
        let payloads = BTreeMap::from([
            ("frequency_domain/manifest.v1.json".into(), br#"{"schema_version":"frequency_domain_manifest.v1","study_product":"modal_eigen","run_id":"run-exact","stage_id":"eigen"}"#.to_vec()),
            ("eigen/spectrum.v2.json".into(), br#"{"schema_version":"eigen_spectrum.v2","modes":[]}"#.to_vec()),
        ]);
        let body = Body {
            schema_version: "frequency_domain_artifact_generation.v2".into(),
            producer: Some(Owner {
                run_id: "run-exact".into(),
                stage_id: "eigen".into(),
                stage_kind: "eigenmodes".into(),
            }),
            members: payloads
                .iter()
                .map(|(p, b)| {
                    (
                        p.clone(),
                        Member {
                            byte_length: b.len() as u64,
                            sha256: digest(b),
                        },
                    )
                })
                .collect(),
        };
        let c = Commit {
            generation_id: digest(&serde_json::to_vec(&body).unwrap()),
            content: body,
        };
        (serde_json::to_vec_pretty(&c).unwrap(), payloads)
    }
    #[test]
    fn bundle_preserves_exact_generation_and_rejects_corruption_truncation_and_budget() {
        let (commit, payloads) = fixture();
        let encoded = encode_modal_eigen_bundle(&commit, &payloads, 4096).unwrap();
        let decoded = decode_modal_eigen_bundle(&encoded, encoded.len()).unwrap();
        assert_eq!(decoded.payloads, payloads);
        assert_eq!(decoded.commit_bytes, commit);
        assert!(decode_modal_eigen_bundle(&encoded, encoded.len() - 1).is_err());
        for length in 0..encoded.len() {
            assert!(decode_modal_eigen_bundle(&encoded[..length], 4096).is_err());
        }
        let mut corrupt = encoded.clone();
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(decode_modal_eigen_bundle(&corrupt, 4096).is_err());
        let mut extra = encoded;
        extra.push(0);
        assert!(decode_modal_eigen_bundle(&extra, 4096).is_err());
    }
    #[test]
    fn bundle_rejects_missing_extra_and_foreign_members() {
        let (commit, mut payloads) = fixture();
        payloads.remove("eigen/spectrum.v2.json");
        assert!(encode_modal_eigen_bundle(&commit, &payloads, 4096).is_err());
        let (commit, mut payloads) = fixture();
        payloads.insert("../escape".into(), vec![1]);
        assert!(encode_modal_eigen_bundle(&commit, &payloads, 4096).is_err());
        let (commit, mut payloads) = fixture();
        payloads.insert(
            "frequency_domain/manifest.v1.json".into(),
            br#"{"run_id":"foreign"}"#.to_vec(),
        );
        assert!(encode_modal_eigen_bundle(&commit, &payloads, 4096).is_err());
    }
    #[test]
    fn manifest_budget_and_stage_kind_are_bounded() {
        let (commit_bytes, _) = fixture();
        let c = commit(&commit_bytes).unwrap();
        assert!(validate_manifest_bytes(&c, br#"{"#).is_err());
        assert!(validate_manifest_bytes(&c, &vec![b' '; MANIFEST_MAX_BYTES + 1]).is_err());
        let flat_manifest = br#"{"schema_version":"frequency_domain_manifest.v1","study_product":"modal_eigen","run_id":"run-exact","stage_id":"eigen","stage_kind":"flat_eigenmodes"}"#;
        assert!(validate_manifest_bytes(&c, flat_manifest).is_ok());
        let unknown_stage_kind = br#"{"schema_version":"frequency_domain_manifest.v1","study_product":"modal_eigen","run_id":"run-exact","stage_id":"eigen","stage_kind":"other"}"#;
        assert!(validate_manifest_bytes(&c, unknown_stage_kind).is_err());
    }
    #[test]
    fn generation_rejects_traversal_and_accepts_utf8_member_paths() {
        let (commit_bytes, payloads) = fixture();
        let mut traversal = commit(&commit_bytes).unwrap();
        let escape = b"escape".to_vec();
        traversal.content.members.insert(
            "../escape".into(),
            Member {
                byte_length: escape.len() as u64,
                sha256: digest(&escape),
            },
        );
        traversal.generation_id = digest(&serde_json::to_vec(&traversal.content).unwrap());
        let traversal_bytes = serde_json::to_vec_pretty(&traversal).unwrap();
        assert!(commit(&traversal_bytes).is_err());

        let mut unicode = commit(&commit_bytes).unwrap();
        let unicode_payload = b"unicode".to_vec();
        unicode.content.members.insert(
            "response/μ.json".into(),
            Member {
                byte_length: unicode_payload.len() as u64,
                sha256: digest(&unicode_payload),
            },
        );
        unicode.generation_id = digest(&serde_json::to_vec(&unicode.content).unwrap());
        let unicode_commit = serde_json::to_vec_pretty(&unicode).unwrap();
        let mut unicode_payloads = payloads;
        unicode_payloads.insert("response/μ.json".into(), unicode_payload);
        let encoded = encode_modal_eigen_bundle(&unicode_commit, &unicode_payloads, 4096).unwrap();
        let decoded = decode_modal_eigen_bundle(&encoded, 4096).unwrap();
        assert!(decoded.payloads.contains_key("response/μ.json"));
    }
}
