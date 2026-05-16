//! Display mutation endpoints.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::State;

use crate::error::ApiError;
use crate::schemas::display::DisplayPatch;
use crate::schemas::realtime::{RealtimeResourceChange, RealtimeResourceName};
use crate::schemas::status::{DisplaySelection, DisplayViewMode, FieldComponent};
use crate::schemas::visualization_state::{
    AirboxLayerPatch, AirboxLayerState, BasicLayerPatch, BasicLayerState, ClipAxis,
    ClipVisualizationState, DomainVisualizationState, FdmVisualizationState, FemTopologyMode,
    FemVisualizationState, FerromagnetVisibilityMode, SamplingProfile, SamplingVisualizationState,
    SliceAirboxRenderMode, SliceRenderMode, SliceVisualizationMode, SliceVisualizationState,
    SurfaceColorSource, TrimAxisVisualizationAxes, TrimAxisVisualizationAxesPatch,
    TrimAxisVisualizationPatch, TrimAxisVisualizationState, TrimVisualizationState,
    VectorColorMode, VectorLayerDomain, VectorLayerPatch, VectorLayerState,
    VectorStyleVisualizationState, VisualizationCameraPatch, VisualizationCameraProjection,
    VisualizationCameraState, VisualizationClientAckEntry, VisualizationClientAckRequest,
    VisualizationClientAckResource, VisualizationDiagnostics, VisualizationLayerPatch,
    VisualizationLayerState, VisualizationOverrideState, VisualizationResolvedTargetSettings,
    VisualizationScopeKind, VisualizationStatePatch, VisualizationStateResource,
    VisualizationTargetGeometryScope, VisualizationTargetRegistryEntry,
    VisualizationTargetRegistryState, VisualizationTargetRenderMode, VisualizationTargetSource,
};
use crate::types::{
    AppState, CurrentDisplaySelection, DisplayPresentationState, SessionStateResponse,
};
use fullmag_runner::{DisplayFieldComponent, DisplayViewMode as RunnerDisplayViewMode};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/visualization/display",
    responses(
        (status = 200, description = "Current display selection", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "visualization"
)]
pub async fn get_display(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DisplaySelection>, ApiError> {
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    Ok(Json(build_display_selection_response(
        &selection,
        &presentation,
    )))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/visualization/state",
    responses(
        (status = 200, description = "Current visualization state", body = VisualizationStateResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "visualization"
)]
pub async fn get_visualization_state(
    State(state): State<Arc<AppState>>,
) -> Result<Json<VisualizationStateResource>, ApiError> {
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    let live_snapshot = state.current_live_state.read().await;
    Ok(Json(build_visualization_state_response(
        &selection,
        &presentation,
        live_snapshot.as_ref(),
    )))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/visualization/client-acks",
    responses(
        (status = 200, description = "Latest visualization client acknowledgements", body = VisualizationClientAckResource),
    ),
    tag = "visualization"
)]
pub async fn get_visualization_client_acks(
    State(state): State<Arc<AppState>>,
) -> Result<Json<VisualizationClientAckResource>, ApiError> {
    let entries = state.current_visualization_client_acks.read().await;
    Ok(Json(VisualizationClientAckResource {
        revision: state
            .current_visualization_client_ack_revision
            .load(Ordering::Relaxed),
        entries: entries.values().cloned().collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/visualization/client-acks",
    request_body = VisualizationClientAckRequest,
    responses(
        (status = 200, description = "Visualization client acknowledgement recorded", body = VisualizationClientAckEntry),
        (status = 400, description = "Invalid client acknowledgement"),
    ),
    tag = "visualization"
)]
pub async fn post_visualization_client_ack(
    State(state): State<Arc<AppState>>,
    Json(request): Json<VisualizationClientAckRequest>,
) -> Result<Json<VisualizationClientAckEntry>, ApiError> {
    let entry = build_visualization_client_ack_entry(&request)?;
    {
        let mut entries = state.current_visualization_client_acks.write().await;
        entries.insert(visualization_client_ack_key(&entry), entry.clone());
        while entries.len() > 128 {
            let Some(oldest_key) = entries.keys().next().cloned() else {
                break;
            };
            entries.remove(&oldest_key);
        }
    }
    let ack_revision = state
        .current_visualization_client_ack_revision
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    emit_visualization_client_ack_realtime_change(&state, ack_revision).await?;
    Ok(Json(entry))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/visualization/display",
    request_body = DisplaySelection,
    responses(
        (status = 200, description = "Display replaced", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "visualization"
)]
pub async fn replace_display(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<DisplaySelection>,
) -> Result<Json<DisplaySelection>, ApiError> {
    apply_display_replace(state.clone(), replacement).await?;
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    Ok(Json(build_display_selection_response(
        &selection,
        &presentation,
    )))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/visualization/state",
    request_body = VisualizationStateResource,
    responses(
        (status = 200, description = "Visualization state replaced", body = VisualizationStateResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "visualization"
)]
pub async fn replace_visualization_state(
    State(state): State<Arc<AppState>>,
    Json(replacement): Json<VisualizationStateResource>,
) -> Result<Json<VisualizationStateResource>, ApiError> {
    validate_camera_state(&replacement.camera)?;
    let display_replacement = visualization_state_to_display_selection(&replacement);
    apply_display_replace(state.clone(), display_replacement).await?;
    {
        let mut presentation = state.current_display_presentation.write().await;
        presentation.visualization_layers = Some(replacement.layers);
        presentation.visualization_domains = Some(replacement.domains);
        presentation.visualization_sampling = Some(replacement.sampling);
        presentation.visualization_fem = Some(replacement.fem);
        presentation.visualization_slice = Some(replacement.slice);
        presentation.visualization_trim = Some(replacement.trim.clone());
        presentation.visualization_camera = Some(replacement.camera);
        presentation.visualization_clip = Some(replacement.clip);
        presentation.visualization_vector_style = Some(replacement.vector_style);
        presentation.visualization_overrides = Some(replacement.overrides);
    }
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    let live_snapshot = state.current_live_state.read().await;
    Ok(Json(build_visualization_state_response(
        &selection,
        &presentation,
        live_snapshot.as_ref(),
    )))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/visualization/display",
    request_body = DisplayPatch,
    responses(
        (status = 200, description = "Display patched", body = DisplaySelection),
        (status = 404, description = "No active workspace"),
    ),
    tag = "visualization"
)]
pub async fn patch_display(
    State(state): State<Arc<AppState>>,
    Json(update): Json<DisplayPatch>,
) -> Result<Json<DisplaySelection>, ApiError> {
    let response = apply_display_patch(state, update).await?;
    Ok(Json(response))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/visualization/state",
    request_body = VisualizationStatePatch,
    responses(
        (status = 200, description = "Visualization state patched", body = VisualizationStateResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "visualization"
)]
pub async fn patch_visualization_state(
    State(state): State<Arc<AppState>>,
    Json(update): Json<VisualizationStatePatch>,
) -> Result<Json<VisualizationStateResource>, ApiError> {
    validate_visualization_state_patch(&update)?;
    let display_patch = visualization_patch_to_display_patch(&update);
    let display_revision = {
        let mut selection = state.current_display_selection.write().await;
        let mut presentation = state.current_display_presentation.write().await;
        apply_display_patch_to_state(&mut selection, &mut presentation, display_patch);
        apply_visualization_presentation_patch(&mut presentation, &update)?;
        selection.revision
    };
    emit_display_realtime_change(&state, display_revision).await?;
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    let live_snapshot = state.current_live_state.read().await;
    Ok(Json(build_visualization_state_response(
        &selection,
        &presentation,
        live_snapshot.as_ref(),
    )))
}

async fn apply_display_replace(
    state: Arc<AppState>,
    replacement: DisplaySelection,
) -> Result<(), ApiError> {
    let mut selection = state.current_display_selection.write().await;
    let mut presentation = state.current_display_presentation.write().await;

    selection.selection.quantity = replacement.active_quantity_id;
    selection.selection.view_mode = match replacement.view_mode {
        DisplayViewMode::TwoD => RunnerDisplayViewMode::TwoD,
        DisplayViewMode::ThreeD => RunnerDisplayViewMode::ThreeD,
    };
    selection.selection.field_component = match replacement.field_component {
        FieldComponent::X => DisplayFieldComponent::X,
        FieldComponent::Y => DisplayFieldComponent::Y,
        FieldComponent::Z => DisplayFieldComponent::Z,
        FieldComponent::Magnitude => DisplayFieldComponent::Magnitude,
    };
    selection.selection.auto_scale_enabled = replacement.auto_contrast;
    selection.selection.every_n = replacement.vector_density;
    selection.selection.layer = replacement.slice_layer.max(0) as u32;
    selection.selection.all_layers = replacement.slice_mode == "all";
    selection.selection.max_points = replacement.max_points;
    selection.selection.x_chosen_size = replacement.x_chosen_size;
    selection.selection.y_chosen_size = replacement.y_chosen_size;
    selection.selection.canonicalize();

    presentation.colormap = replacement.colormap;
    presentation.contrast_min = replacement.contrast_min;
    presentation.contrast_max = replacement.contrast_max;
    presentation.vector_glyphs = replacement.vector_glyphs;

    selection.revision = selection.revision.wrapping_add(1);
    let display_revision = selection.revision;
    drop(presentation);
    drop(selection);
    emit_display_realtime_change(&state, display_revision).await?;

    Ok(())
}

async fn apply_display_patch(
    state: Arc<AppState>,
    update: DisplayPatch,
) -> Result<DisplaySelection, ApiError> {
    let mut sel = state.current_display_selection.write().await;
    let mut presentation = state.current_display_presentation.write().await;
    let response = apply_display_patch_to_state(&mut sel, &mut presentation, update);
    let display_revision = sel.revision;
    drop(presentation);
    drop(sel);
    emit_display_realtime_change(&state, display_revision).await?;

    Ok(response)
}

fn apply_display_patch_to_state(
    sel: &mut CurrentDisplaySelection,
    presentation: &mut DisplayPresentationState,
    update: DisplayPatch,
) -> DisplaySelection {
    if let Some(q) = update.active_quantity_id {
        sel.selection.quantity = q;
    }
    if let Some(view_mode) = update.view_mode {
        sel.selection.view_mode = match view_mode {
            DisplayViewMode::TwoD => RunnerDisplayViewMode::TwoD,
            DisplayViewMode::ThreeD => RunnerDisplayViewMode::ThreeD,
        };
    }
    if let Some(field_component) = update.field_component {
        sel.selection.field_component = match field_component {
            FieldComponent::X => DisplayFieldComponent::X,
            FieldComponent::Y => DisplayFieldComponent::Y,
            FieldComponent::Z => DisplayFieldComponent::Z,
            FieldComponent::Magnitude => DisplayFieldComponent::Magnitude,
        };
    }
    if let Some(ac) = update.auto_contrast {
        sel.selection.auto_scale_enabled = ac;
    }
    if let Some(vd) = update.vector_density {
        sel.selection.every_n = vd;
    }
    if let Some(sl) = update.slice_layer {
        sel.selection.layer = sl.max(0) as u32;
    }
    if let Some(sm) = update.slice_mode {
        sel.selection.all_layers = sm == "all";
    }
    if let Some(max_points) = update.max_points {
        sel.selection.max_points = max_points;
    }
    if let Some(x_chosen_size) = update.x_chosen_size {
        sel.selection.x_chosen_size = x_chosen_size;
    }
    if let Some(y_chosen_size) = update.y_chosen_size {
        sel.selection.y_chosen_size = y_chosen_size;
    }
    if let Some(colormap) = update.colormap {
        presentation.colormap = colormap;
    }
    if let Some(contrast_min) = update.contrast_min {
        presentation.contrast_min = Some(contrast_min);
    }
    if let Some(contrast_max) = update.contrast_max {
        presentation.contrast_max = Some(contrast_max);
    }
    if let Some(vector_glyphs) = update.vector_glyphs {
        presentation.vector_glyphs = vector_glyphs;
    }
    sel.selection.canonicalize();

    sel.revision = sel.revision.wrapping_add(1);
    build_display_selection_response(&sel, &presentation)
}

fn validate_visualization_state_patch(update: &VisualizationStatePatch) -> Result<(), ApiError> {
    if matches!(update.vector_density, Some(0)) {
        return Err(ApiError::bad_request(
            "vector_density must be greater than zero",
        ));
    }
    if matches!(update.max_points, Some(0)) {
        return Err(ApiError::bad_request(
            "max_points must be greater than zero",
        ));
    }
    if let Some(sampling) = &update.sampling {
        if matches!(sampling.max_points, Some(0)) {
            return Err(ApiError::bad_request(
                "sampling.max_points must be greater than zero",
            ));
        }
        if matches!(sampling.max_glyphs, Some(0)) {
            return Err(ApiError::bad_request(
                "sampling.max_glyphs must be greater than zero",
            ));
        }
        if matches!(sampling.max_bytes, Some(0)) {
            return Err(ApiError::bad_request(
                "sampling.max_bytes must be greater than zero",
            ));
        }
    }
    if let Some(slice) = &update.slice {
        if matches!(slice.position_percent, Some(value) if !(0.0..=100.0).contains(&value)) {
            return Err(ApiError::bad_request(
                "slice.position_percent must be between 0 and 100",
            ));
        }
        if matches!(slice.thickness_percent, Some(value) if !(0.0..=100.0).contains(&value)) {
            return Err(ApiError::bad_request(
                "slice.thickness_percent must be between 0 and 100",
            ));
        }
    }
    if let Some(camera) = &update.camera {
        validate_camera_patch(camera)?;
    }
    if let Some(layers) = &update.layers {
        if matches!(
            layers.vectors.as_ref().and_then(|vectors| vectors.density),
            Some(0)
        ) {
            return Err(ApiError::bad_request(
                "layers.vectors.density must be greater than zero",
            ));
        }
        if let Some(airbox_vectors) = layers
            .airbox
            .as_ref()
            .and_then(|airbox| airbox.vectors.as_ref())
        {
            if matches!(airbox_vectors.density, Some(0)) {
                return Err(ApiError::bad_request(
                    "layers.airbox.vectors.density must be greater than zero",
                ));
            }
            if let Some(domain) = airbox_vectors.domain {
                if domain != VectorLayerDomain::AirboxOnly {
                    return Err(ApiError::bad_request(
                        "layers.airbox.vectors.domain must be airbox_only",
                    ));
                }
            }
        }
    }
    if let Some(style) = &update.vector_style {
        if matches!(style.alpha, Some(value) if !(0.0..=1.0).contains(&value)) {
            return Err(ApiError::bad_request(
                "vector_style.alpha must be between 0 and 1",
            ));
        }
        if matches!(style.length_scale, Some(value) if !(0.1..=5.0).contains(&value)) {
            return Err(ApiError::bad_request(
                "vector_style.length_scale must be between 0.1 and 5",
            ));
        }
        if matches!(style.thickness, Some(value) if value <= 0.0) {
            return Err(ApiError::bad_request(
                "vector_style.thickness must be greater than zero",
            ));
        }
    }
    if let Some(overrides) = &update.overrides {
        for (index, target_override) in overrides.iter().enumerate() {
            if target_override.scope_id.trim().is_empty() {
                return Err(ApiError::bad_request(format!(
                    "overrides[{index}].scope_id must not be empty"
                )));
            }
            if let Some(display) = &target_override.display {
                if matches!(display.opacity, Some(value) if !(0.0..=1.0).contains(&value)) {
                    return Err(ApiError::bad_request(format!(
                        "overrides[{index}].display.opacity must be between 0 and 1"
                    )));
                }
                for (label, layer) in [
                    ("surface", display.surface.as_ref()),
                    ("wireframe", display.wireframe.as_ref()),
                    ("points", display.points.as_ref()),
                ] {
                    if matches!(
                        layer.and_then(|layer| layer.opacity),
                        Some(value) if !(0.0..=1.0).contains(&value)
                    ) {
                        return Err(ApiError::bad_request(format!(
                            "overrides[{index}].display.{label}.opacity must be between 0 and 1"
                        )));
                    }
                }
                if matches!(
                    display.vectors.as_ref().and_then(|vectors| vectors.density),
                    Some(0)
                ) {
                    return Err(ApiError::bad_request(format!(
                        "overrides[{index}].display.vectors.density must be greater than zero"
                    )));
                }
            }
            if let Some(style) = &target_override.style {
                if matches!(style.vector_alpha, Some(value) if !(0.0..=1.0).contains(&value)) {
                    return Err(ApiError::bad_request(format!(
                        "overrides[{index}].style.vector_alpha must be between 0 and 1"
                    )));
                }
                if matches!(style.vector_budget, Some(0)) {
                    return Err(ApiError::bad_request(format!(
                        "overrides[{index}].style.vector_budget must be greater than zero"
                    )));
                }
                if matches!(
                    style.vector_length_scale,
                    Some(value) if !(0.1..=5.0).contains(&value)
                ) {
                    return Err(ApiError::bad_request(format!(
                        "overrides[{index}].style.vector_length_scale must be between 0.1 and 5"
                    )));
                }
                if matches!(style.vector_thickness, Some(value) if value <= 0.0) {
                    return Err(ApiError::bad_request(format!(
                        "overrides[{index}].style.vector_thickness must be greater than zero"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn validate_camera_patch(camera: &VisualizationCameraPatch) -> Result<(), ApiError> {
    if let Some(position) = camera.position {
        validate_camera_vector("camera.position", position)?;
        if matches!(camera.target, Some(target) if position == target) {
            return Err(ApiError::bad_request(
                "camera.position must not equal camera.target",
            ));
        }
    }
    if let Some(target) = camera.target {
        validate_camera_vector("camera.target", target)?;
    }
    if let Some(up) = camera.up {
        validate_camera_vector("camera.up", up)?;
        if vector_length_squared(up) <= f64::EPSILON {
            return Err(ApiError::bad_request("camera.up must not be zero"));
        }
    }
    if matches!(camera.fov_degrees, Some(value) if !value.is_finite() || !(1.0..=179.0).contains(&value))
    {
        return Err(ApiError::bad_request(
            "camera.fov_degrees must be between 1 and 179",
        ));
    }
    if matches!(camera.orthographic_scale, Some(value) if !value.is_finite() || value <= 0.0) {
        return Err(ApiError::bad_request(
            "camera.orthographic_scale must be greater than zero",
        ));
    }
    Ok(())
}

fn validate_camera_state(camera: &VisualizationCameraState) -> Result<(), ApiError> {
    validate_camera_vector("camera.position", camera.position)?;
    validate_camera_vector("camera.target", camera.target)?;
    validate_camera_vector("camera.up", camera.up)?;
    if camera.position == camera.target {
        return Err(ApiError::bad_request(
            "camera.position must not equal camera.target",
        ));
    }
    if vector_length_squared(camera.up) <= f64::EPSILON {
        return Err(ApiError::bad_request("camera.up must not be zero"));
    }
    if !camera.fov_degrees.is_finite() || !(1.0..=179.0).contains(&camera.fov_degrees) {
        return Err(ApiError::bad_request(
            "camera.fov_degrees must be between 1 and 179",
        ));
    }
    if matches!(camera.orthographic_scale, Some(value) if !value.is_finite() || value <= 0.0) {
        return Err(ApiError::bad_request(
            "camera.orthographic_scale must be greater than zero",
        ));
    }
    Ok(())
}

fn validate_camera_vector(label: &str, vector: [f64; 3]) -> Result<(), ApiError> {
    if vector.iter().all(|value| value.is_finite()) {
        return Ok(());
    }
    Err(ApiError::bad_request(format!(
        "{label} must contain finite values"
    )))
}

fn vector_length_squared(vector: [f64; 3]) -> f64 {
    vector.iter().map(|component| component * component).sum()
}

fn default_visualization_layers(
    presentation: &DisplayPresentationState,
    vector_density: u32,
) -> VisualizationLayerState {
    VisualizationLayerState {
        bounds: basic_layer(false, 1.0),
        surface: basic_layer(true, 1.0),
        quantity_overlay: basic_layer(true, 1.0),
        wireframe: basic_layer(false, 1.0),
        volume_mesh: basic_layer(false, 1.0),
        points: basic_layer(false, 1.0),
        vectors: VectorLayerState {
            visible: presentation.vector_glyphs,
            density: vector_density,
            domain: VectorLayerDomain::Auto,
        },
        primitives: basic_layer(true, 1.0),
        airbox: AirboxLayerState {
            visible: false,
            bounds: basic_layer(false, 1.0),
            surface: basic_layer(false, 0.18),
            wireframe: basic_layer(false, 1.0),
            points: basic_layer(false, 1.0),
            vectors: VectorLayerState {
                visible: false,
                density: vector_density,
                domain: VectorLayerDomain::AirboxOnly,
            },
            opacity: 0.18,
        },
    }
}

fn default_visualization_domains() -> DomainVisualizationState {
    DomainVisualizationState {
        active_scope: VisualizationScopeKind::Full,
        object_id: None,
        part_id: None,
    }
}

fn default_visualization_sampling(max_points: u32) -> SamplingVisualizationState {
    SamplingVisualizationState {
        profile: SamplingProfile::Balanced,
        max_points,
        max_glyphs: max_points,
        max_bytes: None,
        progressive: true,
    }
}

fn default_fem_visualization() -> FemVisualizationState {
    FemVisualizationState {
        topology_mode: FemTopologyMode::Auto,
        volume_edges_budget: 100_000,
    }
}

fn slice_mode_from_selection(selection: &CurrentDisplaySelection) -> SliceVisualizationMode {
    if selection.selection.all_layers {
        SliceVisualizationMode::AllLayers
    } else {
        SliceVisualizationMode::Single
    }
}

fn default_slice_visualization(
    selection: &CurrentDisplaySelection,
    presentation: &DisplayPresentationState,
    layers: &VisualizationLayerState,
) -> SliceVisualizationState {
    let mut slice = default_slice_visualization_for_presentation(presentation, layers);
    slice.quantity_id = selection.selection.quantity.clone();
    slice.component = match selection.selection.field_component {
        DisplayFieldComponent::X => FieldComponent::X,
        DisplayFieldComponent::Y => FieldComponent::Y,
        DisplayFieldComponent::Z => FieldComponent::Z,
        DisplayFieldComponent::Magnitude => FieldComponent::Magnitude,
    };
    slice.mode = slice_mode_from_selection(selection);
    slice.layer_index = Some(selection.selection.layer as i32);
    slice.auto_contrast = selection.selection.auto_scale_enabled;
    slice
}

fn default_slice_visualization_for_presentation(
    presentation: &DisplayPresentationState,
    layers: &VisualizationLayerState,
) -> SliceVisualizationState {
    SliceVisualizationState {
        quantity_id: "m".to_string(),
        component: FieldComponent::Magnitude,
        axis: ClipAxis::Z,
        mode: SliceVisualizationMode::Single,
        layer_index: Some(0),
        position_percent: 50.0,
        thickness_percent: None,
        colormap: presentation.colormap.clone(),
        auto_contrast: true,
        show_primitives: layers.primitives.visible,
        show_mesh: layers.wireframe.visible || layers.volume_mesh.visible || layers.points.visible,
        show_magnetic_texture: true,
        show_airbox: false,
        airbox_render_mode: SliceAirboxRenderMode::Wireframe,
        show_airbox_vectors: false,
        show_quantity: layers.quantity_overlay.visible,
        show_vectors: false,
        render_mode: SliceRenderMode::Heatmap,
        projection_reduction: "mean_occupied".to_string(),
        projection_include_air_as_zero: false,
        projection_samples: 32,
        projection_resolution: 128,
    }
}

fn default_clip_visualization() -> ClipVisualizationState {
    ClipVisualizationState {
        enabled: false,
        axis: ClipAxis::X,
        position_percent: 50.0,
        flipped: false,
    }
}

fn default_camera_visualization() -> VisualizationCameraState {
    VisualizationCameraState {
        projection: VisualizationCameraProjection::Perspective,
        position: [2e-6, 1.4e-6, 2e-6],
        target: [0.0, 0.0, 0.0],
        up: [0.0, 0.0, 1.0],
        fov_degrees: 45.0,
        orthographic_scale: None,
    }
}

fn default_trim_axis_visualization() -> TrimAxisVisualizationState {
    TrimAxisVisualizationState {
        enabled: false,
        min_percent: 0.0,
        max_percent: 100.0,
    }
}

fn default_trim_visualization() -> TrimVisualizationState {
    TrimVisualizationState {
        enabled: false,
        axes: TrimAxisVisualizationAxes {
            x: default_trim_axis_visualization(),
            y: default_trim_axis_visualization(),
            z: default_trim_axis_visualization(),
        },
    }
}

fn clamp_trim_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

fn normalize_trim_axis(axis: &mut TrimAxisVisualizationState) {
    axis.min_percent = clamp_trim_percent(axis.min_percent);
    axis.max_percent = clamp_trim_percent(axis.max_percent);
    if axis.max_percent - axis.min_percent < 1.0 {
        let center = ((axis.min_percent + axis.max_percent) * 0.5).clamp(0.5, 99.5);
        axis.min_percent = (center - 0.5).max(0.0);
        axis.max_percent = (center + 0.5).min(100.0);
    }
}

fn apply_trim_axis_patch(
    axis: &mut TrimAxisVisualizationState,
    patch: &TrimAxisVisualizationPatch,
) {
    if let Some(enabled) = patch.enabled {
        axis.enabled = enabled;
    }
    if let Some(min_percent) = patch.min_percent {
        axis.min_percent = min_percent;
    }
    if let Some(max_percent) = patch.max_percent {
        axis.max_percent = max_percent;
    }
    normalize_trim_axis(axis);
}

fn apply_trim_axes_patch(
    axes: &mut TrimAxisVisualizationAxes,
    patch: &TrimAxisVisualizationAxesPatch,
) {
    if let Some(x) = &patch.x {
        apply_trim_axis_patch(&mut axes.x, x);
    }
    if let Some(y) = &patch.y {
        apply_trim_axis_patch(&mut axes.y, y);
    }
    if let Some(z) = &patch.z {
        apply_trim_axis_patch(&mut axes.z, z);
    }
}

fn first_enabled_trim_axis(
    trim: &TrimVisualizationState,
) -> Option<(ClipAxis, &TrimAxisVisualizationState)> {
    if trim.axes.x.enabled {
        return Some((ClipAxis::X, &trim.axes.x));
    }
    if trim.axes.y.enabled {
        return Some((ClipAxis::Y, &trim.axes.y));
    }
    if trim.axes.z.enabled {
        return Some((ClipAxis::Z, &trim.axes.z));
    }
    None
}

fn compatibility_clip_from_trim(trim: &TrimVisualizationState) -> ClipVisualizationState {
    if !trim.enabled {
        return default_clip_visualization();
    }
    let Some((axis, state)) = first_enabled_trim_axis(trim) else {
        return default_clip_visualization();
    };
    let use_min_plane = state.min_percent > 0.0;
    ClipVisualizationState {
        enabled: true,
        axis,
        position_percent: if use_min_plane {
            state.min_percent
        } else {
            state.max_percent
        },
        flipped: use_min_plane,
    }
}

fn apply_compatibility_clip_to_trim(
    trim: &mut TrimVisualizationState,
    clip: &ClipVisualizationState,
) {
    trim.enabled = clip.enabled;
    trim.axes.x.enabled = false;
    trim.axes.y.enabled = false;
    trim.axes.z.enabled = false;
    if !clip.enabled {
        return;
    }
    let target = match clip.axis {
        ClipAxis::X => &mut trim.axes.x,
        ClipAxis::Y => &mut trim.axes.y,
        ClipAxis::Z => &mut trim.axes.z,
    };
    target.enabled = true;
    if clip.flipped {
        target.min_percent = clip.position_percent;
        target.max_percent = 100.0;
    } else {
        target.min_percent = 0.0;
        target.max_percent = clip.position_percent;
    }
    normalize_trim_axis(target);
}

fn default_vector_style_visualization() -> VectorStyleVisualizationState {
    VectorStyleVisualizationState {
        color_mode: VectorColorMode::Orientation,
        mono_color: "#00c2ff".to_string(),
        alpha: 1.0,
        length_scale: 1.0,
        thickness: 1.0,
        ferromagnet_visibility: FerromagnetVisibilityMode::Hide,
    }
}

fn apply_basic_layer_patch(state: &mut BasicLayerState, patch: &BasicLayerPatch) {
    if let Some(visible) = patch.visible {
        state.visible = visible;
    }
    if let Some(opacity) = patch.opacity {
        state.opacity = opacity;
    }
}

fn apply_vector_layer_patch(state: &mut VectorLayerState, patch: &VectorLayerPatch) {
    if let Some(visible) = patch.visible {
        state.visible = visible;
    }
    if let Some(density) = patch.density {
        state.density = density;
    }
    if let Some(domain) = patch.domain {
        state.domain = domain;
    }
}

fn apply_airbox_layer_patch(state: &mut AirboxLayerState, patch: &AirboxLayerPatch) {
    if let Some(visible) = patch.visible {
        state.visible = visible;
    }
    if let Some(bounds) = &patch.bounds {
        apply_basic_layer_patch(&mut state.bounds, bounds);
    }
    if let Some(surface) = &patch.surface {
        apply_basic_layer_patch(&mut state.surface, surface);
    }
    if let Some(wireframe) = &patch.wireframe {
        apply_basic_layer_patch(&mut state.wireframe, wireframe);
    }
    if let Some(points) = &patch.points {
        apply_basic_layer_patch(&mut state.points, points);
    }
    if let Some(vectors) = &patch.vectors {
        apply_vector_layer_patch(&mut state.vectors, vectors);
    }
    if let Some(opacity) = patch.opacity {
        state.opacity = opacity;
    }
}

fn apply_visualization_layer_patch(
    state: &mut VisualizationLayerState,
    patch: &VisualizationLayerPatch,
) {
    if let Some(bounds) = &patch.bounds {
        apply_basic_layer_patch(&mut state.bounds, bounds);
    }
    if let Some(surface) = &patch.surface {
        apply_basic_layer_patch(&mut state.surface, surface);
    }
    if let Some(quantity_overlay) = &patch.quantity_overlay {
        apply_basic_layer_patch(&mut state.quantity_overlay, quantity_overlay);
    }
    if let Some(wireframe) = &patch.wireframe {
        apply_basic_layer_patch(&mut state.wireframe, wireframe);
    }
    if let Some(volume_mesh) = &patch.volume_mesh {
        apply_basic_layer_patch(&mut state.volume_mesh, volume_mesh);
    }
    if let Some(points) = &patch.points {
        apply_basic_layer_patch(&mut state.points, points);
    }
    if let Some(vectors) = &patch.vectors {
        apply_vector_layer_patch(&mut state.vectors, vectors);
    }
    if let Some(primitives) = &patch.primitives {
        apply_basic_layer_patch(&mut state.primitives, primitives);
    }
    if let Some(airbox) = &patch.airbox {
        apply_airbox_layer_patch(&mut state.airbox, airbox);
    }
}

fn apply_visualization_presentation_patch(
    presentation: &mut DisplayPresentationState,
    update: &VisualizationStatePatch,
) -> Result<(), ApiError> {
    if let Some(layers_patch) = &update.layers {
        let mut layers = presentation
            .visualization_layers
            .take()
            .unwrap_or_else(|| default_visualization_layers(presentation, 1));
        apply_visualization_layer_patch(&mut layers, layers_patch);
        presentation.visualization_layers = Some(layers);
    }
    if let Some(domains_patch) = &update.domains {
        let mut domains = presentation
            .visualization_domains
            .take()
            .unwrap_or_else(default_visualization_domains);
        if let Some(active_scope) = domains_patch.active_scope {
            domains.active_scope = active_scope;
        }
        if let Some(object_id) = &domains_patch.object_id {
            domains.object_id = Some(object_id.clone());
        }
        if let Some(part_id) = &domains_patch.part_id {
            domains.part_id = Some(part_id.clone());
        }
        presentation.visualization_domains = Some(domains);
    }
    if let Some(sampling_patch) = &update.sampling {
        let mut sampling = presentation
            .visualization_sampling
            .take()
            .unwrap_or_else(|| default_visualization_sampling(1));
        if let Some(profile) = sampling_patch.profile {
            sampling.profile = profile;
        }
        if let Some(max_points) = sampling_patch.max_points {
            sampling.max_points = max_points;
        }
        if let Some(max_glyphs) = sampling_patch.max_glyphs {
            sampling.max_glyphs = max_glyphs;
        }
        if let Some(max_bytes) = sampling_patch.max_bytes {
            sampling.max_bytes = Some(max_bytes);
        }
        if let Some(progressive) = sampling_patch.progressive {
            sampling.progressive = progressive;
        }
        presentation.visualization_sampling = Some(sampling);
    }
    if let Some(fem_patch) = &update.fem {
        let mut fem = presentation
            .visualization_fem
            .take()
            .unwrap_or_else(default_fem_visualization);
        if let Some(topology_mode) = fem_patch.topology_mode {
            fem.topology_mode = topology_mode;
        }
        if let Some(volume_edges_budget) = fem_patch.volume_edges_budget {
            fem.volume_edges_budget = volume_edges_budget;
        }
        presentation.visualization_fem = Some(fem);
    }
    if let Some(slice_patch) = &update.slice {
        let layers = presentation
            .visualization_layers
            .clone()
            .unwrap_or_else(|| default_visualization_layers(presentation, 1));
        let mut slice = presentation
            .visualization_slice
            .take()
            .unwrap_or_else(|| default_slice_visualization_for_presentation(presentation, &layers));
        if let Some(quantity_id) = &slice_patch.quantity_id {
            slice.quantity_id = quantity_id.clone();
        }
        if let Some(component) = slice_patch.component {
            slice.component = component;
        }
        if let Some(axis) = slice_patch.axis {
            slice.axis = axis;
        }
        if let Some(mode) = slice_patch.mode {
            slice.mode = mode;
        }
        if let Some(layer_index) = slice_patch.layer_index {
            slice.layer_index = Some(layer_index);
        }
        if let Some(position_percent) = slice_patch.position_percent {
            slice.position_percent = position_percent;
        }
        if let Some(thickness_percent) = slice_patch.thickness_percent {
            slice.thickness_percent = Some(thickness_percent);
        }
        if let Some(colormap) = &slice_patch.colormap {
            slice.colormap = colormap.clone();
        }
        if let Some(auto_contrast) = slice_patch.auto_contrast {
            slice.auto_contrast = auto_contrast;
        }
        if let Some(show_primitives) = slice_patch.show_primitives {
            slice.show_primitives = show_primitives;
        }
        if let Some(show_mesh) = slice_patch.show_mesh {
            slice.show_mesh = show_mesh;
        }
        if let Some(show_magnetic_texture) = slice_patch.show_magnetic_texture {
            slice.show_magnetic_texture = show_magnetic_texture;
        }
        if let Some(show_airbox) = slice_patch.show_airbox {
            slice.show_airbox = show_airbox;
        }
        if let Some(airbox_render_mode) = slice_patch.airbox_render_mode {
            slice.airbox_render_mode = airbox_render_mode;
        }
        if let Some(show_airbox_vectors) = slice_patch.show_airbox_vectors {
            slice.show_airbox_vectors = show_airbox_vectors;
        }
        if let Some(show_quantity) = slice_patch.show_quantity {
            slice.show_quantity = show_quantity;
        }
        if let Some(show_vectors) = slice_patch.show_vectors {
            slice.show_vectors = show_vectors;
        }
        if let Some(render_mode) = slice_patch.render_mode {
            slice.render_mode = render_mode;
        }
        if let Some(projection_reduction) = &slice_patch.projection_reduction {
            slice.projection_reduction = projection_reduction.clone();
        }
        if let Some(projection_include_air_as_zero) = slice_patch.projection_include_air_as_zero {
            slice.projection_include_air_as_zero = projection_include_air_as_zero;
        }
        if let Some(projection_samples) = slice_patch.projection_samples {
            slice.projection_samples = projection_samples.clamp(1, 512);
        }
        if let Some(projection_resolution) = slice_patch.projection_resolution {
            slice.projection_resolution = projection_resolution.clamp(1, 512);
        }
        presentation.visualization_slice = Some(slice);
    }
    if let Some(trim_patch) = &update.trim {
        let mut trim = presentation
            .visualization_trim
            .take()
            .unwrap_or_else(default_trim_visualization);
        if let Some(enabled) = trim_patch.enabled {
            trim.enabled = enabled;
        }
        if let Some(axes_patch) = &trim_patch.axes {
            apply_trim_axes_patch(&mut trim.axes, axes_patch);
        }
        let clip = compatibility_clip_from_trim(&trim);
        presentation.visualization_trim = Some(trim);
        presentation.visualization_clip = Some(clip);
    }
    if let Some(camera_patch) = &update.camera {
        let mut camera = presentation
            .visualization_camera
            .take()
            .unwrap_or_else(default_camera_visualization);
        apply_camera_patch(&mut camera, camera_patch);
        validate_camera_state(&camera)?;
        presentation.visualization_camera = Some(camera);
    }
    if let Some(clip_patch) = &update.clip {
        let trim_updated_directly = update.trim.is_some();
        let mut clip = presentation.visualization_clip.take().unwrap_or_else(|| {
            compatibility_clip_from_trim(
                &presentation
                    .visualization_trim
                    .clone()
                    .unwrap_or_else(default_trim_visualization),
            )
        });
        if let Some(enabled) = clip_patch.enabled {
            clip.enabled = enabled;
        }
        if let Some(axis) = clip_patch.axis {
            clip.axis = axis;
        }
        if let Some(position_percent) = clip_patch.position_percent {
            clip.position_percent = position_percent;
        }
        if let Some(flipped) = clip_patch.flipped {
            clip.flipped = flipped;
        }
        if !trim_updated_directly {
            let mut trim = presentation
                .visualization_trim
                .take()
                .unwrap_or_else(default_trim_visualization);
            apply_compatibility_clip_to_trim(&mut trim, &clip);
            presentation.visualization_trim = Some(trim);
        }
        presentation.visualization_clip = Some(clip);
    }
    if let Some(style_patch) = &update.vector_style {
        let mut style = presentation
            .visualization_vector_style
            .take()
            .unwrap_or_else(default_vector_style_visualization);
        if let Some(color_mode) = style_patch.color_mode {
            style.color_mode = color_mode;
        }
        if let Some(mono_color) = &style_patch.mono_color {
            style.mono_color = mono_color.clone();
        }
        if let Some(alpha) = style_patch.alpha {
            style.alpha = alpha;
        }
        if let Some(length_scale) = style_patch.length_scale {
            style.length_scale = length_scale;
        }
        if let Some(thickness) = style_patch.thickness {
            style.thickness = thickness;
        }
        if let Some(ferromagnet_visibility) = style_patch.ferromagnet_visibility {
            style.ferromagnet_visibility = ferromagnet_visibility;
        }
        presentation.visualization_vector_style = Some(style);
    }
    if let Some(overrides) = &update.overrides {
        presentation.visualization_overrides = Some(overrides.clone());
    }
    Ok(())
}

fn apply_camera_patch(camera: &mut VisualizationCameraState, patch: &VisualizationCameraPatch) {
    if let Some(projection) = patch.projection {
        camera.projection = projection;
    }
    if let Some(position) = patch.position {
        camera.position = position;
    }
    if let Some(target) = patch.target {
        camera.target = target;
    }
    if let Some(up) = patch.up {
        camera.up = up;
    }
    if let Some(fov_degrees) = patch.fov_degrees {
        camera.fov_degrees = fov_degrees;
    }
    if let Some(orthographic_scale) = patch.orthographic_scale {
        camera.orthographic_scale = Some(orthographic_scale);
    }
}

fn visualization_patch_to_display_patch(update: &VisualizationStatePatch) -> DisplayPatch {
    let quantity = update.quantity.as_ref();
    let layers = update.layers.as_ref();
    let sampling = update.sampling.as_ref();
    let fdm = update.fdm.as_ref();
    let slice = update.slice.as_ref();

    let nested_vectors = layers.and_then(|layers| layers.vectors.as_ref());
    let nested_airbox_vectors = layers
        .and_then(|layers| layers.airbox.as_ref())
        .and_then(|airbox| airbox.vectors.as_ref());

    DisplayPatch {
        active_quantity_id: update.active_quantity_id.clone().or_else(|| {
            quantity
                .as_ref()
                .and_then(|quantity| quantity.active_quantity_id.clone())
        }),
        view_mode: update.view_mode,
        field_component: update.field_component.or_else(|| {
            quantity
                .as_ref()
                .and_then(|quantity| quantity.field_component)
        }),
        colormap: update.colormap.clone().or_else(|| {
            quantity
                .as_ref()
                .and_then(|quantity| quantity.colormap.clone())
        }),
        auto_contrast: update.auto_contrast.or_else(|| {
            quantity
                .as_ref()
                .and_then(|quantity| quantity.auto_contrast)
        }),
        contrast_min: update
            .contrast_min
            .or_else(|| quantity.as_ref().and_then(|quantity| quantity.contrast_min)),
        contrast_max: update
            .contrast_max
            .or_else(|| quantity.as_ref().and_then(|quantity| quantity.contrast_max)),
        vector_glyphs: update.vector_glyphs.or_else(|| {
            nested_vectors
                .and_then(|vectors| vectors.visible)
                .or_else(|| nested_airbox_vectors.and_then(|vectors| vectors.visible))
        }),
        vector_density: update.vector_density.or_else(|| {
            nested_vectors
                .and_then(|vectors| vectors.density)
                .or_else(|| nested_airbox_vectors.and_then(|vectors| vectors.density))
        }),
        slice_mode: update.slice_mode.clone().or_else(|| {
            slice.and_then(|slice| slice.mode).map(|mode| match mode {
                SliceVisualizationMode::AllLayers => "all".to_string(),
                SliceVisualizationMode::Slab => "slab".to_string(),
                SliceVisualizationMode::Single => "single".to_string(),
            })
        }),
        slice_layer: update
            .slice_layer
            .or_else(|| slice.and_then(|slice| slice.layer_index)),
        max_points: update
            .max_points
            .or_else(|| sampling.and_then(|sampling| sampling.max_points)),
        x_chosen_size: update
            .x_chosen_size
            .or_else(|| fdm.and_then(|fdm| fdm.x_chosen_size)),
        y_chosen_size: update
            .y_chosen_size
            .or_else(|| fdm.and_then(|fdm| fdm.y_chosen_size)),
    }
}

async fn emit_display_realtime_change(
    state: &Arc<AppState>,
    display_revision: u64,
) -> Result<(), ApiError> {
    let (session_id, run_id) = current_live_realtime_identity(state).await;
    crate::publish_current_live_realtime_resource_changes(
        state,
        session_id,
        run_id,
        vec![
            RealtimeResourceChange {
                resource: RealtimeResourceName::Display,
                revision: display_revision,
                resource_id: None,
                domain_generation_id: None,
                recommended_fetch: Some("/v2/sessions/current/visualization/display".to_string()),
            },
            RealtimeResourceChange {
                resource: RealtimeResourceName::VisualizationState,
                revision: display_revision,
                resource_id: None,
                domain_generation_id: None,
                recommended_fetch: Some("/v2/sessions/current/visualization/state".to_string()),
            },
        ],
        false,
        0,
    )
    .await
}

async fn current_live_realtime_identity(state: &Arc<AppState>) -> (String, Option<String>) {
    state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| {
            (
                snapshot.session.session_id.clone(),
                snapshot.run.as_ref().map(|run| run.run_id.clone()),
            )
        })
        .unwrap_or_else(|| ("current".to_string(), None))
}

async fn emit_visualization_client_ack_realtime_change(
    state: &Arc<AppState>,
    ack_revision: u64,
) -> Result<(), ApiError> {
    let (session_id, run_id) = current_live_realtime_identity(state).await;
    crate::publish_current_live_realtime_resource_changes(
        state,
        session_id,
        run_id,
        vec![RealtimeResourceChange {
            resource: RealtimeResourceName::VisualizationClientAcks,
            revision: ack_revision,
            resource_id: None,
            domain_generation_id: None,
            recommended_fetch: Some("/v2/sessions/current/visualization/client-acks".to_string()),
        }],
        false,
        0,
    )
    .await
}

fn build_visualization_client_ack_entry(
    request: &VisualizationClientAckRequest,
) -> Result<VisualizationClientAckEntry, ApiError> {
    let client_id = validated_ack_string("client_id", &request.client_id, 128)?;
    let client_label =
        validated_optional_ack_string("client_label", request.client_label.as_deref(), 128)?;
    let viewport_id =
        validated_optional_ack_string("viewport_id", request.viewport_id.as_deref(), 96)?;
    let effective_render_mode = validated_optional_ack_string(
        "effective_render_mode",
        request.effective_render_mode.as_deref(),
        128,
    )?;
    let error = validated_optional_ack_string("error", request.error.as_deref(), 512)?;

    Ok(VisualizationClientAckEntry {
        client_id,
        client_label,
        viewport_id,
        revision: request.revision,
        status: request.status,
        effective_render_mode,
        error,
        received_at_unix_ms: unix_ms_now(),
    })
}

fn visualization_client_ack_key(entry: &VisualizationClientAckEntry) -> String {
    match entry.viewport_id.as_deref() {
        Some(viewport_id) => format!("{}\u{1f}{viewport_id}", entry.client_id),
        None => entry.client_id.clone(),
    }
}

fn validated_ack_string(
    field: &'static str,
    value: &str,
    max_len: usize,
) -> Result<String, ApiError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad_request(format!("{field} must not be empty")));
    }
    if trimmed.len() > max_len {
        return Err(ApiError::bad_request(format!(
            "{field} must be at most {max_len} bytes"
        )));
    }
    Ok(trimmed.to_string())
}

fn validated_optional_ack_string(
    field: &'static str,
    value: Option<&str>,
    max_len: usize,
) -> Result<Option<String>, ApiError> {
    value
        .map(|value| validated_ack_string(field, value, max_len))
        .transpose()
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn visualization_state_to_display_selection(
    replacement: &VisualizationStateResource,
) -> DisplaySelection {
    DisplaySelection {
        active_quantity_id: replacement.active_quantity_id.clone(),
        view_mode: replacement.view_mode,
        field_component: replacement.field_component,
        colormap: replacement.colormap.clone(),
        auto_contrast: replacement.auto_contrast,
        contrast_min: replacement.contrast_min,
        contrast_max: replacement.contrast_max,
        vector_glyphs: replacement.vector_glyphs,
        vector_density: replacement.vector_density,
        slice_mode: replacement.slice_mode.clone(),
        slice_layer: replacement.slice_layer,
        max_points: replacement.max_points,
        x_chosen_size: replacement.x_chosen_size,
        y_chosen_size: replacement.y_chosen_size,
    }
}

pub(crate) fn build_display_selection_response(
    selection: &CurrentDisplaySelection,
    presentation: &DisplayPresentationState,
) -> DisplaySelection {
    DisplaySelection {
        active_quantity_id: selection.selection.quantity.clone(),
        view_mode: match selection.selection.view_mode {
            RunnerDisplayViewMode::TwoD => DisplayViewMode::TwoD,
            RunnerDisplayViewMode::ThreeD => DisplayViewMode::ThreeD,
        },
        field_component: match selection.selection.field_component {
            DisplayFieldComponent::X => FieldComponent::X,
            DisplayFieldComponent::Y => FieldComponent::Y,
            DisplayFieldComponent::Z => FieldComponent::Z,
            DisplayFieldComponent::Magnitude => FieldComponent::Magnitude,
        },
        colormap: presentation.colormap.clone(),
        auto_contrast: selection.selection.auto_scale_enabled,
        contrast_min: presentation.contrast_min,
        contrast_max: presentation.contrast_max,
        vector_glyphs: presentation.vector_glyphs,
        vector_density: selection.selection.every_n,
        slice_mode: if selection.selection.all_layers {
            "all".into()
        } else {
            "single".into()
        },
        slice_layer: selection.selection.layer as i32,
        max_points: selection.selection.max_points,
        x_chosen_size: selection.selection.x_chosen_size,
        y_chosen_size: selection.selection.y_chosen_size,
    }
}

fn basic_layer(visible: bool, opacity: f64) -> BasicLayerState {
    BasicLayerState { visible, opacity }
}

pub(crate) fn build_visualization_state_response(
    selection: &CurrentDisplaySelection,
    presentation: &DisplayPresentationState,
    live_snapshot: Option<&SessionStateResponse>,
) -> VisualizationStateResource {
    let quantity = QuantityProjection {
        active_quantity_id: selection.selection.quantity.clone(),
        field_component: match selection.selection.field_component {
            DisplayFieldComponent::X => FieldComponent::X,
            DisplayFieldComponent::Y => FieldComponent::Y,
            DisplayFieldComponent::Z => FieldComponent::Z,
            DisplayFieldComponent::Magnitude => FieldComponent::Magnitude,
        },
        colormap: presentation.colormap.clone(),
        auto_contrast: selection.selection.auto_scale_enabled,
        contrast_min: presentation.contrast_min,
        contrast_max: presentation.contrast_max,
    };
    let vector_density = selection.selection.every_n.max(1);
    let max_points = selection.selection.max_points.max(1);
    let mut layers = presentation
        .visualization_layers
        .clone()
        .unwrap_or_else(|| default_visualization_layers(presentation, vector_density));
    layers.vectors.visible = presentation.vector_glyphs;
    layers.vectors.density = vector_density;
    let mut sampling = presentation
        .visualization_sampling
        .clone()
        .unwrap_or_else(|| default_visualization_sampling(max_points));
    sampling.max_points = max_points;
    let domains = presentation
        .visualization_domains
        .clone()
        .unwrap_or_else(default_visualization_domains);
    let fem = presentation
        .visualization_fem
        .clone()
        .unwrap_or_else(default_fem_visualization);
    let slice = presentation
        .visualization_slice
        .clone()
        .unwrap_or_else(|| default_slice_visualization(selection, presentation, &layers));
    let trim = presentation
        .visualization_trim
        .clone()
        .unwrap_or_else(default_trim_visualization);
    let camera = presentation
        .visualization_camera
        .clone()
        .unwrap_or_else(default_camera_visualization);
    let clip = presentation
        .visualization_clip
        .clone()
        .unwrap_or_else(|| compatibility_clip_from_trim(&trim));
    let vector_style = presentation
        .visualization_vector_style
        .clone()
        .unwrap_or_else(default_vector_style_visualization);
    let overrides = presentation
        .visualization_overrides
        .clone()
        .unwrap_or_default();
    let targets =
        build_visualization_target_registry(&layers, &vector_style, &overrides, live_snapshot);

    VisualizationStateResource {
        revision: selection.revision,
        schema_version: 4,
        quantity: crate::schemas::visualization_state::QuantityVisualizationState {
            active_quantity_id: quantity.active_quantity_id.clone(),
            field_component: quantity.field_component,
            colormap: quantity.colormap.clone(),
            auto_contrast: quantity.auto_contrast,
            contrast_min: quantity.contrast_min,
            contrast_max: quantity.contrast_max,
        },
        layers,
        domains,
        sampling,
        fdm: FdmVisualizationState {
            x_chosen_size: selection.selection.x_chosen_size,
            y_chosen_size: selection.selection.y_chosen_size,
        },
        fem,
        slice,
        trim,
        camera,
        clip,
        vector_style,
        overrides,
        targets,
        diagnostics: VisualizationDiagnostics {
            warnings: Vec::new(),
            degraded_reasons: Vec::new(),
        },
        active_quantity_id: quantity.active_quantity_id,
        view_mode: match selection.selection.view_mode {
            RunnerDisplayViewMode::TwoD => DisplayViewMode::TwoD,
            RunnerDisplayViewMode::ThreeD => DisplayViewMode::ThreeD,
        },
        field_component: quantity.field_component,
        colormap: quantity.colormap,
        auto_contrast: quantity.auto_contrast,
        contrast_min: quantity.contrast_min,
        contrast_max: quantity.contrast_max,
        vector_glyphs: presentation.vector_glyphs,
        vector_density,
        slice_mode: if selection.selection.all_layers {
            "all".into()
        } else {
            "single".into()
        },
        slice_layer: selection.selection.layer as i32,
        max_points,
        x_chosen_size: selection.selection.x_chosen_size,
        y_chosen_size: selection.selection.y_chosen_size,
    }
}

fn build_visualization_target_registry(
    layers: &VisualizationLayerState,
    vector_style: &VectorStyleVisualizationState,
    overrides: &[VisualizationOverrideState],
    live_snapshot: Option<&SessionStateResponse>,
) -> VisualizationTargetRegistryState {
    VisualizationTargetRegistryState {
        airbox: visualization_target_registry_entry(
            VisualizationScopeKind::Airbox,
            "airbox",
            "Airbox",
            VisualizationTargetSource::Airbox,
            airbox_target_settings(layers, vector_style),
            overrides,
        ),
        objects: live_snapshot
            .and_then(|snapshot| snapshot.scene_document.as_ref())
            .map(|scene| {
                scene
                    .objects
                    .iter()
                    .map(|object| {
                        visualization_target_registry_entry(
                            VisualizationScopeKind::Object,
                            &object.id,
                            &object.name,
                            VisualizationTargetSource::SceneObject,
                            object_target_settings(layers, vector_style),
                            overrides,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
        parts: live_snapshot
            .and_then(|snapshot| snapshot.fem_mesh.as_ref())
            .map(|mesh| {
                mesh.mesh_parts
                    .iter()
                    .map(|part| {
                        visualization_target_registry_entry(
                            VisualizationScopeKind::Part,
                            &part.id,
                            &part.label,
                            VisualizationTargetSource::MeshPart,
                            object_target_settings(layers, vector_style),
                            overrides,
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn visualization_target_registry_entry(
    scope: VisualizationScopeKind,
    scope_id: &str,
    label: &str,
    source: VisualizationTargetSource,
    settings: VisualizationResolvedTargetSettings,
    overrides: &[VisualizationOverrideState],
) -> VisualizationTargetRegistryEntry {
    let override_state = overrides
        .iter()
        .find(|entry| entry.scope == scope && entry.scope_id == scope_id)
        .cloned();
    let settings = override_state
        .as_ref()
        .map(|entry| apply_visualization_target_override(settings.clone(), entry))
        .unwrap_or(settings);

    VisualizationTargetRegistryEntry {
        scope,
        scope_id: scope_id.to_string(),
        label: label.to_string(),
        source,
        settings,
        override_state,
    }
}

fn object_target_settings(
    layers: &VisualizationLayerState,
    vector_style: &VectorStyleVisualizationState,
) -> VisualizationResolvedTargetSettings {
    let mut settings = VisualizationResolvedTargetSettings {
        visible: true,
        bounds_visible: layers.bounds.visible,
        geometry_scope: VisualizationTargetGeometryScope::Full,
        opacity: layers.surface.opacity,
        points_visible: layers.points.visible,
        render_mode: VisualizationTargetRenderMode::Surface,
        surface_color_source: surface_color_source_from_vector_color_mode(vector_style.color_mode),
        surface_mono_color: vector_style.mono_color.clone(),
        surface_visible: layers.surface.visible,
        vector_alpha: vector_style.alpha,
        vector_budget: layers.vectors.density,
        vector_color_mode: vector_style.color_mode,
        vector_length_scale: vector_style.length_scale,
        vector_mono_color: vector_style.mono_color.clone(),
        vector_thickness: vector_style.thickness,
        vectors_visible: layers.vectors.visible,
        wireframe_color: "var(--fm-border-strong)".to_string(),
        wireframe_opacity: layers.wireframe.opacity,
        wireframe_visible: layers.wireframe.visible,
    };
    settings.render_mode = visualization_target_render_mode(&settings);
    settings
}

fn airbox_target_settings(
    layers: &VisualizationLayerState,
    vector_style: &VectorStyleVisualizationState,
) -> VisualizationResolvedTargetSettings {
    let mut settings = VisualizationResolvedTargetSettings {
        visible: layers.airbox.visible,
        bounds_visible: layers.airbox.bounds.visible,
        geometry_scope: VisualizationTargetGeometryScope::Full,
        opacity: layers.airbox.opacity,
        points_visible: layers.airbox.points.visible,
        render_mode: VisualizationTargetRenderMode::Wireframe,
        surface_color_source: SurfaceColorSource::Solid,
        surface_mono_color: "var(--fm-airbox-fill)".to_string(),
        surface_visible: layers.airbox.surface.visible,
        vector_alpha: 1.0,
        vector_budget: layers.airbox.vectors.density,
        vector_color_mode: VectorColorMode::Orientation,
        vector_length_scale: vector_style.length_scale,
        vector_mono_color: "var(--fm-accent)".to_string(),
        vector_thickness: 1.0,
        vectors_visible: layers.airbox.vectors.visible,
        wireframe_color: "var(--fm-airbox-wire)".to_string(),
        wireframe_opacity: layers.airbox.wireframe.opacity,
        wireframe_visible: layers.airbox.wireframe.visible,
    };
    settings.render_mode = visualization_target_render_mode(&settings);
    settings
}

fn apply_visualization_target_override(
    mut settings: VisualizationResolvedTargetSettings,
    override_state: &VisualizationOverrideState,
) -> VisualizationResolvedTargetSettings {
    if let Some(visible) = override_state.visible {
        settings.visible = visible;
    }
    if let Some(display) = &override_state.display {
        if let Some(visible) = display.visible {
            settings.visible = visible;
        }
        if let Some(bounds) = &display.bounds {
            if let Some(visible) = bounds.visible {
                settings.bounds_visible = visible;
            }
        }
        if let Some(surface) = &display.surface {
            if let Some(visible) = surface.visible {
                settings.surface_visible = visible;
            }
            if let Some(opacity) = surface.opacity {
                settings.opacity = opacity;
            }
        }
        if let Some(wireframe) = &display.wireframe {
            if let Some(visible) = wireframe.visible {
                settings.wireframe_visible = visible;
            }
            if let Some(opacity) = wireframe.opacity {
                settings.wireframe_opacity = opacity;
            }
        }
        if let Some(points) = &display.points {
            if let Some(visible) = points.visible {
                settings.points_visible = visible;
            }
        }
        if let Some(vectors) = &display.vectors {
            if let Some(visible) = vectors.visible {
                settings.vectors_visible = visible;
            }
        }
        if let Some(opacity) = display.opacity {
            settings.opacity = opacity;
        }
        if let Some(geometry_scope) = display.geometry_scope {
            settings.geometry_scope = geometry_scope;
        }
    }
    if let Some(style) = &override_state.style {
        if let Some(surface_color_source) = style.surface_color_source {
            settings.surface_color_source = surface_color_source;
        }
        if let Some(surface_mono_color) = &style.surface_mono_color {
            settings.surface_mono_color = surface_mono_color.clone();
        }
        if let Some(vector_color_mode) = style.vector_color_mode {
            settings.vector_color_mode = vector_color_mode;
        }
        if let Some(vector_mono_color) = &style.vector_mono_color {
            settings.vector_mono_color = vector_mono_color.clone();
        }
        if let Some(vector_alpha) = style.vector_alpha {
            settings.vector_alpha = vector_alpha;
        }
        if let Some(vector_budget) = style.vector_budget {
            settings.vector_budget = vector_budget;
        }
        if let Some(vector_length_scale) = style.vector_length_scale {
            settings.vector_length_scale = vector_length_scale;
        }
        if let Some(vector_thickness) = style.vector_thickness {
            settings.vector_thickness = vector_thickness;
        }
        if let Some(wireframe_color) = &style.wireframe_color {
            settings.wireframe_color = wireframe_color.clone();
        }
    }
    settings.render_mode = visualization_target_render_mode(&settings);
    settings
}

fn visualization_target_render_mode(
    settings: &VisualizationResolvedTargetSettings,
) -> VisualizationTargetRenderMode {
    if settings.points_visible {
        return VisualizationTargetRenderMode::Points;
    }
    if settings.surface_visible && settings.wireframe_visible {
        return VisualizationTargetRenderMode::SurfaceEdges;
    }
    if settings.surface_visible {
        return VisualizationTargetRenderMode::Surface;
    }
    VisualizationTargetRenderMode::Wireframe
}

fn surface_color_source_from_vector_color_mode(color_mode: VectorColorMode) -> SurfaceColorSource {
    match color_mode {
        VectorColorMode::Orientation => SurfaceColorSource::Orientation,
        VectorColorMode::X => SurfaceColorSource::ComponentX,
        VectorColorMode::Y => SurfaceColorSource::ComponentY,
        VectorColorMode::Z => SurfaceColorSource::ComponentZ,
        VectorColorMode::Magnitude => SurfaceColorSource::Magnitude,
        VectorColorMode::Monochrome => SurfaceColorSource::Solid,
    }
}

struct QuantityProjection {
    active_quantity_id: String,
    field_component: FieldComponent,
    colormap: String,
    auto_contrast: bool,
    contrast_min: Option<f64>,
    contrast_max: Option<f64>,
}
