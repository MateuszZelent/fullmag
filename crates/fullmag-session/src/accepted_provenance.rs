//! Read-only accepted-run evidence closure for portable session exports.
//!
//! This module deliberately does not extend `SessionStore` authority. It
//! inventories immutable accepted records and verified CAS objects so a later
//! FMS layer can copy them under an evidence-only namespace. Leases, claims,
//! worker/process receipts, coordinator journals, and checkpoints are never
//! part of the closure.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value;

use crate::SessionStore;
#[path = "accepted_provenance_retained.rs"]
mod retained;
pub use retained::{ValidatedRetainedParentEvidence, validate_retained_current_parent_evidence, validate_retained_current_parent_evidence_any};

type AcceptedEvidenceRangeReader<'a> = dyn FnMut(&str, u64, u64)
    -> Result<Option<crate::cas::VerifiedCasRange>> + 'a;
use crate::repository_path::{checked_path, read_bounded_regular_file, validate_relative_path};
use crate::types::{
    FmsAcceptedStagePreparationReceipt, FmsArtifactCatalog, FmsRunCatalog, FmsRunIntent,
    FmsStudyOutputManifest, FmsTaskPreparationReceipt, canonical_json_sha256,
};

pub const ACCEPTED_PROVENANCE_SCHEMA: &str = "accepted_provenance.v1";
pub const ACCEPTED_STORE_PROVENANCE_SCHEMA: &str = "accepted_provenance.v2";
pub const ACCEPTED_PROVENANCE_ROLE: &str = "evidence_only";
pub const ACCEPTED_PROVENANCE_ARCHIVE_PREFIX: &str = "accepted_provenance";
pub const MAX_ACCEPTED_PROVENANCE_RECORD_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ACCEPTED_PROVENANCE_RECORDS: usize = 16_384;
pub const MAX_ACCEPTED_PROVENANCE_OBJECTS: usize = 100_000;

/// The only control records that may cross the accepted/live store boundary.
///
/// The enum is intentionally closed. There are no variants for leases, claims,
/// process state, worker inboxes, journals, or checkpoints, because none of
/// those records may become portable authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedProvenanceRecordKind {
    RunIntent,
    RunCatalog,
    ArtifactCatalog,
    TaskPreparationReceipt,
    AcceptedStagePreparationReceipt,
    SolutionSetManifest,
    SolutionSetRevision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedProvenanceRecord {
    pub kind: AcceptedProvenanceRecordKind,
    /// Relative path in the accepted store at capture time.
    pub source_path: String,
    /// Detached path in the future FMS archive.
    pub archive_path: String,
    /// Bare lowercase SHA-256 of the exact record bytes.
    pub content_sha256: String,
    pub byte_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedProvenanceCasObject {
    /// Bare lowercase SHA-256 under objects/sha256/.
    pub object_ref: String,
    pub byte_count: u64,
}

/// Live identity captured alongside the accepted evidence.
///
/// source_store_binding is supplied by the accepted-store owner. It is
/// preserved as provenance and is never treated as a new runtime binding when
/// the archive is imported on another host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedProvenanceContext {
    pub source_store_binding: String,
    pub accepted_run_id: String,
    pub captured_live_session_id: String,
    pub captured_live_session_epoch: u64,
    /// Opaque canonical scene revision identity. Numeric and digest forms are
    /// both used by existing live-session records.
    pub captured_scene_revision: String,
}

impl AcceptedProvenanceContext {
    pub fn validate(&self) -> Result<()> {
        validate_digest(&self.source_store_binding, "source_store_binding")?;
        crate::repository_path::validate_store_id(&self.accepted_run_id)
            .context("accepted provenance run id")?;
        crate::repository_path::validate_store_id(&self.captured_live_session_id)
            .context("accepted provenance live session id")?;
        if self.captured_live_session_epoch == 0 {
            bail!("accepted provenance live session epoch must be positive");
        }
        if self.captured_scene_revision.is_empty()
            || self.captured_scene_revision.len() > 1024
            || !self.captured_scene_revision.is_ascii()
            || self.captured_scene_revision.chars().any(char::is_control)
        {
            bail!("accepted provenance scene revision is invalid");
        }
        Ok(())
    }
}

/// Detached manifest written by the FMS layer as manifest/accepted_provenance.json.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedProvenanceManifest {
    pub schema_version: String,
    pub role: String,
    pub source_store_binding: String,
    pub accepted_run_id: String,
    pub captured_live_session_id: String,
    pub captured_live_session_epoch: u64,
    pub captured_scene_revision: String,
    pub records: Vec<AcceptedProvenanceRecord>,
    pub cas_objects: Vec<AcceptedProvenanceCasObject>,
    /// sha256:<hex> over this manifest with this field set to an empty string.
    pub closure_sha256: String,
}

impl AcceptedProvenanceManifest {
    pub fn from_context(
        context: &AcceptedProvenanceContext,
        records: Vec<AcceptedProvenanceRecord>,
        cas_objects: Vec<AcceptedProvenanceCasObject>,
    ) -> Result<Self> {
        context.validate()?;
        let mut manifest = Self {
            schema_version: ACCEPTED_PROVENANCE_SCHEMA.into(),
            role: ACCEPTED_PROVENANCE_ROLE.into(),
            source_store_binding: context.source_store_binding.clone(),
            accepted_run_id: context.accepted_run_id.clone(),
            captured_live_session_id: context.captured_live_session_id.clone(),
            captured_live_session_epoch: context.captured_live_session_epoch,
            captured_scene_revision: context.captured_scene_revision.clone(),
            records,
            cas_objects,
            closure_sha256: String::new(),
        };
        manifest.validate_without_digest()?;
        manifest.closure_sha256 = manifest.expected_closure_sha256()?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_without_digest()?;
        let expected = self.expected_closure_sha256()?;
        if self.closure_sha256 != expected {
            bail!("accepted provenance closure digest does not match its manifest");
        }
        Ok(())
    }

    pub fn manifest_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec_pretty(self).context("serializing accepted provenance manifest")
    }

    /// Validate the detached record bytes against both the manifest closure
    /// and the same typed identity rules used by the accepted store.
    ///
    /// The FMS archive is untrusted input.  A valid closure digest alone only
    /// proves that the archive is internally consistent; it must not turn an
    /// arbitrary JSON file at an allowed path into accepted-run evidence.
    pub fn validate_detached_records(&self, detached: &BTreeMap<String, Vec<u8>>) -> Result<()> {
        self.validate_detached_records_with_cas(detached, |_| Ok(None))
    }

    /// Validate detached records and derive the complete direct CAS closure
    /// from the typed records.  The optional reader is used only for bounded
    /// typed artifact manifests whose own CAS object references additional
    /// output objects; the archive importer supplies a reader backed by its
    /// hash-checked CAS view.
    pub fn validate_detached_records_with_cas<F>(
        &self,
        detached: &BTreeMap<String, Vec<u8>>,
        read_cas: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        self.validate_detached_records_inner(detached, read_cas, false)
    }

    /// Require every typed metadata read and exactly the derived CAS closure.
    /// The reader owns bounded I/O; this adds no worker or source authority.
    pub fn validate_detached_records_with_exact_cas<F>(
        &self,
        detached: &BTreeMap<String, Vec<u8>>,
        read_cas: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        self.validate()?;
        validate_exact_detached_records(
            &self.accepted_run_id, &self.records, &self.cas_objects, detached, read_cas,
        )
    }

    /// Preserve legacy direct-CAS semantics while admitting explicitly typed H-only ranges.
    pub fn validate_detached_records_with_cas_and_ranges<F, G>(
        &self, detached: &BTreeMap<String, Vec<u8>>, read_cas: F, mut read_range: G,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
        G: FnMut(&str, u64, u64) -> Result<Option<crate::cas::VerifiedCasRange>>,
    {
        self.validate()?;
        validate_detached_records_with_ranges(
            &self.accepted_run_id, &self.records, &self.cas_objects,
            detached, read_cas, false, Some(&mut read_range),
        )
    }

    fn validate_detached_records_inner<F>(
        &self,
        detached: &BTreeMap<String, Vec<u8>>,
        read_cas: F,
        exact_cas: bool,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        self.validate()?;
        validate_accepted_detached_records_without_ranges(
            &self.accepted_run_id,
            &self.records,
            &self.cas_objects,
            detached,
            read_cas,
            exact_cas,
        )
    }

    fn validate_without_digest(&self) -> Result<()> {
        if self.schema_version != ACCEPTED_PROVENANCE_SCHEMA {
            bail!(
                "unsupported accepted provenance schema `{}`",
                self.schema_version
            );
        }
        if self.role != ACCEPTED_PROVENANCE_ROLE {
            bail!("accepted provenance role must be evidence_only");
        }
        AcceptedProvenanceContext {
            source_store_binding: self.source_store_binding.clone(),
            accepted_run_id: self.accepted_run_id.clone(),
            captured_live_session_id: self.captured_live_session_id.clone(),
            captured_live_session_epoch: self.captured_live_session_epoch,
            captured_scene_revision: self.captured_scene_revision.clone(),
        }
        .validate()?;
        validate_manifest_entries(&self.accepted_run_id, &self.records, &self.cas_objects)
    }

    fn expected_closure_sha256(&self) -> Result<String> {
        let mut unsigned = self.clone();
        unsigned.closure_sha256.clear();
        let value = serde_json::to_value(unsigned)
            .context("serializing accepted provenance closure digest input")?;
        Ok(format!("sha256:{}", canonical_json_sha256(&value)))
    }
    /// Exact typed closure with streamed package ranges instead of full bundle allocation.
    pub fn validate_detached_records_with_exact_cas_and_ranges<F, G>(
        &self, detached: &BTreeMap<String, Vec<u8>>, mut read_cas: F, mut read_range: G,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
        G: FnMut(&str, u64, u64) -> Result<Option<crate::cas::VerifiedCasRange>>,
    {
        self.validate()?;
        validate_detached_records_with_ranges(
            &self.accepted_run_id, &self.records, &self.cas_objects, detached, |object| {
                Ok(Some(read_cas(object)?.with_context(|| format!(
                    "exact accepted provenance typed metadata CAS object is missing: {object}"
                ))?))
            }, true, Some(&mut read_range),
        )
    }

}

/// Genuine accepted-store capture identity, independent of a live UI session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedStoreProvenanceContext {
    pub source_store_binding: String,
    pub accepted_run_id: String,
}

impl AcceptedStoreProvenanceContext {
    pub fn validate(&self) -> Result<()> {
        validate_digest(&self.source_store_binding, "source_store_binding")?;
        crate::repository_path::validate_store_id(&self.accepted_run_id)
            .context("accepted provenance run id")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptedStoreCaptureKind {
    AcceptedStore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedStoreCapture {
    pub kind: AcceptedStoreCaptureKind,
}

/// Additive headless evidence format. It cannot contain live-session identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptedStoreProvenanceManifest {
    pub schema_version: String,
    pub role: String,
    pub capture: AcceptedStoreCapture,
    pub source_store_binding: String,
    pub accepted_run_id: String,
    pub records: Vec<AcceptedProvenanceRecord>,
    pub cas_objects: Vec<AcceptedProvenanceCasObject>,
    pub closure_sha256: String,
}

impl AcceptedStoreProvenanceManifest {
    pub fn from_context(
        context: &AcceptedStoreProvenanceContext,
        records: Vec<AcceptedProvenanceRecord>,
        cas_objects: Vec<AcceptedProvenanceCasObject>,
    ) -> Result<Self> {
        context.validate()?;
        let mut manifest = Self {
            schema_version: ACCEPTED_STORE_PROVENANCE_SCHEMA.into(),
            role: ACCEPTED_PROVENANCE_ROLE.into(),
            capture: AcceptedStoreCapture {
                kind: AcceptedStoreCaptureKind::AcceptedStore,
            },
            source_store_binding: context.source_store_binding.clone(),
            accepted_run_id: context.accepted_run_id.clone(),
            records,
            cas_objects,
            closure_sha256: String::new(),
        };
        manifest.validate_without_digest()?;
        manifest.closure_sha256 = manifest.expected_closure_sha256()?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate_without_digest(&self) -> Result<()> {
        if self.schema_version != ACCEPTED_STORE_PROVENANCE_SCHEMA {
            bail!(
                "unsupported accepted-store provenance schema `{}`",
                self.schema_version
            );
        }
        if self.role != ACCEPTED_PROVENANCE_ROLE {
            bail!("accepted provenance role must be evidence_only");
        }
        AcceptedStoreProvenanceContext {
            source_store_binding: self.source_store_binding.clone(),
            accepted_run_id: self.accepted_run_id.clone(),
        }
        .validate()?;
        validate_manifest_entries(&self.accepted_run_id, &self.records, &self.cas_objects)
    }

    fn expected_closure_sha256(&self) -> Result<String> {
        let mut unsigned = self.clone();
        unsigned.closure_sha256.clear();
        let value = serde_json::to_value(unsigned)
            .context("serializing accepted-store provenance closure digest input")?;
        Ok(format!("sha256:{}", canonical_json_sha256(&value)))
    }

    pub fn validate(&self) -> Result<()> {
        self.validate_without_digest()?;
        if self.closure_sha256 != self.expected_closure_sha256()? {
            bail!("accepted provenance closure digest does not match its manifest");
        }
        Ok(())
    }

    pub fn manifest_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        serde_json::to_vec_pretty(self).context("serializing accepted-store provenance manifest")
    }

    pub fn validate_detached_records_with_exact_cas<F>(
        &self,
        detached: &BTreeMap<String, Vec<u8>>,
        read_cas: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        self.validate()?;
        validate_exact_detached_records(
            &self.accepted_run_id,
            &self.records,
            &self.cas_objects,
            detached,
            read_cas,
        )
    }
    /// Exact typed closure with streamed package ranges instead of full bundle allocation.
    pub fn validate_detached_records_with_exact_cas_and_ranges<F, G>(
        &self, detached: &BTreeMap<String, Vec<u8>>, mut read_cas: F, mut read_range: G,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
        G: FnMut(&str, u64, u64) -> Result<Option<crate::cas::VerifiedCasRange>>,
    {
        self.validate()?;
        validate_detached_records_with_ranges(
            &self.accepted_run_id, &self.records, &self.cas_objects, detached, |object| {
                Ok(Some(read_cas(object)?.with_context(|| format!(
                    "exact accepted provenance typed metadata CAS object is missing: {object}"
                ))?))
            }, true, Some(&mut read_range),
        )
    }

}

/// Explicit dispatch for consumers that intentionally accept both evidence formats.
/// Existing v1 import/export entry points keep their original manifest type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcceptedEvidenceManifest {
    Live(AcceptedProvenanceManifest),
    Store(AcceptedStoreProvenanceManifest),
}

impl From<AcceptedProvenanceManifest> for AcceptedEvidenceManifest {
    fn from(manifest: AcceptedProvenanceManifest) -> Self {
        Self::Live(manifest)
    }
}

impl From<AcceptedStoreProvenanceManifest> for AcceptedEvidenceManifest {
    fn from(manifest: AcceptedStoreProvenanceManifest) -> Self {
        Self::Store(manifest)
    }
}

impl Serialize for AcceptedEvidenceManifest {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Live(manifest) => manifest.serialize(serializer),
            Self::Store(manifest) => manifest.serialize(serializer),
        }
    }
}

impl AcceptedEvidenceManifest {
    /// Dispatch the original bytes, so typed duplicate/unknown-field refusals survive.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        #[derive(Deserialize)]
        struct Header {
            schema_version: String,
        }
        let header: Header =
            serde_json::from_slice(bytes).context("reading accepted evidence schema")?;
        let manifest = match header.schema_version.as_str() {
            ACCEPTED_PROVENANCE_SCHEMA => {
                Self::Live(serde_json::from_slice(bytes).context("reading live accepted evidence")?)
            }
            ACCEPTED_STORE_PROVENANCE_SCHEMA => Self::Store(
                serde_json::from_slice(bytes).context("reading accepted-store evidence")?,
            ),
            schema => bail!("unsupported accepted evidence schema `{schema}`"),
        };
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn closure_sha256(&self) -> &str {
        match self {
            Self::Live(m) => &m.closure_sha256,
            Self::Store(m) => &m.closure_sha256,
        }
    }
    pub fn accepted_run_id(&self) -> &str {
        match self {
            Self::Live(m) => &m.accepted_run_id,
            Self::Store(m) => &m.accepted_run_id,
        }
    }
    pub fn source_store_binding(&self) -> &str {
        match self {
            Self::Live(m) => &m.source_store_binding,
            Self::Store(m) => &m.source_store_binding,
        }
    }
    pub fn records(&self) -> &[AcceptedProvenanceRecord] {
        match self {
            Self::Live(m) => &m.records,
            Self::Store(m) => &m.records,
        }
    }
    pub fn cas_objects(&self) -> &[AcceptedProvenanceCasObject] {
        match self {
            Self::Live(m) => &m.cas_objects,
            Self::Store(m) => &m.cas_objects,
        }
    }
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Live(m) => m.validate(),
            Self::Store(m) => m.validate(),
        }
    }
    pub fn manifest_bytes(&self) -> Result<Vec<u8>> {
        match self {
            Self::Live(m) => m.manifest_bytes(),
            Self::Store(m) => m.manifest_bytes(),
        }
    }
    pub fn validate_detached_records_with_exact_cas<F>(
        &self,
        detached: &BTreeMap<String, Vec<u8>>,
        read_cas: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        self.validate()?;
        validate_exact_detached_records(
            self.accepted_run_id(),
            self.records(),
            self.cas_objects(),
            detached,
            read_cas,
        )
    }
    /// Exact typed closure with streamed package ranges instead of full bundle allocation.
    pub fn validate_detached_records_with_exact_cas_and_ranges<F, G>(
        &self, detached: &BTreeMap<String, Vec<u8>>, mut read_cas: F, mut read_range: G,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
        G: FnMut(&str, u64, u64) -> Result<Option<crate::cas::VerifiedCasRange>>,
    {
        self.validate()?;
        validate_detached_records_with_ranges(
            self.accepted_run_id(), self.records(), self.cas_objects(), detached, |object| {
                Ok(Some(read_cas(object)?.with_context(|| format!(
                    "exact accepted provenance typed metadata CAS object is missing: {object}"
                ))?))
            }, true, Some(&mut read_range),
        )
    }

}

fn validate_manifest_entries(
    accepted_run_id: &str,
    records: &[AcceptedProvenanceRecord],
    cas_objects: &[AcceptedProvenanceCasObject],
) -> Result<()> {
    if records.is_empty() {
        bail!("accepted provenance closure has no control records");
    }
    if records.len() > MAX_ACCEPTED_PROVENANCE_RECORDS {
        bail!("accepted provenance closure has too many control records");
    }
    if cas_objects.len() > MAX_ACCEPTED_PROVENANCE_OBJECTS {
        bail!("accepted provenance closure has too many CAS objects");
    }

    let mut record_paths = BTreeSet::new();
    for record in records {
        validate_record(record, accepted_run_id)?;
        if !record_paths.insert(record.archive_path.as_str()) {
            bail!("duplicate accepted provenance archive record path");
        }
    }
    let mut object_refs = BTreeSet::new();
    let empty_content_sha256 = crate::hex_sha256(b"");
    for object in cas_objects {
        crate::cas::validate_hash(&object.object_ref)?;
        if (object.byte_count == 0) != (object.object_ref == empty_content_sha256) {
            bail!("accepted provenance CAS object length differs from its empty-content identity");
        }
        if !object_refs.insert(object.object_ref.as_str()) {
            bail!("duplicate accepted provenance CAS object");
        }
    }
    Ok(())
}

fn validate_exact_detached_records<F>(
    accepted_run_id: &str,
    records: &[AcceptedProvenanceRecord],
    cas_objects: &[AcceptedProvenanceCasObject],
    detached: &BTreeMap<String, Vec<u8>>,
    mut read_cas: F,
) -> Result<()>
where
    F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    validate_accepted_detached_records_without_ranges(
        accepted_run_id,
        records,
        cas_objects,
        detached,
        |object_ref| {
            let bytes = read_cas(object_ref)?.with_context(|| {
                format!(
                    "exact accepted provenance typed metadata CAS object is missing: {object_ref}"
                )
            })?;
            Ok(Some(bytes))
        },
        true,
    )
}

fn validate_accepted_detached_records_without_ranges<F>(
    accepted_run_id: &str,
    records: &[AcceptedProvenanceRecord],
    cas_objects: &[AcceptedProvenanceCasObject],
    detached: &BTreeMap<String, Vec<u8>>,
    read_cas: F,
    exact_cas: bool,
) -> Result<()>
where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    validate_detached_records_with_ranges(
        accepted_run_id, records, cas_objects, detached, read_cas, exact_cas, None,
    )
}

fn validate_detached_records_with_ranges<F>(
    accepted_run_id: &str,
    records: &[AcceptedProvenanceRecord],
    cas_objects: &[AcceptedProvenanceCasObject],
    detached: &BTreeMap<String, Vec<u8>>,
    mut read_cas: F,
    exact_cas: bool,
    mut ranges: Option<&mut AcceptedEvidenceRangeReader<'_>>,
) -> Result<()>
where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    let mut walk = retained::RetainedClosureWalk::default();
    validate_accepted_detached_records(
        accepted_run_id, records, cas_objects, detached, &mut read_cas,
        exact_cas, &mut ranges, &mut walk,
    )?;
    walk.finish(&mut read_cas, &mut ranges)
}

fn validate_accepted_detached_records<F>(
    accepted_run_id: &str,
    records: &[AcceptedProvenanceRecord],
    cas_objects: &[AcceptedProvenanceCasObject],
    detached: &BTreeMap<String, Vec<u8>>,
    mut read_cas: F,
    exact_cas: bool,
    ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    walk: &mut retained::RetainedClosureWalk,
) -> Result<()>
where
    F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    let record_paths = records.iter().map(|record| record.archive_path.as_str()).collect::<BTreeSet<_>>();
    if detached.len() != records.len()
        || detached.keys().any(|path| !record_paths.contains(path.as_str()))
    {
        bail!("accepted provenance detached records do not match the manifest closure");
    }

    let mut intent = None;
    let mut catalog = None;
    let mut artifact_catalog = None;
    let mut task_receipts = BTreeMap::new();
    let mut stage_receipts = Vec::new();
    let mut solution_sets = BTreeMap::<
        String,
        (
            Option<fullmag_quantities::SolutionSet>,
            BTreeMap<u64, fullmag_quantities::SolutionSet>,
        ),
    >::new();

    for record in records {
        let bytes = detached
            .get(&record.archive_path)
            .with_context(|| format!("detached record is missing: {}", record.archive_path))?;
        if bytes.len() as u64 != record.byte_count
            || crate::hex_sha256(bytes) != record.content_sha256
        {
            bail!("detached accepted provenance record digest mismatch");
        }
        match record.kind {
            AcceptedProvenanceRecordKind::RunIntent => {
                let value: FmsRunIntent = serde_json::from_slice(bytes).with_context(|| {
                    format!("detached run intent is not typed: {}", record.archive_path)
                })?;
                value.validate()?;
                if value.run_id != accepted_run_id
                    || record.source_path != format!("runs/{}/run_intent.json", accepted_run_id)
                {
                    bail!("detached run intent identity differs from its accepted run");
                }
                if intent.replace(value).is_some() {
                    bail!("accepted provenance closure contains duplicate run intents");
                }
            }
            AcceptedProvenanceRecordKind::RunCatalog => {
                let value: FmsRunCatalog = serde_json::from_slice(bytes).with_context(|| {
                    format!("detached run catalog is not typed: {}", record.archive_path)
                })?;
                value.validate()?;
                if value.run_id != accepted_run_id
                    || record.source_path != format!("runs/{}/run_catalog.json", accepted_run_id)
                {
                    bail!("detached run catalog identity differs from its accepted run");
                }
                if catalog.replace(value).is_some() {
                    bail!("accepted provenance closure contains duplicate run catalogs");
                }
            }
            AcceptedProvenanceRecordKind::ArtifactCatalog => {
                let value: FmsArtifactCatalog =
                    serde_json::from_slice(bytes).with_context(|| {
                        format!(
                            "detached artifact catalog is not typed: {}",
                            record.archive_path
                        )
                    })?;
                value.validate()?;
                if value.run_id != accepted_run_id {
                    bail!("detached artifact catalog identity differs from its accepted run");
                }
                if artifact_catalog.replace(value).is_some() {
                    bail!("accepted provenance closure contains duplicate artifact catalogs");
                }
            }
            AcceptedProvenanceRecordKind::TaskPreparationReceipt => {
                let value: FmsTaskPreparationReceipt =
                    serde_json::from_slice(bytes).with_context(|| {
                        format!(
                            "detached task receipt is not typed: {}",
                            record.archive_path
                        )
                    })?;
                value.validate()?;
                if value.run_id != accepted_run_id || value.relative_path()? != record.source_path {
                    bail!("detached task receipt path identity differs from its record");
                }
                if task_receipts.insert(value.task_id.clone(), value).is_some() {
                    bail!("accepted provenance closure contains duplicate task receipts");
                }
            }
            AcceptedProvenanceRecordKind::AcceptedStagePreparationReceipt => {
                let value: FmsAcceptedStagePreparationReceipt = serde_json::from_slice(bytes)
                    .with_context(|| {
                        format!(
                            "detached accepted stage receipt is not typed: {}",
                            record.archive_path
                        )
                    })?;
                value.validate()?;
                if value.run_id != accepted_run_id || value.relative_path()? != record.source_path {
                    bail!("detached stage receipt path identity differs from its record");
                }
                stage_receipts.push(value);
            }
            AcceptedProvenanceRecordKind::SolutionSetManifest
            | AcceptedProvenanceRecordKind::SolutionSetRevision => {
                let value: fullmag_quantities::SolutionSet = serde_json::from_slice(bytes)
                    .with_context(|| {
                        format!(
                            "detached solution set is not typed: {}",
                            record.archive_path
                        )
                    })?;
                value
                    .validate()
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                if value.run_id != accepted_run_id {
                    bail!("detached solution set belongs to another run");
                }
                let directory = crate::hex_sha256(value.solution_set_id.as_bytes());
                let expected = match record.kind {
                    AcceptedProvenanceRecordKind::SolutionSetManifest => {
                        format!("solutions/{directory}/manifest.json")
                    }
                    AcceptedProvenanceRecordKind::SolutionSetRevision => {
                        if value.revision == 0 {
                            bail!("detached solution revision must be positive");
                        }
                        format!(
                            "solutions/{directory}/revisions/{:020}.json",
                            value.revision
                        )
                    }
                    _ => unreachable!(),
                };
                if record.source_path != expected {
                    bail!("detached solution set path identity differs from its record");
                }
                let history = solution_sets
                    .entry(value.solution_set_id.clone())
                    .or_insert_with(|| (None, BTreeMap::new()));
                match record.kind {
                    AcceptedProvenanceRecordKind::SolutionSetManifest => {
                        if history.0.replace(value).is_some() {
                            bail!(
                                "accepted provenance closure contains duplicate solution-set manifests"
                            );
                        }
                    }
                    AcceptedProvenanceRecordKind::SolutionSetRevision => {
                        let revision = value.revision;
                        if history.1.insert(revision, value).is_some() {
                            bail!(
                                "accepted provenance closure contains duplicate solution-set revisions"
                            );
                        }
                    }
                    _ => unreachable!(),
                }
            }
        }
    }

    let intent = intent.context("accepted provenance closure has no run intent")?;
    let catalog = catalog.context("accepted provenance closure has no run catalog")?;
    for receipt in task_receipts.values() {
        receipt.validate_for_catalog(&catalog)?;
        receipt.validate_for_run_intent(&intent)?;
    }
    for receipt in stage_receipts {
        let task = task_receipts
            .get(&receipt.task_id)
            .context("detached accepted stage receipt has no task receipt")?;
        if !receipt.matches_task_receipt(task) {
            bail!("detached accepted stage receipt does not match its task receipt");
        }
    }

    let mut required_cas = BTreeSet::new();
    collect_required_intent_objects(&intent, &mut required_cas)?;
    if let Some(artifact_catalog) = &artifact_catalog {
        collect_required_artifact_objects(artifact_catalog, &mut required_cas, &mut read_cas, ranges, walk)?;
    }
    for (_, (current, revisions)) in &solution_sets {
        for solution in current.iter().chain(revisions.values()) {
            collect_required_solution_objects(solution, &mut required_cas, &mut read_cas, ranges, walk)?;
        }
    }
    validate_solution_histories(&solution_sets)?;

    // Only immutable input assets may be empty. A shared CAS digest does
    // not permit an empty solver output, definition, tensor or geometry.
    for object in cas_objects.iter().filter(|object| object.byte_count == 0) {
        if required_cas.contains(&object.object_ref)
            || !intent
                .asset_object_refs
                .values()
                .any(|reference| reference == &object.object_ref)
        {
            bail!(
                "empty accepted provenance CAS object is not exclusively an immutable input asset"
            );
        }
    }
    required_cas.extend(intent.asset_object_refs.values().cloned());

    let declared_cas = cas_objects
        .iter()
        .map(|object| object.object_ref.as_str())
        .collect::<BTreeSet<_>>();
    for object_ref in &required_cas {
        if !declared_cas.contains(object_ref.as_str()) {
            bail!("accepted provenance closure is missing required CAS object `{object_ref}`");
        }
    }
    if exact_cas && declared_cas.len() != required_cas.len() {
        bail!("exact accepted provenance closure contains unrelated CAS objects");
    }
    Ok(())
}

fn collect_required_intent_objects(
    intent: &FmsRunIntent,
    required: &mut BTreeSet<String>,
) -> Result<()> {
    for object_ref in [
        intent.definition_object_ref.as_deref(),
        intent.study_object_ref.as_deref(),
        intent.study_catalog_object_ref.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        add_required_cas_object(required, object_ref, "run intent")?;
    }
    Ok(())
}

fn collect_required_artifact_objects<F>(
    catalog: &FmsArtifactCatalog,
    required: &mut BTreeSet<String>,
    read_cas: &mut F,
    ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    walk: &mut retained::RetainedClosureWalk,
) -> Result<()>
where
    F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    for entry in &catalog.entries {
        let Some(object_ref) = entry.object_ref.as_deref() else {
            if entry.artifact_type == "study_output_manifest" {
                bail!("study output manifest has no CAS object");
            }
            continue;
        };
        add_required_cas_object(required, object_ref, "artifact catalog")?;
        if entry.artifact_type != "study_output_manifest" {
            continue;
        }

        let Some(bytes) = read_cas(object_ref)? else {
            // The importer separately reports a missing listed CAS object.
            // A caller without a CAS reader can still enforce all direct
            // references; nested output coverage is enforced when bytes are
            // available from the archive importer.
            continue;
        };
        if bytes.len() > MAX_ACCEPTED_PROVENANCE_RECORD_BYTES {
            bail!("study output manifest exceeds the control-plane byte budget");
        }
        if crate::hex_sha256(&bytes) != object_ref {
            bail!("study output manifest CAS digest does not match its reference");
        }
        let manifest: FmsStudyOutputManifest = serde_json::from_slice(&bytes)
            .context("study output manifest CAS object is not typed")?;
        manifest.validate()?;
        if manifest.run_id != catalog.run_id
            || manifest.task_id != entry.task_id
            || manifest.attempt_id != entry.attempt_id
            || manifest.ownership_epoch != entry.ownership_epoch
        {
            bail!("study output manifest identity differs from artifact catalog");
        }
        for output in &manifest.outputs {
            add_required_cas_object(required, &output.object_ref, "study output manifest")?;
            if retained::is_retained_codec(&output.codec_id, &output.codec_version)? {
                required.extend(walk.discover(&output.object_ref, None, Some(&output.codec_version), read_cas, ranges)?);
            }
        }
    }
    Ok(())
}

fn collect_required_solution_objects<F>(
    solution: &fullmag_quantities::SolutionSet,
    required: &mut BTreeSet<String>,
    read_cas: &mut F,
    ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    walk: &mut retained::RetainedClosureWalk,
) -> Result<()>
where
    F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    for member in &solution.members {
        for artifact in &member.artifacts {
            add_required_cas_object(required, &artifact.object_ref, "solution set artifact")?;
            if retained::is_retained_solution_schema(&artifact.schema_id)? {
                required.extend(walk.discover(
                    &artifact.object_ref, Some(artifact.byte_length), artifact.schema_id.rsplit_once('@').map(|(_, version)| version), read_cas, ranges,
                )?);
                continue;
            }
            let typed_metadata = matches!(
                artifact.schema_id.as_str(),
                crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA
                    | crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
                    | crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA
            );
            if !typed_metadata {
                continue;
            }
            let Some(bytes) = read_cas(&artifact.object_ref)? else {
                continue;
            };
            match artifact.schema_id.as_str() {
                crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA => {
                    let descriptor = crate::solution_tensor_source::parse_solution_tensor_artifact(
                        &bytes, artifact,
                    )?;
                    for chunk in descriptor.chunks {
                        add_required_cas_object(
                            required,
                            &chunk.object_ref,
                            "solution tensor descriptor",
                        )?;
                    }
                }
                crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA => {
                    let manifest = crate::materialized_dataset::parse_materialized_dataset_artifact(
                        &bytes, artifact,
                    )?;
                    let tensor_artifact = &manifest.field.tensor_artifact;
                    add_required_cas_object(
                        required,
                        &tensor_artifact.object_ref,
                        "materialized dataset manifest",
                    )?;
                    if let Some(tensor_bytes) = read_cas(&tensor_artifact.object_ref)? {
                        let descriptor =
                            crate::solution_tensor_source::parse_solution_tensor_artifact(
                                &tensor_bytes,
                                tensor_artifact,
                            )?;
                        for chunk in descriptor.chunks {
                            add_required_cas_object(
                                required,
                                &chunk.object_ref,
                                "materialized dataset tensor descriptor",
                            )?;
                        }
                    }
                }
                crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA => {
                    let manifest =
                        crate::solution_field_geometry::parse_solution_field_geometry_manifest(
                            &bytes, artifact,
                        )?;
                    add_required_cas_object(
                        required,
                        &manifest.geometry.object_ref,
                        "solution field geometry manifest",
                    )?;
                    let tensor_artifact = &manifest.tensor_artifact;
                    add_required_cas_object(
                        required,
                        &tensor_artifact.object_ref,
                        "solution field geometry manifest",
                    )?;
                    if let Some(tensor_bytes) = read_cas(&tensor_artifact.object_ref)? {
                        let descriptor =
                            crate::solution_tensor_source::parse_solution_tensor_artifact(
                                &tensor_bytes,
                                tensor_artifact,
                            )?;
                        for chunk in descriptor.chunks {
                            add_required_cas_object(
                                required,
                                &chunk.object_ref,
                                "solution field geometry tensor descriptor",
                            )?;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    for coverage in &solution.coverage {
        for segment in &coverage.segments {
            add_required_cas_object(required, &segment.object_ref, "solution set coverage")?;
        }
    }
    Ok(())
}

fn add_required_cas_object(
    required: &mut BTreeSet<String>,
    object_ref: &str,
    owner: &str,
) -> Result<()> {
    crate::cas::validate_hash(object_ref)
        .with_context(|| format!("invalid CAS object reference in {owner}"))?;
    required.insert(object_ref.to_owned());
    Ok(())
}

fn validate_solution_histories(
    histories: &BTreeMap<
        String,
        (
            Option<fullmag_quantities::SolutionSet>,
            BTreeMap<u64, fullmag_quantities::SolutionSet>,
        ),
    >,
) -> Result<()> {
    for (solution_set_id, (current, revisions)) in histories {
        let current = current
            .as_ref()
            .with_context(|| format!("solution set `{solution_set_id}` has no current manifest"))?;
        if revisions.is_empty() {
            bail!("solution set `{solution_set_id}` has no immutable revision history");
        }

        let mut previous = None;
        for (index, (revision, solution)) in revisions.iter().enumerate() {
            let expected = u64::try_from(index + 1).context("solution-set revision overflow")?;
            if *revision != expected || solution.revision != *revision {
                bail!("solution-set revision history has a gap or path mismatch");
            }
            if let Some(previous) = previous {
                crate::solution_set_catalog::validate_successor(previous, solution)?;
            }
            previous = Some(solution);
        }

        let latest = previous.expect("non-empty revision history has a latest revision");
        if current.revision != latest.revision || current != latest {
            bail!(
                "solution-set current manifest conflicts with its immutable revision history"
            );
        }
    }
    Ok(())
}

/// A source entry that the FMS packer can copy after verify_sources passes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedProvenanceSourceRecord {
    pub source_relative_path: String,
    pub archive_path: String,
    pub kind: AcceptedProvenanceRecordKind,
    pub content_sha256: String,
    pub byte_count: u64,
}

/// A source CAS object that the FMS packer can stream into its shared CAS
/// namespace. source_root is never serialized into the archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedProvenanceSourceObject {
    pub source_root: PathBuf,
    pub object_ref: String,
    pub byte_count: u64,
}

/// Read-only plan. No method on this type acquires a writer lease or mutates
/// the accepted store.
#[derive(Debug, Clone)]
pub struct AcceptedProvenancePlan {
    pub source_root: PathBuf,
    pub manifest: AcceptedProvenanceManifest,
    pub records: Vec<AcceptedProvenanceSourceRecord>,
    pub cas_objects: Vec<AcceptedProvenanceSourceObject>,
}

/// Read-only accepted-store plan; it conveys no lease or execution authority.
#[derive(Debug, Clone)]
pub struct AcceptedStoreProvenancePlan {
    pub source_root: PathBuf,
    pub manifest: AcceptedStoreProvenanceManifest,
    pub records: Vec<AcceptedProvenanceSourceRecord>,
    pub cas_objects: Vec<AcceptedProvenanceSourceObject>,
}

struct AcceptedProvenanceSourceView<'a> {
    source_root: &'a Path,
    records: &'a [AcceptedProvenanceSourceRecord],
    cas_objects: &'a [AcceptedProvenanceSourceObject],
}

impl AcceptedProvenancePlan {
    fn sources(&self) -> AcceptedProvenanceSourceView<'_> {
        AcceptedProvenanceSourceView {
            source_root: &self.source_root,
            records: &self.records,
            cas_objects: &self.cas_objects,
        }
    }
    pub fn verify_sources(&self) -> Result<()> {
        self.manifest.validate()?;
        self.sources().verify_sources()
    }
    pub fn read_record(&self, record: &AcceptedProvenanceSourceRecord) -> Result<Vec<u8>> {
        self.sources().read_record(record)
    }
    pub fn cas_source_path(&self, object: &AcceptedProvenanceSourceObject) -> Result<PathBuf> {
        self.sources().cas_source_path(object)
    }
}

impl AcceptedStoreProvenancePlan {
    fn sources(&self) -> AcceptedProvenanceSourceView<'_> {
        AcceptedProvenanceSourceView {
            source_root: &self.source_root,
            records: &self.records,
            cas_objects: &self.cas_objects,
        }
    }
    pub fn verify_sources(&self) -> Result<()> {
        self.manifest.validate()?;
        self.sources().verify_sources()
    }
    pub fn read_record(&self, record: &AcceptedProvenanceSourceRecord) -> Result<Vec<u8>> {
        self.sources().read_record(record)
    }
    pub fn cas_source_path(&self, object: &AcceptedProvenanceSourceObject) -> Result<PathBuf> {
        self.sources().cas_source_path(object)
    }
}

impl AcceptedProvenanceSourceView<'_> {
    pub fn verify_sources(&self) -> Result<()> {
        for record in self.records {
            let bytes = read_bounded_regular_file(
                self.source_root,
                &record.source_relative_path,
                record
                    .byte_count
                    .min(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64) as usize,
            )?;
            if bytes.len() as u64 != record.byte_count
                || crate::hex_sha256(&bytes) != record.content_sha256
            {
                bail!(
                    "accepted provenance source changed: {}",
                    record.source_relative_path
                );
            }
        }
        let store = SessionStore::open_existing(self.source_root)
            .context("opening accepted store for CAS verification")?;
        for object in self.cas_objects {
            let Some(length) = store.cas().verified_length(&object.object_ref)? else {
                bail!(
                    "accepted provenance CAS object is missing: {}",
                    object.object_ref
                );
            };
            if length != object.byte_count {
                bail!("accepted provenance CAS object length changed");
            }
        }
        Ok(())
    }

    pub fn read_record(&self, record: &AcceptedProvenanceSourceRecord) -> Result<Vec<u8>> {
        if !self.records.iter().any(|candidate| candidate == record) {
            bail!("accepted provenance source record is outside the plan");
        }
        let bytes = read_bounded_regular_file(
            self.source_root,
            &record.source_relative_path,
            record
                .byte_count
                .min(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64) as usize,
        )?;
        if bytes.len() as u64 != record.byte_count
            || crate::hex_sha256(&bytes) != record.content_sha256
        {
            bail!("accepted provenance source record changed");
        }
        Ok(bytes)
    }

    pub fn cas_source_path(&self, object: &AcceptedProvenanceSourceObject) -> Result<PathBuf> {
        if !self.cas_objects.iter().any(|candidate| candidate == object) {
            bail!("CAS source is not part of the accepted provenance plan");
        }
        checked_path(
            self.source_root,
            &format!("objects/sha256/{}", object.object_ref),
        )
    }
}

/// Build an immutable evidence plan from a separate accepted store.
///
/// The accepted store is opened with open_existing; this function only reads
/// bounded control records and streams/verifies referenced CAS identities.
pub fn plan_accepted_provenance(
    accepted_store_root: &Path,
    context: &AcceptedProvenanceContext,
) -> Result<AcceptedProvenancePlan> {
    plan_accepted_provenance_inner(accepted_store_root, context, None)
}

/// Plan the same accepted evidence closure while bounding the aggregate bytes
/// of direct control records before reading them. CAS descriptors retain their
/// existing per-object bounds and are not charged as direct control records.
pub fn plan_accepted_provenance_with_record_budget(
    accepted_store_root: &Path,
    context: &AcceptedProvenanceContext,
    maximum_record_bytes: u64,
) -> Result<AcceptedProvenancePlan> {
    plan_accepted_provenance_inner(accepted_store_root, context, Some(maximum_record_bytes))
}

fn plan_accepted_provenance_inner(
    accepted_store_root: &Path,
    context: &AcceptedProvenanceContext,
    maximum_record_bytes: Option<u64>,
) -> Result<AcceptedProvenancePlan> {
    context.validate()?;
    let sources = plan_accepted_evidence_sources(
        accepted_store_root,
        &context.accepted_run_id,
        maximum_record_bytes,
    )?;
    let manifest = AcceptedProvenanceManifest::from_context(
        context,
        sources.records.clone(),
        sources.cas_objects.clone(),
    )?;
    let (source_root, records, cas_objects) = sources.into_sources();
    let plan = AcceptedProvenancePlan {
        source_root,
        manifest,
        records,
        cas_objects,
    };
    plan.verify_sources()?;
    Ok(plan)
}

/// Capture the same typed record/CAS inventory without requiring a live session.
pub fn plan_accepted_store_provenance_with_record_budget(
    accepted_store_root: &Path,
    context: &AcceptedStoreProvenanceContext,
    maximum_record_bytes: u64,
) -> Result<AcceptedStoreProvenancePlan> {
    context.validate()?;
    let sources = plan_accepted_evidence_sources(
        accepted_store_root,
        &context.accepted_run_id,
        Some(maximum_record_bytes),
    )?;
    let manifest = AcceptedStoreProvenanceManifest::from_context(
        context,
        sources.records.clone(),
        sources.cas_objects.clone(),
    )?;
    let (source_root, records, cas_objects) = sources.into_sources();
    let plan = AcceptedStoreProvenancePlan {
        source_root,
        manifest,
        records,
        cas_objects,
    };
    plan.verify_sources()?;
    Ok(plan)
}

struct PlannedAcceptedEvidence {
    source_root: PathBuf,
    records: Vec<AcceptedProvenanceRecord>,
    cas_objects: Vec<AcceptedProvenanceCasObject>,
}

impl PlannedAcceptedEvidence {
    fn into_sources(
        self,
    ) -> (
        PathBuf,
        Vec<AcceptedProvenanceSourceRecord>,
        Vec<AcceptedProvenanceSourceObject>,
    ) {
        let root = self.source_root;
        let records = self
            .records
            .into_iter()
            .map(|record| AcceptedProvenanceSourceRecord {
                source_relative_path: record.source_path,
                archive_path: record.archive_path,
                kind: record.kind,
                content_sha256: record.content_sha256,
                byte_count: record.byte_count,
            })
            .collect();
        let objects = self
            .cas_objects
            .into_iter()
            .map(|object| AcceptedProvenanceSourceObject {
                source_root: root.clone(),
                object_ref: object.object_ref,
                byte_count: object.byte_count,
            })
            .collect();
        (root, records, objects)
    }
}

fn plan_accepted_evidence_sources(
    accepted_store_root: &Path,
    accepted_run_id: &str,
    maximum_record_bytes: Option<u64>,
) -> Result<PlannedAcceptedEvidence> {
    let mut reader = ControlRecordReader::new(maximum_record_bytes);
    crate::repository_path::reject_link(accepted_store_root)?;
    let source_root = fs::canonicalize(accepted_store_root)
        .context("canonicalizing accepted provenance source root")?;
    let store = SessionStore::open_existing(&source_root)
        .context("opening accepted provenance source store")?;

    let mut records = BTreeMap::<String, AcceptedProvenanceRecord>::new();
    let mut cas_objects = BTreeMap::<String, AcceptedProvenanceCasObject>::new();
    let intent_relative = format!("runs/{}/run_intent.json", accepted_run_id);
    let intent_bytes = add_control_record(
        &source_root,
        &mut reader,
        &mut records,
        accepted_run_id,
        AcceptedProvenanceRecordKind::RunIntent,
        &intent_relative,
    )?;
    let intent: FmsRunIntent = serde_json::from_slice(&intent_bytes)
        .context("accepted provenance run intent is not typed")?;
    intent.validate()?;
    if intent.run_id != accepted_run_id {
        bail!("accepted provenance run intent identity differs from requested run");
    }
    for object_ref in [
        intent.definition_object_ref.as_deref(),
        intent.study_object_ref.as_deref(),
        intent.study_catalog_object_ref.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        add_cas_object(&store, &mut cas_objects, object_ref)?;
    }
    for object_ref in intent.asset_object_refs.values() {
        add_cas_object_for_role(
            &store,
            &mut cas_objects,
            object_ref,
            CasObjectRole::InputAsset,
        )?;
    }

    let catalog_relative = format!("runs/{}/run_catalog.json", accepted_run_id);
    let catalog_bytes = add_control_record(
        &source_root,
        &mut reader,
        &mut records,
        accepted_run_id,
        AcceptedProvenanceRecordKind::RunCatalog,
        &catalog_relative,
    )?;
    let catalog: FmsRunCatalog = serde_json::from_slice(&catalog_bytes)
        .context("accepted provenance run catalog is not typed")?;
    catalog.validate()?;
    if catalog.run_id != accepted_run_id {
        bail!("accepted provenance run catalog identity differs from requested run");
    }

    let mut task_receipts = BTreeMap::new();
    let task_dir = format!("runs/{}/task_preparation_receipts", accepted_run_id);
    for relative in
        read_control_directory_paths(&source_root, &task_dir, reader.remaining_records())?
    {
        let bytes = reader.read(&source_root, &relative)?;
        let receipt: FmsTaskPreparationReceipt = serde_json::from_slice(&bytes)
            .with_context(|| format!("task receipt `{relative}` is not typed"))?;
        receipt.validate_for_catalog(&catalog)?;
        receipt.validate_for_run_intent(&intent)?;
        if receipt.relative_path()? != relative {
            bail!("task receipt path identity mismatch: {relative}");
        }
        task_receipts.insert(receipt.task_id.clone(), receipt);
        add_control_record_with_bytes(
            &mut records,
            accepted_run_id,
            AcceptedProvenanceRecordKind::TaskPreparationReceipt,
            &relative,
            &bytes,
        )?;
    }

    let stage_dir = format!(
        "runs/{}/accepted_stage_preparation_receipts",
        accepted_run_id
    );
    for relative in
        read_control_directory_paths(&source_root, &stage_dir, reader.remaining_records())?
    {
        let bytes = reader.read(&source_root, &relative)?;
        let receipt: FmsAcceptedStagePreparationReceipt = serde_json::from_slice(&bytes)
            .with_context(|| format!("accepted stage receipt `{relative}` is not typed"))?;
        receipt.validate()?;
        let task = task_receipts
            .get(&receipt.task_id)
            .context("accepted stage receipt task receipt is missing")?;
        if !receipt.matches_task_receipt(task) || receipt.relative_path()? != relative {
            bail!("accepted stage receipt does not match its task receipt");
        }
        add_control_record_with_bytes(
            &mut records,
            accepted_run_id,
            AcceptedProvenanceRecordKind::AcceptedStagePreparationReceipt,
            &relative,
            &bytes,
        )?;
    }

    let artifact_relative = format!("runs/{}/artifact_catalog.json", accepted_run_id);
    if let Some(bytes) = read_optional_control(&source_root, &artifact_relative, &mut reader)? {
        let artifact_catalog: FmsArtifactCatalog = serde_json::from_slice(&bytes)
            .context("accepted provenance artifact catalog is not typed")?;
        artifact_catalog.validate()?;
        if artifact_catalog.run_id != accepted_run_id {
            bail!("accepted provenance artifact catalog identity differs from run");
        }
        add_control_record_with_bytes(
            &mut records,
            accepted_run_id,
            AcceptedProvenanceRecordKind::ArtifactCatalog,
            &artifact_relative,
            &bytes,
        )?;
        collect_artifact_objects(&store, &artifact_catalog, &mut cas_objects)?;
    }

    collect_solution_objects(
        &source_root,
        &store,
        accepted_run_id,
        &intent,
        &mut reader,
        &mut records,
        &mut cas_objects,
    )?;

    let records = records.into_values().collect::<Vec<_>>();
    let cas_objects = cas_objects.into_values().collect::<Vec<_>>();
    Ok(PlannedAcceptedEvidence {
        source_root,
        records,
        cas_objects,
    })
}

fn collect_artifact_objects(
    store: &SessionStore,
    catalog: &FmsArtifactCatalog,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
) -> Result<()> {
    for entry in &catalog.entries {
        if let Some(object_ref) = &entry.object_ref {
            add_cas_object(store, objects, object_ref)?;
        }
        if entry.artifact_type != "study_output_manifest" {
            continue;
        }
        let object_ref = entry
            .object_ref
            .as_deref()
            .context("study output manifest has no CAS object")?;
        let byte_count = store
            .cas()
            .verified_length(object_ref)?
            .context("study output manifest CAS object is missing")?;
        if byte_count > MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64 {
            bail!("study output manifest exceeds the control-plane byte budget");
        }
        let range = store
            .cas()
            .get_verified_range(
                object_ref,
                0,
                byte_count,
                MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64,
            )?
            .context("study output manifest CAS object disappeared")?;
        let manifest: FmsStudyOutputManifest = serde_json::from_slice(&range.bytes)
            .context("study output manifest CAS object is not typed")?;
        manifest.validate()?;
        if manifest.run_id != catalog.run_id
            || manifest.task_id != entry.task_id
            || manifest.attempt_id != entry.attempt_id
            || manifest.ownership_epoch != entry.ownership_epoch
        {
            bail!("study output manifest identity differs from artifact catalog");
        }
        for output in &manifest.outputs {
            add_cas_object(store, objects, &output.object_ref)?;
            if retained::is_retained_codec(&output.codec_id, &output.codec_version)? {
                retained::collect_source_objects(store, &output.object_ref, None, &output.codec_version, objects)?;
            }
        }
    }
    Ok(())
}

fn collect_solution_objects(
    root: &Path,
    store: &SessionStore,
    run_id: &str,
    intent: &FmsRunIntent,
    reader: &mut ControlRecordReader,
    records: &mut BTreeMap<String, AcceptedProvenanceRecord>,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
) -> Result<()> {
    let solutions_root = checked_path(root, "solutions")?;
    if !solutions_root.exists() {
        return Ok(());
    }
    crate::repository_path::reject_link(&solutions_root)?;
    if !solutions_root.is_dir() {
        bail!("accepted provenance solutions root is not a directory");
    }
    let mut directories = Vec::new();
    for entry in fs::read_dir(&solutions_root)? {
        let entry = entry?;
        crate::repository_path::reject_link(&entry.path())?;
        if !entry.file_type()?.is_dir() {
            bail!("accepted provenance solution entry is not a directory");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("solution directory name is not UTF-8"))?;
        validate_hex_object_ref(&name, "solution directory")?;
        if reader.remaining_records().is_some_and(|remaining| directories.len() >= remaining) {
            bail!("accepted provenance control record count exceeds its budget");
        }
        directories.push(name);
    }
    directories.sort_unstable();
    for directory in directories {
        let manifest_relative = format!("solutions/{directory}/manifest.json");
        let manifest_bytes = reader.read(root, &manifest_relative)?;
        let current: fullmag_quantities::SolutionSet = serde_json::from_slice(&manifest_bytes)
            .with_context(|| format!("solution set `{manifest_relative}` is not typed"))?;
        current
            .validate()
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        if crate::hex_sha256(current.solution_set_id.as_bytes()) != directory
            || current.run_id != run_id
        {
            continue;
        }
        add_control_record_with_bytes(
            records,
            run_id,
            AcceptedProvenanceRecordKind::SolutionSetManifest,
            &manifest_relative,
            &manifest_bytes,
        )?;

        let revisions_relative = format!("solutions/{directory}/revisions");
        let mut revisions = BTreeMap::new();
        for relative in
            read_control_directory_paths(root, &revisions_relative, reader.remaining_records())?
        {
            let bytes = reader.read(root, &relative)?;
            let solution: fullmag_quantities::SolutionSet = serde_json::from_slice(&bytes)
                .with_context(|| format!("solution revision `{relative}` is not typed"))?;
            solution
                .validate()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if solution.solution_set_id != current.solution_set_id
                || solution.run_id != run_id
                || crate::hex_sha256(solution.solution_set_id.as_bytes()) != directory
            {
                bail!("solution revision owner identity mismatch");
            }
            add_control_record_with_bytes(
                records,
                run_id,
                AcceptedProvenanceRecordKind::SolutionSetRevision,
                &relative,
                &bytes,
            )?;
            if revisions.insert(solution.revision, solution).is_some() {
                bail!("duplicate solution-set revision in accepted provenance source");
            }
        }
        let history = BTreeMap::from([(
            current.solution_set_id.clone(),
            (Some(current), revisions),
        )]);
        validate_solution_histories(&history)?;
        let (_, revisions) = history
            .into_values()
            .next()
            .expect("accepted solution history was just inserted");
        for solution in revisions.values() {
            collect_solution_revision_objects(root, store, solution, intent, objects)?;
        }
    }
    Ok(())
}

fn collect_solution_revision_objects(
    root: &Path,
    store: &SessionStore,
    solution: &fullmag_quantities::SolutionSet,
    intent: &FmsRunIntent,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
) -> Result<()> {
    let has_typed_artifact = solution.members.iter().any(|member| {
        member.artifacts.iter().any(|artifact| {
            artifact.schema_id == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA
                || artifact.schema_id == crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
                || artifact.schema_id
                    == crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA
        })
    });
    if has_typed_artifact {
        let expected = format!("sha256:{}", intent.payload_sha256);
        if solution.provenance.run_spec_digest != expected {
            bail!("typed solution set RunSpec owner digest differs from accepted intent");
        }
        crate::solution_tensor_source::verify_solution_tensor_run_owner(root, solution)?;
        crate::materialized_dataset::verify_materialized_datasets_for_solution(
            root,
            store.cas(),
            solution,
        )?;
        crate::solution_field_geometry::verify_field_geometries_for_solution(
            root,
            store.cas(),
            solution,
        )?;
    }
    for member in &solution.members {
        for artifact in &member.artifacts {
            add_cas_object(store, objects, &artifact.object_ref)?;
            if retained::is_retained_solution_schema(&artifact.schema_id)? {
                retained::collect_source_objects(store, &artifact.object_ref, Some(artifact.byte_length),
                    artifact.schema_id.rsplit_once('@').context("retained schema version absent")?.1, objects)?;
                continue;
            }
            if artifact.schema_id == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA {
                let descriptor = crate::solution_tensor_source::read_solution_tensor_artifact(
                    store.cas(),
                    artifact,
                )?;
                for chunk in descriptor.chunks {
                    add_cas_object(store, objects, &chunk.object_ref)?;
                }
            } else if artifact.schema_id == crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
            {
                let dataset = crate::materialized_dataset::verify_materialized_dataset_payload(
                    store.cas(),
                    artifact,
                )?;
                add_cas_object(store, objects, &dataset.field.tensor_artifact.object_ref)?;
                let descriptor = crate::solution_tensor_source::read_solution_tensor_artifact(
                    store.cas(),
                    &dataset.field.tensor_artifact,
                )?;
                for chunk in descriptor.chunks {
                    add_cas_object(store, objects, &chunk.object_ref)?;
                }
            } else if artifact.schema_id
                == crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA
            {
                let geometry =
                    crate::solution_field_geometry::read_solution_field_geometry_manifest(
                        store.cas(),
                        artifact,
                    )?;
                add_cas_object(store, objects, &geometry.geometry.object_ref)?;
                add_cas_object(store, objects, &geometry.tensor_artifact.object_ref)?;
                let descriptor = crate::solution_tensor_source::read_solution_tensor_artifact(
                    store.cas(),
                    &geometry.tensor_artifact,
                )?;
                for chunk in descriptor.chunks {
                    add_cas_object(store, objects, &chunk.object_ref)?;
                }
            }
        }
    }
    for coverage in &solution.coverage {
        for segment in &coverage.segments {
            add_cas_object(store, objects, &segment.object_ref)?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CasObjectRole {
    RequiredData,
    InputAsset,
}

fn add_cas_object(
    store: &SessionStore,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
    object_ref: &str,
) -> Result<()> {
    add_cas_object_for_role(store, objects, object_ref, CasObjectRole::RequiredData)
}

fn add_cas_object_for_role(
    store: &SessionStore,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
    object_ref: &str,
    role: CasObjectRole,
) -> Result<()> {
    crate::cas::validate_hash(object_ref)?;
    let byte_count = store
        .cas()
        .verified_length(object_ref)?
        .with_context(|| format!("accepted provenance CAS object is missing: {object_ref}"))?;
    if byte_count == 0 && role != CasObjectRole::InputAsset {
        bail!("accepted provenance CAS object is empty: {object_ref}");
    }
    if let Some(previous) = objects.get(object_ref) {
        if previous.byte_count != byte_count {
            bail!("accepted provenance CAS object length changed");
        }
    } else {
        objects.insert(
            object_ref.to_owned(),
            AcceptedProvenanceCasObject {
                object_ref: object_ref.to_owned(),
                byte_count,
            },
        );
    }
    Ok(())
}

fn add_control_record(
    root: &Path,
    reader: &mut ControlRecordReader,
    records: &mut BTreeMap<String, AcceptedProvenanceRecord>,
    run_id: &str,
    kind: AcceptedProvenanceRecordKind,
    source_path: &str,
) -> Result<Vec<u8>> {
    let bytes = reader.read(root, source_path)?;
    add_control_record_with_bytes(records, run_id, kind, source_path, &bytes)?;
    Ok(bytes)
}

fn add_control_record_with_bytes(
    records: &mut BTreeMap<String, AcceptedProvenanceRecord>,
    run_id: &str,
    kind: AcceptedProvenanceRecordKind,
    source_path: &str,
    bytes: &[u8],
) -> Result<()> {
    let record = AcceptedProvenanceRecord {
        kind,
        source_path: source_path.to_owned(),
        archive_path: format!("{ACCEPTED_PROVENANCE_ARCHIVE_PREFIX}/{source_path}"),
        content_sha256: crate::hex_sha256(bytes),
        byte_count: bytes.len() as u64,
    };
    validate_record(&record, run_id)?;
    let content_sha256 = record.content_sha256.clone();
    let byte_count = record.byte_count;
    if let Some(previous) = records.insert(source_path.to_owned(), record) {
        if previous.content_sha256 != content_sha256
            || previous.kind != kind
            || previous.byte_count != byte_count
        {
            bail!("accepted provenance record path has conflicting content");
        }
    }
    Ok(())
}

/// Charges each unique direct metadata path once during planning. The final
/// source verification is a separate pass and never consumes this budget again.
struct ControlRecordReader {
    maximum_bytes: Option<u64>,
    consumed_bytes: u64,
    source_lengths: BTreeMap<String, u64>,
}

impl ControlRecordReader {
    fn new(maximum_bytes: Option<u64>) -> Self {
        Self {
            maximum_bytes,
            consumed_bytes: 0,
            source_lengths: BTreeMap::new(),
        }
    }

    fn remaining_records(&self) -> Option<usize> {
        self.maximum_bytes
            .map(|_| MAX_ACCEPTED_PROVENANCE_RECORDS - self.source_lengths.len())
    }

    fn read(&mut self, root: &Path, relative: &str) -> Result<Vec<u8>> {
        let Some(maximum_bytes) = self.maximum_bytes else {
            return read_control(root, relative);
        };
        let previous_length = self.source_lengths.get(relative).copied();
        if previous_length.is_none() && self.source_lengths.len() >= MAX_ACCEPTED_PROVENANCE_RECORDS {
            bail!("accepted provenance control record count exceeds its budget");
        }
        let available = previous_length.unwrap_or(maximum_bytes - self.consumed_bytes);
        let maximum = available.min(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64) as usize;
        // The regular-file reader checks path and opened-handle lengths before
        // allocation, then caps the read as well if a file grows concurrently.
        let bytes = read_bounded_regular_file(root, relative, maximum)
            .context("reading accepted provenance within its control record byte budget")?;
        let length = bytes.len() as u64;
        if let Some(previous_length) = previous_length {
            if previous_length != length {
                bail!("accepted provenance control record length changed");
            }
        } else {
            self.consumed_bytes = self.consumed_bytes
                .checked_add(length)
                .context("accepted provenance control record byte total overflow")?;
            self.source_lengths.insert(relative.to_owned(), length);
        }
        Ok(bytes)
    }
}

fn read_control(root: &Path, relative: &str) -> Result<Vec<u8>> {
    validate_relative_path(relative)?;
    read_bounded_regular_file(root, relative, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)
}

fn read_optional_control(
    root: &Path,
    relative: &str,
    reader: &mut ControlRecordReader,
) -> Result<Option<Vec<u8>>> {
    let path = checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => reader.read(root, relative).map(Some),
        Ok(_) => bail!("accepted provenance optional control record is not a file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_control_directory_paths(
    root: &Path,
    relative: &str,
    maximum_entries: Option<usize>,
) -> Result<Vec<String>> {
    let directory = checked_path(root, relative)?;
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => bail!("accepted provenance control directory is not a directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    }
    crate::repository_path::reject_link(&directory)?;
    let mut names = Vec::new();
    for entry in fs::read_dir(&directory)? {
        let entry = entry?;
        crate::repository_path::reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("accepted provenance control directory contains a non-file");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("accepted provenance control name is not UTF-8"))?;
        if !name.ends_with(".json") {
            bail!("accepted provenance control file is not JSON: {name}");
        }
        crate::repository_path::validate_store_id(name.trim_end_matches(".json"))?;
        if maximum_entries.is_some_and(|maximum| names.len() >= maximum) {
            bail!("accepted provenance control record count exceeds its budget");
        }
        names.push(name);
    }
    names.sort_unstable();
    Ok(names
        .into_iter()
        .map(|name| format!("{relative}/{name}"))
        .collect())
}

fn validate_record(record: &AcceptedProvenanceRecord, run_id: &str) -> Result<()> {
    validate_relative_path(&record.source_path)?;
    validate_relative_path(&record.archive_path)?;
    if record.archive_path
        != format!(
            "{ACCEPTED_PROVENANCE_ARCHIVE_PREFIX}/{}",
            record.source_path
        )
    {
        bail!("accepted provenance record is outside the detached namespace");
    }
    validate_digest(&record.content_sha256, "accepted provenance record digest")?;
    if record.byte_count == 0 || record.byte_count > MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64 {
        bail!("accepted provenance record is outside its byte budget");
    }
    let run_prefix = format!("runs/{run_id}/");
    match record.kind {
        AcceptedProvenanceRecordKind::RunIntent => {
            require_exact_path(
                &record.source_path,
                &format!("runs/{run_id}/run_intent.json"),
            )?;
        }
        AcceptedProvenanceRecordKind::RunCatalog => {
            require_exact_path(
                &record.source_path,
                &format!("runs/{run_id}/run_catalog.json"),
            )?;
        }
        AcceptedProvenanceRecordKind::ArtifactCatalog => {
            require_exact_path(
                &record.source_path,
                &format!("runs/{run_id}/artifact_catalog.json"),
            )?;
        }
        AcceptedProvenanceRecordKind::TaskPreparationReceipt => {
            require_json_child(
                &record.source_path,
                &format!("{run_prefix}task_preparation_receipts/"),
            )?;
        }
        AcceptedProvenanceRecordKind::AcceptedStagePreparationReceipt => {
            require_json_child(
                &record.source_path,
                &format!("{run_prefix}accepted_stage_preparation_receipts/"),
            )?;
        }
        AcceptedProvenanceRecordKind::SolutionSetManifest => {
            require_solution_path(&record.source_path, false)?;
        }
        AcceptedProvenanceRecordKind::SolutionSetRevision => {
            require_solution_path(&record.source_path, true)?;
        }
    }
    Ok(())
}

fn require_exact_path(actual: &str, expected: &str) -> Result<()> {
    if actual == expected {
        Ok(())
    } else {
        bail!("accepted provenance record path does not match its kind");
    }
}

fn require_json_child(actual: &str, prefix: &str) -> Result<()> {
    let name = actual
        .strip_prefix(prefix)
        .filter(|name| name.ends_with(".json") && !name[..name.len() - 5].contains('/'))
        .context("accepted provenance record is outside its receipt directory")?;
    crate::repository_path::validate_store_id(name.trim_end_matches(".json"))
}

fn require_solution_path(path: &str, revision: bool) -> Result<()> {
    let components = path.split('/').collect::<Vec<_>>();
    let valid = if revision {
        components.len() == 4
            && components[0] == "solutions"
            && components[2] == "revisions"
            && components[3].ends_with(".json")
            && components[3].trim_end_matches(".json").len() == 20
            && components[3]
                .trim_end_matches(".json")
                .bytes()
                .all(|byte| byte.is_ascii_digit())
    } else {
        components.len() == 3 && components[0] == "solutions" && components[2] == "manifest.json"
    };
    if !valid {
        bail!("invalid accepted provenance solution-set record path");
    }
    validate_hex_object_ref(components[1], "solution-set directory")
}

fn validate_hex_object_ref(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase SHA-256 directory");
    }
    Ok(())
}

fn validate_digest(value: &str, field: &str) -> Result<()> {
    let value = value.strip_prefix("sha256:").unwrap_or(value);
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase SHA-256 digest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    pub(super) fn context() -> AcceptedProvenanceContext {
        AcceptedProvenanceContext {
            source_store_binding: format!("sha256:{}", "a".repeat(64)),
            accepted_run_id: "run-accepted".into(),
            captured_live_session_id: "session-live".into(),
            captured_live_session_epoch: 3,
            captured_scene_revision: "scene-revision-7".into(),
        }
    }

    fn record(kind: AcceptedProvenanceRecordKind, source_path: &str) -> AcceptedProvenanceRecord {
        let digest = crate::hex_sha256(b"record");
        AcceptedProvenanceRecord {
            kind,
            source_path: source_path.into(),
            archive_path: format!("{ACCEPTED_PROVENANCE_ARCHIVE_PREFIX}/{source_path}"),
            content_sha256: digest,
            byte_count: 6,
        }
    }

    #[test]
    fn closure_digest_is_canonical_and_tampering_is_rejected() {
        let manifest = AcceptedProvenanceManifest::from_context(
            &context(),
            vec![record(
                AcceptedProvenanceRecordKind::RunIntent,
                "runs/run-accepted/run_intent.json",
            )],
            Vec::new(),
        )
        .unwrap();
        manifest.validate().unwrap();
        let mut tampered = manifest.clone();
        tampered.records[0].byte_count += 1;
        assert!(tampered.validate().is_err());
        let bytes = manifest.manifest_bytes().unwrap();
        let parsed: AcceptedProvenanceManifest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn authority_paths_and_unknown_authority_kinds_are_rejected() {
        let mut lease = record(
            AcceptedProvenanceRecordKind::RunIntent,
            "runs/run-accepted/resource_leases/gpu/lease.json",
        );
        assert!(
            AcceptedProvenanceManifest::from_context(&context(), vec![lease.clone()], Vec::new(),)
                .is_err()
        );
        lease.source_path = "runs/run-accepted/run_intent.json".into();
        lease.archive_path = format!("{ACCEPTED_PROVENANCE_ARCHIVE_PREFIX}/{}", lease.source_path);
        let mut value = serde_json::to_value(
            AcceptedProvenanceManifest::from_context(&context(), vec![lease], Vec::new()).unwrap(),
        )
        .unwrap();
        value["records"][0]["kind"] = Value::String("resource_lease".into());
        assert!(serde_json::from_value::<AcceptedProvenanceManifest>(value).is_err());
    }

    #[test]
    fn plan_reads_two_store_fixture_and_rejects_changed_record() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("accepted");
        let store = SessionStore::open(&root).unwrap();
        let intent = FmsRunIntent::new(
            "run-accepted",
            "intent-accepted",
            serde_json::json!({"run_id": "run-accepted", "solver": "fixture"}),
        );
        store.commit_run_intent(&intent).unwrap();
        let catalog = FmsRunCatalog {
            schema_version: crate::types::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: "run-accepted".into(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            tasks: Vec::new(),
        };
        store.commit_run_catalog(&catalog).unwrap();
        drop(store);

        let plan = plan_accepted_provenance(&root, &context()).unwrap();
        assert_eq!(plan.manifest.role, ACCEPTED_PROVENANCE_ROLE);
        assert_eq!(plan.records.len(), 2);
        assert!(
            plan.records
                .iter()
                .all(|record| record.archive_path.starts_with("accepted_provenance/"))
        );
        let detached = plan
            .records
            .iter()
            .map(|record| {
                plan.read_record(record)
                    .map(|bytes| (record.archive_path.clone(), bytes))
            })
            .collect::<Result<BTreeMap<_, _>>>()
            .unwrap();
        plan.manifest.validate_detached_records(&detached).unwrap();
        let mut tampered_detached = detached.clone();
        tampered_detached
            .values_mut()
            .next()
            .unwrap()
            .extend_from_slice(b" ");
        assert!(
            plan.manifest
                .validate_detached_records(&tampered_detached)
                .is_err()
        );
        let intent_path = root.join("runs/run-accepted/run_intent.json");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(intent_path)
            .unwrap();
        file.write_all(b" ").unwrap();
        assert!(plan.verify_sources().is_err());
    }
}

#[cfg(test)]
mod accepted_provenance_closure_tests {
    use super::*;
    use super::tests::context;
    use crate::types::{
        FmsArtifactCatalogEntry, FmsArtifactStatus, FmsTaskCatalogEntry, FmsTaskLifecycle,
        FmsTaskReadiness, FMS_ARTIFACT_CATALOG_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
        FMS_PREPARATION_RECEIPT_SCHEMA,
    };
    use chrono::Utc;

    fn nonempty_fixture() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        AcceptedProvenancePlan,
        String,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let live_root = directory.path().join("live-store");
        let accepted_root = directory.path().join("accepted-store");
        SessionStore::open(&live_root).unwrap();
        let store = SessionStore::open(&accepted_root).unwrap();

        let definition = store.cas().put(b"accepted definition").unwrap();
        let study = store.cas().put(b"accepted study plan").unwrap();
        let study_catalog = store.cas().put(b"accepted study catalog").unwrap();
        let output = store.cas().put(b"accepted output").unwrap();
        let run_id = "run-accepted";
        let step_id = "step:relax";
        let mut intent = FmsRunIntent::new(
            run_id,
            "idempotency-accepted",
            serde_json::json!({
                "run_id": run_id,
                "snapshot": {"definition_sha256": definition.clone()},
                "study": {"plan_sha256": study.clone()},
                "study_catalog_sha256": study_catalog.clone(),
                "immutable_assets": []
            }),
        );
        intent.definition_object_ref = Some(definition);
        intent.study_object_ref = Some(study);
        intent.study_catalog_object_ref = Some(study_catalog);
        store.commit_run_intent(&intent).unwrap();

        let task_id = crate::types::task_id_for_study_step(run_id, step_id).unwrap();
        let input_fingerprint = "b".repeat(64);
        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let problem_fingerprint = format!("sha256:{}", "c".repeat(64));
        let specification_fingerprint =
            format!("sha256:{}", canonical_json_sha256(&intent.specification));
        let preparation_id = format!("prep-{task_id}");
        let payload = serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": preparation_id.clone(),
            "plan_fingerprint": plan_fingerprint.clone(),
            "plan": {
                "schema_version": "preparation_plan.v2",
                "problem_fingerprint": problem_fingerprint.clone(),
                "source": {
                    "kind": "accepted_run_step",
                    "run_id": run_id,
                    "specification_fingerprint": specification_fingerprint.clone(),
                    "step_id": step_id
                }
            },
            "accepted_run_source": {
                "schema_version": "accepted_run_preparation_source.v1",
                "run_id": run_id,
                "specification_fingerprint": specification_fingerprint.clone(),
                "step_id": step_id,
                "problem_fingerprint": problem_fingerprint.clone()
            },
            "certificates": []
        });
        let receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            preparation_id,
            plan_fingerprint,
            payload,
        )
        .unwrap();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint,
                    lifecycle: FmsTaskLifecycle::Accepted,
                    readiness: FmsTaskReadiness::Blocked {
                        reason: "awaiting dependencies".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        store.commit_task_preparation_receipt(&receipt).unwrap();
        let stage = FmsAcceptedStagePreparationReceipt::from_task_receipt(&receipt).unwrap();
        store
            .commit_accepted_stage_preparation_receipt(&stage)
            .unwrap();

        let catalog = FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: Utc::now(),
            entries: vec![FmsArtifactCatalogEntry {
                artifact_id: "artifact-output".into(),
                task_id: task_id.clone(),
                attempt_id: "attempt-1".into(),
                ownership_epoch: 1,
                logical_path: "outputs/accepted.bin".into(),
                artifact_type: "state".into(),
                content_sha256: output.clone(),
                object_ref: Some(output.clone()),
                status: FmsArtifactStatus::Published,
                required: true,
                study_output: None,
            }],
        };
        std::fs::write(
            accepted_root.join(format!("runs/{run_id}/artifact_catalog.json")),
            serde_json::to_vec_pretty(&catalog).unwrap(),
        )
        .unwrap();
        drop(store);

        let plan = plan_accepted_provenance(&accepted_root, &context()).unwrap();
        (directory, live_root, plan, output)
    }

    fn detached_for(plan: &AcceptedProvenancePlan) -> BTreeMap<String, Vec<u8>> {
        plan.records
            .iter()
            .map(|record| {
                plan.read_record(record)
                    .map(|bytes| (record.archive_path.clone(), bytes))
            })
            .collect::<Result<BTreeMap<_, _>>>()
            .unwrap()
    }

    fn empty_input_fixture() -> (tempfile::TempDir, AcceptedProvenancePlan, String) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("accepted-store");
        let store = SessionStore::open(&root).unwrap();
        let empty = store.cas().put(b"").unwrap();
        let mut intent = FmsRunIntent::new("run-accepted", "intent-empty", serde_json::json!({
            "run_id": "run-accepted",
            "immutable_assets": [{"asset_id": "package-marker", "content_sha256": empty}]
        }));
        intent.asset_object_refs.insert("package-marker".into(), empty.clone());
        store.commit_run_intent(&intent).unwrap();
        store.commit_run_catalog(&FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(), run_id: "run-accepted".into(),
            revision: 1, updated_at: Utc::now(), tasks: Vec::new(),
        }).unwrap();
        let plan = plan_accepted_provenance(&root, &context()).unwrap();
        (directory, plan, empty)
    }

    #[test]
    fn bounded_planner_accepts_exact_record_total_without_charging_verification_twice() {
        let (_directory, original, _empty) = empty_input_fixture();
        let total = original.records.iter().map(|record| record.byte_count).sum();
        let bounded = plan_accepted_provenance_with_record_budget(
            &original.source_root, &context(), total,
        ).unwrap();
        assert_eq!(bounded.manifest, original.manifest);
        bounded.verify_sources().unwrap();
        let error = plan_accepted_provenance_with_record_budget(
            &original.source_root, &context(), total - 1,
        ).unwrap_err();
        assert!(error.to_string().contains("control record byte budget"));
        assert!(plan_accepted_provenance(&original.source_root, &context()).is_ok());
    }

    #[test]
    fn bounded_record_reader_refuses_remaining_byte_overflow_before_retaining_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::write(root.join("a.json"), b"1234").unwrap();
        fs::write(root.join("b.json"), b"123").unwrap();
        let mut reader = ControlRecordReader::new(Some(6));
        assert_eq!(reader.read(root, "a.json").unwrap(), b"1234");
        assert!(reader.read(root, "b.json").is_err());
        assert_eq!(reader.consumed_bytes, 4);
        assert_eq!(reader.source_lengths.len(), 1);
        fs::write(root.join("b.json"), b"12").unwrap();
        assert_eq!(reader.read(root, "b.json").unwrap(), b"12");
        assert_eq!(reader.read(root, "a.json").unwrap(), b"1234");
        assert_eq!(reader.consumed_bytes, 6);
        assert_eq!(reader.source_lengths.len(), 2);
    }

    #[test]
    fn control_directory_bounds_names_before_collecting_record_payloads() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        fs::create_dir(root.join("records")).unwrap();
        for name in ["a.json", "b.json", "c.json"] {
            fs::write(root.join("records").join(name), b"{}").unwrap();
        }
        let error = read_control_directory_paths(root, "records", Some(2)).unwrap_err();
        assert!(error.to_string().contains("control record count"));
        assert_eq!(read_control_directory_paths(root, "records", Some(3)).unwrap(),
            vec!["records/a.json", "records/b.json", "records/c.json"]);
    }

    #[test]
    fn empty_input_asset_closure_preserves_bytes_and_rejects_forged_length() {
        let (_directory, plan, empty) = empty_input_fixture();
        plan.verify_sources().unwrap();
        assert_eq!(plan.manifest.cas_objects, vec![AcceptedProvenanceCasObject {
            object_ref: empty.clone(), byte_count: 0,
        }]);
        let detached = detached_for(&plan);
        plan.manifest.validate_detached_records(&detached).unwrap();
        let mut unowned = plan.manifest.clone();
        let record = unowned.records.iter_mut()
            .find(|record| record.kind == AcceptedProvenanceRecordKind::RunIntent).unwrap();
        let intent = FmsRunIntent::new("run-accepted", "intent-empty", serde_json::json!({
            "run_id": "run-accepted", "immutable_assets": []
        }));
        let bytes = serde_json::to_vec_pretty(&intent).unwrap();
        record.byte_count = bytes.len() as u64;
        record.content_sha256 = crate::hex_sha256(&bytes);
        let mut detached_without_asset = detached.clone();
        detached_without_asset.insert(record.archive_path.clone(), bytes);
        unowned.closure_sha256 = unowned.expected_closure_sha256().unwrap();
        assert!(unowned.validate_detached_records(&detached_without_asset).is_err());
        let mut forged = plan.manifest.clone();
        forged.cas_objects[0].byte_count = 1;
        forged.closure_sha256 = forged.expected_closure_sha256().unwrap();
        assert!(forged.validate().is_err());
        forged.cas_objects[0].byte_count = 0;
        forged.cas_objects[0].object_ref = crate::hex_sha256(b"nonempty");
        forged.closure_sha256 = forged.expected_closure_sha256().unwrap();
        assert!(forged.validate().is_err());
    }

    #[test]
    fn empty_input_asset_cannot_also_be_a_solver_output() {
        let (_directory, mut plan, empty) = empty_input_fixture();
        let store = SessionStore::open_existing(&plan.source_root).unwrap();
        let mut objects = plan.manifest.cas_objects.iter().cloned()
            .map(|object| (object.object_ref.clone(), object)).collect();
        assert!(add_cas_object(&store, &mut objects, &empty).is_err());
        let catalog = FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(), run_id: "run-accepted".into(),
            revision: 1, updated_at: Utc::now(),
            entries: vec![FmsArtifactCatalogEntry {
                artifact_id: "artifact-empty-output".into(), task_id: "task-output".into(),
                attempt_id: "attempt-1".into(), ownership_epoch: 1,
                logical_path: "outputs/empty.bin".into(), artifact_type: "state".into(),
                content_sha256: empty.clone(), object_ref: Some(empty),
                status: FmsArtifactStatus::Published, required: true, study_output: None,
            }],
        };
        let bytes = serde_json::to_vec_pretty(&catalog).unwrap();
        catalog.validate().unwrap();
        let mut detached = detached_for(&plan);
        let source_path = "runs/run-accepted/artifact_catalog.json";
        let mut records = BTreeMap::new();
        add_control_record_with_bytes(&mut records, "run-accepted",
            AcceptedProvenanceRecordKind::ArtifactCatalog, source_path, &bytes).unwrap();
        let record = records.into_values().next().unwrap();
        detached.insert(record.archive_path.clone(), bytes.clone());
        plan.manifest.records.push(record);
        plan.manifest.closure_sha256 = plan.manifest.expected_closure_sha256().unwrap();
        let error = plan.manifest.validate_detached_records(&detached).unwrap_err();
        assert!(error.to_string().contains("exclusively an immutable input asset"));
        fs::write(plan.source_root.join(source_path), bytes).unwrap();
        let error = plan_accepted_provenance(&plan.source_root, &context()).unwrap_err();
        assert!(error.to_string().contains("CAS object is empty"));
    }

    #[test]
    fn nonempty_two_store_closure_rejects_recomputed_manifest_tampering() {
        let (_directory, live_root, plan, output) = nonempty_fixture();
        assert!(live_root.ends_with("live-store"));
        assert!(plan.records.iter().any(|record| {
            record.kind == AcceptedProvenanceRecordKind::TaskPreparationReceipt
        }));
        assert!(plan.records.iter().any(|record| {
            record.kind == AcceptedProvenanceRecordKind::AcceptedStagePreparationReceipt
        }));
        assert!(plan
            .manifest
            .cas_objects
            .iter()
            .any(|object| object.object_ref == output));

        let detached = detached_for(&plan);
        plan.manifest.validate_detached_records(&detached).unwrap();

        let mut missing_cas = plan.manifest.clone();
        missing_cas
            .cas_objects
            .retain(|object| object.object_ref != output);
        missing_cas.closure_sha256 = missing_cas.expected_closure_sha256().unwrap();
        assert!(missing_cas.validate_detached_records(&detached).is_err());

        let task_record_index = plan
            .manifest
            .records
            .iter()
            .position(|record| record.kind == AcceptedProvenanceRecordKind::TaskPreparationReceipt)
            .unwrap();
        let task_archive = plan.manifest.records[task_record_index].archive_path.clone();
        let mut tampered_receipt: FmsTaskPreparationReceipt =
            serde_json::from_slice(detached.get(&task_archive).unwrap()).unwrap();
        tampered_receipt.input_fingerprint = "d".repeat(64);
        let tampered_receipt_bytes = serde_json::to_vec_pretty(&tampered_receipt).unwrap();
        let mut tampered_detached = detached.clone();
        tampered_detached.insert(task_archive, tampered_receipt_bytes.clone());
        let mut tampered_receipt_manifest = plan.manifest.clone();
        tampered_receipt_manifest.records[task_record_index].byte_count =
            tampered_receipt_bytes.len() as u64;
        tampered_receipt_manifest.records[task_record_index].content_sha256 =
            crate::hex_sha256(&tampered_receipt_bytes);
        tampered_receipt_manifest.closure_sha256 =
            tampered_receipt_manifest.expected_closure_sha256().unwrap();
        assert!(tampered_receipt_manifest
            .validate_detached_records(&tampered_detached)
            .is_err());

        let artifact_record_index = plan
            .manifest
            .records
            .iter()
            .position(|record| record.kind == AcceptedProvenanceRecordKind::ArtifactCatalog)
            .unwrap();
        let artifact_archive = plan.manifest.records[artifact_record_index]
            .archive_path
            .clone();
        let mut tampered_catalog: FmsArtifactCatalog =
            serde_json::from_slice(detached.get(&artifact_archive).unwrap()).unwrap();
        let forged_output = "e".repeat(64);
        tampered_catalog.entries[0].content_sha256 = forged_output.clone();
        tampered_catalog.entries[0].object_ref = Some(forged_output);
        let tampered_catalog_bytes = serde_json::to_vec_pretty(&tampered_catalog).unwrap();
        let mut tampered_cas_detached = detached;
        tampered_cas_detached.insert(artifact_archive, tampered_catalog_bytes.clone());
        let mut tampered_cas_manifest = plan.manifest.clone();
        tampered_cas_manifest.records[artifact_record_index].byte_count =
            tampered_catalog_bytes.len() as u64;
        tampered_cas_manifest.records[artifact_record_index].content_sha256 =
            crate::hex_sha256(&tampered_catalog_bytes);
        tampered_cas_manifest.closure_sha256 = tampered_cas_manifest
            .expected_closure_sha256()
            .unwrap();
        assert!(tampered_cas_manifest
            .validate_detached_records(&tampered_cas_detached)
            .is_err());
    }

    fn nested_manifest_fixture() -> (tempfile::TempDir, AcceptedProvenancePlan, String, String) {
        let (directory, _live_root, plan, output) = nonempty_fixture();
        let store = SessionStore::open_existing(&plan.source_root).unwrap();
        let catalog_path = plan.source_root.join("runs/run-accepted/artifact_catalog.json");
        let mut catalog: FmsArtifactCatalog =
            serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        let entry = &mut catalog.entries[0];
        let manifest = FmsStudyOutputManifest {
            schema_version: crate::types::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
            run_id: catalog.run_id.clone(),
            task_id: entry.task_id.clone(),
            step_id: "step:relax".into(),
            attempt_id: entry.attempt_id.clone(),
            ownership_epoch: entry.ownership_epoch,
            accepted_state_ref: None,
            observation_source: None,
            outputs: vec![crate::types::FmsStudyOutputManifestEntry {
                port_id: "field".into(), case_id: "default".into(), data_kind: "artifact".into(),
                codec_id: "fixture".into(), codec_version: "v1".into(),
                artifact_id: "artifact-nested-output".into(),
                object_ref: output.clone(), content_sha256: output.clone(),
            }],
        };
        manifest.validate().unwrap();
        let metadata = store.cas().put(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        entry.artifact_type = "study_output_manifest".into();
        entry.object_ref = Some(metadata.clone());
        entry.content_sha256 = metadata.clone();
        catalog.validate().unwrap();
        fs::write(catalog_path, serde_json::to_vec_pretty(&catalog).unwrap()).unwrap();
        drop(store);
        let plan = plan_accepted_provenance(&plan.source_root, &context()).unwrap();
        (directory, plan, metadata, output)
    }

    #[test]
    fn dtq_v2_archive_exact_parent_closure() {
        use fullmag_antenna_artifacts::retained_current::*;
        // Metadata/archive fixture only. Opaque package bytes cannot pass the physical source gate.
        let (directory, _live, original, package) = nonempty_fixture();
        let store = SessionStore::open_existing(&original.source_root).unwrap();
        let run = "run-accepted";
        let step = "step:relax";
        let task = crate::task_id_for_study_step(run, step).unwrap();
        let root = &original.source_root;
        let intent_path = root.join(format!("runs/{run}/run_intent.json"));
        let mut intent: FmsRunIntent = serde_json::from_slice(&fs::read(&intent_path).unwrap()).unwrap();
        intent.specification["snapshot"]["project_id"] = serde_json::json!("project");
        intent.payload_sha256 = canonical_json_sha256(&intent.specification);
        fs::write(&intent_path, serde_json::to_vec_pretty(&intent).unwrap()).unwrap();
        let receipt_path = root.join(format!("runs/{run}/task_preparation_receipts/{task}.json"));
        let mut receipt: FmsTaskPreparationReceipt = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        let fingerprint = format!("sha256:{}",intent.payload_sha256);
        receipt.payload["plan"]["source"]["specification_fingerprint"] = serde_json::json!(fingerprint);
        receipt.payload["accepted_run_source"]["specification_fingerprint"] = serde_json::json!(fingerprint);
        receipt.payload_sha256 = canonical_json_sha256(&receipt.payload);
        receipt.validate().unwrap();
        fs::write(receipt_path,serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        let stage = FmsAcceptedStagePreparationReceipt::from_task_receipt(&receipt).unwrap();
        fs::write(root.join(stage.relative_path().unwrap()),serde_json::to_vec_pretty(&stage).unwrap()).unwrap();
        let output = FmsStudyOutputManifest {schema_version:crate::types::FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
            run_id:run.into(),task_id:task.clone(),step_id:step.into(),attempt_id:"attempt-1".into(),ownership_epoch:1,
            accepted_state_ref:None,observation_source:None,outputs:vec![crate::FmsStudyOutputManifestEntry {
                port_id:"inspection".into(),case_id:"default".into(),data_kind:"artifact".into(),codec_id:PARENT_CODEC_ID.into(),
                codec_version:PARENT_CODEC_VERSION.into(),artifact_id:"artifact-output".into(),object_ref:package.clone(),content_sha256:package.clone()}]};
        let output_bytes = serde_json::to_vec(&output).unwrap();
        let output_ref = store.cas().put(&output_bytes).unwrap();
        let catalog_path = root.join(format!("runs/{run}/artifact_catalog.json"));
        let mut artifacts: FmsArtifactCatalog = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        artifacts.entries[0].artifact_type = "artifact".into();
        artifacts.entries[0].study_output = Some(crate::FmsStudyArtifactOutput {step_id:step.into(),port_id:"inspection".into(),case_id:"default".into()});
        let mut metadata = artifacts.entries[0].clone();
        metadata.artifact_id="parent-output-manifest".into();metadata.artifact_type="study_output_manifest".into();
        metadata.study_output=None;metadata.object_ref=Some(output_ref.clone());metadata.content_sha256=output_ref.clone();
        metadata.logical_path="outputs/manifest.json".into();artifacts.entries.push(metadata);
        fs::write(catalog_path,serde_json::to_vec_pretty(&artifacts).unwrap()).unwrap();
        let catalog_path=root.join(format!("runs/{run}/run_catalog.json"));
        let mut catalog: FmsRunCatalog=serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        catalog.tasks[0].lifecycle=FmsTaskLifecycle::Succeeded;catalog.tasks[0].attempt_id=Some("attempt-1".into());
        catalog.tasks[0].ownership_epoch=Some(1);catalog.tasks[0].artifact_ids=artifacts.entries.iter().map(|entry|entry.artifact_id.clone()).collect();
        fs::write(catalog_path,serde_json::to_vec_pretty(&catalog).unwrap()).unwrap();
        let plan=plan_accepted_provenance(root,&context()).unwrap();
        let records=detached_for(&plan);
        let evidence_bytes=serde_json::to_vec(&plan.manifest).unwrap();
        let evidence_ref=store.cas().put(&evidence_bytes).unwrap();
        let object=|object_ref:String,byte_count:u64|CasObjectRef {object_ref,byte_count};
        let owner=ParentInspectionOwner {project_id:"project".into(),run_id:run.into(),study_step_id:step.into(),native_stage_id:"source".into(),
            task_id:task,attempt_id:"attempt-1".into(),ownership_epoch:"1".into(),artifact_id:"artifact-output".into(),
            package:object(package.clone(),store.cas().verified_length(&package).unwrap().unwrap()),package_codec_id:PARENT_CODEC_ID.into(),
            package_codec_version:PARENT_CODEC_VERSION.into(),manifest_schema:PARENT_MANIFEST_SCHEMA.into(),
            output_manifest_artifact_id:"parent-output-manifest".into(),output_manifest:object(output_ref.clone(),output_bytes.len() as u64)};
        let capsule=ParentEvidenceCapsule {schema_version:PARENT_EVIDENCE_SCHEMA.into(),role:"evidence_only".into(),parent_owner:owner.clone(),
            accepted_provenance_manifest:object(evidence_ref,evidence_bytes.len() as u64),record_objects:records.iter().map(|(path,bytes)|
                ParentEvidenceRecordObject {archive_path:path.clone(),object:object(store.cas().put(bytes).unwrap(),bytes.len() as u64)}).collect()};
        let capsule_bytes=serde_json::to_vec(&capsule).unwrap();
        let capsule_ref=store.cas().put(&capsule_bytes).unwrap();
        let dig=format!("sha256:{}","e".repeat(64));
        let parent=RetainedCurrentParent {owner,source:ParentCurrentDigests {prepared_execution_digest:dig.clone(),accepted_charge_field_digest:dig.clone(),
            accepted_source_state_digest:dig.clone(),view_identity_digest:dig.clone(),current_balance_certificate_digest:dig.clone()},
            evidence_capsule:object(capsule_ref.clone(),capsule_bytes.len() as u64)};
        let payload=|bytes:u64,layout:&str,unit:&str|serde_json::json!({"sha256":"d".repeat(64),"byte_count":bytes,"layout":layout,"unit":unit});
        let execution=serde_json::json!({"discretization":"fem","device":"cpu","precision":"double","execution_mode":"strict"});
        let mut child:RetainedCurrentFieldManifestV2=serde_json::from_value(serde_json::json!({
            "schema_version":RETAINED_CURRENT_FIELD_SCHEMA_V2,"status":"inspection_only","qualification":"not_verified","content_digest":dig,
            "stage_id":"child","output_id":"field","port_mode_id":"port","source_object_id":"antenna","current_transport_id":"transport","parent":parent,
            "sample_carrier":{"domain":{"kind":"global"},"carrier_kind":"fem_domain_mesh_asset","location":"node","topology_digest":dig},
            "source_vertex_count":4,"source_cell_count":1,"target_count":4,"sample_cell_count":1,
            "requested_intent":{"id":"child","source_object_id":"antenna","current_transport_id":"transport","port_mode_ids":["port"],
                "retained_current_source":{"kind":"published_inspection","project_id":"project","run_id":run,"task_id":parent.owner.task_id,
                    "attempt_id":"attempt-1","ownership_epoch":"1","artifact_id":"artifact-output","object_ref":package},
                "retained_source_preparation":{"asset_id":format!("script-file-{}","1".repeat(64)),"content_sha256":"2".repeat(64)},
                "model":"quasistatic_conduction_biot_savart3d","oersted_realization":"direct_tetra_quadrature","conductor_mesh_policy":"retained",
                "field_sampling_domain":{"kind":"global"},"target_refs":[],"solver_policy":"volume_inspection_v1","outputs":[{"id":"field","quantity":"H_ant_basis"}]},
            "resolved_execution":{"requested_execution":execution,"execution":execution,"operator_version":RETAINED_CURRENT_OPERATOR_V2,
                "basis_version":RETAINED_CURRENT_BASIS,"evidence_schema":RETAINED_CURRENT_EVIDENCE_SCHEMA_V2},
            "direct_field_policy":RetainedCurrentDirectFieldPolicyV2::for_solver_policy("volume_inspection_v1").unwrap(),
            "payloads":{"sample_xyz":payload(96,"sample_xyz_f64_le","m"),"sample_cells":payload(16,"tet4_u32_le","1"),
                "h_raw":payload(96,"sample_xyz_f64_le","A/m"),"evidence":payload(680,RETAINED_CURRENT_EVIDENCE_SCHEMA_V2,"1")}})).unwrap();
        child.content_digest=child.expected_content_digest().unwrap();child.validate_metadata().unwrap();
        let manifest=serde_json::to_vec(&child).unwrap();
        let mut raw=b"FMARCF2\0".to_vec();raw.extend_from_slice(&(manifest.len() as u64).to_le_bytes());raw.extend_from_slice(&manifest);
        // The closure reader deliberately reads only bounded metadata; the field decoder refuses this opaque frame.
        raw.extend_from_slice(&[0;64]);let child_ref=store.cas().put(&raw).unwrap();
        let cold_dir=tempfile::tempdir().unwrap();let cold=SessionStore::open(cold_dir.path()).unwrap();
        for entry in fs::read_dir(root.join("objects/sha256")).unwrap() {
            let path=entry.unwrap().path();if path.is_file(){let bytes=fs::read(&path).unwrap();assert_eq!(cold.cas().put(&bytes).unwrap(),path.file_name().unwrap().to_str().unwrap());}
        }
        drop(store);drop(plan);drop(original);drop(directory);
        let detached=validate_retained_current_parent_evidence_any(&child_ref,RetainedCurrentFieldManifestRef::DirectV2(&child),
            |hash|cold.cas().get_bounded(hash,MAX_METADATA_BYTES),|hash,offset,count|cold.cas().get_verified_range(hash,offset,count,MAX_METADATA_BYTES)).unwrap();
        assert_eq!(detached.required_cas.get(&package),Some(&child.parent.owner.package.byte_count));
        assert_eq!(detached.required_cas.get(&output_ref),Some(&child.parent.owner.output_manifest.byte_count));
        assert!(detached.required_cas.contains_key(&capsule_ref));
        assert_eq!(detached.records,records);
        assert!(decode_retained_current_field_bundle_v2(&raw,MAX_PACKAGE_BYTES as usize).is_err());
        // Re-sign every enclosing metadata pin; an unrelated retained source must still be rejected.
        let unrelated = b"unrelated retained current source";
        let unrelated_ref = cold.cas().put(unrelated).unwrap();
        let mut extra: AcceptedProvenanceManifest = serde_json::from_slice(&evidence_bytes).unwrap();
        extra.cas_objects.push(AcceptedProvenanceCasObject {object_ref:unrelated_ref,byte_count:unrelated.len() as u64});
        extra.cas_objects.sort_by(|a,b|a.object_ref.cmp(&b.object_ref));
        extra.closure_sha256=extra.expected_closure_sha256().unwrap();
        let extra_bytes=serde_json::to_vec(&extra).unwrap();
        let mut extra_capsule=capsule.clone();
        extra_capsule.accepted_provenance_manifest=object(cold.cas().put(&extra_bytes).unwrap(),extra_bytes.len() as u64);
        let extra_bytes=serde_json::to_vec(&extra_capsule).unwrap();
        let mut extra_child=child.clone();
        extra_child.parent.evidence_capsule=object(cold.cas().put(&extra_bytes).unwrap(),extra_bytes.len() as u64);
        extra_child.content_digest=extra_child.expected_content_digest().unwrap();
        let manifest=serde_json::to_vec(&extra_child).unwrap();
        let mut extra_raw=b"FMARCF2\0".to_vec();extra_raw.extend_from_slice(&(manifest.len() as u64).to_le_bytes());
        extra_raw.extend_from_slice(&manifest);extra_raw.extend_from_slice(&[0;64]);
        let extra_ref=cold.cas().put(&extra_raw).unwrap();
        let error=validate_retained_current_parent_evidence_any(&extra_ref,RetainedCurrentFieldManifestRef::DirectV2(&extra_child),
            |hash|cold.cas().get_bounded(hash,MAX_METADATA_BYTES),|hash,offset,count|cold.cas().get_verified_range(hash,offset,count,MAX_METADATA_BYTES)).unwrap_err();
        assert!(error.to_string().contains("unrelated CAS objects"), "{error:#}");
        let mut child_source=child.clone();
        child_source.parent.owner.package_codec_id=RETAINED_CURRENT_FIELD_CODEC_ID.into();
        child_source.parent.owner.package_codec_version="v2".into();
        assert!(child_source.validate_metadata().is_err());
    }

    #[test]
    fn exact_cas_rejects_unrelated_declared_object_without_changing_legacy_validation() {
        let (_directory, _live_root, plan, output) = nonempty_fixture();
        let detached = detached_for(&plan);
        let mut manifest = plan.manifest.clone();
        manifest.cas_objects.push(AcceptedProvenanceCasObject {
            object_ref: crate::hex_sha256(b"unrelated retained object"), byte_count: 25,
        });
        manifest.closure_sha256 = manifest.expected_closure_sha256().unwrap();
        manifest.validate_detached_records(&detached).unwrap();
        manifest.validate_detached_records_with_cas(&detached, |_| Ok(None)).unwrap();
        let error = manifest.validate_detached_records_with_exact_cas(&detached, |_| Ok(None))
            .unwrap_err();
        assert!(error.to_string().contains("unrelated CAS objects"));

        manifest.cas_objects.retain(|object| object.object_ref != output);
        manifest.closure_sha256 = manifest.expected_closure_sha256().unwrap();
        assert!(manifest.validate_detached_records(&detached).is_err());
        assert!(manifest.validate_detached_records_with_exact_cas(&detached, |_| Ok(None)).is_err());
    }

    #[test]
    fn exact_cas_requires_typed_metadata_while_legacy_reader_remains_optional() {
        let (_directory, plan, metadata, _output) = nested_manifest_fixture();
        let detached = detached_for(&plan);
        plan.manifest.validate_detached_records(&detached).unwrap();
        plan.manifest.validate_detached_records_with_cas(&detached, |_| Ok(None)).unwrap();
        let error = plan.manifest.validate_detached_records_with_exact_cas(&detached, |object_ref| {
            assert_eq!(object_ref, metadata);
            Ok(None)
        }).unwrap_err();
        assert!(error.to_string().contains("typed metadata CAS object is missing"));
    }

    #[test]
    fn exact_cas_derives_nested_outputs_and_rejects_rehashed_missing_dependency() {
        let (_directory, plan, metadata, output) = nested_manifest_fixture();
        let detached = detached_for(&plan);
        let store = SessionStore::open_existing(&plan.source_root).unwrap();
        let metadata_bytes = store.cas().get_bounded(&metadata, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64)
            .unwrap().unwrap();
        plan.manifest.validate_detached_records_with_exact_cas(&detached, |object_ref| {
            assert_eq!(object_ref, metadata);
            Ok(Some(metadata_bytes.clone()))
        }).unwrap();
        let mut manifest = plan.manifest.clone();
        manifest.cas_objects.retain(|object| object.object_ref != output);
        manifest.closure_sha256 = manifest.expected_closure_sha256().unwrap();
        // Compatibility mode without metadata can only establish direct references.
        manifest.validate_detached_records(&detached).unwrap();
        for exact in [false, true] {
            let result = if exact {
                manifest.validate_detached_records_with_exact_cas(&detached, |_| Ok(Some(metadata_bytes.clone())))
            } else {
                manifest.validate_detached_records_with_cas(&detached, |_| Ok(Some(metadata_bytes.clone())))
            };
            assert!(result.unwrap_err().to_string().contains("missing required CAS object"));
        }
        assert!(plan.manifest.validate_detached_records_with_exact_cas(&detached,
            |_| Ok(Some(b"{}".to_vec()))).is_err());
    }

    fn solution(revision: u64, state: fullmag_quantities::SolutionSetManifestState) -> fullmag_quantities::SolutionSet {
        fullmag_quantities::SolutionSet {
            schema_version: fullmag_quantities::SOLUTION_SET_SCHEMA_VERSION.into(),
            solution_set_id: "solution-set-accepted".into(),
            revision,
            run_id: "run-accepted".into(),
            manifest_state: state,
            execution_status: if state == fullmag_quantities::SolutionSetManifestState::Open {
                fullmag_quantities::SolutionExecutionStatus::Running
            } else {
                fullmag_quantities::SolutionExecutionStatus::Succeeded
            },
            scientific_assessment: fullmag_quantities::ScientificAssessment {
                status: fullmag_quantities::ScientificAssessmentStatus::Converged,
                reason: None,
                evidence_artifact_ids: Vec::new(),
            },
            provenance: fullmag_quantities::SolutionSetProvenance {
                run_spec_digest: format!("sha256:{}", "a".repeat(64)),
                model_digest: format!("sha256:{}", "b".repeat(64)),
                physics_digest: format!("sha256:{}", "c".repeat(64)),
                discretization_digest: format!("sha256:{}", "d".repeat(64)),
                resolved_plan_digest: format!("sha256:{}", "e".repeat(64)),
                acquisition_digest: format!("sha256:{}", "f".repeat(64)),
                seed_digest: None,
            },
            members: Vec::new(),
            coverage: Vec::new(),
        }
    }

    #[test]
    fn solution_history_requires_contiguous_revisions_and_current_last() {
        let current = solution(2, fullmag_quantities::SolutionSetManifestState::Closed);
        let mut revisions = BTreeMap::new();
        revisions.insert(1, solution(1, fullmag_quantities::SolutionSetManifestState::Open));
        revisions.insert(3, solution(3, fullmag_quantities::SolutionSetManifestState::Closed));
        let histories = BTreeMap::from([(
            current.solution_set_id.clone(),
            (Some(current.clone()), revisions),
        )]);
        assert!(validate_solution_histories(&histories).is_err());

        let mut contiguous = BTreeMap::new();
        contiguous.insert(1, solution(1, fullmag_quantities::SolutionSetManifestState::Open));
        contiguous.insert(2, solution(2, fullmag_quantities::SolutionSetManifestState::Closed));
        let stale_current = solution(1, fullmag_quantities::SolutionSetManifestState::Open);
        let histories = BTreeMap::from([(
            stale_current.solution_set_id.clone(),
            (Some(stale_current), contiguous),
        )]);
        assert!(validate_solution_histories(&histories).is_err());
    }
}


#[cfg(test)]
mod accepted_store_capture_tests {
    use super::*;

    fn store_context() -> AcceptedStoreProvenanceContext {
        AcceptedStoreProvenanceContext {
            source_store_binding: tests::context().source_store_binding,
            accepted_run_id: "run-accepted".into(),
        }
    }

    fn header_record() -> AcceptedProvenanceRecord {
        AcceptedProvenanceRecord {
            kind: AcceptedProvenanceRecordKind::RunIntent,
            source_path: "runs/run-accepted/run_intent.json".into(),
            archive_path: "accepted_provenance/runs/run-accepted/run_intent.json".into(),
            content_sha256: crate::hex_sha256(b"record"),
            byte_count: 6,
        }
    }

    #[test]
    fn v1_golden_bytes_and_digest_survive_store_format_addition() {
        let manifest = AcceptedProvenanceManifest::from_context(
            &tests::context(), vec![header_record()], Vec::new(),
        ).unwrap();
        assert_eq!(manifest.closure_sha256,
            "sha256:a44949767e0c008f06a6b067eac78b199b9e9007493b315b8b0385dd45a3f585");
        let bytes = manifest.manifest_bytes().unwrap();
        assert_eq!(crate::hex_sha256(&bytes),
            "eff9c991344d52f7c7f990e467f516c435011e15f08cb17f441814a6ba8a25e9");
        let dispatched = AcceptedEvidenceManifest::from_bytes(&bytes).unwrap();
        assert_eq!(dispatched, AcceptedEvidenceManifest::Live(manifest));
        assert_eq!(dispatched.manifest_bytes().unwrap(), bytes);
    }

    #[test]
    fn explicit_dispatch_rejects_unknown_mixed_duplicate_and_invalid_headers() {
        let manifest = AcceptedStoreProvenanceManifest::from_context(
            &store_context(), vec![header_record()], Vec::new(),
        ).unwrap();
        let value = serde_json::to_value(&manifest).unwrap();
        for (field, replacement) in [
            ("schema_version", Value::String("accepted_provenance.v3".into())),
            ("role", Value::String("runtime_authority".into())),
            ("capture", serde_json::json!({"kind": "live_session"})),
            ("capture", serde_json::json!({"kind": "accepted_store", "epoch": 1})),
            ("source_store_binding", Value::String("not-a-digest".into())),
            ("accepted_run_id", Value::String("../another-run".into())),
            ("captured_live_session_id", Value::String("session-invented".into())),
        ] {
            let mut invalid = value.clone();
            invalid[field] = replacement;
            assert!(AcceptedEvidenceManifest::from_bytes(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        let mut wrong_run = manifest.clone();
        wrong_run.accepted_run_id = "run-other".into();
        wrong_run.closure_sha256 = wrong_run.expected_closure_sha256().unwrap();
        assert!(wrong_run.validate().is_err());
        assert!(serde_json::from_slice::<AcceptedProvenanceManifest>(&manifest.manifest_bytes().unwrap()).is_err());
        let live = AcceptedProvenanceManifest::from_context(
            &tests::context(), vec![header_record()], Vec::new(),
        ).unwrap();
        let mut mixed = serde_json::to_value(live).unwrap();
        mixed["capture"] = serde_json::json!({"kind": "accepted_store"});
        assert!(AcceptedEvidenceManifest::from_bytes(&serde_json::to_vec(&mixed).unwrap()).is_err());
        let text = String::from_utf8(manifest.manifest_bytes().unwrap()).unwrap();
        let duplicate = text.replacen("{", "{\"schema_version\":\"accepted_provenance.v2\",", 1);
        assert!(AcceptedEvidenceManifest::from_bytes(duplicate.as_bytes()).is_err());
        let duplicate_nested = text.replace(
            "\"kind\": \"accepted_store\"",
            "\"kind\": \"accepted_store\", \"kind\": \"accepted_store\"",
        );
        assert_ne!(duplicate_nested, text);
        assert!(AcceptedEvidenceManifest::from_bytes(duplicate_nested.as_bytes()).is_err());
    }

    #[test]
    fn headless_fixture_uses_same_inventory_and_exact_cas_without_live_identity() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("accepted");
        let store = SessionStore::open(&root).unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime/accepted-fem-preparation-run-v2.json"
        )).unwrap();
        let mut specification = fixture["run_intent"]["specification"].clone();
        assert_eq!(specification["parameters"], serde_json::json!({}));
        assert_eq!(specification["snapshot"]["definition_revision"], 0);
        let run_id = specification["run_id"].as_str().unwrap().to_owned();
        let definition_ref = store.cas().put(b"headless fixture definition").unwrap();
        specification["snapshot"]["definition_sha256"] = Value::String(definition_ref.clone());
        let mut intent = FmsRunIntent::new(&run_id, "headless-fixture", specification);
        intent.definition_object_ref = Some(definition_ref.clone());
        store.commit_run_intent(&intent).unwrap();
        store.commit_run_catalog(&FmsRunCatalog {
            schema_version: crate::types::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.clone(), revision: 1, updated_at: chrono::Utc::now(), tasks: Vec::new(),
        }).unwrap();
        let context = AcceptedStoreProvenanceContext { accepted_run_id: run_id.clone(), ..store_context() };
        let plan = plan_accepted_store_provenance_with_record_budget(&root, &context, 64 * 1024 * 1024).unwrap();
        let mut live_context = tests::context();
        live_context.accepted_run_id = run_id;
        let legacy = plan_accepted_provenance(&root, &live_context).unwrap();
        assert_eq!(legacy.manifest.records, plan.manifest.records);
        assert_eq!(legacy.manifest.cas_objects, plan.manifest.cas_objects);
        assert_eq!(legacy.records, plan.records);
        assert_eq!(legacy.cas_objects, plan.cas_objects);
        plan.verify_sources().unwrap();
        let detached = plan.records.iter().map(|record| {
            (record.archive_path.clone(), plan.read_record(record).unwrap())
        }).collect::<BTreeMap<_, _>>();
        plan.manifest.validate_detached_records_with_exact_cas(&detached, |_| Ok(None)).unwrap();
        let manifest_bytes = plan.manifest.manifest_bytes().unwrap();
        let json: Value = serde_json::from_slice(&manifest_bytes).unwrap();
        assert_eq!(json["capture"], serde_json::json!({"kind": "accepted_store"}));
        for key in ["captured_live_session_id", "captured_live_session_epoch", "captured_scene_revision"] {
            assert!(json.get(key).is_none());
        }
        let dispatched = AcceptedEvidenceManifest::from_bytes(&manifest_bytes).unwrap();
        assert_eq!(dispatched.manifest_bytes().unwrap(), manifest_bytes);
        dispatched.validate_detached_records_with_exact_cas(&detached, |_| Ok(None)).unwrap();
        let mut missing = detached.clone();
        missing.pop_first();
        assert!(dispatched.validate_detached_records_with_exact_cas(&missing, |_| Ok(None)).is_err());
        let mut extra_cas = plan.manifest.clone();
        extra_cas.cas_objects.push(AcceptedProvenanceCasObject { object_ref: "f".repeat(64), byte_count: 1 });
        extra_cas.closure_sha256 = extra_cas.expected_closure_sha256().unwrap();
        assert!(extra_cas.validate_detached_records_with_exact_cas(&detached, |_| Ok(None)).is_err());
        let mut missing_cas = plan.manifest.clone();
        missing_cas.cas_objects.clear();
        missing_cas.closure_sha256 = missing_cas.expected_closure_sha256().unwrap();
        assert!(missing_cas.validate_detached_records_with_exact_cas(&detached, |_| Ok(None)).is_err());
        let record_bytes = plan.records.iter().map(|record| record.byte_count).sum::<u64>();
        assert!(plan_accepted_store_provenance_with_record_budget(&root, &context, record_bytes - 1).is_err());
        let mut wrong_run = context.clone();
        wrong_run.accepted_run_id = "run-absent".into();
        assert!(plan_accepted_store_provenance_with_record_budget(&root, &wrong_run, record_bytes).is_err());
        fs::write(root.join("objects/sha256").join(definition_ref), b"corrupt").unwrap();
        assert!(plan.verify_sources().is_err());
    }
}
