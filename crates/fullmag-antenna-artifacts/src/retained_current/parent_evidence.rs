//! Evidence-only historical parent metadata; never sufficient to authorize a new solve.
use super::*;
use fullmag_ir::AntennaRetainedCurrentSourceIR;
use std::collections::BTreeSet;

pub const PARENT_EVIDENCE_SCHEMA: &str = "antenna_retained_current_parent_evidence.v1";
pub const PARENT_CODEC_ID: &str = "fullmag.antenna.closed_loop_bundle";
pub const PARENT_CODEC_VERSION: &str = "v1";
pub const PARENT_MANIFEST_SCHEMA: &str = "antenna_field_solution.v2";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParentInspectionOwner {
    pub project_id: String,
    pub run_id: String,
    pub study_step_id: String,
    pub native_stage_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: String,
    pub artifact_id: String,
    pub package: CasObjectRef,
    pub package_codec_id: String,
    pub package_codec_version: String,
    pub manifest_schema: String,
    pub output_manifest_artifact_id: String,
    pub output_manifest: CasObjectRef,
}
impl ParentInspectionOwner {
    /// Shape and immutable pin agreement only, not current ownership authentication.
    pub fn validate_metadata(&self) -> Result<(), ArtifactError> {
        for value in [
            &self.project_id,
            &self.run_id,
            &self.study_step_id,
            &self.native_stage_id,
            &self.task_id,
            &self.attempt_id,
            &self.artifact_id,
            &self.output_manifest_artifact_id,
        ] {
            require(id(value), "invalid parent identifier")?;
        }
        let epoch = self.ownership_epoch.parse::<u64>().ok();
        require(
            epoch.is_some_and(|e| e > 0 && e.to_string() == self.ownership_epoch),
            "parent epoch must be canonical positive u64",
        )?;
        require(
            self.package_codec_id == PARENT_CODEC_ID
                && self.package_codec_version == PARENT_CODEC_VERSION
                && self.manifest_schema == PARENT_MANIFEST_SCHEMA,
            "parent must be a full v2 inspection; child-of-child is unsupported",
        )?;
        self.package.validate(MAX_PACKAGE_BYTES)?;
        self.output_manifest.validate(MAX_METADATA_BYTES)?;
        require(
            self.package.object_ref != self.output_manifest.object_ref,
            "parent package and output manifest alias",
        )
    }
    pub fn matches_source(&self, source: &AntennaRetainedCurrentSourceIR) -> bool {
        let AntennaRetainedCurrentSourceIR::PublishedInspection {
            project_id,
            run_id,
            task_id,
            attempt_id,
            ownership_epoch,
            artifact_id,
            object_ref,
        } = source;
        project_id == &self.project_id
            && run_id == &self.run_id
            && task_id == &self.task_id
            && attempt_id == &self.attempt_id
            && ownership_epoch == &self.ownership_epoch
            && artifact_id == &self.artifact_id
            && object_ref == &self.package.object_ref
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParentCurrentDigests {
    pub prepared_execution_digest: String,
    pub accepted_charge_field_digest: String,
    pub accepted_source_state_digest: String,
    pub view_identity_digest: String,
    pub current_balance_certificate_digest: String,
}
impl ParentCurrentDigests {
    pub fn validate_metadata(&self) -> Result<(), ArtifactError> {
        for value in [
            &self.prepared_execution_digest,
            &self.accepted_charge_field_digest,
            &self.accepted_source_state_digest,
            &self.view_identity_digest,
            &self.current_balance_certificate_digest,
        ] {
            require(
                digest(value),
                "parent source digest must be canonical sha256",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedCurrentParent {
    pub owner: ParentInspectionOwner,
    pub source: ParentCurrentDigests,
    pub evidence_capsule: CasObjectRef,
}
impl RetainedCurrentParent {
    pub fn validate_metadata(&self) -> Result<(), ArtifactError> {
        self.owner.validate_metadata()?;
        self.source.validate_metadata()?;
        self.evidence_capsule.validate(MAX_METADATA_BYTES)?;
        require(
            self.evidence_capsule.object_ref != self.owner.package.object_ref
                && self.evidence_capsule.object_ref != self.owner.output_manifest.object_ref,
            "parent evidence aliases package or output manifest",
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParentEvidenceRecordObject {
    pub archive_path: String,
    pub object: CasObjectRef,
}

/// Detached snapshots of allowed parent records. This never mints active parent store records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParentEvidenceCapsule {
    pub schema_version: String,
    pub role: String,
    pub parent_owner: ParentInspectionOwner,
    pub accepted_provenance_manifest: CasObjectRef,
    pub record_objects: Vec<ParentEvidenceRecordObject>,
}
impl ParentEvidenceCapsule {
    pub fn validate_metadata(&self) -> Result<(), ArtifactError> {
        metadata_bound(self)?;
        require(
            self.schema_version == PARENT_EVIDENCE_SCHEMA && self.role == "evidence_only",
            "unsupported evidence schema or role",
        )?;
        self.parent_owner.validate_metadata()?;
        self.accepted_provenance_manifest
            .validate(MAX_METADATA_BYTES)?;
        require(
            !self.record_objects.is_empty() && self.record_objects.len() <= MAX_RECORDS,
            "parent record count budget",
        )?;
        let mut paths = BTreeSet::new();
        let mut total = 0_u64;
        for record in &self.record_objects {
            let path = &record.archive_path;
            require(
                path.len() <= 4096
                    && path.starts_with("accepted_provenance/")
                    && !path.contains('\\')
                    && !path.contains(':')
                    && !path.chars().any(char::is_control)
                    && path
                        .split('/')
                        .all(|part| !part.is_empty() && part != "." && part != ".."),
                "unsafe detached record path",
            )?;
            require(paths.insert(path), "duplicate detached record path")?;
            record.object.validate(MAX_METADATA_BYTES)?;
            total = total
                .checked_add(record.object.byte_count)
                .ok_or_else(|| ArtifactError {
                    message: "parent record budget overflow".into(),
                })?;
            require(
                total <= MAX_RECORD_BYTES_TOTAL,
                "parent records exceed aggregate byte budget",
            )?;
        }
        // The session layer must still compare this exact set with the typed accepted_provenance manifest,
        // derive its required CAS closure, and bind the selected historical task/artifact/preparation.
        Ok(())
    }
    pub fn validate_parent(&self, expected: &ParentInspectionOwner) -> Result<(), ArtifactError> {
        self.validate_metadata()?;
        require(
            &self.parent_owner == expected,
            "parent evidence owner mismatch",
        )
    }
    pub fn metadata_dependencies(&self) -> Result<Vec<RetainedCurrentDependency>, ArtifactError> {
        self.validate_metadata()?;
        let mut refs = vec![RetainedCurrentDependency {
            role: RetainedCurrentDependencyRole::AcceptedProvenanceManifest,
            object: self.accepted_provenance_manifest.clone(),
        }];
        refs.extend(
            self.record_objects
                .iter()
                .map(|record| RetainedCurrentDependency {
                    role: RetainedCurrentDependencyRole::AcceptedProvenanceRecord,
                    object: record.object.clone(),
                }),
        );
        Ok(refs)
    }
}
pub fn parse_parent_evidence_capsule(bytes: &[u8]) -> Result<ParentEvidenceCapsule, ArtifactError> {
    let capsule: ParentEvidenceCapsule = parse(bytes)?;
    capsule.validate_metadata()?;
    Ok(capsule)
}

/// Bind raw capsule bytes to the child's pinned reference, without granting source admission.
pub fn validate_parent_evidence_bytes(
    parent: &RetainedCurrentParent,
    bytes: &[u8],
) -> Result<ParentEvidenceCapsule, ArtifactError> {
    parent.validate_metadata()?;
    require(
        bytes.len() as u64 == parent.evidence_capsule.byte_count
            && sha256(bytes) == parent.evidence_capsule.object_ref,
        "parent evidence capsule length/hash mismatch",
    )?;
    let capsule = parse_parent_evidence_capsule(bytes)?;
    capsule.validate_parent(&parent.owner)?;
    require(
        capsule.accepted_provenance_manifest.object_ref != parent.evidence_capsule.object_ref
            && capsule
                .record_objects
                .iter()
                .all(|r| r.object.object_ref != parent.evidence_capsule.object_ref),
        "evidence capsule contains a direct self-reference",
    )?;
    Ok(capsule)
}

/// A caller that has the external child package CAS must check this before rooting any edges.
/// The remaining proof graph is depth one because parent codec is restricted to full legacy v2.
pub fn validate_no_child_cycle(
    child_package_object_ref: &str,
    manifest: &RetainedCurrentFieldManifest,
    capsule_bytes: &[u8],
) -> Result<(), ArtifactError> {
    require(
        bare_digest(child_package_object_ref),
        "invalid external child package CAS",
    )?;
    let capsule = validate_parent_evidence_bytes(&manifest.parent, capsule_bytes)?;
    let mut dependencies = manifest.metadata_dependencies()?;
    dependencies.extend(capsule.metadata_dependencies()?);
    require(
        dependencies
            .iter()
            .all(|r| r.object.object_ref != child_package_object_ref),
        "child package self-reference",
    )
}
