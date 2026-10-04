//! Scoped publication of private development API discovery records.

use std::path::Path;

use anyhow::{bail, Result};

/// Publish a unique API discovery record without replacing prior ownership.
/// The caller cannot select paths outside the development runtime namespace.
pub fn publish_managed_owner_record(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let components: Vec<_> = relative.split('/').collect();
    if components.len() != 3 || components[0] != "runtimes" || bytes.len() > 8192 {
        bail!("invalid development owner record publication");
    }
    crate::repository_path::validate_store_id(components[1])?;
    let identity = components[2]
        .strip_prefix("development-api-owner-")
        .and_then(|name| name.strip_suffix(".json"))
        .ok_or_else(|| anyhow::anyhow!("invalid development owner record identity"))?;
    let id = uuid::Uuid::parse_str(identity)?;
    if id.is_nil() || id.to_string() != identity {
        bail!("invalid development owner record identity");
    }
    // Serialize the existence check and publication with other managed writers.
    let writer = crate::writer::Writer::new(root.to_path_buf());
    let _transaction = writer.acquire()?;
    let destination = crate::repository_path::create_parent(root, relative)?;
    if destination.try_exists()? {
        bail!("development owner record already exists");
    }
    crate::durability::atomic_write_owner(&destination, bytes)
}
