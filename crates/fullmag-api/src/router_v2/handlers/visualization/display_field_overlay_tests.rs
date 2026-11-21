use super::*;
use crate::schemas::visualization_state::{
    migrate_planar_layer_model, PlanarCropState, PlanarFieldOverlayState, PlanarLayerModel,
    PlanarViewScopeState,
};

fn overlay(id: &str) -> PlanarFieldOverlayState {
    let base = default_planar_visualization_state();
    PlanarFieldOverlayState {
        id: id.into(),
        quantity_id: "m".into(),
        component: base.component,
        view_scope: PlanarViewScopeState::MonitorTarget,
        colormap: base.colormap,
        range: base.range,
        raster_opacity: 0.7,
        raster_visible: false,
        vectors_visible: true,
        vector_style: base.vector_style,
        visible: true,
        points_visible: false,
        mesh_visible: false,
        contours_visible: false,
        streamlines_visible: false,
    }
}

#[test]
fn field_overlays_legacy_default_and_persisted_roundtrip() {
    let mut value = serde_json::to_value(default_planar_visualization_state()).unwrap();
    value.as_object_mut().unwrap().remove("field_overlays");
    let mut restored: PlanarVisualizationState = serde_json::from_value(value).unwrap();
    assert!(restored.field_overlays.is_empty());
    restored.field_overlays = vec![overlay("magnetization")];
    let roundtrip: PlanarVisualizationState =
        serde_json::from_value(serde_json::to_value(&restored).unwrap()).unwrap();
    assert_eq!(roundtrip, restored);
}

#[test]
fn field_overlay_patch_replaces_only_its_list_and_omission_preserves_it() {
    let mut state = default_planar_visualization_state();
    let mut before = state.clone();
    before.field_overlays.clear();
    let patch = PlanarVisualizationPatch {
        field_overlays: Some(vec![overlay("m")]),
        ..Default::default()
    };
    assert!(validate_planar_visualization_patch(&patch).is_ok());
    apply_planar_visualization_patch(&mut state, &patch);
    let overlays = std::mem::take(&mut state.field_overlays);
    assert_eq!(state, before);
    state.field_overlays = overlays;
    apply_planar_visualization_patch(
        &mut state,
        &PlanarVisualizationPatch {
            raster_opacity: Some(0.3),
            ..Default::default()
        },
    );
    assert_eq!(state.field_overlays, vec![overlay("m")]);
    apply_planar_visualization_patch(
        &mut state,
        &PlanarVisualizationPatch {
            field_overlays: Some(vec![]),
            ..Default::default()
        },
    );
    assert!(state.field_overlays.is_empty());
}

#[test]
fn field_overlay_validation_rejects_duplicate_ids_overflow_and_invalid_styles() {
    let valid = overlay("m");
    for entries in [
        vec![valid.clone(), valid.clone()],
        (0..17).map(|index| overlay(&format!("layer-{index}"))).collect(),
        vec![overlay(" ")],
    ] {
        assert!(
            validate_planar_visualization_patch(&PlanarVisualizationPatch {
                field_overlays: Some(entries),
                ..Default::default()
            })
            .is_err()
        );
    }
    let mut cases = Vec::new();
    let mut item = valid.clone();
    item.raster_opacity = f64::NAN;
    cases.push(item);
    let mut item = valid.clone();
    item.vector_style.thickness = 17.0;
    cases.push(item);
    let mut item = valid.clone();
    item.quantity_id = "unknown-quantity".into();
    cases.push(item);
    let mut item = valid.clone();
    item.colormap.clear();
    cases.push(item);
    let mut item = valid.clone();
    item.range.mode = PlanarColorRangeMode::Manual;
    item.range.min = Some(1.0);
    item.range.max = Some(0.0);
    cases.push(item);
    let mut item = valid;
    item.view_scope = PlanarViewScopeState::Region {
        scope_id: "object".into(),
        region_id: "".into(),
    };
    cases.push(item);
    for item in cases {
        assert!(
            validate_planar_visualization_patch(&PlanarVisualizationPatch {
                field_overlays: Some(vec![item]),
                ..Default::default()
            })
            .is_err()
        );
    }
    let mut state = default_planar_visualization_state();
    state.field_overlays = vec![overlay("duplicate"), overlay("duplicate")];
    assert!(validate_planar_visualization_state(&state).is_err());
}

#[test]
fn observation_demand_tracks_only_visible_overlay_fields() {
    let selection = CurrentDisplaySelection::default();
    let presentation = DisplayPresentationState::default();
    let mut state = build_visualization_state_response(&selection, &presentation, None);
    state.planar.quantity_id = "H_demag".into();
    let mut extra = overlay("magnet");
    extra.quantity_id = "H_eff".into();
    state.planar.field_overlays = vec![extra];
    let demand = observation_quantities_for_visualization_state(&state);
    assert!(demand.contains(&"H_eff".to_owned()));
    assert!(demand.contains(&"H_demag".to_owned()));
    state.planar.field_overlays[0].vectors_visible = false;
    assert!(!observation_quantities_for_visualization_state(&state).contains(&"H_eff".to_owned()));
    state.planar.field_overlays[0].raster_visible = true;
    assert!(observation_quantities_for_visualization_state(&state).contains(&"H_eff".to_owned()));
    state.planar.visible = false;
    assert!(!observation_quantities_for_visualization_state(&state).contains(&"H_eff".to_owned()));
}

fn legacy_state_with_base(quantity_id: &str) -> PlanarVisualizationState {
    let mut state = default_planar_visualization_state();
    state.layer_model = PlanarLayerModel::Legacy;
    state.quantity_id = quantity_id.into();
    state.field_overlays = vec![overlay("object:film")];
    state
}

#[test]
fn legacy_base_field_becomes_last_layer() {
    let mut state = legacy_state_with_base("h_demag");
    state.layers.raster = true;
    migrate_planar_layer_model(&mut state);
    assert_eq!(state.layer_model, PlanarLayerModel::Layers);
    assert_eq!(state.field_overlays.len(), 2);
    assert_eq!(state.field_overlays[0].id, "object:film");
    assert!(state.field_overlays[0].visible);
    assert_eq!(state.field_overlays[1].id, "all");
    assert_eq!(state.field_overlays[1].quantity_id, "h_demag");
    assert!(state.field_overlays[1].raster_visible);
    assert_eq!(state.field_overlays[1].view_scope, state.view_scope);
}

#[test]
fn migration_is_idempotent() {
    let mut state = legacy_state_with_base("h_demag");
    state.layers.raster = true;
    migrate_planar_layer_model(&mut state);
    let once = state.clone();
    migrate_planar_layer_model(&mut state);
    assert_eq!(state, once);
}

#[test]
fn legacy_hidden_base_adds_no_layer() {
    let mut state = legacy_state_with_base("h_demag");
    state.layers.raster = false;
    state.layers.vectors = false;
    migrate_planar_layer_model(&mut state);
    assert_eq!(state.layer_model, PlanarLayerModel::Layers);
    assert_eq!(state.field_overlays.len(), 1);
    assert!(state.field_overlays.iter().all(|layer| layer.id != "all"));
}

#[test]
fn default_state_starts_with_one_all_layer() {
    let state = default_planar_visualization_state();
    assert_eq!(state.layer_model, PlanarLayerModel::Layers);
    assert_eq!(state.field_overlays.len(), 1);
    let layer = &state.field_overlays[0];
    assert_eq!(layer.id, "all");
    assert_eq!(layer.quantity_id, "m");
    assert_eq!(layer.view_scope, PlanarViewScopeState::MonitorTarget);
    assert!(layer.visible && layer.raster_visible);
    assert!(state.crop.is_none());
}

#[test]
fn patch_rejects_seventeen_layers() {
    let error = validate_planar_visualization_patch(&PlanarVisualizationPatch {
        field_overlays: Some((0..17).map(|index| overlay(&format!("layer-{index}"))).collect()),
        ..Default::default()
    })
    .expect_err("17 layers exceed the limit");
    assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.message,
        "planar.field_overlays must contain at most 16 entries"
    );
}

#[test]
fn patch_accepts_sixteen_layers() {
    assert!(validate_planar_visualization_patch(&PlanarVisualizationPatch {
        field_overlays: Some((0..16).map(|index| overlay(&format!("layer-{index}"))).collect()),
        ..Default::default()
    })
    .is_ok());
}

#[test]
fn crop_patch_rejects_inverted_bounds() {
    let error = validate_planar_visualization_patch(&PlanarVisualizationPatch {
        crop: Some(Some(PlanarCropState {
            u_min_m: 1.0,
            u_max_m: 0.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        })),
        ..Default::default()
    })
    .expect_err("inverted crop is invalid");
    assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    assert!(error.message.starts_with("invalid_planar_crop"));
}

#[test]
fn crop_patch_null_clears_crop() {
    let mut state = default_planar_visualization_state();
    state.crop = Some(PlanarCropState {
        u_min_m: 0.0,
        u_max_m: 1.0,
        v_min_m: 0.0,
        v_max_m: 1.0,
    });
    let patch: PlanarVisualizationPatch =
        serde_json::from_value(serde_json::json!({ "crop": null })).unwrap();
    assert_eq!(patch.crop, Some(None));
    assert!(validate_planar_visualization_patch(&patch).is_ok());
    apply_planar_visualization_patch(&mut state, &patch);
    assert_eq!(state.crop, None);
}

#[test]
fn plane_change_without_crop_clears_crop_and_explicit_crop_wins() {
    let crop = PlanarCropState {
        u_min_m: 0.0,
        u_max_m: 1.0,
        v_min_m: 0.0,
        v_max_m: 1.0,
    };
    let mut state = default_planar_visualization_state();
    state.crop = Some(crop.clone());
    let mut slice = state.default_slice.clone();
    slice.position_fraction = 0.25;
    apply_planar_visualization_patch(
        &mut state,
        &PlanarVisualizationPatch {
            default_slice: Some(slice.clone()),
            ..Default::default()
        },
    );
    assert_eq!(state.crop, Some(crop.clone()), "same plane keeps the crop");
    slice.plane = crate::schemas::visualization_state::PlanarAxisPlane::Xz;
    apply_planar_visualization_patch(
        &mut state,
        &PlanarVisualizationPatch {
            default_slice: Some(slice.clone()),
            ..Default::default()
        },
    );
    assert_eq!(state.crop, None);
    slice.plane = crate::schemas::visualization_state::PlanarAxisPlane::Yz;
    apply_planar_visualization_patch(
        &mut state,
        &PlanarVisualizationPatch {
            default_slice: Some(slice),
            crop: Some(Some(crop.clone())),
            ..Default::default()
        },
    );
    assert_eq!(state.crop, Some(crop));
}

#[test]
fn overlay_without_new_flags_deserializes() {
    let mut value = serde_json::to_value(overlay("legacy")).unwrap();
    let object = value.as_object_mut().unwrap();
    for field in [
        "visible",
        "points_visible",
        "mesh_visible",
        "contours_visible",
        "streamlines_visible",
    ] {
        object.remove(field);
    }
    let restored: PlanarFieldOverlayState = serde_json::from_value(value).unwrap();
    assert!(restored.visible);
    assert!(!restored.points_visible);
    assert!(!restored.mesh_visible);
    assert!(!restored.contours_visible);
    assert!(!restored.streamlines_visible);
}

#[test]
fn state_without_layer_model_restores_as_legacy() {
    let mut value = serde_json::to_value(default_planar_visualization_state()).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("layer_model");
    object.remove("crop");
    let restored: PlanarVisualizationState = serde_json::from_value(value).unwrap();
    assert_eq!(restored.layer_model, PlanarLayerModel::Legacy);
    assert_eq!(restored.crop, None);
}
