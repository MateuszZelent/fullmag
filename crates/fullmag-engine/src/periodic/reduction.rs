//! Algebraic periodic reduction operators for FEM static/time-domain PBC.
//!
//! Implements the `P^T A P` reduction strategy:
//!
//! ```text
//! A_red = P^T A_full P      (reduced stiffness)
//! b_red = P^T b_full        (reduced right-hand side)
//! u_full = P u_red          (lift reduced solution to full space)
//! ```
//!
//! where `P` is the injection operator that maps each reduced DOF to all nodes
//! in the same periodic class.
//!
//! The mapping is provided as a flat `full_to_reduced: &[usize]` array of
//! length `n_full` where `full_to_reduced[i]` gives the representative class
//! index for full node `i`.

use crate::fem::CsrMatrix;
use crate::Vector3;
use std::collections::BTreeMap;

/// Reduce a square CSR operator by static periodic node classes.
///
/// Computes `A_red = P^T A_full P`:
/// - each row/column of `A_full` that belongs to class `c` contributes to
///   the reduced row/column `c`.
///
/// # Panics
/// Panics if `full_to_reduced.len() != full.n`.
pub fn reduce_csr_by_periodic_classes(
    full: &CsrMatrix,
    full_to_reduced: &[usize],
    reduced_n: usize,
) -> CsrMatrix {
    assert_eq!(
        full.n,
        full_to_reduced.len(),
        "full_to_reduced length must equal the matrix dimension"
    );

    // Accumulate reduced non-zeros into a BTreeMap for automatic deduplication.
    // Key: (reduced_row, reduced_col), Value: accumulated value.
    let mut entries: BTreeMap<(usize, usize), f64> = BTreeMap::new();

    for row in 0..full.n {
        let reduced_row = full_to_reduced[row];
        for idx in full.row_ptr[row]..full.row_ptr[row + 1] {
            let col = full.col_idx[idx];
            let val = full.values[idx];
            let reduced_col = full_to_reduced[col];
            *entries.entry((reduced_row, reduced_col)).or_insert(0.0) += val;
        }
    }

    // Build CSR from accumulated entries.
    let mut row_ptr = vec![0usize; reduced_n + 1];
    let mut col_idx = Vec::new();
    let mut values = Vec::new();

    // Count nnz per row.
    for &(r, _) in entries.keys() {
        row_ptr[r + 1] += 1;
    }
    // Prefix sum.
    for i in 0..reduced_n {
        row_ptr[i + 1] += row_ptr[i];
    }
    // Fill.
    let mut row_pos: Vec<usize> = row_ptr[..reduced_n].to_vec();
    col_idx.resize(entries.len(), 0);
    values.resize(entries.len(), 0.0);
    for (&(r, c), &v) in &entries {
        let pos = row_pos[r];
        col_idx[pos] = c;
        values[pos] = v;
        row_pos[r] += 1;
    }

    CsrMatrix {
        row_ptr,
        col_idx,
        values,
        n: reduced_n,
    }
}

/// Reduce a right-hand-side vector: `b_red = P^T b_full`.
///
/// Each contribution `b_full[i]` is added to `b_red[full_to_reduced[i]]`.
///
/// # Panics
/// Panics if `full_rhs.len() != full_to_reduced.len()`.
pub fn reduce_rhs_by_periodic_classes(
    full_rhs: &[f64],
    full_to_reduced: &[usize],
    reduced_n: usize,
) -> Vec<f64> {
    assert_eq!(
        full_rhs.len(),
        full_to_reduced.len(),
        "RHS length must equal full_to_reduced length"
    );
    let mut reduced = vec![0.0f64; reduced_n];
    for (i, &v) in full_rhs.iter().enumerate() {
        reduced[full_to_reduced[i]] += v;
    }
    reduced
}

/// Lift a reduced scalar solution back to the full space: `u_full = P u_red`.
///
/// Every full node `i` gets the value of its representative class.
///
/// # Panics
/// Panics if `full_to_reduced.len() != full_n`.
pub fn lift_scalar_by_periodic_classes(
    reduced: &[f64],
    full_to_reduced: &[usize],
    full_n: usize,
) -> Vec<f64> {
    assert_eq!(
        full_to_reduced.len(),
        full_n,
        "full_to_reduced length must equal full_n"
    );
    (0..full_n).map(|i| reduced[full_to_reduced[i]]).collect()
}

/// Project a full vector field to periodic classes by arithmetic class average.
///
/// After computing a field on all full nodes, this averages each class so that
/// all nodes in the same periodic class carry the same value. Use for fields
/// that are derived from the reduced solution (e.g. `H_demag`).
///
/// # Panics
/// Panics if `field.len() != full_to_reduced.len()`.
pub fn project_vector_field_by_periodic_classes(
    field: &mut [Vector3],
    full_to_reduced: &[usize],
    reduced_n: usize,
) {
    assert_eq!(
        field.len(),
        full_to_reduced.len(),
        "field length must equal full_to_reduced length"
    );

    // First pass: accumulate per-class sum.
    let mut class_sum = vec![[0.0f64; 3]; reduced_n];
    let mut class_count = vec![0usize; reduced_n];
    for (i, v) in field.iter().enumerate() {
        let c = full_to_reduced[i];
        class_sum[c][0] += v[0];
        class_sum[c][1] += v[1];
        class_sum[c][2] += v[2];
        class_count[c] += 1;
    }

    // Second pass: compute class average and write back.
    for (i, v) in field.iter_mut().enumerate() {
        let c = full_to_reduced[i];
        let n = class_count[c] as f64;
        if n > 0.0 {
            *v = [
                class_sum[c][0] / n,
                class_sum[c][1] / n,
                class_sum[c][2] / n,
            ];
        }
    }
}

/// Copy the representative node's value to all nodes in the same class.
///
/// Use for magnetization state after a solve step, where class averaging
/// could slightly violate `|m| = 1`.  Instead of averaging, copy the
/// representative value to every slave node.
///
/// `representative_nodes[c]` must give the full-node index of the
/// representative for class `c`.
///
/// # Panics
/// Panics if `field.len() != full_to_reduced.len()`.
pub fn project_vector_field_by_representative(
    field: &mut [Vector3],
    full_to_reduced: &[usize],
    representative_nodes: &[usize],
) {
    assert_eq!(
        field.len(),
        full_to_reduced.len(),
        "field length must equal full_to_reduced length"
    );
    let snapshot = field.to_vec();
    for (i, v) in field.iter_mut().enumerate() {
        let c = full_to_reduced[i];
        let rep = representative_nodes[c];
        *v = snapshot[rep];
    }
}

/// Validate that a per-node scalar field is constant within each periodic class.
///
/// Returns `Ok(())` if all nodes in each class carry the same value (within
/// the given absolute tolerance). Returns `Err` with a descriptive message if
/// any violation is found.
pub fn validate_periodic_scalar_field_classes(
    full_to_reduced: &[usize],
    representative_nodes: &[usize],
    field: &[f64],
    field_name: &str,
    atol: f64,
) -> Result<(), String> {
    if field.is_empty() {
        return Ok(());
    }
    assert_eq!(
        field.len(),
        full_to_reduced.len(),
        "field length must equal full_to_reduced length"
    );
    for (i, &val) in field.iter().enumerate() {
        let c = full_to_reduced[i];
        let rep = representative_nodes[c];
        let expected = field[rep];
        let tol = atol * expected.abs().max(1.0);
        if (val - expected).abs() > tol {
            return Err(format!(
                "periodic node class {c}: per-node field '{field_name}' differs between \
                 representative node {rep} (value={expected:.6e}) and node {i} \
                 (value={val:.6e}); difference={:.6e}, tolerance={tol:.6e}",
                (val - expected).abs()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_node_pair() -> (Vec<usize>, Vec<usize>, usize) {
        // Nodes 0,2 → class 0; node 1 → class 1; node 3 → class 2
        let full_to_reduced = vec![0, 1, 0, 2];
        let representative_nodes = vec![0, 1, 3];
        (full_to_reduced, representative_nodes, 3)
    }

    #[test]
    fn reduce_rhs_sums_classes() {
        let (full_to_reduced, _, reduced_n) = two_node_pair();
        let rhs = vec![1.0, 2.0, 3.0, 4.0];
        let reduced = reduce_rhs_by_periodic_classes(&rhs, &full_to_reduced, reduced_n);
        assert_eq!(reduced, vec![4.0, 2.0, 4.0]); // class 0: 1+3, class 1: 2, class 2: 4
    }

    #[test]
    fn lift_scalar_broadcasts() {
        let (full_to_reduced, _, _reduced_n) = two_node_pair();
        let reduced = vec![10.0, 20.0, 30.0];
        let full = lift_scalar_by_periodic_classes(&reduced, &full_to_reduced, 4);
        assert_eq!(full, vec![10.0, 20.0, 10.0, 30.0]);
    }

    #[test]
    fn project_vector_field_averages_classes() {
        let full_to_reduced = vec![0, 1, 0];
        let mut field: Vec<Vector3> = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [3.0, 0.0, 0.0]];
        project_vector_field_by_periodic_classes(&mut field, &full_to_reduced, 2);
        // class 0: average of nodes 0,2 = [2,0,0]
        assert!((field[0][0] - 2.0).abs() < 1e-14);
        assert!((field[2][0] - 2.0).abs() < 1e-14);
        // class 1: node 1 unchanged
        assert!((field[1][1] - 1.0).abs() < 1e-14);
    }

    #[test]
    fn project_by_representative_copies_rep() {
        let full_to_reduced = vec![0, 0, 1];
        let representative_nodes = vec![0, 2];
        let mut field: Vec<Vector3> = vec![[1.0, 0.0, 0.0], [5.0, 0.0, 0.0], [3.0, 0.0, 0.0]];
        project_vector_field_by_representative(&mut field, &full_to_reduced, &representative_nodes);
        // All class-0 nodes get value of node 0
        assert_eq!(field[0][0], 1.0);
        assert_eq!(field[1][0], 1.0);
        // Class-1 node gets value of node 2
        assert_eq!(field[2][0], 3.0);
    }

    #[test]
    fn validate_field_classes_accepts_consistent() {
        let full_to_reduced = vec![0, 1, 0];
        let representative_nodes = vec![0, 1];
        let field = vec![2.0, 3.0, 2.0]; // nodes 0,2 in class 0 both have 2.0
        assert!(validate_periodic_scalar_field_classes(
            &full_to_reduced,
            &representative_nodes,
            &field,
            "test_field",
            1e-12
        )
        .is_ok());
    }

    #[test]
    fn validate_field_classes_rejects_inconsistent() {
        let full_to_reduced = vec![0, 1, 0];
        let representative_nodes = vec![0, 1];
        let field = vec![2.0, 3.0, 5.0]; // nodes 0,2 in class 0 differ
        assert!(validate_periodic_scalar_field_classes(
            &full_to_reduced,
            &representative_nodes,
            &field,
            "test_field",
            1e-12
        )
        .is_err());
    }

    #[test]
    fn reduce_csr_roundtrip_diagonal() {
        // 3-node diagonal matrix, nodes 0,2 in class 0; node 1 in class 1.
        // A = diag(1, 2, 3), full_to_reduced = [0,1,0]
        let full = CsrMatrix {
            n: 3,
            row_ptr: vec![0, 1, 2, 3],
            col_idx: vec![0, 1, 2],
            values: vec![1.0, 2.0, 3.0],
        };
        let full_to_reduced = vec![0, 1, 0];
        let reduced = reduce_csr_by_periodic_classes(&full, &full_to_reduced, 2);
        // Reduced 2x2: class 0 diagonal = 1+3=4, class 1 diagonal = 2
        assert_eq!(reduced.n, 2);
        // Find diagonal entries
        let mut d0 = 0.0_f64;
        let mut d1 = 0.0_f64;
        for r in 0..2 {
            for idx in reduced.row_ptr[r]..reduced.row_ptr[r + 1] {
                if reduced.col_idx[idx] == r {
                    if r == 0 {
                        d0 = reduced.values[idx];
                    } else {
                        d1 = reduced.values[idx];
                    }
                }
            }
        }
        assert!((d0 - 4.0).abs() < 1e-14);
        assert!((d1 - 2.0).abs() < 1e-14);
    }
}
