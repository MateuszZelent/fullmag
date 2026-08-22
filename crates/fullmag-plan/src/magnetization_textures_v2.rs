use crate::magnetization_textures::TextureSamplePoint;
use fullmag_ir::{TextureMappingIR, TextureProjectionMode, TextureTransform3DIR};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

const EPSILON: f64 = 1.0e-14;
const U64_TO_UNIT_F64: f64 = 1.0 / 9007199254740992.0;

#[derive(Debug, Clone, PartialEq)]
pub enum TextureError {
    UnsupportedVersion(u32),
    InvalidParameter {
        key: String,
        reason: String,
    },
    ConflictingPlane {
        preset_plane: String,
        projection_plane: String,
    },
    Legacy(String),
}

impl fmt::Display for TextureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(version) => {
                write!(f, "unsupported preset texture version {version}")
            }
            Self::InvalidParameter { key, reason } => {
                write!(f, "invalid preset parameter '{key}': {reason}")
            }
            Self::ConflictingPlane {
                preset_plane,
                projection_plane,
            } => write!(
                f,
                "preset plane '{preset_plane}' conflicts with mapping projection '{projection_plane}'"
            ),
            Self::Legacy(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for TextureError {}

fn invalid(key: &str, reason: impl Into<String>) -> TextureError {
    TextureError::InvalidParameter {
        key: key.to_string(),
        reason: reason.into(),
    }
}

fn finite_number(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<f64>,
) -> Result<f64, TextureError> {
    let number = match params.get(key) {
        Some(value) => value
            .as_f64()
            .ok_or_else(|| invalid(key, "must be a finite number"))?,
        None => default.ok_or_else(|| invalid(key, "parameter is required"))?,
    };
    if !number.is_finite() {
        return Err(invalid(key, "must be a finite number"));
    }
    Ok(number)
}

fn integer(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<i64>,
) -> Result<i64, TextureError> {
    match params.get(key) {
        Some(value) => value
            .as_i64()
            .ok_or_else(|| invalid(key, "must be an integer")),
        None => default.ok_or_else(|| invalid(key, "parameter is required")),
    }
}

fn string(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<&str>,
) -> Result<String, TextureError> {
    match params.get(key) {
        Some(value) => value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| invalid(key, "must be a string")),
        None => default
            .map(str::to_string)
            .ok_or_else(|| invalid(key, "parameter is required")),
    }
}

fn vector(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<[f64; 3]>,
) -> Result<[f64; 3], TextureError> {
    let value = match params.get(key) {
        Some(value) => value,
        None => {
            return default.ok_or_else(|| invalid(key, "parameter is required"));
        }
    };
    let values = value
        .as_array()
        .ok_or_else(|| invalid(key, "must be a 3-element array"))?;
    if values.len() != 3 {
        return Err(invalid(key, "must be a 3-element array"));
    }
    let result = [
        values[0]
            .as_f64()
            .ok_or_else(|| invalid(key, "component 0 must be a finite number"))?,
        values[1]
            .as_f64()
            .ok_or_else(|| invalid(key, "component 1 must be a finite number"))?,
        values[2]
            .as_f64()
            .ok_or_else(|| invalid(key, "component 2 must be a finite number"))?,
    ];
    if result.iter().any(|component| !component.is_finite()) {
        return Err(invalid(key, "all components must be finite"));
    }
    Ok(result)
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

fn scale(v: [f64; 3], factor: f64) -> [f64; 3] {
    [v[0] * factor, v[1] * factor, v[2] * factor]
}

fn norm(v: [f64; 3]) -> f64 {
    dot(v, v).sqrt()
}

fn normalize_checked(v: [f64; 3], key: &str) -> Result<[f64; 3], TextureError> {
    if v.iter().any(|component| !component.is_finite()) {
        return Err(invalid(key, "all components must be finite"));
    }
    let length = norm(v);
    if !length.is_finite() || length <= EPSILON {
        return Err(invalid(key, "vector must be nonzero and normalizable"));
    }
    Ok(scale(v, 1.0 / length))
}

fn sign(params: &BTreeMap<String, Value>, key: &str, default: i64) -> Result<f64, TextureError> {
    let value = integer(params, key, Some(default))?;
    if value != -1 && value != 1 {
        return Err(invalid(key, "must be either -1 or 1"));
    }
    Ok(value as f64)
}

fn positive(
    params: &BTreeMap<String, Value>,
    key: &str,
    default: Option<f64>,
) -> Result<f64, TextureError> {
    let value = finite_number(params, key, default)?;
    if value <= 0.0 {
        return Err(invalid(key, "must be positive"));
    }
    Ok(value)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrientedPlaneFrame {
    pub e_u: [f64; 3],
    pub e_v: [f64; 3],
    pub e_n: [f64; 3],
}

impl OrientedPlaneFrame {
    pub fn for_plane(plane: &str) -> Result<Self, TextureError> {
        let frame = match plane {
            "xy" => Self {
                e_u: [1.0, 0.0, 0.0],
                e_v: [0.0, 1.0, 0.0],
                e_n: [0.0, 0.0, 1.0],
            },
            "xz" => Self {
                e_u: [1.0, 0.0, 0.0],
                e_v: [0.0, 0.0, 1.0],
                e_n: [0.0, -1.0, 0.0],
            },
            "yz" => Self {
                e_u: [0.0, 1.0, 0.0],
                e_v: [0.0, 0.0, 1.0],
                e_n: [1.0, 0.0, 0.0],
            },
            other => return Err(invalid("plane", format!("unknown plane '{other}'"))),
        };
        if dot(cross(frame.e_u, frame.e_v), frame.e_n) < 1.0 - 1.0e-12 {
            return Err(invalid("plane", "frame must be right-handed"));
        }
        Ok(frame)
    }

    fn coordinates(self, point: [f64; 3]) -> [f64; 3] {
        [
            dot(point, self.e_u),
            dot(point, self.e_v),
            dot(point, self.e_n),
        ]
    }

    fn vector_to_world(self, vector: [f64; 3]) -> [f64; 3] {
        add(
            add(scale(self.e_u, vector[0]), scale(self.e_v, vector[1])),
            scale(self.e_n, vector[2]),
        )
    }
}

fn projection_plane(projection: TextureProjectionMode) -> Option<&'static str> {
    match projection {
        TextureProjectionMode::PlanarXy => Some("xy"),
        TextureProjectionMode::PlanarXz => Some("xz"),
        TextureProjectionMode::PlanarYz => Some("yz"),
        TextureProjectionMode::ObjectLocal => None,
    }
}

fn resolve_frame(
    params: &BTreeMap<String, Value>,
    mapping: &TextureMappingIR,
) -> Result<Option<OrientedPlaneFrame>, TextureError> {
    let explicit = params
        .get("plane")
        .map(|_| string(params, "plane", None))
        .transpose()?;
    let projected = projection_plane(mapping.projection);
    if let (Some(explicit), Some(projected)) = (explicit.as_deref(), projected) {
        if explicit != projected {
            return Err(TextureError::ConflictingPlane {
                preset_plane: explicit.to_string(),
                projection_plane: projected.to_string(),
            });
        }
    }
    explicit
        .or_else(|| projected.map(str::to_string))
        .map(|plane| OrientedPlaneFrame::for_plane(&plane))
        .transpose()
}

fn rotate_by_quaternion(point: [f64; 3], quaternion: [f64; 4]) -> [f64; 3] {
    let q = [quaternion[0], quaternion[1], quaternion[2]];
    let t = scale(cross(q, point), 2.0);
    add(add(point, scale(t, quaternion[3])), cross(q, t))
}

fn inverse_transform(
    point: [f64; 3],
    transform: &TextureTransform3DIR,
) -> Result<[f64; 3], TextureError> {
    let components = transform
        .translation
        .into_iter()
        .chain(transform.scale)
        .chain(transform.pivot)
        .chain(transform.rotation_quat)
        .collect::<Vec<_>>();
    if components.iter().any(|component| !component.is_finite()) {
        return Err(invalid(
            "texture_transform",
            "all components must be finite",
        ));
    }
    if transform.scale.iter().any(|scale| scale.abs() <= EPSILON) {
        return Err(invalid(
            "texture_transform.scale",
            "all components must be nonzero",
        ));
    }
    let quaternion_norm = transform
        .rotation_quat
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    if !quaternion_norm.is_finite() || quaternion_norm <= EPSILON {
        return Err(invalid(
            "texture_transform.rotation_quat",
            "quaternion must be nonzero and finite",
        ));
    }
    let inverse_quaternion = [
        -transform.rotation_quat[0] / quaternion_norm,
        -transform.rotation_quat[1] / quaternion_norm,
        -transform.rotation_quat[2] / quaternion_norm,
        transform.rotation_quat[3] / quaternion_norm,
    ];
    let shifted = sub(sub(point, transform.translation), transform.pivot);
    let rotated = rotate_by_quaternion(shifted, inverse_quaternion);
    Ok([
        rotated[0] / transform.scale[0] + transform.pivot[0],
        rotated[1] / transform.scale[1] + transform.pivot[1],
        rotated[2] / transform.scale[2] + transform.pivot[2],
    ])
}

fn forward_rotate(
    vector: [f64; 3],
    transform: &TextureTransform3DIR,
) -> Result<[f64; 3], TextureError> {
    let quaternion_norm = transform
        .rotation_quat
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    if !quaternion_norm.is_finite() || quaternion_norm <= EPSILON {
        return Err(invalid(
            "texture_transform.rotation_quat",
            "quaternion must be nonzero and finite",
        ));
    }
    Ok(rotate_by_quaternion(
        vector,
        [
            transform.rotation_quat[0] / quaternion_norm,
            transform.rotation_quat[1] / quaternion_norm,
            transform.rotation_quat[2] / quaternion_norm,
            transform.rotation_quat[3] / quaternion_norm,
        ],
    ))
}

fn splitmix64(mut state: u64) -> u64 {
    state = state.wrapping_add(0x9e3779b97f4a7c15);
    let mut result = state;
    result = (result ^ (result >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    result = (result ^ (result >> 27)).wrapping_mul(0x94d049bb133111eb);
    result ^ (result >> 31)
}

fn unit_from_u64(value: u64) -> f64 {
    ((value >> 11) as f64) * U64_TO_UNIT_F64
}

fn random_unit_vector(seed: u64, point: [f64; 3]) -> [f64; 3] {
    let mut state = splitmix64(seed);
    for component in point {
        state = splitmix64(state ^ component.to_bits());
    }
    let phi_hash = splitmix64(state);
    let cos_hash = splitmix64(phi_hash);
    let phi = unit_from_u64(phi_hash) * std::f64::consts::TAU;
    let cos_theta = unit_from_u64(cos_hash) * 2.0 - 1.0;
    let sin_theta = (1.0 - cos_theta * cos_theta).max(0.0).sqrt();
    [sin_theta * phi.cos(), sin_theta * phi.sin(), cos_theta]
}

fn metric_point(point: [f64; 3], frame: Option<OrientedPlaneFrame>) -> [f64; 3] {
    frame.map(|frame| frame.coordinates(point)).unwrap_or(point)
}

fn metric_vector(vector: [f64; 3], frame: Option<OrientedPlaneFrame>) -> [f64; 3] {
    frame
        .map(|frame| frame.vector_to_world(vector))
        .unwrap_or(vector)
}

fn log_sinh(value: f64) -> f64 {
    if value <= 0.0 {
        f64::NEG_INFINITY
    } else if value < 1.0e-5 {
        value.ln()
    } else {
        value - std::f64::consts::LN_2 + (-(-2.0 * value).exp()).ln_1p()
    }
}

fn vortex(
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
    vorticity: f64,
) -> Result<[f64; 3], TextureError> {
    let circulation = sign(params, "circulation", 1)?;
    let polarity = sign(params, "core_polarity", 1)?;
    let core_radius = positive(params, "core_radius", Some(1.0e-9))?;
    let local = point;
    let radius = local[0].hypot(local[1]);
    let phi = local[1].atan2(local[0]);
    let core = (-(radius / core_radius).powi(2)).exp();
    let transverse = (1.0 - core * core).max(0.0).sqrt();
    let phase = vorticity * phi + circulation * std::f64::consts::FRAC_PI_2;
    Ok([
        transverse * phase.cos(),
        transverse * phase.sin(),
        polarity * core,
    ])
}

fn skyrmion_theta(radius: f64, distance: f64, wall_width: f64) -> f64 {
    if distance <= EPSILON {
        return std::f64::consts::PI;
    }
    let log_ratio = log_sinh(radius / wall_width) - log_sinh(distance / wall_width);
    if log_ratio > 40.0 {
        std::f64::consts::PI
    } else if log_ratio < -40.0 {
        0.0
    } else {
        2.0 * log_ratio.exp().atan()
    }
}

#[derive(Clone, Copy)]
enum SkyrmionWallType {
    Bloch,
    Neel,
}

fn wall_helicity(wall_type: SkyrmionWallType, chirality: f64) -> f64 {
    match wall_type {
        SkyrmionWallType::Bloch => chirality * std::f64::consts::FRAC_PI_2,
        SkyrmionWallType::Neel => {
            if chirality > 0.0 {
                0.0
            } else {
                std::f64::consts::PI
            }
        }
    }
}

fn skyrmion(
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
    winding: f64,
    wall_type: SkyrmionWallType,
) -> Result<[f64; 3], TextureError> {
    let radius = positive(params, "radius", None)?;
    let wall_width = positive(params, "wall_width", None)?;
    let polarity = sign(params, "core_polarity", 1)?;
    let chirality = sign(params, "chirality", 1)?;
    let distance = point[0].hypot(point[1]);
    let phi = point[1].atan2(point[0]);
    let theta = skyrmion_theta(radius, distance, wall_width);
    let phase = winding * phi + wall_helicity(wall_type, chirality);
    let sin_theta = theta.sin();
    Ok([
        sin_theta * phase.cos(),
        sin_theta * phase.sin(),
        -polarity * theta.cos(),
    ])
}

fn skyrmionium(
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
) -> Result<[f64; 3], TextureError> {
    let inner_radius = positive(params, "inner_radius", None)?;
    let outer_radius = positive(params, "outer_radius", None)?;
    if outer_radius <= inner_radius {
        return Err(invalid("outer_radius", "must be greater than inner_radius"));
    }
    let wall_width = positive(params, "wall_width", None)?;
    let chirality = sign(params, "chirality", 1)?;
    let background = sign(params, "background_sign", 1)?;
    let kind = string(params, "kind", Some("neel"))?;
    let wall_type = match kind.as_str() {
        "bloch" => SkyrmionWallType::Bloch,
        "neel" => SkyrmionWallType::Neel,
        _ => return Err(invalid("kind", "must be either 'bloch' or 'neel'")),
    };
    let distance = point[0].hypot(point[1]);
    let wall_angle = |coordinate: f64| (-coordinate.tanh()).acos();
    let theta = wall_angle((distance - inner_radius) / wall_width)
        + wall_angle((distance - outer_radius) / wall_width);
    let phase = point[1].atan2(point[0]) + wall_helicity(wall_type, chirality);
    let sin_theta = theta.sin();
    Ok([
        sin_theta * phase.cos(),
        sin_theta * phase.sin(),
        background * theta.cos(),
    ])
}

fn hopfion(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], TextureError> {
    let radius = positive(params, "radius", None)?;
    let charge = sign(params, "hopf_charge", 1)?;
    let background = sign(params, "background_sign", 1)?;
    let axial_scale = positive(params, "axial_scale", Some(1.0))?;
    let phase = finite_number(params, "phase_rad", Some(0.0))?;

    let x = point[0] / radius;
    let y = charge * point[1] / radius;
    let z = point[2] / (radius * axial_scale);
    let rho_squared = x * x + y * y + z * z;
    if !rho_squared.is_finite() {
        return Ok([0.0, 0.0, background]);
    }
    let denominator = 1.0 + rho_squared;
    let z1_re = 2.0 * x / denominator;
    let z1_im = 2.0 * y / denominator;
    let z2_re = 2.0 * z / denominator;
    let z2_im = (rho_squared - 1.0) / denominator;

    let hopf_x = 2.0 * (z1_re * z2_re + z1_im * z2_im);
    let hopf_y = 2.0 * (z1_im * z2_re - z1_re * z2_im);
    let hopf_z = z1_re * z1_re + z1_im * z1_im - z2_re * z2_re - z2_im * z2_im;
    let rotated_x = phase.cos() * hopf_x - phase.sin() * hopf_y;
    let rotated_y = phase.sin() * hopf_x + phase.cos() * hopf_y;

    normalize_checked(
        scale([rotated_x, rotated_y, hopf_z], -background),
        "hopfion",
    )
}

fn axis_vector(axis: &str) -> Result<[f64; 3], TextureError> {
    match axis {
        "x" => Ok([1.0, 0.0, 0.0]),
        "y" => Ok([0.0, 1.0, 0.0]),
        "z" => Ok([0.0, 0.0, 1.0]),
        other => Err(invalid("normal_axis", format!("unknown axis '{other}'"))),
    }
}

fn stable_sech(value: f64) -> f64 {
    if value.abs() > 350.0 {
        0.0
    } else {
        1.0 / value.cosh()
    }
}

fn fallback_wall_direction(
    axis: [f64; 3],
    left: [f64; 3],
    kind: &str,
) -> Result<[f64; 3], TextureError> {
    let projected = sub(axis, scale(left, dot(axis, left)));
    let preferred = if kind == "neel" {
        projected
    } else {
        cross(axis, left)
    };
    if norm(preferred) > EPSILON {
        return Ok(preferred);
    }

    let helper = if axis[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else if axis[1].abs() < 0.9 {
        [0.0, 1.0, 0.0]
    } else {
        [0.0, 0.0, 1.0]
    };
    let tangent_one = normalize_checked(cross(axis, helper), "wall_center_direction")?;
    Ok(if kind == "bloch" {
        tangent_one
    } else {
        cross(tangent_one, axis)
    })
}

fn domain_wall(
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
) -> Result<[f64; 3], TextureError> {
    let axis_name = string(params, "normal_axis", Some("x"))?;
    let axis = axis_vector(&axis_name)?;
    let coordinate = dot(point, axis);
    let center = finite_number(params, "center_offset", Some(0.0))?;
    let width = positive(params, "width", None)?;
    let left = normalize_checked(vector(params, "left", Some([1.0, 0.0, 0.0]))?, "left")?;
    let right = normalize_checked(vector(params, "right", Some([-1.0, 0.0, 0.0]))?, "right")?;
    if dot(left, right) > -1.0 + 1.0e-10 {
        return Err(invalid(
            "right",
            "v2 domain wall requires an antiparallel right domain",
        ));
    }
    let kind = string(params, "kind", Some("neel"))?;
    if kind != "neel" && kind != "bloch" {
        return Err(invalid("kind", "must be either 'bloch' or 'neel'"));
    }
    let wall_direction = if params.contains_key("wall_center_direction") {
        vector(params, "wall_center_direction", None)?
    } else {
        fallback_wall_direction(axis, left, &kind)?
    };
    let wall_direction = normalize_checked(wall_direction, "wall_center_direction")?;
    if dot(wall_direction, left).abs() > 1.0e-10 {
        return Err(invalid(
            "wall_center_direction",
            "must be orthogonal to the domain direction",
        ));
    }
    let xi = (coordinate - center) / width;
    let mixed = add(
        scale(left, -xi.tanh()),
        scale(wall_direction, stable_sech(xi)),
    );
    normalize_checked(mixed, "domain_wall")
}

fn two_domain(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], TextureError> {
    let axis = axis_vector(&string(params, "normal_axis", Some("x"))?)?;
    let coordinate = dot(point, axis);
    let left = normalize_checked(vector(params, "left", None)?, "left")?;
    let right = normalize_checked(vector(params, "right", None)?, "right")?;
    let wall = normalize_checked(vector(params, "wall", None)?, "wall")?;
    if let Some(sharp) = params.get("sharp") {
        if sharp.as_bool() == Some(true) {
            if coordinate < 0.0 {
                return Ok(left);
            }
            if coordinate > 0.0 {
                return Ok(right);
            }
            return Ok(wall);
        }
        if sharp.as_bool() != Some(false) {
            return Err(invalid("sharp", "must be boolean"));
        }
    }
    let width = positive(params, "wall_width", None)?;
    let t = 0.5 * ((coordinate / width).tanh() + 1.0);
    let mixed = add(scale(left, 1.0 - t), scale(right, t));
    if norm(mixed) <= EPSILON {
        return Ok(wall);
    }
    normalize_checked(mixed, "two_domain")
}

fn orthonormal_basis(
    params: &BTreeMap<String, Value>,
) -> Result<([f64; 3], [f64; 3]), TextureError> {
    let e1 = normalize_checked(vector(params, "e1", Some([1.0, 0.0, 0.0]))?, "e1")?;
    let e2 = normalize_checked(vector(params, "e2", Some([0.0, 1.0, 0.0]))?, "e2")?;
    if dot(e1, e2).abs() > 1.0e-12 {
        return Err(invalid("e2", "e1 and e2 must be orthogonal"));
    }
    Ok((e1, e2))
}

fn helical(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], TextureError> {
    let wavevector = normalize_checked(vector(params, "wavevector", None)?, "wavevector")?;
    let magnitude = vector(params, "wavevector", None)?
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    let (e1, e2) = orthonormal_basis(params)?;
    let phase =
        dot(point, scale(wavevector, magnitude)) + finite_number(params, "phase_rad", Some(0.0))?;
    Ok(add(scale(e1, phase.cos()), scale(e2, phase.sin())))
}

fn conical(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], TextureError> {
    let wavevector = vector(params, "wavevector", None)?;
    let magnitude = norm(wavevector);
    if !magnitude.is_finite() || magnitude <= EPSILON {
        return Err(invalid("wavevector", "must be nonzero and finite"));
    }
    let axis = normalize_checked(
        vector(params, "cone_axis", Some([0.0, 0.0, 1.0]))?,
        "cone_axis",
    )?;
    let angle = finite_number(params, "cone_angle_rad", Some(std::f64::consts::FRAC_PI_4))?;
    if !(0.0..=std::f64::consts::PI).contains(&angle) {
        return Err(invalid("cone_angle_rad", "must lie in [0, pi]"));
    }
    let helper = if axis[0].abs() < 0.9 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let e1 = normalize_checked(cross(axis, helper), "cone_axis")?;
    let e2 = cross(axis, e1);
    let phase = dot(point, wavevector) + finite_number(params, "phase_rad", Some(0.0))?;
    Ok(add(
        scale(axis, angle.cos()),
        scale(
            add(scale(e1, phase.cos()), scale(e2, phase.sin())),
            angle.sin(),
        ),
    ))
}

fn bimeron(params: &BTreeMap<String, Value>, point: [f64; 3]) -> Result<[f64; 3], TextureError> {
    let radius = positive(params, "radius", None)?;
    let width = positive(params, "wall_width", None)?;
    let vorticity = sign(params, "vorticity", 1)?;
    let helicity = finite_number(params, "helicity_rad", Some(0.0))?;
    let background = sign(params, "background_sign", 1)?;
    let distance = point[0].hypot(point[1]);
    let theta =
        ((distance - radius) / width).tanh().asin() + ((distance + radius) / width).tanh().asin();
    let phase = vorticity * point[1].atan2(point[0]) + helicity;
    Ok([
        -background * theta.cos(),
        -background * theta.sin() * phase.sin(),
        -background * theta.sin() * phase.cos(),
    ])
}

fn local_evaluate(
    preset_kind: &str,
    params: &BTreeMap<String, Value>,
    point: [f64; 3],
) -> Result<[f64; 3], TextureError> {
    match preset_kind {
        "uniform" => normalize_checked(vector(params, "direction", None)?, "direction"),
        "random" | "random_seeded" => {
            let seed = match params.get("seed") {
                Some(value) => value
                    .as_u64()
                    .ok_or_else(|| invalid("seed", "must be an unsigned integer"))?,
                None => 1,
            };
            Ok(random_unit_vector(seed, point))
        }
        "vortex" => vortex(params, point, 1.0),
        "antivortex" => vortex(params, point, -1.0),
        "bloch_skyrmion" => skyrmion(params, point, 1.0, SkyrmionWallType::Bloch),
        "neel_skyrmion" => skyrmion(params, point, 1.0, SkyrmionWallType::Neel),
        "antiskyrmion" => skyrmion(params, point, -1.0, SkyrmionWallType::Neel),
        "skyrmionium" => skyrmionium(params, point),
        "hopfion" => hopfion(params, point),
        "bimeron" => bimeron(params, point),
        "domain_wall" => domain_wall(params, point),
        "two_domain" => two_domain(params, point),
        "helical" => helical(params, point),
        "conical" => conical(params, point),
        other => Err(invalid(
            "preset_kind",
            format!("unsupported preset '{other}'"),
        )),
    }
}

fn is_metric(preset_kind: &str) -> bool {
    matches!(
        preset_kind,
        "vortex"
            | "antivortex"
            | "bloch_skyrmion"
            | "neel_skyrmion"
            | "antiskyrmion"
            | "skyrmionium"
            | "bimeron"
            | "domain_wall"
            | "two_domain"
    )
}

fn sample_v2(
    preset_kind: &str,
    params: &BTreeMap<String, Value>,
    mapping: &TextureMappingIR,
    transform: &TextureTransform3DIR,
    points: &[TextureSamplePoint],
) -> Result<Vec<[f64; 3]>, TextureError> {
    let frame = resolve_frame(params, mapping)?;
    if preset_kind == "hopfion" && frame.is_some() {
        return Err(invalid(
            "mapping.projection",
            "hopfion is three-dimensional and requires object_local projection",
        ));
    }
    inverse_transform([0.0, 0.0, 0.0], transform)?;
    forward_rotate([0.0, 0.0, 0.0], transform)?;
    local_evaluate(preset_kind, params, [0.0, 0.0, 0.0])?;
    let mut output = Vec::with_capacity(points.len());
    for point in points {
        let source_position = if mapping.space.eq_ignore_ascii_case("object") {
            point.position_object
        } else {
            point.position_world
        };
        if source_position
            .iter()
            .any(|component| !component.is_finite())
        {
            return Err(invalid("sample_point", "all coordinates must be finite"));
        }
        if !point.active {
            output.push([0.0, 0.0, 0.0]);
            continue;
        }
        let transformed = inverse_transform(source_position, transform)?;
        if transformed.iter().any(|component| !component.is_finite()) {
            return Err(invalid(
                "sample_point",
                "transformed coordinates must be finite",
            ));
        }
        let local_point = if is_metric(preset_kind) {
            metric_point(transformed, frame)
        } else {
            transformed
        };
        let local_vector = local_evaluate(preset_kind, params, local_point)?;
        let world_vector = if is_metric(preset_kind) {
            metric_vector(local_vector, frame)
        } else {
            local_vector
        };
        output.push(forward_rotate(world_vector, transform)?);
    }
    Ok(output)
}

pub fn sample_preset_texture_versioned(
    preset_kind: &str,
    preset_version: u32,
    params: &BTreeMap<String, Value>,
    mapping: &TextureMappingIR,
    transform: &TextureTransform3DIR,
    points: &[TextureSamplePoint],
) -> Result<Vec<[f64; 3]>, TextureError> {
    match preset_version {
        1 => crate::magnetization_textures::sample_preset_texture(
            preset_kind,
            params,
            mapping,
            transform,
            points,
        )
        .map_err(TextureError::Legacy),
        2 => sample_v2(preset_kind, params, mapping, transform, points),
        version => Err(TextureError::UnsupportedVersion(version)),
    }
}
