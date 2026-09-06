use super::moments::ScalarMoments;
use super::fem::sub;
use super::frame::{cross, dot};
use super::{FemPlanarElement, FemPlanarField, PlanarComponent};

const KEAST14_U2: f64 = 0.698419704324386603;
const KEAST14_V2: f64 = (1.0 - KEAST14_U2) / 3.0;
const KEAST14_W2: f64 = 6.0 * 0.0147649707904967828;

const KEAST14_U3: f64 = 0.0568813795204234229;
const KEAST14_V3: f64 = (1.0 - KEAST14_U3) / 3.0;
const KEAST14_W3: f64 = 6.0 * 0.0221397911142651221;

const KEAST14_W1: f64 = 6.0 * 0.00317460317460317460;

const KEAST14_POINTS: [([f64; 4], f64); 14] = [
    ([0.5, 0.5, 0.0, 0.0], KEAST14_W1),
    ([0.5, 0.0, 0.5, 0.0], KEAST14_W1),
    ([0.5, 0.0, 0.0, 0.5], KEAST14_W1),
    ([0.0, 0.5, 0.5, 0.0], KEAST14_W1),
    ([0.0, 0.5, 0.0, 0.5], KEAST14_W1),
    ([0.0, 0.0, 0.5, 0.5], KEAST14_W1),
    ([KEAST14_U2, KEAST14_V2, KEAST14_V2, KEAST14_V2], KEAST14_W2),
    ([KEAST14_V2, KEAST14_U2, KEAST14_V2, KEAST14_V2], KEAST14_W2),
    ([KEAST14_V2, KEAST14_V2, KEAST14_U2, KEAST14_V2], KEAST14_W2),
    ([KEAST14_V2, KEAST14_V2, KEAST14_V2, KEAST14_U2], KEAST14_W2),
    ([KEAST14_U3, KEAST14_V3, KEAST14_V3, KEAST14_V3], KEAST14_W3),
    ([KEAST14_V3, KEAST14_U3, KEAST14_V3, KEAST14_V3], KEAST14_W3),
    ([KEAST14_V3, KEAST14_V3, KEAST14_U3, KEAST14_V3], KEAST14_W3),
    ([KEAST14_V3, KEAST14_V3, KEAST14_V3, KEAST14_U3], KEAST14_W3),
];

fn point_segment_distance_sq(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = sub(b, a);
    let ap = sub(p, a);
    let len_sq = dot(ab, ab);
    if len_sq <= 1.0e-30 {
        return dot(ap, ap);
    }
    let t = (dot(ap, ab) / len_sq).clamp(0.0, 1.0);
    let proj = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
    let diff = sub(p, proj);
    dot(diff, diff)
}

fn point_triangle_distance_sq(p: [f64; 3], a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let n = cross(ab, ac);
    let n_sq = dot(n, n);
    let edge_scale_sq = dot(ab, ab).max(dot(ac, ac)).max(dot(sub(c, b), sub(c, b)));
    if n_sq <= edge_scale_sq * edge_scale_sq * 1.0e-24 || edge_scale_sq <= 1.0e-30 {
        return point_segment_distance_sq(p, a, b)
            .min(point_segment_distance_sq(p, b, c))
            .min(point_segment_distance_sq(p, c, a));
    }

    let ap = sub(p, a);
    let n_len = n_sq.sqrt();
    let h = dot(ap, n) / n_len;
    let proj = [
        p[0] - h * n[0] / n_len,
        p[1] - h * n[1] / n_len,
        p[2] - h * n[2] / n_len,
    ];

    let c0 = dot(cross(sub(b, a), sub(proj, a)), n);
    let c1 = dot(cross(sub(c, b), sub(proj, b)), n);
    let c2 = dot(cross(sub(a, c), sub(proj, c)), n);

    let tol = -1.0e-12 * n_sq;
    if c0 >= tol && c1 >= tol && c2 >= tol {
        h * h
    } else {
        point_segment_distance_sq(p, a, b)
            .min(point_segment_distance_sq(p, b, c))
            .min(point_segment_distance_sq(p, c, a))
    }
}

pub(crate) fn point_tetrahedron_distance(
    p: [f64; 3],
    v0: [f64; 3],
    v1: [f64; 3],
    v2: [f64; 3],
    v3: [f64; 3],
) -> f64 {
    let verts = [v0, v1, v2, v3];
    let mut scale = 0.0_f64;
    for i in 0..4 {
        for j in (i + 1)..4 {
            let d = dot(sub(verts[i], verts[j]), sub(verts[i], verts[j])).sqrt();
            if d > scale {
                scale = d;
            }
        }
    }
    if scale <= 1.0e-30 {
        let diff = sub(p, v0);
        return dot(diff, diff).sqrt();
    }

    let inv_scale = 1.0 / scale;
    let p_norm = [
        (p[0] - v3[0]) * inv_scale,
        (p[1] - v3[1]) * inv_scale,
        (p[2] - v3[2]) * inv_scale,
    ];
    let a_norm = [
        (v0[0] - v3[0]) * inv_scale,
        (v0[1] - v3[1]) * inv_scale,
        (v0[2] - v3[2]) * inv_scale,
    ];
    let b_norm = [
        (v1[0] - v3[0]) * inv_scale,
        (v1[1] - v3[1]) * inv_scale,
        (v1[2] - v3[2]) * inv_scale,
    ];
    let c_norm = [
        (v2[0] - v3[0]) * inv_scale,
        (v2[1] - v3[1]) * inv_scale,
        (v2[2] - v3[2]) * inv_scale,
    ];

    let det = dot(a_norm, cross(b_norm, c_norm));
    if det.abs() > 1.0e-12 {
        let w0 = dot(p_norm, cross(b_norm, c_norm)) / det;
        let w1 = dot(a_norm, cross(p_norm, c_norm)) / det;
        let w2 = dot(a_norm, cross(b_norm, p_norm)) / det;
        let w3 = 1.0 - w0 - w1 - w2;
        if w0 >= -1.0e-11 && w1 >= -1.0e-11 && w2 >= -1.0e-11 && w3 >= -1.0e-11 {
            return 0.0;
        }
    }

    let zero_norm = [0.0, 0.0, 0.0];
    let d0 = point_triangle_distance_sq(p_norm, a_norm, b_norm, c_norm);
    let d1 = point_triangle_distance_sq(p_norm, a_norm, b_norm, zero_norm);
    let d2 = point_triangle_distance_sq(p_norm, a_norm, c_norm, zero_norm);
    let d3 = point_triangle_distance_sq(p_norm, b_norm, c_norm, zero_norm);
    d0.min(d1).min(d2).min(d3).max(0.0).sqrt() * scale
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum EvaluationQuantity {
    Component(usize),
    VectorComponent {
        component: PlanarComponent,
        u_axis: [f64; 3],
        v_axis: [f64; 3],
        normal: [f64; 3],
    },
}

impl EvaluationQuantity {
    pub fn is_affine_on_tet4(&self) -> bool {
        match self {
            Self::Component(_) => true,
            Self::VectorComponent { component, .. } => matches!(
                component,
                PlanarComponent::WorldX
                    | PlanarComponent::WorldY
                    | PlanarComponent::WorldZ
                    | PlanarComponent::MonitorU
                    | PlanarComponent::MonitorV
                    | PlanarComponent::MonitorNormal
            ),
        }
    }
}

pub(crate) fn evaluate_sub_tetrahedron_moments(
    field: &FemPlanarField,
    element: &FemPlanarElement,
    vertices: [[f64; 3]; 4],
    component: usize,
) -> ScalarMoments {
    evaluate_sub_tetrahedron_moments_quantity(
        field,
        element,
        vertices,
        EvaluationQuantity::Component(component),
    )
}

pub(crate) fn evaluate_sub_tetrahedron_moments_quantity(
    field: &FemPlanarField,
    element: &FemPlanarElement,
    vertices: [[f64; 3]; 4],
    quantity: EvaluationQuantity,
) -> ScalarMoments {
    let a = sub(vertices[1], vertices[0]);
    let b = sub(vertices[2], vertices[0]);
    let c = sub(vertices[3], vertices[0]);
    let volume = (dot(a, cross(b, c)).abs()) / 6.0;

    if volume <= 1e-36 || !volume.is_finite() {
        return ScalarMoments::zero();
    }

    match element {
        FemPlanarElement::Tet4(nodes) if quantity.is_affine_on_tet4() => {
            let mut a_vals = [0.0; 4];
            let tet_nodes = [
                field.nodes()[nodes[0] as usize],
                field.nodes()[nodes[1] as usize],
                field.nodes()[nodes[2] as usize],
                field.nodes()[nodes[3] as usize],
            ];
            for (i, v) in vertices.iter().enumerate() {
                a_vals[i] = evaluate_quantity_tet4_linear(field, nodes, &tet_nodes, *v, quantity);
            }
            ScalarMoments::from_affine_tetrahedron(a_vals, volume)
        }
        _ => {
            let mut first = 0.0;
            let mut second = 0.0;
            let mut min = f64::INFINITY;
            let mut max = f64::NEG_INFINITY;

            for &(lambda, w) in &KEAST14_POINTS {
                let mut p = [0.0; 3];
                for j in 0..4 {
                    for axis in 0..3 {
                        p[axis] += lambda[j] * vertices[j][axis];
                    }
                }
                let val = evaluate_quantity_at(field, element, p, quantity);
                first += volume * w * val;
                second += volume * w * val * val;
                min = min.min(val);
                max = max.max(val);
            }

            for v in &vertices {
                let val = evaluate_quantity_at(field, element, *v, quantity);
                min = min.min(val);
                max = max.max(val);
            }

            if let FemPlanarElement::Tet4(nodes) = element {
                if let EvaluationQuantity::VectorComponent {
                    component,
                    u_axis,
                    v_axis,
                    ..
                } = quantity
                {
                    if component == PlanarComponent::Magnitude {
                        let tet_nodes = [
                            field.nodes()[nodes[0] as usize],
                            field.nodes()[nodes[1] as usize],
                            field.nodes()[nodes[2] as usize],
                            field.nodes()[nodes[3] as usize],
                        ];
                        let v_vals = vertices.map(|v| [
                            interpolate_tet4_linear(field, nodes, &tet_nodes, v, 0),
                            interpolate_tet4_linear(field, nodes, &tet_nodes, v, 1),
                            interpolate_tet4_linear(field, nodes, &tet_nodes, v, 2),
                        ]);
                        let dist = point_tetrahedron_distance(
                            [0.0; 3],
                            v_vals[0],
                            v_vals[1],
                            v_vals[2],
                            v_vals[3],
                        );
                        min = min.min(dist);
                    } else if component == PlanarComponent::InPlaneMagnitude {
                        let tet_nodes = [
                            field.nodes()[nodes[0] as usize],
                            field.nodes()[nodes[1] as usize],
                            field.nodes()[nodes[2] as usize],
                            field.nodes()[nodes[3] as usize],
                        ];
                        let v_vals = vertices.map(|v| {
                            let vec = [
                                interpolate_tet4_linear(field, nodes, &tet_nodes, v, 0),
                                interpolate_tet4_linear(field, nodes, &tet_nodes, v, 1),
                                interpolate_tet4_linear(field, nodes, &tet_nodes, v, 2),
                            ];
                            [dot(vec, u_axis), dot(vec, v_axis), 0.0]
                        });
                        let dist = point_tetrahedron_distance(
                            [0.0; 3],
                            v_vals[0],
                            v_vals[1],
                            v_vals[2],
                            v_vals[3],
                        );
                        min = min.min(dist);
                    }
                }
            }

            ScalarMoments {
                measure: volume,
                first,
                second,
                min,
                max,
            }
        }
    }
}

pub(crate) fn evaluate_quantity_at(
    field: &FemPlanarField,
    element: &FemPlanarElement,
    point: [f64; 3],
    quantity: EvaluationQuantity,
) -> f64 {
    match quantity {
        EvaluationQuantity::Component(c) => match element {
            FemPlanarElement::Tet4(nodes) => {
                let tet_nodes = [
                    field.nodes()[nodes[0] as usize],
                    field.nodes()[nodes[1] as usize],
                    field.nodes()[nodes[2] as usize],
                    field.nodes()[nodes[3] as usize],
                ];
                interpolate_tet4_linear(field, nodes, &tet_nodes, point, c)
            }
            FemPlanarElement::Prism6(nodes) => interpolate_prism6(field, nodes, point, c),
        },
        EvaluationQuantity::VectorComponent {
            component,
            u_axis,
            v_axis,
            normal,
        } => {
            let vec = match element {
                FemPlanarElement::Tet4(nodes) => {
                    let tet_nodes = [
                        field.nodes()[nodes[0] as usize],
                        field.nodes()[nodes[1] as usize],
                        field.nodes()[nodes[2] as usize],
                        field.nodes()[nodes[3] as usize],
                    ];
                    [
                        interpolate_tet4_linear(field, nodes, &tet_nodes, point, 0),
                        interpolate_tet4_linear(field, nodes, &tet_nodes, point, 1),
                        interpolate_tet4_linear(field, nodes, &tet_nodes, point, 2),
                    ]
                }
                FemPlanarElement::Prism6(nodes) => [
                    interpolate_prism6(field, nodes, point, 0),
                    interpolate_prism6(field, nodes, point, 1),
                    interpolate_prism6(field, nodes, point, 2),
                ],
            };
            evaluate_vector_quantity(vec, component, u_axis, v_axis, normal)
        }
    }
}

fn evaluate_quantity_tet4_linear(
    field: &FemPlanarField,
    nodes: &[u32; 4],
    tet_nodes: &[[f64; 3]; 4],
    point: [f64; 3],
    quantity: EvaluationQuantity,
) -> f64 {
    match quantity {
        EvaluationQuantity::Component(c) => {
            interpolate_tet4_linear(field, nodes, tet_nodes, point, c)
        }
        EvaluationQuantity::VectorComponent {
            component,
            u_axis,
            v_axis,
            normal,
        } => {
            let v = [
                interpolate_tet4_linear(field, nodes, tet_nodes, point, 0),
                interpolate_tet4_linear(field, nodes, tet_nodes, point, 1),
                interpolate_tet4_linear(field, nodes, tet_nodes, point, 2),
            ];
            evaluate_vector_quantity(v, component, u_axis, v_axis, normal)
        }
    }
}

pub(crate) fn evaluate_vector_quantity(
    v: [f64; 3],
    component: PlanarComponent,
    u_axis: [f64; 3],
    v_axis: [f64; 3],
    normal: [f64; 3],
) -> f64 {
    match component {
        PlanarComponent::Scalar => v[0],
        PlanarComponent::Magnitude => (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt(),
        PlanarComponent::MagnitudeSquared => v[0] * v[0] + v[1] * v[1] + v[2] * v[2],
        PlanarComponent::WorldX => v[0],
        PlanarComponent::WorldY => v[1],
        PlanarComponent::WorldZ => v[2],
        PlanarComponent::AbsWorldX => v[0].abs(),
        PlanarComponent::AbsWorldY => v[1].abs(),
        PlanarComponent::AbsWorldZ => v[2].abs(),
        PlanarComponent::MonitorU => dot(v, u_axis),
        PlanarComponent::MonitorV => dot(v, v_axis),
        PlanarComponent::MonitorNormal => dot(v, normal),
        PlanarComponent::InPlaneMagnitude => {
            let u = dot(v, u_axis);
            let v_proj = dot(v, v_axis);
            (u * u + v_proj * v_proj).sqrt()
        }
        PlanarComponent::Orientation => {
            let u = dot(v, u_axis);
            let v_proj = dot(v, v_axis);
            if (u * u + v_proj * v_proj).sqrt() <= 1e-12 {
                f64::NAN
            } else {
                v_proj.atan2(u).rem_euclid(std::f64::consts::TAU) / std::f64::consts::TAU
            }
        }
    }
}

fn interpolate_tet4_linear(
    field: &FemPlanarField,
    nodes: &[u32; 4],
    tet_nodes: &[[f64; 3]; 4],
    point: [f64; 3],
    component: usize,
) -> f64 {
    let a = sub(tet_nodes[0], tet_nodes[3]);
    let b = sub(tet_nodes[1], tet_nodes[3]);
    let c = sub(tet_nodes[2], tet_nodes[3]);
    let p = sub(point, tet_nodes[3]);
    let det = dot(a, cross(b, c));
    if det == 0.0 || !det.is_finite() {
        return field.values()[nodes[0] as usize * field.n_comp() + component];
    }
    let w0 = dot(p, cross(b, c)) / det;
    let w1 = dot(a, cross(p, c)) / det;
    let w2 = dot(a, cross(b, p)) / det;
    let w3 = 1.0 - w0 - w1 - w2;

    let n_comp = field.n_comp();
    w0 * field.values()[nodes[0] as usize * n_comp + component]
        + w1 * field.values()[nodes[1] as usize * n_comp + component]
        + w2 * field.values()[nodes[2] as usize * n_comp + component]
        + w3 * field.values()[nodes[3] as usize * n_comp + component]
}

fn interpolate_prism6(
    field: &FemPlanarField,
    nodes: &[u32; 6],
    point: [f64; 3],
    component: usize,
) -> f64 {
    let prism_nodes: [[f64; 3]; 6] = [
        field.nodes()[nodes[0] as usize],
        field.nodes()[nodes[1] as usize],
        field.nodes()[nodes[2] as usize],
        field.nodes()[nodes[3] as usize],
        field.nodes()[nodes[4] as usize],
        field.nodes()[nodes[5] as usize],
    ];

    if let Some(weights) = prism6_invert(&prism_nodes, point) {
        let n_comp = field.n_comp();
        let mut val = 0.0;
        for (local, &node) in nodes.iter().enumerate() {
            val += weights[local] * field.values()[node as usize * n_comp + component];
        }
        val
    } else {
        f64::NAN
    }
}

pub(crate) fn prism6_invert(nodes: &[[f64; 3]; 6], point: [f64; 3]) -> Option<[f64; 6]> {
    let mut reference = [1.0 / 3.0, 1.0 / 3.0, 0.5];
    let scale = nodes
        .iter()
        .flat_map(|a| nodes.iter().map(move |b| dot(sub(*a, *b), sub(*a, *b))))
        .fold(0.0_f64, f64::max)
        .sqrt()
        .max(f64::MIN_POSITIVE);

    for _ in 0..16 {
        let (weights, derivatives) = prism6_shape(reference);
        let mapped = [0, 1, 2].map(|axis| {
            weights
                .iter()
                .enumerate()
                .map(|(local, weight)| weight * nodes[local][axis])
                .sum::<f64>()
        });

        let jacobian = std::array::from_fn::<_, 3, _>(|column| {
            [0, 1, 2].map(|axis| {
                derivatives
                    .iter()
                    .enumerate()
                    .map(|(local, derivative)| derivative[column] * nodes[local][axis])
                    .sum::<f64>()
            })
        });
        let determinant = dot(jacobian[0], cross(jacobian[1], jacobian[2]));
        if !determinant.is_finite() || determinant.abs() <= scale.powi(3) * 1.0e-15 {
            return None;
        }

        let residual = sub(mapped, point);
        if dot(residual, residual).sqrt() <= scale * 1.0e-12 {
            if reference[0] >= -1.0e-11
                && reference[1] >= -1.0e-11
                && reference[0] + reference[1] <= 1.0 + 1.0e-11
                && reference[2] >= -1.0e-11
                && reference[2] <= 1.0 + 1.0e-11
            {
                return Some(weights);
            }
            return None;
        }

        let delta = [
            dot(residual, cross(jacobian[1], jacobian[2])) / determinant,
            dot(jacobian[0], cross(residual, jacobian[2])) / determinant,
            dot(jacobian[0], cross(jacobian[1], residual)) / determinant,
        ];
        for axis in 0..3 {
            reference[axis] -= delta[axis];
        }
    }
    None
}

fn prism6_shape(reference: [f64; 3]) -> ([f64; 6], [[f64; 3]; 6]) {
    let [r, s, t] = reference;
    let l0 = 1.0 - r - s;
    (
        [
            l0 * (1.0 - t),
            r * (1.0 - t),
            s * (1.0 - t),
            l0 * t,
            r * t,
            s * t,
        ],
        [
            [-(1.0 - t), -(1.0 - t), -l0],
            [1.0 - t, 0.0, -r],
            [0.0, 1.0 - t, -s],
            [-t, -t, l0],
            [t, 0.0, r],
            [0.0, t, s],
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_prism6_invert_nanometer_scale() {
        let nm = 1e-9;
        let nodes = [
            [0.0, 0.0, 0.0],
            [5.0 * nm, 0.0, 0.0],
            [0.0, 5.0 * nm, 0.0],
            [0.0, 0.0, 2.0 * nm],
            [5.0 * nm, 0.0, 2.0 * nm],
            [0.0, 5.0 * nm, 2.0 * nm],
        ];
        let point = [1.0 * nm, 1.0 * nm, 1.0 * nm];
        let weights = prism6_invert(&nodes, point).expect("invert nanometer prism");

        // Affine field: f(x, y, z) = 2.0 * (x/nm) - 3.0 * (y/nm) + 5.0 * (z/nm) + 7.0
        let node_vals: [f64; 6] = std::array::from_fn(|i| {
            let [x, y, z] = nodes[i];
            2.0 * (x / nm) - 3.0 * (y / nm) + 5.0 * (z / nm) + 7.0
        });
        let interpolated: f64 = weights.iter().zip(node_vals.iter()).map(|(w, v)| w * v).sum();
        let exact = 2.0 * 1.0 - 3.0 * 1.0 + 5.0 * 1.0 + 7.0; // 11.0
        assert!((interpolated - exact).abs() < 1e-10, "interpolated: {interpolated}, exact: {exact}");
    }

    #[test]
    fn test_prism6_invert_outside_returns_none() {
        let nm = 1e-9;
        let nodes = [
            [0.0, 0.0, 0.0],
            [5.0 * nm, 0.0, 0.0],
            [0.0, 5.0 * nm, 0.0],
            [0.0, 0.0, 2.0 * nm],
            [5.0 * nm, 0.0, 2.0 * nm],
            [0.0, 5.0 * nm, 2.0 * nm],
        ];
        let outside_point = [10.0 * nm, 10.0 * nm, 10.0 * nm];
        assert!(prism6_invert(&nodes, outside_point).is_none());
    }

    #[test]
    fn test_prism6_invert_degenerate_returns_none() {
        let nm = 1e-9;
        // Flat degenerate prism (all z coordinates are 0)
        let nodes = [
            [0.0, 0.0, 0.0],
            [5.0 * nm, 0.0, 0.0],
            [0.0, 5.0 * nm, 0.0],
            [0.0, 0.0, 0.0],
            [5.0 * nm, 0.0, 0.0],
            [0.0, 5.0 * nm, 0.0],
        ];
        let point = [1.0 * nm, 1.0 * nm, 0.0];
        assert!(prism6_invert(&nodes, point).is_none());
    }
}
