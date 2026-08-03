use crate::fdm::shared::types::{EngineError, Result};

pub(super) type Vector3 = [f64; 3];
pub(super) type Matrix3 = [[f64; 3]; 3];
pub(super) type Block4 = [[f64; 4]; 4];

#[derive(Debug, Clone, PartialEq)]
pub(super) struct LocalInverseBlock {
    pub inverse_charge: f64,
    pub inverse_spin: Matrix3,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct BlockDiagonalPreconditioner {
    pub blocks: Vec<LocalInverseBlock>,
}

impl BlockDiagonalPreconditioner {
    pub fn apply(&self, values: &[f64]) -> Vec<f64> {
        let mut result = vec![0.0; values.len()];
        for (cell, block) in self.blocks.iter().enumerate() {
            result[4 * cell] = block.inverse_charge * values[4 * cell];
            let spin = [
                values[4 * cell + 1],
                values[4 * cell + 2],
                values[4 * cell + 3],
            ];
            let solved = matrix_vector(block.inverse_spin, spin);
            result[4 * cell + 1..4 * cell + 4].copy_from_slice(&solved);
        }
        result
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct BlockLineSystem {
    pub indices: Vec<usize>,
    pub diagonal: Vec<Block4>,
    pub lower: Vec<Block4>,
    pub upper: Vec<Block4>,
}

#[derive(Debug, Clone, PartialEq)]
struct FactoredBlockLine {
    indices: Vec<usize>,
    diagonal_inverse: Vec<Block4>,
    lower_multiplier: Vec<Block4>,
    upper: Vec<Block4>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct BlockLinePreconditioner {
    lines: Vec<FactoredBlockLine>,
}

impl BlockLinePreconditioner {
    pub fn new(systems: Vec<BlockLineSystem>) -> Result<Self> {
        let mut lines = Vec::with_capacity(systems.len());
        for system in systems {
            let length = system.indices.len();
            if length == 0 || system.diagonal.len() != length {
                return Err(EngineError::new(
                    "M2 line preconditioner has an invalid diagonal layout",
                ));
            }
            if system.lower.len() + 1 != length || system.upper.len() + 1 != length {
                return Err(EngineError::new(
                    "M2 line preconditioner has an invalid off-diagonal layout",
                ));
            }
            let mut diagonal_inverse = Vec::with_capacity(length);
            let mut lower_multiplier = Vec::with_capacity(length.saturating_sub(1));
            let first_inverse = inverse4(system.diagonal[0]).ok_or_else(|| {
                EngineError::new("M2 line preconditioner has a singular first block")
            })?;
            diagonal_inverse.push(first_inverse);
            for index in 1..length {
                let multiplier = multiply4(system.lower[index - 1], diagonal_inverse[index - 1]);
                let schur = subtract4(
                    system.diagonal[index],
                    multiply4(multiplier, system.upper[index - 1]),
                );
                let inverse = inverse4(schur).ok_or_else(|| {
                    EngineError::new("M2 line preconditioner has a singular Schur block")
                })?;
                lower_multiplier.push(multiplier);
                diagonal_inverse.push(inverse);
            }
            lines.push(FactoredBlockLine {
                indices: system.indices,
                diagonal_inverse,
                lower_multiplier,
                upper: system.upper,
            });
        }
        Ok(Self { lines })
    }

    pub fn apply(&self, values: &[f64]) -> Vec<f64> {
        let mut result = vec![0.0; values.len()];
        for line in &self.lines {
            let length = line.indices.len();
            let mut right_hand_side = Vec::with_capacity(length);
            for &cell in &line.indices {
                right_hand_side.push(read_block4(values, cell));
            }
            for index in 1..length {
                let correction =
                    multiply_vector4(line.lower_multiplier[index - 1], right_hand_side[index - 1]);
                right_hand_side[index] = subtract_vector4(right_hand_side[index], correction);
            }
            let mut solution = vec![[0.0; 4]; length];
            solution[length - 1] = multiply_vector4(
                line.diagonal_inverse[length - 1],
                right_hand_side[length - 1],
            );
            for index in (0..length.saturating_sub(1)).rev() {
                let coupling = multiply_vector4(line.upper[index], solution[index + 1]);
                solution[index] = multiply_vector4(
                    line.diagonal_inverse[index],
                    subtract_vector4(right_hand_side[index], coupling),
                );
            }
            for (index, &cell) in line.indices.iter().enumerate() {
                write_block4(&mut result, cell, solution[index]);
            }
        }
        result
    }
}

pub(super) fn identity3() -> Matrix3 {
    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
}

pub(super) fn scale_matrix(mut matrix: Matrix3, factor: f64) -> Matrix3 {
    for row in &mut matrix {
        for value in row {
            *value *= factor;
        }
    }
    matrix
}

pub(super) fn add_scaled_matrix(target: &mut Matrix3, source: Matrix3, factor: f64) {
    for row in 0..3 {
        for column in 0..3 {
            target[row][column] += factor * source[row][column];
        }
    }
}

pub(super) fn cross_right_matrix(m: Vector3) -> Matrix3 {
    [[0.0, m[2], -m[1]], [-m[2], 0.0, m[0]], [m[1], -m[0], 0.0]]
}

pub(super) fn transverse_projector(m: Vector3) -> Matrix3 {
    let mut result = identity3();
    for row in 0..3 {
        for column in 0..3 {
            result[row][column] -= m[row] * m[column];
        }
    }
    result
}

pub(super) fn inverse3(matrix: Matrix3) -> Option<Matrix3> {
    let determinant = matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
    if !determinant.is_finite() || determinant.abs() <= 1.0e-300 {
        return None;
    }
    let inverse_determinant = 1.0 / determinant;
    Some([
        [
            (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1]) * inverse_determinant,
            (matrix[0][2] * matrix[2][1] - matrix[0][1] * matrix[2][2]) * inverse_determinant,
            (matrix[0][1] * matrix[1][2] - matrix[0][2] * matrix[1][1]) * inverse_determinant,
        ],
        [
            (matrix[1][2] * matrix[2][0] - matrix[1][0] * matrix[2][2]) * inverse_determinant,
            (matrix[0][0] * matrix[2][2] - matrix[0][2] * matrix[2][0]) * inverse_determinant,
            (matrix[0][2] * matrix[1][0] - matrix[0][0] * matrix[1][2]) * inverse_determinant,
        ],
        [
            (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]) * inverse_determinant,
            (matrix[0][1] * matrix[2][0] - matrix[0][0] * matrix[2][1]) * inverse_determinant,
            (matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0]) * inverse_determinant,
        ],
    ])
}

fn inverse4(matrix: Block4) -> Option<Block4> {
    let mut augmented = [[0.0; 8]; 4];
    for row in 0..4 {
        augmented[row][..4].copy_from_slice(&matrix[row]);
        augmented[row][4 + row] = 1.0;
    }
    for column in 0..4 {
        let pivot = (column..4).max_by(|&left, &right| {
            augmented[left][column]
                .abs()
                .total_cmp(&augmented[right][column].abs())
        })?;
        if augmented[pivot][column].abs() <= 1.0e-300 {
            return None;
        }
        augmented.swap(column, pivot);
        let pivot_value = augmented[column][column];
        for value in &mut augmented[column] {
            *value /= pivot_value;
        }
        for row in 0..4 {
            if row == column {
                continue;
            }
            let factor = augmented[row][column];
            for entry in 0..8 {
                augmented[row][entry] -= factor * augmented[column][entry];
            }
        }
    }
    let mut inverse = [[0.0; 4]; 4];
    for row in 0..4 {
        inverse[row].copy_from_slice(&augmented[row][4..]);
    }
    Some(inverse)
}

fn multiply4(left: Block4, right: Block4) -> Block4 {
    let mut result = [[0.0; 4]; 4];
    for row in 0..4 {
        for column in 0..4 {
            result[row][column] = (0..4)
                .map(|index| left[row][index] * right[index][column])
                .sum();
        }
    }
    result
}

fn subtract4(left: Block4, right: Block4) -> Block4 {
    let mut result = [[0.0; 4]; 4];
    for row in 0..4 {
        for column in 0..4 {
            result[row][column] = left[row][column] - right[row][column];
        }
    }
    result
}

fn multiply_vector4(matrix: Block4, vector: [f64; 4]) -> [f64; 4] {
    let mut result = [0.0; 4];
    for row in 0..4 {
        result[row] = (0..4)
            .map(|column| matrix[row][column] * vector[column])
            .sum();
    }
    result
}

fn subtract_vector4(left: [f64; 4], right: [f64; 4]) -> [f64; 4] {
    [
        left[0] - right[0],
        left[1] - right[1],
        left[2] - right[2],
        left[3] - right[3],
    ]
}

fn read_block4(values: &[f64], cell: usize) -> [f64; 4] {
    [
        values[4 * cell],
        values[4 * cell + 1],
        values[4 * cell + 2],
        values[4 * cell + 3],
    ]
}

fn write_block4(values: &mut [f64], cell: usize, block: [f64; 4]) {
    values[4 * cell..4 * cell + 4].copy_from_slice(&block);
}

pub(super) fn relative_vector_update(new: &[Vector3], old: &[Vector3]) -> f64 {
    let delta = new
        .iter()
        .zip(old)
        .flat_map(|(a, b)| (0..3).map(move |component| (a[component] - b[component]).powi(2)))
        .sum::<f64>()
        .sqrt();
    let value = new
        .iter()
        .flatten()
        .map(|entry| entry * entry)
        .sum::<f64>()
        .sqrt();
    delta / value.max(1.0e-30)
}

pub(super) fn relative_spin_state_update(new: &[f64], old: &[f64], count: usize) -> f64 {
    let mut delta = 0.0;
    let mut value = 0.0;
    for cell in 0..count {
        for component in 1..4 {
            delta += (new[4 * cell + component] - old[4 * cell + component]).powi(2);
            value += new[4 * cell + component].powi(2);
        }
    }
    delta.sqrt() / value.sqrt().max(1.0e-30)
}

pub(super) fn restarted_gmres<F>(
    rhs: &[f64],
    restart: usize,
    max_iterations: usize,
    tolerance: f64,
    apply: F,
) -> Result<(Vec<f64>, usize)>
where
    F: Fn(&[f64]) -> Result<Vec<f64>>,
{
    let mut solution = vec![0.0; rhs.len()];
    let mut iterations = 0;
    let mut effective_restart = restart;
    let mut previous_cycle_residual = None;
    loop {
        let applied = apply(&solution)?;
        let residual: Vec<f64> = rhs.iter().zip(applied).map(|(b, a)| b - a).collect();
        let beta = norm(&residual);
        if beta <= tolerance {
            return Ok((solution, iterations));
        }
        if iterations >= max_iterations {
            return Err(EngineError::new(format!(
                "M2 block GMRES did not converge in {iterations} iterations (residual {beta:.6e}, tolerance {tolerance:.6e})"
            )));
        }
        if previous_cycle_residual.is_some() && beta > 100.0 * tolerance {
            // A short restarted basis can stagnate on the long-wavelength modes
            // of the coupled charge/spin diffusion operator.  Grow the basis
            // while the residual is still materially above the requested
            // tolerance; this preserves the authored restart as the low-memory
            // starting point while remaining robust for refined meshes and
            // strong reciprocal SHE coupling.
            effective_restart = effective_restart
                .saturating_mul(2)
                .min(max_iterations - iterations)
                .max(1);
        }
        previous_cycle_residual = Some(beta);
        let dimension = effective_restart.min(max_iterations - iterations);
        let mut basis = Vec::with_capacity(dimension + 1);
        basis.push(
            residual
                .iter()
                .map(|value| value / beta)
                .collect::<Vec<_>>(),
        );
        let mut hessenberg = vec![vec![0.0; dimension]; dimension + 1];
        let mut cosine = vec![0.0; dimension];
        let mut sine = vec![0.0; dimension];
        let mut rotated_rhs = vec![0.0; dimension + 1];
        rotated_rhs[0] = beta;
        let mut used = 0;
        for column in 0..dimension {
            let mut vector = apply(&basis[column])?;
            for row in 0..=column {
                hessenberg[row][column] = dot_slice(&vector, &basis[row]);
                for index in 0..vector.len() {
                    vector[index] -= hessenberg[row][column] * basis[row][index];
                }
            }
            for row in 0..=column {
                let correction = dot_slice(&vector, &basis[row]);
                hessenberg[row][column] += correction;
                for index in 0..vector.len() {
                    vector[index] -= correction * basis[row][index];
                }
            }
            hessenberg[column + 1][column] = norm(&vector);
            if hessenberg[column + 1][column] > 1.0e-30 {
                basis.push(
                    vector
                        .iter()
                        .map(|value| value / hessenberg[column + 1][column])
                        .collect(),
                );
            } else {
                basis.push(vec![0.0; vector.len()]);
            }
            for row in 0..column {
                let upper =
                    cosine[row] * hessenberg[row][column] + sine[row] * hessenberg[row + 1][column];
                hessenberg[row + 1][column] = -sine[row] * hessenberg[row][column]
                    + cosine[row] * hessenberg[row + 1][column];
                hessenberg[row][column] = upper;
            }
            let denominator = hessenberg[column][column].hypot(hessenberg[column + 1][column]);
            if denominator <= 1.0e-300 {
                return Err(EngineError::new("M2 block GMRES Arnoldi breakdown"));
            }
            cosine[column] = hessenberg[column][column] / denominator;
            sine[column] = hessenberg[column + 1][column] / denominator;
            hessenberg[column][column] = denominator;
            hessenberg[column + 1][column] = 0.0;
            rotated_rhs[column + 1] = -sine[column] * rotated_rhs[column];
            rotated_rhs[column] = cosine[column] * rotated_rhs[column];
            used = column + 1;
            iterations += 1;
            if rotated_rhs[column + 1].abs() <= tolerance || iterations >= max_iterations {
                break;
            }
        }
        let mut coefficients = vec![0.0; used];
        for row in (0..used).rev() {
            let tail: f64 = ((row + 1)..used)
                .map(|column| hessenberg[row][column] * coefficients[column])
                .sum();
            coefficients[row] = (rotated_rhs[row] - tail) / hessenberg[row][row];
        }
        for column in 0..used {
            for index in 0..solution.len() {
                solution[index] += coefficients[column] * basis[column][index];
            }
        }
    }
}

pub(super) fn norm(values: &[f64]) -> f64 {
    values.iter().map(|value| value * value).sum::<f64>().sqrt()
}

fn matrix_vector(matrix: Matrix3, vector: Vector3) -> Vector3 {
    [
        dot3(matrix[0], vector),
        dot3(matrix[1], vector),
        dot3(matrix[2], vector),
    ]
}

fn dot3(left: Vector3, right: Vector3) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn dot_slice(left: &[f64], right: &[f64]) -> f64 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

#[cfg(test)]
mod tests {
    use super::{norm, restarted_gmres, BlockLinePreconditioner, BlockLineSystem};

    #[test]
    fn gmres_grows_restart_after_a_krylov_plateau() {
        let diagonal: Vec<f64> = (0..24).map(|index| 10.0_f64.powi(index / 3)).collect();
        let rhs = vec![1.0; diagonal.len()];
        let (solution, iterations) = restarted_gmres(&rhs, 2, 64, 1.0e-12, |value| {
            Ok(value
                .iter()
                .zip(&diagonal)
                .map(|(entry, diagonal)| entry * diagonal)
                .collect())
        })
        .expect("adaptive restarted GMRES should solve the diagonal system");
        let residual: Vec<f64> = rhs
            .iter()
            .zip(&solution)
            .zip(&diagonal)
            .map(|((right, value), diagonal)| right - value * diagonal)
            .collect();
        assert!(norm(&residual) <= 1.0e-12);
        assert!(iterations <= 64);
    }

    #[test]
    fn block_line_preconditioner_solves_a_nonsymmetric_two_cell_system() {
        let mut diagonal = [[0.0; 4]; 4];
        for index in 0..4 {
            diagonal[index][index] = 4.0;
        }
        let mut coupling = [[0.0; 4]; 4];
        for index in 0..4 {
            coupling[index][index] = -1.0;
        }
        let preconditioner = BlockLinePreconditioner::new(vec![BlockLineSystem {
            indices: vec![0, 1],
            diagonal: vec![diagonal, diagonal],
            lower: vec![coupling],
            upper: vec![coupling],
        }])
        .expect("two-cell block line must factor");
        let result = preconditioner.apply(&[1.0; 8]);
        for value in result {
            assert!((value - 1.0 / 3.0).abs() < 1.0e-12);
        }
    }
}
