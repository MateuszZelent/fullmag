//! Read-only observation of the optional native application runtime service.
//!
//! This module deliberately does not own the service lifecycle.  It never
//! initializes a store, writes a configuration or descriptor, starts or stops
//! a process, retries a launch, or takes over an existing owner.  A status is
//! useful to an API/UI caller only when the observation is explicit about what
//! was and was not proven.

use anyhow::{bail, Context, Result};
use fullmag_session::{
    repository_path::checked_path,
    runtime_service::{
        validate_descriptor, RuntimeServiceConfig, RuntimeServiceOwnerDescriptor,
        RuntimeServiceState, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

/// Stable schema identifier for the future `/v2/platform/runtime-service`
/// resource.
pub const APPLICATION_SERVICE_STATUS_SCHEMA: &str = "application_service_status.v1";

/// The owner descriptor is a bounded operational observation, not an
/// unbounded log or arbitrary JSON document.
pub const OWNER_DESCRIPTOR_MAX_BYTES: usize = 256 * 1024;

/// Keep diagnostic text suitable for a thin control-plane response.  The
/// typed reason code carries the machine-readable meaning.
const REASON_MESSAGE_MAX_BYTES: usize = 2048;
const LIVE_PROBE_TIMEOUT_SECONDS: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationServiceState {
    /// No explicit application service configuration was requested.
    NotConfigured,
    /// A configuration was requested but could not be read or bound safely.
    ConfigurationError,
    /// Configuration is valid, but there is no owner descriptor to observe.
    NotReady,
    Starting,
    Ready,
    Draining,
    Drained,
    Failed,
    /// The native owner published an explicit unknown state.
    Unknown,
    /// The observation itself failed or could not prove the advertised state.
    ObservationUnknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplicationServiceReasonCode {
    ConfigurationAbsent,
    StoreRootInvalid,
    ConfigurationReadFailed,
    ConfigurationStoreMismatch,
    OwnerMissing,
    OwnerReadFailed,
    OwnerInvalid,
    OwnerStarting,
    OwnerDraining,
    OwnerDrained,
    OwnerFailed,
    OwnerUnknown,
    LiveProbeFailed,
    LiveIdentityChanged,
    LiveConfigurationMismatch,
    ServiceReady,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationServiceReason {
    pub code: ApplicationServiceReasonCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplicationServiceStatus {
    pub schema_version: String,
    /// True means an explicit service configuration was requested, including
    /// a configuration path that later proved invalid.
    pub configured: bool,
    pub state: ApplicationServiceState,
    pub reason: ApplicationServiceReason,
}

impl ApplicationServiceStatus {
    fn new(
        configured: bool,
        state: ApplicationServiceState,
        code: ApplicationServiceReasonCode,
        message: impl AsRef<str>,
    ) -> Self {
        Self {
            schema_version: APPLICATION_SERVICE_STATUS_SCHEMA.into(),
            configured,
            state,
            reason: ApplicationServiceReason {
                code,
                message: bounded_message(message.as_ref()),
            },
        }
    }
}

/// Observe one canonical accepted-run store and, when explicitly configured,
/// its native application service.
///
/// `None` is intentionally **not** replaced by a default path.  The caller
/// must first complete the separate, write-owning configuration preparation
/// boundary and then pass the exact path it wants observed.  This prevents a
/// status read from silently opting an installation into a service.
pub fn observe(
    canonical_store_root: &Path,
    explicit_config_path: Option<&Path>,
) -> ApplicationServiceStatus {
    let configured = explicit_config_path.is_some();
    let Some(config_path) = explicit_config_path else {
        return ApplicationServiceStatus::new(
            false,
            ApplicationServiceState::NotConfigured,
            ApplicationServiceReasonCode::ConfigurationAbsent,
            "no native application service configuration was requested",
        );
    };

    let store_root = match canonical_store_root_for_observation(canonical_store_root) {
        Ok(root) => root,
        Err(error) => {
            return ApplicationServiceStatus::new(
                configured,
                ApplicationServiceState::ObservationUnknown,
                ApplicationServiceReasonCode::StoreRootInvalid,
                error.to_string(),
            )
        }
    };

    let config = match RuntimeServiceConfig::read(config_path) {
        Ok(config) => config,
        Err(error) => {
            return ApplicationServiceStatus::new(
                configured,
                ApplicationServiceState::ConfigurationError,
                ApplicationServiceReasonCode::ConfigurationReadFailed,
                error.to_string(),
            )
        }
    };

    if let Err(error) = require_configured_store(&config, &store_root) {
        return ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::ConfigurationError,
            ApplicationServiceReasonCode::ConfigurationStoreMismatch,
            error.to_string(),
        );
    }

    let owner = match read_owner_descriptor(&store_root) {
        Ok(Some(owner)) => owner,
        Ok(None) => {
            let lock = checked_path(&store_root, "runtime-services/OWNER.lock");
            let lock_absent = lock.as_ref().ok().is_some_and(|path| {
                matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            });
            if !lock_absent {
                return ApplicationServiceStatus::new(
                    configured,
                    ApplicationServiceState::ObservationUnknown,
                    ApplicationServiceReasonCode::OwnerInvalid,
                    "owner lock exists or cannot be observed without a descriptor; controlled recovery required",
                );
            }
            return ApplicationServiceStatus::new(
                configured,
                ApplicationServiceState::NotReady,
                ApplicationServiceReasonCode::OwnerMissing,
                "native application service owner descriptor is missing",
            );
        }
        Err(error) => {
            let code = if error
                .chain()
                .any(|cause| cause.downcast_ref::<OwnerDescriptorInvalid>().is_some())
            {
                ApplicationServiceReasonCode::OwnerInvalid
            } else {
                ApplicationServiceReasonCode::OwnerReadFailed
            };
            return ApplicationServiceStatus::new(
                configured,
                ApplicationServiceState::ObservationUnknown,
                code,
                error.to_string(),
            );
        }
    };

    if let Err(error) = require_owner_binding(&owner, &config) {
        return ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::ObservationUnknown,
            ApplicationServiceReasonCode::OwnerInvalid,
            error.to_string(),
        );
    }

    match owner.state {
        RuntimeServiceState::Starting => ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::Starting,
            ApplicationServiceReasonCode::OwnerStarting,
            "native application service owner last published starting; liveness is not proven",
        ),
        RuntimeServiceState::Draining => ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::Draining,
            ApplicationServiceReasonCode::OwnerDraining,
            "native application service owner last published draining; liveness is not proven",
        ),
        RuntimeServiceState::Drained => ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::Drained,
            ApplicationServiceReasonCode::OwnerDrained,
            "native application service owner last published drained; liveness is not proven",
        ),
        RuntimeServiceState::Failed => ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::Failed,
            ApplicationServiceReasonCode::OwnerFailed,
            "native application service owner last published failed; liveness is not proven",
        ),
        RuntimeServiceState::Unknown => ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::Unknown,
            ApplicationServiceReasonCode::OwnerUnknown,
            "native application service owner last published unknown; liveness is not proven",
        ),
        RuntimeServiceState::Ready => observe_ready_owner(configured, &store_root, &config, &owner),
    }
}

fn observe_ready_owner(
    configured: bool,
    store_root: &Path,
    config: &RuntimeServiceConfig,
    descriptor: &RuntimeServiceOwnerDescriptor,
) -> ApplicationServiceStatus {
    // This config-aware probe verifies the live loopback owner, target, pinned
    // build identity, and exact RuntimeServiceConfig payload in one bounded
    // status exchange.  A metadata-only descriptor is never sufficient for
    // Ready because it cannot prove the worker/pool settings match the file.
    let observed = match crate::runtime_service_client::probe_with_config(
        store_root,
        &config.target_id,
        Duration::from_secs(LIVE_PROBE_TIMEOUT_SECONDS),
        Some(config),
    ) {
        Ok(observed) => observed,
        Err(error) => {
            let message = error.to_string();
            let reason_code = if message.contains("configuration mismatch") {
                ApplicationServiceReasonCode::LiveConfigurationMismatch
            } else {
                ApplicationServiceReasonCode::LiveProbeFailed
            };
            return ApplicationServiceStatus::new(
                configured,
                ApplicationServiceState::ObservationUnknown,
                reason_code,
                message,
            );
        }
    };

    if !same_live_owner_identity(descriptor, &observed) {
        return ApplicationServiceStatus::new(
            configured,
            ApplicationServiceState::ObservationUnknown,
            ApplicationServiceReasonCode::LiveIdentityChanged,
            "native application service owner changed during observation",
        );
    }

    ApplicationServiceStatus::new(
        configured,
        ApplicationServiceState::Ready,
        ApplicationServiceReasonCode::ServiceReady,
        "native application service is ready and matches the requested configuration",
    )
}

fn same_live_owner_identity(
    expected: &RuntimeServiceOwnerDescriptor,
    observed: &RuntimeServiceOwnerDescriptor,
) -> bool {
    expected.schema_version == observed.schema_version
        && expected.owner_token == observed.owner_token
        && expected.process_start_token == observed.process_start_token
        && expected.pid == observed.pid
        && expected.host == observed.host
        && expected.target_id == observed.target_id
        && expected.protocol == observed.protocol
        && expected.state == observed.state
        && expected.compute_pool_generation == observed.compute_pool_generation
        && expected.preparation_pool_generation == observed.preparation_pool_generation
        && expected.control_address == observed.control_address
        && expected.build_commit == observed.build_commit
        && expected.build_snapshot == observed.build_snapshot
        && expected.compute_pool_id == observed.compute_pool_id
        && expected.preparation_pool_id == observed.preparation_pool_id
        && expected.children == observed.children
}

fn require_owner_binding(
    owner: &RuntimeServiceOwnerDescriptor,
    config: &RuntimeServiceConfig,
) -> Result<()> {
    if owner.target_id != config.target_id {
        bail!(
            "native service owner target `{}` does not match configured target `{}`",
            owner.target_id,
            config.target_id
        );
    }
    if owner
        .compute_pool_id
        .as_deref()
        .is_some_and(|pool| pool != config.compute_pool_id)
    {
        bail!("native service owner compute pool does not match configuration");
    }
    if owner
        .preparation_pool_id
        .as_deref()
        .is_some_and(|pool| pool != config.preparation_pool_id)
    {
        bail!("native service owner preparation pool does not match configuration");
    }

    let identity = fullmag_build_info::identity();
    if owner
        .build_commit
        .as_deref()
        .is_some_and(|commit| commit != identity.git_commit)
    {
        bail!("native service owner build commit does not match this application");
    }
    if owner
        .build_snapshot
        .as_deref()
        .is_some_and(|snapshot| snapshot != identity.source_snapshot_sha256)
    {
        bail!("native service owner source snapshot does not match this application");
    }
    Ok(())
}

fn canonical_store_root_for_observation(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute()
        || root
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        || !root.is_dir()
    {
        bail!("canonical accepted store root must be an absolute existing directory");
    }
    let canonical = fs::canonicalize(root).context("canonicalize accepted store root")?;
    let guarded = crate::accepted_store::writable_product_state_path(root)
        .context("accepted store root contains an unsupported link or ancestor")?;
    if guarded != canonical {
        bail!("accepted store root is not the canonical guarded path");
    }
    Ok(canonical)
}

fn require_configured_store(config: &RuntimeServiceConfig, expected: &Path) -> Result<()> {
    if !config.store_root.is_dir() {
        bail!("native service configuration store root is not an existing directory");
    }
    let configured = canonical_store_root_for_observation(&config.store_root)?;
    if configured != expected {
        bail!("native service configuration belongs to another accepted store");
    }
    Ok(())
}

fn read_owner_descriptor(root: &Path) -> Result<Option<RuntimeServiceOwnerDescriptor>> {
    let path = checked_path(root, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("inspect native service owner descriptor"),
    };
    if !metadata.is_file() {
        bail!("native service owner descriptor is not a regular file");
    }
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        root,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
        OWNER_DESCRIPTOR_MAX_BYTES,
    )
    .context("read native service owner descriptor")?;
    if bytes.is_empty() {
        return Err(
            OwnerDescriptorInvalid("native service owner descriptor is empty".into()).into(),
        );
    }
    let descriptor = serde_json::from_slice::<RuntimeServiceOwnerDescriptor>(&bytes)
        .map_err(|error| OwnerDescriptorInvalid(format!("parse owner descriptor: {error}")))?;
    validate_descriptor(&descriptor)
        .map_err(|error| OwnerDescriptorInvalid(format!("validate owner descriptor: {error:#}")))?;
    Ok(Some(descriptor))
}

#[derive(Debug)]
struct OwnerDescriptorInvalid(String);

impl std::fmt::Display for OwnerDescriptorInvalid {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for OwnerDescriptorInvalid {}

fn bounded_message(message: &str) -> String {
    if message.len() <= REASON_MESSAGE_MAX_BYTES {
        return message.to_owned();
    }
    let mut end = REASON_MESSAGE_MAX_BYTES.saturating_sub("…".len());
    while !message.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    format!("{}…", &message[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use fullmag_session::{
        runtime_service::{
            RuntimeServiceChild, RUNTIME_SERVICE_OWNER_PROTOCOL, RUNTIME_SERVICE_OWNER_SCHEMA,
        },
        FmsPreparationResourceOffer, FmsResourceBudget, FmsResourceKind, FmsSchedulerResourceOffer,
    };
    use std::{fs, net::TcpListener};
    use uuid::Uuid;

    fn fixture() -> (tempfile::TempDir, RuntimeServiceConfig, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        fs::create_dir(root.join("runtime-services")).unwrap();
        let budget = FmsResourceBudget {
            cpu_millis: 1,
            memory_bytes: 1,
            gpu_memory_bytes: 0,
            storage_bytes: 1,
        };
        let config = RuntimeServiceConfig {
            schema_version: "runtime_service_config.v1".into(),
            store_root: root.clone(),
            target_id: "desktop".into(),
            compute_pool_id: "compute".into(),
            preparation_pool_id: "preparation".into(),
            compute_resources: vec![FmsSchedulerResourceOffer {
                resource_id: "compute.cpu".into(),
                kind: FmsResourceKind::Cpu,
                budget: budget.clone(),
            }],
            preparation_resources: vec![FmsPreparationResourceOffer {
                resource_id: "preparation.cpu".into(),
                budget,
            }],
            worker_timeout_seconds: 1,
            preparation_timeout_seconds: 1,
            heartbeat_interval_milliseconds: 1,
            startup_timeout_seconds: 1,
            drain_timeout_seconds: 1,
        };
        config.validate().unwrap();
        let config_path = root.join("runtime-services/APPLICATION.json");
        fs::write(&config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        (directory, config, config_path)
    }

    fn owner_descriptor(
        state: RuntimeServiceState,
        target_id: &str,
        compute_pool_id: Option<&str>,
        preparation_pool_id: Option<&str>,
    ) -> RuntimeServiceOwnerDescriptor {
        let now = Utc::now();
        RuntimeServiceOwnerDescriptor {
            schema_version: RUNTIME_SERVICE_OWNER_SCHEMA.into(),
            owner_token: Uuid::new_v4().to_string(),
            process_start_token: Uuid::new_v4().to_string(),
            pid: 1,
            host: "observer-test".into(),
            target_id: target_id.into(),
            protocol: RUNTIME_SERVICE_OWNER_PROTOCOL.into(),
            state,
            acquired_at: now,
            heartbeat_at: now,
            compute_pool_generation: compute_pool_id.map(|_| 1),
            preparation_pool_generation: preparation_pool_id.map(|_| 1),
            control_address: None,
            build_commit: None,
            build_snapshot: None,
            compute_pool_id: compute_pool_id.map(str::to_owned),
            preparation_pool_id: preparation_pool_id.map(str::to_owned),
            children: Vec::new(),
        }
    }

    fn write_owner(root: &Path, owner: &RuntimeServiceOwnerDescriptor) {
        fs::write(
            root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH),
            serde_json::to_vec(owner).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn no_configuration_is_explicitly_not_configured() {
        let status = observe(Path::new("relative-store"), None);
        assert!(!status.configured);
        assert_eq!(status.state, ApplicationServiceState::NotConfigured);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::ConfigurationAbsent
        );
    }

    #[test]
    fn invalid_store_root_fails_closed_before_config_read() {
        let status = observe(
            Path::new("relative-store"),
            Some(Path::new("relative-config.json")),
        );
        assert!(status.configured);
        assert_eq!(status.state, ApplicationServiceState::ObservationUnknown);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::StoreRootInvalid
        );
    }

    #[test]
    fn reason_messages_are_bounded_on_utf8_boundaries() {
        let message = "ą".repeat(REASON_MESSAGE_MAX_BYTES);
        let bounded = bounded_message(&message);
        assert!(bounded.len() <= REASON_MESSAGE_MAX_BYTES);
        assert!(bounded.is_char_boundary(bounded.len()));
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn status_serializes_stable_schema_and_snake_case_state() {
        let status = ApplicationServiceStatus::new(
            true,
            ApplicationServiceState::ObservationUnknown,
            ApplicationServiceReasonCode::LiveProbeFailed,
            "probe failed",
        );
        let json = serde_json::to_value(status).unwrap();
        assert_eq!(json["schema_version"], APPLICATION_SERVICE_STATUS_SCHEMA);
        assert_eq!(json["configured"], true);
        assert_eq!(json["state"], "observation_unknown");
        assert_eq!(json["reason"]["code"], "live_probe_failed");
    }

    #[test]
    fn malformed_configuration_is_configuration_error_without_store_mutation() {
        let (_directory, config, config_path) = fixture();
        let root = config.store_root.clone();
        fs::write(&config_path, b"{ malformed").unwrap();

        let status = observe(&root, Some(&config_path));

        assert!(status.configured);
        assert_eq!(status.state, ApplicationServiceState::ConfigurationError);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::ConfigurationReadFailed
        );
        assert!(!root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH).exists());
    }

    #[test]
    fn missing_owner_is_not_ready_and_observation_does_not_create_one() {
        let (_directory, config, config_path) = fixture();
        let root = config.store_root.clone();
        let config_before = fs::read(&config_path).unwrap();
        let owner_path = root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH);

        let status = observe(&root, Some(&config_path));

        assert_eq!(status.state, ApplicationServiceState::NotReady);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::OwnerMissing
        );
        assert_eq!(fs::read(&config_path).unwrap(), config_before);
        assert!(!owner_path.exists());
    }

    #[test]
    fn malformed_owner_is_observation_unknown() {
        let (_directory, config, config_path) = fixture();
        let root = config.store_root.clone();
        fs::write(
            root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH),
            b"not-json",
        )
        .unwrap();

        let status = observe(&root, Some(&config_path));

        assert_eq!(status.state, ApplicationServiceState::ObservationUnknown);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::OwnerInvalid
        );
    }

    #[test]
    fn orphaned_owner_lock_requires_recovery_without_creating_a_descriptor() {
        let (_directory, config, config_path) = fixture();
        let lock = config.store_root.join("runtime-services/OWNER.lock");
        fs::write(&lock, b"orphaned").unwrap();
        let status = observe(&config.store_root, Some(&config_path));
        assert_eq!(status.state, ApplicationServiceState::ObservationUnknown);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::OwnerInvalid
        );
        assert_eq!(fs::read(&lock).unwrap(), b"orphaned");
        assert!(!config
            .store_root
            .join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)
            .exists());
    }

    #[test]
    fn oversized_owner_is_observation_unknown_with_bounded_read_failure() {
        let (_directory, config, config_path) = fixture();
        let root = config.store_root.clone();
        fs::write(
            root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH),
            vec![b'0'; OWNER_DESCRIPTOR_MAX_BYTES + 1],
        )
        .unwrap();

        let status = observe(&root, Some(&config_path));

        assert_eq!(status.state, ApplicationServiceState::ObservationUnknown);
        assert_eq!(
            status.reason.code,
            ApplicationServiceReasonCode::OwnerReadFailed
        );
    }

    #[test]
    fn foreign_target_or_pool_cannot_masquerade_as_a_non_ready_service() {
        let (_directory, config, config_path) = fixture();
        let root = config.store_root.clone();
        for (target_id, compute_pool_id, preparation_pool_id) in [
            ("foreign-target", "compute", "preparation"),
            ("desktop", "foreign-compute", "preparation"),
            ("desktop", "compute", "foreign-preparation"),
        ] {
            let owner = owner_descriptor(
                RuntimeServiceState::Starting,
                target_id,
                Some(compute_pool_id),
                Some(preparation_pool_id),
            );
            write_owner(&root, &owner);

            let status = observe(&root, Some(&config_path));

            assert_eq!(status.state, ApplicationServiceState::ObservationUnknown);
            assert_eq!(
                status.reason.code,
                ApplicationServiceReasonCode::OwnerInvalid
            );
        }
    }

    #[test]
    fn ready_metadata_without_live_confirmation_never_becomes_ready() {
        let (_directory, config, config_path) = fixture();
        let root = config.store_root.clone();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let control_address = listener.local_addr().unwrap();
        drop(listener);

        let identity = fullmag_build_info::identity();
        let build_commit = if identity.git_commit.len() == 40
            && identity
                .git_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            identity.git_commit.to_owned()
        } else {
            "a".repeat(40)
        };
        let build_snapshot = if identity.source_snapshot_sha256.len() == 64
            && identity
                .source_snapshot_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            identity.source_snapshot_sha256.to_owned()
        } else {
            "b".repeat(64)
        };
        let mut owner = owner_descriptor(
            RuntimeServiceState::Ready,
            &config.target_id,
            Some(&config.compute_pool_id),
            Some(&config.preparation_pool_id),
        );
        owner.compute_pool_generation = Some(1);
        owner.preparation_pool_generation = Some(1);
        owner.control_address = Some(control_address.to_string());
        owner.build_commit = Some(build_commit);
        owner.build_snapshot = Some(build_snapshot);
        owner.children = vec![
            RuntimeServiceChild {
                role: "compute".into(),
                pid: 2,
                status: "running".into(),
            },
            RuntimeServiceChild {
                role: "preparation".into(),
                pid: 3,
                status: "running".into(),
            },
        ];
        write_owner(&root, &owner);

        let status = observe(&root, Some(&config_path));

        // The descriptor is deliberately only metadata.  Without a live
        // status response, the observer must remain fail-closed.  When a
        // source build identity is unavailable, the binding check may reject
        // the fixture before the socket probe; that is also the intended
        // unknown result, never a service qualification.
        assert_ne!(status.state, ApplicationServiceState::Ready);
        assert_eq!(status.state, ApplicationServiceState::ObservationUnknown);
    }
}
