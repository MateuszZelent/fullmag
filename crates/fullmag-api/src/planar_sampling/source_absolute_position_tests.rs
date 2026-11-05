use super::*;
use crate::schemas::domain::{Bounds3, DomainCounts, StructuredGridDescriptor};
use crate::schemas::visualization_state::{default_planar_visualization_state, PlanarAxisPlane};

fn domain(z_origin: f64, spacing: f64) -> DomainMeta {
    DomainMeta {
        domain_id: "current".into(),
        discretization: "fdm".into(),
        generation_id: "grid".into(),
        dimension: 3,
        coordinate_system: "cartesian".into(),
        units: Default::default(),
        bounds: Bounds3 {
            min: [0.0, 0.0, z_origin],
            max: [4.0, 4.0, z_origin + 4.0 * spacing],
        },
        counts: DomainCounts {
            cells: Some(64),
            nodes: None,
            elements: None,
            boundary_faces: None,
        },
        grid: Some(StructuredGridDescriptor {
            shape: [4, 4, 4],
            origin: [0.0, 0.0, z_origin],
            spacing: [1.0, 1.0, spacing],
        }),
        element_type: None,
    }
}

#[test]
fn absolute_position_aligns_different_grid_origins_without_cell_center_snapping() {
    let mut slice = default_planar_visualization_state().default_slice;
    slice.plane = PlanarAxisPlane::Xy;
    let a = resolve_default_planar_source_at_position(&domain(0.0, 1.0), &slice, None, Some(1.3))
        .unwrap();
    let b = resolve_default_planar_source_at_position(&domain(0.2, 0.7), &slice, None, Some(1.3))
        .unwrap();
    assert_eq!(a.frame.origin_m, [2.0, 2.0, 1.3]);
    assert_eq!(b.frame.origin_m, a.frame.origin_m);
    for source in [&a, &b] {
        let section = source.section.as_ref().unwrap();
        assert_eq!(section.requested_coordinate_m, 1.3);
        assert_eq!(section.resolved_coordinate_m, 1.3);
        assert_eq!(section.stops_kind, "continuous");
        assert_eq!(section.layer_index, None);
    }
    let shifted =
        resolve_default_planar_source_at_position(&domain(0.0, 1.0), &slice, None, Some(1.4))
            .unwrap();
    assert_ne!(a.identity.source_hash, shifted.identity.source_hash);
}

#[test]
fn absolute_position_never_snaps_fem_nodes_or_clamps_outside_extent() {
    let mut d = domain(0.0, 1.0);
    d.discretization = "fem".into();
    d.grid = None;
    let mut slice = default_planar_visualization_state().default_slice;
    slice.plane = PlanarAxisPlane::Xy;
    let stops = FemNodePlaneStops {
        axis: 2,
        coordinates_m: vec![0.0, 2.0, 4.0],
        tolerance_m: 0.01,
    };
    let source =
        resolve_default_planar_source_at_position(&d, &slice, Some(&stops), Some(2.001)).unwrap();
    assert_eq!(source.frame.origin_m[2], 2.001);
    let outside =
        resolve_default_planar_source_at_position(&d, &slice, Some(&stops), Some(8.0)).unwrap();
    assert_eq!(outside.frame.origin_m[2], 8.0);
    assert!(resolve_default_planar_source_at_position(&d, &slice, None, Some(f64::NAN)).is_err());
    assert!(
        resolve_default_planar_source_at_position(&d, &slice, None, Some(f64::INFINITY)).is_err()
    );
}
