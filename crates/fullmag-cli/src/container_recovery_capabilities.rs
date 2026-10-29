//! Capability evidence from the actual executable, without opening runtime state.

use fullmag_session::runtime_service::{
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V2,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V3,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V4,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V5,
};

pub(crate) fn document() -> serde_json::Value {
    let identity = fullmag_build_info::identity();
    serde_json::json!({
        "schema_version": "runtime_service_container_recovery_capabilities.v1",
        "supported_recovery_schemas": [
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA,
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V2,
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V3,
            RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V4,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V5,
        ],
        "build_identity": {
            "version": fullmag_build_info::version(),
            "built_at_utc": identity.built_at_utc,
            "git_commit": identity.git_commit,
            "worktree_state": identity.worktree_state,
            "source_snapshot_sha256": identity.source_snapshot_sha256,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::args::{Cli, Command, RuntimeCommand};
    use clap::Parser;

    #[test]
    fn container_recovery_capabilities_command_has_no_state_arguments() {
        let cli = Cli::try_parse_from([
            "fullmag",
            "runtime",
            "service-container-recovery-capabilities",
        ])
        .expect("capability command parses without state configuration");
        assert!(matches!(
            cli.command,
            Command::Runtime(RuntimeCommand::ServiceContainerRecoveryCapabilities)
        ));
        assert!(Cli::try_parse_from([
            "fullmag",
            "runtime",
            "service-container-recovery-capabilities",
            "--config",
            "/must-not-be-opened/runtime.json",
        ])
        .is_err());
    }

    #[test]
    fn container_recovery_capabilities_bind_build_and_request_schemas() {
        let evidence = document();
        assert_eq!(
            evidence["schema_version"],
            "runtime_service_container_recovery_capabilities.v1"
        );
        assert_eq!(
            evidence["supported_recovery_schemas"],
            serde_json::json!([
                RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA,
                RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V2,
                RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V3,
                RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V4,
    RUNTIME_SERVICE_CONTAINER_RECOVERY_REQUEST_SCHEMA_V5,
            ])
        );
        assert_eq!(
            evidence["build_identity"]["git_commit"],
            fullmag_build_info::identity().git_commit
        );
        assert_eq!(
            evidence["build_identity"]["source_snapshot_sha256"],
            fullmag_build_info::identity().source_snapshot_sha256
        );
    }
}
