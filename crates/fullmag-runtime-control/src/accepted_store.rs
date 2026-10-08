//! Canonical accepted-run storage shared by API and native launchers.
use std::path::{Path, PathBuf};

/// Opaque local binding for discovery; never a portable scientific identity.
pub fn store_binding(root: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let path = writable_product_state_path(root)?;
    let mut hash = Sha256::new();
    hash.update(b"fullmag.accepted-store-binding.v1\0");
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for code in path.as_os_str().encode_wide() {
            hash.update(code.to_le_bytes());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hash.update(path.as_os_str().as_bytes());
    }
    #[cfg(not(any(windows, unix)))]
    {
        return None;
    }
    Some(format!("{:x}", hash.finalize()))
}

/// Developer launches require the managed resolver. An installed Windows
/// executable owns a separate user-data store, without a source checkout.
pub fn configured_submit_store_root(
    repo_root: &Path,
    runtime_state_root: &Path,
) -> Option<PathBuf> {
    let packaged_root = std::env::current_exe()
        .ok()
        .and_then(|executable| crate::python_runtime::packaged_windows_root(&executable));
    let base_root = submit_store_root_for_origin(
        repo_root,
        runtime_state_root,
        packaged_root.as_deref(),
        std::env::var_os("FULLMAG_MANAGED_REPO_ROOT"),
        std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT"),
        std::env::var_os("FULLMAG_RUNS_ROOT"),
        std::env::var_os("FULLMAG_WORKTREE_ID"),
    )?;
    scoped_submit_store_root(&base_root, std::env::var_os("FULLMAG_ACCEPTED_STORE_SCOPE"))
}

/// The explicit resolver origin is only a binding for the managed route.
/// Asset/package roots remain independent, and invalid configuration fails closed.
fn submit_store_root_for_origin(
    repo_root: &Path,
    runtime_state_root: &Path,
    packaged_root: Option<&Path>,
    managed_origin: Option<std::ffi::OsString>,
    storage_root: Option<std::ffi::OsString>,
    runs_root: Option<std::ffi::OsString>,
    worktree_id: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let Some(origin) = managed_origin else {
        return submit_store_root_for_layout(
            repo_root,
            runtime_state_root,
            packaged_root,
            storage_root,
            runs_root,
            worktree_id,
        );
    };
    // Presence alone selects managed storage: never fall back to installed state.
    let origin = PathBuf::from(origin);
    let canonical_origin = writable_product_state_path(&origin)?;
    if !canonical_origin.is_dir() {
        return None;
    }
    let storage = PathBuf::from(storage_root.as_ref()?);
    let runs = PathBuf::from(runs_root.as_ref()?);
    let id = worktree_id.as_ref()?.to_str()?;
    if id.is_empty()
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || !storage.is_absolute()
        || !runs.is_absolute()
        || runs != storage.join("runs").join(id)
    {
        return None;
    }
    let canonical_storage = writable_product_state_path(&storage)?;
    let canonical_runs = writable_product_state_path(&runs)?;
    if !canonical_storage.is_dir()
        || !canonical_runs.is_dir()
        || canonical_runs != canonical_storage.join("runs").join(id)
        || canonical_storage.starts_with(&canonical_origin)
        || canonical_origin.starts_with(&canonical_storage)
    {
        return None;
    }
    // Both the project marker and worktree registration must be local regular
    // records; following a link here could bind another checkout's store.
    let marker = regular_json_record(&canonical_storage.join(".fullmag-storage.json"))?;
    if marker.get("schema")?.as_str()? != "fullmag_storage_v1" {
        return None;
    }
    let project = writable_product_state_path(Path::new(marker.get("project_root")?.as_str()?))?;
    if !project.is_dir() || canonical_origin == project || !canonical_origin.starts_with(&project) {
        return None;
    }
    let registration =
        regular_json_record(&canonical_storage.join("index").join(format!("{id}.json")))?;
    if registration.get("schema")?.as_str()? != "fullmag_storage_v1"
        || registration.get("worktree_id")?.as_str()? != id
    {
        return None;
    }
    let registered_origin =
        writable_product_state_path(Path::new(registration.get("repo_root")?.as_str()?))?;
    if registered_origin != canonical_origin {
        return None;
    }
    submit_store_root_for_layout(
        &canonical_origin,
        runtime_state_root,
        packaged_root,
        storage_root,
        runs_root,
        worktree_id,
    )
}

fn regular_json_record(path: &Path) -> Option<serde_json::Value> {
    writable_product_state_path(path.parent()?)?;
    let metadata = std::fs::symlink_metadata(path).ok()?;
    #[cfg(windows)]
    let reparse = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let reparse = false;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || reparse
        || metadata.len() > 1024 * 1024
    {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Resolve an optional isolated accepted-store namespace below an already
/// validated managed or installed-user-state store root. This never creates
/// directories; the store owner remains responsible for initialization.
pub fn scoped_submit_store_root(
    base_root: &Path,
    scope: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    let base_root = writable_product_state_path(base_root)?;
    if base_root.file_name()? != "session-store" {
        return None;
    }

    let Some(scope) = scope else {
        return Some(base_root);
    };
    let scope = scope.into_string().ok()?;
    let parsed_scope = uuid::Uuid::parse_str(&scope).ok()?;
    if parsed_scope.is_nil() || parsed_scope.to_string() != scope {
        return None;
    }

    let base_parent = base_root.parent()?;
    let scoped_root = writable_product_state_path(
        &base_parent
            .join("workspaces")
            .join(scope)
            .join("session-store"),
    )?;
    if scoped_root.file_name()? != "session-store" || !scoped_root.starts_with(base_parent) {
        return None;
    }
    Some(scoped_root)
}

pub fn submit_store_root_for_layout(
    repo_root: &Path,
    runtime_state_root: &Path,
    packaged_root: Option<&Path>,
    storage_root: Option<std::ffi::OsString>,
    runs_root: Option<std::ffi::OsString>,
    worktree_id: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if storage_root.is_none() && runs_root.is_none() && worktree_id.is_none() {
        let install_root = std::fs::canonicalize(packaged_root?).ok()?;
        if install_root != std::fs::canonicalize(repo_root).ok()? {
            return None;
        }
        let state_root = writable_product_state_path(runtime_state_root)?;
        if state_root.starts_with(&install_root) || install_root.starts_with(&state_root) {
            return None;
        }
        return writable_product_state_path(&state_root.join("runs").join("session-store"));
    }
    // Any managed configuration selects that route exclusively. A broken
    // resolver environment must never silently change the data destination.
    let storage_root = PathBuf::from(storage_root?);
    let runs_root = PathBuf::from(runs_root?);
    let worktree_id = worktree_id?.into_string().ok()?;
    if !storage_root.is_absolute()
        || !runs_root.is_absolute()
        || worktree_id.is_empty()
        || !worktree_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        || runs_root != storage_root.join("runs").join(&worktree_id)
        || storage_root.starts_with(repo_root)
        || repo_root.starts_with(&storage_root)
    {
        return None;
    }
    let canonical_storage = std::fs::canonicalize(&storage_root).ok()?;
    let canonical_runs = std::fs::canonicalize(&runs_root).ok()?;
    let canonical_repo = std::fs::canonicalize(repo_root).ok()?;
    if canonical_runs != canonical_storage.join("runs").join(&worktree_id)
        || canonical_storage.starts_with(&canonical_repo)
        || canonical_repo.starts_with(&canonical_storage)
    {
        return None;
    }
    let marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(canonical_storage.join(".fullmag-storage.json")).ok()?,
    )
    .ok()?;
    if marker.get("schema").and_then(serde_json::Value::as_str) != Some("fullmag_storage_v1") {
        return None;
    }
    let declared_project = PathBuf::from(marker.get("project_root")?.as_str()?);
    let canonical_project = std::fs::canonicalize(declared_project).ok()?;
    if canonical_repo == canonical_project || !canonical_repo.starts_with(canonical_project) {
        return None;
    }
    Some(canonical_runs.join("session-store"))
}

/// Resolve a possibly new user-data directory without creating it. Reject
/// links along existing ancestors before SessionStore enforces its FS/lease
/// boundary. Missing directories are initialized only by the store owner.
pub fn writable_product_state_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return None;
    }
    let mut nearest_existing = None;
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse {
                    return None;
                }
                if nearest_existing.is_none() {
                    nearest_existing = Some(ancestor);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    let existing = nearest_existing?;
    Some(
        std::fs::canonicalize(existing)
            .ok()?
            .join(path.strip_prefix(existing).ok()?),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    struct Layout {
        _temp: tempfile::TempDir,
        origin: PathBuf,
        storage: PathBuf,
        runs: PathBuf,
        packaged: PathBuf,
        state: PathBuf,
        project: PathBuf,
    }

    impl Layout {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let project = temp.path().join("project");
            let origin = project.join("worktrees").join("source");
            let storage = project.join("storage");
            let runs = storage.join("runs").join("source-123");
            let packaged = storage
                .join("runtimes")
                .join("source-123")
                .join("native-launch");
            let state = temp.path().join("installed-state");
            for directory in [&origin, &runs, &packaged, &state, &storage.join("index")] {
                std::fs::create_dir_all(directory).unwrap();
            }
            let layout = Self {
                _temp: temp,
                origin,
                storage,
                runs,
                packaged,
                state,
                project,
            };
            layout.write_marker(serde_json::json!({
                "schema": "fullmag_storage_v1", "project_root": layout.project,
            }));
            layout.write_registration(serde_json::json!({
                "schema": "fullmag_storage_v1", "worktree_id": "source-123", "repo_root": layout.origin,
            }));
            layout
        }

        fn write_marker(&self, value: serde_json::Value) {
            std::fs::write(
                self.storage.join(".fullmag-storage.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }

        fn registration_path(&self) -> PathBuf {
            self.storage.join("index").join("source-123.json")
        }

        fn write_registration(&self, value: serde_json::Value) {
            std::fs::write(
                self.registration_path(),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }

        fn managed(&self) -> Option<PathBuf> {
            submit_store_root_for_origin(
                &self.packaged,
                &self.state,
                Some(&self.packaged),
                Some(self.origin.clone().into_os_string()),
                Some(self.storage.clone().into_os_string()),
                Some(self.runs.clone().into_os_string()),
                Some(OsString::from("source-123")),
            )
        }
    }

    #[test]
    fn packaged_asset_root_uses_registered_managed_origin() {
        let layout = Layout::new();
        assert_eq!(
            layout.managed(),
            Some(
                std::fs::canonicalize(&layout.runs)
                    .unwrap()
                    .join("session-store")
            )
        );
        assert!(!layout.runs.join("session-store").exists());
    }

    #[test]
    fn origin_absence_preserves_installed_and_legacy_managed_routes() {
        let layout = Layout::new();
        assert_eq!(
            submit_store_root_for_origin(
                &layout.packaged,
                &layout.state,
                Some(&layout.packaged),
                None,
                None,
                None,
                None
            ),
            submit_store_root_for_layout(
                &layout.packaged,
                &layout.state,
                Some(&layout.packaged),
                None,
                None,
                None
            ),
        );
        assert!(submit_store_root_for_origin(
            &layout.packaged,
            &layout.state,
            Some(&layout.packaged),
            None,
            None,
            None,
            None
        )
        .is_some());
        assert_eq!(
            submit_store_root_for_origin(
                &layout.origin,
                &layout.state,
                Some(&layout.packaged),
                None,
                Some(layout.storage.clone().into_os_string()),
                Some(layout.runs.clone().into_os_string()),
                Some(OsString::from("source-123")),
            ),
            Some(
                std::fs::canonicalize(&layout.runs)
                    .unwrap()
                    .join("session-store")
            ),
        );
    }

    #[test]
    fn explicit_origin_never_falls_back_when_managed_environment_is_partial() {
        let layout = Layout::new();
        for mask in 0..7 {
            let storage = (mask & 1 != 0).then(|| layout.storage.clone().into_os_string());
            let runs = (mask & 2 != 0).then(|| layout.runs.clone().into_os_string());
            let id = (mask & 4 != 0).then(|| OsString::from("source-123"));
            assert!(
                submit_store_root_for_origin(
                    &layout.packaged,
                    &layout.state,
                    Some(&layout.packaged),
                    Some(layout.origin.clone().into_os_string()),
                    storage,
                    runs,
                    id,
                )
                .is_none(),
                "partial managed mask {mask}"
            );
        }
    }

    #[test]
    fn invalid_origins_and_alternate_runs_are_rejected() {
        let layout = Layout::new();
        for origin in [
            PathBuf::new(),
            PathBuf::from("relative"),
            layout.project.join("missing"),
            layout.packaged.clone(),
            layout.project.clone(),
        ] {
            assert!(submit_store_root_for_origin(
                &layout.packaged,
                &layout.state,
                Some(&layout.packaged),
                Some(origin.into_os_string()),
                Some(layout.storage.clone().into_os_string()),
                Some(layout.runs.clone().into_os_string()),
                Some(OsString::from("source-123")),
            )
            .is_none());
        }
        let alternate = layout.storage.join("runs").join("another-123");
        std::fs::create_dir_all(&alternate).unwrap();
        assert!(submit_store_root_for_origin(
            &layout.packaged,
            &layout.state,
            Some(&layout.packaged),
            Some(layout.origin.clone().into_os_string()),
            Some(layout.storage.clone().into_os_string()),
            Some(alternate.into_os_string()),
            Some(OsString::from("source-123")),
        )
        .is_none());
    }

    #[test]
    fn registration_must_bind_schema_worktree_and_canonical_origin() {
        let layout = Layout::new();
        let foreign = layout.project.join("worktrees").join("foreign");
        std::fs::create_dir_all(&foreign).unwrap();
        for record in [
            serde_json::json!({"schema": "wrong", "worktree_id": "source-123", "repo_root": layout.origin}),
            serde_json::json!({"schema": "fullmag_storage_v1", "worktree_id": "foreign-123", "repo_root": layout.origin}),
            serde_json::json!({"schema": "fullmag_storage_v1", "worktree_id": "source-123", "repo_root": foreign}),
            serde_json::json!({"schema": "fullmag_storage_v1", "worktree_id": "source-123", "repo_root": "relative"}),
        ] {
            layout.write_registration(record);
            assert!(layout.managed().is_none());
        }
        std::fs::remove_file(layout.registration_path()).unwrap();
        assert!(layout.managed().is_none());
    }

    #[test]
    fn marker_must_bind_the_origin_project() {
        let layout = Layout::new();
        let foreign = layout._temp.path().join("foreign-project");
        std::fs::create_dir_all(&foreign).unwrap();
        for record in [
            serde_json::json!({"schema": "wrong", "project_root": layout.project}),
            serde_json::json!({"schema": "fullmag_storage_v1", "project_root": foreign}),
        ] {
            layout.write_marker(record);
            assert!(layout.managed().is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn linked_registration_and_parent_are_rejected() {
        use std::os::unix::fs::symlink;
        let layout = Layout::new();
        let real_record = layout._temp.path().join("registration.json");
        std::fs::rename(layout.registration_path(), &real_record).unwrap();
        symlink(&real_record, layout.registration_path()).unwrap();
        assert!(layout.managed().is_none());
        std::fs::remove_file(layout.registration_path()).unwrap();
        let real_index = layout._temp.path().join("index");
        std::fs::rename(layout.storage.join("index"), &real_index).unwrap();
        std::fs::copy(real_record, real_index.join("source-123.json")).unwrap();
        symlink(&real_index, layout.storage.join("index")).unwrap();
        assert!(layout.managed().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_index_is_rejected() {
        let layout = Layout::new();
        let real_index = layout._temp.path().join("index");
        std::fs::rename(layout.storage.join("index"), &real_index).unwrap();
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(layout.storage.join("index"))
            .arg(&real_index)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "could not create owned fixture junction"
        );
        assert!(layout.managed().is_none());
    }
}
