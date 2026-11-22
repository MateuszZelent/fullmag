"""Version 2 evaluator for analytic magnetic texture presets.

The formulas and validation rules in this module mirror
``crates/fullmag-plan/src/magnetization_textures_v2.rs``.  Version 1 remains
in ``preset_eval.py`` so historical scene payloads keep their old result.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import struct
from typing import Iterable, Mapping, Sequence


Vec3 = tuple[float, float, float]
_EPSILON = 1.0e-14
_U64_MASK = (1 << 64) - 1
_U64_TO_UNIT = 1.0 / 9007199254740992.0


@dataclass(frozen=True, slots=True)
class EvaluatedTextureV2:
    values: list[Vec3]


def _invalid(key: str, reason: str) -> ValueError:
    return ValueError(f"invalid preset parameter '{key}': {reason}")


def _number(params: Mapping[str, object], key: str, default: float | None = None) -> float:
    raw = params.get(key, default)
    if isinstance(raw, bool) or raw is None:
        raise _invalid(key, "must be a finite number")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise _invalid(key, "must be a finite number") from exc
    if not math.isfinite(value):
        raise _invalid(key, "must be a finite number")
    return value


def _positive(params: Mapping[str, object], key: str, default: float | None = None) -> float:
    value = _number(params, key, default)
    if value <= 0.0:
        raise _invalid(key, "must be positive")
    return value


def _integer(params: Mapping[str, object], key: str, default: int | None = None) -> int:
    raw = params.get(key, default)
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise _invalid(key, "must be an integer")
    return raw


def _sign(params: Mapping[str, object], key: str, default: int = 1) -> float:
    value = _integer(params, key, default)
    if value not in (-1, 1):
        raise _invalid(key, "must be either -1 or 1")
    return float(value)


def _string(params: Mapping[str, object], key: str, default: str | None = None) -> str:
    raw = params.get(key, default)
    if not isinstance(raw, str):
        raise _invalid(key, "must be a string")
    return raw


def _vector(
    params: Mapping[str, object],
    key: str,
    default: Sequence[float] | None = None,
) -> Vec3:
    raw = params.get(key, default)
    if isinstance(raw, (str, bytes)) or raw is None:
        raise _invalid(key, "must be a 3-element array")
    try:
        if len(raw) != 3:  # type: ignore[arg-type]
            raise _invalid(key, "must be a 3-element array")
        result = (float(raw[0]), float(raw[1]), float(raw[2]))  # type: ignore[index]
    except (TypeError, ValueError, IndexError) as exc:
        raise _invalid(key, "must be a 3-element array") from exc
    if any(not math.isfinite(component) for component in result):
        raise _invalid(key, "all components must be finite")
    return result


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return float(a[0]) * float(b[0]) + float(a[1]) * float(b[1]) + float(a[2]) * float(b[2])


def _cross(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (
        float(a[1]) * float(b[2]) - float(a[2]) * float(b[1]),
        float(a[2]) * float(b[0]) - float(a[0]) * float(b[2]),
        float(a[0]) * float(b[1]) - float(a[1]) * float(b[0]),
    )


def _add(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (float(a[0]) + float(b[0]), float(a[1]) + float(b[1]), float(a[2]) + float(b[2]))


def _sub(a: Sequence[float], b: Sequence[float]) -> Vec3:
    return (float(a[0]) - float(b[0]), float(a[1]) - float(b[1]), float(a[2]) - float(b[2]))


def _scale(v: Sequence[float], factor: float) -> Vec3:
    return (float(v[0]) * factor, float(v[1]) * factor, float(v[2]) * factor)


def _norm(v: Sequence[float]) -> float:
    return math.sqrt(_dot(v, v))


def _normalize(v: Sequence[float], key: str) -> Vec3:
    result = (float(v[0]), float(v[1]), float(v[2]))
    if any(not math.isfinite(component) for component in result):
        raise _invalid(key, "all components must be finite")
    length = _norm(result)
    if not math.isfinite(length) or length <= _EPSILON:
        raise _invalid(key, "vector must be nonzero and normalizable")
    return _scale(result, 1.0 / length)


def _axis(value: object, key: str = "normal_axis") -> Vec3:
    if not isinstance(value, str):
        raise _invalid(key, "must be a string")
    try:
        return {"x": (1.0, 0.0, 0.0), "y": (0.0, 1.0, 0.0), "z": (0.0, 0.0, 1.0)}[value]
    except KeyError as exc:
        raise _invalid(key, f"unknown axis '{value}'") from exc


def _frame(plane: str) -> tuple[Vec3, Vec3, Vec3]:
    try:
        return {
            "xy": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
            "xz": ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0)),
            "yz": ((0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
        }[plane]
    except KeyError as exc:
        raise _invalid("plane", f"unknown plane '{plane}'") from exc


def _projection_plane(projection: str | None) -> str | None:
    return {
        "planar_xy": "xy",
        "planar_xz": "xz",
        "planar_yz": "yz",
    }.get(projection)


def _resolve_frame(params: Mapping[str, object], projection: str | None) -> tuple[Vec3, Vec3, Vec3] | None:
    explicit = params.get("plane")
    if explicit is not None and not isinstance(explicit, str):
        raise _invalid("plane", "must be a string")
    projected = _projection_plane(projection)
    if explicit is not None and projected is not None and explicit != projected:
        raise ValueError(
            f"preset plane '{explicit}' conflicts with mapping projection '{projected}'"
        )
    selected = explicit or projected
    return _frame(selected) if selected is not None else None


def _coordinates(point: Sequence[float], frame: tuple[Vec3, Vec3, Vec3]) -> Vec3:
    return (_dot(point, frame[0]), _dot(point, frame[1]), _dot(point, frame[2]))


def _vector_to_world(vector: Sequence[float], frame: tuple[Vec3, Vec3, Vec3]) -> Vec3:
    return _add(_add(_scale(frame[0], vector[0]), _scale(frame[1], vector[1])), _scale(frame[2], vector[2]))


def _rotate(vector: Sequence[float], quaternion: Sequence[float]) -> Vec3:
    q = (float(quaternion[0]), float(quaternion[1]), float(quaternion[2]), float(quaternion[3]))
    qvec = q[:3]
    t = _scale(_cross(qvec, vector), 2.0)
    return _add(_add(vector, _scale(t, q[3])), _cross(qvec, t))


def _normalized_quaternion(quaternion: Sequence[float]) -> tuple[float, float, float, float]:
    try:
        q = tuple(float(component) for component in quaternion)
    except (TypeError, ValueError) as exc:
        raise _invalid("texture_transform.rotation_quat", "must have four finite components") from exc
    if len(q) != 4 or any(not math.isfinite(component) for component in q):
        raise _invalid("texture_transform.rotation_quat", "must have four finite components")
    length = math.sqrt(sum(component * component for component in q))
    if not math.isfinite(length) or length <= _EPSILON:
        raise _invalid("texture_transform.rotation_quat", "quaternion must be nonzero and finite")
    return tuple(component / length for component in q)  # type: ignore[return-value]


def _splitmix64(state: int) -> int:
    state = (state + 0x9E3779B97F4A7C15) & _U64_MASK
    result = state
    result = ((result ^ (result >> 30)) * 0xBF58476D1CE4E5B9) & _U64_MASK
    result = ((result ^ (result >> 27)) * 0x94D049BB133111EB) & _U64_MASK
    return (result ^ (result >> 31)) & _U64_MASK


def _unit_from_u64(value: int) -> float:
    return float(value >> 11) * _U64_TO_UNIT


def _f64_bits(value: float) -> int:
    return struct.unpack("<Q", struct.pack("<d", value))[0]


def _random_unit_vector(seed: int, point: Sequence[float]) -> Vec3:
    state = _splitmix64(seed & _U64_MASK)
    for component in point:
        state = _splitmix64(state ^ _f64_bits(float(component)))
    phi_hash = _splitmix64(state)
    cos_hash = _splitmix64(phi_hash)
    phi = _unit_from_u64(phi_hash) * math.tau
    cos_theta = _unit_from_u64(cos_hash) * 2.0 - 1.0
    sin_theta = math.sqrt(max(0.0, 1.0 - cos_theta * cos_theta))
    return (sin_theta * math.cos(phi), sin_theta * math.sin(phi), cos_theta)


def _log_sinh(value: float) -> float:
    if value <= 0.0:
        return -math.inf
    if value < 1.0e-5:
        return math.log(value)
    return value - math.log(2.0) + math.log1p(-math.exp(-2.0 * value))


def _skyrmion_theta(radius: float, distance: float, wall_width: float) -> float:
    if distance <= _EPSILON:
        return math.pi
    log_ratio = _log_sinh(radius / wall_width) - _log_sinh(distance / wall_width)
    if log_ratio > 40.0:
        return math.pi
    if log_ratio < -40.0:
        return 0.0
    return 2.0 * math.atan(math.exp(log_ratio))


def _vortex(params: Mapping[str, object], point: Sequence[float], vorticity: float) -> Vec3:
    circulation = _sign(params, "circulation")
    polarity = _sign(params, "core_polarity")
    core_radius = _positive(params, "core_radius", 1.0e-9)
    radius = math.hypot(point[0], point[1])
    phi = math.atan2(point[1], point[0])
    core = math.exp(-((radius / core_radius) ** 2))
    transverse = math.sqrt(max(0.0, 1.0 - core * core))
    phase = vorticity * phi + circulation * math.pi / 2.0
    return (transverse * math.cos(phase), transverse * math.sin(phase), polarity * core)


def _wall_helicity(kind: str, chirality: int) -> float:
    if kind == "bloch":
        return chirality * math.pi / 2.0
    if kind == "neel":
        return 0.0 if chirality > 0 else math.pi
    raise _invalid("kind", "must be either 'bloch' or 'neel'")


def _skyrmion(
    params: Mapping[str, object],
    point: Sequence[float],
    winding: float,
    kind: str,
) -> Vec3:
    radius = _positive(params, "radius")
    wall_width = _positive(params, "wall_width")
    polarity = _sign(params, "core_polarity")
    chirality = _sign(params, "chirality")
    distance = math.hypot(point[0], point[1])
    phi = math.atan2(point[1], point[0])
    theta = _skyrmion_theta(radius, distance, wall_width)
    phase = winding * phi + _wall_helicity(kind, chirality)
    return (
        math.sin(theta) * math.cos(phase),
        math.sin(theta) * math.sin(phase),
        -polarity * math.cos(theta),
    )


def _skyrmionium(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    inner_radius = _positive(params, "inner_radius")
    outer_radius = _positive(params, "outer_radius")
    if outer_radius <= inner_radius:
        raise _invalid("outer_radius", "must be greater than inner_radius")
    wall_width = _positive(params, "wall_width")
    chirality = _sign(params, "chirality")
    background = _sign(params, "background_sign")
    kind = params.get("kind", "neel")
    if not isinstance(kind, str):
        raise _invalid("kind", "must be a string")
    distance = math.hypot(point[0], point[1])
    wall_angle = lambda coordinate: math.acos(-math.tanh(coordinate))
    theta = wall_angle((distance - inner_radius) / wall_width) + wall_angle(
        (distance - outer_radius) / wall_width
    )
    phase = math.atan2(point[1], point[0]) + _wall_helicity(kind, chirality)
    return (
        math.sin(theta) * math.cos(phase),
        math.sin(theta) * math.sin(phase),
        background * math.cos(theta),
    )


def _hopfion(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    radius = _positive(params, "radius")
    charge = _sign(params, "hopf_charge")
    background = _sign(params, "background_sign")
    axial_scale = _positive(params, "axial_scale", 1.0)
    phase = _number(params, "phase_rad", 0.0)

    x = point[0] / radius
    y = charge * point[1] / radius
    z = point[2] / (radius * axial_scale)
    rho_squared = x * x + y * y + z * z
    if not math.isfinite(rho_squared):
        return (0.0, 0.0, float(background))
    denominator = 1.0 + rho_squared
    z1_re = 2.0 * x / denominator
    z1_im = 2.0 * y / denominator
    z2_re = 2.0 * z / denominator
    z2_im = (rho_squared - 1.0) / denominator

    hopf_x = 2.0 * (z1_re * z2_re + z1_im * z2_im)
    hopf_y = 2.0 * (z1_im * z2_re - z1_re * z2_im)
    hopf_z = z1_re * z1_re + z1_im * z1_im - z2_re * z2_re - z2_im * z2_im
    rotated = (
        math.cos(phase) * hopf_x - math.sin(phase) * hopf_y,
        math.sin(phase) * hopf_x + math.cos(phase) * hopf_y,
        hopf_z,
    )
    return _normalize(_scale(rotated, -background), "hopfion")



def _vortex_wall(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    wall_half_width = _positive(params, "wall_half_width")
    left_mx = _number(params, "left_mx", 1.0)
    right_mx = _number(params, "right_mx", -1.0)
    if left_mx == 0.0:
        raise _invalid("left_mx", "must be finite and nonzero")
    if right_mx == 0.0:
        raise _invalid("right_mx", "must be finite and nonzero")
    circulation = params.get("circulation")
    if circulation is None:
        circulation = 1 if left_mx * right_mx > 0.0 else -1
    else:
        circulation = int(_sign(params, "circulation"))
    vortex_params = dict(params)
    vortex_params["circulation"] = circulation
    if point[0] < -wall_half_width:
        return (math.copysign(1.0, left_mx), 0.0, 0.0)
    if point[0] > wall_half_width:
        return (math.copysign(1.0, right_mx), 0.0, 0.0)
    return _vortex(vortex_params, point, 1.0)


def _hopfion_compact_support(
    params: Mapping[str, object],
    point: Sequence[float],
) -> Vec3:
    major_radius = _positive(params, "major_radius")
    minor_radius = _positive(params, "minor_radius")
    if minor_radius > major_radius:
        raise _invalid("minor_radius", "minor_radius must be <= major_radius")
    psi = math.atan2(point[1], point[0])
    toroidal_radial = point[0] * math.cos(psi) + point[1] * math.sin(psi) - major_radius
    rho = math.hypot(point[2], toroidal_radial)
    if rho >= minor_radius:
        return (0.0, 0.0, 1.0)
    local_phi = math.atan2(point[2], toroidal_radial)
    phi = -local_phi + psi
    normalized_radius = rho / minor_radius
    compact_denominator = 1.0 - normalized_radius * normalized_radius
    theta = math.pi * math.exp(1.0 - 1.0 / compact_denominator)
    return (
        math.cos(phi) * math.sin(theta),
        math.sin(phi) * math.sin(theta),
        math.cos(theta),
    )


def _sech(value: float) -> float:
    absolute = abs(value)
    if absolute > 350.0:
        return 0.0
    return 1.0 / math.cosh(value)


def _domain_wall(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    kind = params.get("kind", "neel")
    if not isinstance(kind, str) or kind not in {"bloch", "neel"}:
        raise _invalid("kind", "must be either 'bloch' or 'neel'")
    axis = _axis(params.get("normal_axis", "x"))
    coordinate = _dot(point, axis)
    center = _number(params, "center_offset", 0.0)
    width = _positive(params, "width")
    left = _normalize(_vector(params, "left", (1.0, 0.0, 0.0)), "left")
    right = _normalize(_vector(params, "right", (-1.0, 0.0, 0.0)), "right")
    if _dot(left, right) > -1.0 + 1.0e-10:
        raise _invalid("right", "v2 domain wall requires an antiparallel right domain")
    if "wall_center_direction" in params:
        wall_direction = _vector(params, "wall_center_direction")
    else:
        projected = _sub(axis, _scale(left, _dot(axis, left)))
        if _norm(projected) <= _EPSILON:
            raise _invalid("wall_center_direction", "required when the derived wall direction is degenerate")
        wall_direction = projected if kind == "neel" else _cross(axis, left)
    wall_direction = _normalize(wall_direction, "wall_center_direction")
    if abs(_dot(wall_direction, left)) > 1.0e-10:
        raise _invalid("wall_center_direction", "must be orthogonal to the domain direction")
    xi = (coordinate - center) / width
    return _normalize(
        _add(_scale(left, -math.tanh(xi)), _scale(wall_direction, _sech(xi))),
        "domain_wall",
    )


def _two_domain(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    axis = _axis(params.get("normal_axis", "x"))
    coordinate = _dot(point, axis)
    left = _normalize(_vector(params, "left"), "left")
    right = _normalize(_vector(params, "right"), "right")
    wall = _normalize(_vector(params, "wall"), "wall")
    sharp = params.get("sharp")
    if sharp is True:
        return left if coordinate < 0.0 else right if coordinate > 0.0 else wall
    if sharp is not None and sharp is not False:
        raise _invalid("sharp", "must be boolean")
    width = _positive(params, "wall_width")
    t = 0.5 * (math.tanh(coordinate / width) + 1.0)
    mixed = _add(_scale(left, 1.0 - t), _scale(right, t))
    return wall if _norm(mixed) <= _EPSILON else _normalize(mixed, "two_domain")


def _basis(params: Mapping[str, object]) -> tuple[Vec3, Vec3]:
    e1 = _normalize(_vector(params, "e1", (1.0, 0.0, 0.0)), "e1")
    e2 = _normalize(_vector(params, "e2", (0.0, 1.0, 0.0)), "e2")
    if abs(_dot(e1, e2)) > 1.0e-12:
        raise _invalid("e2", "e1 and e2 must be orthogonal")
    return e1, e2


def _helical(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    wavevector = _vector(params, "wavevector")
    if _norm(wavevector) <= _EPSILON:
        raise _invalid("wavevector", "must be nonzero and finite")
    e1, e2 = _basis(params)
    phase = _dot(point, wavevector) + _number(params, "phase_rad", 0.0)
    return _add(_scale(e1, math.cos(phase)), _scale(e2, math.sin(phase)))


def _conical(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    wavevector = _vector(params, "wavevector")
    if _norm(wavevector) <= _EPSILON:
        raise _invalid("wavevector", "must be nonzero and finite")
    axis = _normalize(_vector(params, "cone_axis", (0.0, 0.0, 1.0)), "cone_axis")
    angle = _number(params, "cone_angle_rad", math.pi / 4.0)
    if not 0.0 <= angle <= math.pi:
        raise _invalid("cone_angle_rad", "must lie in [0, pi]")
    helper = (1.0, 0.0, 0.0) if abs(axis[0]) < 0.9 else (0.0, 1.0, 0.0)
    e1 = _normalize(_cross(axis, helper), "cone_axis")
    e2 = _cross(axis, e1)
    phase = _dot(point, wavevector) + _number(params, "phase_rad", 0.0)
    transverse = _add(_scale(e1, math.cos(phase)), _scale(e2, math.sin(phase)))
    return _add(_scale(axis, math.cos(angle)), _scale(transverse, math.sin(angle)))


def _bimeron(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    radius = _positive(params, "radius")
    width = _positive(params, "wall_width")
    vorticity = _sign(params, "vorticity")
    helicity = _number(params, "helicity_rad", 0.0)
    background = _sign(params, "background_sign")
    distance = math.hypot(point[0], point[1])
    theta = math.asin(math.tanh((distance - radius) / width)) + math.asin(
        math.tanh((distance + radius) / width)
    )
    phase = vorticity * math.atan2(point[1], point[0]) + helicity
    return (
        -background * math.cos(theta),
        -background * math.sin(theta) * math.sin(phase),
        -background * math.sin(theta) * math.cos(phase),
    )


def _wrap_metric_repeat(coord: float, period: float) -> float:
    return ((coord + 0.5 * period) % period) - 0.5 * period


def _wrap_metric_mirror(coord: float, period: float) -> float:
    two_p = 2.0 * period
    wrapped = (coord + 0.5 * period) % two_p
    folded = wrapped if wrapped <= period else (two_p - wrapped)
    return folded - 0.5 * period


def _orthonormal_basis_from_normal(normal: Vec3) -> tuple[Vec3, Vec3]:
    ref = (0.0, 0.0, 1.0) if abs(normal[2]) < 0.9 else (1.0, 0.0, 0.0)
    e1 = _normalize(_cross(ref, normal), "spin_plane_normal")
    e2 = _normalize(_cross(normal, e1), "spin_plane_normal")
    return e1, e2


def _skyrmion_lattice(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    lattice = _string(params, "lattice", "hexagonal")
    a = _positive(params, "lattice_constant")
    radius = _positive(params, "radius")
    if a <= 2.0 * radius:
        raise _invalid("lattice_constant", "must be strictly greater than 2 * radius")
    wall_type = _string(params, "kind", "bloch")
    if wall_type not in {"bloch", "neel"}:
        raise _invalid("kind", "must be 'bloch' or 'neel'")
    u, v = point[0], point[1]
    if lattice == "square":
        u_ws = _wrap_metric_repeat(u, a)
        v_ws = _wrap_metric_repeat(v, a)
    elif lattice == "hexagonal":
        sqrt3_half_a = 0.5 * math.sqrt(3.0) * a
        f2 = v / sqrt3_half_a
        f1 = (u - 0.5 * a * f2) / a
        n1_0 = round(f1)
        n2_0 = round(f2)
        best_dist_sq = math.inf
        u_ws = u
        v_ws = v
        for d1 in (-1, 0, 1):
            for d2 in (-1, 0, 1):
                n1 = n1_0 + d1
                n2 = n2_0 + d2
                du = u - (n1 * a + n2 * 0.5 * a)
                dv = v - (n2 * sqrt3_half_a)
                dist_sq = du * du + dv * dv
                if dist_sq < best_dist_sq:
                    best_dist_sq = dist_sq
                    u_ws = du
                    v_ws = dv
    else:
        raise _invalid("lattice", "must be 'hexagonal' or 'square'")
    return _skyrmion(params, (u_ws, v_ws, point[2]), 1.0, wall_type)


def _spiral(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    spiral_kind = _string(params, "spiral_kind", "cycloidal")
    if spiral_kind not in {"cycloidal", "proper_screw", "custom_plane"}:
        raise _invalid("spiral_kind", "must be 'cycloidal', 'proper_screw', or 'custom_plane'")
    wavelength = _positive(params, "wavelength")
    q_hat = _normalize(_vector(params, "propagation_axis", (1.0, 0.0, 0.0)), "propagation_axis")
    chirality = _sign(params, "chirality", 1)
    phase_rad = _number(params, "phase_rad", 0.0)
    if spiral_kind == "proper_screw":
        n_s = q_hat
        e1, e2 = _orthonormal_basis_from_normal(n_s)
    elif spiral_kind == "cycloidal":
        default_normal = (0.0, 1.0, 0.0) if abs(q_hat[1]) < 0.9 else (0.0, 0.0, 1.0)
        raw_n = _normalize(_vector(params, "spin_plane_normal", default_normal), "spin_plane_normal")
        proj = _dot(raw_n, q_hat)
        if abs(proj) > 1.0 - 1.0e-6:
            raise _invalid(
                "spin_plane_normal",
                "must not be parallel to propagation_axis for a cycloidal spiral",
            )
        n_s = _normalize(
            (
                raw_n[0] - proj * q_hat[0],
                raw_n[1] - proj * q_hat[1],
                raw_n[2] - proj * q_hat[2],
            ),
            "spin_plane_normal",
        )
        e1 = q_hat
        e2 = _normalize(_cross(n_s, e1), "spin_plane_normal")
    else:
        n_s = _normalize(_vector(params, "spin_plane_normal", (0.0, 1.0, 0.0)), "spin_plane_normal")
        e1, e2 = _orthonormal_basis_from_normal(n_s)
    phase = chirality * (2.0 * math.pi / wavelength) * _dot(q_hat, point) + phase_rad
    cos_phi = math.cos(phase)
    sin_phi = math.sin(phase)
    return _normalize(
        (
            e1[0] * cos_phi + e2[0] * sin_phi,
            e1[1] * cos_phi + e2[1] * sin_phi,
            e1[2] * cos_phi + e2[2] * sin_phi,
        ),
        "spiral",
    )


def _bloch_point(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    bp_kind = _string(params, "bp_kind", "circulating")
    if bp_kind not in {"radial", "circulating", "hyperbolic"}:
        raise _invalid("bp_kind", "must be 'radial', 'circulating', or 'hyperbolic'")
    polarity = _sign(params, "polarity", 1)
    default_twist = math.pi / 2.0 if bp_kind == "circulating" else 0.0
    twist = _number(params, "twist_rad", default_twist)
    _positive(params, "core_radius", 1.0e-9)
    r = math.sqrt(point[0] * point[0] + point[1] * point[1] + point[2] * point[2])
    if r <= 1.0e-15:
        ux, uy, uz = 0.0, 0.0, 1.0
    else:
        ux, uy, uz = point[0] / r, point[1] / r, point[2] / r
    sz = -1.0 if bp_kind == "hyperbolic" else 1.0
    vx, vy, vz = ux, uy, sz * uz
    cos_t = math.cos(twist)
    sin_t = math.sin(twist)
    return (
        polarity * (cos_t * vx - sin_t * vy),
        polarity * (sin_t * vx + cos_t * vy),
        polarity * vz,
    )


def _artificial_spin_ice(params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    lattice = _string(params, "lattice", "square")
    vertex_state = _string(params, "vertex_state", "type_i_ground")
    if vertex_state not in {"type_i_ground", "type_ii_polarized", "monopole_pair"}:
        raise _invalid(
            "vertex_state",
            "must be 'type_i_ground', 'type_ii_polarized', or 'monopole_pair'",
        )
    a = _positive(params, "pitch")
    u, v = point[0], point[1]
    if lattice == "square":
        h_nu = math.floor(u / a)
        h_nv = round(v / a)
        h_du = u - (h_nu + 0.5) * a
        h_dv = v - h_nv * a
        h_dist_sq = h_du * h_du + h_dv * h_dv

        v_nu = round(u / a)
        v_nv = math.floor(v / a)
        v_du = u - v_nu * a
        v_dv = v - (v_nv + 0.5) * a
        v_dist_sq = v_du * v_du + v_dv * v_dv

        if h_dist_sq <= v_dist_sq:
            if vertex_state == "type_ii_polarized":
                sign_val = 1.0
            else:
                sign_val = 1.0 if (h_nu + h_nv) % 2 == 0 else -1.0
                if vertex_state == "monopole_pair" and h_nu == 0 and h_nv == 0:
                    sign_val = -sign_val
            return (sign_val, 0.0, 0.0)
        else:
            if vertex_state == "type_ii_polarized":
                sign_val = 1.0
            else:
                sign_val = -1.0 if (v_nu + v_nv) % 2 == 0 else 1.0
            return (0.0, sign_val, 0.0)
    if lattice == "kagome":
        sqrt3 = math.sqrt(3.0)
        b1 = (1.5 * a, 0.5 * sqrt3 * a)
        b2 = (1.5 * a, -0.5 * sqrt3 * a)
        # Inverse of [[1.5a, 1.5a], [0.5*sqrt3*a, -0.5*sqrt3*a]]
        f_sum = u / (1.5 * a)
        f_diff = v / (0.5 * sqrt3 * a)
        f1 = 0.5 * (f_sum + f_diff)
        f2 = 0.5 * (f_sum - f_diff)
        i0 = round(f1)
        j0 = round(f2)
        bonds = (
            (1.0, 0.0),
            (-0.5, 0.5 * sqrt3),
            (-0.5, -0.5 * sqrt3),
        )
        best_dist_sq = math.inf
        best_i = i0
        best_j = j0
        best_k = 0
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                ii = i0 + di
                jj = j0 + dj
                ax = ii * b1[0] + jj * b2[0]
                ay = ii * b1[1] + jj * b2[1]
                for k, (bx, by) in enumerate(bonds):
                    mx = ax + 0.5 * a * bx
                    my = ay + 0.5 * a * by
                    dist_sq = (u - mx) ** 2 + (v - my) ** 2
                    if dist_sq < best_dist_sq:
                        best_dist_sq = dist_sq
                        best_i = ii
                        best_j = jj
                        best_k = k
        bx, by = bonds[best_k]
        if vertex_state == "type_ii_polarized":
            sign_val = 1.0 if best_k == 0 else -1.0
        else:
            out_bond = (best_i - best_j) % 3
            sign_val = 1.0 if best_k == out_bond else -1.0
            if vertex_state == "monopole_pair" and best_i == 0 and best_j == 0 and best_k == 0:
                sign_val = -sign_val
        return (sign_val * bx, sign_val * by, 0.0)
    raise _invalid("lattice", "must be 'square' or 'kagome'")


def _validate_axis_extent_v2(
    axis_extent_mode: str,
    axis_thickness_m: float | None,
) -> float | None:
    if not axis_extent_mode or axis_extent_mode == "uniform":
        return None
    if axis_extent_mode == "thickness":
        if axis_thickness_m is None or isinstance(axis_thickness_m, bool):
            raise _invalid(
                "mapping.axis_thickness_m",
                "positive axis_thickness_m is required when axis_extent_mode == 'thickness'",
            )
        try:
            thickness = float(axis_thickness_m)
        except (TypeError, ValueError) as exc:
            raise _invalid("mapping.axis_thickness_m", "must be finite and positive") from exc
        if not math.isfinite(thickness) or thickness <= _EPSILON:
            raise _invalid("mapping.axis_thickness_m", "must be finite and positive")
        return 0.5 * thickness
    raise _invalid("mapping.axis_extent_mode", f"unsupported axis_extent_mode '{axis_extent_mode}'")


def _resolve_slab_background_v2(
    preset_kind: str,
    params: Mapping[str, object],
    frame: tuple[Vec3, Vec3, Vec3] | None,
    background_vector: Vec3 | None,
) -> Vec3:
    if background_vector is not None:
        return _normalize(background_vector, "mapping.background_vector")
    if preset_kind in {"bloch_skyrmion", "neel_skyrmion", "antiskyrmion", "skyrmion_lattice"}:
        polarity = _sign(params, "core_polarity", 1)
        local_bg: Vec3 = (0.0, 0.0, -polarity)
    elif preset_kind in {"skyrmionium", "hopfion"}:
        bg_sign = _sign(params, "background_sign", 1)
        local_bg = (0.0, 0.0, bg_sign)
    elif preset_kind == "bimeron":
        bg_sign = _sign(params, "background_sign", 1)
        local_bg = (bg_sign, 0.0, 0.0)
    elif preset_kind == "hopfion_compact_support":
        local_bg = (0.0, 0.0, 1.0)
    else:
        local_bg = (0.0, 0.0, 1.0)
    if frame is not None and preset_kind in _METRIC_PRESETS:
        return _vector_to_world(local_bg, frame)
    return local_bg


def _apply_clamp_mode_v2(
    point: Vec3,
    pivot: Vec3,
    clamp_mode: str,
    period: Vec3 | None,
    background_vector: Vec3 | None,
) -> tuple[str, Vec3]:
    if not clamp_mode or clamp_mode == "none":
        return ("sample", point)
    if period is None:
        raise _invalid(
            "mapping.tile_period",
            "positive metric box/period [Px, Py, Pz] is required when clamp_mode != 'none'",
        )
    if any(not math.isfinite(p) or p <= _EPSILON for p in period):
        raise _invalid("mapping.tile_period", "all period components must be finite and positive")
    rel = (point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2])
    if clamp_mode == "clamp":
        return (
            "sample",
            (
                max(-0.5 * period[0], min(0.5 * period[0], rel[0])) + pivot[0],
                max(-0.5 * period[1], min(0.5 * period[1], rel[1])) + pivot[1],
                max(-0.5 * period[2], min(0.5 * period[2], rel[2])) + pivot[2],
            ),
        )
    if clamp_mode == "repeat":
        return (
            "sample",
            (
                _wrap_metric_repeat(rel[0], period[0]) + pivot[0],
                _wrap_metric_repeat(rel[1], period[1]) + pivot[1],
                _wrap_metric_repeat(rel[2], period[2]) + pivot[2],
            ),
        )
    if clamp_mode == "mirror":
        return (
            "sample",
            (
                _wrap_metric_mirror(rel[0], period[0]) + pivot[0],
                _wrap_metric_mirror(rel[1], period[1]) + pivot[1],
                _wrap_metric_mirror(rel[2], period[2]) + pivot[2],
            ),
        )
    if clamp_mode == "background":
        if any(abs(rel[i]) > 0.5 * period[i] for i in range(3)):
            bg = background_vector if background_vector is not None else (0.0, 0.0, 1.0)
            return ("background", _normalize(bg, "mapping.background_vector"))
        return ("sample", point)
    raise _invalid("mapping.clamp_mode", f"unsupported clamp_mode '{clamp_mode}'")


def _local(preset_kind: str, params: Mapping[str, object], point: Sequence[float]) -> Vec3:
    if preset_kind == "uniform":
        return _normalize(_vector(params, "direction"), "direction")
    if preset_kind in {"random", "random_seeded"}:
        seed = _integer(params, "seed", 1)
        if seed < 0:
            raise _invalid("seed", "must be an unsigned integer")
        return _random_unit_vector(seed, point)
    if preset_kind == "vortex":
        return _vortex(params, point, 1.0)
    if preset_kind == "antivortex":
        return _vortex(params, point, -1.0)
    if preset_kind == "vortex_wall":
        return _vortex_wall(params, point)
    if preset_kind == "bloch_skyrmion":
        return _skyrmion(params, point, 1.0, "bloch")
    if preset_kind == "neel_skyrmion":
        return _skyrmion(params, point, 1.0, "neel")
    if preset_kind == "antiskyrmion":
        return _skyrmion(params, point, -1.0, "neel")
    if preset_kind == "skyrmionium":
        return _skyrmionium(params, point)
    if preset_kind == "hopfion":
        return _hopfion(params, point)
    if preset_kind == "hopfion_compact_support":
        return _hopfion_compact_support(params, point)
    if preset_kind == "bimeron":
        return _bimeron(params, point)
    if preset_kind == "domain_wall":
        return _domain_wall(params, point)
    if preset_kind == "two_domain":
        return _two_domain(params, point)
    if preset_kind == "helical":
        return _helical(params, point)
    if preset_kind == "conical":
        return _conical(params, point)
    if preset_kind == "skyrmion_lattice":
        return _skyrmion_lattice(params, point)
    if preset_kind == "spiral":
        return _spiral(params, point)
    if preset_kind == "bloch_point":
        return _bloch_point(params, point)
    if preset_kind == "artificial_spin_ice":
        return _artificial_spin_ice(params, point)
    raise _invalid("preset_kind", f"unsupported preset '{preset_kind}'")


_METRIC_PRESETS = {
    "vortex",
    "antivortex",
    "vortex_wall",
    "bloch_skyrmion",
    "neel_skyrmion",
    "antiskyrmion",
    "skyrmionium",
    "bimeron",
    "domain_wall",
    "two_domain",
    "skyrmion_lattice",
    "artificial_spin_ice",
}

_WAVE2_PRESETS = frozenset({
    "skyrmion_lattice",
    "spiral",
    "bloch_point",
    "artificial_spin_ice",
})


def evaluate_preset_texture_v2(
    preset_kind: str,
    params: Mapping[str, object],
    points: Iterable[Sequence[float]],
    *,
    projection: str | None = None,
    rotation_quat: Sequence[float] | None = None,
    rotate_vectors: bool = True,
    clamp_mode: str = "none",
    tile_period: Sequence[float] | None = None,
    background_vector: Sequence[float] | None = None,
    axis_extent_mode: str = "uniform",
    axis_thickness_m: float | None = None,
    pivot: Sequence[float] = (0.0, 0.0, 0.0),
) -> EvaluatedTextureV2:
    if projection is not None and projection not in {
        "object_local",
        "planar_xy",
        "planar_xz",
        "planar_yz",
    }:
        raise _invalid("projection", f"unsupported projection '{projection}'")
    if not isinstance(rotate_vectors, bool):
        raise _invalid("texture_transform.rotate_vectors", "must be a boolean")
    point_list: list[Vec3] = []
    for raw_point in points:
        try:
            point = (float(raw_point[0]), float(raw_point[1]), float(raw_point[2]))
        except (TypeError, ValueError, IndexError) as exc:
            raise _invalid("sample_point", "must contain three finite coordinates") from exc
        if any(not math.isfinite(component) for component in point):
            raise _invalid("sample_point", "all components must be finite")
        point_list.append(point)

    normalized_clamp = str(clamp_mode or "none").strip().lower()
    normalized_axis_extent = str(axis_extent_mode or "uniform").strip().lower()
    half_axis_thickness = _validate_axis_extent_v2(normalized_axis_extent, axis_thickness_m)
    use_native = (
        normalized_clamp == "none"
        and half_axis_thickness is None
        and rotate_vectors is True
        and preset_kind not in _WAVE2_PRESETS
    )
    if use_native:
        from fullmag._core import sample_preset_texture_v2

        native_result = sample_preset_texture_v2(
            preset_kind,
            dict(params),
            point_list,
            projection=projection,
            rotation_quat=list(rotation_quat) if rotation_quat is not None else None,
        )
        if native_result is not None:
            raw_values = native_result.get("values")
            if not isinstance(raw_values, list):
                raise ValueError("native v2 evaluator returned an invalid result")
            return EvaluatedTextureV2(
                values=[
                    (float(value[0]), float(value[1]), float(value[2]))
                    for value in raw_values
                ]
            )

    frame = _resolve_frame(params, projection)
    if preset_kind in {"hopfion", "hopfion_compact_support", "bloch_point"} and frame is not None:
        raise _invalid(
            "mapping.projection",
            "the selected three-dimensional preset requires object_local projection",
        )
    quaternion = _normalized_quaternion(rotation_quat) if (rotation_quat is not None and rotate_vectors) else None
    pivot_vec: Vec3 = (float(pivot[0]), float(pivot[1]), float(pivot[2]))
    period_vec: Vec3 | None = None
    if tile_period is not None:
        period_vec = (float(tile_period[0]), float(tile_period[1]), float(tile_period[2]))
    elif normalized_clamp != "none" and point_list:
        mins = [min(p[i] for p in point_list) for i in range(3)]
        maxs = [max(p[i] for p in point_list) for i in range(3)]
        extents = [maxs[i] - mins[i] for i in range(3)]
        if all(e > _EPSILON for e in extents):
            period_vec = (extents[0], extents[1], extents[2])
    bg_vec: Vec3 | None = (
        (float(background_vector[0]), float(background_vector[1]), float(background_vector[2]))
        if background_vector is not None
        else None
    )

    _local(preset_kind, params, (0.0, 0.0, 0.0))
    slab_bg_vec: Vec3 | None = (
        _resolve_slab_background_v2(preset_kind, params, frame, bg_vec)
        if half_axis_thickness is not None
        else None
    )
    is_metric = preset_kind in _METRIC_PRESETS
    values: list[Vec3] = []
    for point in point_list:
        if half_axis_thickness is not None and slab_bg_vec is not None:
            rel_z = _sub(point, pivot_vec)
            z_normal = _dot(rel_z, frame[2]) if (is_metric and frame is not None) else rel_z[2]
            if abs(z_normal) > half_axis_thickness * (1.0 + 1.0e-12):
                values.append(_rotate(slab_bg_vec, quaternion) if quaternion is not None else slab_bg_vec)
                continue
        outcome_kind, outcome_vec = _apply_clamp_mode_v2(
            point,
            pivot_vec,
            normalized_clamp,
            period_vec,
            bg_vec,
        )
        if outcome_kind == "background":
            values.append(_rotate(outcome_vec, quaternion) if quaternion is not None else outcome_vec)
            continue
        local_point = _coordinates(outcome_vec, frame) if frame is not None and is_metric else outcome_vec
        local_vector = _local(preset_kind, params, local_point)
        world_vector = _vector_to_world(local_vector, frame) if frame is not None and is_metric else local_vector
        values.append(_rotate(world_vector, quaternion) if quaternion is not None else world_vector)
    return EvaluatedTextureV2(values=values)
