//! Per-connection FDM exchange coefficients shared by the CPU reference and
//! the CUDA lane (physics note 0104, `material-fdm-connection-coefficient`).
//!
//! A connection joins a cell to its `+x`, `+y` or `+z` neighbour. Its
//! coefficient is stored on the lower cell, so the `-x` coefficient of cell
//! `i` is `x_plus[xm(i)]`. Region indices are unbounded `u32` values and pair
//! rules are resolved per connection, so the cost does not depend on the
//! number of regions.

use std::collections::HashMap;

use super::types::GridShape;

/// Exchange rule between two regions; see [`ExchangePairRule`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExchangePairMode {
    /// `A_ij = scale * H(A_i, A_j)`.
    HarmonicScale(f64),
    /// `A_ij` is the given stiffness [J/m].
    Explicit(f64),
    /// No exchange across the interface.
    Disabled,
}

/// Symmetric rule for the connections between two region indices.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExchangePairRule {
    pub region_i: u32,
    pub region_j: u32,
    pub mode: ExchangePairMode,
}

/// Exchange stiffness [J/m] of every `+x`, `+y`, `+z` connection; zero where
/// no connection exists.
#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeFaces {
    pub x_plus: Vec<f64>,
    pub y_plus: Vec<f64>,
    pub z_plus: Vec<f64>,
}

/// Realized exchange operator. `Uniform` means every existing connection has
/// the scalar material stiffness, so the classic Laplacian kernels apply.
#[derive(Debug, Clone, PartialEq)]
pub enum ExchangeOperator {
    Uniform,
    Faces(ExchangeFaces),
}

/// Inputs of [`build_exchange_operator`]. Optional per-cell slices must have
/// `grid.cell_count()` entries; `region_owner` is indexed by region index.
#[derive(Debug, Clone, Copy)]
pub struct ExchangeOperatorInputs<'a> {
    pub grid: GridShape,
    pub periodic: [bool; 3],
    pub active: Option<&'a [bool]>,
    pub region_mask: Option<&'a [u32]>,
    pub region_owner: Option<&'a [u32]>,
    pub exchange_stiffness: f64,
    pub a_field: Option<&'a [f64]>,
    pub rules: &'a [ExchangePairRule],
}

/// Guarded harmonic mean `H(a, b)` (note 0104,
/// `material-fdm-guarded-harmonic-mean`). Equal arguments return `a` exactly.
#[inline]
pub fn harmonic_exchange(a: f64, b: f64) -> f64 {
    if a == 0.0 || b == 0.0 {
        0.0
    } else if a == b {
        a
    } else {
        2.0 * a * (b / (a + b))
    }
}

/// Resolve every grid connection into an exchange coefficient.
pub fn build_exchange_operator(
    inputs: &ExchangeOperatorInputs<'_>,
) -> Result<ExchangeOperator, String> {
    let grid = inputs.grid;
    let cells = grid.cell_count();
    check_len("active", inputs.active.map(<[bool]>::len), cells)?;
    check_len("region_mask", inputs.region_mask.map(<[u32]>::len), cells)?;
    check_len("a_field", inputs.a_field.map(<[f64]>::len), cells)?;
    if !inputs.exchange_stiffness.is_finite() || inputs.exchange_stiffness < 0.0 {
        return Err(format!(
            "exchange stiffness must be finite and >= 0, got {}",
            inputs.exchange_stiffness
        ));
    }
    if let Some(field) = inputs.a_field {
        if let Some(index) = field.iter().position(|a| !a.is_finite() || *a < 0.0) {
            return Err(format!(
                "a_field[{index}] must be finite and >= 0, got {}",
                field[index]
            ));
        }
    }

    let mut rules = HashMap::with_capacity(inputs.rules.len());
    for rule in inputs.rules {
        let key = ordered_pair(rule.region_i, rule.region_j);
        if let Some(previous) = rules.insert(key, rule.mode) {
            if previous != rule.mode {
                return Err(format!(
                    "conflicting exchange rules for regions ({}, {})",
                    key.0, key.1
                ));
            }
        }
    }

    let is_active = |index: usize| inputs.active.map_or(true, |mask| mask[index]);
    let a_at = |index: usize| inputs.a_field.map_or(inputs.exchange_stiffness, |a| a[index]);
    let region_at = |index: usize| inputs.region_mask.map_or(0, |mask| mask[index]);
    let owner_of = |region: u32| -> Result<u32, String> {
        match inputs.region_owner {
            None => Ok(0),
            Some(owners) => owners.get(region as usize).copied().ok_or_else(|| {
                format!(
                    "region index {region} has no owner entry (region_owner_len={})",
                    owners.len()
                )
            }),
        }
    };
    let connection = |i: usize, j: usize| -> Result<f64, String> {
        if i == j || !is_active(i) || !is_active(j) {
            return Ok(0.0);
        }
        let (region_i, region_j) = (region_at(i), region_at(j));
        let harmonic = || harmonic_exchange(a_at(i), a_at(j));
        if region_i == region_j {
            return Ok(harmonic());
        }
        match rules.get(&ordered_pair(region_i, region_j)) {
            Some(ExchangePairMode::Disabled) => Ok(0.0),
            Some(ExchangePairMode::Explicit(value)) => Ok(*value),
            Some(ExchangePairMode::HarmonicScale(scale)) => Ok(scale * harmonic()),
            None if owner_of(region_i)? != owner_of(region_j)? => Ok(0.0),
            None => Ok(harmonic()),
        }
    };

    let mut faces = ExchangeFaces {
        x_plus: vec![0.0; cells],
        y_plus: vec![0.0; cells],
        z_plus: vec![0.0; cells],
    };
    let dims = [grid.nx, grid.ny, grid.nz];
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let index = grid.index(x, y, z);
                let coords = [x, y, z];
                for axis in 0..3 {
                    let Some(neighbor) =
                        plus_neighbor(grid, coords, axis, dims[axis], inputs.periodic[axis])
                    else {
                        continue;
                    };
                    let value = connection(index, neighbor)?;
                    match axis {
                        0 => faces.x_plus[index] = value,
                        1 => faces.y_plus[index] = value,
                        _ => faces.z_plus[index] = value,
                    }
                }
            }
        }
    }

    if is_uniform(&faces, grid, inputs) {
        Ok(ExchangeOperator::Uniform)
    } else {
        Ok(ExchangeOperator::Faces(faces))
    }
}

/// First `+x/+y/+z` connection with a zero coefficient between two distinct
/// active cells, as `(cell, neighbour)`. Such a connection is a free surface
/// for exchange; the FDM DMI stencils do not read the faces and would couple
/// across it (note 0104, DMI across decoupled connections).
pub fn first_decoupled_connection(
    faces: &ExchangeFaces,
    grid: GridShape,
    periodic: [bool; 3],
    active: Option<&[bool]>,
) -> Option<(usize, usize)> {
    let is_active = |index: usize| active.map_or(true, |mask| mask[index]);
    let dims = [grid.nx, grid.ny, grid.nz];
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let index = grid.index(x, y, z);
                if !is_active(index) {
                    continue;
                }
                for (axis, values) in [&faces.x_plus, &faces.y_plus, &faces.z_plus]
                    .into_iter()
                    .enumerate()
                {
                    let Some(neighbor) =
                        plus_neighbor(grid, [x, y, z], axis, dims[axis], periodic[axis])
                    else {
                        continue;
                    };
                    if neighbor != index && is_active(neighbor) && values[index] == 0.0 {
                        return Some((index, neighbor));
                    }
                }
            }
        }
    }
    None
}

fn check_len(name: &str, len: Option<usize>, cells: usize) -> Result<(), String> {
    match len {
        Some(len) if len != cells => Err(format!(
            "{name} length mismatch: expected {cells}, got {len}"
        )),
        _ => Ok(()),
    }
}

#[inline]
fn ordered_pair(a: u32, b: u32) -> (u32, u32) {
    (a.min(b), a.max(b))
}

/// `+1` neighbour along `axis`, wrapped when periodic; `None` at an open
/// boundary.
fn plus_neighbor(
    grid: GridShape,
    coords: [usize; 3],
    axis: usize,
    len: usize,
    periodic: bool,
) -> Option<usize> {
    let mut next = coords;
    if coords[axis] + 1 < len {
        next[axis] += 1;
    } else if periodic {
        next[axis] = 0;
    } else {
        return None;
    }
    Some(grid.index(next[0], next[1], next[2]))
}

/// Every existing connection carries exactly the scalar stiffness, and a
/// consumer that ignores the faces reproduces them: `Uniform` leaves the CPU on
/// its per-cell `a_field` stencil and CUDA on the scalar `A`, so a cellwise `A`
/// that differs from the scalar on an active cell must stay `Faces` even when
/// rules make every connection equal to the scalar.
fn is_uniform(faces: &ExchangeFaces, grid: GridShape, inputs: &ExchangeOperatorInputs<'_>) -> bool {
    let a = inputs.exchange_stiffness;
    let is_active = |index: usize| inputs.active.map_or(true, |mask| mask[index]);
    if let Some(a_field) = inputs.a_field {
        if a_field
            .iter()
            .enumerate()
            .any(|(index, value)| is_active(index) && *value != a)
        {
            return false;
        }
    }
    let dims = [grid.nx, grid.ny, grid.nz];
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let index = grid.index(x, y, z);
                for (axis, values) in [&faces.x_plus, &faces.y_plus, &faces.z_plus]
                    .into_iter()
                    .enumerate()
                {
                    let Some(neighbor) =
                        plus_neighbor(grid, [x, y, z], axis, dims[axis], inputs.periodic[axis])
                    else {
                        continue;
                    };
                    let exists = neighbor != index && is_active(index) && is_active(neighbor);
                    if exists && values[index] != a {
                        return false;
                    }
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(nx: usize, ny: usize, nz: usize) -> GridShape {
        GridShape::new(nx, ny, nz).expect("valid grid")
    }

    fn inputs<'a>(grid: GridShape) -> ExchangeOperatorInputs<'a> {
        ExchangeOperatorInputs {
            grid,
            periodic: [false; 3],
            active: None,
            region_mask: None,
            region_owner: None,
            exchange_stiffness: 1e-11,
            a_field: None,
            rules: &[],
        }
    }

    fn faces(operator: ExchangeOperator) -> ExchangeFaces {
        match operator {
            ExchangeOperator::Faces(faces) => faces,
            ExchangeOperator::Uniform => panic!("expected face coefficients"),
        }
    }

    #[test]
    fn harmonic_exchange_cases() {
        assert_eq!(harmonic_exchange(0.0, 3e-11), 0.0);
        assert_eq!(harmonic_exchange(3e-11, 0.0), 0.0);
        assert_eq!(harmonic_exchange(1.3e-11, 1.3e-11).to_bits(), 1.3e-11f64.to_bits());
        assert!((harmonic_exchange(1e-11, 3e-11) - 1.5e-11).abs() <= 1e-26);
    }

    #[test]
    fn two_cells_rules() {
        let a = [1e-11, 3e-11];
        let mask = [1u32, 2];
        let cases = [
            (None, 1.5e-11),
            (Some(ExchangePairMode::HarmonicScale(0.5)), 0.75e-11),
            (Some(ExchangePairMode::Explicit(2e-11)), 2e-11),
            (Some(ExchangePairMode::Disabled), 0.0),
        ];
        for (mode, expected) in cases {
            let rules: Vec<ExchangePairRule> = mode
                .map(|mode| ExchangePairRule {
                    region_i: 2,
                    region_j: 1,
                    mode,
                })
                .into_iter()
                .collect();
            let operator = build_exchange_operator(&ExchangeOperatorInputs {
                region_mask: Some(&mask),
                a_field: Some(&a),
                rules: &rules,
                ..inputs(grid(2, 1, 1))
            })
            .expect("operator");
            let faces = faces(operator);
            assert!(
                (faces.x_plus[0] - expected).abs() <= 1e-26,
                "mode {mode:?}: got {}",
                faces.x_plus[0]
            );
            assert_eq!(faces.x_plus[1], 0.0, "open boundary has no connection");
        }
    }

    #[test]
    fn rules_matching_scalar_keep_faces_over_variable_a_field() {
        // Explicit A12 equal to the scalar makes every connection equal the
        // scalar, but a consumer of `Uniform` would use H(13, 20) from a_field.
        let a = [13e-12, 20e-12];
        let mask = [1u32, 2];
        let rules = [ExchangePairRule {
            region_i: 1,
            region_j: 2,
            mode: ExchangePairMode::Explicit(13e-12),
        }];
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            region_mask: Some(&mask),
            exchange_stiffness: 13e-12,
            a_field: Some(&a),
            rules: &rules,
            ..inputs(grid(2, 1, 1))
        })
        .expect("operator");
        let faces = faces(operator);
        assert_eq!(faces.x_plus[0], 13e-12);
    }

    #[test]
    fn a_field_equal_to_scalar_collapses_to_uniform() {
        let a = [1e-11; 4];
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            a_field: Some(&a),
            ..inputs(grid(4, 1, 1))
        })
        .expect("operator");
        assert_eq!(operator, ExchangeOperator::Uniform);
    }

    #[test]
    fn uniform_material_many_regions_collapses_to_uniform() {
        let shape = grid(1000, 1, 1);
        let mask: Vec<u32> = (1..=1000).collect();
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            region_mask: Some(&mask),
            ..inputs(shape)
        })
        .expect("operator");
        assert_eq!(operator, ExchangeOperator::Uniform);
    }

    #[test]
    fn distinct_owners_are_decoupled_without_rules() {
        let mask = [1u32, 2];
        let owners = [0u32, 0, 1];
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            region_mask: Some(&mask),
            region_owner: Some(&owners),
            ..inputs(grid(2, 1, 1))
        })
        .expect("operator");
        assert_eq!(faces(operator).x_plus[0], 0.0);
    }

    #[test]
    fn decoupled_connection_between_active_cells_is_found() {
        let mask = [1u32, 2, 2];
        let owners = [0u32, 0, 1];
        let decoupled = faces(
            build_exchange_operator(&ExchangeOperatorInputs {
                region_mask: Some(&mask),
                region_owner: Some(&owners),
                ..inputs(grid(3, 1, 1))
            })
            .expect("operator"),
        );
        assert_eq!(
            first_decoupled_connection(&decoupled, grid(3, 1, 1), [false; 3], None),
            Some((0, 1))
        );

        // A positive scaled interface keeps the connection.
        let rules = [ExchangePairRule {
            region_i: 1,
            region_j: 2,
            mode: ExchangePairMode::HarmonicScale(0.5),
        }];
        let scaled = faces(
            build_exchange_operator(&ExchangeOperatorInputs {
                region_mask: Some(&mask),
                rules: &rules,
                ..inputs(grid(3, 1, 1))
            })
            .expect("operator"),
        );
        assert_eq!(first_decoupled_connection(&scaled, grid(3, 1, 1), [false; 3], None), None);
    }

    #[test]
    fn decoupled_connection_ignores_inactive_cells_and_checks_periodic_wrap() {
        let shape = grid(3, 1, 1);
        let zero_next_to_inactive = ExchangeFaces {
            x_plus: vec![1e-11, 0.0, 0.0],
            y_plus: vec![0.0; 3],
            z_plus: vec![0.0; 3],
        };
        let active = [true, true, false];
        assert_eq!(
            first_decoupled_connection(&zero_next_to_inactive, shape, [false; 3], Some(&active)),
            None
        );
        // The +x wrap of the last cell joins it to cell 0.
        let open_wrap = ExchangeFaces {
            x_plus: vec![1e-11, 1e-11, 0.0],
            y_plus: vec![0.0; 3],
            z_plus: vec![0.0; 3],
        };
        assert_eq!(first_decoupled_connection(&open_wrap, shape, [false; 3], None), None);
        assert_eq!(
            first_decoupled_connection(&open_wrap, shape, [true, false, false], None),
            Some((2, 0))
        );
    }

    #[test]
    fn inactive_neighbor_has_no_connection() {
        let active = [true, false, true];
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            active: Some(&active),
            ..inputs(grid(3, 1, 1))
        })
        .expect("operator");
        assert_eq!(operator, ExchangeOperator::Uniform);
        let a = [1e-11, 1e-11, 2e-11];
        let faces = faces(
            build_exchange_operator(&ExchangeOperatorInputs {
                active: Some(&active),
                a_field: Some(&a),
                ..inputs(grid(3, 1, 1))
            })
            .expect("operator"),
        );
        assert_eq!(faces.x_plus, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn periodic_axis_lengths_one_and_two() {
        let one = build_exchange_operator(&ExchangeOperatorInputs {
            periodic: [true, false, false],
            a_field: Some(&[2e-11]),
            ..inputs(grid(1, 1, 1))
        })
        .expect("operator");
        assert_eq!(faces(one).x_plus, vec![0.0]);

        let a = [1e-11, 3e-11];
        let two = faces(
            build_exchange_operator(&ExchangeOperatorInputs {
                periodic: [true, false, false],
                a_field: Some(&a),
                ..inputs(grid(2, 1, 1))
            })
            .expect("operator"),
        );
        assert!((two.x_plus[0] - 1.5e-11).abs() <= 1e-26);
        assert!((two.x_plus[1] - 1.5e-11).abs() <= 1e-26);
    }

    #[test]
    fn rule_without_contact_is_ignored() {
        let mask = [1u32, 1];
        let rules = [ExchangePairRule {
            region_i: 1,
            region_j: 7,
            mode: ExchangePairMode::Disabled,
        }];
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            region_mask: Some(&mask),
            rules: &rules,
            ..inputs(grid(2, 1, 1))
        })
        .expect("operator");
        assert_eq!(operator, ExchangeOperator::Uniform);
    }

    #[test]
    fn length_mismatch_is_error() {
        let error = build_exchange_operator(&ExchangeOperatorInputs {
            a_field: Some(&[1e-11]),
            ..inputs(grid(2, 1, 1))
        })
        .expect_err("a_field length must match");
        assert!(error.contains("a_field length mismatch"));
    }
}
