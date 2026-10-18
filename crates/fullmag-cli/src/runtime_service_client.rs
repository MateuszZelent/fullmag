//! Shared native lifecycle client used by CLI and desktop.
pub(crate) use fullmag_runtime_control::runtime_service_client::{
    drain_confirmed, ensure, initialize_host_application, probe, recover_unknown_empty,
};
