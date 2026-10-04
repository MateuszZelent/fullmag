//! Cold accepted-store reservation for an explicitly owned development handoff.
//! Absence of a configured service is not, by itself, evidence of global idle.

use std::{fs, path::Path};

use anyhow::{bail, Context, Result};
use fullmag_session::{
    repository_path::{checked_path, validate_store_id},
    runtime_service::RuntimeServiceLaunchGuard,
    runtime_service_startup::RuntimeServiceStartupGuard,
    store::DevelopmentAdmissionFence,
    SessionStore,
};

/// Startup locks remain held through the protected handoff boundary. Dropping
/// this proof releases only kernel locks: the durable fence is never removed
/// implicitly, and subsequent service ownership refuses that closed fence.
pub struct ColdIdleProof {
    store: SessionStore,
    pub admission_fence: DevelopmentAdmissionFence,
    _startup: RuntimeServiceStartupGuard,
    _launch: RuntimeServiceLaunchGuard,
}

impl ColdIdleProof {
    pub fn verify_for_api(&self, port: u16, instance: &str) -> Result<String> {
        self.verify_current()?;
        let observed = crate::runtime_service_client::verify_api_store(port, self.store.root())?;
        if observed != instance {
            bail!("cold idle proof is bound to another API instance");
        }
        crate::accepted_store::store_binding(self.store.root())
            .context("cold idle proof store binding is invalid")
    }

    pub fn verify_current(&self) -> Result<()> {
        require_no_service_metadata(&self.store)?;
        if self.store.read_development_idle_fence()?.as_ref() != Some(&self.admission_fence) {
            bail!("cold idle admission fence changed; handoff refused");
        }
        Ok(())
    }

    /// Explicit abort or completed handoff only. The caller owns the lifecycle
    /// decision; neither a timeout nor Drop is authorization for this release.
    pub fn release_fence(self) -> Result<()> {
        self.verify_current()?;
        self.store
            .release_development_idle_fence(&self.admission_fence)
    }
}

fn require_no_service_metadata(store: &SessionStore) -> Result<()> {
    for relative in [
        "runtime-services/APPLICATION.json",
        "runtime-services/OWNER.lock",
        "runtime-services/OWNER.json",
        "runtime-services/LAUNCH.json",
    ] {
        let path = checked_path(store.root(), relative)?;
        match fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("cold service metadata outcome is unknown"),
            Ok(_) => bail!("cold service metadata is present; reconciliation required"),
        }
    }
    Ok(())
}

/// Reserve only an existing store. Initialization and recovery are separate
/// managed operations; a missing or malformed store is never inferred empty.
pub fn acquire_cold_idle_fence(
    store_root: &Path,
    owner_token: &str,
    nonce: &str,
) -> Result<ColdIdleProof> {
    if !store_root.is_absolute()
        || owner_token.len() != 32
        || !owner_token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("invalid cold idle owner/store identity");
    }
    validate_store_id(owner_token)?;
    let parsed = uuid::Uuid::parse_str(nonce).context("invalid cold idle nonce")?;
    if parsed.is_nil() || parsed.to_string() != nonce {
        bail!("cold idle nonce must be a canonical nonzero UUID");
    }
    let store = SessionStore::open_existing(store_root.to_path_buf())?;
    let launch = RuntimeServiceLaunchGuard::try_acquire(store.root())?
        .context("runtime service startup serialization is already held")?;
    let startup = RuntimeServiceStartupGuard::try_acquire(store.root())?
        .context("runtime service direct startup is already held")?;
    require_no_service_metadata(&store)?;
    let admission_fence = store.acquire_development_idle_fence(owner_token, nonce)?;
    let proof = ColdIdleProof {
        store,
        admission_fence,
        _startup: startup,
        _launch: launch,
    };
    proof.verify_current()?;
    Ok(proof)
}

/// Require the exact compiled API, UUID and accepted-store binding before any
/// reservation. Recheck after fencing; an uncertain result preserves the fence.
pub fn cold_idle_for_api(
    api_port: u16,
    api_instance_id: &str,
    store_root: &Path,
    owner_token: &str,
    nonce: &str,
) -> Result<ColdIdleProof> {
    let pin = uuid::Uuid::parse_str(api_instance_id).context("invalid cold idle API pin")?;
    if api_port == 0 || pin.is_nil() || pin.to_string() != api_instance_id {
        bail!("invalid cold idle API identity");
    }
    let verify_api = || -> Result<()> {
        let observed = crate::runtime_service_client::verify_api_store(api_port, store_root)?;
        if observed != api_instance_id {
            bail!("API instance changed during cold idle handoff");
        }
        Ok(())
    };
    verify_api()?;
    let proof = acquire_cold_idle_fence(store_root, owner_token, nonce)?;
    verify_api()?;
    proof.verify_current()?;
    Ok(proof)
}
