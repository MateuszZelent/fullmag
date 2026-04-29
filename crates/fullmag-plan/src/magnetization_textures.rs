use fullmag_ir::{TextureMappingIR, TextureProjectionMode, TextureTransform3DIR};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy)]
pub struct TextureSamplePoint {
    pub position_world: [f64; 3],
    pub position_object: [f64; 3],
    pub active: bool,
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn scale(v: [f64; 3], s: f64) -> [f64; 3] {
    [v[0] * s, v[1] * s, v[2] * s]
}

fn norm(v: [f64; 3]) -> f64 {
    dot(v, v).sqrt()
}

fn normalize(v: [f64; 3]) -> [f64; 3] {
    let n = norm(v);
    if n <= 1e-30 {
        [0.0, 0.0, 1.0]
    } else {
        [v[0] / n, v[1] / n, v[2] / n]
    }
}

fn parse_f64(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<f64>,
) -> Result<f64, String> {
    if let Some(value) = params.get(key) {
        value
            .as_f64()
            .ok_or_else(|| format!("preset param '{}' must be a number", key))
    } else {
        default.ok_or_else(|| format!("preset param '{}' is required", key))
    }
}

fn parse_i64(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<i64>,
) -> Result<i64, String> {
    if let Some(value) = params.get(key) {
        value
            .as_i64()
            .ok_or_else(|| format!("preset param '{}' must be an integer", key))
    } else {
        default.ok_or_else(|| format!("preset param '{}' is required", key))
    }
}

fn parse_string(params: &BTreeMap<String, Value>, key: &str, default: &str) -> String {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| default.to_string())
}

fn parse_vec3(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: [f64; 3],
) -> Result<[f64; 3], String> {
    let Some(value) = params.get(key) else {
        return Ok(default);
    };
    let Some(values) = value.as_array() else {
        return Err(format!("preset param '{}' must be a 3-element array", key));
    };
    if values.len() != 3 {
        return Err(format!("preset param '{}' must be a 3-element array", key));
    }
    Ok([
        values[0]
            .as_f64()
            .ok_or_else(|| format!("preset param '{}'[0] must be a number", key))?,
        values[1]
            .as_f64()
            .ok_or_else(|| format!("preset param '{}'[1] must be a number", key))?,
        values[2]
            .as_f64()
            .ok_or_else(|| format!("preset param '{}'[2] must be a number", key))?,
    ])
}

fn plane_coords(point: [f64; 3], plane: &str) -> [f64; 3] {
    match plane {
        "xz" => [point[0], point[2], point[1]],
        "yz" => [point[1], point[2], point[0]],
        _ => [point[0], point[1], point[2]],
    }
}

/// Map a vector from plane-local (u, v, n) basis back to world (x, y, z).
/// Inverse of `plane_coords` applied to vector components.
fn plane_vec_to_world(mu: f64, mv: f64, mn: f64, plane: &str) -> [f64; 3] {
    match plane {
        "xz" => [mu, mn, mv],
        "yz" => [mn, mu, mv],
        _ => [mu, mv, mn],
    }
}

fn rotate_point_by_quat(point: [f64; 3], q: [f64; 4]) -> [f64; 3] {
    let qvec = [q[0], q[1], q[2]];
    let t = scale(cross(qvec, point), 2.0);
    add(add(point, scale(t, q[3])), cross(qvec, t))
}

fn apply_inverse_transform(point: [f64; 3], transform: &TextureTransform3DIR) -> [f64; 3] {
    let translation = transform.translation;
    let pivot = transform.pivot;
    let mut p = sub(sub(point, translation), pivot);
    let mut inv_quat = [
        -transform.rotation_quat[0],
        -transform.rotation_quat[1],
        -transform.rotation_quat[2],
        transform.rotation_quat[3],
    ];
    let qn = (inv_quat[0] * inv_quat[0]
        + inv_quat[1] * inv_quat[1]
        + inv_quat[2] * inv_quat[2]
        + inv_quat[3] * inv_quat[3])
        .sqrt();
    if qn > 1e-30 {
        inv_quat = [
            inv_quat[0] / qn,
            inv_quat[1] / qn,
            inv_quat[2] / qn,
            inv_quat[3] / qn,
        ];
    }
    p = rotate_point_by_quat(p, inv_quat);
    let sx = if transform.scale[0].abs() > 1e-30 {
        transform.scale[0]
    } else {
        1.0
    };
    let sy = if transform.scale[1].abs() > 1e-30 {
        transform.scale[1]
    } else {
        1.0
    };
    let sz = if transform.scale[2].abs() > 1e-30 {
        transform.scale[2]
    } else {
        1.0
    };
    [p[0] / sx + pivot[0], p[1] / sy + pivot[1], p[2] / sz + pivot[2]]
}

fn wrap_repeat(x: f64) -> f64 {
    (x + 0.5).rem_euclid(1.0) - 0.5
}

fn wrap_mirror(x: f64) -> f64 {
    let wrapped = (x + 0.5).rem_euclid(2.0);
    let mirrored = if wrapped <= 1.0 {
        wrapped
    } else {
        2.0 - wrapped
    };
    mirrored - 0.5
}

fn apply_clamp_mode(point: [f64; 3], mode: &str) -> [f64; 3] {
    match mode {
        "none" => point,
        "clamp" => [
            point[0].clamp(-0.5, 0.5),
            point[1].clamp(-0.5, 0.5),
            point[2].clamp(-0.5, 0.5),
        ],
        "repeat" | "wrap" => [
            wrap_repeat(point[0]),
            wrap_repeat(point[1]),
            wrap_repeat(point[2]),
        ],
        "mirror" => [
            wrap_mirror(point[0]),
            wrap_mirror(point[1]),
            wrap_mirror(point[2]),
        ],
        _ => point,
    }
}

fn map_point_into_texture_space(
    point: TextureSamplePoint,
    mapping: &TextureMappingIR,
    transform: &TextureTransform3DIR,
) -> [f64; 3] {
    let mut mapped = if mapping.space.eq_ignore_ascii_case("object") {
        point.position_object
    } else {
        point.position_world
    };
    mapped = match mapping.projection {
        TextureProjectionMode::PlanarXy => [mapped[0], mapped[1], 0.0],
        TextureProjectionMode::PlanarXz => [mapped[0], mapped[2], 0.0],
        TextureProjectionMode::PlanarYz => [mapped[1], mapped[2], 0.0],
        TextureProjectionMode::ObjectLocal => mapped,
    };
    let local = apply_inverse_transform(mapped, transform);
    apply_clamp_mode(local, &mapping.clamp_mode)
}

fn eval_uniform(params: &BTreeMap<String, Value>) -> Result<[f64; 3], String> {
    Ok(normalize(parse_vec3(params, "direction", [1.0, 0.0, 0.0])?))
}

fn eval_random_seeded(params: &BTreeMap<String, Value>, point: [f64; 3]) -> [f64; 3] {
    let seed = parse_i64(params, "seed", Some(1)).unwrap_or(1) as f64;
    let x = point[0] * 1.0e9;
    let y = point[1] * 1.0e9;
    let z = point[2] * 1.0e9;
    let angle1 = (seed * 12.9898 + x * 78.233 + y * 37.719 + z * 11.137).sin()
        * 43758.5453;
    let angle2 = (seed * 4.1414 + x * 93.989 + y * 67.345 + z * 45.678).sin()
        * 43758.5453;
    let u1 = angle1 - angle1.floor();
    let u2 = angle2 - angle2.floor();
    let phi = u1 * std::f64::consts::TAU;
    let cos_theta = 2.0 * u2 - 1.0;
    let sin_theta = (1.0 - cos_theta * cos_theta).max(0.0).sqrt();
    [sin_theta * phi.cos(), sin_theta * phi.sin(), cos_theta]
}

fn eval_vortex(
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
    anti: bool,
) -> Result<[f64; 3], String> {
    let plane = parse_string(params, "plane", "xy");
    let p = plane_coords(point, plane.as_str());
    let phi = p[1].atan2(p[0]);
    let mut circulation = parse_i64(params, "circulation", Some(1))?;
    if anti {
        circulation *= -1;
    }
    let polarity = parse_i64(params, "core_polarity", Some(1))?;
    let core_radius = parse_f64(params, "core_radius", Some(1e-9))?.max(1e-30);
    let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
    let mn = (polarity as f64) * (-(r / core_radius).powi(2)).exp();
    let mu = -(circulation as f64) * phi.sin();
    let mv = (circulation as f64) * phi.cos();
    Ok(normalize(plane_vec_to_world(mu, mv, mn, plane.as_str())))
}

fn skyrmion_theta(radius: f64, r: f64, wall_width: f64) -> f64 {
    2.0 * ((radius - r) / wall_width.max(1e-30)).exp().atan()
}

fn eval_skyrmion(
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
    helicity: f64,
) -> Result<[f64; 3], String> {
    let plane = parse_string(params, "plane", "xy");
    let p = plane_coords(point, plane.as_str());
    let radius = parse_f64(params, "radius", None)?;
    let wall_width = parse_f64(params, "wall_width", None)?;
    let core_polarity = parse_i64(params, "core_polarity", Some(-1))?;
    let chirality = parse_i64(params, "chirality", Some(1))?;
    let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
    let phi = p[1].atan2(p[0]);
    let theta = skyrmion_theta(radius, r, wall_width);
    let phase = (chirality as f64) * phi + helicity;
    let sin_t = theta.sin();
    let mu = sin_t * phase.cos();
    let mv = sin_t * phase.sin();
    let mn = (core_polarity as f64) * theta.cos();
    Ok(normalize(plane_vec_to_world(mu, mv, mn, plane.as_str())))
}

fn eval_domain_wall(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], String> {
    let axis = parse_string(params, "normal_axis", "x");
    let coord = match axis.as_str() {
        "y" => point[1],
        "z" => point[2],
        _ => point[0],
    };
    let center_offset = parse_f64(params, "center_offset", Some(0.0))?;
    let width = parse_f64(params, "width", None)?.max(1e-30);
    let left = normalize(parse_vec3(params, "left", [1.0, 0.0, 0.0])?);
    let right = normalize(parse_vec3(params, "right", [-1.0, 0.0, 0.0])?);
    let t = 0.5 * (((coord - center_offset) / width).tanh() + 1.0);
    let mut mixed = [
        left[0] * (1.0 - t) + right[0] * t,
        left[1] * (1.0 - t) + right[1] * t,
        left[2] * (1.0 - t) + right[2] * t,
    ];
    if parse_string(params, "kind", "neel") == "bloch" {
        let tangent = cross([1.0, 0.0, 0.0], mixed);
        if norm(tangent) > 1e-16 {
            mixed = add(mixed, scale(normalize(tangent), 0.25));
        }
    }
    Ok(normalize(mixed))
}

fn eval_two_domain(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], String> {
    let axis = parse_string(params, "normal_axis", "x");
    let coord = match axis.as_str() {
        "y" => point[1],
        "z" => point[2],
        _ => point[0],
    };
    if coord < 0.0 {
        return Ok(normalize(parse_vec3(params, "left", [1.0, 0.0, 0.0])?));
    }
    if coord > 0.0 {
        return Ok(normalize(parse_vec3(params, "right", [-1.0, 0.0, 0.0])?));
    }
    Ok(normalize(parse_vec3(params, "wall", [0.0, 1.0, 0.0])?))
}

fn eval_helical(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], String> {
    let k = normalize(parse_vec3(params, "wavevector", [1.0, 0.0, 0.0])?);
    let e1 = normalize(parse_vec3(params, "e1", [1.0, 0.0, 0.0])?);
    let e2 = normalize(parse_vec3(params, "e2", [0.0, 1.0, 0.0])?);
    let phase = dot(point, k) + parse_f64(params, "phase_rad", Some(0.0))?;
    Ok(normalize(add(
        scale(e1, phase.cos()),
        scale(e2, phase.sin()),
    )))
}

fn eval_conical(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], String> {
    let k = normalize(parse_vec3(params, "wavevector", [1.0, 0.0, 0.0])?);
    let axis = normalize(parse_vec3(params, "cone_axis", [0.0, 0.0, 1.0])?);
    let phase = dot(point, k) + parse_f64(params, "phase_rad", Some(0.0))?;
    let cone_angle = parse_f64(params, "cone_angle_rad", Some(std::f64::consts::FRAC_PI_4))?;
    let helper = if axis[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let e1 = normalize(cross(axis, helper));
    let e2 = normalize(cross(axis, e1));
    let transverse = add(scale(e1, phase.cos()), scale(e2, phase.sin()));
    Ok(normalize(add(
        scale(axis, cone_angle.cos()),
        scale(transverse, cone_angle.sin()),
    )))
}

fn eval_preset(
    preset_kind: &str,
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
) -> Result<[f64; 3], String> {
    match preset_kind {
        "uniform" => eval_uniform(params),
        "random_seeded" => Ok(normalize(eval_random_seeded(params, point))),
        "vortex" => eval_vortex(params, point, false),
        "antivortex" => eval_vortex(params, point, true),
        "bloch_skyrmion" => eval_skyrmion(params, point, 0.5 * std::f64::consts::PI),
        "neel_skyrmion" => eval_skyrmion(params, point, 0.0),
        "domain_wall" => eval_domain_wall(params, point),
        "two_domain" => eval_two_domain(params, point),
        "helical" => eval_helical(params, point),
        "conical" => eval_conical(params, point),
        other => Err(format!("unsupported preset_texture kind '{}'", other)),
    }
}

pub fn sample_preset_texture(
    preset_kind: &str,
    params: &BTreeMap<String, Value>,
    mapping: &TextureMappingIR,
    transform: &TextureTransform3DIR,
    points: &[TextureSamplePoint],
) -> Result<Vec<[f64; 3]>, String> {
    let mut out = Vec::with_capacity(points.len());
    for point in points {
        if !point.active {
            out.push([0.0, 0.0, 0.0]);
            continue;
        }
        let mapped = map_point_into_texture_space(*point, mapping, transform);
        out.push(eval_preset(preset_kind, params, mapped)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_transform_respects_pivot_and_scale() {
        let transform = TextureTransform3DIR {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
            scale: [2.0, 1.0, 1.0],
            pivot: [1.0, 0.0, 0.0],
        };

        let local = apply_inverse_transform([3.0, 0.0, 0.0], &transform);
        assert!((local[0] - 2.0).abs() < 1e-12);
        assert!(local[1].abs() < 1e-12);
        assert!(local[2].abs() < 1e-12);
    }

    #[test]
    fn sample_preset_texture_keeps_translated_vortex_center_in_object_space() {
        let mapping = TextureMappingIR::default();
        let transform = TextureTransform3DIR {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            pivot: [0.0, 0.0, 0.0],
        };
        let mut params = BTreeMap::new();
        params.insert("circulation".to_string(), Value::from(1));
        params.insert("core_polarity".to_string(), Value::from(1));
        params.insert("core_radius".to_string(), Value::from(10e-9));
        params.insert("plane".to_string(), Value::from("xy"));

        let values = sample_preset_texture(
            "vortex",
            &params,
            &mapping,
            &transform,
            &[TextureSamplePoint {
                position_world: [50e-9, 0.0, 0.0],
                position_object: [0.0, 0.0, 0.0],
                active: true,
            }],
        )
        .expect("vortex sampling should succeed");

        assert!(values[0][2] > 0.5);
    }

    #[test]
    fn random_seeded_varies_across_nanoscale_points() {
        let mapping = TextureMappingIR::default();
        let transform = TextureTransform3DIR {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            pivot: [0.0, 0.0, 0.0],
        };
        let mut params = BTreeMap::new();
        params.insert("seed".to_string(), Value::from(7));

        let values = sample_preset_texture(
            "random_seeded",
            &params,
            &mapping,
            &transform,
            &[
                TextureSamplePoint {
                    position_world: [0.0, 0.0, 0.0],
                    position_object: [0.0, 0.0, 0.0],
                    active: true,
                },
                TextureSamplePoint {
                    position_world: [50e-9, 0.0, 0.0],
                    position_object: [50e-9, 0.0, 0.0],
                    active: true,
                },
                TextureSamplePoint {
                    position_world: [100e-9, 25e-9, 0.0],
                    position_object: [100e-9, 25e-9, 0.0],
                    active: true,
                },
            ],
        )
        .expect("random_seeded sampling should succeed");

        let dot01 = dot(values[0], values[1]).abs();
        let dot12 = dot(values[1], values[2]).abs();
        assert!(dot01 < 0.999, "first two random vectors are nearly identical: {dot01}");
        assert!(dot12 < 0.999, "last two random vectors are nearly identical: {dot12}");
    }
}
