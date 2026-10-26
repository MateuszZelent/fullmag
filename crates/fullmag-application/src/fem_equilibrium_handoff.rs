//! Bounded, owner-bound transport for FEM relaxation equilibrium artifacts.
//!
//! This module authenticates the JSON envelope, its preparation binding, and
//! the exact member byte closure.  It deliberately does not interpret the
//! scientific contents of those members; the runner/runtime-control boundary
//! owns that validation before execution or publication.

use crate::execution::ExecutionError;
use crate::preparation::PreparationBinding;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Component, Path};

pub const FEM_EQUILIBRIUM_HANDOFF_CODEC_ID: &str = "fullmag.study.fem_equilibrium_handoff";
pub const FEM_EQUILIBRIUM_HANDOFF_CODEC_VERSION: &str = "v1";
pub const FEM_EQUILIBRIUM_HANDOFF_PORT: &str = fullmag_authoring::EQUILIBRIUM_HANDOFF_PORT_ID;
pub const FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES: usize = 64 * 1024 * 1024;

pub const FEM_EQUILIBRIUM_HANDOFF_SCHEMA: &str = "fullmag.fem_equilibrium_handoff.v1";
const COMMON_MEMBER_PATHS: [&str; 4] = [
    "source/execution_plan.json",
    "source/completion.json",
    "source/m0.json",
    "equilibrium/producer_provenance.v1.json",
];
const V1_MEMBER_PATHS: [&str; 3] = [
    "equilibrium/accepted_fem_equilibrium_fields.v1.json",
    "equilibrium/certified_fem_equilibrium_fields.v1.json",
    "equilibrium/recomputed_fem_linearization_certificate.v1.json",
];
const V2_MEMBER_PATHS: [&str; 3] = [
    "equilibrium/accepted_fem_equilibrium_fields.v2.json",
    "equilibrium/certified_fem_equilibrium_fields.v2.json",
    "equilibrium/recomputed_fem_linearization_certificate.v2.json",
];

/// One exact immutable member in the handoff closure.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemEquilibriumHandoffMember {
    pub sha256: String,
    pub bytes: Vec<u8>,
}

/// The complete typed handoff between accepted FEM relaxation and eigen work.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemEquilibriumHandoff {
    pub schema_version: String,
    pub run_id: String,
    pub stage_id: String,
    pub preparation: PreparationBinding,
    pub execution_plan_fingerprint: String,
    pub members: BTreeMap<String, FemEquilibriumHandoffMember>,
}

fn invalid(reason: impl Into<String>) -> ExecutionError {
    ExecutionError::Invalid(format!("FEM equilibrium handoff v1: {}", reason.into()))
}

fn prefixed_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn bounded_maximum(maximum_bytes: usize) -> usize {
    maximum_bytes.min(FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES)
}

fn canonical_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn safe_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
        && !value.contains('/')
        && !value.contains('\\')
        && value != "."
        && value != ".."
        && value != "current"
        && value != "run:current"
        && !value.ends_with(":current")
}

fn safe_member_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && path.is_ascii()
        && !path.contains('\\')
        && !path.contains(':')
        && !path.chars().any(char::is_control)
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn expected_paths(family: &[&'static str; 3]) -> BTreeSet<&'static str> {
    COMMON_MEMBER_PATHS
        .into_iter()
        .chain(family.iter().copied())
        .collect()
}

fn validate_member_paths(
    members: &BTreeMap<String, FemEquilibriumHandoffMember>,
) -> Result<(), ExecutionError> {
    let actual = members.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let v1 = expected_paths(&V1_MEMBER_PATHS);
    let v2 = expected_paths(&V2_MEMBER_PATHS);
    if actual != v1 && actual != v2 {
        return Err(invalid(
            "members must contain the common closure and exactly one complete v1 or v2 family",
        ));
    }
    for path in members.keys() {
        if !safe_member_path(path) {
            return Err(invalid("member path is not canonical and portable"));
        }
    }
    Ok(())
}

fn validate_aggregate_bytes(
    members: &BTreeMap<String, FemEquilibriumHandoffMember>,
    maximum_bytes: usize,
) -> Result<(), ExecutionError> {
    let mut aggregate = 0usize;
    for member in members.values() {
        if member.bytes.is_empty() {
            return Err(invalid("member bytes must not be empty"));
        }
        aggregate = aggregate
            .checked_add(member.bytes.len())
            .ok_or_else(|| invalid("member byte aggregate overflow"))?;
    }
    if aggregate > maximum_bytes {
        return Err(invalid("member byte aggregate exceeds the handoff budget"));
    }
    Ok(())
}

impl FemEquilibriumHandoffMember {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        let Some(hex) = self.sha256.strip_prefix("sha256:") else {
            return Err(invalid("member sha256 must be sha256:<64 lowercase hex>"));
        };
        if !canonical_hex64(hex) {
            return Err(invalid("member sha256 must be sha256:<64 lowercase hex>"));
        }
        if self.bytes.is_empty() {
            return Err(invalid("member bytes must not be empty"));
        }
        if prefixed_digest(&self.bytes) != self.sha256 {
            return Err(invalid("member sha256 does not match its bytes"));
        }
        Ok(())
    }
}

impl FemEquilibriumHandoff {
    pub fn validate(&self) -> Result<(), ExecutionError> {
        self.validate_with_budget(FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES)
    }

    fn validate_with_budget(&self, maximum_bytes: usize) -> Result<(), ExecutionError> {
        if self.schema_version != FEM_EQUILIBRIUM_HANDOFF_SCHEMA {
            return Err(invalid("schema_version is unsupported"));
        }
        if !safe_owner(&self.run_id) || !safe_owner(&self.stage_id) {
            return Err(invalid("run_id or stage_id is unsafe or reserved"));
        }
        self.preparation
            .validate()
            .map_err(|error| invalid(format!("preparation binding: {error}")))?;
        if !canonical_hex64(&self.execution_plan_fingerprint) {
            return Err(invalid(
                "execution_plan_fingerprint must be 64 lowercase hexadecimal characters",
            ));
        }
        if self.members.is_empty() {
            return Err(invalid("member closure must not be empty"));
        }
        validate_member_paths(&self.members)?;
        validate_aggregate_bytes(&self.members, bounded_maximum(maximum_bytes))?;
        for member in self.members.values() {
            member.validate()?;
        }
        Ok(())
    }
}

struct DuplicateKeySeed;

struct DuplicateKeyVisitor;

impl<'de> Visitor<'de> for DuplicateKeyVisitor {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_string<E>(self, _value: String) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_none<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(())
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateKeyVisitor)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        while sequence.next_element_seed(DuplicateKeySeed)?.is_some() {}
        Ok(())
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut keys = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key) {
                return Err(de::Error::custom("duplicate JSON object key"));
            }
            map.next_value_seed(DuplicateKeySeed)?;
        }
        Ok(())
    }
}

impl<'de> DeserializeSeed<'de> for DuplicateKeySeed {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(DuplicateKeyVisitor)
    }
}

fn reject_duplicate_json_keys(bytes: &[u8]) -> Result<(), ExecutionError> {
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    deserializer
        .deserialize_any(DuplicateKeyVisitor)
        .map_err(|error| invalid(format!("malformed or duplicate JSON: {error}")))?;
    deserializer
        .end()
        .map_err(|error| invalid(format!("trailing JSON bytes: {error}")))
}

/// Encode a validated handoff envelope for immutable CAS publication.
pub fn encode_fem_equilibrium_handoff(
    envelope: &FemEquilibriumHandoff,
    maximum_bytes: usize,
) -> Result<Vec<u8>, ExecutionError> {
    let maximum_bytes = bounded_maximum(maximum_bytes);
    envelope.validate_with_budget(maximum_bytes)?;
    let bytes = serde_json::to_vec(envelope)
        .map_err(|error| invalid(format!("serialize envelope: {error}")))?;
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(invalid("encoded envelope exceeds the handoff budget"));
    }
    Ok(bytes)
}

/// Decode and validate one immutable handoff envelope.
pub fn decode_fem_equilibrium_handoff(
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<FemEquilibriumHandoff, ExecutionError> {
    let maximum_bytes = bounded_maximum(maximum_bytes);
    if bytes.is_empty() || bytes.len() > maximum_bytes {
        return Err(invalid("encoded envelope exceeds the handoff budget"));
    }
    reject_duplicate_json_keys(bytes)?;
    let envelope: FemEquilibriumHandoff = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("decode envelope: {error}")))?;
    envelope.validate_with_budget(maximum_bytes)?;
    Ok(envelope)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(bytes: &[u8]) -> FemEquilibriumHandoffMember {
        FemEquilibriumHandoffMember {
            sha256: prefixed_digest(bytes),
            bytes: bytes.to_vec(),
        }
    }

    fn fixture_with_family(family: &[&'static str; 3]) -> FemEquilibriumHandoff {
        let mut members: BTreeMap<String, FemEquilibriumHandoffMember> = BTreeMap::new();
        for path in COMMON_MEMBER_PATHS
            .into_iter()
            .chain(family.iter().copied())
        {
            members.insert(path.to_owned(), member(path.as_bytes()));
        }
        FemEquilibriumHandoff {
            schema_version: FEM_EQUILIBRIUM_HANDOFF_SCHEMA.into(),
            run_id: "run-exact".into(),
            stage_id: "relax".into(),
            preparation: PreparationBinding {
                schema_version: crate::preparation::PREPARATION_BINDING_SCHEMA.into(),
                preparation_id: "prep-exact".into(),
                plan_fingerprint: format!("sha256:{}", "a".repeat(64)),
                receipt_sha256: format!("sha256:{}", "b".repeat(64)),
            },
            execution_plan_fingerprint: "c".repeat(64),
            members,
        }
    }

    fn fixture() -> FemEquilibriumHandoff {
        fixture_with_family(&V1_MEMBER_PATHS)
    }

    #[test]
    fn round_trip_preserves_exact_typed_envelope_and_supports_both_families() {
        for family in [&V1_MEMBER_PATHS, &V2_MEMBER_PATHS] {
            let envelope = fixture_with_family(family);
            let encoded =
                encode_fem_equilibrium_handoff(&envelope, FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES)
                    .unwrap();
            let decoded =
                decode_fem_equilibrium_handoff(&encoded, FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES)
                    .unwrap();
            assert_eq!(decoded, envelope);
        }
    }

    #[test]
    fn rejects_budget_empty_malformed_nonfinite_and_duplicate_json() {
        let envelope = fixture();
        let mut aggregate = envelope.clone();
        aggregate
            .members
            .get_mut(COMMON_MEMBER_PATHS[0])
            .unwrap()
            .bytes = vec![0; FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES];
        let path = COMMON_MEMBER_PATHS[0].to_owned();
        aggregate.members.get_mut(&path).unwrap().sha256 =
            prefixed_digest(&aggregate.members[&path].bytes);
        assert!(
            encode_fem_equilibrium_handoff(&aggregate, FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES).is_err()
        );
        assert!(decode_fem_equilibrium_handoff(b"", FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES).is_err());
        assert!(decode_fem_equilibrium_handoff(b"{", FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES).is_err());
        assert!(
            decode_fem_equilibrium_handoff(br#"NaN"#, FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES).is_err()
        );
        assert!(decode_fem_equilibrium_handoff(
            br#"{"schema_version":"one","schema_version":"two"}"#,
            FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES,
        )
        .is_err());
    }

    #[test]
    fn rejects_unknown_missing_mixed_and_noncanonical_member_paths() {
        let mut unknown = fixture();
        unknown
            .members
            .insert("equilibrium/extra.json".into(), member(b"x"));
        assert!(unknown.validate().is_err());

        let mut missing = fixture();
        missing.members.remove(COMMON_MEMBER_PATHS[0]);
        assert!(missing.validate().is_err());

        let mut mixed = fixture();
        mixed
            .members
            .insert(V2_MEMBER_PATHS[0].into(), member(b"x"));
        assert!(mixed.validate().is_err());

        let mut unsafe_path = fixture();
        let value = unsafe_path.members.remove(COMMON_MEMBER_PATHS[0]).unwrap();
        unsafe_path.members.insert("../escape.json".into(), value);
        assert!(unsafe_path.validate().is_err());
    }

    #[test]
    fn rejects_wrong_hash_owner_and_plan_fingerprint() {
        let mut wrong_hash = fixture();
        wrong_hash
            .members
            .get_mut(COMMON_MEMBER_PATHS[0])
            .unwrap()
            .sha256 = format!("sha256:{}", "d".repeat(64));
        assert!(wrong_hash.validate().is_err());

        for owner in [
            "",
            " current",
            "current",
            "run:current",
            "stage:current",
            "run/current",
        ] {
            let mut invalid_owner = fixture();
            invalid_owner.run_id = owner.into();
            assert!(
                invalid_owner.validate().is_err(),
                "owner {owner:?} must reject"
            );
        }

        let mut invalid_plan = fixture();
        invalid_plan.execution_plan_fingerprint = format!("sha256:{}", "e".repeat(64));
        assert!(invalid_plan.validate().is_err());
    }
}
