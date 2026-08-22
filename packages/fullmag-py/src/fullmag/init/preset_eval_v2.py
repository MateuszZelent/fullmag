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
    raise _invalid("preset_kind", f"unsupported preset '{preset_kind}'")


_METRIC_PRESETS = {
    "vortex",
    "antivortex",
    "bloch_skyrmion",
    "neel_skyrmion",
    "antiskyrmion",
    "skyrmionium",
    "bimeron",
    "domain_wall",
    "two_domain",
}


def evaluate_preset_texture_v2(
    preset_kind: str,
    params: Mapping[str, object],
    points: Iterable[Sequence[float]],
    *,
    projection: str | None = None,
    rotation_quat: Sequence[float] | None = None,
) -> EvaluatedTextureV2:
    if projection is not None and projection not in {
        "object_local",
        "planar_xy",
        "planar_xz",
        "planar_yz",
    }:
        raise _invalid("projection", f"unsupported projection '{projection}'")
    point_list: list[Vec3] = []
    for raw_point in points:
        try:
            point = (float(raw_point[0]), float(raw_point[1]), float(raw_point[2]))
        except (TypeError, ValueError, IndexError) as exc:
            raise _invalid("sample_point", "must contain three finite coordinates") from exc
        if any(not math.isfinite(component) for component in point):
            raise _invalid("sample_point", "all components must be finite")
        point_list.append(point)

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
    if preset_kind == "hopfion" and frame is not None:
        raise _invalid(
            "mapping.projection",
            "hopfion is three-dimensional and requires object_local projection",
        )
    quaternion = _normalized_quaternion(rotation_quat) if rotation_quat is not None else None
    _local(preset_kind, params, (0.0, 0.0, 0.0))
    values: list[Vec3] = []
    for point in point_list:
        local_point = _coordinates(point, frame) if frame is not None and preset_kind in _METRIC_PRESETS else point
        local_vector = _local(preset_kind, params, local_point)
        world_vector = _vector_to_world(local_vector, frame) if frame is not None and preset_kind in _METRIC_PRESETS else local_vector
        values.append(_rotate(world_vector, quaternion) if quaternion is not None else world_vector)
    return EvaluatedTextureV2(values=values)
