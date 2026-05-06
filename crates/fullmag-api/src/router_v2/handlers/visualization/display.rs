//! Display mutation endpoints.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use crate::error::ApiError;
use crate::schemas::display::DisplayPatch;
use crate::schemas::status::{DisplaySelection, DisplayViewMode, FieldComponent};
use crate::schemas::visualization_state::{
    AirboxLayerPatch, AirboxLayerState, BasicLayerPatch, BasicLayerState, ClipAxis,
    ClipVisualizationState, DomainVisualizationState, FdmVisualizationState, FemTopologyMode,
    FemVisualizationState, FerromagnetVisibilityMode, SamplingProfile, SamplingVisualizationState,
    SliceAirboxRenderMode, SliceRenderMode, SliceVisualizationMode, SliceVisualizationState,
    VectorColorMode, VectorLayerDomain, VectorLayerPatch, VectorLayerState,
    VectorStyleVisualizationState, VisualizationDiagnostics, VisualizationLayerPatch,
    VisualizationLayerState, VisualizationScopeKind, VisualizationStatePatch,
    VisualizationStateResource,
};
use crate::types::{AppState, CurrentDisplaySelection, DisplayPresentationState};
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
    Ok(Json(build_visualization_state_response(
        &selection,
        &presentation,
    )))
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
    let display_replacement = visualization_state_to_display_selection(&replacement);
    apply_display_replace(state.clone(), display_replacement).await?;
    {
        let mut presentation = state.current_display_presentation.write().await;
        presentation.visualization_layers = Some(replacement.layers);
        presentation.visualization_domains = Some(replacement.domains);
        presentation.visualization_sampling = Some(replacement.sampling);
        presentation.visualization_fem = Some(replacement.fem);
        presentation.visualization_slice = Some(replacement.slice);
        presentation.visualization_clip = Some(replacement.clip);
        presentation.visualization_vector_style = Some(replacement.vector_style);
        presentation.visualization_overrides = Some(replacement.overrides);
    }
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    Ok(Json(build_visualization_state_response(
        &selection,
        &presentation,
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
    apply_display_patch(state.clone(), display_patch).await?;
    {
        let mut presentation = state.current_display_presentation.write().await;
        apply_visualization_presentation_patch(&mut presentation, &update);
    }
    let selection = state.current_display_selection.read().await;
    let presentation = state.current_display_presentation.read().await;
    Ok(Json(build_visualization_state_response(
        &selection,
        &presentation,
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
    let display_revision = sel.revision;
    let response = build_display_selection_response(&sel, &presentation);
    drop(presentation);
    drop(sel);
    emit_display_realtime_change(&state, display_revision).await?;

    Ok(response)
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
    Ok(())
}

fn default_visualization_layers(
    presentation: &DisplayPresentationState,
    vector_density: u32,
) -> VisualizationLayerState {
    VisualizationLayerState {
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
) {
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
        presentation.visualization_slice = Some(slice);
    }
    if let Some(clip_patch) = &update.clip {
        let mut clip = presentation
            .visualization_clip
            .take()
            .unwrap_or_else(default_clip_visualization);
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
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0)
            .await?;
    }
    Ok(())
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
    let clip = presentation
        .visualization_clip
        .clone()
        .unwrap_or_else(default_clip_visualization);
    let vector_style = presentation
        .visualization_vector_style
        .clone()
        .unwrap_or_else(default_vector_style_visualization);
    let overrides = presentation
        .visualization_overrides
        .clone()
        .unwrap_or_default();

    VisualizationStateResource {
        revision: selection.revision,
        schema_version: 2,
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
        clip,
        vector_style,
        overrides,
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

struct QuantityProjection {
    active_quantity_id: String,
    field_component: FieldComponent,
    colormap: String,
    auto_contrast: bool,
    contrast_min: Option<f64>,
    contrast_max: Option<f64>,
}
