use super::constraints::{Complex64, PeriodicDofMap};

pub fn reconstruct_full_complex_vec3(
    dof_map: &PeriodicDofMap,
    reduced_values: &[[Complex64; 3]],
) -> Vec<[Complex64; 3]> {
    let mut out = vec![[Complex64::new(0.0, 0.0); 3]; dof_map.full_node_count];
    for node in 0..dof_map.full_node_count {
        let reduced = dof_map.reduced_node(node);
        let phase = dof_map.phase(node);
        for component in 0..3 {
            out[node][component] = phase * reduced_values[reduced][component];
        }
    }
    out
}
