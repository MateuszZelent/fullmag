use std::collections::HashMap;

use super::frame::ResolvedFrame;
use super::{FemPlanarField, PlanarMeshOverlay, PlanarOverlayPolygon, PlanarOverlaySegment, PlanarOverlaySegmentKind};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CutVertex {
    pub uv_local: [f64; 2],
    pub world_position: [f64; 3],
    pub parent_element_id: u32,
    pub reference_coordinate: [f64; 3],
    pub barycentric_weights: [f64; 6],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderTriangle {
    pub vertices: [usize; 3],
    pub parent_element_id: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CutSegment {
    pub a_uv_m: [f64; 2],
    pub b_uv_m: [f64; 2],
    pub kind: PlanarOverlaySegmentKind,
    pub parent_element_id: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CutPolygon {
    pub vertices_uv_m: Vec<[f64; 2]>,
    pub parent_element_id: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CutGeometry {
    pub vertices: Vec<CutVertex>,
    pub triangles: Vec<RenderTriangle>,
    pub polygons: Vec<CutPolygon>,
    pub segments: Vec<CutSegment>,
    pub bounds_uv: [f64; 4],
}

#[derive(Clone, Debug)]
struct IntersectionVertex {
    uv: [f64; 2],
    world: [f64; 3],
    edge_nodes: [u32; 2],
    weights: [f64; 6],
    ref_coord: [f64; 3],
}

pub(super) fn build_cut_geometry(
    field: &FemPlanarField,
    frame: &ResolvedFrame,
    clip_extent: Option<[f64; 4]>,
) -> CutGeometry {
    let target_face_counts = selected_face_counts(field);
    let mut cut_vertices = Vec::new();
    let mut render_triangles = Vec::new();
    let mut polygons = Vec::new();
    let mut segments = Vec::new();

    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let nodes = element
            .nodes()
            .iter()
            .map(|index| field.nodes()[*index as usize])
            .collect::<Vec<_>>();
        let projected = nodes
            .iter()
            .map(|point| frame.project(*point))
            .collect::<Vec<_>>();

        // Check if element can intersect the plane
        let n_min = projected
            .iter()
            .map(|point| point[2])
            .fold(f64::INFINITY, f64::min);
        let n_max = projected
            .iter()
            .map(|point| point[2])
            .fold(f64::NEG_INFINITY, f64::max);

        // Scale-aware plane distance threshold
        let edge_scale = element.edges().iter().map(|&(a, b)| {
            let dx = nodes[a][0] - nodes[b][0];
            let dy = nodes[a][1] - nodes[b][1];
            let dz = nodes[a][2] - nodes[b][2];
            (dx * dx + dy * dy + dz * dz).sqrt()
        }).fold(0.0_f64, f64::max);
        let plane_eps = (edge_scale * 1e-12).max(1e-15);

        if n_min > plane_eps || n_max < -plane_eps {
            continue;
        }

        let mut polygon_points = Vec::<IntersectionVertex>::new();

        // Check vertex intersections
        for (local_idx, proj) in projected.iter().enumerate() {
            if proj[2].abs() <= plane_eps {
                let mut weights = [0.0; 6];
                if local_idx < 6 {
                    weights[local_idx] = 1.0;
                }
                push_vertex_point(
                    &mut polygon_points,
                    [proj[0], proj[1]],
                    nodes[local_idx],
                    [element.nodes()[local_idx], element.nodes()[local_idx]],
                    weights,
                    [0.0; 3],
                    plane_eps,
                );
            }
        }

        // Check edge intersections
        for &(a, b) in element.edges() {
            let da = projected[a][2];
            let db = projected[b][2];
            if da.abs() <= plane_eps || db.abs() <= plane_eps {
                continue;
            }
            if da.signum() == db.signum() || (da - db).abs() <= f64::EPSILON {
                continue;
            }
            let t = da / (da - db);
            if t <= 0.0 || t >= 1.0 {
                continue;
            }
            let world = [
                nodes[a][0] + t * (nodes[b][0] - nodes[a][0]),
                nodes[a][1] + t * (nodes[b][1] - nodes[a][1]),
                nodes[a][2] + t * (nodes[b][2] - nodes[a][2]),
            ];
            let uv = [
                projected[a][0] + t * (projected[b][0] - projected[a][0]),
                projected[a][1] + t * (projected[b][1] - projected[a][1]),
            ];
            let mut weights = [0.0; 6];
            if a < 6 && b < 6 {
                weights[a] = 1.0 - t;
                weights[b] = t;
            }
            push_vertex_point(
                &mut polygon_points,
                uv,
                world,
                [element.nodes()[a], element.nodes()[b]],
                weights,
                [0.0; 3],
                plane_eps,
            );
        }

        if polygon_points.len() < 3 {
            continue;
        }

        // Sort points angularly around polygon centroid
        let center = [
            polygon_points.iter().map(|p| p.uv[0]).sum::<f64>() / polygon_points.len() as f64,
            polygon_points.iter().map(|p| p.uv[1]).sum::<f64>() / polygon_points.len() as f64,
        ];
        polygon_points.sort_by(|a, b| {
            (a.uv[1] - center[1])
                .atan2(a.uv[0] - center[0])
                .total_cmp(&(b.uv[1] - center[1]).atan2(b.uv[0] - center[0]))
        });

        // Filter out zero-area polygon
        let area = polygon_area(&polygon_points);
        if area.abs() <= 1e-36 {
            continue;
        }

        // Clip polygon to viewport extent if specified
        let final_points = if let Some(bounds) = clip_extent {
            clip_polygon_to_bounds(&polygon_points, bounds)
        } else {
            polygon_points
        };

        if final_points.len() < 3 {
            continue;
        }

        // Add to mesh overlay segments (ONLY the perimeter edges, NEVER the triangulation diagonals!)
        let n_pts = final_points.len();
        for i in 0..n_pts {
            let next = (i + 1) % n_pts;
            let kind = classify_segment(
                &final_points[i],
                &final_points[next],
                &target_face_counts,
                clip_extent,
            );
            segments.push(CutSegment {
                a_uv_m: final_points[i].uv,
                b_uv_m: final_points[next].uv,
                kind,
                parent_element_id: element_index as u32,
            });
        }

        // Record polygon for overlay
        polygons.push(CutPolygon {
            vertices_uv_m: final_points.iter().map(|p| p.uv).collect(),
            parent_element_id: element_index as u32,
        });

        // Triangulate polygon into render triangles (fan from vertex 0)
        let base_vertex_idx = cut_vertices.len();
        for pt in &final_points {
            cut_vertices.push(CutVertex {
                uv_local: pt.uv,
                world_position: pt.world,
                parent_element_id: element_index as u32,
                reference_coordinate: pt.ref_coord,
                barycentric_weights: pt.weights,
            });
        }
        for i in 1..final_points.len() - 1 {
            render_triangles.push(RenderTriangle {
                vertices: [base_vertex_idx, base_vertex_idx + i, base_vertex_idx + i + 1],
                parent_element_id: element_index as u32,
            });
        }
    }

    let mut deduplicated_segments = Vec::with_capacity(segments.len());
    let mut seen_segments = HashMap::new();
    for seg in segments {
        let key = segment_canonical_key(seg.a_uv_m, seg.b_uv_m);
        if let Some(&existing_idx) = seen_segments.get(&key) {
            let existing: &mut CutSegment = &mut deduplicated_segments[existing_idx];
            if existing.kind == PlanarOverlaySegmentKind::TargetBoundary && seg.kind == PlanarOverlaySegmentKind::TargetBoundary {
                existing.kind = PlanarOverlaySegmentKind::MeshInterior;
            } else if seg.kind == PlanarOverlaySegmentKind::MeshInterior {
                existing.kind = PlanarOverlaySegmentKind::MeshInterior;
            }
        } else {
            seen_segments.insert(key, deduplicated_segments.len());
            deduplicated_segments.push(seg);
        }
    }

    CutGeometry {
        vertices: cut_vertices,
        triangles: render_triangles,
        polygons,
        segments: deduplicated_segments,
        bounds_uv: frame.bounds,
    }
}

fn segment_canonical_key(a: [f64; 2], b: [f64; 2]) -> (i64, i64, i64, i64) {
    let ka = ((a[0] * 1e14).round() as i64, (a[1] * 1e14).round() as i64);
    let kb = ((b[0] * 1e14).round() as i64, (b[1] * 1e14).round() as i64);
    if ka <= kb {
        (ka.0, ka.1, kb.0, kb.1)
    } else {
        (kb.0, kb.1, ka.0, ka.1)
    }
}

pub(super) fn cut_geometry_to_planar_mesh_overlay(
    cut: &CutGeometry,
    frame: &ResolvedFrame,
) -> PlanarMeshOverlay {
    PlanarMeshOverlay {
        frame_origin_m: frame.origin,
        frame_u_axis: frame.u,
        frame_v_axis: frame.v,
        frame_normal: frame.normal,
        bounds_uv_m: cut.bounds_uv,
        polygons: cut
            .polygons
            .iter()
            .map(|poly| PlanarOverlayPolygon {
                vertices_uv_m: poly.vertices_uv_m.clone(),
                parent_element_id: poly.parent_element_id,
            })
            .collect(),
        segments: cut
            .segments
            .iter()
            .map(|seg| PlanarOverlaySegment {
                a_uv_m: seg.a_uv_m,
                b_uv_m: seg.b_uv_m,
                kind: seg.kind,
            })
            .collect(),
    }
}

fn push_vertex_point(
    points: &mut Vec<IntersectionVertex>,
    uv: [f64; 2],
    world: [f64; 3],
    edge_nodes: [u32; 2],
    weights: [f64; 6],
    ref_coord: [f64; 3],
    tol: f64,
) {
    let tol_sq = (tol * tol).max(1e-24);
    if points
        .iter()
        .any(|p| (p.uv[0] - uv[0]).powi(2) + (p.uv[1] - uv[1]).powi(2) <= tol_sq)
    {
        return;
    }
    points.push(IntersectionVertex {
        uv,
        world,
        edge_nodes,
        weights,
        ref_coord,
    });
}

fn polygon_area(points: &[IntersectionVertex]) -> f64 {
    let mut area = 0.0;
    for i in 0..points.len() {
        let j = (i + 1) % points.len();
        area += points[i].uv[0] * points[j].uv[1] - points[j].uv[0] * points[i].uv[1];
    }
    area * 0.5
}

fn clip_polygon_to_bounds(
    points: &[IntersectionVertex],
    bounds: [f64; 4],
) -> Vec<IntersectionVertex> {
    let mut current = points.to_vec();
    // 4 edges of bounds: u >= min, u <= max, v >= min, v <= max
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
    ] {
        if current.is_empty() {
            break;
        }
        let mut next = Vec::new();
        let len = current.len();
        for i in 0..len {
            let a = &current[i];
            let b = &current[(i + 1) % len];
            let a_in = if keep_greater { a.uv[axis] >= limit - 1e-14 } else { a.uv[axis] <= limit + 1e-14 };
            let b_in = if keep_greater { b.uv[axis] >= limit - 1e-14 } else { b.uv[axis] <= limit + 1e-14 };
            if a_in {
                next.push(a.clone());
            }
            if a_in != b_in {
                let denom = b.uv[axis] - a.uv[axis];
                if denom.abs() > 1e-15 {
                    let t = ((limit - a.uv[axis]) / denom).clamp(0.0, 1.0);
                    let uv = [
                        a.uv[0] + t * (b.uv[0] - a.uv[0]),
                        a.uv[1] + t * (b.uv[1] - a.uv[1]),
                    ];
                    let world = [
                        a.world[0] + t * (b.world[0] - a.world[0]),
                        a.world[1] + t * (b.world[1] - a.world[1]),
                        a.world[2] + t * (b.world[2] - a.world[2]),
                    ];
                    let mut weights = [0.0; 6];
                    for k in 0..6 {
                        weights[k] = a.weights[k] + t * (b.weights[k] - a.weights[k]);
                    }
                    next.push(IntersectionVertex {
                        uv,
                        world,
                        edge_nodes: [a.edge_nodes[0], b.edge_nodes[1]],
                        weights,
                        ref_coord: [0.0; 3],
                    });
                }
            }
        }
        current = next;
    }
    current
}

fn selected_face_counts(field: &FemPlanarField) -> HashMap<Vec<u32>, u32> {
    let mut counts = HashMap::new();
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        for local_face in element.faces() {
            let mut face = local_face
                .iter()
                .map(|local| element.nodes()[*local])
                .collect::<Vec<_>>();
            face.sort_unstable();
            *counts.entry(face).or_insert(0) += 1;
        }
    }
    counts
}

fn classify_segment(
    a: &IntersectionVertex,
    b: &IntersectionVertex,
    target_face_counts: &HashMap<Vec<u32>, u32>,
    clip_extent: Option<[f64; 4]>,
) -> PlanarOverlaySegmentKind {
    // Check if on clip boundary
    if let Some(bounds) = clip_extent {
        for axis in 0..2 {
            let min_val = bounds[axis * 2];
            let max_val = bounds[axis * 2 + 1];
            if (a.uv[axis] - min_val).abs() < 1e-11 && (b.uv[axis] - min_val).abs() < 1e-11 {
                return PlanarOverlaySegmentKind::MeshInterior; // clipped to window edge
            }
            if (a.uv[axis] - max_val).abs() < 1e-11 && (b.uv[axis] - max_val).abs() < 1e-11 {
                return PlanarOverlaySegmentKind::MeshInterior;
            }
        }
    }

    let mut nodes = [
        a.edge_nodes[0],
        a.edge_nodes[1],
        b.edge_nodes[0],
        b.edge_nodes[1],
    ];
    nodes.sort_unstable();
    let mut unique = nodes.to_vec();
    unique.dedup();
    if !(2..=4).contains(&unique.len()) {
        return PlanarOverlaySegmentKind::TargetBoundary;
    }
    match target_face_counts.get(&unique).copied() {
        Some(1) => PlanarOverlaySegmentKind::TargetBoundary,
        Some(_) => PlanarOverlaySegmentKind::MeshInterior,
        None => PlanarOverlaySegmentKind::TargetBoundary,
    }
}
