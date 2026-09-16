use super::eigen_math::{add_vector, cross, dot, normalize_vector, scale_vector};
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
        real[*node_index] = scale_vector(e1, value.re);
        imag[*node_index] = scale_vector(e2, value.im);
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
        let u1 = bloch_phase
            * (u1_root * transport[0][0] + u2_root * transport[0][1]);
        let u2 = bloch_phase
            * (u1_root * transport[1][0] + u2_root * transport[1][1]);

        real[node_index] = add_vector(
            scale_vector(node_e1, u1.re),
            scale_vector(node_e2, u2.re),
        );
        imag[node_index] = add_vector(
            scale_vector(node_e1, u1.im),
            scale_vector(node_e2, u2.im),
        );
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
