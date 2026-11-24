//! Evidence-only traversal of retained-field packages. No accepted-store authority is imported.
use serde_json::Value;
use super::*;
use std::collections::VecDeque;
use fullmag_antenna_artifacts::retained_current::{
    CasObjectRef, ParentInspectionOwner, RetainedCurrentFieldManifest, RetainedCurrentFieldManifestAny, RetainedCurrentFieldManifestRef,
    RETAINED_CURRENT_FIELD_CODEC_ID, RETAINED_CURRENT_FIELD_CODEC_VERSION,
    MAX_RECORD_BYTES_TOTAL, parse_retained_current_manifest_any,
    retained_current_field_manifest_length_any, validate_parent_evidence_bytes,
};

/// Validated immutable metadata, never proof of current execution or physical source admission.
#[derive(Debug)]
pub struct ValidatedRetainedParentEvidence {
    pub manifest: AcceptedEvidenceManifest,
    pub records: BTreeMap<String, Vec<u8>>,
    pub required_cas: BTreeMap<String, u64>,
}

#[derive(Default)]
pub(super) struct RetainedClosureWalk {
    metadata_bytes: u64,
    record_count: usize,
    object_lengths: BTreeMap<String, u64>,
    dependencies: BTreeMap<String, BTreeSet<String>>,
    child_manifests: BTreeMap<String, RetainedCurrentFieldManifestAny>,
    evidence: BTreeMap<String, ValidatedRetainedParentEvidence>,
    pending: VecDeque<String>,
    edges: BTreeMap<String, BTreeSet<String>>,
    current_package: Option<String>,
}

pub(super) fn is_retained_codec(codec: &str, version: &str) -> Result<bool> {
    if codec != RETAINED_CURRENT_FIELD_CODEC_ID { return Ok(false); }
    if !matches!(version, RETAINED_CURRENT_FIELD_CODEC_VERSION | "v2") {
        bail!("unsupported retained-current evidence codec version `{version}`");
    }
    Ok(true)
}

pub(super) fn is_retained_solution_schema(schema: &str) -> Result<bool> {
    let Some(version) = schema.strip_prefix(&format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@")) else {
        return Ok(false);
    };
    is_retained_codec(RETAINED_CURRENT_FIELD_CODEC_ID, version)
}

impl RetainedClosureWalk {
    fn charge_metadata(&mut self, bytes: u64) -> Result<()> {
        if bytes == 0 || bytes > MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64 {
            bail!("retained evidence metadata document exceeds its byte budget");
        }
        let total = self.metadata_bytes.checked_add(bytes)
            .context("retained evidence metadata byte total overflow")?;
        if total > MAX_RECORD_BYTES_TOTAL {
            bail!("retained evidence graph exceeds its aggregate metadata byte budget");
        }
        self.metadata_bytes = total;
        Ok(())
    }

    fn remember_length(&mut self, object_ref: &str, length: u64) -> Result<()> {
        crate::cas::validate_hash(object_ref)?;
        if let Some(previous) = self.object_lengths.get(object_ref) {
            if *previous != length { bail!("retained evidence CAS object changed length"); }
        } else {
            if self.object_lengths.len() >= MAX_ACCEPTED_PROVENANCE_OBJECTS {
                bail!("retained evidence graph exceeds its CAS object count budget");
            }
            self.object_lengths.insert(object_ref.to_owned(), length);
        }
        Ok(())
    }

    fn read_range(
        &mut self, object_ref: &str, offset: u64, count: u64,
        expected_length: Option<u64>, ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    ) -> Result<crate::cas::VerifiedCasRange> {
        if count == 0 || count > MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64 {
            bail!("retained evidence CAS range exceeds its positive metadata bound");
        }
        if !self.object_lengths.contains_key(object_ref)
            && self.object_lengths.len() >= MAX_ACCEPTED_PROVENANCE_OBJECTS {
            bail!("retained evidence graph exceeds its CAS object count budget before range read");
        }
        let range = ranges.as_mut().context(
            "retained-current portable evidence requires an explicit verified CAS range reader"
        )?(object_ref, offset, count)?.context("retained evidence CAS object is missing")?;
        if range.bytes.len() as u64 != count
            || offset.checked_add(count).is_none_or(|end| end > range.object_length)
            || expected_length.is_some_and(|length| length != range.object_length) {
            bail!("retained evidence CAS range length differs from its pinned object");
        }
        self.remember_length(object_ref, range.object_length)?;
        Ok(range)
    }

    fn metadata<F>(&mut self, object: &CasObjectRef, read_cas: &mut F) -> Result<Vec<u8>>
    where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        object.validate(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        if !self.object_lengths.contains_key(&object.object_ref)
            && self.object_lengths.len() >= MAX_ACCEPTED_PROVENANCE_OBJECTS {
            bail!("retained evidence graph exceeds its CAS object count budget before metadata read");
        }
        // Charge the declared bound before the callback can allocate an owned document.
        self.charge_metadata(object.byte_count)?;
        let bytes = read_cas(&object.object_ref)?.context("retained evidence metadata CAS is missing")?;
        if bytes.len() as u64 != object.byte_count || crate::hex_sha256(&bytes) != object.object_ref {
            bail!("retained evidence metadata CAS bytes differ from their pin");
        }
        self.remember_length(&object.object_ref, object.byte_count)?;
        Ok(bytes)
    }

    pub(super) fn discover<F>(
        &mut self, package: &str, expected_length: Option<u64>, expected_version: Option<&str>, read_cas: &mut F,
        ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    ) -> Result<BTreeSet<String>>
    where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        // A known new codec cannot silently degrade to direct-only v1 evidence.
        if ranges.is_none() {
            bail!("retained-current portable evidence requires an explicit verified CAS range reader");
        }
        if let Some(current) = &self.current_package {
            self.edges.entry(current.clone()).or_default().insert(package.to_owned());
        }
        if let Some(dependencies) = self.dependencies.get(package) {
            if expected_length.is_some_and(|length| self.object_lengths.get(package) != Some(&length)) {
                bail!("retained evidence repeated package has inconsistent lengths");
            }
            if expected_version.is_some_and(|version| self.child_manifests[package].as_ref().codec_version() != version) {
                bail!("retained evidence repeated package has inconsistent codec versions");
            }
            return Ok(dependencies.clone());
        }
        let header = self.read_range(package, 0, 16, expected_length, ranges)?;
        let manifest_length = retained_current_field_manifest_length_any(&header.bytes, header.object_length)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        self.charge_metadata(manifest_length as u64)?;
        let manifest_bytes = self.read_range(
            package, 16, manifest_length as u64, Some(header.object_length), ranges,
        )?.bytes;
        let child = parse_retained_current_manifest_any(&manifest_bytes)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let header_version = if &header.bytes[..8] == b"FMARCF1\0" { "v1" } else { "v2" };
        if child.as_ref().codec_version() != header_version
            || expected_version.is_some_and(|version| version != header_version) {
            bail!("retained evidence codec, header and manifest versions differ");
        }
        self.edges.entry(package.to_owned()).or_default();
        let evidence = self.load_parent(child.as_ref(), package, read_cas, ranges)?;
        let dependencies = evidence.required_cas.keys().cloned().collect::<BTreeSet<_>>();
        self.dependencies.insert(package.to_owned(), dependencies.clone());
        self.child_manifests.insert(package.to_owned(), child);
        self.evidence.insert(package.to_owned(), evidence);
        self.pending.push_back(package.to_owned());
        Ok(dependencies)
    }

    fn load_parent<F>(
        &mut self, child: RetainedCurrentFieldManifestRef<'_>, child_package: &str,
        read_cas: &mut F, ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    ) -> Result<ValidatedRetainedParentEvidence>
    where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        let capsule_bytes = self.metadata(&child.parent().evidence_capsule, read_cas)?;
        let capsule = validate_parent_evidence_bytes(child.parent(), &capsule_bytes)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let manifest_bytes = self.metadata(&capsule.accepted_provenance_manifest, read_cas)?;
        let manifest = AcceptedEvidenceManifest::from_bytes(&manifest_bytes)?;
        if manifest.accepted_run_id() != child.parent().owner.run_id {
            bail!("retained parent accepted evidence belongs to another run");
        }
        let next_records = self.record_count.checked_add(capsule.record_objects.len())
            .context("retained evidence aggregate record count overflow")?;
        if next_records > MAX_ACCEPTED_PROVENANCE_RECORDS {
            bail!("retained evidence graph exceeds its aggregate record count budget");
        }
        self.record_count = next_records;
        let pinned = capsule.record_objects.iter().map(|entry| (
            entry.archive_path.as_str(), (&entry.object.object_ref, entry.object.byte_count),
        )).collect::<BTreeMap<_, _>>();
        if pinned.len() != manifest.records().len() || manifest.records().iter().any(|record| {
            pinned.get(record.archive_path.as_str()).is_none_or(|(hash, bytes)|
                hash.as_str() != record.content_sha256 || *bytes != record.byte_count)
        }) {
            bail!("retained capsule record set differs from the typed accepted manifest");
        }
        let mut records = BTreeMap::new();
        let mut required_cas = BTreeMap::new();
        for dependency in child.metadata_dependencies().map_err(|error| anyhow::anyhow!(error.message))?
            .into_iter().chain(capsule.metadata_dependencies().map_err(|error| anyhow::anyhow!(error.message))?) {
            if dependency.object.object_ref == child_package {
                bail!("retained evidence directly references its child package");
            }
            required_cas.insert(dependency.object.object_ref, dependency.object.byte_count);
        }
        for record in &capsule.record_objects {
            records.insert(record.archive_path.clone(), self.metadata(&record.object, read_cas)?);
        }
        // These provisional dependencies only survive if every queued parent passes
        // the same exact typed closure validator. Listed unrelated extras cannot authorize edges.
        for object in manifest.cas_objects() {
            if let Some(previous) = required_cas.insert(object.object_ref.clone(), object.byte_count) {
                if previous != object.byte_count { bail!("retained evidence has conflicting CAS lengths"); }
            }
            if self.object_lengths.get(&object.object_ref) == Some(&object.byte_count) { continue; }
            if object.byte_count == 0 {
                let bytes = read_cas(&object.object_ref)?.context("retained empty input asset missing")?;
                if !bytes.is_empty() || crate::hex_sha256(&bytes) != object.object_ref {
                    bail!("retained empty input asset is corrupt");
                }
                self.remember_length(&object.object_ref, 0)?;
            } else {
                self.read_range(&object.object_ref, 0, 1, Some(object.byte_count), ranges)?;
            }
        }
        let output_bytes = self.metadata(&child.parent().owner.output_manifest, read_cas)?;
        validate_selected_parent_owner(&child.parent().owner, &manifest, &records, &output_bytes)?;
        Ok(ValidatedRetainedParentEvidence { manifest, records, required_cas })
    }

    pub(super) fn finish<F>(
        &mut self, read_cas: &mut F, ranges: &mut Option<&mut AcceptedEvidenceRangeReader<'_>>,
    ) -> Result<()>
    where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    {
        while let Some(package) = self.pending.pop_front() {
            let evidence = self.evidence.remove(&package).context("retained evidence pending job missing")?;
            self.current_package = Some(package.clone());
            // This calls the common typed core, not another planner or a recursive walker.
            validate_accepted_detached_records(
                evidence.manifest.accepted_run_id(), evidence.manifest.records(),
                evidence.manifest.cas_objects(), &evidence.records, |object| {
                    Ok(Some(read_cas(object)?.context("retained parent typed metadata CAS missing")?))
                }, true, ranges, self,
            )?;
            self.current_package = None;
            self.evidence.insert(package, evidence);
        }
        self.validate_acyclic()
    }

    fn validate_acyclic(&self) -> Result<()> {
        let mut indegree = self.edges.keys().map(|node| (node.as_str(), 0usize)).collect::<BTreeMap<_, _>>();
        for children in self.edges.values() {
            for child in children {
                let degree = indegree.get_mut(child.as_str()).context("retained dependency graph node missing")?;
                *degree = degree.checked_add(1).context("retained dependency graph edge overflow")?;
            }
        }
        let mut ready = indegree.iter().filter_map(|(node, degree)| (*degree == 0).then_some(*node)).collect::<VecDeque<_>>();
        let mut visited = 0usize;
        while let Some(node) = ready.pop_front() {
            visited += 1;
            for child in &self.edges[node] {
                let degree = indegree.get_mut(child.as_str()).expect("graph child already checked");
                *degree -= 1;
                if *degree == 0 { ready.push_back(child); }
            }
        }
        if visited != self.edges.len() { bail!("retained portable evidence dependency cycle"); }
        Ok(())
    }
}

fn validate_selected_parent_owner(
    owner: &ParentInspectionOwner, manifest: &AcceptedEvidenceManifest,
    records: &BTreeMap<String, Vec<u8>>, output_bytes: &[u8],
) -> Result<()>
{
    owner.validate_metadata().map_err(|error| anyhow::anyhow!(error.message))?;
    if crate::types::task_id_for_study_step(&owner.run_id, &owner.study_step_id)? != owner.task_id {
        bail!("retained parent selected task differs from its run and study step");
    }
    let mut task = None;
    let mut artifacts = None;
    let mut preparation = false;
    for record in manifest.records() {
        let bytes = records.get(&record.archive_path).context("retained parent record missing")?;
        match record.kind {
            AcceptedProvenanceRecordKind::RunIntent => {
                let intent: FmsRunIntent = serde_json::from_slice(bytes)?;
                if intent.specification.pointer("/snapshot/project_id").and_then(Value::as_str)
                    != Some(owner.project_id.as_str()) {
                    bail!("retained parent accepted project differs from its capsule");
                }
            }
            AcceptedProvenanceRecordKind::RunCatalog => {
                let catalog: FmsRunCatalog = serde_json::from_slice(bytes)?;
                task = catalog.tasks.into_iter().find(|task| task.task_id == owner.task_id);
            }
            AcceptedProvenanceRecordKind::ArtifactCatalog => {
                artifacts = Some(serde_json::from_slice::<FmsArtifactCatalog>(bytes)?);
            }
            AcceptedProvenanceRecordKind::TaskPreparationReceipt => {
                let receipt: FmsTaskPreparationReceipt = serde_json::from_slice(bytes)?;
                if receipt.task_id == owner.task_id { preparation = true; }
            }
            _ => {}
        }
    }
    let task = task.context("retained parent selected task absent")?;
    if task.lifecycle != crate::types::FmsTaskLifecycle::Succeeded
        || task.attempt_id.as_deref() != Some(owner.attempt_id.as_str())
        || task.ownership_epoch.map(|epoch| epoch.to_string()).as_deref() != Some(owner.ownership_epoch.as_str())
        || !preparation || !task.artifact_ids.contains(&owner.artifact_id)
        || !task.artifact_ids.contains(&owner.output_manifest_artifact_id) {
        bail!("retained parent task/attempt/preparation ownership differs");
    }
    let artifacts = artifacts.context("retained parent artifact catalog absent")?;
    for (id, expected, kind) in [
        (&owner.artifact_id, &owner.package, "artifact"),
        (&owner.output_manifest_artifact_id, &owner.output_manifest, "study_output_manifest"),
    ] {
        let entries = artifacts.entries.iter().filter(|entry| entry.artifact_id == *id).collect::<Vec<_>>();
        let [entry] = entries.as_slice() else { bail!("retained parent selected artifact is not unique"); };
        if entry.task_id != owner.task_id || entry.attempt_id != owner.attempt_id
            || entry.ownership_epoch.to_string() != owner.ownership_epoch
            || entry.artifact_type != kind || entry.status != crate::types::FmsArtifactStatus::Published
            || entry.object_ref.as_deref() != Some(expected.object_ref.as_str())
            || entry.content_sha256 != expected.object_ref
            || !manifest.cas_objects().iter().any(|object|
                object.object_ref == expected.object_ref && object.byte_count == expected.byte_count) {
            bail!("retained parent selected artifact differs from its immutable pin");
        }
    }
    if output_bytes.len() as u64 != owner.output_manifest.byte_count || crate::hex_sha256(output_bytes) != owner.output_manifest.object_ref {
        bail!("retained parent output manifest CAS pin differs");
    }
    let output: FmsStudyOutputManifest = serde_json::from_slice(output_bytes)?;
    output.validate()?;
    let [item] = output.outputs.as_slice() else { bail!("retained parent output is not unique"); };
    if output.run_id != owner.run_id || output.task_id != owner.task_id || output.step_id != owner.study_step_id
        || output.attempt_id != owner.attempt_id || output.ownership_epoch.to_string() != owner.ownership_epoch
        || output.accepted_state_ref.is_some() || output.observation_source.is_some()
        || item.artifact_id != owner.artifact_id || item.object_ref != owner.package.object_ref
        || item.content_sha256 != owner.package.object_ref || item.codec_id != owner.package_codec_id
        || item.codec_version != owner.package_codec_version || item.data_kind != "artifact" || item.case_id != "default" {
        bail!("retained parent output owner/codec differs from the full closed-loop source");
    }
    Ok(())
}

pub fn validate_retained_current_parent_evidence<F, G>(
    child_package: &str, child: &RetainedCurrentFieldManifest, read_cas: F, read_range: G,
) -> Result<ValidatedRetainedParentEvidence>
where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    G: FnMut(&str, u64, u64) -> Result<Option<crate::cas::VerifiedCasRange>>,
{
    validate_retained_current_parent_evidence_any(child_package,
        RetainedCurrentFieldManifestRef::SurfaceV1(child), read_cas, read_range)
}

pub fn validate_retained_current_parent_evidence_any<F, G>(
    child_package: &str, child: RetainedCurrentFieldManifestRef<'_>,
    mut read_cas: F, mut read_range: G,
) -> Result<ValidatedRetainedParentEvidence>
where F: FnMut(&str) -> Result<Option<Vec<u8>>>,
    G: FnMut(&str, u64, u64) -> Result<Option<crate::cas::VerifiedCasRange>>,
{
    child.validate_metadata().map_err(|error| anyhow::anyhow!(error.message))?;
    let mut walk = RetainedClosureWalk::default();
    let mut ranges: Option<&mut AcceptedEvidenceRangeReader<'_>> = Some(&mut read_range);
    walk.discover(child_package, None, Some(child.codec_version()), &mut read_cas, &mut ranges)?;
    let actual = walk.child_manifests.get(child_package).context("retained child manifest absent")?;
    let equal = match (actual, child) {
        (RetainedCurrentFieldManifestAny::SurfaceV1(a), RetainedCurrentFieldManifestRef::SurfaceV1(b)) => a == b,
        (RetainedCurrentFieldManifestAny::DirectV2(a), RetainedCurrentFieldManifestRef::DirectV2(b)) => a == b,
        _ => false,
    };
    if !equal { bail!("retained child manifest differs from its verified package header"); }
    walk.finish(&mut read_cas, &mut ranges)?;
    walk.evidence.remove(child_package).context("validated retained parent evidence missing")
}

pub(super) fn collect_source_objects(
    store: &SessionStore, package: &str, expected_length: Option<u64>, expected_version: &str,
    objects: &mut BTreeMap<String, AcceptedProvenanceCasObject>,
) -> Result<()> {
    let mut read_cas = |object: &str| store.cas().get_bounded(object, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64);
    let mut read_range = |object: &str, offset, count| store.cas().get_verified_range(
        object, offset, count, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64,
    );
    let mut ranges: Option<&mut AcceptedEvidenceRangeReader<'_>> = Some(&mut read_range);
    let mut walk = RetainedClosureWalk::default();
    walk.discover(package, expected_length, Some(expected_version), &mut read_cas, &mut ranges)?;
    walk.finish(&mut read_cas, &mut ranges)?;
    for (object_ref, byte_count) in walk.object_lengths {
        if let Some(previous) = objects.get(&object_ref) {
            if previous.byte_count != byte_count { bail!("retained source CAS length changed"); }
        } else {
            if objects.len() >= MAX_ACCEPTED_PROVENANCE_OBJECTS {
                bail!("retained source CAS object count exceeds its budget");
            }
            objects.insert(object_ref.clone(), AcceptedProvenanceCasObject { object_ref, byte_count });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dtq_v2_archive_rejects_cycle_extra_source_and_oversize() {
        assert!(is_retained_codec(RETAINED_CURRENT_FIELD_CODEC_ID, "v2").unwrap());
        assert!(is_retained_codec(RETAINED_CURRENT_FIELD_CODEC_ID, "v3").is_err());
        let mut walk = RetainedClosureWalk::default();
        walk.edges.insert("child".into(), BTreeSet::from(["child".into()]));
        assert!(walk.validate_acyclic().is_err());
        let mut calls = 0;
        let object = CasObjectRef { object_ref: "a".repeat(64),
            byte_count: MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64 + 1 };
        assert!(walk.metadata(&object, &mut |_| { calls += 1; Ok(None) }).is_err());
        assert_eq!(calls, 0);
    }
    #[test]
    fn codec_is_exact_and_legacy_metadata_reader_cannot_ignore_retained_bundle() {
        assert!(!is_retained_codec("another.codec", "v1").unwrap());
        assert!(is_retained_codec(RETAINED_CURRENT_FIELD_CODEC_ID, "v1").unwrap());
        assert!(is_retained_codec(RETAINED_CURRENT_FIELD_CODEC_ID, "v3").is_err());
        assert!(is_retained_solution_schema(&format!("{RETAINED_CURRENT_FIELD_CODEC_ID}@v1")).unwrap());
        assert!(!is_retained_solution_schema(RETAINED_CURRENT_FIELD_CODEC_ID).unwrap());
        let mut walk = RetainedClosureWalk::default();
        let mut reads = 0;
        assert!(walk.discover(&"a".repeat(64), None, None, &mut |_| { reads += 1; Ok(None) }, &mut None).is_err());
        assert_eq!(reads, 0);
    }
    #[test]
    fn graph_cycle_check_is_iterative_and_accepts_shared_acyclic_dependencies() {
        let mut walk = RetainedClosureWalk::default();
        walk.edges = BTreeMap::from([
            ("a".into(), BTreeSet::from(["b".into(), "c".into()])),
            ("b".into(), BTreeSet::from(["c".into()])),
            ("c".into(), BTreeSet::new()),
        ]);
        walk.validate_acyclic().unwrap();
        walk.edges.get_mut("c").unwrap().insert("a".into());
        assert!(walk.validate_acyclic().is_err());
    }
    #[test]
    fn aggregate_metadata_is_charged_before_read_and_ranges_bind_total_length() {
        let mut walk = RetainedClosureWalk::default();
        for _ in 0..4 { walk.charge_metadata(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64).unwrap(); }
        assert!(walk.charge_metadata(1).is_err());
        let mut calls = 0;
        let mut reader = |_: &str, _: u64, _: u64| {
            calls += 1;
            Ok(Some(crate::cas::VerifiedCasRange { bytes: vec![0; 16], object_length: 32 }))
        };
        assert!(walk.read_range(&"a".repeat(64), 0, 16, Some(64), &mut Some(&mut reader)).is_err());
        assert_eq!(calls, 1);
    }
}
