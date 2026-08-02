use crate::fdm::shared::types::{CellSize, EngineError, GridShape, Result};
use crate::Vector3;
use std::f64::consts::PI;

/// Direct midpoint-quadrature Biot-Savart reference for a cell-centered
/// conventional current density.
///
/// The returned magnetic field strength is in A/m:
///
/// `H(r) = (1 / 4 pi) integral J(r') x (r-r') / |r-r'|^3 dV'`.
///
/// A source cell's contribution at its own center is exactly zero by inversion
/// symmetry and is omitted. This O(N^2) routine is an oracle for signs, units,
/// convergence studies, and production FFT qualification; it is not a
/// production large-grid realization.
pub fn biot_savart_midpoint_field(
    grid: GridShape,
    cell_size: CellSize,
    source_active: &[bool],
    current_density_a_per_m2: &[Vector3],
) -> Result<Vec<Vector3>> {
    let count = grid.cell_count();
    if source_active.len() != count || current_density_a_per_m2.len() != count {
        return Err(EngineError::new(format!(
            "Biot-Savart source arrays must contain {count} cell values"
        )));
    }
    if current_density_a_per_m2
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(EngineError::new(
            "Biot-Savart current density must be finite",
        ));
    }

    let positions: Vec<Vector3> = (0..count)
        .map(|cell| cell_center(grid, cell_size, cell))
        .collect();
    let coefficient = cell_size.volume() / (4.0 * PI);
    let mut field = vec![[0.0; 3]; count];
    for target in 0..count {
        for source in 0..count {
            if source == target || !source_active[source] {
                continue;
            }
            let displacement = [
                positions[target][0] - positions[source][0],
                positions[target][1] - positions[source][1],
                positions[target][2] - positions[source][2],
            ];
            let radius_squared = displacement.iter().map(|value| value * value).sum::<f64>();
            let inverse_radius_cubed = 1.0 / (radius_squared * radius_squared.sqrt());
            let cross = cross(current_density_a_per_m2[source], displacement);
            for component in 0..3 {
                field[target][component] += coefficient * cross[component] * inverse_radius_cubed;
            }
        }
    }
    Ok(field)
}

fn cell_center(grid: GridShape, cell_size: CellSize, cell: usize) -> Vector3 {
    let x = cell % grid.nx;
    let yz = cell / grid.nx;
    let y = yz % grid.ny;
    let z = yz / grid.ny;
    [
        (x as f64 + 0.5) * cell_size.dx,
        (y as f64 + 0.5) * cell_size.dy,
        (z as f64 + 0.5) * cell_size.dz,
    ]
}

fn cross(left: Vector3, right: Vector3) -> Vector3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midpoint_biot_savart_matches_single_source_si_oracle_and_sign() {
        let grid = GridShape::new(2, 1, 1).unwrap();
        let cell_size = CellSize::new(2.0e-9, 3.0e-9, 4.0e-9).unwrap();
        let current = 7.0e11;
        let field = biot_savart_midpoint_field(
            grid,
            cell_size,
            &[true, false],
            &[[0.0, 0.0, current], [0.0; 3]],
        )
        .unwrap();

        let distance = cell_size.dx;
        let expected_y = current * cell_size.volume() / (4.0 * PI * distance * distance);
        assert_eq!(field[0], [0.0; 3]);
        assert!((field[1][0]).abs() < 1.0e-15);
        assert!((field[1][1] - expected_y).abs() <= expected_y.abs() * 1.0e-14);
        assert!((field[1][2]).abs() < 1.0e-15);

        let reversed = biot_savart_midpoint_field(
            grid,
            cell_size,
            &[true, false],
            &[[0.0, 0.0, -current], [0.0; 3]],
        )
        .unwrap();
        assert!((reversed[1][1] + field[1][1]).abs() <= expected_y.abs() * 1.0e-14);
    }

    #[test]
    fn midpoint_biot_savart_rejects_nonfinite_current() {
        let grid = GridShape::new(1, 1, 1).unwrap();
        let error = biot_savart_midpoint_field(
            grid,
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            &[true],
            &[[f64::NAN, 0.0, 0.0]],
        )
        .unwrap_err();
        assert!(error.to_string().contains("finite"));
    }
}
