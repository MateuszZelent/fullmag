//! Vector math utilities for 3D vector operations.
//!
//! These are the basic building blocks used throughout the engine
//! for magnetization, field, and energy computations.

#[cfg(feature = "parallel")]
use rayon::prelude::*;

use crate::Vector3;

/// Normalize a vector. Returns `[0, 0, 0]` for zero vectors (inactive cells).
pub fn normalized(vector: Vector3) -> crate::Result<Vector3> {
    let n = norm(vector);
    if n <= 0.0 {
        // Inactive cell (masked out by active_mask) — preserve zero vector
        return Ok([0.0, 0.0, 0.0]);
    }
    Ok(scale(vector, 1.0 / n))
}

/// Maximum Euclidean norm across a slice of vectors.
pub fn max_norm(vectors: &[Vector3]) -> f64 {
    #[cfg(feature = "parallel")]
    {
        vectors
            .par_iter()
            .map(|vector| norm(*vector))
            .reduce(|| 0.0, f64::max)
    }
    #[cfg(not(feature = "parallel"))]
    {
        vectors
            .iter()
            .map(|vector| norm(*vector))
            .fold(0.0, f64::max)
    }
}

/// Component-wise addition.
pub fn add(left: Vector3, right: Vector3) -> Vector3 {
    [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

/// Component-wise subtraction.
pub fn sub(left: Vector3, right: Vector3) -> Vector3 {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

/// Scalar multiplication.
pub fn scale(vector: Vector3, factor: f64) -> Vector3 {
    [vector[0] * factor, vector[1] * factor, vector[2] * factor]
}

/// Dot product.
pub fn dot(left: Vector3, right: Vector3) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

/// Cross product.
pub fn cross(left: Vector3, right: Vector3) -> Vector3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

/// Squared Euclidean norm.
pub fn squared_norm(vector: Vector3) -> f64 {
    dot(vector, vector)
}

/// Euclidean norm.
pub fn norm(vector: Vector3) -> f64 {
    squared_norm(vector).sqrt()
}
