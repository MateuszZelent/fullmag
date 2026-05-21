//! Extraction point for the current scalar-projected eigen operator.
//!
//! The current Fullmag eigen kernel already assembles a real dense
//! generalized eigenproblem for the reference solver. The goal of this file
//! is not to replace that math today, only to give it a clean home and a
//! stable return type so multi-k orchestration, diagnostics and artifacts no
//! longer depend on one monolithic `fem_eigen.rs`.

use crate::eigen::types::EigenSolverModel;
use nalgebra::{DMatrix, DVector, SymmetricEigen};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PetscSlepcBindingDescriptor {
    pub operator_family: &'static str,
    pub matrix_layout: &'static str,
    pub target_solver: &'static str,
    pub rows: usize,
    pub cols: usize,
    pub mass_rows: usize,
    pub mass_cols: usize,
    pub tangent_components_per_node: usize,
    pub supports_csr_export: bool,
}

#[derive(Debug, Clone)]
pub struct AssembledScalarOperator {
    pub stiffness: DMatrix<f64>,
    pub mass: DMatrix<f64>,
    pub solver_model: EigenSolverModel,
    pub notes: Vec<String>,
}

impl AssembledScalarOperator {
    pub fn new(stiffness: DMatrix<f64>, mass: DMatrix<f64>) -> Self {
        Self {
            stiffness,
            mass,
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: vec![
                "scalar-projected reference operator".to_string(),
                "intended as MVP baseline before full tangent-plane LLG".to_string(),
            ],
        }
    }

    pub fn dimension(&self) -> usize {
        self.stiffness.nrows()
    }

    pub fn petsc_slepc_binding_descriptor(&self) -> PetscSlepcBindingDescriptor {
        PetscSlepcBindingDescriptor {
            operator_family: "scalar_projected_tangent_plane",
            matrix_layout: "assembled_symmetric_generalized",
            target_solver: "petsc_slepc_eps_shift_invert",
            rows: self.stiffness.nrows(),
            cols: self.stiffness.ncols(),
            mass_rows: self.mass.nrows(),
            mass_cols: self.mass.ncols(),
            tangent_components_per_node: 1,
            supports_csr_export: true,
        }
    }

    pub fn validate_petsc_slepc_binding(&self) -> Result<(), String> {
        let binding = self.petsc_slepc_binding_descriptor();
        if binding.rows == 0 {
            return Err("assembled tangent operator must not be empty".to_string());
        }
        if binding.rows != binding.cols {
            return Err(format!(
                "stiffness matrix must be square, got {}x{}",
                binding.rows, binding.cols
            ));
        }
        if binding.mass_rows != binding.mass_cols {
            return Err(format!(
                "mass matrix must be square, got {}x{}",
                binding.mass_rows, binding.mass_cols
            ));
        }
        if binding.rows != binding.mass_rows {
            return Err(format!(
                "stiffness/mass dimensions must match, got {} and {}",
                binding.rows, binding.mass_rows
            ));
        }
        Ok(())
    }
}

pub fn apply_reference_bloch_shift(
    stiffness: &mut DMatrix<f64>,
    k_vector: [f64; 3],
    shift_scale: f64,
) {
    let kmag2 = k_vector[0] * k_vector[0] + k_vector[1] * k_vector[1] + k_vector[2] * k_vector[2];
    if kmag2 == 0.0 || shift_scale == 0.0 {
        return;
    }
    let diag_shift = kmag2 * shift_scale;
    let n = stiffness.nrows().min(stiffness.ncols());
    for i in 0..n {
        stiffness[(i, i)] += diag_shift;
    }
}

pub fn solve_dense_reference_modes(
    operator: &AssembledScalarOperator,
    count: usize,
) -> Vec<(f64, DVector<f64>)> {
    if operator.dimension() == 0 || count == 0 {
        return Vec::new();
    }
    // Transitional dense path:
    // In the current repo the production logic already uses dense LAPACK /
    // cuSolver wrappers. This helper is intentionally simple and acts as a
    // self-contained fallback for refactoring and tests.
    let mass_inv = operator
        .mass
        .clone()
        .try_inverse()
        .unwrap_or_else(|| DMatrix::identity(operator.dimension(), operator.dimension()));
    let effective = mass_inv * operator.stiffness.clone();
    let eig = SymmetricEigen::new(effective);
    let mut pairs: Vec<(f64, DVector<f64>)> = eig
        .eigenvalues
        .iter()
        .enumerate()
        .map(|(i, value)| (*value, eig.eigenvectors.column(i).into_owned()))
        .collect();
    pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    pairs.truncate(count);
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_operator_exposes_petsc_slepc_binding_contract() {
        let operator = AssembledScalarOperator::new(
            DMatrix::<f64>::identity(3, 3),
            DMatrix::<f64>::identity(3, 3),
        );

        let binding = operator.petsc_slepc_binding_descriptor();

        assert_eq!(binding.operator_family, "scalar_projected_tangent_plane");
        assert_eq!(binding.matrix_layout, "assembled_symmetric_generalized");
        assert_eq!(binding.target_solver, "petsc_slepc_eps_shift_invert");
        assert_eq!(binding.rows, 3);
        assert_eq!(binding.cols, 3);
        assert_eq!(binding.mass_rows, 3);
        assert_eq!(binding.tangent_components_per_node, 1);
        assert!(binding.supports_csr_export);
        operator
            .validate_petsc_slepc_binding()
            .expect("square stiffness/mass with matching dimensions is bindable");
    }
}
