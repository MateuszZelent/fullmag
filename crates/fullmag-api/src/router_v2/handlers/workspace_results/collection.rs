//! Bounded aggregation of independently revisioned accepted-output leaves.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use fullmag_workspace_inspect::{
    ensure_results_revision, read_results_catalog, ResultsError, ResultsReadBudget,
    WorkspaceResultArray, WorkspaceResultEntry, WorkspaceResultEntryKind,
    WorkspaceResultEntryPayload, WorkspaceResultEntryStatus, WorkspaceResultsCatalog,
    WorkspaceResultsSource, WorkspaceResultsStatus,
};
use sha2::{Digest, Sha256};

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
const MAX_MEMBERS: usize = 256;
const MEMBER_ROOT_INNER_ID: &str = "__workspace_member_root__";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Member {
    pub root: PathBuf,
    pub run_id: String,
    pub label: String,
    pub identity: String,
}

struct CapturedMember {
    member: Member,
    key: String,
    leaf_revision: String,
    leaf_total_count: usize,
}

pub(super) struct CollectionSnapshot {
    accepted_run_id: String,
    members: Vec<CapturedMember>,
    pub(super) revision: String,
    total_count: usize,
}

#[derive(Debug, Clone)]
pub(super) struct Target {
    pub root: PathBuf,
    pub run_id: String,
    /// Revision of the underlying leaf, used with the public leaf reader.
    pub revision: String,
    pub inner_id: String,
    pub key: String,
    pub label: String,
}

impl CollectionSnapshot {
    pub(super) fn capture(
        accepted_run_id: &str,
        mut members: Vec<Member>,
    ) -> Result<Self, ResultsError> {
        let _budget = ResultsReadBudget::begin();
        if accepted_run_id.is_empty() {
            return Err(ResultsError::Invalid(
                "accepted output run identity is empty".into(),
            ));
        }
        if members.len() > MAX_MEMBERS {
            return Err(ResultsError::TooLarge(format!(
                "accepted output collection exceeds {MAX_MEMBERS} members"
            )));
        }
        members.sort_by(|left, right| {
            left.label
                .cmp(&right.label)
                .then_with(|| left.identity.cmp(&right.identity))
                .then_with(|| left.run_id.cmp(&right.run_id))
        });

        let mut keys = BTreeSet::new();
        let mut captured = Vec::with_capacity(members.len());
        let mut total_count = 0_usize;
        for member in members {
            if member.label.is_empty() || member.identity.is_empty() || member.run_id.is_empty() {
                return Err(ResultsError::Invalid(
                    "accepted output member identity, label, and run id must be nonempty".into(),
                ));
            }
            let key = member_key(&member);
            if !keys.insert(key.clone()) {
                return Err(ResultsError::Invalid(
                    "accepted output members do not have unique scoped identities".into(),
                ));
            }
            // Keep only the leaf revision and count. The one-entry page is
            // intentionally discarded; later pages read only the requested range.
            let leaf = read_results_catalog(
                &member.root,
                None,
                1,
                Some(&member.run_id),
                WorkspaceResultsSource::Current,
            )?;
            if leaf.run_id.as_deref() != Some(member.run_id.as_str()) {
                return Err(ResultsError::SourceChanged);
            }
            let block_count = leaf
                .total_count
                .checked_add(1)
                .ok_or_else(|| ResultsError::TooLarge("collection entry count overflow".into()))?;
            total_count = total_count
                .checked_add(block_count)
                .ok_or_else(|| ResultsError::TooLarge("collection entry count overflow".into()))?;
            captured.push(CapturedMember {
                member,
                key,
                leaf_revision: leaf.revision,
                leaf_total_count: leaf.total_count,
            });
        }

        captured.sort_by(|left, right| {
            left.member
                .label
                .cmp(&right.member.label)
                .then_with(|| left.member.identity.cmp(&right.member.identity))
                .then_with(|| left.member.run_id.cmp(&right.member.run_id))
                .then_with(|| left.leaf_revision.cmp(&right.leaf_revision))
        });
        let revision = collection_revision(accepted_run_id, &captured);

        // Ensure the members were simultaneously stable across the capture,
        // rather than merely stable while each individual leaf was scanned.
        for captured_member in &captured {
            ensure_results_revision(
                &captured_member.member.root,
                &captured_member.leaf_revision,
                Some(&captured_member.member.run_id),
            )?;
        }

        Ok(Self {
            accepted_run_id: accepted_run_id.to_string(),
            members: captured,
            revision,
            total_count,
        })
    }

    pub(super) fn capture_selected(
        accepted_run_id: &str,
        members: Vec<Member>,
        scoped_id: &str,
    ) -> Result<Self, ResultsError> {
        if members.len() > MAX_MEMBERS {
            return Err(ResultsError::TooLarge(format!(
                "accepted output collection exceeds {MAX_MEMBERS} members"
            )));
        }
        let (selected_key, _) = split_scoped_id(scoped_id)?;
        let mut selected = None;
        for member in members {
            if member_key(&member) == selected_key {
                if selected.is_some() {
                    return Err(ResultsError::Invalid(
                        "scoped result member identity is ambiguous".into(),
                    ));
                }
                selected = Some(member);
            }
        }
        let selected =
            selected.ok_or_else(|| ResultsError::NotFound("scoped result member".into()))?;
        Self::capture(accepted_run_id, vec![selected])
    }

    pub(super) fn catalog(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<WorkspaceResultsCatalog, ResultsError> {
        let _budget = ResultsReadBudget::begin();
        let offset = parse_collection_cursor(cursor, &self.revision)?;
        let limit = if limit == 0 {
            DEFAULT_LIMIT
        } else {
            limit.min(MAX_LIMIT)
        };
        let end = offset.saturating_add(limit).min(self.total_count);
        let mut entries = Vec::with_capacity(end.saturating_sub(offset).min(limit));
        let mut block_start = 0_usize;

        for captured in &self.members {
            let leaf_start = block_start
                .checked_add(1)
                .ok_or_else(|| ResultsError::TooLarge("collection offset overflow".into()))?;
            let block_end = leaf_start
                .checked_add(captured.leaf_total_count)
                .ok_or_else(|| ResultsError::TooLarge("collection offset overflow".into()))?;

            if offset <= block_start && block_start < end {
                entries.push(member_directory_entry(captured));
            }

            let requested_start = offset.max(leaf_start);
            let requested_end = end.min(block_end);
            if requested_start < requested_end {
                let leaf_offset = requested_start - leaf_start;
                let leaf_limit = requested_end - requested_start;
                // A revision-pinned leaf cursor is used even at offset zero,
                // so every returned page is tied to the captured leaf revision.
                let leaf_cursor = format!("{}:{leaf_offset}", captured.leaf_revision);
                let leaf = read_results_catalog(
                    &captured.member.root,
                    Some(&leaf_cursor),
                    leaf_limit,
                    Some(&captured.member.run_id),
                    WorkspaceResultsSource::Current,
                )?;
                if leaf.revision != captured.leaf_revision
                    || leaf.total_count != captured.leaf_total_count
                    || leaf.run_id.as_deref() != Some(captured.member.run_id.as_str())
                    || leaf.entries.len() != leaf_limit
                {
                    return Err(ResultsError::SourceChanged);
                }
                for mut entry in leaf.entries {
                    let target = target_for(captured, entry.id.clone());
                    normalize_entry_fields(&target, &mut entry);
                    entries.push(entry);
                }
            }
            block_start = block_end;
        }

        let can_read_values = entries.iter().any(|entry| {
            entry.status == WorkspaceResultEntryStatus::Ready && entry.array_id.is_some()
        });
        let can_visualize_3d = entries.iter().any(|entry| {
            entry.status == WorkspaceResultEntryStatus::Ready
                && entry.array_id.is_some()
                && entry.reason.is_none()
        });
        let partial = entries.iter().any(|entry| {
            matches!(
                entry.status,
                WorkspaceResultEntryStatus::Unsupported | WorkspaceResultEntryStatus::Unreadable
            )
        });
        let next_cursor = (end < self.total_count).then(|| format!("{}:{end}", self.revision));

        Ok(WorkspaceResultsCatalog {
            schema: "fullmag.results-catalog.v1".into(),
            revision: self.revision.clone(),
            resource_binding: WorkspaceResultsSource::Current,
            root_label: self.accepted_run_id.clone(),
            run_id: Some(self.accepted_run_id.clone()),
            status: if self.total_count == 0 {
                WorkspaceResultsStatus::Empty
            } else if partial {
                WorkspaceResultsStatus::Partial
            } else {
                WorkspaceResultsStatus::Ready
            },
            reason: partial.then(|| "one or more entries are metadata-only or unsupported".into()),
            can_read_values,
            can_visualize_3d,
            entries,
            next_cursor,
            total_count: self.total_count,
            truncated: self.total_count > end,
        })
    }

    /// Resolve a scoped reader id without deriving any filesystem path from it.
    pub(super) fn resolve(
        &self,
        scoped_id: &str,
        expected_revision: &str,
    ) -> Result<Target, ResultsError> {
        let (key, inner_id) = split_scoped_id(scoped_id)?;
        let captured = self
            .members
            .iter()
            .find(|member| member.key == key)
            .ok_or_else(|| ResultsError::NotFound("scoped result member".into()))?;
        let expected_leaf_revision = leaf_revision_token(captured);
        if expected_revision != self.revision && expected_revision != expected_leaf_revision {
            return Err(ResultsError::StaleRevision);
        }
        Ok(target_for(captured, inner_id.to_string()))
    }

    /// Stable revision for arrays that does not change when a sibling leaf is added.
    pub(super) fn array_revision(&self, target: &Target) -> String {
        self.member_for_target(target)
            .map(leaf_revision_token)
            .unwrap_or_else(|| format!("leaf:{}:{}", target.key, target.revision))
    }

    pub(super) fn normalize_array(
        &self,
        target: &Target,
        mut array: WorkspaceResultArray,
    ) -> WorkspaceResultArray {
        array.id = scoped_id(&target.key, &array.id);
        array.path = scoped_path(&target.label, &array.path);
        array.revision = self.array_revision(target);
        if let Some(geometry) = array.geometry.as_mut() {
            if let Some(topology_array_id) = geometry.topology_array_id.as_mut() {
                *topology_array_id = scoped_id(&target.key, topology_array_id);
            }
        }
        array
    }

    pub(super) fn normalize_entry(
        &self,
        target: &Target,
        mut payload: WorkspaceResultEntryPayload,
    ) -> WorkspaceResultEntryPayload {
        normalize_entry_fields(target, &mut payload.entry);
        payload.revision = self.revision.clone();
        payload
    }

    pub(super) fn ensure_unchanged(&self) -> Result<(), ResultsError> {
        let _budget = ResultsReadBudget::begin();
        for captured in &self.members {
            ensure_results_revision(
                &captured.member.root,
                &captured.leaf_revision,
                Some(&captured.member.run_id),
            )?;
        }
        Ok(())
    }

    fn member_for_target(&self, target: &Target) -> Option<&CapturedMember> {
        self.members.iter().find(|captured| {
            captured.key == target.key
                && captured.member.root == target.root
                && captured.member.run_id == target.run_id
                && captured.member.label == target.label
                && captured.leaf_revision == target.revision
        })
    }
}

fn target_for(captured: &CapturedMember, inner_id: String) -> Target {
    Target {
        root: captured.member.root.clone(),
        run_id: captured.member.run_id.clone(),
        revision: captured.leaf_revision.clone(),
        inner_id,
        key: captured.key.clone(),
        label: captured.member.label.clone(),
    }
}

fn normalize_entry_fields(target: &Target, entry: &mut WorkspaceResultEntry) {
    entry.id = scoped_id(&target.key, &entry.id);
    entry.path = scoped_path(&target.label, &entry.path);
    entry.parent_id = Some(
        entry
            .parent_id
            .take()
            .map(|parent_id| scoped_id(&target.key, &parent_id))
            .unwrap_or_else(|| member_root_id(&target.key)),
    );
    if let Some(array_id) = entry.array_id.as_mut() {
        *array_id = scoped_id(&target.key, array_id);
    }
}

fn member_directory_entry(captured: &CapturedMember) -> WorkspaceResultEntry {
    let name = Path::new(&captured.member.label)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| captured.member.label.clone());
    WorkspaceResultEntry {
        id: member_root_id(&captured.key),
        path: captured.member.label.clone(),
        parent_id: None,
        name,
        kind: WorkspaceResultEntryKind::Directory,
        size_bytes: None,
        array_id: None,
        mime_type: None,
        format: Some("directory".into()),
        status: WorkspaceResultEntryStatus::Ready,
        reason: None,
    }
}

fn member_root_id(key: &str) -> String {
    scoped_id(key, MEMBER_ROOT_INNER_ID)
}

fn scoped_id(key: &str, inner_id: &str) -> String {
    format!("{key}~{inner_id}")
}

fn scoped_path(label: &str, inner_path: &str) -> String {
    if inner_path.is_empty() {
        label.to_string()
    } else {
        format!("{label}/{inner_path}")
    }
}

fn split_scoped_id(scoped_id: &str) -> Result<(&str, &str), ResultsError> {
    let (key, inner_id) = scoped_id
        .split_once('~')
        .ok_or_else(|| ResultsError::NotFound("invalid scoped result id".into()))?;
    if key.len() != 64
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || inner_id.is_empty()
        || inner_id.contains('~')
        || inner_id.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(ResultsError::NotFound("invalid scoped result id".into()));
    }
    Ok((key, inner_id))
}

fn member_key(member: &Member) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fullmag.workspace-results.member.v1\0");
    update_length_prefixed(&mut hasher, &member.label);
    update_length_prefixed(&mut hasher, &member.identity);
    update_length_prefixed(&mut hasher, &member.run_id);
    format!("{:x}", hasher.finalize())
}

fn collection_revision(accepted_run_id: &str, members: &[CapturedMember]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"fullmag.workspace-results.collection.v1\0");
    update_length_prefixed(&mut hasher, accepted_run_id);
    hasher.update((members.len() as u64).to_le_bytes());
    for member in members {
        update_length_prefixed(&mut hasher, &member.member.label);
        update_length_prefixed(&mut hasher, &member.member.identity);
        update_length_prefixed(&mut hasher, &member.member.run_id);
        update_length_prefixed(&mut hasher, &member.leaf_revision);
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn update_length_prefixed(hasher: &mut Sha256, value: &str) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn leaf_revision_token(member: &CapturedMember) -> String {
    format!("leaf:{}:{}", member.key, member.leaf_revision)
}

fn parse_collection_cursor(
    cursor: Option<&str>,
    expected_revision: &str,
) -> Result<usize, ResultsError> {
    let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) else {
        return Ok(0);
    };
    let (revision, offset) = cursor
        .rsplit_once(':')
        .ok_or_else(|| ResultsError::Cursor("expected a revision-pinned cursor".into()))?;
    let hash = revision
        .strip_prefix("sha256:")
        .ok_or_else(|| ResultsError::Cursor("invalid cursor revision".into()))?;
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || offset.is_empty()
        || offset.len() > 12
        || !offset.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ResultsError::Cursor(
            "invalid revision-pinned cursor".into(),
        ));
    }
    if revision != expected_revision {
        return Err(ResultsError::StaleRevision);
    }
    offset
        .parse()
        .map_err(|_| ResultsError::Cursor("offset is out of range".into()))
}

#[cfg(test)]
mod tests {
    use super::{member_key, CollectionSnapshot, Member};
    use fullmag_workspace_inspect::{
        read_results_array, read_results_catalog, read_results_entry, read_results_sample,
        ResultsError, WorkspaceResultEntry, WorkspaceResultsSource,
    };
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn write_leaf(root: &Path, run_id: &str, value: f64, note: &str) {
        fs::create_dir_all(root.join("fields/m")).expect("array directory");
        fs::create_dir_all(root.join("nested")).expect("nested directory");
        fs::write(root.join(".zgroup"), br#"{"zarr_format":2}"#).expect("root group");
        fs::write(root.join(".zattrs"), br#"{}"#).expect("root attributes");
        fs::write(
            root.join("fullmag-run.json"),
            serde_json::to_vec(&json!({ "run_id": run_id })).expect("run marker JSON"),
        )
        .expect("run marker");
        fs::write(
            root.join("fields/m/.zarray"),
            serde_json::to_vec(&json!({
                "zarr_format": 2,
                "shape": [1, 1],
                "chunks": [1, 1],
                "dtype": "<f8",
                "compressor": null,
                "filters": null,
                "order": "C",
                "dimension_separator": "."
            }))
            .expect("array metadata JSON"),
        )
        .expect("array metadata");
        fs::write(
            root.join("fields/m/.zattrs"),
            serde_json::to_vec(&json!({
                "quantity": "m",
                "unit": "A/m",
                "storage_layout": "aos_node_major",
                "field_layout": "aos_node_major",
                "dimension_order": ["sample", "value"]
            }))
            .expect("array attributes JSON"),
        )
        .expect("array attributes");
        fs::write(root.join("fields/m/0.0"), value.to_le_bytes()).expect("array chunk");
        fs::write(root.join("notes.json"), note.as_bytes()).expect("note file");
        fs::write(root.join("nested/readme.txt"), b"result details\n").expect("nested text");
    }

    fn member(root: PathBuf, run_id: &str, label: &str, identity: &str) -> Member {
        Member {
            root,
            run_id: run_id.into(),
            label: label.into(),
            identity: identity.into(),
        }
    }

    fn find_entry<'a>(entries: &'a [WorkspaceResultEntry], path: &str) -> &'a WorkspaceResultEntry {
        entries
            .iter()
            .find(|entry| entry.path == path)
            .unwrap_or_else(|| panic!("missing catalog entry at {path}"))
    }

    #[test]
    fn identical_array_paths_are_scoped_to_their_leaf_and_read_the_correct_payloads() {
        let temp = tempfile::tempdir().expect("temp directory");
        let left_root = temp.path().join("attempt-a");
        let right_root = temp.path().join("attempt-b");
        write_leaf(&left_root, "run-a", 1.25, r#"{"leaf":"left"}"#);
        write_leaf(&right_root, "run-b", -7.5, r#"{"leaf":"right"}"#);
        let snapshot = CollectionSnapshot::capture(
            "accepted-run",
            vec![
                member(right_root.clone(), "run-b", "attempt-b", "output-b"),
                member(left_root.clone(), "run-a", "attempt-a", "output-a"),
            ],
        )
        .expect("capture collection");
        let catalog = snapshot.catalog(None, 1000).expect("collection catalog");

        let left_entry = find_entry(&catalog.entries, "attempt-a/fields/m");
        let right_entry = find_entry(&catalog.entries, "attempt-b/fields/m");
        let left_array_id = left_entry.array_id.clone().expect("left array id");
        let right_array_id = right_entry.array_id.clone().expect("right array id");
        assert_ne!(left_array_id, right_array_id);
        let left_target = snapshot
            .resolve(&left_array_id, &snapshot.revision)
            .expect("left target");
        let right_target = snapshot
            .resolve(&right_array_id, &snapshot.revision)
            .expect("right target");

        for (target, expected_value, expected_label) in [
            (&left_target, 1.25_f64, "attempt-a"),
            (&right_target, -7.5_f64, "attempt-b"),
        ] {
            let raw = read_results_array(
                &target.root,
                &target.inner_id,
                &target.revision,
                Some(&target.run_id),
            )
            .expect("leaf array metadata");
            let normalized = snapshot.normalize_array(target, raw);
            assert_eq!(normalized.revision, snapshot.array_revision(target));
            assert_eq!(normalized.path, format!("{expected_label}/fields/m"));
            assert!(normalized.id.starts_with(&format!("{}~", target.key)));
            let sample = read_results_sample(
                &target.root,
                &target.inner_id,
                0,
                &target.revision,
                Some(&target.run_id),
            )
            .expect("leaf sample");
            assert_eq!(
                f64::from_le_bytes(sample.bytes[..8].try_into().expect("f64 bytes")),
                expected_value
            );
        }

        let left_note = find_entry(&catalog.entries, "attempt-a/notes.json");
        let left_note_target = snapshot
            .resolve(&left_note.id, &snapshot.revision)
            .expect("left note target");
        let raw_note = read_results_entry(
            &left_note_target.root,
            &left_note_target.inner_id,
            &left_note_target.revision,
            Some(&left_note_target.run_id),
        )
        .expect("left note payload");
        let normalized_note = snapshot.normalize_entry(&left_note_target, raw_note);
        assert_eq!(normalized_note.entry.path, "attempt-a/notes.json");
        assert!(normalized_note
            .entry
            .id
            .starts_with(&format!("{}~", left_note_target.key)));
        assert_eq!(
            std::str::from_utf8(&normalized_note.bytes).expect("note text"),
            r#"{"leaf":"left"}"#
        );
    }

    #[test]
    fn adding_a_member_preserves_leaf_array_identity_and_revision_but_stales_global_cursor() {
        let temp = tempfile::tempdir().expect("temp directory");
        let first_root = temp.path().join("first");
        let second_root = temp.path().join("second");
        write_leaf(&first_root, "run-first", 2.0, r#"{"leaf":"first"}"#);
        write_leaf(&second_root, "run-second", 3.0, r#"{"leaf":"second"}"#);
        let first = member(
            first_root.clone(),
            "run-first",
            "outputs/first",
            "immutable-output-first",
        );
        let first_snapshot = CollectionSnapshot::capture("accepted-run", vec![first.clone()])
            .expect("first capture");
        let first_catalog = first_snapshot.catalog(None, 1).expect("first page");
        let old_cursor = first_catalog.next_cursor.clone().expect("cursor");
        let old_array = find_entry(
            &first_snapshot
                .catalog(None, 1000)
                .expect("first full page")
                .entries,
            "outputs/first/fields/m",
        )
        .array_id
        .clone()
        .expect("first array id");
        let first_target = first_snapshot
            .resolve(&old_array, &first_snapshot.revision)
            .expect("first array target");
        let first_array = first_snapshot.normalize_array(
            &first_target,
            read_results_array(
                &first_target.root,
                &first_target.inner_id,
                &first_target.revision,
                Some(&first_target.run_id),
            )
            .expect("first array"),
        );
        let first_leaf_token = first_array.revision.clone();

        let second_snapshot = CollectionSnapshot::capture(
            "accepted-run",
            vec![
                first.clone(),
                member(
                    second_root,
                    "run-second",
                    "outputs/second",
                    "immutable-output-second",
                ),
            ],
        )
        .expect("second capture");
        assert_ne!(first_snapshot.revision, second_snapshot.revision);
        assert!(matches!(
            second_snapshot.catalog(Some(&old_cursor), 1),
            Err(ResultsError::StaleRevision)
        ));
        assert!(matches!(
            second_snapshot.resolve(&old_array, &first_snapshot.revision),
            Err(ResultsError::StaleRevision)
        ));

        let second_catalog = second_snapshot
            .catalog(None, 1000)
            .expect("second full page");
        let first_array_id_after_addition =
            find_entry(&second_catalog.entries, "outputs/first/fields/m")
                .array_id
                .clone()
                .expect("first array id after addition");
        assert_eq!(old_array, first_array_id_after_addition);
        let stable_target = second_snapshot
            .resolve(&first_array_id_after_addition, &first_leaf_token)
            .expect("leaf token remains current");
        let stable_array = second_snapshot.normalize_array(
            &stable_target,
            read_results_array(
                &stable_target.root,
                &stable_target.inner_id,
                &stable_target.revision,
                Some(&stable_target.run_id),
            )
            .expect("first array after addition"),
        );
        assert_eq!(stable_array.id, first_array.id);
        assert_eq!(stable_array.revision, first_array.revision);

        let second_array_id = find_entry(&second_catalog.entries, "outputs/second/fields/m")
            .array_id
            .clone()
            .expect("second array id");
        let second_target = second_snapshot
            .resolve(&second_array_id, &second_snapshot.revision)
            .expect("second array target");
        let second_leaf_token = second_snapshot.array_revision(&second_target);
        assert!(matches!(
            second_snapshot.resolve(&first_array_id_after_addition, &second_leaf_token),
            Err(ResultsError::StaleRevision)
        ));
    }

    #[test]
    fn pagination_returns_each_entry_once_with_coherent_scoped_parent_ids() {
        let temp = tempfile::tempdir().expect("temp directory");
        let first_root = temp.path().join("one");
        let second_root = temp.path().join("two");
        write_leaf(&first_root, "run-one", 1.0, r#"{"leaf":"one"}"#);
        write_leaf(&second_root, "run-two", 2.0, r#"{"leaf":"two"}"#);
        let snapshot = CollectionSnapshot::capture(
            "accepted-run",
            vec![
                member(second_root, "run-two", "b", "output-b"),
                member(first_root, "run-one", "a", "output-a"),
            ],
        )
        .expect("capture collection");

        let mut cursor = None;
        let mut all_entries = Vec::new();
        loop {
            let page = snapshot
                .catalog(cursor.as_deref(), 2)
                .expect("collection page");
            assert_eq!(page.revision, snapshot.revision);
            assert_eq!(page.run_id.as_deref(), Some("accepted-run"));
            all_entries.extend(page.entries);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }

        assert_eq!(all_entries.len(), snapshot.total_count);
        let ids = all_entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(ids.len(), snapshot.total_count);
        let by_id = all_entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect::<BTreeMap<_, _>>();
        for entry in &all_entries {
            if let Some(parent_id) = entry.parent_id.as_deref() {
                let parent = by_id
                    .get(parent_id)
                    .unwrap_or_else(|| panic!("missing parent {parent_id} for {}", entry.id));
                assert!(
                    entry.path.starts_with(&format!("{}/", parent.path)),
                    "parent {} is not an ancestor of {}",
                    parent.path,
                    entry.path
                );
            }
        }
    }

    #[test]
    fn drift_in_either_leaf_invalidates_the_captured_snapshot() {
        for changed_index in 0..2 {
            let temp = tempfile::tempdir().expect("temp directory");
            let roots = [temp.path().join("one"), temp.path().join("two")];
            write_leaf(&roots[0], "run-one", 1.0, r#"{"leaf":"one"}"#);
            write_leaf(&roots[1], "run-two", 2.0, r#"{"leaf":"two"}"#);
            let snapshot = CollectionSnapshot::capture(
                "accepted-run",
                vec![
                    member(roots[0].clone(), "run-one", "a", "output-a"),
                    member(roots[1].clone(), "run-two", "b", "output-b"),
                ],
            )
            .expect("capture collection");
            fs::write(
                roots[changed_index].join("notes.json"),
                b"changed result metadata with a different length",
            )
            .expect("drift leaf");
            assert!(matches!(
                snapshot.ensure_unchanged(),
                Err(ResultsError::StaleRevision)
            ));
        }
    }

    #[test]
    fn selected_capture_skips_an_oversized_sibling_and_rejects_a_wrong_key() {
        let temp = tempfile::tempdir().expect("temp directory");
        let selected_root = temp.path().join("selected");
        let sibling_root = temp.path().join("sibling");
        write_leaf(
            &selected_root,
            "run-selected",
            6.25,
            r#"{"leaf":"selected"}"#,
        );
        write_leaf(&sibling_root, "run-sibling", -2.0, r#"{"leaf":"sibling"}"#);
        fs::write(
            sibling_root.join("metadata.json"),
            vec![b' '; 8 * 1024 * 1024 + 1],
        )
        .expect("oversized critical sibling metadata");
        let selected = member(
            selected_root.clone(),
            "run-selected",
            "outputs/selected",
            "immutable-output-selected",
        );
        let sibling = member(
            sibling_root,
            "run-sibling",
            "outputs/sibling",
            "immutable-output-sibling",
        );

        assert!(matches!(
            CollectionSnapshot::capture("accepted-run", vec![selected.clone(), sibling.clone()],),
            Err(ResultsError::TooLarge(_))
        ));

        let leaf_catalog = read_results_catalog(
            &selected_root,
            None,
            1000,
            Some("run-selected"),
            WorkspaceResultsSource::Current,
        )
        .expect("selected leaf catalog");
        let inner_array_id = find_entry(&leaf_catalog.entries, "fields/m")
            .array_id
            .as_deref()
            .expect("selected array id");
        let key = member_key(&selected);
        let scoped_array_id = format!("{key}~{inner_array_id}");
        let leaf_revision = format!("leaf:{key}:{}", leaf_catalog.revision);

        let selected_snapshot = CollectionSnapshot::capture_selected(
            "accepted-run",
            vec![selected.clone(), sibling.clone()],
            &scoped_array_id,
        )
        .expect("capture only selected leaf");
        let target = selected_snapshot
            .resolve(&scoped_array_id, &leaf_revision)
            .expect("resolve selected leaf token");
        let sample = read_results_sample(
            &target.root,
            &target.inner_id,
            0,
            &target.revision,
            Some(&target.run_id),
        )
        .expect("selected sample");
        assert_eq!(
            f64::from_le_bytes(sample.bytes[..8].try_into().expect("f64 bytes")),
            6.25
        );

        let wrong_key = format!(
            "{}{}~{}",
            if key.starts_with('0') { '1' } else { '0' },
            &key[1..],
            inner_array_id,
        );
        assert!(matches!(
            CollectionSnapshot::capture_selected("accepted-run", vec![selected], &wrong_key,),
            Err(ResultsError::NotFound(_))
        ));
    }

    #[test]
    fn capture_uses_the_public_leaf_catalog_reader_for_real_zarr_metadata() {
        let temp = tempfile::tempdir().expect("temp directory");
        let root = temp.path().join("only");
        write_leaf(&root, "run-only", 4.0, r#"{"leaf":"only"}"#);
        let public_catalog = read_results_catalog(
            &root,
            None,
            1,
            Some("run-only"),
            WorkspaceResultsSource::Current,
        )
        .expect("public leaf reader");
        let snapshot = CollectionSnapshot::capture(
            "accepted-run",
            vec![member(root, "run-only", "only", "output-only")],
        )
        .expect("capture collection");
        assert_eq!(public_catalog.total_count + 1, snapshot.total_count);
    }
}
