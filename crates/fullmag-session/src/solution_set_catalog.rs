//! Durable, monotonic catalog for immutable solution-set revisions.

use crate::cas::hex_sha256;
use crate::repository_path::{checked_path, create_parent, reject_link};
use crate::writer::{require_local_filesystem, Writer};
use anyhow::{bail, Context, Result};
use fullmag_quantities::{
    SolutionArtifactCoverage, SolutionExecutionStatus, SolutionMember, SolutionSet,
    SolutionSetManifestState,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct SolutionSetCatalog {
    root: PathBuf,
    writer: Arc<Writer>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolutionSetReconciliation {
    pub solution_set_id: String,
    pub previous_current_revision: Option<u64>,
    pub promoted_revision: Option<u64>,
    pub revision_count: usize,
}

impl SolutionSetCatalog {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        require_local_filesystem(&root)?;
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        Self::with_writer(root, writer)
    }

    pub(crate) fn with_writer(root: PathBuf, writer: Arc<Writer>) -> Result<Self> {
        let catalog = Self { root, writer };
        catalog.reconcile_all()?;
        Ok(catalog)
    }

    pub(crate) fn with_existing_writer(root: PathBuf, writer: Arc<Writer>) -> Self {
        Self { root, writer }
    }

    pub fn read(&self, solution_set_id: &str) -> Result<Option<SolutionSet>> {
        require_logical_id(solution_set_id)?;
        let path = self.current_manifest_path(solution_set_id)?;
        if !path.exists() {
            return Ok(None);
        }
        let solution = read_solution_set(&path)?;
        if solution.solution_set_id != solution_set_id {
            bail!(
                "solution-set catalog path identity mismatch: requested `{solution_set_id}`, found `{}`",
                solution.solution_set_id
            );
        }
        Ok(Some(solution))
    }

    pub fn read_revision(
        &self,
        solution_set_id: &str,
        revision: u64,
    ) -> Result<Option<SolutionSet>> {
        require_logical_id(solution_set_id)?;
        if revision == 0 {
            bail!("solution-set revision must be positive");
        }
        let path = self.revision_path(solution_set_id, revision)?;
        if !path.exists() {
            return Ok(None);
        }
        let solution = read_solution_set(&path)?;
        if solution.solution_set_id != solution_set_id || solution.revision != revision {
            bail!("solution-set revision path identity mismatch");
        }
        Ok(Some(solution))
    }

    pub fn list(&self) -> Result<Vec<SolutionSet>> {
        let solutions_root = checked_path(&self.root, "solutions")?;
        if !solutions_root.exists() {
            return Ok(Vec::new());
        }
        let mut solutions = Vec::new();
        for entry in fs::read_dir(&solutions_root)? {
            let entry = entry?;
            let directory_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 solution-set catalog directory"))?;
            validate_directory_name(&directory_name)?;
            let relative = format!("solutions/{directory_name}/manifest.json");
            let path = checked_path(&self.root, &relative)?;
            if !path.exists() {
                // A crash after immutable revision publication and before the
                // current-manifest commit leaves a safe recoverable orphan.
                continue;
            }
            let solution = read_solution_set(&path)?;
            if solution_directory(&solution.solution_set_id) != directory_name {
                bail!("solution-set catalog directory does not match logical identity");
            }
            solutions.push(solution);
        }
        solutions.sort_unstable_by(|left, right| left.solution_set_id.cmp(&right.solution_set_id));
        Ok(solutions)
    }

    #[cfg(test)]
    pub(crate) fn publish(&self, solution: &SolutionSet) -> Result<()> {
        let _lease = self.writer.acquire()?;
        self.publish_locked(solution)
    }

    pub(crate) fn publish_locked(&self, solution: &SolutionSet) -> Result<()> {
        solution
            .validate()
            .context("validating solution-set manifest")?;
        require_logical_id(&solution.solution_set_id)?;
        if solution.revision == 0 {
            bail!("solution-set revision must be positive");
        }

        let current = self.read(&solution.solution_set_id)?;
        if let Some(current) = &current {
            if solution.revision == current.revision {
                if solution == current {
                    return Ok(());
                }
                bail!("solution-set revision already exists with different content");
            }
            validate_successor(current, solution)?;
        } else if solution.revision != 1 {
            bail!("first solution-set revision must be 1");
        }

        let bytes = serde_json::to_vec_pretty(solution)?;
        let revision_path = create_parent(
            &self.root,
            &self.revision_relative_path(&solution.solution_set_id, solution.revision),
        )?;
        if revision_path.exists() {
            let persisted = read_solution_set(&revision_path)?;
            if persisted != *solution {
                bail!("immutable solution-set revision conflicts with persisted content");
            }
        } else {
            crate::durability::atomic_write(&revision_path, &bytes)?;
        }

        let current_path = create_parent(
            &self.root,
            &self.current_manifest_relative_path(&solution.solution_set_id),
        )?;
        crate::durability::atomic_write(&current_path, &bytes)
    }

    pub fn reconcile(&self, solution_set_id: &str) -> Result<SolutionSetReconciliation> {
        require_logical_id(solution_set_id)?;
        let _lease = self.writer.acquire()?;
        self.reconcile_locked(solution_set_id)
    }

    pub fn reconcile_all(&self) -> Result<Vec<SolutionSetReconciliation>> {
        let _lease = self.writer.acquire()?;
        let mut reconciliations = Vec::new();
        for solution_set_id in self.discover_solution_set_ids()? {
            reconciliations.push(self.reconcile_locked(&solution_set_id)?);
        }
        Ok(reconciliations)
    }

    /// Return CAS identities protected by immutable SolutionSet revisions.
    ///
    /// The caller must hold the repository writer lease. Every revision chain
    /// is validated before any identity is returned so pin retirement remains
    /// fail-closed after a crash between manifest publication and pin release.
    pub(crate) fn durable_objects_locked(&self) -> Result<BTreeMap<String, u64>> {
        let mut objects = BTreeMap::new();
        for solution_set_id in self.discover_solution_set_ids()? {
            let current = self.read(&solution_set_id)?;
            let revisions = self.read_revision_chain(&solution_set_id)?;
            if revisions.is_empty() {
                bail!("solution-set catalog entry has no immutable revision history");
            }

            let mut previous: Option<&SolutionSet> = None;
            for (index, (revision, solution)) in revisions.iter().enumerate() {
                let expected =
                    u64::try_from(index + 1).context("solution-set revision overflow")?;
                if *revision != expected || solution.revision != *revision {
                    bail!("solution-set revision history has a gap or path mismatch");
                }
                if let Some(previous) = previous {
                    validate_successor(previous, solution)?;
                }
                previous = Some(solution);

                for member in &solution.members {
                    for artifact in &member.artifacts {
                        register_durable_object(
                            &mut objects,
                            &artifact.object_ref,
                            artifact.byte_length,
                        )?;
                    }
                }
                for coverage in &solution.coverage {
                    for segment in &coverage.segments {
                        register_durable_object(
                            &mut objects,
                            &segment.object_ref,
                            segment.byte_length,
                        )?;
                    }
                }
            }

            if let Some(current) = current {
                let persisted = revisions
                    .get(&current.revision)
                    .context("solution-set current revision is missing")?;
                if persisted != &current {
                    bail!(
                        "current solution-set manifest conflicts with immutable revision history"
                    );
                }
            }
        }
        Ok(objects)
    }

    fn reconcile_locked(&self, solution_set_id: &str) -> Result<SolutionSetReconciliation> {
        let current = self.read(solution_set_id)?;
        let revisions = self.read_revision_chain(solution_set_id)?;
        if revisions.is_empty() {
            if current.is_some() {
                bail!("solution-set current manifest has no immutable revision history");
            }
            return Ok(SolutionSetReconciliation {
                solution_set_id: solution_set_id.to_string(),
                previous_current_revision: None,
                promoted_revision: None,
                revision_count: 0,
            });
        }

        let mut previous: Option<&SolutionSet> = None;
        for (index, (revision, solution)) in revisions.iter().enumerate() {
            let expected = u64::try_from(index + 1).context("solution-set revision overflow")?;
            if *revision != expected || solution.revision != *revision {
                bail!("solution-set revision history has a gap or path mismatch");
            }
            if let Some(previous) = previous {
                validate_successor(previous, solution)?;
            }
            previous = Some(solution);
        }

        let latest = previous.expect("non-empty revision chain has a latest revision");
        let previous_current_revision = current.as_ref().map(|value| value.revision);
        if let Some(current) = &current {
            let persisted = revisions
                .get(&current.revision)
                .ok_or_else(|| anyhow::anyhow!("current solution-set revision is missing"))?;
            if persisted != current {
                bail!("current solution-set manifest conflicts with immutable revision history");
            }
            if current.revision > latest.revision {
                bail!("current solution-set revision is ahead of immutable revision history");
            }
        }

        let promoted_revision =
            (previous_current_revision != Some(latest.revision)).then_some(latest.revision);
        if promoted_revision.is_some() {
            let bytes = serde_json::to_vec_pretty(latest)?;
            let current_path = create_parent(
                &self.root,
                &self.current_manifest_relative_path(solution_set_id),
            )?;
            crate::durability::atomic_write(&current_path, &bytes)?;
        }
        Ok(SolutionSetReconciliation {
            solution_set_id: solution_set_id.to_string(),
            previous_current_revision,
            promoted_revision,
            revision_count: revisions.len(),
        })
    }

    fn discover_solution_set_ids(&self) -> Result<Vec<String>> {
        let solutions_root = checked_path(&self.root, "solutions")?;
        if !solutions_root.exists() {
            return Ok(Vec::new());
        }
        let mut solution_set_ids = Vec::new();
        for entry in fs::read_dir(&solutions_root)? {
            let entry = entry?;
            let directory_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 solution-set catalog directory"))?;
            validate_directory_name(&directory_name)?;
            if !entry.file_type()?.is_dir() {
                bail!("invalid solution-set catalog entry `{directory_name}`");
            }

            let current_relative = format!("solutions/{directory_name}/manifest.json");
            let current_path = checked_path(&self.root, &current_relative)?;
            let discovered = if current_path.exists() {
                Some(read_solution_set(&current_path)?)
            } else {
                self.read_first_revision(&directory_name)?
            };
            let Some(solution) = discovered else {
                // A crash before the first immutable revision may leave only
                // empty catalog directories. They carry no recoverable state.
                continue;
            };
            if solution_directory(&solution.solution_set_id) != directory_name {
                bail!("solution-set catalog directory does not match logical identity");
            }
            solution_set_ids.push(solution.solution_set_id);
        }
        solution_set_ids.sort_unstable();
        solution_set_ids.dedup();
        Ok(solution_set_ids)
    }

    fn read_first_revision(&self, directory_name: &str) -> Result<Option<SolutionSet>> {
        let relative = format!("solutions/{directory_name}/revisions");
        let directory = checked_path(&self.root, &relative)?;
        if !directory.exists() {
            return Ok(None);
        }
        let mut first: Option<(u64, SolutionSet)> = None;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 solution-set revision filename"))?;
            let revision = parse_revision_entry(&entry, &file_name)?;
            let path = checked_path(&self.root, &format!("{relative}/{file_name}"))?;
            let solution = read_solution_set(&path)?;
            if solution.revision != revision {
                bail!("solution-set revision path identity mismatch");
            }
            if first
                .as_ref()
                .is_none_or(|(first_revision, _)| revision < *first_revision)
            {
                first = Some((revision, solution));
            }
        }
        Ok(first.map(|(_, solution)| solution))
    }

    fn current_manifest_path(&self, solution_set_id: &str) -> Result<PathBuf> {
        checked_path(
            &self.root,
            &self.current_manifest_relative_path(solution_set_id),
        )
    }

    fn revision_path(&self, solution_set_id: &str, revision: u64) -> Result<PathBuf> {
        checked_path(
            &self.root,
            &self.revision_relative_path(solution_set_id, revision),
        )
    }

    fn read_revision_chain(&self, solution_set_id: &str) -> Result<BTreeMap<u64, SolutionSet>> {
        let relative = format!(
            "solutions/{}/revisions",
            solution_directory(solution_set_id)
        );
        let directory = checked_path(&self.root, &relative)?;
        if !directory.exists() {
            return Ok(BTreeMap::new());
        }
        let mut revisions = BTreeMap::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 solution-set revision filename"))?;
            let revision = parse_revision_entry(&entry, &file_name)?;
            let relative_path = format!("{relative}/{file_name}");
            let path = checked_path(&self.root, &relative_path)?;
            let solution = read_solution_set(&path)?;
            if solution.solution_set_id != solution_set_id || solution.revision != revision {
                bail!("solution-set revision path identity mismatch");
            }
            if revisions.insert(revision, solution).is_some() {
                bail!("duplicate solution-set revision `{revision}`");
            }
        }
        Ok(revisions)
    }

    fn current_manifest_relative_path(&self, solution_set_id: &str) -> String {
        format!(
            "solutions/{}/manifest.json",
            solution_directory(solution_set_id)
        )
    }

    fn revision_relative_path(&self, solution_set_id: &str, revision: u64) -> String {
        format!(
            "solutions/{}/revisions/{revision:020}.json",
            solution_directory(solution_set_id)
        )
    }
}

fn register_durable_object(
    objects: &mut BTreeMap<String, u64>,
    object_ref: &str,
    byte_length: u64,
) -> Result<()> {
    if let Some(previous) = objects.insert(object_ref.to_string(), byte_length) {
        if previous != byte_length {
            bail!("solution-set object has conflicting declared lengths");
        }
    }
    Ok(())
}

fn validate_directory_name(directory_name: &str) -> Result<()> {
    if directory_name.len() != 64
        || !directory_name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("invalid solution-set catalog directory `{directory_name}`");
    }
    Ok(())
}

fn parse_revision_entry(entry: &fs::DirEntry, file_name: &str) -> Result<u64> {
    let revision_text = file_name
        .strip_suffix(".json")
        .filter(|value| value.len() == 20 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| anyhow::anyhow!("invalid solution-set revision filename `{file_name}`"))?;
    let revision = revision_text.parse::<u64>()?;
    if revision == 0 || !entry.file_type()?.is_file() {
        bail!("invalid solution-set revision entry `{file_name}`");
    }
    Ok(revision)
}

fn read_solution_set(path: &Path) -> Result<SolutionSet> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let solution: SolutionSet =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    solution
        .validate()
        .with_context(|| format!("validating {}", path.display()))?;
    Ok(solution)
}

fn require_logical_id(solution_set_id: &str) -> Result<()> {
    if solution_set_id.trim().is_empty()
        || solution_set_id.len() > 1024
        || solution_set_id.chars().any(char::is_control)
    {
        bail!("invalid logical solution_set_id");
    }
    Ok(())
}

fn solution_directory(solution_set_id: &str) -> String {
    hex_sha256(solution_set_id.as_bytes())
}

pub(crate) fn validate_successor(previous: &SolutionSet, next: &SolutionSet) -> Result<()> {
    if previous.manifest_state == SolutionSetManifestState::Closed {
        bail!("closed solution-set manifest is immutable");
    }
    let expected_revision = previous
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("solution-set revision overflow"))?;
    if next.revision != expected_revision {
        bail!("solution-set revisions must advance exactly by one");
    }
    if next.solution_set_id != previous.solution_set_id
        || next.run_id != previous.run_id
        || next.provenance != previous.provenance
    {
        bail!("solution-set identity or provenance changed across revisions");
    }
    validate_execution_transition(previous.execution_status, next.execution_status)?;

    let next_members = next
        .members
        .iter()
        .map(|member| (member.member_id.as_str(), member))
        .collect::<BTreeMap<_, _>>();
    for previous_member in &previous.members {
        let next_member = next_members
            .get(previous_member.member_id.as_str())
            .ok_or_else(|| anyhow::anyhow!("solution-set member was removed"))?;
        validate_member_successor(previous_member, next_member)?;
    }

    let next_coverage = next
        .coverage
        .iter()
        .map(|coverage| (coverage.artifact_id.as_str(), coverage))
        .collect::<BTreeMap<_, _>>();
    for previous_coverage in &previous.coverage {
        let next_entry = next_coverage
            .get(previous_coverage.artifact_id.as_str())
            .ok_or_else(|| anyhow::anyhow!("solution-set artifact coverage was removed"))?;
        validate_coverage_successor(previous_coverage, next_entry)?;
    }
    Ok(())
}

fn validate_member_successor(previous: &SolutionMember, next: &SolutionMember) -> Result<()> {
    if previous.task_id != next.task_id
        || previous.attempt_id != next.attempt_id
        || previous.ownership_epoch != next.ownership_epoch
        || previous.case_id != next.case_id
        || previous.stage_id != next.stage_id
    {
        bail!("solution-set member execution identity changed across revisions");
    }
    validate_execution_transition(previous.execution_status, next.execution_status)?;
    let next_artifacts = next
        .artifacts
        .iter()
        .map(|artifact| (artifact.artifact_id.as_str(), artifact))
        .collect::<BTreeMap<_, _>>();
    for previous_artifact in &previous.artifacts {
        if next_artifacts.get(previous_artifact.artifact_id.as_str()) != Some(&previous_artifact) {
            bail!("solution-set immutable artifact was removed or changed");
        }
    }
    Ok(())
}

fn validate_execution_transition(
    previous: SolutionExecutionStatus,
    next: SolutionExecutionStatus,
) -> Result<()> {
    if previous == SolutionExecutionStatus::Running || previous == next {
        Ok(())
    } else {
        bail!("terminal solution execution status cannot change")
    }
}

fn validate_coverage_successor(
    previous: &SolutionArtifactCoverage,
    next: &SolutionArtifactCoverage,
) -> Result<()> {
    if coverage_rank(next.state) < coverage_rank(previous.state)
        || (previous.expected_samples.is_some()
            && previous.expected_samples != next.expected_samples)
        || next.committed_samples < previous.committed_samples
        || !next.segments.starts_with(&previous.segments)
    {
        bail!("solution-set coverage must advance monotonically with immutable segments");
    }
    Ok(())
}

fn coverage_rank(state: fullmag_quantities::SolutionCoverageState) -> u8 {
    match state {
        fullmag_quantities::SolutionCoverageState::Unknown => 0,
        fullmag_quantities::SolutionCoverageState::Partial => 1,
        fullmag_quantities::SolutionCoverageState::Complete => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SessionStore;
    use fullmag_quantities::{
        ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind,
        SolutionArtifactRef, SolutionMember, SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
    };

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn solution(revision: u64, manifest_state: SolutionSetManifestState) -> SolutionSet {
        SolutionSet {
            schema_version: SOLUTION_SET_SCHEMA_VERSION.to_string(),
            solution_set_id: "solution:run-1".to_string(),
            revision,
            run_id: "run:1".to_string(),
            manifest_state,
            execution_status: if manifest_state == SolutionSetManifestState::Open {
                SolutionExecutionStatus::Running
            } else {
                SolutionExecutionStatus::Succeeded
            },
            scientific_assessment: ScientificAssessment {
                status: ScientificAssessmentStatus::Unassessed,
                reason: Some("assessment pending".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            provenance: SolutionSetProvenance {
                run_spec_digest: digest('a'),
                model_digest: digest('b'),
                physics_digest: digest('c'),
                discretization_digest: digest('d'),
                resolved_plan_digest: digest('e'),
                acquisition_digest: digest('f'),
                seed_digest: None,
            },
            members: Vec::new(),
            coverage: Vec::new(),
        }
    }

    fn solution_with_artifact(object_ref: String, byte_length: u64) -> SolutionSet {
        let mut solution = solution(1, SolutionSetManifestState::Open);
        solution.members.push(SolutionMember {
            member_id: "member:1".to_string(),
            task_id: "task:1".to_string(),
            attempt_id: "attempt:1".to_string(),
            ownership_epoch: 1,
            case_id: None,
            stage_id: "stage:1".to_string(),
            execution_status: SolutionExecutionStatus::Running,
            scientific_assessment: ScientificAssessment {
                status: ScientificAssessmentStatus::Unassessed,
                reason: Some("assessment pending".to_string()),
                evidence_artifact_ids: Vec::new(),
            },
            artifacts: vec![SolutionArtifactRef {
                artifact_id: "artifact:state".to_string(),
                kind: SolutionArtifactKind::State,
                schema_id: "fullmag.state.test.v1".to_string(),
                object_ref,
                byte_length,
                accepted_state: None,
            }],
        });
        solution
    }

    #[test]
    fn revisions_are_monotonic_and_closed_manifest_is_immutable() {
        let directory = tempfile::tempdir().expect("temporary catalog");
        let catalog = SolutionSetCatalog::open(directory.path()).expect("open catalog");
        catalog
            .publish(&solution(1, SolutionSetManifestState::Open))
            .expect("publish first revision");
        catalog
            .publish(&solution(2, SolutionSetManifestState::Closed))
            .expect("close solution set");

        assert_eq!(catalog.read("solution:run-1").unwrap().unwrap().revision, 2);
        assert!(catalog
            .publish(&solution(3, SolutionSetManifestState::Closed))
            .is_err());
        assert_eq!(
            catalog
                .read_revision("solution:run-1", 1)
                .unwrap()
                .unwrap()
                .manifest_state,
            SolutionSetManifestState::Open
        );
    }

    #[test]
    fn open_reconciles_valid_orphan_revision() {
        let directory = tempfile::tempdir().expect("temporary catalog");
        let catalog = SolutionSetCatalog::open(directory.path()).expect("open catalog");
        catalog
            .publish(&solution(1, SolutionSetManifestState::Open))
            .expect("publish first revision");
        let orphan = solution(2, SolutionSetManifestState::Closed);
        let orphan_path = create_parent(
            &catalog.root,
            &catalog.revision_relative_path(&orphan.solution_set_id, orphan.revision),
        )
        .expect("orphan path");
        crate::durability::atomic_write(
            &orphan_path,
            &serde_json::to_vec_pretty(&orphan).expect("serialize orphan"),
        )
        .expect("persist orphan revision");

        drop(catalog);
        let catalog = SolutionSetCatalog::open(directory.path()).expect("reopen catalog");
        assert_eq!(catalog.read("solution:run-1").unwrap(), Some(orphan));

        let outcome = catalog
            .reconcile("solution:run-1")
            .expect("reconcile recovered catalog");
        assert_eq!(outcome.previous_current_revision, Some(2));
        assert_eq!(outcome.promoted_revision, None);
    }

    #[test]
    fn session_store_open_reconciles_solution_set_catalog() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");
        let orphan = solution(2, SolutionSetManifestState::Closed);
        {
            let catalog = store.solution_sets();
            catalog
                .publish(&solution(1, SolutionSetManifestState::Open))
                .expect("publish first revision");
            let orphan_path = create_parent(
                &catalog.root,
                &catalog.revision_relative_path(&orphan.solution_set_id, orphan.revision),
            )
            .expect("orphan path");
            crate::durability::atomic_write(
                &orphan_path,
                &serde_json::to_vec_pretty(&orphan).expect("serialize orphan"),
            )
            .expect("persist orphan revision");
        }
        drop(store);

        let store = SessionStore::open(directory.path()).expect("reopen session store");
        assert_eq!(
            store.solution_sets().read("solution:run-1").unwrap(),
            Some(orphan)
        );
    }

    #[test]
    fn session_store_checks_cas_integrity_before_solution_publication() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");

        let missing = solution_with_artifact("0".repeat(64), 5);
        assert!(store.publish_solution_set(&missing).is_err());
        assert!(store
            .solution_sets()
            .read("solution:run-1")
            .unwrap()
            .is_none());

        let payload = b"state";
        let object_ref = store.cas().put(payload).expect("publish CAS object");
        let wrong_length = solution_with_artifact(object_ref.clone(), 6);
        assert!(store.publish_solution_set(&wrong_length).is_err());
        assert!(store
            .solution_sets()
            .read("solution:run-1")
            .unwrap()
            .is_none());

        store
            .publish_solution_set(&solution_with_artifact(object_ref, payload.len() as u64))
            .expect("publish verified solution set");
    }

    #[test]
    fn solution_set_objects_are_gc_reachable() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");
        let payload = b"retained state";
        let object_ref = store.cas().put(payload).expect("publish CAS object");
        store
            .publish_solution_set(&solution_with_artifact(
                object_ref.clone(),
                payload.len() as u64,
            ))
            .expect("publish verified solution set");

        let report = crate::reachability::walk_store_root(
            store.root(),
            crate::reachability::ReachabilityMode::Gc,
        )
        .expect("walk solution set reachability");
        assert!(report.complete);
        assert!(report.object_refs.contains(&object_ref));
        assert!(report
            .file_refs
            .iter()
            .any(|path| path.ends_with("/manifest.json")));
    }

    #[test]
    fn solution_set_publication_releases_only_its_rooted_pins() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");
        let referenced_payload = b"published solution state";
        let referenced = store
            .cas()
            .put(referenced_payload)
            .expect("publish referenced CAS object");
        let unrelated = store
            .cas()
            .put(b"unpublished ingest")
            .expect("publish unrelated CAS object");

        store
            .publish_solution_set(&solution_with_artifact(
                referenced.clone(),
                referenced_payload.len() as u64,
            ))
            .expect("publish verified solution set");

        let pins = store.cas().pinned_refs().expect("read CAS pins");
        assert!(!pins.contains(&referenced));
        assert!(pins.contains(&unrelated));
    }

    #[test]
    fn store_open_recovers_pin_release_after_manifest_only_commit() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");
        let payload = b"interrupted pin retirement";
        let object_ref = store.cas().put(payload).expect("publish CAS object");
        let solution = solution_with_artifact(object_ref.clone(), payload.len() as u64);
        {
            let _lease = store.write_transaction().expect("acquire writer");
            store
                .solution_sets()
                .publish_locked(&solution)
                .expect("commit immutable solution manifest");
        }
        assert!(store
            .cas()
            .pinned_refs()
            .expect("read pins before recovery")
            .contains(&object_ref));

        drop(store);
        let store = SessionStore::open(directory.path()).expect("reopen session store");
        assert!(!store
            .cas()
            .pinned_refs()
            .expect("read pins after recovery")
            .contains(&object_ref));
    }
}
