use super::moments::ScalarMoments;
use super::fem::sub;
use super::frame::{cross, dot};
use super::{FemPlanarElement, FemPlanarField, PlanarComponent};

const QUAD_ALPHA: f64 = 0.5854101966249685; // (5.0 + 3.0 * 5.0_f64.sqrt()) / 20.0;
const QUAD_BETA: f64 = 0.1381966011250105;  // (5.0 - 5.0_f64.sqrt()) / 20.0;

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

    if volume <= 1e-28 || !volume.is_finite() {
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
            let weight = volume * 0.25;

            for i in 0..4 {
                let mut lambda = [QUAD_BETA; 4];
                lambda[i] = QUAD_ALPHA;
                let mut p = [0.0; 3];
                for j in 0..4 {
                    for axis in 0..3 {
                        p[axis] += lambda[j] * vertices[j][axis];
                    }
                }
                let val = evaluate_quantity_at(field, element, p, quantity);
                first += weight * val;
                second += weight * val * val;
                min = min.min(val);
                max = max.max(val);
            }

            for v in &vertices {
                let val = evaluate_quantity_at(field, element, *v, quantity);
                min = min.min(val);
                max = max.max(val);
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
    if det.abs() <= 1e-30 {
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
        // Fallback: average
        let n_comp = field.n_comp();
        nodes.iter().map(|&n| field.values()[n as usize * n_comp + component]).sum::<f64>() / 6.0
    }
}

fn prism6_invert(nodes: &[[f64; 3]; 6], point: [f64; 3]) -> Option<[f64; 6]> {
    let mut reference = [1.0 / 3.0, 1.0 / 3.0, 0.5];
    let scale = nodes
        .iter()
        .flat_map(|a| nodes.iter().map(move |b| dot(sub(*a, *b), sub(*a, *b))))
        .fold(0.0_f64, f64::max)
        .sqrt()
        .max(1.0);

    for _ in 0..16 {
        let (weights, derivatives) = prism6_shape(reference);
        let mapped = [0, 1, 2].map(|axis| {
            weights
                .iter()
                .enumerate()
                .map(|(local, weight)| weight * nodes[local][axis])
                .sum::<f64>()
        });
        let residual = sub(mapped, point);
        if dot(residual, residual).sqrt() <= scale * 1e-12 {
            return Some(weights);
        }
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
        if determinant.abs() <= scale.powi(3) * 1e-15 {
            return Some(weights);
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
    let (weights, _) = prism6_shape(reference);
    Some(weights)
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
