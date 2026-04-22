//! Field projection utilities: component selection, projection, magnitude, and ETag keys.
//!
//! This module is part of the P1 data-plane effort. The handler calls these
//! utilities *outside* the long read-lock so the solver thread is never blocked
//! by serialisation or maths work.

use crate::error::ApiError;

// ── Component selection ──────────────────────────────────────────────────────

/// Canonical component selection parsed from the `component` query parameter.
///
/// Wire aliases:
/// - `"full"` or absent → [`ComponentSelection::Full`]
/// - `"magnitude"` → [`ComponentSelection::Magnitude`]
/// - `"x"`, `"y"`, `"z"` → [`ComponentSelection::Index`] (0, 1, 2 respectively)
/// - `"cN"` (N ≥ 0) → [`ComponentSelection::Index(N)`]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentSelection {
    /// Return all components unchanged.
    Full,
    /// Return per-point L2 magnitude (scalar, `nComp=1`).
    Magnitude,
    /// Return a single component by zero-based index (scalar, `nComp=1`).
    Index(usize),
}

/// Parse the optional `component` query string.
///
/// Returns an error if the alias is known but out of range for `n_comp`, or if
/// the string is completely unrecognised.
pub fn parse_component(input: Option<&str>, n_comp: usize) -> Result<ComponentSelection, ApiError> {
    let raw = match input {
        None | Some("full") => return Ok(ComponentSelection::Full),
        Some(s) => s,
    };

    match raw {
        "magnitude" => Ok(ComponentSelection::Magnitude),
        "x" => validate_index(0, n_comp),
        "y" => validate_index(1, n_comp),
        "z" => validate_index(2, n_comp),
        other if other.starts_with('c') => {
            let idx_str = &other[1..];
            let idx: usize = idx_str.parse().map_err(|_| {
                ApiError::bad_request(format!(
                    "invalid_component: '{}' is not a valid component alias",
                    other
                ))
            })?;
            validate_index(idx, n_comp)
        }
        other => Err(ApiError::bad_request(format!(
            "invalid_component: '{}' is not a recognised component alias",
            other
        ))),
    }
}

fn validate_index(idx: usize, n_comp: usize) -> Result<ComponentSelection, ApiError> {
    if idx < n_comp {
        Ok(ComponentSelection::Index(idx))
    } else {
        Err(ApiError::bad_request(format!(
            "invalid_component: component index {} out of range for n_comp={}",
            idx, n_comp
        )))
    }
}

// ── Projection ───────────────────────────────────────────────────────────────

/// Project `values` (interleaved, `n_comp` floats per point) according to
/// `component`.
///
/// Returns `(result_n_comp, projected_values)`.
///
/// * `Full` → returns the original slice unchanged (`n_comp` unchanged).
/// * `Index(i)` → extracts every i-th value → `nComp=1`.
/// * `Magnitude` → computes L2 norm per point → `nComp=1`.
pub fn project_values(
    values: &[f64],
    n_comp: usize,
    component: &ComponentSelection,
) -> Result<(usize, Vec<f64>), ApiError> {
    if n_comp == 0 {
        return Err(ApiError::internal("field has n_comp=0"));
    }
    if values.len() % n_comp != 0 {
        return Err(ApiError::internal(format!(
            "value count {} is not divisible by n_comp={}",
            values.len(),
            n_comp
        )));
    }

    match component {
        ComponentSelection::Full => Ok((n_comp, values.to_vec())),
        ComponentSelection::Index(idx) => {
            let projected: Vec<f64> = values.iter().skip(*idx).step_by(n_comp).copied().collect();
            Ok((1, projected))
        }
        ComponentSelection::Magnitude => Ok((1, magnitude(values, n_comp))),
    }
}

/// Compute per-point L2 magnitude from interleaved values.
pub fn magnitude(values: &[f64], n_comp: usize) -> Vec<f64> {
    if n_comp == 0 || values.is_empty() {
        return Vec::new();
    }
    values
        .chunks_exact(n_comp)
        .map(|chunk| chunk.iter().map(|v| v * v).sum::<f64>().sqrt())
        .collect()
}

// ── ETag key ─────────────────────────────────────────────────────────────────

/// Build the raw token (before quoting) for the field vector ETag.
///
/// Format: `fmvp:{quantity_id}:{field_revision}:{domain_generation_id}:{component}:v2`
pub fn component_etag_token(
    quantity_id: &str,
    field_revision: u64,
    domain_generation_id: u64,
    component: &ComponentSelection,
) -> String {
    let comp_str = match component {
        ComponentSelection::Full => "full".to_string(),
        ComponentSelection::Magnitude => "magnitude".to_string(),
        ComponentSelection::Index(i) => format!("c{}", i),
    };
    format!("fmvp:{quantity_id}:{field_revision}:{domain_generation_id}:{comp_str}:v2")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_values() -> Vec<f64> {
        // 4 points, nComp=3
        // p0=[1,0,0], p1=[0,1,0], p2=[0,0,1], p3=[1,2,2]
        vec![
            1.0, 0.0, 0.0, // p0
            0.0, 1.0, 0.0, // p1
            0.0, 0.0, 1.0, // p2
            1.0, 2.0, 2.0, // p3
        ]
    }

    #[test]
    fn parse_full_explicit() {
        let sel = parse_component(Some("full"), 3).unwrap();
        assert_eq!(sel, ComponentSelection::Full);
    }

    #[test]
    fn parse_full_absent() {
        let sel = parse_component(None, 3).unwrap();
        assert_eq!(sel, ComponentSelection::Full);
    }

    #[test]
    fn parse_magnitude() {
        let sel = parse_component(Some("magnitude"), 3).unwrap();
        assert_eq!(sel, ComponentSelection::Magnitude);
    }

    #[test]
    fn parse_x_y_z() {
        assert_eq!(
            parse_component(Some("x"), 3).unwrap(),
            ComponentSelection::Index(0)
        );
        assert_eq!(
            parse_component(Some("y"), 3).unwrap(),
            ComponentSelection::Index(1)
        );
        assert_eq!(
            parse_component(Some("z"), 3).unwrap(),
            ComponentSelection::Index(2)
        );
    }

    #[test]
    fn parse_c_alias() {
        assert_eq!(
            parse_component(Some("c0"), 3).unwrap(),
            ComponentSelection::Index(0)
        );
        assert_eq!(
            parse_component(Some("c1"), 3).unwrap(),
            ComponentSelection::Index(1)
        );
        assert_eq!(
            parse_component(Some("c2"), 3).unwrap(),
            ComponentSelection::Index(2)
        );
    }

    #[test]
    fn parse_c_out_of_range() {
        let err = parse_component(Some("c3"), 3).unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_xyz_out_of_range_for_scalar() {
        // scalar field nComp=1 rejects x/y/z that map to index>=1
        let err = parse_component(Some("y"), 1).unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn parse_unknown_alias() {
        let err = parse_component(Some("theta"), 3).unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::BAD_REQUEST);
    }

    #[test]
    fn project_full() {
        let vals = mock_values();
        let (n, out) = project_values(&vals, 3, &ComponentSelection::Full).unwrap();
        assert_eq!(n, 3);
        assert_eq!(out, vals);
    }

    #[test]
    fn project_x() {
        let vals = mock_values();
        let (n, out) = project_values(&vals, 3, &ComponentSelection::Index(0)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, vec![1.0, 0.0, 0.0, 1.0]);
    }

    #[test]
    fn project_y() {
        let vals = mock_values();
        let (n, out) = project_values(&vals, 3, &ComponentSelection::Index(1)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, vec![0.0, 1.0, 0.0, 2.0]);
    }

    #[test]
    fn project_z() {
        let vals = mock_values();
        let (n, out) = project_values(&vals, 3, &ComponentSelection::Index(2)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, vec![0.0, 0.0, 1.0, 2.0]);
    }

    #[test]
    fn project_magnitude() {
        let vals = mock_values();
        let (n, out) = project_values(&vals, 3, &ComponentSelection::Magnitude).unwrap();
        assert_eq!(n, 1);
        // p0=(1,0,0)->1, p1=(0,1,0)->1, p2=(0,0,1)->1, p3=(1,2,2)->3
        assert!((out[0] - 1.0).abs() < 1e-12);
        assert!((out[1] - 1.0).abs() < 1e-12);
        assert!((out[2] - 1.0).abs() < 1e-12);
        assert!((out[3] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn etag_token_format() {
        let tok = component_etag_token("m", 91, 42, &ComponentSelection::Magnitude);
        assert_eq!(tok, "fmvp:m:91:42:magnitude:v2");
    }

    #[test]
    fn etag_token_index() {
        let tok = component_etag_token("H_eff", 5, 1, &ComponentSelection::Index(2));
        assert_eq!(tok, "fmvp:H_eff:5:1:c2:v2");
    }
}
