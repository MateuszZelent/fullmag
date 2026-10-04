use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use fullmag_runtime_control::application_service_status::{
    ApplicationServiceReasonCode, ApplicationServiceState, ApplicationServiceStatus,
};

/// Read-only status of the optional native application runtime service.
///
/// The resource intentionally contains no process path, store path, PID, or
/// scheduler payload.  Consumers get the bounded state and a machine-readable
/// reason while the native observer retains ownership of operational details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeServiceStatusResource {
    pub schema_version: String,
    pub configured: bool,
    pub state: RuntimeServiceStatusState,
    pub reason: RuntimeServiceStatusReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeServiceStatusState {
    NotConfigured,
    ConfigurationError,
    NotReady,
    Starting,
    Ready,
    Draining,
    Drained,
    Failed,
    Unknown,
    ObservationUnknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct RuntimeServiceStatusReason {
    pub code: String,
    pub message: String,
}

impl From<ApplicationServiceStatus> for RuntimeServiceStatusResource {
    fn from(status: ApplicationServiceStatus) -> Self {
        Self {
            schema_version: status.schema_version,
            configured: status.configured,
            state: map_state(status.state),
            reason: RuntimeServiceStatusReason {
                code: map_reason_code(status.reason.code).to_owned(),
                message: public_reason_message(status.reason.code).to_owned(),
            },
        }
    }
}

// Native diagnostics may contain host paths or untrusted owner text.
// Only fixed, code-derived explanations cross the public API boundary.
fn public_reason_message(code: ApplicationServiceReasonCode) -> &'static str {
    match code {
        ApplicationServiceReasonCode::ConfigurationAbsent => {
            "No native application service is configured."
        }
        ApplicationServiceReasonCode::StoreRootInvalid => {
            "The accepted store cannot be safely observed."
        }
        ApplicationServiceReasonCode::ConfigurationReadFailed => {
            "The native service configuration cannot be read."
        }
        ApplicationServiceReasonCode::ConfigurationStoreMismatch => {
            "The native service configuration belongs to a different store."
        }
        ApplicationServiceReasonCode::OwnerMissing => "The native service has no published owner.",
        ApplicationServiceReasonCode::OwnerReadFailed => "The native service owner cannot be read.",
        ApplicationServiceReasonCode::OwnerInvalid => {
            "The native service owner metadata is invalid; recovery is required."
        }
        ApplicationServiceReasonCode::OwnerStarting => {
            "The owner last published a starting state; process liveness is unverified."
        }
        ApplicationServiceReasonCode::OwnerDraining => {
            "The owner last published a draining state; process liveness is unverified."
        }
        ApplicationServiceReasonCode::OwnerDrained => {
            "The owner last published a drained state; process liveness is unverified."
        }
        ApplicationServiceReasonCode::OwnerFailed => {
            "The owner last published a failed state; process liveness is unverified."
        }
        ApplicationServiceReasonCode::OwnerUnknown => {
            "The owner last published an unknown state; process liveness is unverified."
        }
        ApplicationServiceReasonCode::LiveProbeFailed => {
            "The live native service could not be verified."
        }
        ApplicationServiceReasonCode::LiveIdentityChanged => {
            "The native service identity changed during observation."
        }
        ApplicationServiceReasonCode::LiveConfigurationMismatch => {
            "The live native service does not match its configuration."
        }
        ApplicationServiceReasonCode::ServiceReady => {
            "The live native service identity and configuration were verified."
        }
    }
}

fn map_state(state: ApplicationServiceState) -> RuntimeServiceStatusState {
    match state {
        ApplicationServiceState::NotConfigured => RuntimeServiceStatusState::NotConfigured,
        ApplicationServiceState::ConfigurationError => {
            RuntimeServiceStatusState::ConfigurationError
        }
        ApplicationServiceState::NotReady => RuntimeServiceStatusState::NotReady,
        ApplicationServiceState::Starting => RuntimeServiceStatusState::Starting,
        ApplicationServiceState::Ready => RuntimeServiceStatusState::Ready,
        ApplicationServiceState::Draining => RuntimeServiceStatusState::Draining,
        ApplicationServiceState::Drained => RuntimeServiceStatusState::Drained,
        ApplicationServiceState::Failed => RuntimeServiceStatusState::Failed,
        ApplicationServiceState::Unknown => RuntimeServiceStatusState::Unknown,
        ApplicationServiceState::ObservationUnknown => {
            RuntimeServiceStatusState::ObservationUnknown
        }
    }
}

fn map_reason_code(code: ApplicationServiceReasonCode) -> &'static str {
    match code {
        ApplicationServiceReasonCode::ConfigurationAbsent => "configuration_absent",
        ApplicationServiceReasonCode::StoreRootInvalid => "store_root_invalid",
        ApplicationServiceReasonCode::ConfigurationReadFailed => "configuration_read_failed",
        ApplicationServiceReasonCode::ConfigurationStoreMismatch => "configuration_store_mismatch",
        ApplicationServiceReasonCode::OwnerMissing => "owner_missing",
        ApplicationServiceReasonCode::OwnerReadFailed => "owner_read_failed",
        ApplicationServiceReasonCode::OwnerInvalid => "owner_invalid",
        ApplicationServiceReasonCode::OwnerStarting => "owner_starting",
        ApplicationServiceReasonCode::OwnerDraining => "owner_draining",
        ApplicationServiceReasonCode::OwnerDrained => "owner_drained",
        ApplicationServiceReasonCode::OwnerFailed => "owner_failed",
        ApplicationServiceReasonCode::OwnerUnknown => "owner_unknown",
        ApplicationServiceReasonCode::LiveProbeFailed => "live_probe_failed",
        ApplicationServiceReasonCode::LiveIdentityChanged => "live_identity_changed",
        ApplicationServiceReasonCode::LiveConfigurationMismatch => "live_configuration_mismatch",
        ApplicationServiceReasonCode::ServiceReady => "service_ready",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_runtime_control::application_service_status::{
        ApplicationServiceReason, APPLICATION_SERVICE_STATUS_SCHEMA,
    };

    #[test]
    fn maps_every_observer_state_to_the_public_snake_case_state() {
        let cases = [
            (ApplicationServiceState::NotConfigured, "not_configured"),
            (
                ApplicationServiceState::ConfigurationError,
                "configuration_error",
            ),
            (ApplicationServiceState::NotReady, "not_ready"),
            (ApplicationServiceState::Starting, "starting"),
            (ApplicationServiceState::Ready, "ready"),
            (ApplicationServiceState::Draining, "draining"),
            (ApplicationServiceState::Drained, "drained"),
            (ApplicationServiceState::Failed, "failed"),
            (ApplicationServiceState::Unknown, "unknown"),
            (
                ApplicationServiceState::ObservationUnknown,
                "observation_unknown",
            ),
        ];

        for (state, expected) in cases {
            let resource = RuntimeServiceStatusResource::from(ApplicationServiceStatus {
                schema_version: APPLICATION_SERVICE_STATUS_SCHEMA.to_owned(),
                configured: true,
                state,
                reason: ApplicationServiceReason {
                    code: ApplicationServiceReasonCode::ServiceReady,
                    message: "test".to_owned(),
                },
            });
            assert_eq!(serde_json::to_value(resource).unwrap()["state"], expected);
        }
    }

    #[test]
    fn maps_reason_codes_without_exposing_a_native_enum_contract() {
        let resource = RuntimeServiceStatusResource::from(ApplicationServiceStatus {
            schema_version: APPLICATION_SERVICE_STATUS_SCHEMA.to_owned(),
            configured: true,
            state: ApplicationServiceState::ObservationUnknown,
            reason: ApplicationServiceReason {
                code: ApplicationServiceReasonCode::LiveConfigurationMismatch,
                message: "C:/operator-private/store: configuration mismatch".to_owned(),
            },
        });

        assert_eq!(resource.reason.code, "live_configuration_mismatch");
        assert_eq!(
            resource.reason.message,
            public_reason_message(ApplicationServiceReasonCode::LiveConfigurationMismatch)
        );
        assert!(!resource.reason.message.contains("operator-private"));
    }
}
