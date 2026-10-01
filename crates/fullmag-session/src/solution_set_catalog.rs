//! Durable, monotonic catalog for immutable solution-set revisions.

use crate::cas::{hex_sha256, CasStore};
use crate::repository_path::{checked_path, create_parent, reject_link};
use crate::writer::{require_local_filesystem, Writer};
use anyhow::{bail, Context, Result};
use fullmag_quantities::{
    SolutionArtifactCoverage, SolutionArtifactRef, SolutionExecutionStatus, SolutionMember,
    SolutionSet, SolutionSetManifestState,
};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

// This control-plane manifest must not grow into an unbounded data plane.
const MAX_SOLUTION_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

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

/// One immutable SolutionSet reference returned by run discovery.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionSetDiscoveryItem {
    pub solution_set_id: String,
    pub run_id: String,
    pub revision: u64,
    pub run_spec_digest: String,
    pub manifest_digest: String,
}

/// Bounded page of immutable SolutionSet references. The cursor is the
/// physical catalog directory boundary, not a logical mutable `CURRENT` alias.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolutionSetDiscoveryPage {
    pub items: Vec<SolutionSetDiscoveryItem>,
    pub next_after_directory: Option<String>,
}

const MAX_RUN_DISCOVERY_PAGE_LIMIT: usize = 50;

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

    /// Return a bounded page of published SolutionSet references for one run.
    ///
    /// Discovery scans immutable catalog directory names and reads at most
    /// `limit` current manifests. It never opens CAS or uses a mutable current
    /// session pointer as a result source.
    pub fn list_run_page(
        &self,
        run_id: &str,
        after_directory: Option<&str>,
        limit: usize,
    ) -> Result<SolutionSetDiscoveryPage> {
        crate::repository_path::validate_store_id(run_id)?;
        if !(1..=MAX_RUN_DISCOVERY_PAGE_LIMIT).contains(&limit) {
            bail!("solution-set discovery limit must be in 1..={MAX_RUN_DISCOVERY_PAGE_LIMIT}");
        }
        if let Some(cursor) = after_directory {
            validate_directory_name(cursor)?;
        }

        let solutions_root = checked_path(&self.root, "solutions")?;
        if !solutions_root.exists() {
            if after_directory.is_some() {
                bail!("solution-set discovery cursor is unknown");
            }
            return Ok(SolutionSetDiscoveryPage {
                items: Vec::new(),
                next_after_directory: None,
            });
        }

        let candidate_limit = limit
            .checked_add(1)
            .context("solution-set discovery page limit overflow")?;
        let mut candidates = std::collections::BTreeSet::new();
        let mut cursor_seen = after_directory.is_none();
        let mut has_more_candidates = false;
        for entry in fs::read_dir(&solutions_root)? {
            let entry = entry?;
            let entry_path = entry.path();
            reject_link(&entry_path)?;
            let directory_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 solution-set catalog directory"))?;
            validate_directory_name(&directory_name)?;
            if !entry.file_type()?.is_dir() {
                bail!("invalid solution-set catalog entry `{directory_name}`");
            }
            if after_directory == Some(directory_name.as_str()) {
                cursor_seen = true;
                continue;
            }
            if after_directory.is_some_and(|cursor| directory_name.as_str() <= cursor) {
                continue;
            }

            if candidates.len() < candidate_limit {
                candidates.insert(directory_name);
                continue;
            }
            has_more_candidates = true;
            let largest = candidates
                .iter()
                .next_back()
                .cloned()
                .expect("candidate limit is positive");
            if directory_name < largest {
                candidates.remove(&largest);
                candidates.insert(directory_name);
            }
        }
        if !cursor_seen {
            bail!("solution-set discovery cursor is unknown");
        }

        let candidates = candidates.into_iter().collect::<Vec<_>>();
        let mut items = Vec::with_capacity(limit.min(candidates.len()));
        let mut visited = 0usize;
        let mut manifests_read = 0usize;
        let mut last_visited = None;
        while visited < candidates.len() && manifests_read < limit {
            let directory_name = &candidates[visited];
            visited += 1;
            last_visited = Some(directory_name.clone());
            let relative = format!("solutions/{directory_name}/manifest.json");
            let path = checked_path(&self.root, &relative)?;
            if !path.exists() {
                // A directory without a current manifest is a recoverable
                // orphan; its directory boundary is still consumed.
                continue;
            }
            let solution = read_solution_set(&path)?;
            manifests_read += 1;
            if solution_directory(&solution.solution_set_id) != *directory_name {
                bail!("solution-set catalog directory does not match logical identity");
            }
            let immutable = self
                .read_revision(&solution.solution_set_id, solution.revision)?
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "solution-set current manifest has no immutable revision {}",
                        solution.revision
                    )
                })?;
            if immutable != solution {
                bail!("solution-set current manifest conflicts with immutable revision history");
            }
            if solution.run_id != run_id {
                continue;
            }
            let manifest_digest = solution_manifest_digest(&solution)?;
            items.push(SolutionSetDiscoveryItem {
                solution_set_id: solution.solution_set_id,
                run_id: solution.run_id,
                revision: solution.revision,
                run_spec_digest: solution.provenance.run_spec_digest,
                manifest_digest,
            });
        }

        let has_unvisited_candidate = visited < candidates.len() || has_more_candidates;
        Ok(SolutionSetDiscoveryPage {
            items,
            next_after_directory: has_unvisited_candidate.then_some(last_visited).flatten(),
        })
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

        // Validate the owner closure and every recognized payload before any
        // idempotent replay shortcut.  A replay must not turn a previously
        // valid pointer into an authorization for a missing or changed run
        // owner.
        self.verify_typed_artifacts(std::iter::once(solution))?;

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
        if bytes.len() as u64 > MAX_SOLUTION_MANIFEST_BYTES {
            bail!("solution-set manifest exceeds the 16 MiB control-plane budget");
        }
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

                // Recovery and durable-graph discovery are publication
                // boundaries too: a recognized tensor must still be owned by
                // the immutable run intent before its descriptor is parsed.
                crate::solution_tensor_source::verify_solution_tensor_run_owner(
                    &self.root, solution,
                )?;
                self.verify_materialized_dataset_artifacts(solution)?;
                self.verify_field_geometry_artifacts(solution)?;

                for member in &solution.members {
                    for artifact in &member.artifacts {
                        if artifact.schema_id == crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA {
                            let manifest = crate::solution_field_geometry::read_solution_field_geometry_manifest(
                                &self.existing_cas()?, artifact,
                            )?;
                            register_durable_object(&mut objects, &manifest.geometry.object_ref, manifest.geometry.byte_length)?;
                        }
                    }
                }

                for member in &solution.members {
                    for artifact in &member.artifacts {
                        register_durable_object(
                            &mut objects,
                            &artifact.object_ref,
                            artifact.byte_length,
                        )?;
                        // Recognized tensor roots expand to verified chunks;
                        // unknown schemas remain opaque for compatibility.
                        if artifact.schema_id
                            == crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA
                        {
                            let cas = self.existing_cas()?;
                            let chunks = verified_tensor_chunks(&cas, artifact)?;
                            for (object_ref, byte_length) in chunks {
                                register_durable_object(&mut objects, &object_ref, byte_length)?;
                            }
                        }
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

        // Reconciliation is allowed to promote only a graph whose every
        // immutable revision has a verified typed tensor payload.  Otherwise
        // the current pointer could publish a descriptor with missing chunks.
        self.verify_typed_artifacts(revisions.values())?;

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

    fn existing_cas(&self) -> Result<CasStore> {
        CasStore::existing(checked_path(&self.root, "objects")?, self.writer.clone())
    }

    fn verify_materialized_dataset_artifacts(&self, solution: &SolutionSet) -> Result<()> {
        if solution
            .members
            .iter()
            .flat_map(|member| &member.artifacts)
            .any(|artifact| {
                artifact.schema_id == crate::materialized_dataset::MATERIALIZED_DATASET_SCHEMA
            })
        {
            crate::materialized_dataset::verify_materialized_datasets_for_solution(
                &self.root,
                &self.existing_cas()?,
                solution,
            )?;
        }
        Ok(())
    }

    fn verify_typed_artifacts<'a>(
        &self,
        solutions: impl IntoIterator<Item = &'a SolutionSet>,
    ) -> Result<()> {
        let mut cas = None;
        for solution in solutions {
            // Keep the owner closure ahead of CAS/descriptor reads.  Unknown
            // schemas remain opaque because the shared helper is a no-op for
            // them.
            crate::solution_tensor_source::verify_solution_tensor_run_owner(&self.root, solution)?;
            self.verify_materialized_dataset_artifacts(solution)?;
            self.verify_field_geometry_artifacts(solution)?;
            for member in &solution.members {
                for artifact in &member.artifacts {
                    // Keep unknown schemas opaque until their typed contract
                    // is explicitly introduced.
                    if artifact.schema_id != crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA {
                        continue;
                    }
                    if cas.is_none() {
                        cas = Some(self.existing_cas()?);
                    }
                    let _ =
                        verified_tensor_chunks(cas.as_ref().expect("CAS initialized"), artifact)?;
                }
            }
        }
        Ok(())
    }

    fn verify_field_geometry_artifacts(&self, solution: &SolutionSet) -> Result<()> {
        if solution.members.iter().flat_map(|member| &member.artifacts).any(|artifact| {
            artifact.schema_id == crate::solution_field_geometry::SOLUTION_FIELD_GEOMETRY_SCHEMA
        }) {
            crate::solution_field_geometry::verify_field_geometries_for_solution(
                &self.root, &self.existing_cas()?, solution,
            )?;
        }
        Ok(())
    }
}

fn verified_tensor_chunks(
    cas: &CasStore,
    artifact: &SolutionArtifactRef,
) -> Result<Vec<(String, u64)>> {
    let descriptor = crate::solution_tensor_source::verify_solution_tensor_payload(cas, artifact)?;
    let mut chunks = Vec::with_capacity(descriptor.chunks.len());
    for chunk in descriptor.chunks {
        let expected_length =
            u64::try_from(chunk.length).context("solution tensor chunk length does not fit u64")?;
        chunks.push((chunk.object_ref, expected_length));
    }
    Ok(chunks)
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
    let file = fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_SOLUTION_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() as u64 > MAX_SOLUTION_MANIFEST_BYTES {
        bail!("solution-set manifest exceeds the 16 MiB control-plane budget");
    }
    let solution: SolutionSet =
        serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?;
    solution
        .validate()
        .with_context(|| format!("validating {}", path.display()))?;
    Ok(solution)
}

fn solution_manifest_digest(solution: &SolutionSet) -> Result<String> {
    let value =
        serde_json::to_value(solution).context("serializing SolutionSet manifest digest")?;
    Ok(format!("sha256:{}", crate::canonical_json_sha256(&value)))
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
    if previous.execution_status != SolutionExecutionStatus::Running
        && previous.artifacts.len() != next.artifacts.len()
    {
        bail!("terminal solution-set member cannot gain or lose artifacts");
    }
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
    use crate::FmsRunIntent;
    use fullmag_quantities::{
        ScientificAssessment, ScientificAssessmentStatus, SolutionArtifactKind,
        SolutionArtifactRef, SolutionMember, SolutionSetProvenance, SOLUTION_SET_SCHEMA_VERSION,
    };
    use serde_json::json;

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

    fn commit_tensor_owner(
        store: &SessionStore,
        solution: &mut SolutionSet,
        run_id: &str,
    ) -> FmsRunIntent {
        solution.run_id = run_id.to_string();
        let intent = FmsRunIntent::new(
            run_id,
            format!("intent-{run_id}"),
            json!({
                "run_id": run_id,
                "source": "solution-set-catalog-tests"
            }),
        );
        store
            .commit_run_intent(&intent)
            .expect("commit tensor run owner");
        solution.provenance.run_spec_digest = format!("sha256:{}", intent.payload_sha256);
        intent
    }

    fn tensor_solution_with_payload(
        store: &SessionStore,
        run_id: &str,
    ) -> (SolutionSet, String, String, u64) {
        let payload = 1.0_f64.to_le_bytes().to_vec();
        let chunk_ref = store.cas().put(&payload).expect("publish tensor chunk");

        let mut descriptor =
            crate::TensorDescriptor::new_f64("value", vec![1], vec!["sample".to_string()]);
        descriptor.chunks.push(crate::TensorChunk {
            object_ref: chunk_ref.clone(),
            offset: 0,
            length: payload.len(),
            sha256: Some(chunk_ref.clone()),
        });
        let descriptor_bytes = serde_json::to_vec_pretty(&descriptor).unwrap();
        let descriptor_ref = store
            .cas()
            .put(&descriptor_bytes)
            .expect("publish tensor descriptor");

        let mut value =
            solution_with_artifact(descriptor_ref.clone(), descriptor_bytes.len() as u64);
        value.run_id = run_id.to_string();
        value.members[0].artifacts[0].schema_id =
            crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA.to_string();
        (
            value,
            descriptor_ref,
            chunk_ref,
            descriptor_bytes.len() as u64,
        )
    }

    #[test]
    fn oversized_manifest_is_rejected_before_publishing_a_revision() {
        let directory = tempfile::tempdir().unwrap();
        let catalog = SolutionSetCatalog::open(directory.path()).unwrap();
        let mut value = solution(1, SolutionSetManifestState::Open);
        value.scientific_assessment.reason = Some("x".repeat(MAX_SOLUTION_MANIFEST_BYTES as usize));
        assert!(catalog
            .publish(&value)
            .unwrap_err()
            .to_string()
            .contains("16 MiB"));
        assert!(catalog.read(&value.solution_set_id).unwrap().is_none());
        assert!(catalog
            .read_revision(&value.solution_set_id, 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn direct_catalog_publish_rejects_unverified_tensor_before_revision_write() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let catalog = store.solution_sets();
        let mut value = solution_with_artifact("0".repeat(64), 1);
        value.members[0].artifacts[0].schema_id =
            crate::solution_tensor_source::SOLUTION_TENSOR_SCHEMA.to_string();
        commit_tensor_owner(&store, &mut value, "run-tensor-invalid");

        assert!(catalog.publish(&value).is_err());
        assert!(catalog.read(&value.solution_set_id).unwrap().is_none());
        assert!(catalog
            .read_revision(&value.solution_set_id, 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn typed_publication_rejects_missing_run_owner_before_revision_write() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let (value, _, _, _) = tensor_solution_with_payload(&store, "run-tensor-missing-owner");

        assert!(store.publish_solution_set(&value).is_err());
        assert!(store
            .solution_sets()
            .read(&value.solution_set_id)
            .unwrap()
            .is_none());
        assert!(store
            .solution_sets()
            .read_revision(&value.solution_set_id, 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn typed_publication_rejects_wrong_run_owner_digest_or_run() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let (mut wrong_digest, _, _, _) =
            tensor_solution_with_payload(&store, "run-tensor-wrong-digest");
        commit_tensor_owner(&store, &mut wrong_digest, "run-tensor-wrong-digest");
        wrong_digest.provenance.run_spec_digest = digest('a');

        assert!(store.publish_solution_set(&wrong_digest).is_err());
        assert!(store
            .solution_sets()
            .read(&wrong_digest.solution_set_id)
            .unwrap()
            .is_none());

        let other_directory = tempfile::tempdir().unwrap();
        let other_store = SessionStore::open(other_directory.path()).unwrap();
        let (mut wrong_run, _, _, _) =
            tensor_solution_with_payload(&other_store, "run-tensor-wrong-run");
        let owner = FmsRunIntent::new(
            "run-tensor-owner",
            "intent-run-tensor-owner",
            json!({
                "run_id": "run-tensor-owner",
                "source": "solution-set-catalog-tests"
            }),
        );
        other_store
            .commit_run_intent(&owner)
            .expect("commit owner for different run");
        let wrong_run_owner_path = create_parent(
            other_store.root(),
            "runs/run-tensor-wrong-run/run_intent.json",
        )
        .expect("create mismatched owner path");
        crate::durability::atomic_write(
            &wrong_run_owner_path,
            &serde_json::to_vec_pretty(&owner).expect("serialize mismatched owner"),
        )
        .expect("persist mismatched owner bytes");
        wrong_run.provenance.run_spec_digest = format!("sha256:{}", owner.payload_sha256);

        assert!(other_store.publish_solution_set(&wrong_run).is_err());
        assert!(other_store
            .solution_sets()
            .read(&wrong_run.solution_set_id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn typed_idempotent_replay_revalidates_run_owner() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let (mut value, _, _, _) = tensor_solution_with_payload(&store, "run-tensor-replay");
        commit_tensor_owner(&store, &mut value, "run-tensor-replay");
        store
            .publish_solution_set(&value)
            .expect("publish verified tensor solution");
        let before = store
            .solution_sets()
            .read(&value.solution_set_id)
            .unwrap()
            .expect("current solution-set manifest");

        fs::remove_file(
            store
                .root()
                .join("runs")
                .join("run-tensor-replay")
                .join("run_intent.json"),
        )
        .expect("remove owner for replay regression");

        assert!(store.solution_sets().publish(&value).is_err());
        assert_eq!(
            store.solution_sets().read(&value.solution_set_id).unwrap(),
            Some(before)
        );
    }

    #[test]
    fn oversized_control_file_is_rejected_before_json_parsing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("oversized.json");
        fs::write(&path, vec![b'x'; MAX_SOLUTION_MANIFEST_BYTES as usize + 1]).unwrap();
        assert!(read_solution_set(&path)
            .unwrap_err()
            .to_string()
            .contains("16 MiB"));
    }

    #[test]
    fn terminal_member_cannot_gain_artifacts_in_an_open_solution_set() {
        let directory = tempfile::tempdir().expect("temporary catalog");
        let catalog = SolutionSetCatalog::open(directory.path()).expect("open catalog");
        let first = solution_with_artifact("a".repeat(64), 1);
        catalog.publish(&first).expect("publish running member");
        let mut terminal = first.clone();
        terminal.revision = 2;
        terminal.members[0].execution_status = SolutionExecutionStatus::Succeeded;
        catalog
            .publish(&terminal)
            .expect("finish member while set remains open");
        let mut changed = terminal.clone();
        changed.revision = 3;
        let mut extra = changed.members[0].artifacts[0].clone();
        extra.artifact_id = "artifact:migration".into();
        extra.object_ref = "b".repeat(64);
        changed.members[0].artifacts.push(extra);
        assert!(catalog.publish(&changed).is_err());
        assert_eq!(
            catalog.read(&first.solution_set_id).unwrap(),
            Some(terminal)
        );
        assert!(catalog
            .read_revision(&first.solution_set_id, 3)
            .unwrap()
            .is_none());
    }

    #[test]
    fn running_member_can_publish_an_additional_immutable_artifact() {
        let directory = tempfile::tempdir().expect("temporary catalog");
        let catalog = SolutionSetCatalog::open(directory.path()).expect("open catalog");
        let first = solution_with_artifact("a".repeat(64), 1);
        catalog.publish(&first).expect("publish running member");
        let mut next = first.clone();
        next.revision = 2;
        let mut extra = next.members[0].artifacts[0].clone();
        extra.artifact_id = "artifact:second".into();
        extra.object_ref = "b".repeat(64);
        next.members[0].artifacts.push(extra);
        catalog
            .publish(&next)
            .expect("running member may extend its artifacts");
        assert_eq!(catalog.read(&first.solution_set_id).unwrap(), Some(next));
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
    fn recovery_rejects_typed_orphan_promotion_and_preserves_current_pointer() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");
        let (mut first, _, _, _) = tensor_solution_with_payload(&store, "run-tensor-recovery");
        commit_tensor_owner(&store, &mut first, "run-tensor-recovery");
        store
            .publish_solution_set(&first)
            .expect("publish verified first revision");
        let current_before = store
            .solution_sets()
            .read(&first.solution_set_id)
            .unwrap()
            .expect("current first revision");

        let owner_path = store
            .root()
            .join("runs")
            .join("run-tensor-recovery")
            .join("run_intent.json");
        fs::remove_file(owner_path).expect("remove owner before recovery");

        let mut orphan = first.clone();
        orphan.revision = 2;
        orphan.manifest_state = SolutionSetManifestState::Closed;
        orphan.execution_status = SolutionExecutionStatus::Succeeded;
        orphan.members[0].execution_status = SolutionExecutionStatus::Succeeded;
        let orphan_path = create_parent(
            &store.solution_sets().root,
            &store
                .solution_sets()
                .revision_relative_path(&orphan.solution_set_id, orphan.revision),
        )
        .expect("orphan path");
        crate::durability::atomic_write(
            &orphan_path,
            &serde_json::to_vec_pretty(&orphan).expect("serialize orphan"),
        )
        .expect("persist typed orphan revision");

        assert!(store
            .solution_sets()
            .reconcile(&first.solution_set_id)
            .is_err());
        assert_eq!(
            store.solution_sets().read(&first.solution_set_id).unwrap(),
            Some(current_before)
        );
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
    fn durable_solution_objects_include_verified_tensor_chunks() {
        let directory = tempfile::tempdir().expect("temporary session store");
        let store = SessionStore::open(directory.path()).expect("open session store");
        let (mut value, descriptor_ref, chunk_ref, descriptor_byte_length) =
            tensor_solution_with_payload(&store, "run-tensor-durable");
        commit_tensor_owner(&store, &mut value, "run-tensor-durable");
        store
            .publish_solution_set(&value)
            .expect("publish verified tensor solution");

        let _lease = store.write_transaction().expect("acquire writer lease");
        let durable = store
            .solution_sets()
            .durable_objects_locked()
            .expect("collect durable tensor graph");
        assert_eq!(durable.get(&descriptor_ref), Some(&descriptor_byte_length));
        assert_eq!(durable.get(&chunk_ref), Some(&8_u64));
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

    #[test]
    fn run_discovery_pages_filter_orphans_and_reject_invalid_cursors() {
        let directory = tempfile::tempdir().expect("temporary catalog");
        let catalog = SolutionSetCatalog::open(directory.path()).expect("open catalog");

        let mut ids = (0..6)
            .map(|index| format!("solution-discovery-{index}"))
            .collect::<Vec<_>>();
        ids.sort_by_key(|solution_set_id| solution_directory(solution_set_id));
        let other_run_id = ids[0].clone();
        for solution_set_id in &ids {
            let mut value = solution(1, SolutionSetManifestState::Open);
            value.solution_set_id = solution_set_id.clone();
            value.run_id = if solution_set_id == &other_run_id {
                "run-other".to_string()
            } else {
                "run-target".to_string()
            };
            catalog.publish(&value).expect("publish discovery manifest");
        }

        let mut orphan_directory = "0".repeat(64);
        if ids
            .iter()
            .any(|solution_set_id| solution_directory(solution_set_id) == orphan_directory)
        {
            orphan_directory = "f".repeat(64);
        }
        let orphan_path = checked_path(&catalog.root, &format!("solutions/{orphan_directory}"))
            .expect("orphan directory path");
        fs::create_dir_all(orphan_path).expect("create orphan directory");

        let first = catalog
            .list_run_page("run-target", None, 1)
            .expect("read first discovery page");
        assert!(first.items.is_empty());
        assert!(first.next_after_directory.is_some());

        let mut cursor = first.next_after_directory;
        let mut discovered = Vec::new();
        for _ in 0..20 {
            let page = catalog
                .list_run_page("run-target", cursor.as_deref(), 1)
                .expect("read discovery page");
            assert!(page.items.len() <= 1);
            discovered.extend(page.items.into_iter().map(|item| item.solution_set_id));
            cursor = page.next_after_directory;
            if cursor.is_none() {
                break;
            }
        }
        assert!(cursor.is_none(), "discovery pagination did not terminate");
        let expected = ids
            .into_iter()
            .skip(1)
            .collect::<std::collections::BTreeSet<_>>();
        let actual = discovered
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(actual, expected);

        assert!(catalog
            .list_run_page("run-target", Some("../escape"), 1)
            .is_err());
        assert!(catalog.list_run_page("../escape", None, 1).is_err());
        assert!(catalog.list_run_page("run-target", None, 0).is_err());
        assert!(catalog
            .list_run_page("run-target", None, MAX_RUN_DISCOVERY_PAGE_LIMIT + 1)
            .is_err());

        let unknown_cursor = "e".repeat(64);
        assert!(catalog
            .list_run_page("run-target", Some(&unknown_cursor), 1)
            .is_err());
    }

    #[test]
    fn run_discovery_preserves_large_revision_and_does_not_read_cas() {
        let directory = tempfile::tempdir().expect("temporary catalog");
        let catalog = SolutionSetCatalog::open(directory.path()).expect("open catalog");
        let mut value = solution_with_artifact("a".repeat(64), 7);
        value.solution_set_id = "solution-large-revision".to_string();
        value.run_id = "run-large-revision".to_string();
        value.revision = 9_007_199_254_740_993;

        let revision_path = create_parent(
            &catalog.root,
            &catalog.revision_relative_path(&value.solution_set_id, value.revision),
        )
        .expect("immutable manifest path");
        let bytes = serde_json::to_vec_pretty(&value).expect("serialize discovery manifest");
        crate::durability::atomic_write(&revision_path, &bytes)
            .expect("write immutable discovery manifest");
        let path = create_parent(
            &catalog.root,
            &catalog.current_manifest_relative_path(&value.solution_set_id),
        )
        .expect("manifest path");
        crate::durability::atomic_write(&path, &bytes).expect("write discovery manifest");

        let page = catalog
            .list_run_page("run-large-revision", None, 1)
            .expect("read discovery metadata without CAS");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].solution_set_id, value.solution_set_id);
        assert_eq!(page.items[0].revision, 9_007_199_254_740_993);
        assert_eq!(
            page.items[0].manifest_digest,
            solution_manifest_digest(&value).expect("canonical manifest digest")
        );
    }
}
