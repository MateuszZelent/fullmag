use super::eigen_math::{add_vector, cross, dot, normalize_vector, scale_vector};
use super::eigen_reduction::ReductionMap;
use crate::types::RunError;
use fullmag_engine::Vector3;
use nalgebra::DVector;
use num_complex::Complex64;

pub(super) fn tangent_bases(equilibrium: &[Vector3]) -> Vec<(Vector3, Vector3)> {
    equilibrium
        .iter()
        .map(|m| {
            let reference = if m[2].abs() < 0.9 {
                [0.0, 0.0, 1.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            let e1 = normalize_vector(cross(reference, *m));
            let e2 = normalize_vector(cross(*m, e1));
            (e1, e2)
        })
        .collect()
}

pub(super) fn project_real_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &DVector<f64>,
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let a = amplitudes[reduced_index];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = scale_vector(e1, a);
        imag[*node_index] = scale_vector(e2, a);
        amplitude[*node_index] = a.abs();
        phase[*node_index] = if a >= 0.0 { 0.0 } else { std::f64::consts::PI };
        max_amplitude = max_amplitude.max(a.abs());
    }

    (real, imag, amplitude, phase, max_amplitude)
}

pub(super) fn project_complex_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let value = amplitudes[reduced_index];
        let (e1, e2) = bases[*node_index];
        // Extend the real scalar convention a * (e1 + i e2) complex-linearly.
        // Splitting a.re onto e1 and a.im onto e2 would lose quadrature and
        // make the exported polarization depend on the arbitrary eigenvector phase.
        real[*node_index] = add_vector(scale_vector(e1, value.re), scale_vector(e2, -value.im));
        imag[*node_index] = add_vector(scale_vector(e1, value.im), scale_vector(e2, value.re));
        amplitude[*node_index] = value.norm();
        phase[*node_index] = value.arg();
        max_amplitude = max_amplitude.max(amplitude[*node_index]);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

pub(super) fn project_complex_2x2_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    if amplitudes.len() < 2 * n {
        return (real, imag, amplitude, phase, max_amplitude);
    }

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let u1 = amplitudes[reduced_index];
        let u2 = amplitudes[reduced_index + n];
        let (e1, e2) = bases[*node_index];
        real[*node_index] = add_vector(scale_vector(e1, u1.re), scale_vector(e2, u2.re));
        imag[*node_index] = add_vector(scale_vector(e1, u1.im), scale_vector(e2, u2.im));
        let amp = (u1.norm_sqr() + u2.norm_sqr()).sqrt();
        amplitude[*node_index] = amp;
        phase[*node_index] = (u1.im + u2.im).atan2(u1.re + u2.re);
        max_amplitude = max_amplitude.max(amp);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

/// Project a reduced 2×2 mode onto every physical magnetic node, expanding
/// periodic/Floquet classes with their Bloch phase and transporting tangent
/// coefficients from the class root frame to the destination node frame.
///
/// The reduced vector is laid out as `[u1_0..u1_{N-1}, u2_0..u2_{N-1}]`, while
/// `node_map[node]` identifies the reduced class for a full-mesh node.  This
/// keeps the exported field on the same mesh as `metadata.json`; publishing
/// only `active_nodes` would leave periodic slave nodes at zero and invalidate
/// the phase certificate.
pub(super) fn project_complex_2x2_mode_to_tangent_basis_with_periodic_map(
    total_nodes: usize,
    active_nodes: &[usize],
    node_map: &[Option<usize>],
    node_phases: &[Complex64],
    amplitudes: &[Complex64],
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    if amplitudes.len() < 2 * n
        || node_map.len() != total_nodes
        || node_phases.len() != total_nodes
        || bases.len() != total_nodes
    {
        return (real, imag, amplitude, phase, max_amplitude);
    }

    for node_index in 0..total_nodes {
        let Some(reduced_index) = node_map[node_index] else {
            continue;
        };
        let Some(&root) = active_nodes.get(reduced_index) else {
            continue;
        };
        if root >= total_nodes {
            continue;
        }

        let (root_e1, root_e2) = bases[root];
        let (node_e1, node_e2) = bases[node_index];
        let transport = [
            [dot(node_e1, root_e1), dot(node_e1, root_e2)],
            [dot(node_e2, root_e1), dot(node_e2, root_e2)],
        ];
        let u1_root = amplitudes[reduced_index];
        let u2_root = amplitudes[reduced_index + n];
        let bloch_phase = node_phases[node_index];
        let u1 = bloch_phase * (u1_root * transport[0][0] + u2_root * transport[0][1]);
        let u2 = bloch_phase * (u1_root * transport[1][0] + u2_root * transport[1][1]);

        real[node_index] = add_vector(scale_vector(node_e1, u1.re), scale_vector(node_e2, u2.re));
        imag[node_index] = add_vector(scale_vector(node_e1, u1.im), scale_vector(node_e2, u2.im));
        let amp = (u1.norm_sqr() + u2.norm_sqr()).sqrt();
        amplitude[node_index] = amp;
        phase[node_index] = (u1.im + u2.im).atan2(u1.re + u2.re);
        max_amplitude = max_amplitude.max(amp);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

/// Project a 2×2 block eigenvector back to full 3D mode fields.
///
/// The eigenvector has 2N elements: [u1_0..u1_{N-1}, u2_0..u2_{N-1}]
/// where u1 are the e1-component amplitudes and u2 are the e2-component
/// amplitudes.  The 3D mode field is dm = u1*e1 + u2*e2.
pub(super) fn project_2x2_mode_to_tangent_basis(
    total_nodes: usize,
    active_nodes: &[usize],
    amplitudes: &DVector<f64>,
    bases: &[(Vector3, Vector3)],
) -> (Vec<Vector3>, Vec<Vector3>, Vec<f64>, Vec<f64>, f64) {
    let n = active_nodes.len();
    let mut real = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut imag = vec![[0.0, 0.0, 0.0]; total_nodes];
    let mut amplitude = vec![0.0; total_nodes];
    let mut phase = vec![0.0; total_nodes];
    let mut max_amplitude: f64 = 0.0;

    for (reduced_index, node_index) in active_nodes.iter().enumerate() {
        let u1 = amplitudes[reduced_index]; // e1 component
        let u2 = amplitudes[reduced_index + n]; // e2 component
        let (e1, e2) = bases[*node_index];

        // Real part of the mode: dm_real = u1*e1 + u2*e2
        real[*node_index] = add_vector(scale_vector(e1, u1), scale_vector(e2, u2));
        // Imaginary part: for the undamped real-symmetric case, the mode
        // oscillates as dm ~ cos(ωt)*u, so the "imaginary" part is the
        // orthogonal tangent component (circular/elliptical precession).
        imag[*node_index] = add_vector(scale_vector(e1, -u2), scale_vector(e2, u1));
        let amp = (u1 * u1 + u2 * u2).sqrt();
        amplitude[*node_index] = amp;
        phase[*node_index] = u2.atan2(u1);
        max_amplitude = max_amplitude.max(amp);
    }

    (real, imag, amplitude, phase, max_amplitude)
}

/// Expand already reconstructed Cartesian reference fields over translation-only
/// periodic classes. The reduced solver vector and its normalization stay unchanged.
/// Requires the materialized-equilibrium transport guard before reconstruction.
/// Native modal publication uses its own tangent-frame-aware projection above.
pub(super) fn expand_reference_mode_to_periodic_nodes(
    reduction: &ReductionMap,
    real: &mut [Vector3],
    imag: &mut [Vector3],
    amplitude: &mut [f64],
    phase: &mut [f64],
) -> Result<(), RunError> {
    let node_count = real.len();
    if imag.len() != node_count
        || amplitude.len() != node_count
        || phase.len() != node_count
        || reduction.node_map.len() != node_count
        || reduction.node_phases.len() != node_count
    {
        return Err(RunError {
            message: "reference modal periodic expansion has inconsistent field dimensions".into(),
        });
    }
    for (reduced_index, &root) in reduction.active_nodes.iter().enumerate() {
        if root >= node_count || reduction.node_map[root] != Some(reduced_index) {
            return Err(RunError {
                message: "reference modal periodic expansion has an invalid class representative"
                    .into(),
            });
        }
        let anchor = reduction.node_phases[root];
        if !anchor.re.is_finite()
            || !anchor.im.is_finite()
            || (anchor - Complex64::new(1.0, 0.0)).norm() > 1.0e-10
            || real[root]
                .iter()
                .chain(imag[root].iter())
                .any(|value| !value.is_finite())
            || !amplitude[root].is_finite()
            || amplitude[root] < 0.0
            || !phase[root].is_finite()
        {
            return Err(RunError {
                message: "reference modal periodic expansion has an invalid root field or phase anchor"
                    .into(),
            });
        }
    }
    for node in 0..node_count {
        let Some(reduced_index) = reduction.node_map[node] else {
            continue;
        };
        let Some(&root) = reduction.active_nodes.get(reduced_index) else {
            return Err(RunError {
                message: "reference modal periodic expansion has an out-of-range class".into(),
            });
        };
        let factor = reduction.node_phases[node];
        if !factor.re.is_finite()
            || !factor.im.is_finite()
            || (factor.norm_sqr() - 1.0).abs() > 1.0e-10
        {
            return Err(RunError {
                message: "reference modal periodic expansion requires finite unit Bloch phases"
                    .into(),
            });
        }
        // Never overwrite a representative: a slave may occur before it in
        // the full-node array, and all members must read the same root phasor.
        if node == root {
            continue;
        }
        for component in 0..3 {
            let value = factor * Complex64::new(real[root][component], imag[root][component]);
            if !value.re.is_finite() || !value.im.is_finite() {
                return Err(RunError {
                    message: "reference modal periodic expansion produced a non-finite field".into(),
                });
            }
            real[node][component] = value.re;
            imag[node][component] = value.im;
        }
        amplitude[node] = amplitude[root];
        phase[node] = (factor * Complex64::from_polar(1.0, phase[root])).arg();
    }
    Ok(())
}

#[cfg(test)]
mod scalar_projection_tests {
    use super::*;

    #[test]
    fn reference_projection_expands_periodic_and_signed_bloch_nodes() {
        let bases = tangent_bases(&[[0.0, 0.0, 1.0]; 5]);
        for angle in [0.0, -0.43, 0.43] {
            let factor = Complex64::from_polar(1.0, angle);
            let reduction = ReductionMap {
                active_nodes: vec![1, 3],
                node_map: vec![Some(0), Some(0), None, Some(1), Some(1)],
                node_phases: vec![factor, Complex64::new(1.0, 0.0), Complex64::new(1.0, 0.0), Complex64::new(1.0, 0.0), factor.conj()],
                complex_reduction: angle != 0.0,
            };
            let (mut real, mut imag, mut amplitude, mut phase, _) =
                project_complex_mode_to_tangent_basis(5, &reduction.active_nodes,
                    &[Complex64::new(1.0, 0.5), Complex64::new(2.0, -0.3)], &bases);
            let root_real = real.clone();
            let root_imag = imag.clone();
            expand_reference_mode_to_periodic_nodes(&reduction, &mut real, &mut imag, &mut amplitude, &mut phase).unwrap();
            for (node, root) in [(0, 1), (1, 1), (3, 3), (4, 3)] {
                for component in 0..3 {
                    let expected = reduction.node_phases[node] * Complex64::new(root_real[root][component], root_imag[root][component]);
                    let actual = Complex64::new(real[node][component], imag[node][component]);
                    assert!((actual - expected).norm() < 1.0e-12);
                }
                assert_eq!(amplitude[node], amplitude[root]);
                let relative_phase = Complex64::from_polar(1.0, phase[node] - phase[root]);
                assert!((relative_phase - reduction.node_phases[node]).norm() < 1.0e-12);
            }
            assert_eq!(real[2], [0.0; 3]);
            assert_eq!(imag[2], [0.0; 3]);
            assert_eq!(amplitude[2], 0.0);
        }
    }

    #[test]
    fn reference_full2x2_expansion_preserves_elliptic_field_across_frame_rotation() {
        // The two frames span the same physical tangent plane, with a chart
        // rotation at the slave. The published Cartesian ellipse is unchanged.
        let bases = [
            ([0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]),
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ];
        let coefficients = [Complex64::new(0.8, 0.2), Complex64::new(-0.3, 0.7)];
        let expected_amplitude =
            (coefficients[0].norm_sqr() + coefficients[1].norm_sqr()).sqrt();
        for angle in [0.0, -0.31, 0.31] {
            let factor = Complex64::from_polar(1.0, angle);
            let reduction = ReductionMap {
                active_nodes: vec![1],
                node_map: vec![Some(0), Some(0)],
                node_phases: vec![factor, Complex64::new(1.0, 0.0)],
                complex_reduction: angle != 0.0,
            };
            let (mut real, mut imag, mut amplitude, mut phase, _) =
                project_complex_2x2_mode_to_tangent_basis(
                    2, &reduction.active_nodes, &coefficients, &bases,
                );
            expand_reference_mode_to_periodic_nodes(
                &reduction, &mut real, &mut imag, &mut amplitude, &mut phase,
            ).unwrap();

            for node in 0..2 {
                for component in 0..2 {
                    let expected = reduction.node_phases[node] * coefficients[component];
                    let actual = Complex64::new(real[node][component], imag[node][component]);
                    assert!((actual - expected).norm() < 1.0e-12);
                }
                assert_eq!(real[node][2], 0.0);
                assert_eq!(imag[node][2], 0.0);
                assert!((amplitude[node] - expected_amplitude).abs() < 1.0e-12);
                let field_power = dot(real[node], real[node]) + dot(imag[node], imag[node]);
                assert!((field_power - expected_amplitude.powi(2)).abs() < 1.0e-12);
            }
        }
    }

    #[test]
    fn reference_projection_rejects_invalid_periodic_map() {
        let baseline = ReductionMap {
            active_nodes: vec![0], node_map: vec![Some(0), Some(0)],
            node_phases: vec![Complex64::new(1.0, 0.0); 2], complex_reduction: true,
        };
        for case in 0..6 {
            let mut reduction = baseline.clone();
            match case {
                0 => reduction.node_map[1] = Some(4),
                1 => reduction.active_nodes[0] = 4,
                2 => reduction.node_phases[1] = Complex64::new(f64::NAN, 0.0),
                3 => reduction.node_phases[1] = Complex64::new(2.0, 0.0),
                4 => reduction.node_phases[0] = Complex64::new(0.0, 1.0),
                _ => { reduction.node_map.pop(); },
            }
            let result = expand_reference_mode_to_periodic_nodes(&reduction,
                &mut [[1.0, 0.0, 0.0], [0.0; 3]], &mut [[0.0, 1.0, 0.0], [0.0; 3]],
                &mut [1.0, 0.0], &mut [0.0, 0.0]);
            assert!(result.is_err(), "malformed periodic map case {case}");
        }
    }

    #[test]
    fn scalar_complex_projection_matches_real_projection() {
        let bases = tangent_bases(&[[0.0, 0.0, 1.0]; 4]);
        let active_nodes = [0, 2, 3];
        let coefficients = DVector::from_vec(vec![-2.0, 0.0, 3.0]);
        let complex_coefficients = coefficients
            .iter()
            .map(|&value| Complex64::new(value, 0.0))
            .collect::<Vec<_>>();
        let real_projection =
            project_real_mode_to_tangent_basis(4, &active_nodes, &coefficients, &bases);
        let complex_projection =
            project_complex_mode_to_tangent_basis(4, &active_nodes, &complex_coefficients, &bases);

        assert_eq!(complex_projection, real_projection);
    }

    #[test]
    fn scalar_complex_projection_commutes_with_global_phase() {
        let bases = tangent_bases(&[[0.0, 0.0, 1.0], [1.0, 0.0, 0.0]]);
        let active_nodes = [0, 1];
        let coefficients = [Complex64::new(0.7, -0.4), Complex64::new(-0.2, 0.9)];
        let rotation = Complex64::from_polar(1.0, 0.37);
        let rotated = coefficients.map(|value| rotation * value);
        let (real, imag, amplitude, _, max_amplitude) =
            project_complex_mode_to_tangent_basis(2, &active_nodes, &coefficients, &bases);
        let (rotated_real, rotated_imag, rotated_amplitude, _, rotated_max) =
            project_complex_mode_to_tangent_basis(2, &active_nodes, &rotated, &bases);

        for node in active_nodes {
            for component in 0..3 {
                let expected = rotation * Complex64::new(real[node][component], imag[node][component]);
                let actual = Complex64::new(rotated_real[node][component], rotated_imag[node][component]);
                assert!((actual - expected).norm() < 1.0e-12);
            }
            assert!((rotated_amplitude[node] - amplitude[node]).abs() < 1.0e-12);
            assert!((dot(real[node], real[node]) - coefficients[node].norm_sqr()).abs() < 1.0e-12);
            assert!((dot(imag[node], imag[node]) - coefficients[node].norm_sqr()).abs() < 1.0e-12);
            assert!(dot(real[node], imag[node]).abs() < 1.0e-12);
        }
        assert!((rotated_max - max_amplitude).abs() < 1.0e-12);
    }
}
