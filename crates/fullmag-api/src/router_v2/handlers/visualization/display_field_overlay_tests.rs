use super::*;
use crate::schemas::visualization_state::{PlanarFieldOverlayState, PlanarViewScopeState};

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
    let before = state.clone();
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
        vec![valid.clone(); 5],
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
