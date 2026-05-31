use axum::extract::ws::{Message, WebSocket};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use fullmag_authoring::{
    normalize_scene_document_magnetization_assets, MagnetizationAsset, SceneDocument,
};
use fullmag_ir::{TextureMappingIR, TextureProjectionMode, TextureTransform3DIR};
use fullmag_plan::{sample_preset_texture, TextureSamplePoint};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex, RwLock};
use tokio::time::{interval, sleep_until, Duration, Instant};
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;

use fullmag_quantities::{quantity_spec, QuantityShape as QuantityKind};
use fullmag_runner::LivePreviewField;

mod artifacts;
mod assets;
mod build_info;
mod error;
mod feature_flags;
mod fem_cross_section;
mod fem_cross_section_image;
mod fem_slice;
mod fem_slice_overlay;
mod fem_spatial_index;
mod field_projection;
mod field_render_png;
mod field_slice;
mod field_store;
mod openapi_v2;
mod orientation_color;
mod preview;
mod quantities;
mod quantity_data_plane;
mod router_v2;
mod schemas;
mod script;
mod session;
mod session_persistence;
mod types;

use artifacts::*;
use assets::*;
use error::ApiError;
use feature_flags::FeatureFlags;
use preview::*;
use quantities::*;
use schemas::realtime::{
    HeartbeatPayload, HelloPayload, LiveRealtimeServerEvent, RealtimeResourceChange,
    RealtimeResourceName, RealtimeResourceRevisionMap, ResourceBatchChangedPayload,
    ResyncRequiredPayload,
};
use script::*;
use session::*;
use types::*;

const CURRENT_LIVE_REALTIME_REPLAY_CAPACITY: usize = 512;
const CURRENT_LIVE_REALTIME_HEARTBEAT_SECS: u64 = 15;
const CURRENT_LIVE_REALTIME_COALESCE_WINDOW_MS: u32 = 250;

#[derive(Debug, Clone)]
pub(crate) struct CurrentLiveRealtimeState {
    pub session_id: String,
    pub run_id: Option<String>,
    pub revisions: RealtimeResourceRevisionMap,
    pub mesh_resource_fetches: Vec<String>,
}

fn realtime_timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn current_live_realtime_contract_version() -> &'static str {
    "1.0.0"
}

fn current_live_realtime_available_after_seq(
    replay: &VecDeque<CurrentLiveRealtimeEvent>,
    current_seq: u64,
) -> u64 {
    replay
        .front()
        .map(|event| event.seq.saturating_sub(1))
        .unwrap_or(current_seq)
}

pub(crate) async fn current_live_realtime_state_from_snapshot(
    state: &AppState,
    snapshot: &SessionStateResponse,
    display_revision: u64,
) -> CurrentLiveRealtimeState {
    let (commands_revision, command_completion_revision) = {
        let ledger = state.current_command_ledger.lock().await;
        let commands_revision = ledger.len() as u64;
        let command_completion_revision = ledger
            .iter()
            .filter_map(|record| record.completed_at_unix_ms)
            .filter_map(|value| u64::try_from(value).ok())
            .max()
            .unwrap_or_else(|| ledger.back().map(|record| record.command.seq).unwrap_or(0));
        (commands_revision, command_completion_revision)
    };
    let workspace_revision = current_live_workspace_revision(state).await;
    let domain_generation_id = snapshot
        .fem_mesh
        .as_ref()
        .and_then(|mesh| mesh.generation_id.as_deref())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let field_catalog_revision =
        router_v2::handlers::sessions::status::field_catalog_revision(snapshot);
    let field_revision = router_v2::handlers::sessions::status::field_revision(snapshot);
    let slice_revision =
        router_v2::handlers::sessions::status::slice_revision(field_revision, display_revision);
    let artifact_revision = router_v2::handlers::sessions::status::artifact_revision(snapshot);
    CurrentLiveRealtimeState {
        session_id: snapshot.session.session_id.clone(),
        run_id: snapshot.run.as_ref().map(|run| run.run_id.clone()),
        mesh_resource_fetches: current_live_mesh_resource_fetches(snapshot),
        revisions: RealtimeResourceRevisionMap {
            topology_revision: router_v2::handlers::sessions::status::topology_revision(
                snapshot,
                domain_generation_id,
            ),
            field_catalog_revision,
            field_revision,
            slice_revision,
            artifact_revision,
            command_completion_revision,
            fields_revision: field_revision,
            scalars_revision: snapshot.scalar_revision,
            domain_generation_id,
            artifacts_revision: snapshot.artifacts.len() as u64,
            engine_log_revision: snapshot.engine_log.len() as u64,
            solver_profile_revision: snapshot.solver_profile.revision,
            display_revision,
            visualization_state_revision: display_revision,
            workspace_revision,
            mesh_revision: snapshot.mesh_revision,
            mesh_build_revision: snapshot.mesh_build_revision,
            commands_revision,
            stages_revision: snapshot.stage_execution_revision,
            scene_revision: snapshot.scene_document.as_ref().map(|scene| scene.revision),
        },
    }
}

fn current_live_mesh_resource_fetches(snapshot: &SessionStateResponse) -> Vec<String> {
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Vec::new();
    };

    let mut fetches = vec![
        "/v2/sessions/current/meshing/meshes/shared-domain/manifest".to_string(),
        "/v2/sessions/current/meshing/meshes/shared-domain/topology".to_string(),
    ];
    fetches.extend(mesh.object_segments.iter().map(|segment| {
        format!(
            "/v2/sessions/current/meshing/meshes/objects/{}/topology",
            segment.object_id
        )
    }));
    fetches.extend(mesh.mesh_parts.iter().map(|part| {
        format!(
            "/v2/sessions/current/meshing/meshes/parts/{}/topology",
            part.id
        )
    }));
    fetches
}

async fn current_live_workspace_revision(state: &AppState) -> u64 {
    let selection_revision = state.current_workspace_selection.read().await.revision;
    let ribbon_revision = state.current_workspace_ribbon.read().await.revision;
    let layout_revision = state.current_workspace_layout.read().await.revision;
    selection_revision.max(ribbon_revision).max(layout_revision)
}

fn current_live_realtime_changes(
    realtime_state: &CurrentLiveRealtimeState,
) -> Vec<RealtimeResourceChange> {
    let mut changes = vec![
        RealtimeResourceChange {
            resource: RealtimeResourceName::Display,
            revision: realtime_state.revisions.display_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/visualization/display".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::VisualizationState,
            revision: realtime_state.revisions.visualization_state_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/visualization/state".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Workspace,
            revision: realtime_state.revisions.workspace_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/workspace/selection".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Fields,
            revision: realtime_state.revisions.field_catalog_revision,
            resource_id: Some("catalog".to_string()),
            domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
            recommended_fetch: Some("/v2/sessions/current/data/fields".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Fields,
            revision: realtime_state.revisions.field_revision,
            resource_id: Some("samples".to_string()),
            domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
            recommended_fetch: None,
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Scalars,
            revision: realtime_state.revisions.scalars_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/data/scalars".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Domain,
            revision: realtime_state.revisions.domain_generation_id,
            resource_id: None,
            domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
            recommended_fetch: Some("/v2/sessions/current/data/domain/meta".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Domain,
            revision: realtime_state.revisions.topology_revision,
            resource_id: Some("topology".to_string()),
            domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
            recommended_fetch: Some("/v2/sessions/current/data/domain/topology".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Artifacts,
            revision: realtime_state.revisions.artifacts_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/data/artifacts".to_string()),
        },
        RealtimeResourceChange {
            resource: RealtimeResourceName::Logs,
            revision: realtime_state.revisions.engine_log_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/diagnostics/engine-log".to_string()),
        },
    ];
    if realtime_state.revisions.solver_profile_revision > 0 {
        changes.push(RealtimeResourceChange {
            resource: RealtimeResourceName::Diagnostics,
            revision: realtime_state.revisions.solver_profile_revision,
            resource_id: Some("solver-profile".to_string()),
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/diagnostics/solver-profile".to_string()),
        });
    }
    if realtime_state.revisions.mesh_revision > 0 {
        changes.push(RealtimeResourceChange {
            resource: RealtimeResourceName::Mesh,
            revision: realtime_state.revisions.mesh_revision,
            resource_id: None,
            domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
            recommended_fetch: Some("/v2/sessions/current/meshing/summary".to_string()),
        });
        for recommended_fetch in &realtime_state.mesh_resource_fetches {
            changes.push(RealtimeResourceChange {
                resource: RealtimeResourceName::Mesh,
                revision: realtime_state.revisions.mesh_revision,
                resource_id: None,
                domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
                recommended_fetch: Some(recommended_fetch.clone()),
            });
        }
    }
    if realtime_state.revisions.mesh_build_revision > 0 {
        changes.push(RealtimeResourceChange {
            resource: RealtimeResourceName::MeshBuilds,
            revision: realtime_state.revisions.mesh_build_revision,
            resource_id: None,
            domain_generation_id: Some(realtime_state.revisions.domain_generation_id),
            recommended_fetch: Some("/v2/sessions/current/meshing/builds/current".to_string()),
        });
    }
    if realtime_state.revisions.commands_revision > 0 {
        changes.push(RealtimeResourceChange {
            resource: RealtimeResourceName::Commands,
            revision: realtime_state.revisions.commands_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/simulation/commands".to_string()),
        });
    }
    if realtime_state.revisions.stages_revision > 0 {
        changes.push(RealtimeResourceChange {
            resource: RealtimeResourceName::Stages,
            revision: realtime_state.revisions.stages_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/simulation/stages/execution".to_string()),
        });
    }
    if let Some(scene_revision) = realtime_state.revisions.scene_revision {
        changes.push(RealtimeResourceChange {
            resource: RealtimeResourceName::SceneDocument,
            revision: scene_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/model/scene".to_string()),
        });
    }
    changes
}

fn current_live_realtime_changes_since(
    realtime_state: &CurrentLiveRealtimeState,
    previous_revisions: Option<&RealtimeResourceRevisionMap>,
) -> Vec<RealtimeResourceChange> {
    let changes = current_live_realtime_changes(realtime_state);
    let Some(previous_revisions) = previous_revisions else {
        return changes;
    };

    changes
        .into_iter()
        .filter(|change| current_live_realtime_change_revision_changed(previous_revisions, change))
        .collect()
}

fn current_live_realtime_change_revision_changed(
    previous: &RealtimeResourceRevisionMap,
    change: &RealtimeResourceChange,
) -> bool {
    let domain_generation_changed = change
        .domain_generation_id
        .is_some_and(|revision| revision != previous.domain_generation_id);
    match change.resource {
        RealtimeResourceName::Display => previous.display_revision != change.revision,
        RealtimeResourceName::VisualizationState => {
            previous.visualization_state_revision != change.revision
        }
        RealtimeResourceName::Workspace => previous.workspace_revision != change.revision,
        RealtimeResourceName::Fields => {
            match change.resource_id.as_deref() {
                Some("catalog") => {
                    previous.field_catalog_revision != change.revision || domain_generation_changed
                }
                Some("samples") => {
                    previous.field_revision != change.revision || domain_generation_changed
                }
                _ => previous.fields_revision != change.revision || domain_generation_changed,
            }
        }
        RealtimeResourceName::Scalars => previous.scalars_revision != change.revision,
        RealtimeResourceName::Domain => {
            if change.recommended_fetch.as_deref() == Some("/v2/sessions/current/data/domain/meta")
            {
                previous.domain_generation_id != change.revision
            } else {
                previous.topology_revision != change.revision || domain_generation_changed
            }
        }
        RealtimeResourceName::Artifacts => previous.artifacts_revision != change.revision,
        RealtimeResourceName::Logs => previous.engine_log_revision != change.revision,
        RealtimeResourceName::Diagnostics => previous.solver_profile_revision != change.revision,
        RealtimeResourceName::Mesh => {
            previous.mesh_revision != change.revision || domain_generation_changed
        }
        RealtimeResourceName::MeshBuilds => previous.mesh_build_revision != change.revision,
        RealtimeResourceName::Commands => previous.commands_revision != change.revision,
        RealtimeResourceName::Stages => previous.stages_revision != change.revision,
        RealtimeResourceName::SceneDocument => previous.scene_revision != Some(change.revision),
        RealtimeResourceName::VisualizationClientAcks => true,
    }
}

#[cfg(test)]
mod realtime_change_tests {
    use super::*;

    fn revisions() -> RealtimeResourceRevisionMap {
        RealtimeResourceRevisionMap {
            topology_revision: 11,
            field_catalog_revision: 12,
            field_revision: 13,
            slice_revision: 14,
            artifact_revision: 15,
            command_completion_revision: 16,
            fields_revision: 13, // must equal field_revision — they share the same source
            scalars_revision: 18,
            domain_generation_id: 19,
            artifacts_revision: 20,
            engine_log_revision: 21,
            solver_profile_revision: 0,
            display_revision: 22,
            workspace_revision: 23,
            mesh_revision: 24,
            mesh_build_revision: 25,
            commands_revision: 26,
            stages_revision: 27,
            scene_revision: Some(28),
            visualization_state_revision: 29,
        }
    }

    #[test]
    fn realtime_changes_include_mesh_and_scene_resource_fetches() {
        let state = CurrentLiveRealtimeState {
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            revisions: revisions(),
            mesh_resource_fetches: vec![
                "/v2/sessions/current/meshing/meshes/shared-domain/manifest".to_string(),
                "/v2/sessions/current/meshing/meshes/shared-domain/topology".to_string(),
            ],
        };

        let fetches = current_live_realtime_changes(&state)
            .into_iter()
            .filter_map(|change| change.recommended_fetch)
            .collect::<BTreeSet<_>>();

        assert!(fetches.contains("/v2/sessions/current/data/domain/topology"));
        assert!(fetches.contains("/v2/sessions/current/meshing/meshes/shared-domain/manifest"));
        assert!(fetches.contains("/v2/sessions/current/meshing/meshes/shared-domain/topology"));
        assert!(fetches.contains("/v2/sessions/current/model/scene"));
    }

    #[test]
    fn realtime_changes_publish_separate_field_catalog_and_field_sample_changes() {
        let changes = current_live_realtime_changes(&CurrentLiveRealtimeState {
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            revisions: revisions(),
            mesh_resource_fetches: Vec::new(),
        });

        assert!(changes.iter().any(|change| {
            matches!(change.resource, RealtimeResourceName::Fields)
                && change.resource_id.as_deref() == Some("catalog")
                && change.recommended_fetch.as_deref()
                    == Some("/v2/sessions/current/data/fields")
        }));
        assert!(changes.iter().any(|change| {
            matches!(change.resource, RealtimeResourceName::Fields)
                && change.resource_id.as_deref() == Some("samples")
                && change.recommended_fetch.is_none()
        }));
        assert!(changes.iter().all(|change| {
            change
                .recommended_fetch
                .as_deref()
                .is_none_or(|fetch| !fetch.contains("/samples/vector"))
        }));
    }

    #[test]
    fn realtime_changes_since_omits_unchanged_static_resources() {
        let mut current_revisions = revisions();
        current_revisions.field_catalog_revision += 1;
        let state = CurrentLiveRealtimeState {
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            revisions: current_revisions,
            mesh_resource_fetches: vec![
                "/v2/sessions/current/meshing/meshes/shared-domain/manifest".to_string(),
                "/v2/sessions/current/meshing/meshes/shared-domain/topology".to_string(),
            ],
        };

        let fetches = current_live_realtime_changes_since(&state, Some(&revisions()))
            .into_iter()
            .filter_map(|change| change.recommended_fetch)
            .collect::<BTreeSet<_>>();

        assert_eq!(fetches.len(), 1);
        assert!(fetches.contains("/v2/sessions/current/data/fields"));
        assert!(!fetches.contains("/v2/sessions/current/meshing/meshes/shared-domain/topology"));
        assert!(!fetches.contains("/v2/sessions/current/workspace/selection"));
    }

    #[test]
    fn realtime_changes_since_refreshes_field_samples_when_live_field_data_changes() {
        let mut current_revisions = revisions();
        current_revisions.field_revision += 1;
        current_revisions.fields_revision = current_revisions.field_revision;
        let state = CurrentLiveRealtimeState {
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            revisions: current_revisions,
            mesh_resource_fetches: Vec::new(),
        };

        let changes = current_live_realtime_changes_since(&state, Some(&revisions()));

        assert!(changes.iter().any(|change| {
            matches!(change.resource, RealtimeResourceName::Fields)
                && change.resource_id.as_deref() == Some("samples")
                && change.recommended_fetch.is_none()
        }));
    }

    #[test]
    fn realtime_changes_since_does_not_refresh_field_vectors_when_only_snapshot_counter_changes() {
        // Scenario: fields_revision stays the same but some other revision changed.
        // The field-samples change should NOT appear in the diff.
        let previous = revisions();
        let mut current = revisions();
        // Bump scalars (a different resource) without touching field_revision/fields_revision.
        current.scalars_revision += 1;

        let state = CurrentLiveRealtimeState {
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            revisions: current,
            mesh_resource_fetches: Vec::new(),
        };

        let changes = current_live_realtime_changes_since(&state, Some(&previous));

        // Scalars should show up.
        assert!(changes.iter().any(|c| c
            .recommended_fetch
            .as_deref()
            == Some("/v2/sessions/current/data/scalars")));
        // Field samples should NOT show up.
        assert!(changes.iter().all(|c| !(matches!(
            c.resource,
            RealtimeResourceName::Fields
        ) && c.resource_id.as_deref() == Some("samples"))));
    }

    #[test]
    fn realtime_batch_events_carry_coalescing_window_metadata() {
        let event = LiveRealtimeServerEvent::ResourceBatchChanged {
            seq: 1,
            ts: "2026-05-21T00:00:00.000Z".to_string(),
            session_id: "session-1".to_string(),
            run_id: None,
            contract_version: current_live_realtime_contract_version().to_string(),
            payload: ResourceBatchChangedPayload {
                changes: Vec::new(),
                coalesced: true,
                window_ms: 100,
            },
        };

        assert_eq!(
            current_live_realtime_event_coalesce_window_ms(&event),
            Some(100)
        );
    }
}

fn current_live_realtime_event_coalesce_window_ms(event: &LiveRealtimeServerEvent) -> Option<u32> {
    if let LiveRealtimeServerEvent::ResourceBatchChanged { payload, .. } = event {
        if payload.coalesced && payload.window_ms > 0 {
            return Some(payload.window_ms);
        }
    }
    None
}

async fn publish_current_live_realtime_event(
    state: &AppState,
    event: LiveRealtimeServerEvent,
) -> Result<(), ApiError> {
    let json = serde_json::to_string(&event).map_err(|error| {
        ApiError::internal(format!("failed to serialize realtime event: {error}"))
    })?;
    let record = CurrentLiveRealtimeEvent {
        seq: event.seq(),
        json,
        coalesce_window_ms: current_live_realtime_event_coalesce_window_ms(&event),
    };
    {
        let mut replay = state.current_live_realtime_replay.lock().await;
        replay.push_back(record.clone());
        while replay.len() > CURRENT_LIVE_REALTIME_REPLAY_CAPACITY {
            replay.pop_front();
        }
    }
    let _ = state.current_live_realtime_events.send(record);
    Ok(())
}

pub(crate) async fn publish_current_live_realtime_batch_changed(
    state: &AppState,
    realtime_state: &CurrentLiveRealtimeState,
    coalesced: bool,
    window_ms: u32,
) -> Result<(), ApiError> {
    publish_current_live_realtime_resource_changes(
        state,
        realtime_state.session_id.clone(),
        realtime_state.run_id.clone(),
        current_live_realtime_changes(realtime_state),
        coalesced,
        window_ms,
    )
    .await
}

async fn publish_current_live_realtime_batch_changed_since(
    state: &AppState,
    realtime_state: &CurrentLiveRealtimeState,
    previous_revisions: Option<&RealtimeResourceRevisionMap>,
    coalesced: bool,
    window_ms: u32,
) -> Result<(), ApiError> {
    publish_current_live_realtime_resource_changes(
        state,
        realtime_state.session_id.clone(),
        realtime_state.run_id.clone(),
        current_live_realtime_changes_since(realtime_state, previous_revisions),
        coalesced,
        window_ms,
    )
    .await
}

pub(crate) async fn publish_current_live_realtime_resource_changes(
    state: &AppState,
    session_id: String,
    run_id: Option<String>,
    changes: Vec<RealtimeResourceChange>,
    coalesced: bool,
    window_ms: u32,
) -> Result<(), ApiError> {
    if changes.is_empty() {
        return Ok(());
    }

    let seq = state
        .current_live_realtime_next_seq
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    publish_current_live_realtime_event(
        state,
        LiveRealtimeServerEvent::ResourceBatchChanged {
            seq,
            ts: realtime_timestamp_now(),
            session_id,
            run_id,
            contract_version: current_live_realtime_contract_version().to_string(),
            payload: ResourceBatchChangedPayload {
                changes,
                coalesced,
                window_ms,
            },
        },
    )
    .await
}

fn parse_texture_projection_mode(value: &str) -> TextureProjectionMode {
    match value.trim().to_ascii_lowercase().as_str() {
        "object_local" => TextureProjectionMode::ObjectLocal,
        "planar_xy" => TextureProjectionMode::PlanarXy,
        "planar_xz" => TextureProjectionMode::PlanarXz,
        "planar_yz" => TextureProjectionMode::PlanarYz,
        other => {
            eprintln!(
                "[fullmag-api][mag-texture] unknown projection {:?}, falling back to object_local",
                other
            );
            TextureProjectionMode::ObjectLocal
        }
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--print-openapi-v2") {
        println!(
            "{}",
            serde_json::to_string_pretty(&openapi_v2::openapi_json())
                .expect("OpenAPI v2 document should serialize to JSON")
        );
        return;
    }

    tracing_subscriber::fmt().with_env_filter("info").init();

    let repo_root = repo_root();
    let current_workspace_root = repo_root
        .join(".fullmag")
        .join("local-live")
        .join("current");
    let static_web_root = resolve_static_web_root(&repo_root);

    let feature_flags = FeatureFlags::resolve();
    if feature_flags.any_active() {
        eprintln!(
            "[fullmag-api] FEATURE FLAGS active: {}",
            feature_flags.summary()
        );
    }

    let state = Arc::new(AppState {
        repo_root: repo_root.clone(),
        current_workspace_root,
        current_live_state: Arc::new(RwLock::new(None)),
        current_live_realtime_events: broadcast::channel(256).0,
        current_live_realtime_replay: Arc::new(Mutex::new(VecDeque::new())),
        current_live_realtime_next_seq: Arc::new(AtomicU64::new(0)),
        current_display_selection: Arc::new(RwLock::new(CurrentDisplaySelection::default())),
        current_display_presentation: Arc::new(RwLock::new(DisplayPresentationState::default())),
        current_visualization_client_acks: Arc::new(RwLock::new(BTreeMap::new())),
        current_visualization_client_ack_revision: Arc::new(AtomicU64::new(0)),
        current_workspace_selection: Arc::new(RwLock::new(CurrentWorkspaceSelection::default())),
        current_workspace_ribbon: Arc::new(RwLock::new(CurrentWorkspaceRibbon::default())),
        current_workspace_layout: Arc::new(RwLock::new(CurrentWorkspaceLayout::default())),
        current_control_queue: Arc::new(Mutex::new(VecDeque::new())),
        current_command_responses: Arc::new(Mutex::new(VecDeque::new())),
        current_command_ledger: Arc::new(Mutex::new(VecDeque::new())),
        current_control_events: watch::channel(0).0,
        current_control_next_seq: Arc::new(Mutex::new(0)),
        feature_flags,
        quantity_data_plane: Arc::new(crate::quantity_data_plane::QuantityDataPlaneStore::new()),
    });

    let cors = router_v2::middleware::cors::cors_layer();

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/v2/platform/vision", get(vision))
        // ── Internal runner bridge (not part of the public browser contract) ──
        .route(
            "/v1/internal/live/current/snapshot",
            post(sync_current_live_snapshot),
        )
        .route(
            "/v1/internal/live/current/session",
            post(sync_current_live_session_frame),
        )
        .route(
            "/v1/internal/live/current/runtime",
            post(sync_current_live_runtime_frame),
        )
        .route(
            "/v1/internal/live/current/scalars",
            post(sync_current_live_scalar_frame),
        )
        .route(
            "/v1/internal/live/current/fields",
            post(sync_current_live_field_frame),
        )
        .route(
            "/v1/internal/live/current/control/wait",
            get(wait_current_live_control),
        )
        // ── Diagnostics / feature flags ───────────────────────────────
        // ── Feature flags (diagnostics) ──────────────────────────────
        .route("/v2/platform/docs/physics", get(list_physics_docs))
        // ── Professional session-scoped API (v2) ───────────────────────
        .merge(router_v2::build_v2_router())
        // ── OpenAPI / Swagger ──────────────────────────────────────────
        .merge(
            utoipa_swagger_ui::SwaggerUi::new("/v2/platform/docs/swagger")
                .external_url_unchecked("/v2/platform/openapi.json", openapi_v2::openapi_json()),
        )
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .layer(cors)
        .with_state(state);

    let app = if let Some(static_root) = static_web_root {
        info!(path = %static_root.display(), "serving built control room");
        app.fallback_service(
            ServeDir::new(&static_root)
                .append_index_html_on_directories(true)
                .fallback(ServeFile::new(static_root.join("index.html"))),
        )
    } else {
        app
    };

    let port: u16 = std::env::var("FULLMAG_API_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8081);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!(%addr, "starting fullmag-api");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("binding API listener should succeed");

    axum::serve(listener, app)
        .await
        .expect("serving API should succeed");
}

fn resolve_static_web_root(repo_root: &Path) -> Option<PathBuf> {
    if std::env::var("FULLMAG_DISABLE_STATIC_CONTROL_ROOM")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        return None;
    }

    let candidates = [
        std::env::var_os("FULLMAG_WEB_STATIC_DIR").map(PathBuf::from),
        Some(repo_root.join(".fullmag").join("local").join("web")),
        Some(repo_root.join("apps").join("web").join("out")),
    ];

    candidates
        .into_iter()
        .flatten()
        .find(|path| path.join("index.html").is_file())
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "fullmag-api",
    })
}

async fn vision() -> Json<VisionResponse> {
    Json(VisionResponse {
        north_star:
            "Describe one physical problem and execute it through FDM, FEM, or hybrid plans.",
        modes: ["strict", "extended", "hybrid"],
        runtime_spine: "current-live",
    })
}

pub(crate) fn sample_gpu_telemetry() -> Result<GpuTelemetryResponse, ApiError> {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|error| ApiError::internal(format!("failed to launch nvidia-smi: {error}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("nvidia-smi exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(ApiError::internal(format!(
            "failed to sample GPU telemetry: {detail}"
        )));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|error| {
        ApiError::internal(format!("nvidia-smi emitted invalid UTF-8: {error}"))
    })?;

    let mut devices = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        let parts = line.split(',').map(|part| part.trim()).collect::<Vec<_>>();
        if parts.len() != 7 {
            return Err(ApiError::internal(format!(
                "unexpected nvidia-smi output shape: '{line}'"
            )));
        }
        devices.push(GpuTelemetryDevice {
            index: parts[0].parse().map_err(|error| {
                ApiError::internal(format!("failed to parse GPU index from '{line}': {error}"))
            })?,
            name: parts[1].to_string(),
            utilization_gpu_percent: parts[2].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU utilization from '{line}': {error}"
                ))
            })?,
            utilization_memory_percent: parts[3].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU memory utilization from '{line}': {error}"
                ))
            })?,
            memory_used_mb: parts[4].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU memory used from '{line}': {error}"
                ))
            })?,
            memory_total_mb: parts[5].parse().map_err(|error| {
                ApiError::internal(format!(
                    "failed to parse GPU memory total from '{line}': {error}"
                ))
            })?,
            temperature_c: parts[6].parse().ok(),
        });
    }

    Ok(GpuTelemetryResponse {
        status: "available".into(),
        reason: None,
        sample_time_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0),
        devices,
    })
}

struct CpuSample {
    idle_ticks: u64,
    total_ticks: u64,
    process_ticks: u64,
}

pub(crate) fn sample_cpu_telemetry() -> Result<crate::types::CpuTelemetryResponse, ApiError> {
    let first = read_cpu_sample()?;
    std::thread::sleep(std::time::Duration::from_millis(100));
    let second = read_cpu_sample()?;
    let total_delta = second.total_ticks.saturating_sub(first.total_ticks);
    if total_delta == 0 {
        return Err(ApiError::internal(
            "CPU telemetry sample had zero elapsed ticks",
        ));
    }
    let idle_delta = second.idle_ticks.saturating_sub(first.idle_ticks);
    let busy_delta = total_delta.saturating_sub(idle_delta);
    let logical_cpus = std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(1);
    let process_delta = second.process_ticks.saturating_sub(first.process_ticks);
    let utilization_cpu_percent =
        (busy_delta as f64 / total_delta as f64 * 100.0).clamp(0.0, 100.0);
    let process_cpu_percent =
        (process_delta as f64 / total_delta as f64 * logical_cpus as f64 * 100.0)
            .clamp(0.0, logical_cpus as f64 * 100.0);
    let (memory_total_mb, memory_used_mb) = read_memory_mb()?;
    let (process_rss_mb, process_threads) = read_process_status()?;
    let (load_average_1m, load_average_5m, load_average_15m) = read_load_average();

    Ok(crate::types::CpuTelemetryResponse {
        status: "available".into(),
        reason: None,
        sample_time_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0),
        logical_cpus,
        utilization_cpu_percent,
        process_cpu_percent,
        memory_used_mb,
        memory_total_mb,
        process_rss_mb,
        process_threads,
        load_average_1m,
        load_average_5m,
        load_average_15m,
        model_name: read_cpu_model_name(),
    })
}

fn read_cpu_sample() -> Result<CpuSample, ApiError> {
    let stat = std::fs::read_to_string("/proc/stat")
        .map_err(|error| ApiError::internal(format!("failed to read /proc/stat: {error}")))?;
    let cpu_line = stat
        .lines()
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(|| ApiError::internal("failed to find aggregate CPU line in /proc/stat"))?;
    let values = cpu_line
        .split_whitespace()
        .skip(1)
        .map(|part| {
            part.parse::<u64>().map_err(|error| {
                ApiError::internal(format!("failed to parse /proc/stat CPU ticks: {error}"))
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() < 5 {
        return Err(ApiError::internal(
            "aggregate CPU line in /proc/stat is incomplete",
        ));
    }
    let idle_ticks = values[3].saturating_add(values[4]);
    let total_ticks = values.iter().copied().sum();

    Ok(CpuSample {
        idle_ticks,
        total_ticks,
        process_ticks: read_process_cpu_ticks()?,
    })
}

fn read_process_cpu_ticks() -> Result<u64, ApiError> {
    let stat = std::fs::read_to_string("/proc/self/stat")
        .map_err(|error| ApiError::internal(format!("failed to read /proc/self/stat: {error}")))?;
    let after_comm = stat
        .rsplit_once(") ")
        .map(|(_, rest)| rest)
        .ok_or_else(|| ApiError::internal("failed to parse /proc/self/stat command field"))?;
    let fields = after_comm.split_whitespace().collect::<Vec<_>>();
    let utime = fields
        .get(11)
        .ok_or_else(|| ApiError::internal("/proc/self/stat is missing utime"))?
        .parse::<u64>()
        .map_err(|error| ApiError::internal(format!("failed to parse process utime: {error}")))?;
    let stime = fields
        .get(12)
        .ok_or_else(|| ApiError::internal("/proc/self/stat is missing stime"))?
        .parse::<u64>()
        .map_err(|error| ApiError::internal(format!("failed to parse process stime: {error}")))?;
    Ok(utime.saturating_add(stime))
}

fn read_memory_mb() -> Result<(f64, f64), ApiError> {
    let meminfo = std::fs::read_to_string("/proc/meminfo")
        .map_err(|error| ApiError::internal(format!("failed to read /proc/meminfo: {error}")))?;
    let total_kb = read_meminfo_kb(&meminfo, "MemTotal")
        .ok_or_else(|| ApiError::internal("/proc/meminfo is missing MemTotal"))?;
    let available_kb = read_meminfo_kb(&meminfo, "MemAvailable")
        .ok_or_else(|| ApiError::internal("/proc/meminfo is missing MemAvailable"))?;
    let used_kb = total_kb.saturating_sub(available_kb);
    Ok((kb_to_mb(total_kb), kb_to_mb(used_kb)))
}

fn read_meminfo_kb(meminfo: &str, key: &str) -> Option<u64> {
    meminfo.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name == key).then(|| {
            value
                .split_whitespace()
                .next()
                .and_then(|token| token.parse::<u64>().ok())
        })?
    })
}

fn read_process_status() -> Result<(f64, u32), ApiError> {
    let status = std::fs::read_to_string("/proc/self/status").map_err(|error| {
        ApiError::internal(format!("failed to read /proc/self/status: {error}"))
    })?;
    let rss_kb = read_status_kb(&status, "VmRSS").unwrap_or(0);
    let process_threads = status
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name == "Threads").then(|| {
                value
                    .split_whitespace()
                    .next()
                    .and_then(|token| token.parse::<u32>().ok())
            })?
        })
        .unwrap_or(0);
    Ok((kb_to_mb(rss_kb), process_threads))
}

fn read_status_kb(status: &str, key: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name == key).then(|| {
            value
                .split_whitespace()
                .next()
                .and_then(|token| token.parse::<u64>().ok())
        })?
    })
}

fn read_load_average() -> (Option<f64>, Option<f64>, Option<f64>) {
    let Ok(loadavg) = std::fs::read_to_string("/proc/loadavg") else {
        return (None, None, None);
    };
    let mut parts = loadavg.split_whitespace();
    (
        parts.next().and_then(|value| value.parse::<f64>().ok()),
        parts.next().and_then(|value| value.parse::<f64>().ok()),
        parts.next().and_then(|value| value.parse::<f64>().ok()),
    )
}

fn read_cpu_model_name() -> Option<String> {
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    for key in ["model name", "Hardware", "Processor"] {
        if let Some(value) = cpuinfo.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            (name.trim() == key).then(|| value.trim().to_string())
        }) {
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

fn kb_to_mb(value: u64) -> f64 {
    value as f64 / 1024.0
}

async fn mark_command_dispatched(state: &Arc<AppState>, command: &SessionCommand) {
    let mut ledger = state.current_command_ledger.lock().await;
    if let Some(record) = ledger
        .iter_mut()
        .find(|record| record.command.command_id == command.command_id)
    {
        record.status = crate::types::CommandLifecycleState::Dispatched;
        record.dispatched_at_unix_ms = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or(0),
        );
        record.completed_at_unix_ms = None;
        record.completion_status = None;
    }
}

async fn take_next_current_control_command_after(
    state: &Arc<AppState>,
    after_seq: u64,
) -> Option<SessionCommand> {
    let mut stale = Vec::new();
    let selected = {
        let mut queue = state.current_control_queue.lock().await;
        let index = 0usize;
        let mut selected = None;
        while index < queue.len() {
            let Some(command) = queue.get(index) else {
                break;
            };
            if command.seq <= after_seq {
                if let Some(removed) = queue.remove(index) {
                    stale.push(removed);
                }
                continue;
            }
            selected = queue.remove(index);
            break;
        }
        selected
    };

    for command in &stale {
        mark_command_dispatched(state, command).await;
    }
    if let Some(command) = &selected {
        mark_command_dispatched(state, command).await;
    }
    selected
}

async fn sync_current_live_snapshot(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CurrentLiveSnapshotRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let has_live_state_update = req.live_state.is_some();
    let has_scalar_row_update = req.latest_scalar_row.is_some();
    let has_latest_fields_update = req.latest_fields.is_some();
    let allow_previous_preview_fallback = !req.clear_preview_cache;
    let preview_fields = req.preview_fields.clone();
    let clear_preview_cache = req.clear_preview_cache;
    let session_id = req.session_id.clone();
    sync_current_live_frame_update(
        &state,
        CurrentLiveSyncKind::Snapshot,
        &session_id,
        allow_previous_preview_fallback,
        has_live_state_update,
        has_scalar_row_update,
        has_latest_fields_update,
        preview_fields,
        clear_preview_cache,
        move |next| apply_current_live_snapshot(next, req),
    )
    .await
}

async fn sync_current_live_session_frame(
    State(state): State<Arc<AppState>>,
    Json(frame): Json<CurrentLiveSessionFrameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session_id = frame.session_id.clone();
    sync_current_live_frame_update(
        &state,
        CurrentLiveSyncKind::Session,
        &session_id,
        true,
        false,
        false,
        false,
        None,
        false,
        move |next| apply_current_live_session_frame(next, frame),
    )
    .await
}

async fn sync_current_live_runtime_frame(
    State(state): State<Arc<AppState>>,
    Json(frame): Json<CurrentLiveRuntimeFrameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session_id = frame.session_id.clone();
    sync_current_live_frame_update(
        &state,
        CurrentLiveSyncKind::Runtime,
        &session_id,
        true,
        true,
        false,
        false,
        None,
        false,
        move |next| apply_current_live_runtime_frame(next, frame),
    )
    .await
}

async fn sync_current_live_scalar_frame(
    State(state): State<Arc<AppState>>,
    Json(frame): Json<CurrentLiveScalarFrameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session_id = frame.session_id.clone();
    sync_current_live_frame_update(
        &state,
        CurrentLiveSyncKind::Scalars,
        &session_id,
        true,
        false,
        true,
        false,
        None,
        false,
        move |next| apply_current_live_scalar_frame(next, frame),
    )
    .await
}

async fn sync_current_live_field_frame(
    State(state): State<Arc<AppState>>,
    Json(frame): Json<CurrentLiveFieldFrameRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let session_id = frame.session_id.clone();
    let preview_fields = frame.preview_fields.clone();
    let clear_preview_cache = frame.clear_preview_cache;
    let has_latest_fields_update = frame.latest_fields.is_some();
    sync_current_live_frame_update(
        &state,
        CurrentLiveSyncKind::Fields,
        &session_id,
        !clear_preview_cache,
        false,
        false,
        has_latest_fields_update,
        preview_fields,
        clear_preview_cache,
        move |next| apply_current_live_field_frame(next, frame),
    )
    .await
}

#[derive(Debug, Clone, Copy)]
enum CurrentLiveSyncKind {
    Snapshot,
    Session,
    Runtime,
    Scalars,
    Fields,
}

impl CurrentLiveSyncKind {
    fn label(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::Session => "session",
            Self::Runtime => "runtime",
            Self::Scalars => "scalars",
            Self::Fields => "fields",
        }
    }
}

async fn sync_current_live_frame_update<F>(
    state: &Arc<AppState>,
    kind: CurrentLiveSyncKind,
    session_id: &str,
    allow_previous_preview_fallback: bool,
    has_live_state_update: bool,
    has_scalar_row_update: bool,
    has_latest_fields_update: bool,
    preview_fields: Option<Vec<LivePreviewField>>,
    clear_preview_cache: bool,
    apply: F,
) -> Result<Json<serde_json::Value>, ApiError>
where
    F: FnOnce(&mut SessionStateResponse) -> Result<(), ApiError>,
{
    let sync_start = std::time::Instant::now();
    let reset_preview = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|existing| existing.session.session_id != session_id)
        .unwrap_or(false);
    if reset_preview {
        let display_selection = CurrentDisplaySelection::default();
        *state.current_display_selection.write().await = display_selection.clone();
        state.current_control_queue.lock().await.clear();
        state.current_command_responses.lock().await.clear();
        state.current_command_ledger.lock().await.clear();
        *state.current_control_next_seq.lock().await = 0;
        let _ = state.current_control_events.send(0);
        let _ = std::fs::remove_dir_all(&state.current_workspace_root);
    }
    let display_selection = state.current_display_selection.read().await.clone();
    let selected_cached_display_fields_match_selection = preview_fields
        .as_ref()
        .is_some_and(|fields| cached_display_fields_match_selection(fields, &display_selection));
    let has_cached_display_fields =
        clear_preview_cache || selected_cached_display_fields_match_selection;
    let preview_config = display_selection.preview_request();
    let mut current = state.current_live_state.write().await;
    let (mut next, previous_snapshot) = match current.take() {
        Some(existing) if existing.session.session_id == session_id => {
            let previous_snapshot = existing.clone();
            (existing, Some(previous_snapshot))
        }
        _ => (
            default_current_live_state(&CurrentLiveSnapshotRequest {
                session_id: session_id.to_string(),
                session: None,
                session_status: None,
                metadata: None,
                mesh_workspace: None,
                stage_execution: None,
                run: None,
                live_state: None,
                latest_scalar_row: None,
                latest_fields: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh: None,
            }),
            None,
        ),
    };
    let previous_preview = next.preview.clone();
    let previous_revisions = match previous_snapshot.as_ref() {
        Some(snapshot) => Some(
            current_live_realtime_state_from_snapshot(&state, snapshot, display_selection.revision)
                .await
                .revisions,
        ),
        None => None,
    };
    let apply_start = std::time::Instant::now();
    apply(&mut next)?;
    let apply_ms = apply_start.elapsed().as_micros();
    next.display_selection = display_selection.clone();
    next.preview_config = preview_config.clone();
    if next.scene_document.is_none() && !next.session.script_path.trim().is_empty() {
        match load_scene_document_state(
            &state.repo_root,
            &state.current_workspace_root,
            Path::new(next.session.script_path.trim()),
        ) {
            Ok(mut scene_document) => {
                normalize_scene_document_magnetization_assets(&mut scene_document);
                next.builder_adapter = scene_document_builder_projection(&scene_document).ok();
                next.scene_document = Some(scene_document);
            }
            Err(e) => {
                eprintln!(
                    "[fullmag-api] failed to load scene document for '{}': {:?}",
                    next.session.script_path.trim(),
                    e
                );
            }
        }
    }
    let has_fresh_preview = live_state_has_fresh_preview(next.live_state.as_ref());
    let should_rebuild_preview = !state.feature_flags.disable_preview_3d
        && (has_fresh_preview
            || has_latest_fields_update
            || has_cached_display_fields
            || (matches!(
                next.display_selection.selection.kind,
                fullmag_runner::DisplayKind::GlobalScalar
            ) && (has_live_state_update || has_scalar_row_update)));
    let preview_start = std::time::Instant::now();
    next.preview = if should_rebuild_preview {
        let rebuilt = build_preview_state(&next, &next.display_selection, &preview_config);
        if allow_previous_preview_fallback {
            rebuilt.or(previous_preview)
        } else {
            rebuilt
        }
    } else {
        previous_preview
    };
    let preview_ms = preview_start.elapsed().as_micros();
    next.state_version = next.state_version.wrapping_add(1);
    let current_state_version = next.state_version;
    let command_completed_at_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    {
        let mut ledger = state.current_command_ledger.lock().await;
        reconcile_command_ledger_from_stage_execution(
            &mut ledger,
            &next,
            command_completed_at_unix_ms,
        );
        reconcile_dispatched_command_ledger_from_snapshot(
            &mut ledger,
            &next,
            command_completed_at_unix_ms,
        );
    }
    let (preview_source_step, preview_vector_len, preview_vector_avg) =
        preview_debug_metrics(next.preview.as_ref());
    let live_mag_len = next
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .map(|values| values.len())
        .unwrap_or(0);
    let live_mag_avg = next
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
        .and_then(|values| average_vector_components(values, 3));
    eprintln!(
        "[fullmag-api] sync -> live {} version={} session={} run={} step={} scalar_rows={} live_mag_len={} live_mag_avg={} preview={} preview_step={} preview_vec_len={} preview_vec_avg={} fields={} realtime_subscribers={}",
        kind.label(),
        current_state_version,
        next.session.session_id,
        next.run.as_ref().map(|run| run.run_id.as_str()).unwrap_or("-"),
        next
            .live_state
            .as_ref()
            .map(|state| state.latest_step.step)
            .unwrap_or(0),
        next.scalar_rows.len(),
        live_mag_len,
        format_debug_vector_average(live_mag_avg),
        next.preview.is_some(),
        preview_source_step,
        preview_vector_len,
        format_debug_vector_average(preview_vector_avg),
        next.latest_fields.len(),
        state.current_live_realtime_events.receiver_count(),
    );
    let realtime_state =
        current_live_realtime_state_from_snapshot(&state, &next, display_selection.revision).await;
    *current = Some(next);
    drop(current);

    publish_current_live_realtime_batch_changed_since(
        &state,
        &realtime_state,
        previous_revisions.as_ref(),
        true,
        CURRENT_LIVE_REALTIME_COALESCE_WINDOW_MS,
    )
    .await?;

    let sync_elapsed_us = sync_start.elapsed().as_micros();
    if sync_elapsed_us > 50_000 {
        eprintln!(
            "[fullmag-api] PERF: internal live {} sync took {:.1}ms (apply={:.1}ms preview={:.1}ms)",
            kind.label(),
            sync_elapsed_us as f64 / 1000.0,
            apply_ms as f64 / 1000.0,
            preview_ms as f64 / 1000.0,
        );
    }

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[allow(dead_code)]
async fn dequeue_current_live_command(
    State(state): State<Arc<AppState>>,
) -> Result<Response, ApiError> {
    let command = take_next_current_control_command_after(&state, 0).await;
    match command {
        Some(command) => Ok(Json(command).into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn wait_current_live_control(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ControlWaitQuery>,
) -> Result<Response, ApiError> {
    let _ = current_live_session_id(&state).await?;
    if let Some(command) = take_next_current_control_command_after(&state, query.after_seq).await {
        return Ok(Json(command).into_response());
    }

    let timeout_ms = query.timeout_ms.clamp(100, 20_000);
    let mut rx = state.current_control_events.subscribe();
    let state_for_wait = Arc::clone(&state);
    let waited = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), async move {
        loop {
            rx.changed()
                .await
                .map_err(|_| ApiError::internal("control command stream closed"))?;
            if let Some(command) =
                take_next_current_control_command_after(&state_for_wait, query.after_seq).await
            {
                return Ok::<SessionCommand, ApiError>(command);
            }
        }
    })
    .await;

    match waited {
        Ok(Ok(command)) => Ok(Json(command).into_response()),
        Ok(Err(error)) => Err(error),
        Err(_) => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[allow(dead_code)]
async fn read_current_live_artifact(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ArtifactFileQuery>,
) -> Result<Response, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    drop(current);

    let relative = sanitize_artifact_relative_path(&query.path)?;
    let artifact_path = artifact_dir.join(&relative);
    if !artifact_path.exists() || !artifact_path.is_file() {
        return Err(ApiError::not_found(format!(
            "artifact '{}' was not found",
            query.path
        )));
    }

    let content_type = match artifact_path.extension().and_then(|ext| ext.to_str()) {
        Some("json") => "application/json; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    let bytes = std::fs::read(&artifact_path)
        .map_err(|error| ApiError::internal(format!("failed to read artifact: {}", error)))?;
    Ok(([(CONTENT_TYPE, content_type)], bytes).into_response())
}

async fn build_current_live_realtime_hello_event(
    state: &AppState,
) -> Result<LiveRealtimeServerEvent, ApiError> {
    let snapshot = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        current_live_realtime_state_from_snapshot(state, &snapshot, display_revision).await;
    let replay = state.current_live_realtime_replay.lock().await;
    let current_seq = state.current_live_realtime_next_seq.load(Ordering::Relaxed);
    let replay_available_after_seq =
        current_live_realtime_available_after_seq(&replay, current_seq);
    Ok(LiveRealtimeServerEvent::Hello {
        seq: current_seq,
        ts: realtime_timestamp_now(),
        session_id: realtime_state.session_id.clone(),
        run_id: realtime_state.run_id.clone(),
        contract_version: current_live_realtime_contract_version().to_string(),
        payload: HelloPayload {
            server_time: realtime_timestamp_now(),
            replay_available_after_seq,
            current_seq,
            resource_revisions: realtime_state.revisions,
        },
    })
}

async fn build_current_live_realtime_resync_event(
    state: &AppState,
    session_id: String,
    run_id: Option<String>,
    expected_after: Option<u64>,
    reason: &str,
) -> LiveRealtimeServerEvent {
    let replay = state.current_live_realtime_replay.lock().await;
    let current_seq = state.current_live_realtime_next_seq.load(Ordering::Relaxed);
    let replay_available_after_seq =
        current_live_realtime_available_after_seq(&replay, current_seq);
    LiveRealtimeServerEvent::ResyncRequired {
        seq: current_seq,
        ts: realtime_timestamp_now(),
        session_id,
        run_id,
        contract_version: current_live_realtime_contract_version().to_string(),
        payload: ResyncRequiredPayload {
            reason: reason.to_string(),
            expected_after,
            replay_available_after_seq,
        },
    }
}

fn encode_current_live_realtime_event(event: &LiveRealtimeServerEvent) -> Result<String, ApiError> {
    serde_json::to_string(event).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize realtime websocket event: {error}"
        ))
    })
}

async fn send_current_live_realtime_record(
    socket: &mut WebSocket,
    event: CurrentLiveRealtimeEvent,
    last_sent_seq: &mut u64,
) -> bool {
    if event.seq <= *last_sent_seq {
        return true;
    }
    if socket.send(Message::Text(event.json.into())).await.is_err() {
        return false;
    }
    *last_sent_seq = event.seq;
    true
}

async fn flush_pending_current_live_realtime_record(
    socket: &mut WebSocket,
    pending_event: &mut Option<CurrentLiveRealtimeEvent>,
    last_sent_seq: &mut u64,
) -> bool {
    let Some(event) = pending_event.take() else {
        return true;
    };
    send_current_live_realtime_record(socket, event, last_sent_seq).await
}

pub(crate) async fn handle_current_live_realtime_ws(
    mut socket: WebSocket,
    state: Arc<AppState>,
    after_seq: u64,
) {
    let mut rx = state.current_live_realtime_events.subscribe();
    let hello = match build_current_live_realtime_hello_event(&state).await {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!("failed to build realtime hello event: {:?}", error);
            return;
        }
    };
    let (session_id, run_id, replay_available_after_seq) = match &hello {
        LiveRealtimeServerEvent::Hello {
            session_id,
            run_id,
            payload,
            ..
        } => (
            session_id.clone(),
            run_id.clone(),
            payload.replay_available_after_seq,
        ),
        _ => return,
    };
    let hello_json = match encode_current_live_realtime_event(&hello) {
        Ok(json) => json,
        Err(error) => {
            tracing::warn!("failed to encode realtime hello event: {:?}", error);
            return;
        }
    };
    if socket.send(Message::Text(hello_json.into())).await.is_err() {
        return;
    }

    let mut last_sent_seq = after_seq;
    if after_seq > 0 && after_seq < replay_available_after_seq {
        let resync = build_current_live_realtime_resync_event(
            &state,
            session_id.clone(),
            run_id.clone(),
            Some(after_seq),
            "sequence_gap",
        )
        .await;
        match encode_current_live_realtime_event(&resync) {
            Ok(json) => {
                if socket.send(Message::Text(json.into())).await.is_err() {
                    return;
                }
            }
            Err(error) => {
                tracing::warn!("failed to encode realtime resync event: {:?}", error);
                return;
            }
        }
    } else if after_seq > 0 {
        let replay_events = {
            let replay = state.current_live_realtime_replay.lock().await;
            replay
                .iter()
                .filter(|event| event.seq > after_seq)
                .cloned()
                .collect::<Vec<_>>()
        };
        for event in replay_events {
            if !send_current_live_realtime_record(&mut socket, event, &mut last_sent_seq).await {
                return;
            }
        }
    }

    let mut heartbeat = interval(Duration::from_secs(CURRENT_LIVE_REALTIME_HEARTBEAT_SECS));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pending_event: Option<CurrentLiveRealtimeEvent> = None;
    let mut coalesce_deadline: Option<Instant> = None;

    loop {
        tokio::select! {
            _ = async {
                if let Some(deadline) = coalesce_deadline {
                    sleep_until(deadline).await;
                }
            }, if coalesce_deadline.is_some() => {
                coalesce_deadline = None;
                if !flush_pending_current_live_realtime_record(
                    &mut socket,
                    &mut pending_event,
                    &mut last_sent_seq,
                ).await {
                    break;
                }
            }
            result = rx.recv() => {
                match result {
                    Ok(event) => {
                        if event.seq <= last_sent_seq {
                            continue;
                        }
                        if let Some(window_ms) = event.coalesce_window_ms {
                            if pending_event.is_none() {
                                coalesce_deadline = Some(
                                    Instant::now() + Duration::from_millis(u64::from(window_ms)),
                                );
                            }
                            pending_event = Some(event);
                        } else {
                            coalesce_deadline = None;
                            if !flush_pending_current_live_realtime_record(
                                &mut socket,
                                &mut pending_event,
                                &mut last_sent_seq,
                            ).await {
                                break;
                            }
                            if !send_current_live_realtime_record(
                                &mut socket,
                                event,
                                &mut last_sent_seq,
                            ).await {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        coalesce_deadline = None;
                        if !flush_pending_current_live_realtime_record(
                            &mut socket,
                            &mut pending_event,
                            &mut last_sent_seq,
                        ).await {
                            break;
                        }
                        let resync = build_current_live_realtime_resync_event(
                            &state,
                            session_id.clone(),
                            run_id.clone(),
                            Some(last_sent_seq),
                            "sequence_gap",
                        ).await;
                        match encode_current_live_realtime_event(&resync) {
                            Ok(json) => {
                                if socket.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(error) => {
                                tracing::warn!("failed to encode realtime lag resync event: {:?}", error);
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = heartbeat.tick() => {
                coalesce_deadline = None;
                if !flush_pending_current_live_realtime_record(
                    &mut socket,
                    &mut pending_event,
                    &mut last_sent_seq,
                ).await {
                    break;
                }
                let heartbeat_event = LiveRealtimeServerEvent::Heartbeat {
                    seq: state.current_live_realtime_next_seq.load(Ordering::Relaxed),
                    ts: realtime_timestamp_now(),
                    session_id: session_id.clone(),
                    run_id: run_id.clone(),
                    contract_version: current_live_realtime_contract_version().to_string(),
                    payload: HeartbeatPayload {
                        current_seq: state.current_live_realtime_next_seq.load(Ordering::Relaxed),
                    },
                };
                match encode_current_live_realtime_event(&heartbeat_event) {
                    Ok(json) => {
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::warn!("failed to encode realtime heartbeat event: {:?}", error);
                        break;
                    }
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

pub(crate) async fn import_asset_for_current_workspace(
    state: &Arc<AppState>,
    req: ImportSessionAssetRequest,
) -> Result<SessionAssetImportResponse, ApiError> {
    let (session_id, imports_dir) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        let session_id = snapshot.session.session_id.clone();
        let artifact_dir = current_artifact_dir(snapshot)
            .unwrap_or_else(|| state.current_workspace_root.join("artifacts"));
        (session_id, artifact_dir.join("imports"))
    };

    let response = import_asset_into_dir(state, &session_id, imports_dir.clone(), req)?;
    let artifacts = read_artifacts_from_dir(imports_dir.parent())?;
    let realtime_state = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        snapshot.artifacts = artifacts;
        current_live_realtime_state_from_snapshot(
            state,
            snapshot,
            snapshot.display_selection.revision,
        )
        .await
    };
    publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await?;
    Ok(response)
}

fn import_asset_into_dir(
    state: &AppState,
    session_id: &str,
    imports_dir: PathBuf,
    req: ImportSessionAssetRequest,
) -> Result<SessionAssetImportResponse, ApiError> {
    let safe_file_name = sanitize_file_name(&req.file_name);
    if safe_file_name.is_empty() {
        return Err(ApiError::bad_request("file_name must not be empty"));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&req.content_base64)
        .map_err(|error| ApiError::bad_request(format!("invalid base64 payload: {}", error)))?;

    std::fs::create_dir_all(&imports_dir)?;

    let asset_id = format!("asset-{}", uuid_v4_hex());
    let stored_name = format!("{}-{}", asset_id, safe_file_name);
    let stored_path = imports_dir.join(&stored_name);
    std::fs::write(&stored_path, &bytes)?;

    let summary = summarize_uploaded_asset(&safe_file_name, &bytes)?;
    let response = SessionAssetImportResponse {
        asset_id: asset_id.clone(),
        session_id: session_id.to_string(),
        stored_path: make_repo_relative(&state.repo_root, &stored_path),
        target_realization: req.target_realization,
        summary,
    };

    let manifest_path = imports_dir.join(format!("{}.asset.json", asset_id));
    let manifest_text = serde_json::to_string_pretty(&response).map_err(|error| {
        ApiError::internal(format!("failed to serialize asset manifest: {}", error))
    })?;
    std::fs::write(manifest_path, manifest_text)?;

    Ok(response)
}

#[allow(dead_code)]
async fn sync_current_live_script(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScriptSyncRequest>,
) -> Result<Json<ScriptSyncResponse>, ApiError> {
    crate::script::sync_current_live_script_with_request(&state, req)
        .await
        .map(Json)
}

pub(crate) async fn get_or_load_current_live_scene_document(
    state: &Arc<AppState>,
) -> Result<SceneDocument, ApiError> {
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    if snapshot.scene_document.is_none() && !snapshot.session.script_path.trim().is_empty() {
        let mut current_scene = load_scene_document_state(
            &state.repo_root,
            &state.current_workspace_root,
            Path::new(snapshot.session.script_path.trim()),
        )?;
        normalize_scene_document_magnetization_assets(&mut current_scene);
        snapshot.builder_adapter = scene_document_builder_projection(&current_scene).ok();
        snapshot.scene_document = Some(current_scene);
    }
    snapshot
        .scene_document
        .clone()
        .ok_or_else(|| ApiError::not_found("no scene document available for current workspace"))
}

pub(crate) async fn commit_current_live_scene_document(
    state: &Arc<AppState>,
    mut scene_document: SceneDocument,
) -> Result<SceneDocument, ApiError> {
    normalize_scene_document_magnetization_assets(&mut scene_document);
    let preset_texture_count = scene_document
        .magnetization_assets
        .iter()
        .filter(|asset| asset.kind == "preset_texture")
        .count();
    eprintln!(
        "[fullmag-api] RX <- frontend scene rev={} objects={} magnetization_assets={} preset_texture_assets={}",
        scene_document.revision,
        scene_document.objects.len(),
        scene_document.magnetization_assets.len(),
        preset_texture_count
    );
    info!(
        target: "fullmag_api::scene_sync",
        direction = "rx",
        revision = scene_document.revision,
        version = %scene_document.version,
        objects = scene_document.objects.len(),
        magnetization_assets = scene_document.magnetization_assets.len(),
        summary = %scene_magnetization_summary(&scene_document),
        "frontend scene update received"
    );
    let (scene_document, realtime_state, preset_texture_change_logs, live_rebuild_stats) = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        if snapshot.scene_document.is_none() && !snapshot.session.script_path.trim().is_empty() {
            let mut current_scene = load_scene_document_state(
                &state.repo_root,
                &state.current_workspace_root,
                Path::new(snapshot.session.script_path.trim()),
            )?;
            normalize_scene_document_magnetization_assets(&mut current_scene);
            snapshot.builder_adapter = scene_document_builder_projection(&current_scene).ok();
            snapshot.scene_document = Some(current_scene);
        }
        let previous_scene = snapshot.scene_document.clone();
        let previous_mesh_signature = previous_scene.as_ref().map(scene_mesh_signature);
        let next_revision = snapshot
            .scene_document
            .as_ref()
            .map(|current_scene| current_scene.revision.saturating_add(1))
            .unwrap_or_else(|| scene_document.revision.saturating_add(1));
        scene_document.version = "scene.v1".to_string();
        scene_document.revision = next_revision;
        let builder_state = match scene_document_builder_projection(&scene_document) {
            Ok(state) => state,
            Err(err) => {
                info!(
                    target: "fullmag_api::scene_sync",
                    direction = "reject",
                    revision = scene_document.revision,
                    summary = %scene_magnetization_summary(&scene_document),
                    error = %err.message,
                    "frontend scene update rejected"
                );
                return Err(err);
            }
        };
        snapshot.builder_adapter = Some(builder_state);
        let next_mesh_signature = scene_mesh_signature(&scene_document);
        snapshot.scene_document = Some(scene_document.clone());
        let allow_live_magnetization_rebuild = snapshot
            .live_state
            .as_ref()
            .map(|live_state| {
                !matches!(
                    live_state.status.as_str(),
                    "running" | "materializing_script"
                )
            })
            .unwrap_or(true);
        let live_rebuild_stats = if allow_live_magnetization_rebuild {
            rebuild_live_scene_magnetization(snapshot)
        } else {
            None
        };
        let previous_preview = snapshot.preview.clone();
        snapshot.preview = build_preview_state(
            snapshot,
            &snapshot.display_selection,
            &snapshot.preview_config,
        )
        .or(previous_preview);
        // Polling clients gate updates on `state_version`, so scene-authoring
        // changes must advance it just like solver publishes do.
        snapshot.state_version = snapshot.state_version.wrapping_add(1);
        if previous_mesh_signature.as_ref() != Some(&next_mesh_signature) {
            snapshot.mesh_revision = snapshot.mesh_revision.wrapping_add(1).max(1);
            snapshot.mesh_build_revision = snapshot.mesh_build_revision.wrapping_add(1).max(1);
        }
        let realtime_state = current_live_realtime_state_from_snapshot(
            state,
            snapshot,
            snapshot.display_selection.revision,
        )
        .await;
        let preset_texture_change_logs =
            detect_preset_texture_changes(previous_scene.as_ref(), &scene_document);
        (
            scene_document,
            realtime_state,
            preset_texture_change_logs,
            live_rebuild_stats,
        )
    };

    publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await?;
    eprintln!(
        "[fullmag-api] TX -> frontend scene rev={} preset_texture_assets={} status=committed",
        scene_document.revision,
        scene_document
            .magnetization_assets
            .iter()
            .filter(|asset| asset.kind == "preset_texture")
            .count()
    );
    for line in &preset_texture_change_logs {
        eprintln!("[fullmag-api][mag-texture] {}", line);
    }
    if let Some(stats) = live_rebuild_stats {
        eprintln!(
            "[fullmag-api][mag-texture] LIVE_REBUILD mesh_nodes={} magnetic_nodes={} rewritten_nodes={} rewritten_objects={} skipped_objects={} warnings={}",
            stats.mesh_nodes,
            stats.magnetic_nodes,
            stats.rewritten_nodes,
            stats.rewritten_objects,
            stats.skipped_objects,
            stats.warnings.len()
        );
        for warning in stats.warnings {
            eprintln!("[fullmag-api][mag-texture] LIVE_REBUILD_WARN {}", warning);
        }
    }
    info!(
        target: "fullmag_api::scene_sync",
        direction = "tx",
        revision = scene_document.revision,
        summary = %scene_magnetization_summary(&scene_document),
        "frontend scene update committed"
    );
    Ok(scene_document)
}

#[derive(Debug, Clone, Default)]
struct LiveSceneMagnetizationRebuildStats {
    mesh_nodes: usize,
    magnetic_nodes: usize,
    rewritten_nodes: usize,
    rewritten_objects: usize,
    skipped_objects: usize,
    warnings: Vec<String>,
}

fn rebuild_live_scene_magnetization(
    snapshot: &mut SessionStateResponse,
) -> Option<LiveSceneMagnetizationRebuildStats> {
    let scene = snapshot.scene_document.as_ref()?;
    let mesh = snapshot.fem_mesh.as_ref()?;
    let node_count = mesh.nodes.len();
    if node_count == 0 {
        return Some(LiveSceneMagnetizationRebuildStats::default());
    }

    let mut stats = LiveSceneMagnetizationRebuildStats {
        mesh_nodes: node_count,
        ..LiveSceneMagnetizationRebuildStats::default()
    };

    let mut vectors = existing_live_magnetization_vectors(snapshot, node_count)
        .unwrap_or_else(|| vec![[0.0, 0.0, 0.0]; node_count]);
    if vectors.len() != node_count {
        vectors = vec![[0.0, 0.0, 0.0]; node_count];
    }

    let object_index = scene
        .objects
        .iter()
        .enumerate()
        .flat_map(|(index, object)| {
            let mut keys = vec![(object.id.clone(), index)];
            if !object.name.trim().is_empty() {
                keys.push((object.name.clone(), index));
            }
            keys
        })
        .collect::<HashMap<_, _>>();
    let get_owner_fallback = |id: &str| {
        object_index.get(id).copied().or_else(|| {
            if id.ends_with("_geom") {
                object_index.get(&id[..id.len() - 5]).copied()
            } else {
                object_index.get(&format!("{}_geom", id)).copied()
            }
        })
    };

    let mut node_owner: Vec<Option<usize>> = vec![None; node_count];

    for part in &mesh.mesh_parts {
        if part.role != "magnetic_object" {
            continue;
        }
        let Some(owner_id) = part
            .object_id
            .as_ref()
            .or(part.geometry_id.as_ref())
            .map(String::as_str)
        else {
            continue;
        };
        let Some(owner_index) = get_owner_fallback(owner_id) else {
            continue;
        };
        if !part.node_indices.is_empty() {
            for &node in &part.node_indices {
                let node = node as usize;
                if node < node_count && node_owner[node].is_none() {
                    node_owner[node] = Some(owner_index);
                }
            }
        } else {
            let start = part.node_start as usize;
            let end = start
                .saturating_add(part.node_count as usize)
                .min(node_count);
            for slot in node_owner.iter_mut().take(end).skip(start) {
                if slot.is_none() {
                    *slot = Some(owner_index);
                }
            }
        }
    }

    for segment in &mesh.object_segments {
        if segment.object_id == "__air__" {
            continue;
        }
        let seg_id = segment.object_id.as_str();
        let Some(owner_index) = get_owner_fallback(seg_id) else {
            continue;
        };
        let start = segment.node_start as usize;
        let end = start
            .saturating_add(segment.node_count as usize)
            .min(node_count);
        for slot in node_owner.iter_mut().take(end).skip(start) {
            if slot.is_none() {
                *slot = Some(owner_index);
            }
        }
        let element_start = segment.element_start as usize;
        let element_end = element_start
            .saturating_add(segment.element_count as usize)
            .min(mesh.elements.len());
        for element in &mesh.elements[element_start..element_end] {
            for node in element {
                let node = *node as usize;
                if node < node_count && node_owner[node].is_none() {
                    node_owner[node] = Some(owner_index);
                }
            }
        }
    }

    let mut nodes_by_object = vec![Vec::<usize>::new(); scene.objects.len()];
    for (node_index, owner) in node_owner.iter().enumerate() {
        if let Some(owner) = owner {
            nodes_by_object[*owner].push(node_index);
        }
    }
    stats.magnetic_nodes = nodes_by_object.iter().map(Vec::len).sum();

    let magnetization_assets = scene
        .magnetization_assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect::<HashMap<_, _>>();

    for (object_index, node_indices) in nodes_by_object.iter().enumerate() {
        if node_indices.is_empty() {
            continue;
        }
        let object = &scene.objects[object_index];
        let Some(magnetization_ref) = object.magnetization_ref.as_deref() else {
            stats.skipped_objects += 1;
            continue;
        };
        let Some(asset) = magnetization_assets.get(magnetization_ref).copied() else {
            stats.skipped_objects += 1;
            stats.warnings.push(format!(
                "object '{}' references missing magnetization '{}'",
                object.id, magnetization_ref
            ));
            continue;
        };
        let rewritten = apply_live_scene_magnetization_asset(
            asset,
            object,
            node_indices,
            &mesh.nodes,
            &mut vectors,
            &mut stats,
        );
        if rewritten {
            stats.rewritten_objects += 1;
        } else {
            stats.skipped_objects += 1;
        }
    }

    let flat = flatten_vectors(&vectors);
    if let Some(live_state) = snapshot.live_state.as_mut() {
        live_state.latest_step.magnetization = Some(flat);
    }

    let latest_m = json!({
        "layout": { "grid_cells": [node_count, 1, 1] },
        "values": vectors,
    });
    match serde_json::from_value::<LatestFields>(json!({ "m": latest_m })) {
        Ok(update) => {
            merge_latest_fields(&mut snapshot.latest_fields, update);
        }
        Err(error) => {
            stats.warnings.push(format!(
                "failed to serialize live magnetization field: {}",
                error
            ));
        }
    }

    let field_location = if snapshot.fem_mesh.is_some() {
        "node"
    } else {
        "cell"
    };
    snapshot.quantities = build_quantities(
        &snapshot.latest_fields,
        &snapshot.preview_cache,
        snapshot.live_state.as_ref(),
        snapshot.run.as_ref(),
        snapshot.metadata.as_ref(),
        &snapshot.scalar_rows,
        field_location,
    );

    Some(stats)
}

fn apply_live_scene_magnetization_asset(
    asset: &MagnetizationAsset,
    object: &fullmag_authoring::SceneObject,
    node_indices: &[usize],
    world_nodes: &[[f64; 3]],
    vectors: &mut [[f64; 3]],
    stats: &mut LiveSceneMagnetizationRebuildStats,
) -> bool {
    match asset.kind.as_str() {
        "preset_texture" => {
            let preset_kind = asset.preset_kind.as_deref().unwrap_or("uniform");
            let params = asset
                .preset_params
                .as_ref()
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            let mapping = TextureMappingIR {
                space: asset.mapping.space.clone(),
                projection: parse_texture_projection_mode(&asset.mapping.projection),
                clamp_mode: asset.mapping.clamp_mode.clone(),
            };
            let texture_transform = TextureTransform3DIR {
                translation: asset.texture_transform.translation,
                rotation_quat: asset.texture_transform.rotation_quat,
                scale: asset.texture_transform.scale,
                pivot: asset.texture_transform.pivot,
            };
            let sample_points = node_indices
                .iter()
                .map(|&node_index| {
                    let world = world_nodes[node_index];
                    TextureSamplePoint {
                        position_world: world,
                        position_object: apply_inverse_object_transform(world, &object.transform),
                        active: true,
                    }
                })
                .collect::<Vec<_>>();
            match sample_preset_texture(
                preset_kind,
                &params,
                &mapping,
                &texture_transform,
                &sample_points,
            ) {
                Ok(sampled) => {
                    for (slot, value) in node_indices.iter().zip(sampled.iter()) {
                        vectors[*slot] = *value;
                    }
                    stats.rewritten_nodes += node_indices.len();
                    true
                }
                Err(error) => {
                    stats.warnings.push(format!(
                        "preset_texture '{}' for object '{}' failed: {}",
                        preset_kind, object.id, error
                    ));
                    false
                }
            }
        }
        other => {
            stats.warnings.push(format!(
                "object '{}' magnetization kind '{}' is not remapped live",
                object.id, other
            ));
            false
        }
    }
}

fn existing_live_magnetization_vectors(
    snapshot: &SessionStateResponse,
    node_count: usize,
) -> Option<Vec<[f64; 3]>> {
    if let Some(flat) = snapshot
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.magnetization.as_ref())
    {
        if flat.len() == node_count * 3 {
            return Some(
                flat.chunks_exact(3)
                    .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                    .collect(),
            );
        }
    }
    snapshot
        .latest_fields
        .get("m")
        .and_then(parse_field_value)
        .and_then(|(vectors, _)| (vectors.len() == node_count).then_some(vectors))
}

fn apply_inverse_object_transform(
    point_world: [f64; 3],
    transform: &fullmag_authoring::Transform3D,
) -> [f64; 3] {
    let mut p = [
        point_world[0] - transform.translation[0] - transform.pivot[0],
        point_world[1] - transform.translation[1] - transform.pivot[1],
        point_world[2] - transform.translation[2] - transform.pivot[2],
    ];
    let mut inv_quat = [
        -transform.rotation_quat[0],
        -transform.rotation_quat[1],
        -transform.rotation_quat[2],
        transform.rotation_quat[3],
    ];
    let qn = (inv_quat[0] * inv_quat[0]
        + inv_quat[1] * inv_quat[1]
        + inv_quat[2] * inv_quat[2]
        + inv_quat[3] * inv_quat[3])
        .sqrt();
    if qn > 1.0e-30 {
        inv_quat = [
            inv_quat[0] / qn,
            inv_quat[1] / qn,
            inv_quat[2] / qn,
            inv_quat[3] / qn,
        ];
    }
    p = rotate_point_by_quat(p, inv_quat);
    p = [
        p[0] + transform.pivot[0],
        p[1] + transform.pivot[1],
        p[2] + transform.pivot[2],
    ];
    [
        p[0] / safe_scale_component(transform.scale[0]),
        p[1] / safe_scale_component(transform.scale[1]),
        p[2] / safe_scale_component(transform.scale[2]),
    ]
}

fn rotate_point_by_quat(point: [f64; 3], quat: [f64; 4]) -> [f64; 3] {
    let qvec = [quat[0], quat[1], quat[2]];
    let t = [
        2.0 * (qvec[1] * point[2] - qvec[2] * point[1]),
        2.0 * (qvec[2] * point[0] - qvec[0] * point[2]),
        2.0 * (qvec[0] * point[1] - qvec[1] * point[0]),
    ];
    [
        point[0] + quat[3] * t[0] + (qvec[1] * t[2] - qvec[2] * t[1]),
        point[1] + quat[3] * t[1] + (qvec[2] * t[0] - qvec[0] * t[2]),
        point[2] + quat[3] * t[2] + (qvec[0] * t[1] - qvec[1] * t[0]),
    ]
}

fn safe_scale_component(value: f64) -> f64 {
    if value.abs() > 1.0e-30 {
        value
    } else {
        1.0
    }
}

fn scene_magnetization_summary(scene: &SceneDocument) -> String {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut interesting = Vec::new();
    for asset in &scene.magnetization_assets {
        *counts.entry(asset.kind.clone()).or_insert(0) += 1;
        if asset.kind == "preset_texture" {
            let preset_param_keys = asset
                .preset_params
                .as_ref()
                .and_then(|value| value.as_object())
                .map(|map| map.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            interesting.push(format!(
                "{}:{}:{}:{:?}",
                asset.id,
                asset.kind,
                asset
                    .preset_kind
                    .as_ref()
                    .map(String::as_str)
                    .unwrap_or("-"),
                preset_param_keys
            ));
        }
    }
    format!("counts={counts:?}; assets={interesting:?}")
}

fn linked_objects_for_magnetization_asset(scene: &SceneDocument, asset_id: &str) -> Vec<String> {
    scene
        .objects
        .iter()
        .filter(|object| object.magnetization_ref.as_deref() == Some(asset_id))
        .map(|object| object.name.clone())
        .collect()
}

fn fmt_vec3_nm(vec: [f64; 3]) -> String {
    format!(
        "[{:+.3}, {:+.3}, {:+.3}]nm",
        vec[0] * 1.0e9,
        vec[1] * 1.0e9,
        vec[2] * 1.0e9
    )
}

fn fmt_quat4(quat: [f64; 4]) -> String {
    format!(
        "[{:+.6}, {:+.6}, {:+.6}, {:+.6}]",
        quat[0], quat[1], quat[2], quat[3]
    )
}

fn vec3_delta(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
}

fn vec3_changed(a: [f64; 3], b: [f64; 3]) -> bool {
    const EPS: f64 = 1.0e-21;
    (a[0] - b[0]).abs() > EPS || (a[1] - b[1]).abs() > EPS || (a[2] - b[2]).abs() > EPS
}

fn quat_changed(a: [f64; 4], b: [f64; 4]) -> bool {
    const EPS: f64 = 1.0e-21;
    (a[0] - b[0]).abs() > EPS
        || (a[1] - b[1]).abs() > EPS
        || (a[2] - b[2]).abs() > EPS
        || (a[3] - b[3]).abs() > EPS
}
fn fmt_preset_params(params: Option<&Value>) -> String {
    let Some(params) = params else {
        return "<none>".to_string();
    };
    let Some(map) = params.as_object() else {
        return "<non-object>".to_string();
    };
    match serde_json::to_string(map) {
        Ok(raw) => {
            const MAX: usize = 220;
            if raw.len() <= MAX {
                raw
            } else {
                format!("{}…", &raw[..MAX])
            }
        }
        Err(_) => "<invalid-json>".to_string(),
    }
}

fn detect_preset_texture_changes(
    previous: Option<&SceneDocument>,
    next: &SceneDocument,
) -> Vec<String> {
    let mut out = Vec::new();
    let previous_assets: HashMap<&str, &MagnetizationAsset> = previous
        .map(|scene| {
            scene
                .magnetization_assets
                .iter()
                .map(|asset| (asset.id.as_str(), asset))
                .collect()
        })
        .unwrap_or_default();
    let next_assets: HashMap<&str, &MagnetizationAsset> = next
        .magnetization_assets
        .iter()
        .map(|asset| (asset.id.as_str(), asset))
        .collect();

    let mut asset_ids: Vec<&str> = previous_assets
        .keys()
        .copied()
        .chain(next_assets.keys().copied())
        .collect();
    asset_ids.sort_unstable();
    asset_ids.dedup();

    for asset_id in asset_ids {
        let prev_asset = previous_assets.get(asset_id).copied();
        let next_asset = next_assets.get(asset_id).copied();
        match (prev_asset, next_asset) {
            (None, Some(next_asset)) => {
                if next_asset.kind != "preset_texture" {
                    continue;
                }
                let objects = linked_objects_for_magnetization_asset(next, asset_id);
                out.push(format!(
                    "ASSIGN objects={:?} asset={} preset={} mapping=({}/{}/{}) T={} S={} R={}",
                    objects,
                    next_asset.id,
                    next_asset.preset_kind.as_deref().unwrap_or("<none>"),
                    next_asset.mapping.space,
                    next_asset.mapping.projection,
                    next_asset.mapping.clamp_mode,
                    fmt_vec3_nm(next_asset.texture_transform.translation),
                    fmt_vec3_nm(next_asset.texture_transform.scale),
                    fmt_quat4(next_asset.texture_transform.rotation_quat),
                ));
            }
            (Some(prev_asset), Some(next_asset)) => {
                if prev_asset.kind != "preset_texture" && next_asset.kind != "preset_texture" {
                    continue;
                }
                let objects = linked_objects_for_magnetization_asset(next, asset_id);
                if prev_asset.kind != "preset_texture" && next_asset.kind == "preset_texture" {
                    out.push(format!(
                        "KIND_SWITCH objects={:?} asset={} {} -> preset_texture({})",
                        objects,
                        next_asset.id,
                        prev_asset.kind,
                        next_asset.preset_kind.as_deref().unwrap_or("<none>"),
                    ));
                    continue;
                }
                if prev_asset.kind == "preset_texture" && next_asset.kind != "preset_texture" {
                    out.push(format!(
                        "KIND_SWITCH objects={:?} asset={} preset_texture -> {}",
                        objects, next_asset.id, next_asset.kind
                    ));
                    continue;
                }
                let mut changes = Vec::new();
                if prev_asset.preset_kind != next_asset.preset_kind {
                    changes.push(format!(
                        "preset={} -> {}",
                        prev_asset.preset_kind.as_deref().unwrap_or("<none>"),
                        next_asset.preset_kind.as_deref().unwrap_or("<none>")
                    ));
                }
                if prev_asset.preset_params != next_asset.preset_params {
                    changes.push(format!(
                        "preset_params {} -> {}",
                        fmt_preset_params(prev_asset.preset_params.as_ref()),
                        fmt_preset_params(next_asset.preset_params.as_ref()),
                    ));
                }
                if prev_asset.mapping != next_asset.mapping {
                    changes.push(format!(
                        "mapping=({}/{}/{}) -> ({}/{}/{})",
                        prev_asset.mapping.space,
                        prev_asset.mapping.projection,
                        prev_asset.mapping.clamp_mode,
                        next_asset.mapping.space,
                        next_asset.mapping.projection,
                        next_asset.mapping.clamp_mode
                    ));
                }
                if vec3_changed(
                    prev_asset.texture_transform.translation,
                    next_asset.texture_transform.translation,
                ) {
                    let delta = vec3_delta(
                        prev_asset.texture_transform.translation,
                        next_asset.texture_transform.translation,
                    );
                    changes.push(format!(
                        "translate Δ={} -> {}",
                        fmt_vec3_nm(delta),
                        fmt_vec3_nm(next_asset.texture_transform.translation),
                    ));
                }
                if vec3_changed(
                    prev_asset.texture_transform.scale,
                    next_asset.texture_transform.scale,
                ) {
                    changes.push(format!(
                        "scale {} -> {}",
                        fmt_vec3_nm(prev_asset.texture_transform.scale),
                        fmt_vec3_nm(next_asset.texture_transform.scale),
                    ));
                }
                if vec3_changed(
                    prev_asset.texture_transform.pivot,
                    next_asset.texture_transform.pivot,
                ) {
                    changes.push(format!(
                        "pivot {} -> {}",
                        fmt_vec3_nm(prev_asset.texture_transform.pivot),
                        fmt_vec3_nm(next_asset.texture_transform.pivot),
                    ));
                }
                if quat_changed(
                    prev_asset.texture_transform.rotation_quat,
                    next_asset.texture_transform.rotation_quat,
                ) {
                    changes.push(format!(
                        "rotation {} -> {}",
                        fmt_quat4(prev_asset.texture_transform.rotation_quat),
                        fmt_quat4(next_asset.texture_transform.rotation_quat),
                    ));
                }

                if !changes.is_empty() {
                    out.push(format!(
                        "UPDATE objects={:?} asset={} {}",
                        objects,
                        next_asset.id,
                        changes.join(" | "),
                    ));
                }
            }
            (Some(prev_asset), None) => {
                if prev_asset.kind != "preset_texture" {
                    continue;
                }
                if let Some(previous_scene) = previous {
                    let objects = linked_objects_for_magnetization_asset(previous_scene, asset_id);
                    out.push(format!(
                        "REMOVE objects={:?} asset={} preset={}",
                        objects,
                        prev_asset.id,
                        prev_asset.preset_kind.as_deref().unwrap_or("<none>")
                    ));
                } else {
                    out.push(format!(
                        "REMOVE objects=[] asset={} preset={}",
                        prev_asset.id,
                        prev_asset.preset_kind.as_deref().unwrap_or("<none>")
                    ));
                }
            }
            (None, None) => {}
        }
    }
    out
}

fn scene_mesh_signature(scene: &SceneDocument) -> Value {
    json!({
        "universe": scene.universe,
        "study_universe_mesh": scene.study.universe_mesh,
        "shared_domain_mesh": scene.study.shared_domain_mesh,
        "mesh_defaults": scene.study.mesh_defaults,
        "mesh_interfaces": scene.study.mesh_interfaces,
        "objects": scene.objects.iter().map(|object| json!({
            "id": object.id,
            "name": object.name,
            "geometry": object.geometry,
            "transform": object.transform,
            "material_ref": object.material_ref,
            "region_name": object.region_name,
            "object_mesh": object.object_mesh,
            "mesh_override": object.mesh_override,
        })).collect::<Vec<_>>(),
    })
}

async fn list_physics_docs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<String>>, ApiError> {
    let physics_dir = state.repo_root.join("docs/physics");
    let mut docs = Vec::new();
    for entry in std::fs::read_dir(&physics_dir)
        .map_err(|_| ApiError::not_found(format!("missing {}", physics_dir.display())))?
    {
        let entry = entry.map_err(ApiError::from)?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            docs.push(
                path.strip_prefix(&state.repo_root)
                    .unwrap_or(&path)
                    .display()
                    .to_string(),
            );
        }
    }
    docs.sort();
    Ok(Json(docs))
}

fn average_vector_components(values: &[f64], n_comp: usize) -> Option<[f64; 3]> {
    if values.is_empty() || n_comp == 0 || values.len() < n_comp {
        return None;
    }
    let vector_count = values.len() / n_comp;
    if vector_count == 0 {
        return None;
    }
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_z = 0.0;
    for chunk in values.chunks_exact(n_comp) {
        sum_x += chunk[0];
        if n_comp > 1 {
            sum_y += chunk[1];
        }
        if n_comp > 2 {
            sum_z += chunk[2];
        }
    }
    Some([
        sum_x / vector_count as f64,
        sum_y / vector_count as f64,
        sum_z / vector_count as f64,
    ])
}

fn format_debug_vector_average(mean: Option<[f64; 3]>) -> String {
    match mean {
        Some([mx, my, mz]) => format!("[{mx:.6e}, {my:.6e}, {mz:.6e}]"),
        None => "-".to_string(),
    }
}

fn preview_debug_metrics(preview: Option<&PreviewState>) -> (u64, usize, Option<[f64; 3]>) {
    match preview {
        Some(PreviewState::Spatial(state)) => (
            state.source_step,
            state
                .vector_field_values
                .as_ref()
                .map(|values| values.len())
                .unwrap_or(0),
            state
                .vector_field_values
                .as_ref()
                .and_then(|values| average_vector_components(values, state.n_comp)),
        ),
        Some(PreviewState::GlobalScalar(state)) => (state.source_step, 0, None),
        None => (0, 0, None),
    }
}

fn live_state_has_fresh_preview(live_state: Option<&LiveState>) -> bool {
    live_state
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .is_some()
}

fn build_preview_state(
    current: &SessionStateResponse,
    display_selection: &CurrentDisplaySelection,
    config: &CurrentPreviewConfig,
) -> Option<PreviewState> {
    match display_selection.selection.kind {
        fullmag_runner::DisplayKind::GlobalScalar => {
            build_global_scalar_preview_state(current, display_selection)
        }
        fullmag_runner::DisplayKind::VectorField | fullmag_runner::DisplayKind::SpatialScalar => {
            build_spatial_preview_state(current, display_selection, config)
        }
    }
}

fn build_spatial_preview_state(
    current: &SessionStateResponse,
    display_selection: &CurrentDisplaySelection,
    config: &CurrentPreviewConfig,
) -> Option<PreviewState> {
    let selection = &display_selection.selection;
    let quantity = resolve_preview_quantity(current, &selection.quantity)?;
    let component = normalize_preview_component(selection.preview_component());
    let (source_step, source_time) = current_preview_source(current);

    if let Some(field) = current
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .filter(|field| field.config_revision == config.revision && field.quantity == quantity)
    {
        return build_preview_state_from_live_field(
            current,
            field,
            display_selection,
            config,
            component,
            source_step,
            source_time,
        );
    }

    if let Some(mut field) = current
        .live_state
        .as_ref()
        .and_then(|state| state.latest_step.preview_field.as_ref())
        .filter(|field| field.quantity == quantity)
        .cloned()
    {
        field.config_revision = config.revision;
        return build_preview_state_from_live_field(
            current,
            &field,
            display_selection,
            config,
            component,
            source_step,
            source_time,
        );
    }

    if let Some(mut field) = cached_preview_field_owned(current, &quantity) {
        field.config_revision = config.revision;
        return build_preview_state_from_live_field(
            current,
            &field,
            display_selection,
            config,
            component,
            source_step,
            source_time,
        );
    }

    let unit = quantity_unit(&quantity).to_string();
    let display_kind = display_kind_for_quantity(&quantity).to_string();
    let quantity_domain = crate::preview::quantity_spatial_domain(&quantity).to_string();

    if let Some(mesh) = current.fem_mesh.as_ref() {
        let vectors = current_vector_field(current, &quantity)?.0;
        if vectors.len() != mesh.nodes.len() {
            return None;
        }
        let (min, max) = component_min_max(&vectors, component);
        let active_mask = crate::preview::mesh_preview_active_mask(mesh, &quantity);
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: config.revision,
            source_step,
            source_time,
            spatial_kind: "mesh".to_string(),
            quantity,
            unit,
            quantity_domain,
            component: component.to_string(),
            layer: 0,
            all_layers: true,
            view_type: if component == "3D" { "3D" } else { "2D" }.to_string(),
            vector_payload_id: None,
            vector_field_values: Some(flatten_vectors(&vectors)),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes: Vec::new(),
            y_possible_sizes: Vec::new(),
            x_chosen_size: 0,
            y_chosen_size: 0,
            applied_x_chosen_size: 0,
            applied_y_chosen_size: 0,
            applied_layer_stride: 1,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: false,
            auto_downscale_message: None,
            preview_grid: [vectors.len(), 1, 1],
            fem_mesh: Some(mesh.clone()),
            original_node_count: Some(mesh.nodes.len()),
            original_face_count: Some(mesh.boundary_faces.len()),
            active_mask,
        }));
    }

    let (vectors, grid) = current_vector_field(current, &quantity)?;
    if vectors.is_empty() {
        return None;
    }
    let [full_x, full_y, full_z] = grid;
    if full_x == 0 || full_y == 0 || full_z == 0 || vectors.len() != full_x * full_y * full_z {
        return None;
    }

    let x_possible_sizes = candidate_preview_sizes(full_x);
    let y_possible_sizes = candidate_preview_sizes(full_y);
    let requested_x = choose_preview_size(config.x_chosen_size as usize, &x_possible_sizes, full_x);
    let requested_y = choose_preview_size(config.y_chosen_size as usize, &y_possible_sizes, full_y);

    if component == "3D" {
        let (applied_x, applied_y, stride, auto_downscaled) = if config.auto_scale_enabled {
            fit_preview_grid_3d(requested_x, requested_y, full_z, config.max_points as usize)
        } else {
            (requested_x, requested_y, 1, false)
        };
        let preview_z = full_z.div_ceil(stride).max(1);

        let vectors = resample_grid_vectors_3d(
            &vectors,
            [full_x, full_y, full_z],
            [applied_x, applied_y, preview_z],
            stride,
        );
        let (min, max) = component_min_max(&vectors, component);
        let auto_downscale_message = auto_downscaled.then(|| {
            format!(
                "Preview auto-fit from {}x{}x{} to {}x{}x{} within {} points",
                full_x, full_y, full_z, applied_x, applied_y, preview_z, config.max_points
            )
        });
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: config.revision,
            source_step,
            source_time,
            spatial_kind: "grid".to_string(),
            quantity,
            unit,
            quantity_domain,
            component: component.to_string(),
            layer: (config.layer as usize).min(full_z.saturating_sub(1)),
            all_layers: config.all_layers,
            view_type: "3D".to_string(),
            vector_payload_id: None,
            vector_field_values: Some(flatten_vectors(&vectors)),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes: x_possible_sizes.clone(),
            y_possible_sizes: y_possible_sizes.clone(),
            x_chosen_size: requested_x,
            y_chosen_size: requested_y,
            applied_x_chosen_size: applied_x,
            applied_y_chosen_size: applied_y,
            applied_layer_stride: stride,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled,
            auto_downscale_message,
            preview_grid: [applied_x, applied_y, preview_z],
            fem_mesh: None,
            original_node_count: None,
            original_face_count: None,
            active_mask: None,
        }));
    }

    let layer = (config.layer as usize).min(full_z.saturating_sub(1));
    let effective_layers = if config.all_layers { full_z } else { 1 };
    let (applied_x, applied_y, auto_downscaled) = if config.auto_scale_enabled {
        fit_preview_grid_2d(
            requested_x,
            requested_y,
            effective_layers,
            config.max_points as usize,
        )
    } else {
        (requested_x, requested_y, false)
    };
    let scalar_field = resample_grid_scalar_2d(
        &vectors,
        [full_x, full_y, full_z],
        [applied_x, applied_y],
        component,
        layer,
        config.all_layers,
    );
    let (min, max) = scalar_min_max(&scalar_field);
    let auto_downscale_message = auto_downscaled.then(|| {
        format!(
            "Preview auto-fit from {}x{} to {}x{} within {} points",
            full_x, full_y, applied_x, applied_y, config.max_points
        )
    });
    Some(PreviewState::Spatial(SpatialPreviewState {
        display_kind,
        config_revision: config.revision,
        source_step,
        source_time,
        spatial_kind: "grid".to_string(),
        quantity,
        unit,
        quantity_domain,
        component: component.to_string(),
        layer,
        all_layers: config.all_layers,
        view_type: "2D".to_string(),
        vector_payload_id: None,
        vector_field_values: None,
        scalar_field,
        min,
        max,
        n_comp: 1,
        max_points: config.max_points as usize,
        data_points_count: applied_x * applied_y,
        x_possible_sizes,
        y_possible_sizes,
        x_chosen_size: requested_x,
        y_chosen_size: requested_y,
        applied_x_chosen_size: applied_x,
        applied_y_chosen_size: applied_y,
        applied_layer_stride: 1,
        auto_scale_enabled: config.auto_scale_enabled,
        auto_downscaled,
        auto_downscale_message,
        preview_grid: [applied_x, applied_y, 1],
        fem_mesh: None,
        original_node_count: None,
        original_face_count: None,
        active_mask: None,
    }))
}

fn build_global_scalar_preview_state(
    current: &SessionStateResponse,
    display_selection: &CurrentDisplaySelection,
) -> Option<PreviewState> {
    let quantity = resolve_global_scalar_quantity(current, &display_selection.selection.quantity)?;
    let value = current_global_scalar_value(current, &quantity)?;
    let (source_step, source_time) = current_preview_source(current);
    Some(PreviewState::GlobalScalar(GlobalScalarPreviewState {
        display_kind: display_kind_for_quantity(&quantity).to_string(),
        config_revision: display_selection.revision,
        source_step,
        source_time,
        quantity: quantity.clone(),
        unit: quantity_unit(&quantity).to_string(),
        value,
    }))
}

fn build_preview_state_from_live_field(
    current: &SessionStateResponse,
    field: &LivePreviewField,
    display_selection: &CurrentDisplaySelection,
    config: &CurrentPreviewConfig,
    component: &str,
    source_step: u64,
    source_time: f64,
) -> Option<PreviewState> {
    let preview_grid = [
        field.preview_grid[0] as usize,
        field.preview_grid[1] as usize,
        field.preview_grid[2] as usize,
    ];
    let original_grid = [
        field.original_grid[0] as usize,
        field.original_grid[1] as usize,
        field.original_grid[2] as usize,
    ];
    let n_comp = quantity_spec(&field.quantity)
        .map(|spec| spec.n_comp as usize)
        .unwrap_or(3);
    if n_comp == 1 && field.spatial_kind == "grid" {
        let scalar_field = sampled_flat_grid_scalar_2d(&field.vector_field_values, preview_grid);
        let (min, max) = scalar_min_max(&scalar_field);
        let x_possible_sizes = if original_grid[0] > 0 {
            candidate_preview_sizes(original_grid[0])
        } else {
            Vec::new()
        };
        let y_possible_sizes = if original_grid[1] > 0 {
            candidate_preview_sizes(original_grid[1])
        } else {
            Vec::new()
        };
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind: display_kind_for_quantity(&field.quantity).to_string(),
            config_revision: field.config_revision,
            source_step,
            source_time,
            spatial_kind: "grid".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            quantity_domain: field.quantity_domain.clone(),
            component: if component == "3D" {
                "magnitude"
            } else {
                component
            }
            .to_string(),
            layer: display_selection
                .selection
                .layer
                .min(field.original_grid[2].saturating_sub(1)) as usize,
            all_layers: display_selection.selection.all_layers,
            view_type: "2D".to_string(),
            vector_payload_id: None,
            vector_field_values: None,
            scalar_field,
            min,
            max,
            n_comp: 1,
            max_points: config.max_points as usize,
            data_points_count: preview_grid.iter().product(),
            x_possible_sizes,
            y_possible_sizes,
            x_chosen_size: field.x_chosen_size as usize,
            y_chosen_size: field.y_chosen_size as usize,
            applied_x_chosen_size: field.applied_x_chosen_size as usize,
            applied_y_chosen_size: field.applied_y_chosen_size as usize,
            applied_layer_stride: field.applied_layer_stride as usize,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: field.auto_downscaled,
            auto_downscale_message: field.auto_downscale_message.clone(),
            preview_grid,
            fem_mesh: None,
            original_node_count: None,
            original_face_count: None,
            active_mask: field.active_mask.clone(),
        }));
    }
    let vectors = field
        .vector_field_values
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect::<Vec<_>>();
    let display_kind = display_kind_for_quantity(&field.quantity).to_string();

    if field.spatial_kind == "mesh" {
        let mesh = current
            .fem_mesh
            .as_ref()
            .or_else(|| {
                current
                    .live_state
                    .as_ref()
                    .and_then(|state| state.latest_step.fem_mesh.as_ref())
            })?
            .clone();
        let (min, max) = component_min_max(&vectors, component);
        let active_mask = field
            .active_mask
            .clone()
            .or_else(|| crate::preview::mesh_preview_active_mask(&mesh, &field.quantity));
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: field.config_revision,
            source_step,
            source_time,
            spatial_kind: "mesh".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            quantity_domain: field.quantity_domain.clone(),
            component: component.to_string(),
            layer: 0,
            all_layers: true,
            view_type: if component == "3D" { "3D" } else { "2D" }.to_string(),
            vector_payload_id: None,
            vector_field_values: Some(field.vector_field_values.clone()),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes: Vec::new(),
            y_possible_sizes: Vec::new(),
            x_chosen_size: field.x_chosen_size as usize,
            y_chosen_size: field.y_chosen_size as usize,
            applied_x_chosen_size: field.applied_x_chosen_size as usize,
            applied_y_chosen_size: field.applied_y_chosen_size as usize,
            applied_layer_stride: field.applied_layer_stride as usize,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: field.auto_downscaled,
            auto_downscale_message: field.auto_downscale_message.clone(),
            preview_grid,
            fem_mesh: Some(mesh.clone()),
            original_node_count: Some(mesh.nodes.len()),
            original_face_count: Some(mesh.boundary_faces.len()),
            active_mask,
        }));
    }

    let x_possible_sizes = if original_grid[0] > 0 {
        candidate_preview_sizes(original_grid[0])
    } else {
        Vec::new()
    };
    let y_possible_sizes = if original_grid[1] > 0 {
        candidate_preview_sizes(original_grid[1])
    } else {
        Vec::new()
    };

    if component == "3D" {
        let (min, max) = component_min_max(&vectors, component);
        return Some(PreviewState::Spatial(SpatialPreviewState {
            display_kind,
            config_revision: field.config_revision,
            source_step,
            source_time,
            spatial_kind: "grid".to_string(),
            quantity: field.quantity.clone(),
            unit: field.unit.clone(),
            quantity_domain: field.quantity_domain.clone(),
            component: component.to_string(),
            layer: display_selection
                .selection
                .layer
                .min(field.original_grid[2].saturating_sub(1)) as usize,
            all_layers: display_selection.selection.all_layers,
            view_type: "3D".to_string(),
            vector_payload_id: None,
            vector_field_values: Some(field.vector_field_values.clone()),
            scalar_field: Vec::new(),
            min,
            max,
            n_comp: 3,
            max_points: config.max_points as usize,
            data_points_count: vectors.len(),
            x_possible_sizes,
            y_possible_sizes,
            x_chosen_size: field.x_chosen_size as usize,
            y_chosen_size: field.y_chosen_size as usize,
            applied_x_chosen_size: field.applied_x_chosen_size as usize,
            applied_y_chosen_size: field.applied_y_chosen_size as usize,
            applied_layer_stride: field.applied_layer_stride as usize,
            auto_scale_enabled: config.auto_scale_enabled,
            auto_downscaled: field.auto_downscaled,
            auto_downscale_message: field.auto_downscale_message.clone(),
            preview_grid,
            fem_mesh: None,
            original_node_count: None,
            original_face_count: None,
            active_mask: field.active_mask.clone(),
        }));
    }

    let scalar_field = sampled_grid_scalar_2d(&vectors, preview_grid, component);
    let (min, max) = scalar_min_max(&scalar_field);
    Some(PreviewState::Spatial(SpatialPreviewState {
        display_kind,
        config_revision: field.config_revision,
        source_step,
        source_time,
        spatial_kind: "grid".to_string(),
        quantity: field.quantity.clone(),
        unit: field.unit.clone(),
        quantity_domain: field.quantity_domain.clone(),
        component: component.to_string(),
        layer: display_selection
            .selection
            .layer
            .min(field.original_grid[2].saturating_sub(1)) as usize,
        all_layers: display_selection.selection.all_layers,
        view_type: "2D".to_string(),
        vector_payload_id: None,
        vector_field_values: None,
        scalar_field,
        min,
        max,
        n_comp: 1,
        max_points: config.max_points as usize,
        data_points_count: preview_grid[0] * preview_grid[1],
        x_possible_sizes,
        y_possible_sizes,
        x_chosen_size: field.x_chosen_size as usize,
        y_chosen_size: field.y_chosen_size as usize,
        applied_x_chosen_size: field.applied_x_chosen_size as usize,
        applied_y_chosen_size: field.applied_y_chosen_size as usize,
        applied_layer_stride: field.applied_layer_stride as usize,
        auto_scale_enabled: config.auto_scale_enabled,
        auto_downscaled: field.auto_downscaled,
        auto_downscale_message: field.auto_downscale_message.clone(),
        preview_grid,
        fem_mesh: None,
        original_node_count: None,
        original_face_count: None,
        active_mask: field.active_mask.clone(),
    }))
}

fn resolve_preview_quantity(current: &SessionStateResponse, requested: &str) -> Option<String> {
    let is_preview_compatible = |quantity_id: &str| {
        quantity_spec(quantity_id).is_some_and(|spec| spec.shape != QuantityKind::GlobalScalar)
    };
    if current.quantities.iter().any(|quantity| {
        quantity.available && quantity.id == requested && is_preview_compatible(&quantity.id)
    }) {
        return Some(requested.to_string());
    }
    // PH-00: explicit fallback with diagnostic log instead of silent first-available.
    let fallback = current
        .quantities
        .iter()
        .find(|quantity| quantity.available && is_preview_compatible(&quantity.id))
        .map(|quantity| quantity.id.clone());
    if let Some(ref fb) = fallback {
        eprintln!(
            "[quantities] preview fallback: requested '{}' unavailable, using '{}'",
            requested, fb
        );
    }
    fallback
}

fn resolve_global_scalar_quantity(
    current: &SessionStateResponse,
    requested: &str,
) -> Option<String> {
    let is_global_scalar = |quantity_id: &str| {
        quantity_spec(quantity_id).is_some_and(|spec| spec.shape == QuantityKind::GlobalScalar)
    };
    if current.quantities.iter().any(|quantity| {
        quantity.available && quantity.id == requested && is_global_scalar(&quantity.id)
    }) {
        return Some(requested.to_string());
    }
    // PH-00: explicit fallback with diagnostic log instead of silent first-available.
    let fallback = current
        .quantities
        .iter()
        .find(|quantity| quantity.available && is_global_scalar(&quantity.id))
        .map(|quantity| quantity.id.clone());
    if let Some(ref fb) = fallback {
        eprintln!(
            "[quantities] global scalar fallback: requested '{}' unavailable, using '{}'",
            requested, fb
        );
    }
    fallback
}

fn current_preview_source(current: &SessionStateResponse) -> (u64, f64) {
    if let Some(live_state) = current.live_state.as_ref() {
        return (live_state.latest_step.step, live_state.latest_step.time);
    }
    if let Some(row) = current.scalar_rows.last() {
        return (row.step, row.time);
    }
    if let Some(run) = current.run.as_ref() {
        return (run.total_steps as u64, run.final_time.unwrap_or(0.0));
    }
    (0, 0.0)
}

fn current_global_scalar_value(current: &SessionStateResponse, quantity: &str) -> Option<f64> {
    let metric_key = quantity_spec(quantity)?.scalar_metric_key?;
    current
        .scalar_rows
        .last()
        .and_then(|row| scalar_row_metric_value(row, metric_key))
        .or_else(|| {
            current
                .live_state
                .as_ref()
                .and_then(|state| live_step_metric_value(&state.latest_step, metric_key))
        })
        .or_else(|| run_manifest_scalar_value(current.run.as_ref(), metric_key))
}

fn scalar_row_metric_value(row: &ScalarRow, metric_key: &str) -> Option<f64> {
    match metric_key {
        "e_ex" => Some(row.e_ex),
        "e_demag" => Some(row.e_demag),
        "e_ext" => Some(row.e_ext),
        "e_ani" => Some(row.e_ani),
        "e_dmi" => Some(row.e_dmi),
        "e_total" => Some(row.e_total),
        _ => None,
    }
}
