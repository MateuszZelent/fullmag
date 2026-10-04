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
    let base_root = submit_store_root_for_layout(
        repo_root,
        runtime_state_root,
        packaged_root.as_deref(),
        std::env::var_os("FULLMAG_PROJECT_STORAGE_ROOT"),
        std::env::var_os("FULLMAG_RUNS_ROOT"),
        std::env::var_os("FULLMAG_WORKTREE_ID"),
    )?;
    scoped_submit_store_root(&base_root, std::env::var_os("FULLMAG_ACCEPTED_STORE_SCOPE"))
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
