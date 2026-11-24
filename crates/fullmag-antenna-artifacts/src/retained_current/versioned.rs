//! Explicit read-only dispatch. Neither variant authenticates the source owner.
use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum RetainedCurrentFieldManifestAny {
    SurfaceV1(RetainedCurrentFieldManifest),
    DirectV2(RetainedCurrentFieldManifestV2),
}
#[derive(Debug, Clone, Copy)]
pub enum RetainedCurrentFieldManifestRef<'a> {
    SurfaceV1(&'a RetainedCurrentFieldManifest),
    DirectV2(&'a RetainedCurrentFieldManifestV2),
}
impl RetainedCurrentFieldManifestAny {
    pub fn as_ref(&self) -> RetainedCurrentFieldManifestRef<'_> {
        match self {
            Self::SurfaceV1(m) => RetainedCurrentFieldManifestRef::SurfaceV1(m),
            Self::DirectV2(m) => RetainedCurrentFieldManifestRef::DirectV2(m),
        }
    }
}
impl<'a> RetainedCurrentFieldManifestRef<'a> {
    pub fn schema_version(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.schema_version,
            Self::DirectV2(m) => &m.schema_version,
        }
    }
    pub fn status(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.status,
            Self::DirectV2(m) => &m.status,
        }
    }
    pub fn qualification(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.qualification,
            Self::DirectV2(m) => &m.qualification,
        }
    }
    pub fn content_digest(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.content_digest,
            Self::DirectV2(m) => &m.content_digest,
        }
    }
    pub fn stage_id(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.stage_id,
            Self::DirectV2(m) => &m.stage_id,
        }
    }
    pub fn output_id(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.output_id,
            Self::DirectV2(m) => &m.output_id,
        }
    }
    pub fn port_mode_id(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.port_mode_id,
            Self::DirectV2(m) => &m.port_mode_id,
        }
    }
    pub fn source_object_id(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.source_object_id,
            Self::DirectV2(m) => &m.source_object_id,
        }
    }
    pub fn current_transport_id(self) -> &'a str {
        match self {
            Self::SurfaceV1(m) => &m.current_transport_id,
            Self::DirectV2(m) => &m.current_transport_id,
        }
    }
    pub fn parent(self) -> &'a RetainedCurrentParent {
        match self {
            Self::SurfaceV1(m) => &m.parent,
            Self::DirectV2(m) => &m.parent,
        }
    }
    pub fn sample_carrier(self) -> &'a crate::AntennaSampleCarrier {
        match self {
            Self::SurfaceV1(m) => &m.sample_carrier,
            Self::DirectV2(m) => &m.sample_carrier,
        }
    }
    pub fn requested_intent(self) -> &'a fullmag_ir::AntennaFieldSolveStageIR {
        match self {
            Self::SurfaceV1(m) => &m.requested_intent,
            Self::DirectV2(m) => &m.requested_intent,
        }
    }
    pub fn resolved_execution(self) -> &'a RetainedCurrentResolvedExecution {
        match self {
            Self::SurfaceV1(m) => &m.resolved_execution,
            Self::DirectV2(m) => &m.resolved_execution,
        }
    }
    pub fn payloads(self) -> &'a RetainedCurrentPayloads {
        match self {
            Self::SurfaceV1(m) => &m.payloads,
            Self::DirectV2(m) => &m.payloads,
        }
    }
    pub fn source_vertex_count(self) -> u64 {
        match self {
            Self::SurfaceV1(m) => m.source_vertex_count,
            Self::DirectV2(m) => m.source_vertex_count,
        }
    }
    pub fn source_cell_count(self) -> u64 {
        match self {
            Self::SurfaceV1(m) => m.source_cell_count,
            Self::DirectV2(m) => m.source_cell_count,
        }
    }
    pub fn target_count(self) -> u64 {
        match self {
            Self::SurfaceV1(m) => m.target_count,
            Self::DirectV2(m) => m.target_count,
        }
    }
    pub fn sample_cell_count(self) -> u64 {
        match self {
            Self::SurfaceV1(m) => m.sample_cell_count,
            Self::DirectV2(m) => m.sample_cell_count,
        }
    }
    pub fn codec_version(self) -> &'static str {
        match self {
            Self::SurfaceV1(_) => RETAINED_CURRENT_FIELD_CODEC_VERSION,
            Self::DirectV2(_) => RETAINED_CURRENT_FIELD_CODEC_VERSION_V2,
        }
    }
    pub fn surface_policy(self) -> Option<&'a fullmag_ir::AntennaSurfaceFieldPolicyIR> {
        match self {
            Self::SurfaceV1(m) => Some(&m.field_policy),
            Self::DirectV2(_) => None,
        }
    }
    pub fn direct_policy(self) -> Option<&'a RetainedCurrentDirectFieldPolicyV2> {
        match self {
            Self::SurfaceV1(_) => None,
            Self::DirectV2(m) => Some(&m.direct_field_policy),
        }
    }
    pub fn validate_metadata(self) -> Result<(), ArtifactError> {
        match self {
            Self::SurfaceV1(m) => m.validate_metadata(),
            Self::DirectV2(m) => m.validate_metadata(),
        }
    }
    pub fn metadata_dependencies(self) -> Result<Vec<RetainedCurrentDependency>, ArtifactError> {
        match self {
            Self::SurfaceV1(m) => m.metadata_dependencies(),
            Self::DirectV2(m) => m.metadata_dependencies(),
        }
    }
    pub fn validate_payloads(
        self,
        payloads: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), ArtifactError> {
        match self {
            Self::SurfaceV1(m) => validate_payloads(m, payloads),
            Self::DirectV2(m) => validate_payloads_v2(m, payloads),
        }
    }
}

pub fn parse_retained_current_manifest_any(
    bytes: &[u8],
) -> Result<RetainedCurrentFieldManifestAny, ArtifactError> {
    let value: serde_json::Value = parse(bytes)?;
    match value
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
    {
        Some(RETAINED_CURRENT_FIELD_SCHEMA) => Ok(RetainedCurrentFieldManifestAny::SurfaceV1(
            parse_retained_current_manifest(bytes)?,
        )),
        Some(RETAINED_CURRENT_FIELD_SCHEMA_V2) => Ok(RetainedCurrentFieldManifestAny::DirectV2(
            parse_retained_current_manifest_v2(bytes)?,
        )),
        _ => Err(ArtifactError {
            message: "retained current: unknown manifest version".into(),
        }),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum RetainedCurrentFieldBundleAny {
    SurfaceV1(RetainedCurrentFieldBundle),
    DirectV2(RetainedCurrentFieldBundleV2),
}
impl RetainedCurrentFieldBundleAny {
    pub fn manifest(&self) -> RetainedCurrentFieldManifestRef<'_> {
        match self {
            Self::SurfaceV1(b) => RetainedCurrentFieldManifestRef::SurfaceV1(&b.manifest),
            Self::DirectV2(b) => RetainedCurrentFieldManifestRef::DirectV2(&b.manifest),
        }
    }
    pub fn manifest_bytes(&self) -> &[u8] {
        match self {
            Self::SurfaceV1(b) => &b.manifest_bytes,
            Self::DirectV2(b) => &b.manifest_bytes,
        }
    }
    pub fn payloads(&self) -> &BTreeMap<String, Vec<u8>> {
        match self {
            Self::SurfaceV1(b) => &b.payloads,
            Self::DirectV2(b) => &b.payloads,
        }
    }
}
/// Header dispatch is exact; a v1 header never retries a v2 parser after refusal.
pub fn retained_current_field_manifest_length_any(
    header: &[u8],
    package_byte_count: u64,
) -> Result<usize, ArtifactError> {
    require(header.len() == 16, "retained field fixed header length")?;
    match &header[..8] {
        b"FMARCF1\0" => retained_current_field_manifest_length(header, package_byte_count),
        b"FMARCF2\0" => retained_current_field_manifest_length_v2(header, package_byte_count),
        _ => Err(ArtifactError {
            message: "retained current: unknown package version".into(),
        }),
    }
}
pub fn decode_retained_current_field_bundle_any(
    bytes: &[u8],
    maximum: usize,
) -> Result<RetainedCurrentFieldBundleAny, ArtifactError> {
    require(bytes.len() >= 16, "retained field fixed header length")?;
    retained_current_field_manifest_length_any(&bytes[..16], bytes.len() as u64)?;
    match &bytes[..8] {
        b"FMARCF1\0" => Ok(RetainedCurrentFieldBundleAny::SurfaceV1(
            decode_retained_current_field_bundle(bytes, maximum)?,
        )),
        b"FMARCF2\0" => Ok(RetainedCurrentFieldBundleAny::DirectV2(
            decode_retained_current_field_bundle_v2(bytes, maximum)?,
        )),
        _ => Err(ArtifactError {
            message: "retained current: unknown package version".into(),
        }),
    }
}

/// Checks only immutable reference cycles, not accepted ownership or scientific qualification.
pub fn validate_no_child_cycle_any(
    child_package_object_ref: &str,
    manifest: RetainedCurrentFieldManifestRef<'_>,
    capsule_bytes: &[u8],
) -> Result<(), ArtifactError> {
    require(
        bare_digest(child_package_object_ref),
        "invalid external child package CAS",
    )?;
    let capsule = validate_parent_evidence_bytes(manifest.parent(), capsule_bytes)?;
    let mut dependencies = manifest.metadata_dependencies()?;
    dependencies.extend(capsule.metadata_dependencies()?);
    require(
        dependencies
            .iter()
            .all(|r| r.object.object_ref != child_package_object_ref),
        "child package self-reference",
    )
}
pub fn validate_no_child_cycle_v2(
    child_package_object_ref: &str,
    manifest: &RetainedCurrentFieldManifestV2,
    capsule_bytes: &[u8],
) -> Result<(), ArtifactError> {
    validate_no_child_cycle_any(
        child_package_object_ref,
        RetainedCurrentFieldManifestRef::DirectV2(manifest),
        capsule_bytes,
    )
}
