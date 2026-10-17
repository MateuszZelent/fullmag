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
use serde_json::Value;

use crate::SessionStore;
use crate::repository_path::{checked_path, read_bounded_regular_file, validate_relative_path};
use crate::types::{
    FmsAcceptedStagePreparationReceipt, FmsArtifactCatalog, FmsRunCatalog, FmsRunIntent,
    FmsStudyOutputManifest, FmsTaskPreparationReceipt, canonical_json_sha256,
};

pub const ACCEPTED_PROVENANCE_SCHEMA: &str = "accepted_provenance.v1";
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
        mut read_cas: F,
    ) -> Result<()>
    where
        F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        self.validate()?;
        if detached.len() != self.records.len()
            || detached.keys().any(|path| {
                !self
                    .records
                    .iter()
                    .any(|record| record.archive_path == *path)
            })
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

        for record in &self.records {
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
                    if value.run_id != self.accepted_run_id
                        || record.source_path
                            != format!("runs/{}/run_intent.json", self.accepted_run_id)
                    {
                        bail!("detached run intent identity differs from its accepted run");
                    }
                    if intent.replace(value).is_some() {
                        bail!("accepted provenance closure contains duplicate run intents");
                    }
                }
                AcceptedProvenanceRecordKind::RunCatalog => {
                    let value: FmsRunCatalog =
                        serde_json::from_slice(bytes).with_context(|| {
                            format!("detached run catalog is not typed: {}", record.archive_path)
                        })?;
                    value.validate()?;
                    if value.run_id != self.accepted_run_id
                        || record.source_path
                            != format!("runs/{}/run_catalog.json", self.accepted_run_id)
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
                    if value.run_id != self.accepted_run_id {
                        bail!("detached artifact catalog identity differs from its accepted run");
                    }
                    if artifact_catalog.replace(value).is_some() {
                        bail!("accepted provenance closure contains duplicate artifact catalogs");
                    }
                }
                AcceptedProvenanceRecordKind::TaskPreparationReceipt => {
                    let value: FmsTaskPreparationReceipt = serde_json::from_slice(bytes)
                        .with_context(|| {
                            format!(
                                "detached task receipt is not typed: {}",
                                record.archive_path
                            )
                        })?;
                    value.validate()?;
                    if value.run_id != self.accepted_run_id
                        || value.relative_path()? != record.source_path
                    {
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
                    if value.run_id != self.accepted_run_id
                        || value.relative_path()? != record.source_path
                    {
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
                    if value.run_id != self.accepted_run_id {
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
            collect_required_artifact_objects(
                artifact_catalog,
                &mut required_cas,
                &mut read_cas,
            )?;
        }
        for (_, (current, revisions)) in &solution_sets {
            for solution in current.iter().chain(revisions.values()) {
                collect_required_solution_objects(solution, &mut required_cas, &mut read_cas)?;
            }
        }
        validate_solution_histories(&solution_sets)?;

        let declared_cas = self
            .cas_objects
            .iter()
            .map(|object| object.object_ref.as_str())
            .collect::<BTreeSet<_>>();
        for object_ref in required_cas {
            if !declared_cas.contains(object_ref.as_str()) {
                bail!(
                    "accepted provenance closure is missing required CAS object `{object_ref}`"
                );
            }
        }
        Ok(())
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
        if self.records.is_empty() {
            bail!("accepted provenance closure has no control records");
        }
        if self.records.len() > MAX_ACCEPTED_PROVENANCE_RECORDS {
            bail!("accepted provenance closure has too many control records");
        }
        if self.cas_objects.len() > MAX_ACCEPTED_PROVENANCE_OBJECTS {
            bail!("accepted provenance closure has too many CAS objects");
        }

        let mut record_paths = BTreeSet::new();
        for record in &self.records {
            validate_record(record, &self.accepted_run_id)?;
            if !record_paths.insert(record.archive_path.as_str()) {
                bail!("duplicate accepted provenance archive record path");
            }
        }
        let mut object_refs = BTreeSet::new();
        for object in &self.cas_objects {
            crate::cas::validate_hash(&object.object_ref)?;
            if object.byte_count == 0 {
                bail!("accepted provenance CAS object has zero length");
            }
            if !object_refs.insert(object.object_ref.as_str()) {
                bail!("duplicate accepted provenance CAS object");
            }
        }
        Ok(())
    }

    fn expected_closure_sha256(&self) -> Result<String> {
        let mut unsigned = self.clone();
        unsigned.closure_sha256.clear();
        let value = serde_json::to_value(unsigned)
            .context("serializing accepted provenance closure digest input")?;
        Ok(format!("sha256:{}", canonical_json_sha256(&value)))
    }
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
    for object_ref in intent.asset_object_refs.values() {
        add_required_cas_object(required, object_ref, "run intent asset")?;
    }
    Ok(())
}

fn collect_required_artifact_objects<F>(
    catalog: &FmsArtifactCatalog,
    required: &mut BTreeSet<String>,
    read_cas: &mut F,
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
        }
    }
    Ok(())
}

fn collect_required_solution_objects<F>(
    solution: &fullmag_quantities::SolutionSet,
    required: &mut BTreeSet<String>,
    read_cas: &mut F,
) -> Result<()>
where
    F: FnMut(&str) -> Result<Option<Vec<u8>>>,
{
    for member in &solution.members {
        for artifact in &member.artifacts {
            add_required_cas_object(required, &artifact.object_ref, "solution set artifact")?;
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

impl AcceptedProvenancePlan {
    pub fn verify_sources(&self) -> Result<()> {
        self.manifest.validate()?;
        for record in &self.records {
            let bytes = read_control(&self.source_root, &record.source_relative_path)?;
            if bytes.len() as u64 != record.byte_count
                || crate::hex_sha256(&bytes) != record.content_sha256
            {
                bail!(
                    "accepted provenance source changed: {}",
                    record.source_relative_path
                );
            }
        }
        let store = SessionStore::open_existing(&self.source_root)
            .context("opening accepted store for CAS verification")?;
        for object in &self.cas_objects {
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
        let bytes = read_control(&self.source_root, &record.source_relative_path)?;
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
            &self.source_root,
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
    context.validate()?;
    crate::repository_path::reject_link(accepted_store_root)?;
    let source_root = fs::canonicalize(accepted_store_root)
        .context("canonicalizing accepted provenance source root")?;
    let store = SessionStore::open_existing(&source_root)
        .context("opening accepted provenance source store")?;

    let mut records = BTreeMap::<String, AcceptedProvenanceRecord>::new();
    let mut cas_objects = BTreeMap::<String, AcceptedProvenanceCasObject>::new();
    let intent_relative = format!("runs/{}/run_intent.json", context.accepted_run_id);
    let intent_bytes = add_control_record(
        &source_root,
        &mut records,
        context.accepted_run_id.as_str(),
        AcceptedProvenanceRecordKind::RunIntent,
        &intent_relative,
    )?;
    let intent: FmsRunIntent = serde_json::from_slice(&intent_bytes)
        .context("accepted provenance run intent is not typed")?;
    intent.validate()?;
    if intent.run_id != context.accepted_run_id {
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
        add_cas_object(&store, &mut cas_objects, object_ref)?;
    }

    let catalog_relative = format!("runs/{}/run_catalog.json", context.accepted_run_id);
    let catalog_bytes = add_control_record(
        &source_root,
        &mut records,
        context.accepted_run_id.as_str(),
        AcceptedProvenanceRecordKind::RunCatalog,
        &catalog_relative,
    )?;
    let catalog: FmsRunCatalog = serde_json::from_slice(&catalog_bytes)
        .context("accepted provenance run catalog is not typed")?;
    catalog.validate()?;
    if catalog.run_id != context.accepted_run_id {
        bail!("accepted provenance run catalog identity differs from requested run");
    }

    let mut task_receipts = BTreeMap::new();
    let task_dir = format!("runs/{}/task_preparation_receipts", context.accepted_run_id);
    for (relative, bytes) in read_control_directory(&source_root, &task_dir)? {
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
            context.accepted_run_id.as_str(),
            AcceptedProvenanceRecordKind::TaskPreparationReceipt,
            &relative,
            &bytes,
        )?;
    }

    let stage_dir = format!(
        "runs/{}/accepted_stage_preparation_receipts",
        context.accepted_run_id
    );
    for (relative, bytes) in read_control_directory(&source_root, &stage_dir)? {
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
            context.accepted_run_id.as_str(),
            AcceptedProvenanceRecordKind::AcceptedStagePreparationReceipt,
            &relative,
            &bytes,
        )?;
    }

    let artifact_relative = format!("runs/{}/artifact_catalog.json", context.accepted_run_id);
    if let Some(bytes) = read_optional_control(&source_root, &artifact_relative)? {
        let artifact_catalog: FmsArtifactCatalog = serde_json::from_slice(&bytes)
            .context("accepted provenance artifact catalog is not typed")?;
        artifact_catalog.validate()?;
        if artifact_catalog.run_id != context.accepted_run_id {
            bail!("accepted provenance artifact catalog identity differs from run");
        }
        add_control_record_with_bytes(
            &mut records,
            context.accepted_run_id.as_str(),
            AcceptedProvenanceRecordKind::ArtifactCatalog,
            &artifact_relative,
            &bytes,
        )?;
        collect_artifact_objects(&store, &artifact_catalog, &mut cas_objects)?;
    }

    collect_solution_objects(
        &source_root,
        &store,
        context.accepted_run_id.as_str(),
        &intent,
        &mut records,
        &mut cas_objects,
    )?;

    let records = records.into_values().collect::<Vec<_>>();
    let cas_objects = cas_objects.into_values().collect::<Vec<_>>();
    let manifest =
        AcceptedProvenanceManifest::from_context(context, records.clone(), cas_objects.clone())?;
    let plan = AcceptedProvenancePlan {
        source_root: source_root.clone(),
        manifest,
        records: records
            .into_iter()
            .map(|record| AcceptedProvenanceSourceRecord {
                source_relative_path: record.source_path,
                archive_path: record.archive_path,
                kind: record.kind,
                content_sha256: record.content_sha256,
                byte_count: record.byte_count,
            })
            .collect(),
        cas_objects: cas_objects
            .into_iter()
            .map(|object| AcceptedProvenanceSourceObject {
                source_root: source_root.clone(),
                object_ref: object.object_ref,
                byte_count: object.byte_count,
            })
            .collect(),
    };
    plan.verify_sources()?;
    Ok(plan)
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
        }
    }
    Ok(())
}

fn collect_solution_objects(
    root: &Path,
    store: &SessionStore,
    run_id: &str,
    intent: &FmsRunIntent,
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
        directories.push(name);
    }
    directories.sort_unstable();
    for directory in directories {
        let manifest_relative = format!("solutions/{directory}/manifest.json");
        let manifest_bytes = read_control(root, &manifest_relative)?;
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
        for (relative, bytes) in read_control_directory(root, &revisions_relative)? {
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

fn add_cas_object(
    store: &SessionStore,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
    object_ref: &str,
) -> Result<()> {
    crate::cas::validate_hash(object_ref)?;
    let byte_count = store
        .cas()
        .verified_length(object_ref)?
        .with_context(|| format!("accepted provenance CAS object is missing: {object_ref}"))?;
    if byte_count == 0 {
        bail!("accepted provenance CAS object is empty");
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
    records: &mut BTreeMap<String, AcceptedProvenanceRecord>,
    run_id: &str,
    kind: AcceptedProvenanceRecordKind,
    source_path: &str,
) -> Result<Vec<u8>> {
    let bytes = read_control(root, source_path)?;
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

fn read_control(root: &Path, relative: &str) -> Result<Vec<u8>> {
    validate_relative_path(relative)?;
    read_bounded_regular_file(root, relative, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)
}

fn read_optional_control(root: &Path, relative: &str) -> Result<Option<Vec<u8>>> {
    let path = checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => read_control(root, relative).map(Some),
        Ok(_) => bail!("accepted provenance optional control record is not a file"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_control_directory(root: &Path, relative: &str) -> Result<Vec<(String, Vec<u8>)>> {
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
        names.push(name);
    }
    names.sort_unstable();
    names
        .into_iter()
        .map(|name| {
            let path = format!("{relative}/{name}");
            read_control(root, &path).map(|bytes| (path, bytes))
        })
        .collect()
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
