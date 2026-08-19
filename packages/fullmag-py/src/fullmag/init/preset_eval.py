from __future__ import annotations

"""Starter evaluator for analytic magnetic texture presets.

Important:
- intended as a shared evaluator for FDM and FEM
- consumes arbitrary sample points
- keeps all presets normalized
"""

from dataclasses import dataclass
import math
from typing import Iterable, Mapping, Sequence


Vec3 = tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class EvaluatedTexture:
    values: list[Vec3]


def _normalize(v: Sequence[float]) -> Vec3:
    x, y, z = float(v[0]), float(v[1]), float(v[2])
    norm = math.sqrt(x * x + y * y + z * z)
    if norm <= 1e-30:
        return (0.0, 0.0, 1.0)
    return (x / norm, y / norm, z / norm)


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


def _scale(v: Sequence[float], s: float) -> Vec3:
    return (float(v[0]) * s, float(v[1]) * s, float(v[2]) * s)


def _plane_coords(point: Sequence[float], plane: str) -> tuple[float, float, float]:
    """Extract in-plane (u, v) and out-of-plane (n) coordinates for *plane*.

    Returns ``(u, v, n)`` where u/v span the chosen plane and n is normal.
    """
    x, y, z = float(point[0]), float(point[1]), float(point[2])
    if plane == "xy":
        return x, y, z
    if plane == "xz":
        return x, z, -y
    if plane == "yz":
        return y, z, x
    return x, y, z


def _plane_vec_to_world(mu: float, mv: float, mn: float, plane: str) -> Vec3:
    """Map a vector from plane-local (u, v, n) basis back to world (x, y, z).

    This is the inverse of ``_plane_coords`` applied to vector components:
      xy: u=x, v=y, n=z  →  (mu, mv, mn)
      xz: u=x, v=z, n=-y →  (mu, -mn, mv)
      yz: u=y, v=z, n=x  →  (mn, mu, mv)
    """
    if plane == "xy":
        return (mu, mv, mn)
    if plane == "xz":
        return (mu, -mn, mv)
    if plane == "yz":
        return (mn, mu, mv)
    return (mu, mv, mn)


def _domain_wall_profile(distance: float, width: float) -> float:
    width = max(width, 1e-30)
    return math.tanh(distance / width)


def _two_atan_exp(value: float) -> float:
    if value >= 0.0:
        return math.pi - 2.0 * math.atan(math.exp(-value))
    return 2.0 * math.atan(math.exp(value))


def _skyrmion_theta(radius: float, r: float, wall_width: float) -> float:
    wall_width = max(wall_width, 1e-30)
    return _two_atan_exp((radius - r) / wall_width)


def _bimeron_theta(radius: float, r: float, wall_width: float) -> float:
    width = max(wall_width, 1e-30)
    return math.asin(math.tanh((r - radius) / width)) + math.asin(
        math.tanh((r + radius) / width)
    )


def _skyrmion_phase(phi: float, chirality: int, helicity: float) -> float:
    if abs(helicity) <= 1e-30:
        return phi + math.pi if chirality < 0 else phi
    chirality_sign = -1.0 if chirality < 0 else 1.0
    return phi + chirality_sign * helicity


def _vortex(point: Sequence[float], params: Mapping[str, object], anti: bool = False) -> Vec3:
    plane = str(params.get("plane", "xy"))
    pu, pv, _pn = _plane_coords(point, plane)
    phi = math.atan2(pv, pu)
    circulation = int(params.get("circulation", 1))
    if anti:
        circulation *= -1
    polarity = int(params.get("core_polarity", 1))
    core_radius = float(params.get("core_radius") or 1e-9)
    r = math.hypot(pu, pv)
    mn = polarity * math.exp(-(r / max(core_radius, 1e-30)) ** 2)
    mu = -circulation * math.sin(phi)
    mv = circulation * math.cos(phi)
    return _normalize(_plane_vec_to_world(mu, mv, mn, plane))


def _skyrmion(point: Sequence[float], params: Mapping[str, object], helicity: float) -> Vec3:
    plane = str(params.get("plane", "xy"))
    pu, pv, _pn = _plane_coords(point, plane)
    radius = float(params["radius"])
    wall_width = float(params["wall_width"])
    core_polarity = int(params.get("core_polarity", -1))
    chirality = int(params.get("chirality", 1))
    r = math.hypot(pu, pv)
    phi = math.atan2(pv, pu)
    theta = _skyrmion_theta(radius, r, wall_width)
    phase = _skyrmion_phase(phi, chirality, helicity)
    sin_t = math.sin(theta)
    mu = sin_t * math.cos(phase)
    mv = sin_t * math.sin(phase)
    mn = core_polarity * math.cos(theta)
    return _normalize(_plane_vec_to_world(mu, mv, mn, plane))


def _bimeron(point: Sequence[float], params: Mapping[str, object]) -> Vec3:
    plane = str(params.get("plane", "xy"))
    if plane not in {"xy", "xz", "yz"}:
        raise ValueError(f"invalid bimeron plane: {plane!r}")

    pu, pv, _pn = _plane_coords(point, plane)
    try:
        radius = float(params["radius"])
        wall_width = float(params["wall_width"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("bimeron radius and wall_width must be numeric") from exc
    if not math.isfinite(radius) or radius <= 0.0:
        raise ValueError("bimeron radius must be finite and positive")
    if not math.isfinite(wall_width) or wall_width <= 0.0:
        raise ValueError("bimeron wall_width must be finite and positive")

    vorticity = params.get("vorticity", 1)
    if isinstance(vorticity, bool) or not isinstance(vorticity, int) or vorticity not in {-1, 1}:
        raise ValueError("bimeron vorticity must be -1 or 1")

    helicity = float(params.get("helicity_rad", 0.0))
    if not math.isfinite(helicity):
        raise ValueError("bimeron helicity_rad must be finite")

    background_sign = params.get("background_sign", 1)
    if isinstance(background_sign, bool) or not isinstance(background_sign, int) or background_sign not in {-1, 1}:
        raise ValueError("bimeron background_sign must be -1 or 1")

    radius_local = math.hypot(pu, pv)
    phi = math.atan2(pv, pu)
    theta = _bimeron_theta(radius, radius_local, wall_width)
    phase = vorticity * phi + helicity
    sin_theta = math.sin(theta)
    mu = -background_sign * math.cos(theta)
    mv = -background_sign * sin_theta * math.sin(phase)
    mn = -background_sign * sin_theta * math.cos(phase)
    return _normalize(_plane_vec_to_world(mu, mv, mn, plane))


def _domain_wall(point: Sequence[float], params: Mapping[str, object]) -> Vec3:
    axis = str(params.get("normal_axis", "x"))
    coordinate = {"x": float(point[0]), "y": float(point[1]), "z": float(point[2])}[axis]
    center_offset = float(params.get("center_offset", 0.0))
    width = float(params["width"])
    left = _normalize(params.get("left", (1.0, 0.0, 0.0)))
    right = _normalize(params.get("right", (-1.0, 0.0, 0.0)))
    t = 0.5 * (_domain_wall_profile(coordinate - center_offset, width) + 1.0)
    mixed = (
        left[0] * (1.0 - t) + right[0] * t,
        left[1] * (1.0 - t) + right[1] * t,
        left[2] * (1.0 - t) + right[2] * t,
    )
    if str(params.get("kind", "neel")) == "bloch":
        tangent = _cross((1.0, 0.0, 0.0), mixed)
        if math.sqrt(_dot(tangent, tangent)) > 1e-16:
            mixed = _add(mixed, _scale(_normalize(tangent), 0.25))
    return _normalize(mixed)


def _two_domain(point: Sequence[float], params: Mapping[str, object]) -> Vec3:
    axis = str(params.get("normal_axis", "x"))
    coordinate = {"x": float(point[0]), "y": float(point[1]), "z": float(point[2])}[axis]
    if coordinate < 0:
        return _normalize(params["left"])
    if coordinate > 0:
        return _normalize(params["right"])
    return _normalize(params["wall"])


def _helical(point: Sequence[float], params: Mapping[str, object]) -> Vec3:
    k = _normalize(params["wavevector"])
    e1 = _normalize(params.get("e1", (1.0, 0.0, 0.0)))
    e2 = _normalize(params.get("e2", (0.0, 1.0, 0.0)))
    phase = _dot(point, k) + float(params.get("phase_rad", 0.0))
    return _normalize(_add(_scale(e1, math.cos(phase)), _scale(e2, math.sin(phase))))


def _conical(point: Sequence[float], params: Mapping[str, object]) -> Vec3:
    k = _normalize(params["wavevector"])
    axis = _normalize(params.get("cone_axis", (0.0, 0.0, 1.0)))
    phase = _dot(point, k) + float(params.get("phase_rad", 0.0))
    cone_angle = float(params.get("cone_angle_rad", math.pi / 4.0))
    helper = (1.0, 0.0, 0.0) if abs(axis[0]) < 0.9 else (0.0, 1.0, 0.0)
    e1 = _normalize(_cross(axis, helper))
    e2 = _normalize(_cross(axis, e1))
    transverse = _add(_scale(e1, math.cos(phase)), _scale(e2, math.sin(phase)))
    return _normalize(_add(_scale(axis, math.cos(cone_angle)), _scale(transverse, math.sin(cone_angle))))


def evaluate_preset_texture(
    preset_kind: str,
    params: Mapping[str, object],
    points: Iterable[Sequence[float]],
    *,
    preset_version: int = 1,
) -> EvaluatedTexture:
    if preset_version == 2:
        from .preset_eval_v2 import evaluate_preset_texture_v2

        result = evaluate_preset_texture_v2(preset_kind, params, points)
        return EvaluatedTexture(values=result.values)
    if preset_version != 1:
        raise ValueError(f"unsupported preset texture version: {preset_version}")

    values: list[Vec3] = []
    for point in points:
        if preset_kind == "uniform":
            values.append(_normalize(params["direction"]))
        elif preset_kind in {"random", "random_seeded"}:
            # Use a deterministic per-point seed derived from the global seed + point coords
            x, y, z = float(point[0]) * 1e9, float(point[1]) * 1e9, float(point[2]) * 1e9
            seed = int(params.get("seed", 1))
            angle1 = math.sin(seed * 12.9898 + x * 78.233 + y * 37.719 + z * 11.137) * 43758.5453
            angle1 = angle1 - math.floor(angle1)
            angle2 = math.sin(seed * 4.1414 + x * 93.989 + y * 67.345 + z * 45.678) * 43758.5453
            angle2 = angle2 - math.floor(angle2)
            phi = angle1 * 2.0 * math.pi
            cos_theta = 2.0 * angle2 - 1.0
            sin_theta = math.sqrt(max(0.0, 1.0 - cos_theta * cos_theta))
            values.append((sin_theta * math.cos(phi), sin_theta * math.sin(phi), cos_theta))
        elif preset_kind == "vortex":
            values.append(_vortex(point, params, anti=False))
        elif preset_kind == "antivortex":
            values.append(_vortex(point, params, anti=True))
        elif preset_kind == "bloch_skyrmion":
            values.append(_skyrmion(point, params, helicity=0.5 * math.pi))
        elif preset_kind == "neel_skyrmion":
            values.append(_skyrmion(point, params, helicity=0.0))
        elif preset_kind == "bimeron":
            values.append(_bimeron(point, params))
        elif preset_kind == "domain_wall":
            values.append(_domain_wall(point, params))
        elif preset_kind == "two_domain":
            values.append(_two_domain(point, params))
        elif preset_kind == "helical":
            values.append(_helical(point, params))
        elif preset_kind == "conical":
            values.append(_conical(point, params))
        else:
            raise ValueError(f"unsupported preset_kind: {preset_kind!r}")
    return EvaluatedTexture(values=values)
