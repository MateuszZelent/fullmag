use crate::fdm::shared::types::{EngineError, Result};

pub(super) type Vector3 = [f64; 3];
pub(super) type Matrix3 = [[f64; 3]; 3];

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
    loop {
        let applied = apply(&solution)?;
        let residual: Vec<f64> = rhs.iter().zip(applied).map(|(b, a)| b - a).collect();
        let beta = norm(&residual);
        if beta <= tolerance {
            return Ok((solution, iterations));
        }
        if iterations >= max_iterations {
            return Err(EngineError::new(format!(
                "M2 block GMRES did not converge in {iterations} iterations"
            )));
        }
        let dimension = restart.min(max_iterations - iterations);
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
