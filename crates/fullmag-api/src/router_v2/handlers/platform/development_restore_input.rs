//! Private startup input from the development launcher, never an HTTP resource.
//!
//! Capsule verification and process ownership remain the launcher's duties.
//! This consumer binds the input to the configured candidate and installs the
//! authoring snapshot before any API listener can expose an empty workspace.

use std::{io::Read, sync::atomic::Ordering, time::Duration};

use fullmag_authoring::SceneDocument;
use serde::Deserialize;

use crate::types::AppState;

use super::development_backend::DevelopmentBackendConfig;

const INPUT_ENV: &str = "FULLMAG_DEVELOPMENT_RESTORE_STDIN";
const SCHEMA: &str = "fullmag.development-prelisten-restore.v1";
const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RestoreInput {
    schema: String,
    target_build_id: String,
    target_source_sha256: String,
    old_session_id: String,
    scene_document: SceneDocument,
}

/// An explicit request must fail closed; absent configuration never reads stdin.
pub(crate) async fn restore_before_listen(state: &AppState) -> Result<(), String> {
    match std::env::var_os(INPUT_ENV) {
        None => return Ok(()),
        Some(value) if value == "1" => {}
        Some(_) => return Err("invalid private development restore configuration".into()),
    }
    let DevelopmentBackendConfig::Managed { current, .. } = &state.development_backend else {
        return Err("development restore requires a managed development launcher".into());
    };

    // Use a detached OS reader, not spawn_blocking: a stalled inherited pipe
    // must not keep Tokio's runtime shutdown waiting after the deadline.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("development-restore-input".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let result = std::io::stdin()
                .lock()
                .take((MAX_INPUT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "cannot read private development restore input".to_string())
                .and_then(|_| {
                    if bytes.len() > MAX_INPUT_BYTES {
                        Err("private development restore input exceeds its limit".to_string())
                    } else {
                        serde_json::from_slice::<RestoreInput>(&bytes)
                            .map_err(|_| "invalid private development restore input".to_string())
                    }
                });
            let _ = sender.send(result);
        })
        .map_err(|_| "cannot start private development restore reader".to_string())?;
    let input = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .map_err(|_| "private development restore input deadline exceeded".to_string())?
        .map_err(|_| "private development restore reader disconnected".to_string())??;
    if input.schema != SCHEMA
        || input.target_build_id != current.id
        || input.target_source_sha256 != current.source_sha256
    {
        return Err("private development restore input targets a different build".into());
    }
    let snapshot = super::development_restore::restore_authoring_snapshot(
        input.scene_document,
        &input.old_session_id,
    )
    .map_err(|error| error.message)?;
    let _transition = state.current_live_session_transition.lock().await;
    let mut current_state = state.current_live_state.write().await;
    if current_state.is_some() || state.current_live_session_epoch.load(Ordering::Acquire) != 0 {
        return Err("development restore requires a fresh API workspace".into());
    }
    *current_state = Some(snapshot);
    state.current_live_session_epoch.store(1, Ordering::Release);
    Ok(())
}
